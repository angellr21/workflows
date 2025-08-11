// scripts/uscis_check.cjs
'use strict';

const { chromium } = require('playwright');

// ======== CONFIG / UTILS ========

const RAW_BASE = (process.env.API_BASE || '').trim();
const API_TOKEN = process.env.API_TOKEN || '';
const HEADFUL = process.env.HEADFUL === '1';
const DEBUG = process.env.DEBUG === '1';
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

if (!RAW_BASE || !API_TOKEN) {
  console.error('Missing API_BASE or API_TOKEN envs.');
  process.exit(1);
}

// Normaliza API_BASE y detecta si ya trae /api/uscis al final
const BASE_URL = new URL(/^https?:\/\//i.test(RAW_BASE) ? RAW_BASE : `https://${RAW_BASE}`);
const BASE_HAS_USCIS = /\/api\/uscis\/?$/i.test(BASE_URL.pathname);

// Construye URL para endpoints del API sin duplicar rutas
function makeApiUrl(endpoint, params) {
  let path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (!BASE_HAS_USCIS) path = `/api/uscis${path}`;
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url;
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
    throw new Error(`GET ${new URL(url).pathname + new URL(url).search} failed: ${res.status} ${res.statusText} — ${text}`);
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
    throw new Error(`POST ${new URL(url).pathname} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return text;
}

// ======== API CLIENT ========

async function fetchQueue({ force, limit } = {}) {
  const u = makeApiUrl('/queue', { force: force ? 1 : undefined, limit });
  log('Fetching queue from API (GET):', `${u.pathname}${u.search}`);
  try {
    const data = await getJson(u.toString(), { Authorization: `Bearer ${API_TOKEN}` });
    // Soporta {queue:[]} o {tramites:[]}
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
  const url = makeApiUrl('/report').toString();
  await postJson(url, { items }, { Authorization: `Bearer ${API_TOKEN}` });
}

async function reportFailures(items) {
  if (!items.length) return;
  const url = makeApiUrl('/report-failed').toString();
  await postJson(url, { items }, { Authorization: `Bearer ${API_TOKEN}` });
}

// ======== CLOUDFLARE BYPASS PASIVO ========

async function passCloudflare(page, { maxWaitMs = 60000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ready = await page.locator(
      'input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]'
    ).first().isVisible().catch(() => false);
    if (ready) return true;

    const cfTitle = (await page.title().catch(() => '')) || '';
    const cfOn =
      /just a moment|verifying you are human|checking your browser/i.test(cfTitle) ||
      await page.locator('text=/Verifying you are human/i').first().isVisible().catch(() => false) ||
      await page.locator('#cf-please-wait, #challenge-running, iframe[src*="challenge"]').count().then(c => c > 0).catch(() => false);

    if (!cfOn) {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(800);
    } else {
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
    } catch (_) {}
  }
  return null;
}

// ======== BROWSER ========

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: !HEADFUL,
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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(45000);

  return { browser, context, page };
}

// ======== SCRAPER ========

async function scrapeOne(page, receipt) {
  const failures = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(USCIS_URL, { waitUntil: 'domcontentloaded' });

      const cfOk = await passCloudflare(page, { maxWaitMs: 60000 });
      if (!cfOk) throw new Error('Cloudflare guard did not finish in time');

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

      const submitBtn = await firstVisible(page, [
        'form button[type="submit"]',
        'button#caseStatusSearch',
        'button:has-text("Check Status")',
        'input[type="submit"]',
      ], { timeoutPerSel: 4000 });

      if (!submitBtn) throw new Error('Submit button not found');

      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        submitBtn.click(),
      ]);

      await passCloudflare(page, { maxWaitMs: 45000 });

      // Devolvemos HTML completo; tu backend lo parsea
      const html = await page.content();
      return { ok: true, html };
    } catch (err) {
      const html = await page.content().catch(() => '');
      const snippet = html.replace(/\s+/g, ' ').slice(0, 200);
      const msg = `${err.message || String(err)}${snippet ? ` — ${snippet}` : ''}`;
      failures.push(msg);
      if (attempt < 2) await sleep(1200 + Math.floor(Math.random() * 800));
    }
  }

  return { ok: false, error: failures.join(' | ') };
}

// ======== MAIN ========

async function main() {
  log('--- Scraping Cycle Started ---');
  log('API_BASE_URL:', BASE_URL.origin + BASE_URL.pathname.replace(/\/$/, ''));

  const queue = await fetchQueue({ limit: LIMIT });
  log('Queue size:', queue.length);

  if (!queue.length) {
    log('No receipts to process (or API unavailable). Exiting gracefully.');
    return;
  }

  const { browser, context, page } = await launchBrowser();

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
        failures.push({ receipt_number: rn, error: result.error.slice(0, 500) });
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
