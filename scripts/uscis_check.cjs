#!/usr/bin/env node
'use strict';

/**
 * USCIS checker – autómata Playwright para leer cola desde API y reportar resultados.
 * Node 20+, Playwright 1.44+ (funciona con Chrome del sistema).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

// =======================
// Config / Entorno
// =======================
const API_BASE = process.env.API_BASE || process.env.API_BASE_URL || '';
const API_TOKEN = process.env.API_TOKEN || '';
const PROXY_ENABLED = String(process.env.PROXY_ENABLED || '').trim();
const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = process.env.PROXY_PORT || '';
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';
const QUEUE_LIMIT = process.env.QUEUE_LIMIT ? Number(process.env.QUEUE_LIMIT) : null;
const HEADFUL = String(process.env.HEADFUL || '') === '1';
const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase(); // ej: "chrome-channel" | "chromium"
const NODE_ENV = process.env.NODE_ENV || 'production';

// carpetas de salida (logs, screenshots, report)
const OUT_BASE = path.resolve(process.cwd());
const LOG_DIR = path.join(OUT_BASE, 'logs');
const SHOT_DIR = path.join(LOG_DIR, 'screens');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

// =======================
// Utilidades
// =======================
const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] [warn]`, ...a);
const terr = (...a) => console.error(`[${ts()}] [error]`, ...a);

// Oculta query params y tokens en logs
function maskUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch {
    return u;
  }
}

// Une base + partes sin perder subrutas del API (evita usar '/recurso' absoluto)
function joinUrl(base, ...parts) {
  const b = base.endsWith('/') ? base : base + '/';
  const p = parts.map(s => String(s).replace(/^\/+|\/+$/g, '')).join('/');
  return new URL(b + p).toString();
}

async function fetchJSON(url, opts = {}) {
  const headers = Object.assign(
    {
      'Accept': 'application/json',
    },
    opts.headers || {}
  );

  if (opts.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (API_TOKEN) {
    // Si tu API usa "X-API-KEY" en lugar de Bearer, cambia esta línea:
    headers['Authorization'] = `Bearer ${API_TOKEN}`;
  }

  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 1200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  // Si no es JSON, devolvemos texto (por si el endpoint devuelve string plano)
  return res.text();
}

// =======================
// API: cola y reporte
// =======================
async function getQueue() {
  const urlStr = joinUrl(API_BASE, 'queue');
  const url = new URL(urlStr);
  url.searchParams.set('force', '1');
  if (QUEUE_LIMIT) url.searchParams.set('limit', String(QUEUE_LIMIT));

  log('API_BASE_URL: ***');
  log(`Fetching queue from API (GET): ${maskUrl(url.toString())}`);

  const data = await fetchJSON(url.toString());
  // Acepta dos formatos: { tramites: [...] } o directamente [...]
  const tramites = Array.isArray(data?.tramites) ? data.tramites :
                   Array.isArray(data) ? data : [];
  if (!Array.isArray(tramites)) {
    throw new Error('Queue payload missing "tramites" array');
  }
  log(`Queue raw payload: ${JSON.stringify({ tramites: tramites.map(t => ({ tramite_id: t.tramite_id, receipt_number: t.receipt_number, fail_count: t.fail_count })) })}`);
  log(`Queue size: ${tramites.length}`);
  return tramites;
}

async function reportResult(tramiteId, payload) {
  const url = joinUrl(API_BASE, 'results', String(tramiteId));
  try {
    await fetchJSON(url, { method: 'POST', body: JSON.stringify(payload) });
  } catch (e) {
    terr(`Report failed for tramite_id=${tramiteId}: ${e.message}`);
  }
}

// =======================
// Navegación / Playwright
// =======================
function buildProxyOption() {
  if (!PROXY_ENABLED || PROXY_ENABLED === '0' || PROXY_ENABLED.toLowerCase() === 'false') return undefined;
  if (!PROXY_HOST || !PROXY_PORT) return undefined;
  const server = `http://${PROXY_HOST}:${PROXY_PORT}`;
  const proxy = { server };
  if (PROXY_USERNAME || PROXY_PASSWORD) {
    proxy.username = PROXY_USERNAME || '';
    proxy.password = PROXY_PASSWORD || '';
  }
  return proxy;
}

async function launchPersistent() {
  const userDataDir = path.join(os.tmpdir(), 'pw-user-data');
  const proxy = buildProxyOption();

  const contextOptions = {
    headless: !HEADFUL,
    viewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-webgl',
      '--autoplay-policy=user-gesture-required',
    ],
    proxy,
  };

  // Preferimos Chrome del sistema
  if (BROWSER.includes('chrome')) {
    contextOptions.channel = 'chrome';
    // Fallback por si el canal no está disponible
    if (!fs.existsSync('/usr/bin/google-chrome') && fs.existsSync('/usr/bin/google-chrome-stable')) {
      contextOptions.executablePath = '/usr/bin/google-chrome-stable';
    } else if (fs.existsSync('/usr/bin/google-chrome')) {
      contextOptions.executablePath = '/usr/bin/google-chrome';
    }
  }

  log(`Browser in use: ${BROWSER} | headful: ${HEADFUL ? 'yes' : 'no'} | proxy:${proxy ? 'on' : 'off'}`);
  const ctx = await chromium.launchPersistentContext(userDataDir, contextOptions);
  const page = await ctx.newPage();
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'warning') warn('[page.console]', msg.text());
    else if (type === 'error') terr('[page.console]', msg.text());
    else log('[page.console]', msg.text());
  });
  return { ctx, page };
}

// Intento simple de esperar un posible reto de Cloudflare
async function waitCloudflare(page, timeoutMs = 120000) {
  const start = Date.now();
  const cfHints = [
    'challenge-platform',
    'cf-chl-widget',
    'cf-browser-verification',
    'Checking your browser',
    'Verifying you are human',
  ];
  try {
    // Si se ve alguno de los hints, esperamos navegación o desaparición
    while (Date.now() - start < timeoutMs) {
      const content = (await page.content().catch(() => '')) || '';
      const seen = cfHints.some(h => content.includes(h));
      if (!seen) return; // no hay reto visible
      await page.waitForTimeout(1000);
      // si en el proceso cambia la URL o carga nueva página
      if (page.url().includes('error')) break;
    }
  } catch {
    /* ignore */
  }
  if (Date.now() - start >= timeoutMs) {
    throw new Error('Cloudflare guard did not finish in time');
  }
}

