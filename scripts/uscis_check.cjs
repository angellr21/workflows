#!/usr/bin/env node
/* eslint-disable no-console */
//
// USCIS checker (self-hosted friendly)
// - Usa Google Chrome del sistema (sin descargar navegadores de Playwright)
// - Respeta HEADFUL=1 para modo visible (con xvfb en Actions)
// - Proxy opcional via PROXY_*
//
// Env esperadas (ejemplos):
//   API_BASE="https://tu.api"          (obligatorio)
//   API_TOKEN="xxxxx"                  (opcional, Bearer)
//   HEADFUL="1"                        (opcional; 1 = con UI; por defecto headless)
//   BROWSER="chrome-channel"           (opcional; se ignora si CHROME_PATH está presente)
//   CHROME_PATH="/usr/bin/google-chrome" (se exporta en el workflow)
//   PROXY_ENABLED="1" PROXY_HOST="host" PROXY_PORT="8080" PROXY_USERNAME="u" PROXY_PASSWORD="p" (opcionales)
//
// Notas:
// - Si quieres seguir usando exactamente tu scraping anterior, reemplaza el cuerpo de
//   `runCheckForReceipt()` por tu lógica original. El resto ya gestiona Chrome del sistema.
//

const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------- Utils de logging ----------
function ts() {
  return new Date().toISOString();
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ---------- ENV ----------
const API_BASE = process.env.API_BASE || process.env.API_BASE_URL || '';
const API_TOKEN = process.env.API_TOKEN || '';
const HEADFUL = process.env.HEADFUL === '1';
const BROWSER_ENV = process.env.BROWSER || ''; // p.ej. "chrome-channel"
const PROXY_ENABLED = !!process.env.PROXY_ENABLED;

// ---------- Helpers ----------
function findChromeSync() {
  const explicit = process.env.CHROME_PATH && process.env.CHROME_PATH.trim();
  const candidates = [
    explicit,
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium'
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const p = execFileSync('which', [c], { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

async function createBrowserContext() {
  const userDataDir = path.join(os.homedir(), '.uscis-chrome-profile');

  /** @type {import('playwright').LaunchPersistentContextOptions} */
  const common = {
    headless: !HEADFUL,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--mute-audio'
    ],
    timeout: 90_000
  };

  if (PROXY_ENABLED && process.env.PROXY_HOST && process.env.PROXY_PORT) {
    const proto = (process.env.PROXY_HOST || '').startsWith('http') ? '' : 'http://';
    common.proxy = {
      server: `${proto}${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`,
      username: process.env.PROXY_USERNAME || undefined,
      password: process.env.PROXY_PASSWORD || undefined
    };
  }

  const chromePath = findChromeSync();
  let browserLabel = 'chromium';
  let context;

  if (chromePath) {
    browserLabel = 'chrome (system)';
    context = await chromium.launchPersistentContext(userDataDir, {
      ...common,
      executablePath: chromePath
    });
  } else if (BROWSER_ENV && BROWSER_ENV.toLowerCase().includes('chrome')) {
    browserLabel = 'chrome-channel';
    context = await chromium.launchPersistentContext(userDataDir, {
      ...common,
      channel: 'chrome'
    });
  } else {
    // Fallback absoluto: chromium de Playwright (requiere npx playwright install)
    context = await chromium.launchPersistentContext(userDataDir, { ...common });
  }

  const proxyLabel = PROXY_ENABLED ? 'on' : 'off';
  log(`Browser in use: ${browserLabel} | headful: ${HEADFUL ? 'yes' : 'no'} | proxy:${proxyLabel}`);

  return context;
}

async function passCloudflare(page, { timeoutMs = 120_000 } = {}) {
  // Estrategia simple/robusta: esperar a "networkidle" y un pequeño colchón.
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(30_000, timeoutMs) });
    await page.waitForLoadState('networkidle', { timeout: Math.min(60_000, timeoutMs) });
    await page.waitForTimeout(2_000);
  } catch {
    throw new Error('Cloudflare guard did not finish in time');
  }
}

function maskUrl(url) {
  if (!url) return '***';
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '***';
  }
}

