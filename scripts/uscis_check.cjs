// scripts/uscis_check.cjs
'use strict';

/**
 * Worker: USCIS scraper
 * - Lee la cola desde la API (GET /queue?force=1&limit=N)
 * - Visita https://egov.uscis.gov/casestatus/landing
 * - Rellena el receipt, envía y obtiene el HTML del resultado
 * - Reporta éxitos a POST /report y fallos a POST /report-failed
 *
 * Variables de entorno:
 *  - API_BASE   (obligatorio)  e.g. https://mi-api.test/api/uscis
 *  - API_TOKEN  (opcional)     token Bearer
 *  - LIMIT      (opcional)     número de items por corrida
 *  - FORCE      (opcional)     fuerza la cola (?force=1)
 *  - HEADFUL=1  (opcional)     abre Chromium con UI (bajo xvfb en Actions)
 *  - DEBUG=1    (opcional)     logs extra
 */

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const { chromium } = require('playwright');

// ========= ENV & CONFIG =========
const RAW_BASE   = (process.env.API_BASE || '').trim();
const API_TOKEN  = process.env.API_TOKEN || '';
const HEADFUL    = process.env.HEADFUL === '1';
const DEBUG      = process.env.DEBUG === '1';
const LIMIT      = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const FORCE      = (process.env.FORCE || '1').trim(); // por defecto forzamos ?force=1

if (!RAW_BASE) {
  console.error('API_BASE is required.');
  process.exit(2);
}

const API_BASE_URL = RAW_BASE.replace(/\/+$/, ''); // sin trailing slash
const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing';

// ========= LOG/UTILS =========
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function errInfo(err) {
  const c = err && (err.cause || err);
  const bits = [];
  if (err && err.message) bits.push(err.message);
  if (c && c.code) bits.push(`code=${c.code}`);
  if (c && c.status) bits.push(`status=${c.status}`);
  return bits.join(' ');
}

// ========= HTTP HELPERS =========
const defaultHeaders = () => {
  const h = { 'Content-Type': 'application/json' };
  if (API_TOKEN) {
    h['Authorization'] = `Bearer ${API_TOKEN}`;
  }
  return h;
};

async function httpGetJson(path) {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, { headers: defaultHeaders(), method: 'GET' });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function httpPostJson(path, body) {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: defaultHeaders(),
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

// ========= API CALLS =========
async function getQueue({ limit, force }) {
  const q = [];
  if (force && `${force}`.trim() !== '') q.push(`force=${encodeURIComponent(force)}`);
  if (Number.isFinite(limit)) q.push(`limit=${limit}`);
  const qs = q.length ? `?${q.join('&')}` : '';
  log(`Fetching queue from API (GET): ${API_BASE_URL}/queue${qs}`);
  const data = await httpGetJson(`/queue${qs}`);
  if (DEBUG) log('Queue raw payload:', JSON.stringify(data));
  const tramites = Array.isArray(data?.tramites) ? data.tramites : [];
  log(`Queue size: ${tramites.length}`);
  return tramites;
}

async function reportSuccess(items) {
  if (!items.length) return { ok: true, skipped: 0 };
  return httpPostJson('/report', { items });
}

async function reportFailures(items) {
  if (!items.length) return { ok: true, skipped: 0 };
  return httpPostJson('/report-failed', { items });
}

// ========= BROWSER UTILS =========
function buildCommonLaunchArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
}

function buildCommonContextOptions() {
  return {
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    // SIN userAgent hardcodeado: usar el UA real de Chromium actual
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

async function prepareContext(browser) {
  const context = await browser.newContext(buildCommonContextOptions());
  await context.addInitScript(() => {
    // Pequeños toques “stealth”
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4] });
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(45_000);
  return { context, page };
}

// ========= CLOUDFLARE GUARD (espera pasiva) =========
async function passCloudflare(page, { maxWaitMs = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // ¿Ya vemos el input de receipt?
    const ready = await page
      .locator('input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]')
      .first().isVisible().catch(() => false);
    if (ready) return true;

    // ¿Señales de challenge?
    const title = await page.title().catch(() => '');
    const cfOn =
      /Just a moment|Attention Required|Security check|challenge|Verify/i.test(title) ||
      await page.locator('text=/Verifying you are human|Just a moment|Please wait/i').first().isVisible().catch(() => false) ||
      await page.locator('#cf-please-wait, #challenge-running').count().then(c => c > 0).catch(() => false);

    // Darle tiempo al JS a que corra
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(cfOn ? (1500 + Math.floor(Math.random() * 900)) : 800);
  }
  return false;
}

// ========= SCRAPER =========
async function scrapeOne(page, item) {
  const receipt = (item?.receipt_number || '').trim();
  if (!receipt) throw new Error('Missing receipt_number');

  // 1) Landing
  await page.goto(USCIS_URL, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const cfOk = await passCloudflare(page);
  if (!cfOk) {
    throw new Error('Cloudflare guard did not finish in time');
  }

  // 2) Ingresar receipt
  const input = page.locator('input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]').first();
  await input.waitFor({ state: 'visible', timeout: 20_000 });
  await input.fill('');
  await sleep(200 + Math.floor(Math.random() * 300));
  await input.type(receipt, { delay: 60 + Math.floor(Math.random() * 40) });

  // 3) Submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Check Status"), input[type="submit"]').first();
  await Promise.all([
    page.waitForLoadState('load'),
    submitBtn.click()
  ]);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await passCloudflare(page);

  // 4) Extra: a veces aparece un dialog o banner
  const okBtn = page.locator('button:has-text("OK"), button:has-text("Accept"), button:has-text("I Agree")').first();
  if (await okBtn.isVisible().catch(() => false)) {
    await okBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }

  // 5) Capturar HTML de resultado
  const html = await page.content();
  return {
    tramite_id: item.tramite_id,
    receipt_number: receipt,
    html,
  };
}

async function processQueue(items) {
  const successes = [];
  const failures = [];

  // Lanzamos un browser y vamos creando contexts limpios por caso
  const browser = await chromium.launch({ headless: !HEADFUL, args: buildCommonLaunchArgs() });
  try {
    for (const it of items) {
      let context, page;
      try {
        log('Processing:', it.receipt_number);
        ({ context, page } = await prepareContext(browser));
        const result = await scrapeOne(page, it);
        successes.push(result);
      } catch (err) {
        const msg = `FAIL ${it.receipt_number}: ${err.message}`;
        log(msg, '—', errInfo(err));
        failures.push({
          tramite_id: it.tramite_id,
          receipt_number: it.receipt_number,
          error: err.message,
        });
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { successes, failures };
}

// ========= MAIN =========
async function main() {
  log('--- Scraping Cycle Started ---');
  log('API_BASE_URL:', API_BASE_URL);

  const queue = await getQueue({ limit: LIMIT, force: FORCE });
  if (!queue.length) {
    log('Queue empty. Exiting.');
    return;
  }

  const { successes, failures } = await processQueue(queue);

  if (successes.length) {
    log(`Reporting successful items: ${successes.length}`);
    await reportSuccess(successes);
  } else {
    log('No successful scrapes to report.');
  }

  if (failures.length) {
    log(`Reporting failed items: ${failures.length}`);
    await reportFailures(failures);
  }

  log('--- Scraping Cycle Finished ---');
}

main().catch(err => { console.error(err); process.exit(1); });
