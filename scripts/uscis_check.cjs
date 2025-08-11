#!/usr/bin/env node
/* scripts/uscis_check.cjs */
/* Versión del scraper con manejo de errores mejorado y logging. */
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

// --- SIMPLE FETCH WRAPPER ---
async function reportToApi(endpoint, payload) {
  const url = `${API_BASE_URL}/api/uscis/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${endpoint} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json().catch(() => ({}));
}

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

  // 1) Pedir cola a la API
  log('Fetching queue from API...');
  const queue = await (async () => {
    const data = await reportToApi('queue', {});
    if (!data || !Array.isArray(data.receipts)) return [];
    return data.receipts.map(r => String(r || '').trim()).filter(Boolean);
  })();

  log(`Queue size: ${queue.length}`);
  if (!queue.length) {
    await browser.close();
    log('No receipts to process. Exiting.');
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
        // **MEJORA**: Enviamos el HTML de la página fallida para diagnóstico.
        meta: { failed_html: result.fullPageHtml }
      });
    }
    await sleep(1500 + Math.random() * 1500); // Jitter entre peticiones
  }

  await reportToApi('report', successfulScrapes);
  await reportToApi('report-failed', failedScrapes);

  await browser.close();
  log('--- Scraping Cycle Finished ---');
})();