// ---------- API ----------
async function fetchJSON(url, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${maskUrl(url)}: ${text}`);
  }
}

async function getQueue() {
  const url = new URL('/queue', API_BASE);
  url.searchParams.set('force', '1');
  if (process.env.QUEUE_LIMIT) url.searchParams.set('limit', String(process.env.QUEUE_LIMIT));

  log('API_BASE_URL: ***');
  log(`Fetching queue from API (GET): ${maskUrl(url.toString())}`);

  const data = await fetchJSON(url.toString());
  if (!data || !Array.isArray(data.tramites)) {
    throw new Error('Queue payload missing "tramites" array');
  }
  log(`Queue raw payload: ${JSON.stringify(data)}`);
  log(`Queue size: ${data.tramites.length}`);
  return data.tramites;
}

// Stubs para reportes; si ya tenías endpoints, reemplaza aquí:
async function reportResult(tramiteId, payload) {
  if (!API_BASE) return;
  try {
    const url = new URL(`/results/${tramiteId}`, API_BASE).toString();
    await fetchJSON(url, { method: 'POST', body: JSON.stringify(payload) });
  } catch (e) {
    log(`WARN reportResult failed: ${e.message}`);
  }
}

// ---------- Lógica de scraping por recibo ----------
// Reemplaza el contenido de esta función por tu scraping real si lo necesitas.
// Aquí solo dejamos una navegación de ejemplo + Cloudflare guard.
async function runCheckForReceipt(page, receipt) {
  // TODO: cambia a tu URL real:
  const target = process.env.TARGET_URL || 'https://example.com/';
  await page.goto(target, { waitUntil: 'load', timeout: 90_000 });

  // Si hay Cloudflare, esperar a que termine:
  await passCloudflare(page, { timeoutMs: 120_000 });

  // TODO: aquí tu scraping real...
  await page.waitForTimeout(1_000);

  // Devuelve un objeto de ejemplo:
  return {
    receipt,
    status: 'ok',
    fetchedAt: new Date().toISOString()
  };
}

// ---------- Main ----------
async function main() {
  log('--- Scraping Cycle Started ---');

  if (!API_BASE) {
    throw new Error('API_BASE (o API_BASE_URL) no está definido en el entorno.');
  }

  let context;
  const successes = [];
  const failures = [];

  try {
    const queue = await getQueue();

    context = await createBrowserContext();

    // Para ver consola del sitio en logs:
    context.on('page', (p) => {
      p.on('console', (msg) => {
        // Imita el formato de tus logs: [page.console] <type> <text>
        console.log(`[${ts()}] [page.console] ${msg.type()} ${msg.text()}`);
      });
    });

    for (const item of queue) {
      const receipt = item.receipt_number || item.receipt || '';
      const id = item.tramite_id ?? item.id ?? null;
      if (!receipt) continue;

      log(`Processing: ${receipt}`);
      const page = await context.newPage();

      try {
        const result = await runCheckForReceipt(page, receipt);
        successes.push({ id, receipt, result });
      } catch (err) {
        log(`FAIL ${receipt}: ${err.message} — ${err.message}`);
        failures.push({ id, receipt, error: err.message });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  if (successes.length === 0) {
    log('No successful scrapes to report.');
  } else {
    log(`Reporting successful items: ${successes.length}`);
  }
  if (failures.length > 0) {
    log(`Reporting failed items: ${failures.length}`);
  }

  // Envía resultados (si tienes endpoints definidos, ajusta aquí)
  for (const s of successes) {
    if (s.id != null) await reportResult(s.id, { ok: true, data: s.result });
  }
  for (const f of failures) {
    if (f.id != null) await reportResult(f.id, { ok: false, error: f.error });
  }

  log('--- Scraping Cycle Finished ---');
}

// Manejo de errores global
process.on('unhandledRejection', (err) => {
  const message = err && err.message ? err.message : String(err);
  log(`UNHANDLED REJECTION: ${message}`);
  process.exitCode = 1;
});
process.on('uncaughtException', (err) => {
  const message = err && err.message ? err.message : String(err);
  log(`UNCAUGHT EXCEPTION: ${message}`);
  process.exitCode = 1;
});

main().catch((err) => {
  log(err.stack || err.message || String(err));
  process.exit(1);
});
