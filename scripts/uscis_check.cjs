#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function ts() { return new Date().toISOString(); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function warn(...a) { console.warn(`[${ts()}] [warn]`, ...a); }
function err(...a) { console.error(`[${ts()}] [error]`, ...a); }

const CFG = {
  API_BASE: (process.env.API_BASE || '').replace(/\/+$/, ''),
  API_TOKEN: process.env.API_TOKEN || '',
  QUEUE_PATH: (process.env.API_QUEUE_PATH || '/queue').replace(/^\/?/, '/'),
  RESULT_PATH: (process.env.API_RESULT_PATH || '/result').replace(/^\/?/, '/'),

  BROWSER: process.env.BROWSER || 'chrome-channel',
  HEADFUL: process.env.HEADFUL === '1',
  MAX_ATTEMPTS_CASE: 3,
  NAV_TIMEOUT_MS: 120_000,
  SELECTOR_TIMEOUT_MS: 90_000,

  PROXY: (process.env.PROXY_ENABLED && process.env.PROXY_ENABLED !== '0') ? {
    server: process.env.PROXY_HOST && process.env.PROXY_PORT
      ? `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}` : undefined,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined
  } : null
};

if (!CFG.API_BASE) {
  err('API_BASE no definido. Configura el secreto API_BASE.');
  process.exit(1);
}

for (const d of ['logs', 'screenshots', 'pages', 'playwright-report']) {
  fs.mkdirSync(d, { recursive: true });
}

async function fetchJSON(url, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {})
  };
  if (CFG.API_TOKEN) {
    headers['Authorization'] = `Bearer ${CFG.API_TOKEN}`;
    headers['X-API-TOKEN'] = CFG.API_TOKEN;
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 1500)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function qURL(p) { return `${CFG.API_BASE}${p}`; }

