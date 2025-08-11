#!/usr/bin/env node
/* scripts/uscis_check.cjs */
/* Versión del scraper con manejo de errores mejorado y logging (soft-fail en queue). */
const { chromium } = require('playwright-chromium');

// --- HELPERS ---
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeBase = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api\/uscis\/?$/, '');

// --- CONFIGURATION ---
const API_BASE_URL = normalizeBase(process.env.API_BASE);
const API_TOKEN = process.env.API_TOKEN;
const USCIS_LANDING_URL = 'https://egov.uscis.gov/casestatus/landing.do';
const USCIS_LEGACY_URL = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

const REQUIRED_ENVS = ['API_BASE', 'API_TOKEN'];
for (const v of REQUIRED_ENVS) {
  if (!process.env[v] || !String(process.env[v]).trim()) {
    console.error(`Missing required env var: ${v}`);
    process.exit(1);
  }
}

// --- HTTP WRAPPERS ---
async function getJson(url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json().catch(() => ({}));
}

// Endpoints helpers
const apiUrl = (endpoint) => `${API_BASE_URL}/api/uscis/${endpoint}`;

// Soft-fail: si la API de cola está caída o con 500, devolvemos [] para no romper el job
const getQueueFromApi = async () => {
  const url = apiUrl('queue');
  try {
    return await getJson(url);
  } catch (err) {
    log('Queue API error (soft-fail):', err.message);
    return { receipts: [] };
  }
};

const reportSuccessToApi = (items) => postJson(apiUrl('report'), items);         // POST
const reportFailedToApi  = (items) => postJson(apiUrl('report-failed'), items);  // POST

// --- SCRAPER CORE ---
async function scrapeCase(page, receipt) {
  const result = { receipt, ok: false, status: null, details: null, error: null, fullPageHtml: null };

  try {
    // Intento moderno (landing + form moderno)
    await page.goto(USCIS_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(500);
    const hasModernForm = await page.locator('form[action*="casestatus"]').count().catch(() => 0);

    if (hasModernForm) {
      await page.fill('input[name="receipt_number"]', receipt, { timeout: 10000 });
      await Promise.any([
        page.click('button[type="submit"]'),
        page.press('input[name="receipt_number"]', 'Enter')
      ]);
      await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    } else {
      // Fallback a legacy
      await page.goto(USCIS_LEGACY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('#receipt_number', receipt, { timeout: 15000 });
      await Promise.any([
        page.click('input[type="submit"]'),
        page.press('#receipt_number', 'Enter')
      ]);
      await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
    }

    // Extraer status
    const statusTitle = await page.locator('h1, h2, .rows.text-center h1, .rows.text-center h2').first().textContent().catch(() => null);
    const statusBody = await page.locator('#formErrors, .appointment-sec p, .current-status-sec p, .rows.text-center p').first().textContent().catch(() => null);

    if (statusTitle || statusBody) {
      result.ok = true;
      result.status = (statusTitle || '').trim();
      result.details = (statusBody || '').replace(/\s+/g, ' ').trim();
    } else {
      throw new Error('Unable to extract status text');
    }
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
    try {
      result.fullPageHtml = await page.content();
    } catch (_) {}
  }

  return result;
}

(async () => {
  log('--- Scraping Cycle Started ---');
  log('API_BASE_URL:', API_BASE_URL);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox'
    ]
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1) Pedir cola a la API (GET, soft-fail)
  const queueUrl = apiUrl('queue');
  log('Fetching queue from API (GET):', queueUrl);
  const queue = await (async () => {
    const data = await getQueueFromApi();
    // Soportar posibles formas del payload
    let items = [];
    if (Array.isArray(data?.receipts)) {
      items = data.receipts;
    } else if (Array.isArray(data?.tramites)) {
      items = data.tramites.map(t => t?.receipt_number ?? t?.receipt ?? t?.number).filter(Boolean);
    }
    return items.map(r => String(r || '').trim()).filter(Boolean);
  })();

  log(`Queue size: ${queue.length}`);
  if (!queue.length) {
    await browser.close();
    log('No receipts to process (or API unavailable). Exiting gracefully.');
    process.exit(0);
  }

  const successfulScrapes = [];
  const failedScrapes = [];

  for (const receipt of queue) {
    log(`Processing: ${receipt}`);
    const result = await scrapeCase(page, receipt);
    if (result.ok) {
      successfulScrapes.push({
        receipt: result.receipt,
        status: result.status,
        details: result.details
      });
    } else {
      failedScrapes.push({
        receipt: result.receipt,
        error: result.error,
        meta: { failed_html: result.fullPageHtml }
      });
    }
    await sleep(1500 + Math.random() * 1500); // Jitter entre peticiones
  }

  // 2) Reportes (POST) — solo si hay algo que enviar
  if (successfulScrapes.length) {
    await reportSuccessToApi(successfulScrapes);
  } else {
    log('No successful scrapes to report.');
  }
  if (failedScrapes.length) {
    await reportFailedToApi(failedScrapes);
  } else {
    log('No failed scrapes to report.');
  }

  await browser.close();
  log('--- Scraping Cycle Finished ---');
})();
