#!/usr/bin/env node

/**
 * USCIS case status checker
 * - Headless 100%
 * - Respeta backoff/jitter para evitar bloqueos
 * - Envía resultados por webhook a tu API Laravel
 *
 * Requiere:
 *   - process.env.API_BASE (p.ej. https://aroeservices.com/api/uscis)
 *   - process.env.API_TOKEN (Bearer)
 *
 * Flujo:
 *   1) GET {API_BASE}/queue  -> { status: "ok", queue: [{receipt_number, id, ...}, ...] }
 *   2) Por cada item:
 *        - Navegar a https://egov.uscis.gov/casestatus/landing.do
 *        - Ingresar número y consultar
 *        - Parsear título y cuerpo del estado
 *        - POST {API_BASE}/webhook/status  (Authorization: Bearer <token>)
 *        - Esperar con jitter antes del siguiente ítem
 */

const { chromium, devices } = require('playwright');
const fetch = require('node-fetch');

// ---------- Utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (minMs, maxMs) =>
  Math.floor(minMs + Math.random() * (maxMs - minMs));

function normalizeBaseUrl(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  url = url.replace(/\/+$/g, ''); // sin trailing slash
  return url;
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}]`, ...args);
}

// ---------- Config ----------
const RAW_API_BASE = process.env.API_BASE || '';
const API_BASE = normalizeBaseUrl(RAW_API_BASE);
const API_TOKEN = process.env.API_TOKEN || '';

if (!API_BASE || !API_TOKEN) {
  console.error('Faltan variables de entorno API_BASE y/o API_TOKEN');
  process.exit(2);
}

// Frecuencia/espaciado recomendado (anti-bloqueos):
// - Jitter entre ítems: 8–18s
// - Random UA/viewport
const PER_ITEM_MIN_WAIT_MS = 8000;
const PER_ITEM_MAX_WAIT_MS = 18000;

// Navegación USCIS
const USCIS_LANDING = 'https://egov.uscis.gov/casestatus/landing.do';

// Algunos selectores conocidos (con fallback)
const SELECTORS = {
  input: ['#receipt_number', 'input[name="appReceiptNum"]', 'input#receipt_number'],
  submit: ['input[type="submit"]', 'button[type="submit"]', 'button:has-text("Check Status")', 'input#caseStatusSearch'],
  statusTitle: [
    'h1',
    '.current-status h1',
    '#formCaseStatus h1',
    '.rows.text-center h1',
  ],
  statusBody: [
    '.appointment-sec p',
    '#casestatus p',
    '.rows.text-center p',
    'p',
  ],
  captcha: ['iframe[src*="recaptcha"]', 'div.g-recaptcha', 'iframe[title*="challenge"]'],
};

async function tryFillAndSubmit(page, receipt) {
  // Esperas y fallbacks para el input
  let inputEl = null;
  for (const sel of SELECTORS.input) {
    try {
      inputEl = await page.waitForSelector(sel, { timeout: 4000 });
      if (inputEl) break;
    } catch (_) {}
  }
  if (!inputEl) throw new Error('No encontré el input del número de recibo.');

  await inputEl.click({ delay: 50 });
  await inputEl.fill('');
  await inputEl.type(receipt, { delay: 40 });

  // Intentar enviar
  for (const sel of SELECTORS.submit) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
          btn.click({ delay: 60 }),
        ]);
        return;
      }
    } catch (_) {}
  }

  // Fallback: Enter
  await inputEl.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

async function anySelector(page, arr) {
  for (const s of arr) {
    const el = await page.$(s);
    if (el) return el;
  }
  return null;
}

async function getInnerText(el) {
  if (!el) return '';
  const txt = (await el.innerText()).trim();
  return txt.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

async function looksLikeCaptcha(page) {
  // Si aparece un recaptcha/challenge, devolvemos true
  for (const sel of SELECTORS.captcha) {
    const has = await page.$(sel);
    if (has) return true;
  }
  // También si no aparece ningún contenedor de resultados tras enviar
  const h1 = await anySelector(page, SELECTORS.statusTitle);
  const p = await anySelector(page, SELECTORS.statusBody);
  if (!h1 && !p) {
    // Puede ser que USCIS cambió, pero también puede ser challenge.
    // Dejamos como "posible captcha".
    return false; // conservador
  }
  return false;
}

async function scrapeOne(browser, receipt) {
  const context = await browser.newContext({
    userAgent: devices['Desktop Chrome HiDPI'].userAgent.replace('Headless', ''),
    viewport: { width: 1280 + Math.floor(Math.random() * 240), height: 900 + Math.floor(Math.random() * 200) },
    locale: 'en-US',
  });
  const page = await context.newPage();

  try {
    // Jitter inicial por item
    await sleep(jitter(1500, 4000));

    await page.goto(USCIS_LANDING, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await tryFillAndSubmit(page, receipt);

    // Esperar contenido
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    if (await looksLikeCaptcha(page)) {
      throw new Error('Captcha o challenge detectado; no se pudo continuar.');
    }

    const titleEl = await anySelector(page, SELECTORS.statusTitle);
    const bodyEl = await anySelector(page, SELECTORS.statusBody);

    const status_title = await getInnerText(titleEl);
    const status_body = await getInnerText(bodyEl);

    if (!status_title && !status_body) {
      throw new Error('No se pudo extraer el estado (selectores vacíos).');
    }

    return {
      ok: true,
      receipt_number: receipt,
      status_title,
      status_body,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      receipt_number: receipt,
      error: err?.message || String(err),
      checked_at: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function run() {
  log('USCIS Actions: iniciando…');
  log('API_BASE (normalizada):', API_BASE);

  // 1) Obtener cola
  const queueUrl = `${API_BASE}/queue`;
  const q = await httpJson(queueUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: 'application/json',
      'User-Agent': 'uscis-actions/1.0 (+github-actions)',
    },
  });

  if (!q.ok) {
    console.error('No se pudo obtener la cola:', q.status, q.text);
    process.exit(1);
  }
  const items = Array.isArray(q.json?.queue) ? q.json.queue : [];
  log(`Se recibieron ${items.length} item(s) para revisar.`);

  if (items.length === 0) {
    log('Nada para hacer.');
    return;
  }

  for (const it of items) {
    log('• Pendiente:', it.receipt_number);
  }

  // 2) Scraping headless
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    for (let idx = 0; idx < items.length; idx++) {
      const { receipt_number } = items[idx];
      const res = await scrapeOne(browser, receipt_number);

      // 3) Enviar webhook con resultado
      const hookUrl = `${API_BASE}/webhook/status`;
      const payload = res.ok
        ? {
            receipt_number: res.receipt_number,
            status_title: res.status_title,
            status_body: res.status_body,
            checked_at: res.checked_at,
            ok: true,
          }
        : {
            receipt_number: res.receipt_number,
            error: res.error,
            checked_at: res.checked_at,
            ok: false,
          };

      const post = await httpJson(hookUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'uscis-actions/1.0 (+github-actions)',
        },
        body: JSON.stringify(payload),
      });

      if (!post.ok) {
        console.error(
          `Webhook error (${receipt_number}):`,
          post.status,
          post.text
        );
      } else {
        log(`Webhook OK (${receipt_number})`);
      }

      // Anti-bloqueos: jitter entre ítems
      if (idx < items.length - 1) {
        const wait = jitter(PER_ITEM_MIN_WAIT_MS, PER_ITEM_MAX_WAIT_MS);
        log(`Esperando ${Math.round(wait / 1000)}s antes del siguiente…`);
        await sleep(wait);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log('Proceso finalizado.');
}

run().catch((e) => {
  console.error('Error fatal:', e);
  process.exit(1);
});