// =======================
// Scrape (simplificado, robusto ante cambios)
// =======================
async function checkCase(page, receiptNumber) {
  // Página de estado de caso USCIS (puede variar, mantenemos robusto)
  const landing = 'https://egov.uscis.gov/casestatus/landing.do';
  await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Espera reto si aparece
  await waitCloudflare(page, 120000).catch(err => { throw err; });

  // Intenta localizar el input del receipt (varía de vez en cuando)
  const selectors = [
    'input#receipt_number',
    'input[name="appReceiptNum"]',
    'input[name="receipt_number"]',
    'input[aria-label*="Receipt"]',
    'input[type="text"]',
  ];

  let filled = false;
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(receiptNumber, { timeout: 15000 });
      filled = true;
      break;
    }
  }
  if (!filled) throw new Error('No se encontró el campo del Receipt Number');

  // Click en botón de consulta
  const buttonSelectors = [
    'button:has-text("Check Status")',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Check")',
  ];

  let clicked = false;
  for (const sel of buttonSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ timeout: 15000 });
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // Si no hay botón, intenta Enter
    await page.keyboard.press('Enter');
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  await waitCloudflare(page, 120000).catch(err => { throw err; });

  // Extraer resultado (selector defensivo)
  const resultSelectors = [
    '.rows.text-center .current-status-sec h1',
    '.text-center h1',
    'h1.current-status-title',
    'h1',
    '[data-testid="case-status"]',
  ];

  for (const sel of resultSelectors) {
    const el = await page.$(sel);
    if (el) {
      const title = (await el.textContent())?.trim() || '';
      if (title) {
        // También intenta obtener el párrafo de detalle
        const detailSel = [
          '.rows.text-center .rows.text-center',
          '.text-center p',
          'p',
          '[data-testid="case-status-body"]',
        ];
        let body = '';
        for (const ds of detailSel) {
          const d = await page.$(ds);
          if (d) {
            body = (await d.textContent())?.trim() || '';
            if (body) break;
          }
        }
        return { title, body };
      }
    }
  }

  throw new Error('No se pudo extraer el estado del caso');
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
}

// =======================
// Main
// =======================
async function main() {
  log('--- Scraping Cycle Started ---');
  if (!API_BASE) {
    throw new Error('Falta API_BASE; configúralo como secret/API_BASE en el workflow.');
  }

  const tramites = await getQueue();

  if (!tramites.length) {
    log('No items in queue. Finishing.');
    return;
  }

  const { ctx, page } = await launchPersistent();
  let okCount = 0;
  const failures = [];

  try {
    for (const item of tramites) {
      const { tramite_id, receipt_number } = item;
      if (!tramite_id || !receipt_number) {
        warn('Elemento inválido en cola:', item);
        continue;
      }

      log(`Processing: ${receipt_number}`);
      try {
        const result = await checkCase(page, receipt_number);

        // screenshot
        const shotPath = path.join(SHOT_DIR, `${safeName(receipt_number)}_${Date.now()}.png`);
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

        await reportResult(tramite_id, {
          ok: true,
          receipt_number,
          title: result.title,
          body: result.body,
          screenshot: path.basename(shotPath),
          meta: { node: process.version, headful: HEADFUL, browser: BROWSER, env: NODE_ENV },
        });

        okCount += 1;
      } catch (e) {
        terr(`${receipt_number} failed: ${e.message}`);

        // screenshot on failure
        const shotPath = path.join(SHOT_DIR, `${safeName(receipt_number)}_${Date.now()}_ERR.png`);
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

        await reportResult(tramite_id, {
          ok: false,
          receipt_number,
          error: e.message,
          screenshot: path.basename(shotPath),
          meta: { node: process.version, headful: HEADFUL, browser: BROWSER, env: NODE_ENV },
        });

        failures.push({ receipt_number, error: e.message });
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  if (!okCount) {
    log('No successful scrapes to report.');
  }
  if (failures.length) {
    log(`Reporting failed items: ${failures.length}`);
  }
  log('--- Scraping Cycle Finished ---');
}

// Run
main().catch(err => {
  terr(err.stack || err.message || String(err));
  process.exitCode = 1;
});
