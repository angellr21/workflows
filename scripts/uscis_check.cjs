#!/usr/bin/env node
/* scripts/uscis_check.cjs */
/* Worker USCIS – flujo y selectores robustos (direct + form) + payloads compatibles + soporte force queue. */
const { chromium } = require('playwright-chromium');

// --- HELPERS ---
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeBase = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api\/uscis\/?$/, '');

// --- CONFIGURATION ---
const API_BASE_URL = normalizeBase(process.env.API_BASE);
const API_TOKEN = process.env.API_TOKEN;
const USCIS_LANDING_URL = 'https://egov.uscis.gov/casestatus/landing.do';
const USCIS_RESULTS_URL = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

// Decidir si forzamos la cola
const shouldForceQueue = (() => {
  const v = (process.env.FORCE_QUEUE || '').toLowerCase();
  if (v === '1' || v === 'true') return true;
  const event = (process.env.GITHUB_EVENT_NAME || '').toLowerCase();
  return event === 'workflow_dispatch'; // si el run es manual, forzar
})();

let queueLimit = parseInt(process.env.QUEUE_LIMIT || '10', 10);
if (!Number.isFinite(queueLimit) || queueLimit < 1 || queueLimit > 100) queueLimit = 10;

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

function apiUrl(endpoint, params = null) {
  let url = `${API_BASE_URL}/api/uscis/${endpoint}`;
  if (params && Object.keys(params).length) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        qs.append(k, String(v));
      }
    }
    const q = qs.toString();
    if (q) url += `?${q}`;
  }
  return url;
}

// Soft-fail para queue: si 500, devolvemos vacío para no romper el job
const getQueueFromApi = async (url) => {
  try {
    return await getJson(url);
  } catch (err) {
    log('Queue API error (soft-fail):', err.message);
    return { tramites: [] };
  }
};

const reportSuccessToApi = (items) => postJson(apiUrl('report'), { items });          // { items: [{ tramite_id, html }] }
const reportFailedToApi  = (items) => postJson(apiUrl('report-failed'), { items });   // { items: [{ receipt_number, error }] }

// --- PARSE HELPERS ---
async function extractStatusFromPage(page) {
  const titleSelCandidates = [
    '.current-status-sec h1',
    'div.current-status-sec h1',
    'div.rows.text-center h1',
    'h1'
  ];
  const bodySelCandidates = [
    '.current-status-sec p',
    'div.current-status-sec p',
    'div.rows.text-center p',
    '#formErrors',
    '.appointment-sec p'
  ];

  let title = null;
  for (const sel of titleSelCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const txt = (await el.textContent())?.trim();
        if (txt) { title = txt; break; }
      }
    } catch (_) {}
  }

  let body = null;
  for (const sel of bodySelCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const txt = (await el.textContent())?.replace(/\s+/g, ' ').trim();
        if (txt) { body = txt; break; }
      }
    } catch (_) {}
  }

  return { title, body };
}