async function postResultWithFallback(payload) {
  const candidates = [
    CFG.RESULT_PATH,
    '/uscis/result',
    '/api/uscis/result'
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      const url = qURL(p);
      log(`POST -> ${url}`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(CFG.API_TOKEN ? { 'Authorization': `Bearer ${CFG.API_TOKEN}`, 'X-API-TOKEN': CFG.API_TOKEN } : {})
        },
        body: JSON.stringify(payload)
      });
      if (res.ok || res.status === 204) return true;
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 1500)}`);
    } catch (e) {
      lastErr = e;
      warn(`POST ${p} falló: ${e.message}`);
    }
  }
  throw lastErr;
}

async function locateChrome() {
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function randomUA() {
  const ver =  119 + Math.floor(Math.random() * 20);
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
}

const USCIS_LANDING = 'https://egov.uscis.gov/casestatus/landing.do';
const USCIS_MYCASE  = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

const RECEIPT_INPUTS = [
  'input[name="appReceiptNum"]',
  'input[name="receiptNumber"]',
  'input#receipt_number',
  'input#receiptNumber',
  'input[name="caseStatusSearchInput"]'
].join(', ');

const SUBMIT_BUTTONS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("CHECK STATUS")',
  'button:has-text("Check Status")'
].join(', ');

const RESULT_SELECTORS = [
  'h1:has-text("Case ")',
  '.current-status-sec',
  '.rows .text-center h1',
  'div:has-text("Your Current Case Status")'
];

const BLOCK_MARKERS = [
  'text=Access denied',
  'text=Attention Required! | Cloudflare',
  'text=Please verify you are a human',
  '#cf-chl-widget',
  'iframe[title*="challenge"]'
];

async function saveArtifacts(prefix, page) {
  try { fs.writeFileSync(path.join('pages', `${prefix}.html`), await page.content(), 'utf8'); } catch {}
  try { await page.screenshot({ path: path.join('screenshots', `${prefix}.png`), fullPage: true }); } catch {}
}

async function openContext() {
  const executablePath = await locateChrome();
  const ctx = await chromium.launchPersistentContext(
    path.join('.pw-profile'),
    {
      headless: !CFG.HEADFUL ? true : false,
      channel: executablePath ? undefined : 'chrome',
      executablePath: executablePath || undefined,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--force-color-profile=srgb'
      ],
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
      userAgent: randomUA(),
      proxy: CFG.PROXY?.server ? {
        server: CFG.PROXY.server, username: CFG.PROXY.username, password: CFG.PROXY.password
      } : undefined
    }
  );

  await ctx.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1'
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(p){ if (p===37445) return 'NVIDIA'; return getParameter.apply(this,[p]); };
    } catch {}
  });

  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(CFG.NAV_TIMEOUT_MS);
  page.setDefaultTimeout(CFG.SELECTOR_TIMEOUT_MS);
  return { context: ctx, page };
}

// ---- FAST PATH: ir directo al resultado con querystring ----
async function tryDirectResult(page, receipt, attempt) {
  const url = `${USCIS_MYCASE}?appReceiptNum=${encodeURIComponent(receipt)}`;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const status = resp ? resp.status() : 0;

  // ¿bloqueado?
  const blocked = await Promise.any(BLOCK_MARKERS.map(sel => page.waitForSelector(sel, { timeout: 4000 })))
    .then(() => true).catch(() => false);

  if (blocked || status >= 400) {
    await saveArtifacts(`blocked_direct_${receipt}_attempt${attempt}`, page);
    throw new Error(`Bloqueo/HTTP ${status} en acceso directo`);
  }

  const found = await Promise.any(RESULT_SELECTORS.map(sel => page.waitForSelector(sel, { timeout: 8000 })))
    .catch(() => null);

  if (found) {
    return true;
  } else {
    // No encontró el bloque, no necesariamente bloqueo. Devuelve false para intentar el flujo de formulario.
    return false;
  }
}

async function ensureReady(page, attempt) {
  await page.goto(USCIS_LANDING, { waitUntil: 'domcontentloaded' });

  const blocker = Promise.any(BLOCK_MARKERS.map(sel => page.waitForSelector(sel, { timeout: 8000 })))
    .then(() => 'blocked').catch(() => null);

  const receipt = page.waitForSelector(RECEIPT_INPUTS, { state: 'visible', timeout: 12000 })
    .then(() => 'ok').catch(() => null);

  let outcome = await Promise.race([blocker, receipt, new Promise(r => setTimeout(() => r('timeout'), 10000))]);

  if (outcome === 'blocked' || outcome === 'timeout') {
    await page.goto(USCIS_MYCASE, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(RECEIPT_INPUTS, { state: 'visible', timeout: 15000 });
      outcome = 'ok';
    } catch { outcome = outcome || 'blocked'; }
  }

  if (outcome !== 'ok') {
    await saveArtifacts(`blocked_attempt${attempt}`, page);
    throw new Error('Bloqueo/desafío o input no disponible');
  }
}

async function checkCase(page, receipt, attempt) {
  // 1) Intento directo con querystring
  try {
    const ok = await tryDirectResult(page, receipt, attempt);
    if (ok) {
      const title = (await page.locator('h1').first().textContent().catch(()=>'')||'').trim();
      const body = (await page.locator('div, p').allTextContents().catch(()=>[])).join('\n').slice(0,5000);
      return { receipt_number: receipt, status_title: title, status_excerpt: body };
    }
  } catch (e) {
    warn(`Directo falló (${receipt}): ${e.message}`);
  }

  // 2) Flujo por formulario
  await ensureReady(page, attempt);

  const input = page.locator(RECEIPT_INPUTS).first();
  await input.fill('');
  await input.type(receipt, { delay: 30 });

  const btn = page.locator(SUBMIT_BUTTONS).first();
  if (await btn.isVisible().catch(()=>false)) {
    await Promise.all([page.waitForLoadState('domcontentloaded'), btn.click()]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded');
  }

  const found = await Promise.any(
    RESULT_SELECTORS.map(sel => page.waitForSelector(sel, { timeout: CFG.SELECTOR_TIMEOUT_MS }))
  ).catch(() => null);

  if (!found) {
    await saveArtifacts(`noresult_${receipt}_attempt${attempt}`, page);
    throw new Error('No se detectó el bloque de resultado');
  }

  const title = (await page.locator('h1').first().textContent().catch(()=>'')||'').trim();
  const body  = (await page.locator('div, p').allTextContents().catch(()=>[])).join('\n').slice(0,5000);

  return { receipt_number: receipt, status_title: title, status_excerpt: body };
}

async function getQueue() {
  const url = qURL(CFG.QUEUE_PATH);
  log(`Fetching queue from API (GET): ${url}`);
  const data = await fetchJSON(url);
  try { log('Queue raw payload:', JSON.stringify(data)); } catch {}
  const list = (data?.tramites || []).map(x => ({
    tramite_id: x.tramite_id ?? x.id ?? null,
    receipt_number: String(x.receipt_number || x.case || '').trim(),
    fail_count: x.fail_count ?? 0
  })).filter(x => x.receipt_number);
  log(`Queue size: ${list.length}`);
  return list;
}

async function main() {
  console.log('>>> Intento 1');
  log('--- Scraping Cycle Started ---');
  log(`API_BASE_URL: ${CFG.API_BASE}`);

  const queue = await getQueue();
  if (!queue.length) { log('Cola vacía.'); return; }

  const { context, page } = await openContext();
  log(`Browser in use: ${CFG.BROWSER} | headful: ${CFG.HEADFUL ? 'yes' : 'no'} | proxy:${CFG.PROXY ? 'on' : 'off'}`);

  for (const item of queue) {
    const { receipt_number, tramite_id } = item;
    log(`Processing: ${receipt_number}`);

    let result = null;
    let ok = false;

    for (let attempt = 1; attempt <= CFG.MAX_ATTEMPTS_CASE; attempt++) {
      try {
        result = await checkCase(page, receipt_number, attempt);
        ok = true;
        break;
      } catch (e) {
        err(`${receipt_number} failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 2500 * attempt));
        try { await page.goto(USCIS_LANDING, { waitUntil: 'domcontentloaded' }); } catch {}
      }
    }

    const payload = { tramite_id, receipt_number, ok, ...(result || {}), ts: new Date().toISOString() };
    try { await postResultWithFallback(payload); }
    catch (e) { warn(`POST ${qURL(CFG.RESULT_PATH)} falló: ${e.message}`); }
  }

  await page.close().catch(()=>{});
  await context.close().catch(()=>{});
}

main().catch(async (e) => {
  err(e.stack || e.message || String(e));
  try { fs.writeFileSync(`run-${Date.now()}.log`, `${e.stack || e}`); } catch {}
  process.exit(1);
});
