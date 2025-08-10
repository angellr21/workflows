#!/usr/bin/env node
/**
 * USCIS Checker — sin dependencias externas (fetch nativo de Node 18+ y Playwright)
 *
 * Flujo:
 *  1) GET  {API_BASE}/queue      -> { queue: [{ tramite_id|id, receipt_number }, ...] }
 *  2) Playwright (headless) visita USCIS, rellena receipt y obtiene HTML del resultado
 *  3) POST {API_BASE}/report     -> { items: [{ tramite_id, html }, ...] }
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

function redact(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const safeHost = host.length > 8 ? host.slice(0, host.length - 4) + '****' : host;
    return `${u.protocol}//${safeHost}${u.pathname}`;
  } catch {
    return String(url).replace(/.{4}$/, '****');
  }
}

async function clickIfExists(locator, timeout = 2000) {
  try {
    if (await locator.first().isVisible({ timeout })) {
      await locator.first().click({ timeout });
      return true;
    }
  } catch {}
  return false;
}

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

  let queueJson;
  try {
    const res = await fetch(queueUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
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

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing.do';

  async function acceptBanners(pageOrFrame) {
    // Varios candidatos comunes (OneTrust / cookie banners / consent)
    const candidates = [
      '#onetrust-accept-btn-handler',
      'button#onetrust-accept-btn-handler',
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
      'button:has-text("I Agree")',
      'button:has-text("Got it")',
      'button:has-text("Entiendo")',
      'button:has-text("Aceptar")',
      '[aria-label="accept cookies"]',
      'button[title*="Accept"]',
    ];
    for (const sel of candidates) {
      try {
        const loc = pageOrFrame.locator(sel);
        if (await loc.first().isVisible({ timeout: 1000 })) {
          await loc.first().click({ timeout: 1500 });
          await sleep(500);
        }
      } catch {}
    }
  }

  async function findReceiptInputIn(frame) {
    // Intentar múltiples selectores para robustez
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
      'input[type="text"]',
    ];
    for (const s of selectors) {
      const el = frame.locator(s).first();
      try {
        await el.waitFor({ state: 'visible', timeout: 1000 });
        return el;
      } catch {}
    }
    // Buscar por label cercano
    const labels = [
      'Enter your receipt number',
      'Ingrese su número de recibo',
      'Receipt Number',
      'Número de recibo',
    ];
    for (const text of labels) {
      const el = frame.getByLabel(new RegExp(text, 'i')).first();
      try {
        await el.waitFor({ state: 'visible', timeout: 1000 });
        return el;
      } catch {}
    }
    return null;
  }

  async function findSubmitIn(frame) {
    const candidates = [
      'input[type="submit"][value*="Check" i]',
      'button[type="submit"]',
      '#caseStatusSearch, #caseStatusButton, #allFormSubmitButton',
      'input[type="submit"]',
      'button:has-text("Check Status")',
      'button:has-text("Consultar")',
    ];
    for (const s of candidates) {
      const el = frame.locator(s).first();
      try {
        if (await el.isVisible({ timeout: 800 })) return el;
      } catch {}
    }
    // Rol accesible como fallback
    try {
      const el = frame.getByRole('button', { name: /check|status|consultar/i }).first();
      if (await el.isVisible({ timeout: 800 })) return el;
    } catch {}
    return null;
  }

  async function dumpFrames(page) {
    try {
      const frames = page.frames();
      console.log(`DEBUG: Hay ${frames.length} frame(s)`);
      frames.forEach((f, i) => {
        try { console.log(`  [${i}] url=${f.url()}`); } catch {}
      });
    } catch {}
  }

  async function fetchCaseHtml(receipt) {
    const page = await context.newPage();
    try {
      await page.goto(USCIS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await acceptBanners(page);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await sleep(800);

      // Si existen iframes, intentar dentro de cada uno
      await dumpFrames(page);
      const frames = page.frames();

      // Primero intentar en la página principal
      let input = await findReceiptInputIn(page);
      let submitBtn = null;

      if (!input) {
        // Intentar en iframes
        for (const f of frames) {
          try {
            await acceptBanners(f);
            input = await findReceiptInputIn(f);
            if (input) {
              submitBtn = await findSubmitIn(f);
              break;
            }
          } catch {}
        }
      } else {
        submitBtn = await findSubmitIn(page);
      }

      if (!input) {
        // Logs de ayuda
        const content = await page.content();
        console.log('DEBUG: No se encontró input. HTML (primeros 1200 chars):');
        console.log(content.slice(0, 1200));
        throw new Error('No se encontró el campo de Receipt Number (cambio de DOM o bloqueo).');
      }

      await input.fill(receipt, { timeout: 5000 });
      await sleep(300);

      if (!submitBtn) {
        // buscar el submit en el mismo frame del input
        const ownerFrame = input.page() || page;
        submitBtn = await findSubmitIn(ownerFrame);
      }
      if (!submitBtn) {
        throw new Error('No se encontró el botón de "Check Status".');
      }

      await Promise.all([
        input.page().waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {}),
        submitBtn.click().catch(() => {}),
      ]);

      // Esperar resultados
      const resultSelectors = [
        '#caseStatus',
        '.rows.text-center',
        '.appointment-sec',
        '.content',
        'main',
        '#caseStatusText',
        'section:has(h1), section:has(h2)',
      ];

      // Probar en main y frames
      let resultHtml = null;
      // Primero revisar main
      try {
        await page.waitForSelector(resultSelectors.join(', '), { timeout: 15000 });
        for (const sel of resultSelectors) {
          const el = await page.$(sel);
          if (el) {
            const html = await el.evaluate((n) => n.outerHTML);
            if (html && html.trim().length > 200) {
              resultHtml = html;
              break;
            }
          }
        }
      } catch {}

      if (!resultHtml) {
        // Probar en frames
        for (const f of page.frames()) {
          try {
            await f.waitForSelector(resultSelectors.join(', '), { timeout: 8000 });
            for (const sel of resultSelectors) {
              const el = await f.$(sel);
              if (el) {
                const html = await el.evaluate((n) => n.outerHTML);
                if (html && html.trim().length > 200) {
                  resultHtml = html;
                  break;
                }
              }
            }
            if (resultHtml) break;
          } catch {}
        }
      }

      if (!resultHtml) {
        // Como último recurso, devolver toda la página
        return await page.content();
      }
      return resultHtml;
    } finally {
      await page.close().catch(() => {});
    }
  }

  const itemsForReport = [];
  for (const it of queue) {
    const receipt = String(it.receipt_number || '').trim();
    const tramiteId = it.tramite_id ?? it.id;

    if (!receipt || !tramiteId) {
      log('• Item inválido (sin receipt o tramite_id):', JSON.stringify(it));
      continue;
    }

    log('• Pendiente:', receipt);

    try {
      await sleep(1000 + Math.floor(Math.random() * 700));
      const html = await fetchCaseHtml(receipt);
      if (!html || html.length < 200) throw new Error('HTML de resultado demasiado corto.');
      itemsForReport.push({ tramite_id: tramiteId, html });
    } catch (err) {
      console.error(`✗ Error con ${receipt}:`, err.message);
    }
  }

  if (!itemsForReport.length) {
    await browser.close();
    log('No hay items válidos para reportar.');
    process.exit(0);
  }

  const reportUrl = `${API_BASE}/report`;
  log('URL de reporte:', redact(reportUrl));

  try {
    const res = await fetch(reportUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: itemsForReport }),
    });

    const bodyText = await res.text().catch(() => '');
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch {}

    if (!res.ok) throw new Error(`Report HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    log('Reporte enviado. Respuesta:', bodyJson ? JSON.stringify(bodyJson).slice(0, 500) : bodyText.slice(0, 500));
  } catch (err) {
    console.error('ERROR al enviar reporte:', err.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  log('Listo.');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
