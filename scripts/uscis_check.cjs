#!/usr/bin/env node
'use strict';

/**
 * USCIS checker con Playwright (Chrome del sistema).
 * - Usa API_BASE/ API_TOKEN (Bearer) para leer cola y reportar resultados.
 * - Soporta proxy vía PROXY_*.
 * - Reintenta navegaciones y maneja microcortes de red.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium, devices } = require('playwright');

// ======== ENV ========
const ENV = (k, d='') => (process.env[k] ?? d);
const API_BASE   = ENV('API_BASE').replace(/\/+$/,''); // sin slash final
const API_TOKEN  = ENV('API_TOKEN');
const PROXY_ON   = /^(1|true|yes)$/i.test(ENV('PROXY_ENABLED'));
const PROXY_HOST = ENV('PROXY_HOST');
const PROXY_PORT = ENV('PROXY_PORT');
const PROXY_USER = ENV('PROXY_USERNAME');
const PROXY_PASS = ENV('PROXY_PASSWORD');
const HEADFUL    = /^(1|true|yes)$/i.test(ENV('HEADFUL', '0'));
const BROWSER    = ENV('BROWSER', 'chrome-channel'); // 'chrome-channel' | 'chromium'
const NAV_TIMEOUT_MS = parseInt(ENV('NAV_TIMEOUT_MS', '90000'), 10); // 90s

if (!API_BASE || !API_TOKEN) {
  console.error('[fatal] Falta API_BASE o API_TOKEN en variables de entorno.');
  process.exit(2);
}

// ======== LOGS ========
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runTag = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(logsDir, `run-${runTag}.log`);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

// ======== Helpers HTTP ========
async function fetchJSON(url, { method='GET', headers={}, body, timeout=20000 } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  const res = await fetch(url, {
    method,
    headers: {
      'accept': 'application/json',
      ...(body ? {'content-type': 'application/json'} : {}),
      authorization: `Bearer ${API_TOKEN}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctrl.signal,
  }).catch(err => {
    clearTimeout(id);
    throw new Error(`HTTP fetch error: ${err.message}`);
  });
  clearTimeout(id);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0,1000)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0,200)}`);
  }
}

async function postJSON(url, payload) {
  return fetchJSON(url, { method: 'POST', body: payload, timeout: 30000 });
}

// ======== Conectividad y reintentos ========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function probeInternet() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://www.google.com/generate_204', { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function gotoWithRetries(page, url, { attempts=3, timeout=NAV_TIMEOUT_MS } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (err) {
      log(`[warn] goto attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) throw err;

      const netOk = await probeInternet();
      if (!netOk) {
        log('[warn] Connectivity probe failed; waiting 10s before retry…');
        await sleep(10_000);
      }
      await sleep(5000 * i); // backoff
    }
  }
}

// ======== API ========
async function getQueue() {
  const url = `${API_BASE}/queue`;
  log(`Fetching queue from API (GET): ${url}`);
  const data = await fetchJSON(url, { timeout: 25000 });
  log(`Queue raw payload: ${JSON.stringify(data).slice(0,500)}`);
  const arr = Array.isArray(data) ? data
            : Array.isArray(data?.tramites) ? data.tramites
            : [];
  return arr.map(x => ({
    tramite_id: x.tramite_id ?? x.id ?? null,
    receipt_number: String(x.receipt_number ?? x.receipt ?? '').trim(),
    fail_count: x.fail_count ?? 0,
  })).filter(x => x.receipt_number);
}

async function sendResult(payload) {
  const url = `${API_BASE}/result`;
  try {
    await postJSON(url, payload);
  } catch (e) {
    log(`[warn] POST ${url} falló: ${e.message}`);
  }
}

// ======== Playwright (Chrome del sistema) ========
function buildProxy() {
  if (!PROXY_ON || !PROXY_HOST || !PROXY_PORT) return undefined;
  const server = `http://${PROXY_HOST}:${PROXY_PORT}`;
  return {
    server,
    username: PROXY_USER || undefined,
    password: PROXY_PASS || undefined,
  };
}

async function launchContext() {
  const userDataDir = path.join(os.homedir(), '.cache', 'playwright-chrome-profile');
  const proxy = buildProxy();
  const useChromeChannel = (BROWSER || '').toLowerCase().includes('chrome');

  const launchOptions = {
    headless: !HEADFUL,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
      '--enable-unsafe-swiftshader',
    ],
    proxy: proxy,
    channel: useChromeChannel ? 'chrome' : undefined,
  };

  log(`Browser in use: ${useChromeChannel ? 'chrome-channel' : 'chromium'} | headful: ${HEADFUL ? 'yes' : 'no'} | proxy:${proxy ? 'on' : 'off'}`);

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // Simular un viewport decente
  await page.setViewportSize({ width: 1366, height: 768 });

  return { context, page };
}

// ======== Scraping USCIS ========
const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing.do';

async function extractStatusText(page) {
  // Busca en varios selectores comunes de la página de resultado
  const selectors = [
    '#caseStatus h1',
    'div.current-status-sec h1',
    '.rows .current-status-title',
    'h1',
    'h2',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count()) {
      const txt = (await el.textContent() || '').trim();
      if (txt) return txt;
    }
  }
  // fallback: un fragmento de la página
  const html = await page.content();
  return (html || '').slice(0, 300);
}

async function checkReceipt(page, receipt) {
  await gotoWithRetries(page, USCIS_URL);

  // Encuentra input del número (varía de vez en cuando)
  const input = page.locator([
    'input[name="receiptNumber"]',
    'input#receipt_number',
    'input#receiptNumber',
    'input[name="caseStatusSearchInput"]',
    'input[name="appReceiptNum"]',
  ].join(', ')).first();

  await input.waitFor({ state: 'visible' });
  await input.fill(receipt);

  // Botón "Check Status"
  const btn = page.locator([
    'button:has-text("Check Status")',
    'button:has-text("CHECK STATUS")',
    'input[type="submit"]',
    '#caseStatusSearchBtn'
  ].join(', ')).first();

  // Espera navegación o cambio de contenido
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    btn.click()
  ]);

  // A veces el contenido se renderiza un pelín tarde:
  await page.waitForTimeout(1500);

  const status = await extractStatusText(page);
  return status;
}

// ======== MAIN ========
async function main() {
  log('--- Scraping Cycle Started ---');
  log(`API_BASE_URL: ${API_BASE}`);

  const queue = await getQueue();
  log(`Queue size: ${queue.length}`);

  const { context, page } = await launchContext();

  try {
    for (const item of queue) {
      const rn = item.receipt_number;
      log(`Processing: ${rn}`);
      try {
        const statusText = await checkReceipt(page, rn);
        log(`[ok] ${rn}: ${statusText}`);
        await sendResult({
          ok: true,
          tramite_id: item.tramite_id,
          receipt_number: rn,
          status_text: statusText,
          checked_at: new Date().toISOString()
        });
      } catch (err) {
        log(`[error] ${rn} failed: ${err.message}`);
        await sendResult({
          ok: false,
          tramite_id: item.tramite_id,
          receipt_number: rn,
          error: String(err.message || err),
          checked_at: new Date().toISOString()
        });
      }
    }
  } finally {
    await context.close();
  }
}

main().catch(err => {
  log(`[fatal] ${err.stack || err.message || String(err)}`);
  process.exit(1);
});