// --- SCRAPER CORE ---
async function tryDirectResults(page, receipt) {
  const url = `${USCIS_RESULTS_URL}?appReceiptNum=${encodeURIComponent(receipt)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const inResults = page.url().includes('mycasestatus.do');
  if (!inResults) return null;

  try {
    await page.waitForTimeout(800);
    const html = await page.content();
    const { title, body } = await extractStatusFromPage(page);
    if (title || body) {
      return { ok: true, status: title || null, details: body || null, html };
    }
  } catch (_) {}
  return null;
}

async function tryFormFlow(page, receipt) {
  await page.goto(USCIS_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const inputCandidates = ['#receipt_number', 'input[name="appReceiptNum"]'];
  let inputFound = false;
  for (const sel of inputCandidates) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count) {
      await page.fill(sel, receipt, { timeout: 15000 }).catch(() => {});
      inputFound = true;
      break;
    }
  }
  if (!inputFound) throw new Error('Receipt input not found');

  const submitCandidates = ['input[name="initCaseSearch"]', 'button[type="submit"]', 'input[type="submit"]'];
  let clicked = false;
  for (const sel of submitCandidates) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count) {
      await page.click(sel).catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) await page.keyboard.press('Enter').catch(() => {});

  try {
    await Promise.race([
      page.waitForURL(/mycasestatus\.do/i, { timeout: 20000 }),
      page.waitForSelector('.current-status-sec, #formErrors, .rows.text-center', { timeout: 20000 })
    ]);
  } catch (_) {}

  const html = await page.content().catch(() => null);
  const { title, body } = await extractStatusFromPage(page);

  if (title || body) {
    return { ok: true, status: title || null, details: body || null, html };
  }

  const errText = await page.locator('#formErrors').first().textContent().catch(() => null);
  if (errText && errText.trim()) {
    return { ok: false, error: errText.trim(), html };
  }

  return { ok: false, error: 'Unable to extract status text', html };
}

async function scrapeCase(page, receiptNumberRaw) {
  const receiptNumber = String(receiptNumberRaw || '').replace(/\s+/g, '').toUpperCase();
  const result = { receipt_number: receiptNumber, ok: false, status: null, details: null, error: null, fullPageHtml: null };

  try {
    const direct = await tryDirectResults(page, receiptNumber);
    if (direct && direct.ok) {
      result.ok = true;
      result.status = direct.status;
      result.details = direct.details;
      result.fullPageHtml = direct.html;
      return result;
    }

    const viaForm = await tryFormFlow(page, receiptNumber);
    if (viaForm.ok) {
      result.ok = true;
      result.status = viaForm.status;
      result.details = viaForm.details;
      result.fullPageHtml = viaForm.html;
    } else {
      result.error = viaForm.error || 'Unknown error';
      result.fullPageHtml = viaForm.html || null;
    }
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
    try { result.fullPageHtml = await page.content(); } catch (_) {}
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

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36'
  });
  const page = await ctx.newPage();

  // 1) Pedir cola (con o sin force, según contexto)
  const queueUrl = apiUrl('queue', {
    force: shouldForceQueue ? '1' : undefined,
    limit: queueLimit
  });
  log('Fetching queue from API (GET):', queueUrl);
  const queuePayload = await getQueueFromApi(queueUrl);

  // Normalizar a objetos { tramite_id, receipt_number }
  const queue = (() => {
    if (Array.isArray(queuePayload?.tramites)) {
      return queuePayload.tramites
        .map(t => ({
          tramite_id: t?.tramite_id ?? t?.id ?? null,
          receipt_number: String(t?.receipt_number ?? '').trim()
        }))
        .filter(it => !!it.receipt_number);
    }
    if (Array.isArray(queuePayload?.receipts)) {
      return queuePayload.receipts
        .map(r => ({ tramite_id: null, receipt_number: String(r ?? '').trim() }))
        .filter(it => !!it.receipt_number);
    }
    return [];
  })();

  log(`Queue size: ${queue.length}`);
  if (!queue.length) {
    await browser.close();
    log('No receipts to process (or API unavailable). Exiting gracefully.');
    process.exit(0);
  }

  const successItems = []; // -> { tramite_id, html }
  const failedItems  = []; // -> { receipt_number, error }

  for (const item of queue) {
    const { receipt_number, tramite_id } = item;
    log(`Processing: ${receipt_number}`);
    const result = await scrapeCase(page, receipt_number);

    if (result.ok && tramite_id) {
      successItems.push({
        tramite_id,
        html: result.fullPageHtml || ''
      });
    } else if (!result.ok) {
      failedItems.push({
        receipt_number,
        error: result.error || 'Unknown error'
      });
    }
    await sleep(1200 + Math.random() * 1200);
  }

  // 2) Reportes (POST) — solo si hay algo que enviar
  if (successItems.length) {
    log(`Reporting success items: ${successItems.length}`);
    await reportSuccessToApi(successItems);
  } else {
    log('No successful scrapes to report.');
  }

  if (failedItems.length) {
    log(`Reporting failed items: ${failedItems.length}`);
    await reportFailedToApi(failedItems);
  } else {
    log('No failed scrapes to report.');
  }

  await browser.close();
  log('--- Scraping Cycle Finished ---');
})();
