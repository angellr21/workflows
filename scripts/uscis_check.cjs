#!/usr/bin/env node
/**
 * USCIS Checker — sin dependencias externas (usa fetch nativo de Node 18+ y Playwright)
 *
 * Flujo:
 *  1) GET  {API_BASE}/queue      -> { queue: [{ tramite_id|id, receipt_number }, ...] }
 *  2) Playwright (headless) visita USCIS, maneja interstitial de Cloudflare, rellena el receipt y obtiene HTML
 *  3) POST {API_BASE}/report     -> { items: [{ tramite_id, html }, ...] }
 *
 * Entradas por entorno:
 *  - API_BASE  : base del API, p.ej. https://tusitio.com/api/uscis
 *  - API_TOKEN : token Bearer del API
 *
 * Notas:
 *  - No resolvemos CAPTCHAs. Si Cloudflare exige desafío interactivo, abortamos ese item y seguimos con backoff (lo maneja tu backend).
 *  - Probamos la landing moderna y, si falla, la ruta clásica mycasestatus.do.
 */

const { chromium } = require('playwright');

function normalizeBase(u) {
  let b = String(u || '').trim();
  b = b.replace(/[?#].*$/, '');
  b = b.replace(/\/+$/, '');
  b = b.replace(/\/queue$/i, ''); // por si pasan /queue por error
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** Redacta host al imprimir (evita mostrar secretos/dom completo) */
function redact(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const safeHost =
      host.length > 8 ? host.slice(0, Math.max(0, host.length - 4)) + '****' : host;
    return `${u.protocol}//${safeHost}${u.pathname}`;
  } catch {
    return String(url).replace(/.{4}$/, '****');
  }
}

/** Detecta pantalla de Cloudflare (interstitial) */
async function isCloudflareInterstitial(page) {
  try {
    const title = await page.title().catch(() => '');
    if (/Attention Required/i.test(title)) return true;
    const cf = page.locator('#cf-wrapper, #cf-error-details');
    if (await cf.first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  } catch {}
  return false;
}

/** Intenta “calentar” Cloudflare: espera, recarga y verifica si desaparece el interstitial */
async function warmUpCloudflare(page, { maxCycles = 3, waitMs = 3000 } = {}) {
  for (let i = 0; i < maxCycles; i++) {
    if (!(await isCloudflareInterstitial(page))) return true;
    log(`CF interstitial detectado. Esperando ${waitMs}ms y recargando… (intento ${i + 1}/${maxCycles})`);
    await sleep(waitMs);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }
  return !(await isCloudflareInterstitial(page));
}

/** Intenta cerrar banners de cookies/consent muy comunes */
async function acceptBanners(pageOrFrame) {
  const candidates = [
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'button:has-text("Aceptar")',
    '[aria-label="accept cookies"]',
    'button[title*="Accept" i]',
  ];
  for (const sel of candidates) {
    try {
      const loc = pageOrFrame.locator(sel);
      if (await loc.first().isVisible({ timeout: 800 })) {
        await loc.first().click({ timeout: 1200 });
        await sleep(350);
      }
    } catch {}
  }
}

/** Busca el input del receipt en una página o frame */
async function findReceiptInputIn(frame) {
  const selectors = [
    'input[name="appReceiptNum"]',
    '#appReceiptNum',
    'input[name="receipt_number"]',
    '#receipt_number',
    '#receiptNum',
    'input#caseReceiptNumber',
    'input[aria-label*="receipt" i]',
    'input[placeholder*="receipt" i]',
    'input[placeholder*="número de recibo" i]',
  ];
  for (const s of selectors) {
    const el = frame.locator(s).first();
    try {
      await el.waitFor({ state: 'visible', timeout: 1200 });
      return el;
    } catch {}
  }
  // Fallback por etiqueta accesible
  const labels = [
    'Enter your receipt number',
    'Ingrese su número de recibo',
    'Receipt Number',
    'Número de recibo',
  ];
  for (const text of labels) {
    const el = frame.getByLabel(new RegExp(text, 'i')).first();
    try {
      await el.waitFor({ state: 'visible', timeout: 1200 });
      return el;
    } catch {}
  }
  return null;
}

/** Busca el botón de submit en una página o frame */
async function findSubmitIn(frame) {
  const candidates = [
    'input[type="submit"][value*="Check" i]',
    '#caseStatusSearch, #caseStatusButton, #allFormSubmitButton',
    'button[type="submit"]',
    'button:has-text("Check Status")',
    'button:has-text("Consultar")',
  ];
  for (const s of candidates) {
    const el = frame.locator(s).first();
    try {
      if (await el.isVisible({ timeout: 800 })) return el;
    } catch {}
  }
  try {
    const el = frame.getByRole('button', { name: /check|status|consultar/i }).first();
    if (await el.isVisible({ timeout: 800 })) return el;
  } catch {}
  return null;
}

/** Vuelca urls de frames a log (debug) */
async function dumpFrames(page) {
  try {
    const frames = page.frames();
    log(`DEBUG: Hay ${frames.length} frame(s)`);
    frames.forEach((f, i) => {
      try {
        log(`  [${i}] url=${f.url()}`);
      } catch {}
    });
  } catch {}
}

/** Intenta obtener HTML de resultado desde una URL dada que contiene el formulario */
async function tryOnUrl(context, url, receipt) {
  const page = await context.newPage();
  try {
    await page.route('**/*', async (route) => {
      const req = route.request();
      const headers = { ...req.headers(), 'Accept-Language': 'en-US,en;q=0.9' };
      await route.continue({ headers });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptBanners(page);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await sleep(500);

    // Manejar posible Cloudflare interstitial
    const warmed = await warmUpCloudflare(page, { maxCycles: 3, waitMs: 3000 });
    if (!warmed) throw new Error('Cloudflare interstitial persistente.');

    await dumpFrames(page);

    // 1) En la página principal
    let input = await findReceiptInputIn(page);
    let submitBtn = null;

    // 2) Si no, en iframes
    if (!input) {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        input = await findReceiptInputIn(f);
        if (input) {
          submitBtn = await findSubmitIn(f);
          break;
        }
      }
    } else {
      submitBtn = await findSubmitIn(page);
    }

    if (!input) {
      // Guardar una muestra del HTML de error para diagnóstico
      const htmlHead = await page.content();
      log('DEBUG: No se encontró input. HTML (primeros 1200 chars):');
      log((htmlHead || '').slice(0, 1200));
      throw new Error('No se encontró el campo de Receipt Number (cambio de DOM o bloqueo).');
    }

    await input.fill(String(receipt));
    await sleep(200);

    if (!submitBtn) {
      // Intentar Enter si no encontramos botón visible
      await input.press('Enter').catch(() => {});
    } else {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
        submitBtn.click({ timeout: 5000 }).catch(() => {}),
      ]);
    }

    // Espera de resultados (varios selectores candidatos)
    const resultSelectors = ['#caseStatus', '.rows.text-center', '.appointment-sec', '.content', 'main'];
    await page.waitForSelector(resultSelectors.join(', '), { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(500);

    // Extrae fragmento significativo si es posible
    for (const sel of resultSelectors) {
      const el = await page.$(sel);
      if (el) {
        const html = await el.evaluate((node) => node.outerHTML).catch(() => '');
        if (html && html.trim().length > 200) return html;
      }
    }
    // Fallback: página completa
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

/** Flujo principal */
(async () => {
  log('USCIS Actions: iniciando…');

  const RAW_API_BASE = process.env.API_BASE || '';
  const API_TOKEN = process.env.API_TOKEN || '';
  const API_BASE = normalizeBase(RAW_API_BASE);

  if (!API_BASE) {
    console.error('ERROR: API_BASE no definido.');
    process.exit(1);
  }
  if (!API_TOKEN) {
    console.error('ERROR: API_TOKEN no definido.');
    process.exit(1);
  }

  log('API_BASE (raw):', RAW_API_BASE ? redact(RAW_API_BASE) : '(vacío)');
  log('API_BASE (normalizada):', redact(API_BASE));

  const queueUrl = `${API_BASE}/queue`;
  log('URL de cola:', redact(queueUrl));

  // === 1) Obtener cola ===
  let queueJson;
  try {
    const res = await fetch(queueUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
      },
    });
    if (!res.ok) throw new Error(`Queue HTTP ${res.status}`);
    queueJson = await res.json();
  } catch (err) {
    console.error('ERROR al pedir cola:', err.message);
    process.exit(1);
  }

  const queue = Array.isArray(queueJson?.queue) ? queueJson.queue : [];
  log(`Se recibieron ${queue.length} item(s) para revisar.`);
  if (!queue.length) {
    log('Nada para hacer.');
    process.exit(0);
  }

  // === 2) Navegador ===
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Ajustar contexto a un perfil “realista”
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const LANDING_URL = 'https://egov.uscis.gov/casestatus/landing.do';
  const LEGACY_URL = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

  const itemsForReport = [];

  // Procesar de forma secuencial para ser más “amigable”
  for (const it of queue) {
    const receipt = String(it.receipt_number || '').trim();
    const tramiteId = it.tramite_id ?? it.id;

    if (!receipt || !tramiteId) {
      log('• Item inválido (sin receipt o tramite_id):', JSON.stringify(it));
      continue;
    }

    log('• Pendiente:', receipt);

    try {
      // Pequeño jitter para no machacar
      await sleep(800 + Math.floor(Math.random() * 700));

      // Intento 1: landing moderna
      let html = await tryOnUrl(context, LANDING_URL, receipt).catch((e) => {
        log(`  Aviso (landing): ${e.message}`);
        return null;
      });

      // Intento 2: ruta clásica si falló la landing
      if (!html || html.length < 200) {
        await sleep(600);
        html = await tryOnUrl(context, LEGACY_URL, receipt).catch((e) => {
          log(`  Aviso (legacy): ${e.message}`);
          return null;
        });
      }

      if (!html || html.length < 200) {
        throw new Error('HTML de resultado insuficiente (posible bloqueo o cambio de DOM).');
      }

      itemsForReport.push({ tramite_id: tramiteId, html });
    } catch (err) {
      console.error(`✗ Error con ${receipt}:`, err.message);
    }
  }

  // Cerrar navegador
  await browser.close().catch(() => {});

  if (!itemsForReport.length) {
    log('No hay items válidos para reportar.');
    process.exit(0);
  }

  // === 3) Reportar al backend ===
  const reportUrl = `${API_BASE}/report`;
  log('URL de reporte:', redact(reportUrl));

  try {
    const res = await fetch(reportUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: itemsForReport }),
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Report HTTP ${res.status} — body: ${(txt || '').slice(0, 500)}`);
    }
    log('Reporte enviado OK. Resumen (primeros 500 chars):');
    log((txt || '').slice(0, 500));
  } catch (err) {
    console.error('ERROR al reportar:', err.message);
    process.exit(2);
  }

  process.exit(0);
})().catch((e) => {
  console.error('Fallo no controlado:', e);
  process.exit(1);
});
