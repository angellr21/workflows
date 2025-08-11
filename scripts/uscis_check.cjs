// scripts/uscis_check.cjs
'use strict';

const { chromium } = require('playwright');

const API_BASE = (process.env.API_BASE || '').replace(/\/+$/, '');
const API_TOKEN = process.env.API_TOKEN || '';
const HEADFUL = process.env.HEADFUL === '1';
const DEBUG = process.env.DEBUG === '1';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined; // opcional

if (!API_BASE || !API_TOKEN) {
  console.error('Missing API_BASE or API_TOKEN envs.');
  process.exit(1);
}

const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing';

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  try { return JSON.parse(text); } catch { return {}; }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return text;
}

async function fetchQueue({ force, limit } = {}) {
  const u = new URL(`${API_BASE}/api/uscis/queue`);
  if (force) u.searchParams.set('force', '1');
  if (limit) u.searchParams.set('limit', String(limit));

  log('Fetching queue from API (GET):', `${u.pathname}${u.search}`);
  try {
    const data = await getJson(u.toString(), {
      Authorization: `Bearer ${API_TOKEN}`,
    });
    // El backend a veces devuelve {queue:[]} y a veces {tramites:[]}
    const items = Array.isArray(data.queue) ? data.queue
                : Array.isArray(data.tramites) ? data.tramites
                : [];
    return items;
  } catch (err) {
    log('Queue API error (soft-fail):', String(err));
    return [];
  }
}

async function reportSuccess(items) {
  if (!items.length) return;
  const url = `${API_BASE}/api/uscis/report`;
  await postJson(url, { items }, { Authorization: `Bearer ${API_TOKEN}` });
}

async function reportFailures(items) {
  if (!items.length) return;
  const url = `${API_BASE}/api/uscis/report-failed`;
  await postJson(url, { items }, { Authorization: `Bearer ${API_TOKEN}` });
}

/**
 * Espera a que Cloudflare “Just a moment / Verifying you are human”
 * se complete sola (sin captcha). Máx. ~60s.
 */
async function passCloudflare(page, { maxWaitMs = 60000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // ¿Ya está el input del recibo?
    const ready = await page.locator(
      'input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]'
    ).first().isVisible().catch(() => false);
    if (ready) return true;

    // ¿Sigue mostrando la página de Cloudflare?
    const cfTitle = (await page.title().catch(() => '')) || '';
    const cfOn =
      /just a moment|verifying you are human|checking your browser/i.test(cfTitle) ||
      await page.locator('text=/Verifying you are human/i').first().isVisible().catch(() => false) ||
      await page.locator('#cf-please-wait, #challenge-running, iframe[src*="challenge"]').count().then(c => c > 0).catch(() => false);

    if (!cfOn) {
      // Carga normal pero aún no aparece el input — espera un poco más
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(800);
    } else {
      // Deja respirar la página para que ejecute el JS de verificación
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1500 + Math.floor(Math.random() * 900));
    }
  }
  return false;
}

async function firstVisible(page, selectors = [], { timeoutPerSel = 4000 } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: timeoutPerSel });
      return el;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: !HEADFUL, // por defecto headless; puedes setear HEADFUL=1 en el workflow para pruebas
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Pequeños ajustes anti-automation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(45000);

  return { browser, context, page };
}

async function scrapeOne(page, receipt) {
  const failures = [];

  // 2 intentos por recibo con espera y “jitter”
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(USCIS_URL, { waitUntil: 'domcontentloaded' });

      // Esperar Cloudflare si aparece
      const cfOk = await passCloudflare(page, { maxWaitMs: 60000 });
      if (!cfOk) {
        throw new Error('Cloudflare guard did not finish in time');
      }

      // Buscar input del recibo
      const input = await firstVisible(page, [
        'input#receipt_number',
        'input[name="appReceiptNum"]',
        'input[name="receiptNumber"]',
        'input[id*="receipt"]',
        'input[aria-label*="Receipt"]',
      ], { timeoutPerSel: 6000 });

      if (!input) {
        const snippet = (await page.content().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`Receipt input not found — ${snippet}`);
      }

      await input.fill('');
      await input.type(receipt, { delay: 50 + Math.floor(Math.random() * 25) });

      // Botón de búsqueda
      const submitBtn = await firstVisible(page, [
        'form button[type="submit"]',
        'button#caseStatusSearch',
        'button:has-text("Check Status")',
        'input[type="submit"]',
      ], { timeoutPerSel: 4000 });

      if (!submitBtn) {
        throw new Error('Submit button not found');
      }

      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        submitBtn.click(),
      ]);

      // Si vuelve a aparecer Cloudflare, espera otra vez
      await passCloudflare(page, { maxWaitMs: 45000 });

      // Esperar resultados: un h1 y algún texto descriptivo
      const titleEl = await firstVisible(page, [
        '#caseStatus h1',
        'h1',
      ], { timeoutPerSel: 8000 });

      const detailsEl = await firstVisible(page, [
        '#caseStatus .rows p',
        '#caseStatus p',
        'article p',
        'main p',
        'p',
      ], { timeoutPerSel: 8000 });

      // Si no hay ninguno visible, igual capturamos el HTML completo para que el backend lo parsee
      const html = await page.content();

      return { ok: true, html }; // el backend extrae h1 y p
    } catch (err) {
      const html = await page.content().catch(() => '');
      const snippet = html.replace(/\s+/g, ' ').slice(0, 200);
      const msg = `${err.message || String(err)}${snippet ? ` — ${snippet}` : ''}`;
      failures.push(msg);
      if (attempt < 2) {
        await sleep(1200 + Math.floor(Math.random() * 800));
      }
    }
  }

  return { ok: false, error: failures.join(' | ') };
}

async function main() {
  log('--- Scraping Cycle Started ---');
  log('API_BASE_URL:', API_BASE);

  const queue = await fetchQueue({ limit: LIMIT });
  log('Queue size:', queue.length);

  if (!queue.length) {
    log('No receipts to process (or API unavailable). Exiting gracefully.');
    return;
  }

  const { browser, page, context } = await launchBrowser();

  const successes = [];
  const failures = [];

  try {
    for (const item of queue) {
      const rn = item.receipt_number || item.uscis_receipt_number;
      if (!rn) continue;

      log('Processing:', rn);

      const result = await scrapeOne(page, rn);

      if (result.ok) {
        successes.push({ tramite_id: item.tramite_id, html: result.html });
      } else {
        log(`FAIL ${rn}:`, result.error);
        failures.push({
          receipt_number: rn,
          error: result.error.slice(0, 500),
        });
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (successes.length) {
    log(`Reporting successes: ${successes.length}`);
    try { await reportSuccess(successes); } catch (e) { log('Report success error:', String(e)); }
  } else {
    log('No successful scrapes to report.');
  }

  if (failures.length) {
    log(`Reporting failed items: ${failures.length}`);
    try { await reportFailures(failures); } catch (e) { log('Report failed error:', String(e)); }
  }

  log('--- Scraping Cycle Finished ---');
}

// Ejecutar
main().catch(err => {
  console.error(err);
  process.exit(1);
});
