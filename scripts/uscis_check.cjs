#!/usr/bin/env node
/**
 * USCIS Checker — fetch nativo (Node 18+) + Playwright
 *
 * Flujo:
 *  1) GET  {API_BASE}/queue      -> { queue: [{ id|tramite_id, receipt_number }, ...] }
 *  2) Playwright (headless) visita USCIS (landing y fallback legacy),
 *     intenta “calentar” Cloudflare (reloads). Si persiste interstitial, marca bloqueado.
 *  3) Si hay HTML válido -> POST {API_BASE}/report     -> { items: [{ tramite_id, html }, ...] }
 *     Si hay bloqueo    -> POST {API_BASE}/report-failed -> { items: [{ receipt_number, error, meta }, ...] }
 *
 * Entradas:
 *  - API_BASE  : p.ej. https://aroeservices.com/api/uscis
 *  - API_TOKEN : token Bearer
 */
const { chromium } = require('playwright');

function normalizeBase(u) {
  let b = String(u || '').trim();
  b = b.replace(/[?#].*$/, '');
  b = b.replace(/\/+$/, '');
  b = b.replace(/\/queue$/i, '');
  return b;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** Redact host al imprimir */
function redact(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const safeHost = host.length > 8 ? host.replace(/\.(?=[^.]*$)/, '****') : host;
    return `${u.protocol}//${safeHost}${u.pathname}`;
  } catch {
    return String(url).replace(/.{4}$/, '****');
  }
}

/** Cloudflare interstitial detection */
async function isCloudflareInterstitial(page) {
  try {
    const title = await page.title().catch(() => '');
    if (/Attention Required/i.test(title)) return true;
    const cf = page.locator('#cf-wrapper, #cf-error-details');
    if (await cf.first().isVisible({ timeout: 500 }).catch(() => false)) return true;
  } catch {}
  return false;
}

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
  try {
    const labels = [
      'Enter your receipt number',
      'Ingrese su número de recibo',
      'Receipt Number',
      'Número de recibo',
    ];
    for (const text of labels) {
      const el = frame.getByLabel(new RegExp(text, 'i')).first();
      await el.waitFor({ state: 'visible', timeout: 1200 });
      return el;
    }
  } catch {}
  return null;
}

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

async function dumpFrames(page) {
  try {
    const frames = page.frames();
    log(`DEBUG: Hay ${frames.length} frame(s)`);
    frames.forEach((f, i) => {
      try { log(`  [${i}] url=${f.url()}`); } catch {}
    });
  } catch {}
}

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

    const warmed = await warmUpCloudflare(page, { maxCycles: 3, waitMs: 3000 });
    if (!warmed) {
      log('  Aviso: Cloudflare interstitial persistente.');
      return { html: null, blocked: true };
    }

    await dumpFrames(page);

    let input = await findReceiptInputIn(page);
    let submitBtn = null;

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
      const htmlHead = await page.content();
      log('DEBUG: No se encontró input. HTML (primeros 1200 chars):');
      log((htmlHead || '').slice(0, 1200));
      return { html: null, blocked: false };
    }

    await input.fill(String(receipt));
    await sleep(200);
    if (!submitBtn) {
      await input.press('Enter').catch(() => {});
    } else {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
        submitBtn.click({ timeout: 5000 }).catch(() => {}),
      ]);
    }

    // Esperar contenedor de resultado
    const candidates = ['#caseStatus', '.rows.text-center', '.appointment-sec', '.content', 'main'];
    await page.waitForSelector(candidates.join(', '), { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await sleep(400);

    const containers = await page.locator(candidates.join(', ')).all();
    for (const c of containers) {
      try {
        const html = await c.evaluate((n) => n.outerHTML);
        if (html && html.trim().length >= 200) return { html, blocked: false };
      } catch {}
    }
    // Fallback: toda la página
    const all = await page.content();
    if (all && all.trim().length >= 200) return { html: all, blocked: false };

    return { html: null, blocked: false };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  log('USCIS Actions: iniciando…');
  const RAW_API_BASE = process.env.API_BASE || '';
  const API_TOKEN = process.env.API_TOKEN || '';
  const API_BASE = normalizeBase(RAW_API_BASE);
  if (!API_BASE) { console.error('ERROR: API_BASE no definido.'); process.exit(1); }
  if (!API_TOKEN) { console.error('ERROR: API_TOKEN no definido.'); process.exit(1); }

  log('API_BASE (raw):', redact(RAW_API_BASE));
  log('API_BASE (normalizada):', redact(API_BASE));

  const queueUrl = `${API_BASE}/queue`;
  log('URL de cola:', redact(queueUrl));

  let queueJson;
  try {
    const res = await fetch(queueUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Queue HTTP ${res.status}`);
    queueJson = await res.json();
  } catch (err) {
    console.error('ERROR al pedir cola:', err.message);
    process.exit(1);
  }

  const queue = Array.isArray(queueJson?.queue) ? queueJson.queue : [];
  log(`Se recibieron ${queue.length} item(s) para revisar.`);
  if (!queue.length) { log('Nada para hacer.'); process.exit(0); }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const USCIS_LANDING = 'https://egov.uscis.gov/casestatus/landing.do';
  const USCIS_LEGACY  = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

  const okItems = [];
  const blockedItems = [];

  for (const it of queue) {
    const receipt = String(it.receipt_number || '').trim();
    const tramiteId = it.tramite_id ?? it.id; // si tu API devuelve id=tramite_id o un id de cola, el backend ya empata por receipt
    if (!receipt) { log('• Item inválido (sin receipt):', JSON.stringify(it)); continue; }

    log('• Pendiente:', receipt);

    try {
      // Landing moderna
      let { html, blocked } = await tryOnUrl(context, USCIS_LANDING, receipt);
      if (blocked) {
        // Intentar legacy como fallback
        ({ html, blocked } = await tryOnUrl(context, USCIS_LEGACY, receipt));
      }

      if (html && html.length >= 200) {
        okItems.push({ tramite_id: tramiteId, html });
      } else if (blocked) {
        blockedItems.push({ receipt_number: receipt, error: 'cf_blocked', meta: { agent: 'gha' } });
      } else {
        // No bloqueado pero sin HTML suficiente: tratamos como fallo genérico
        blockedItems.push({ receipt_number: receipt, error: 'unknown', meta: { agent: 'gha' } });
      }
    } catch (err) {
      console.error(`✗ Error con ${receipt}:`, err.message);
      blockedItems.push({ receipt_number: receipt, error: 'network', meta: { agent: 'gha', msg: err.message } });
    }

    // Pequeño jitter
    await sleep(700 + Math.floor(Math.random() * 600));
  }

  // Enviar éxitos
  if (okItems.length) {
    const reportUrl = `${API_BASE}/report`;
    log('URL de reporte (ok):', redact(reportUrl));
    try {
      const res = await fetch(reportUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items: okItems }),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error('Reporte OK falló:', res.status, t);
      }
    } catch (err) {
      console.error('Error enviando reporte OK:', err.message);
    }
  }

  // Enviar bloqueos/fallos
  if (blockedItems.length) {
    const failedUrl = `${API_BASE}/report-failed`;
    log('URL de reporte (failed):', redact(failedUrl));
    try {
      const res = await fetch(failedUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items: blockedItems }),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error('Reporte FAILED falló:', res.status, t);
      }
    } catch (err) {
      console.error('Error enviando reporte FAILED:', err.message);
    }
  }

  await browser.close();
  log(`Listo. OK=${okItems.length} | FAILED=${blockedItems.length}`);
  process.exit(0);
})();
