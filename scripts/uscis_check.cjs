// scripts/uscis_check.cjs
'use strict';

/**
 * Worker: USCIS scraper
 *
 * Flujo:
 *  1) Lee la cola desde la API:   GET /queue?force=1&limit=N
 *  2) Abre https://egov.uscis.gov/casestatus/landing
 *  3) Ingresa receipt, envía, captura HTML de resultado
 *  4) Reporta: POST /report (éxitos) y POST /report-failed (errores)
 *
 * ENV:
 *  - API_BASE     (requerido)   e.g. https://mi-api.test/api/uscis
 *  - API_TOKEN    (opcional)    token Bearer
 *  - LIMIT        (opcional)    items por corrida (integer)
 *  - FORCE        (opcional)    fuerza uso de cola (?force=1 por defecto)
 *  - HEADFUL=1    (opcional)    Headful (UI) bajo Xvfb en GitHub Actions
 *  - DEBUG=1      (opcional)    logs adicionales
 *  - USE_CHROME=1 (opcional)    intenta usar canal 'chrome' (si está instalado)
 *  - PROXY_SERVER (opcional)    e.g. http://host:port o http://user:pass@host:port
 *  - PROXY_USERNAME / PROXY_PASSWORD (opcionales) credenciales si no van embebidas
 */

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

// ========= ENV & CONFIG =========
const RAW_BASE   = (process.env.API_BASE || '').trim();
const API_TOKEN  = process.env.API_TOKEN || '';
const HEADFUL    = process.env.HEADFUL === '1';
const DEBUG      = process.env.DEBUG === '1';
const USE_CHROME = process.env.USE_CHROME === '1';

const LIMIT      = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const FORCE      = (process.env.FORCE || '1').trim(); // por defecto ?force=1

const PROXY_SERVER   = (process.env.PROXY_SERVER || '').trim();
const PROXY_USERNAME = process.env.PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || '';

if (!RAW_BASE) {
  console.error('API_BASE is required.');
  process.exit(2);
}

const API_BASE_URL = RAW_BASE.replace(/\/+$/, '');
const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing';

// ========= LOG/UTILS =========
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}
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
  if (API_TOKEN) h['Authorization'] = `Bearer ${API_TOKEN}`;
  return h;
};

async function httpGetJson(pathname) {
  const url = `${API_BASE_URL}${pathname}`;
  const res = await fetch(url, { headers: defaultHeaders(), method: 'GET' });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.json();
}

async function httpPostJson(pathname, body) {
  const url = `${API_BASE_URL}${pathname}`;
  const res = await fetch(url, {
    headers: defaultHeaders(),
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status}`);
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

// ========= PLAYWRIGHT SETUP =========
function buildLaunchArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
}

function buildContextOptions() {
  return {
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Importante: NO fijar userAgent -> Playwright usará el UA real de la build instalada
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };
}

async function applyStealth(context) {
  await context.addInitScript(() => {
    // navigator.*
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins',  { get: () => [1,2,3,4] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

    // window.chrome
    window.chrome = { runtime: {} };

    // Permissions API
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (params) => {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: 'denied' });
        }
        return origQuery(params);
      };
    }

    // WebGL vendor/renderer
    const patchWebGL = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function(param) {
        // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
        if (param === 37445) return 'Google Inc. (Intel)';
        if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, D3D11)';
        return orig.call(this, param);
      };
    };
    patchWebGL(WebGLRenderingContext?.prototype);
    patchWebGL(WebGL2RenderingContext?.prototype);
  });
}

function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-uscis-'));
  return dir;
}

function buildProxyOption() {
  if (!PROXY_SERVER) return undefined;

  // Si las credenciales vienen embebidas en la URL, Playwright las toma solo con 'server'
  const opt = { server: PROXY_SERVER };
  // Si vienen separadas, agregamos usuario/clave
  if (PROXY_USERNAME || PROXY_PASSWORD) {
    opt.username = PROXY_USERNAME || undefined;
    opt.password = PROXY_PASSWORD || undefined;
  }
  return opt;
}

async function launchPersistent() {
  const userDataDir = makeUserDataDir();

  const options = {
    headless: !HEADFUL,
    args: buildLaunchArgs(),
    ...buildContextOptions(),
  };

  const proxyOpt = buildProxyOption();
  if (proxyOpt) options.proxy = proxyOpt;

  let context;
  let using = 'chromium-bundled';

  try {
    if (USE_CHROME) {
      context = await chromium.launchPersistentContext(userDataDir, {
        ...options,
        channel: 'chrome', // requiere que 'chrome' esté instalado vía 'npx playwright install chrome'
      });
      using = 'chrome-channel';
    } else {
      context = await chromium.launchPersistentContext(userDataDir, options);
    }
  } catch (e) {
    // Si falló el canal chrome, caemos a Chromium
    if (USE_CHROME) {
      log('Chrome channel requested but failed to launch; falling back to bundled Chromium.', e.message);
      context = await chromium.launchPersistentContext(userDataDir, options);
      using = 'chromium-bundled';
    } else {
      throw e;
    }
  }

  await applyStealth(context);

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(60_000);

  if (DEBUG) {
    log('Browser in use:', using, '| headful:', HEADFUL ? 'yes' : 'no', proxyOpt ? '| proxy:on' : '| proxy:off');
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'warning' || type === 'error') {
        log('[page.console]', type, msg.text());
      }
    });
    page.on('pageerror', e => log('[pageerror]', e.message));
    page.on('requestfailed', req => log('[requestfailed]', req.url(), req.failure()?.errorText));
  }

  return { context, page, userDataDir };
}

// ========= CLOUDFLARE (espera pasiva con backoff) =========
async function passCloudflare(page, { maxWaitMs = 150_000 } = {}) {
  const start = Date.now();
  let waitMs = 1200;

  while (Date.now() - start < maxWaitMs) {
    // ¿El input de receipt ya es visible?
    const ready = await page
      .locator('input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (ready) return true;

    // Señales de challenge
    const title = await page.title().catch(() => '');
    const cfOn =
      /Just a moment|Attention Required|Security check|Challenge|Verify/i.test(title) ||
      await page.locator('text=/Verifying you are human|Just a moment|Please wait/i').first().isVisible().catch(() => false) ||
      await page.locator('#cf-please-wait, #challenge-running').count().then(c => c > 0).catch(() => false) ||
      await page.locator('iframe[title*="Cloudflare"], iframe[title*="security challenge"], iframe[src*="turnstile"]').count().then(c => c > 0).catch(() => false);

    // Darle tiempo al JS a que evalúe
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(waitMs + Math.floor(Math.random() * 500));

    // Incremental backoff suave
    waitMs = Math.min(waitMs + 400, 3000);

    // Micro acción humana: mover un poco el mouse
    try {
      await page.mouse.move(200 + Math.random() * 300, 300 + Math.random() * 200, { steps: 3 });
    } catch {}

    // pequeño respiro si no hay señales claras
    if (!cfOn) await sleep(400);
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
  if (!cfOk) throw new Error('Cloudflare guard did not finish in time');

  // 2) Ingresar receipt
  const input = page.locator('input#receipt_number, input[name="appReceiptNum"], input[name="receiptNumber"], input[id*="receipt"]').first();
  await input.waitFor({ state: 'visible', timeout: 25_000 });
  await input.fill('');
  await sleep(250 + Math.floor(Math.random() * 250));
  await input.type(receipt, { delay: 60 + Math.floor(Math.random() * 50) });

  // 3) Submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Check Status"), input[type="submit"]').first();
  await Promise.all([
    page.waitForLoadState('load'),
    submitBtn.click()
  ]);
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await passCloudflare(page, { maxWaitMs: 60_000 });

  // 4) Capturar HTML de resultado
  const html = await page.content();
  return {
    tramite_id: item.tramite_id,
    receipt_number: receipt,
    html,
  };
}

async function processQueueSequential(page, items) {
  const successes = [];
  const failures = [];

  for (const it of items) {
    try {
      log('Processing:', it.receipt_number);
      const result = await scrapeOne(page, it);
      successes.push(result);

      // Pausa ligera entre casos (reduce ritmo “robótico”)
      await sleep(1200 + Math.floor(Math.random() * 800));
    } catch (err) {
      const msg = `FAIL ${it.receipt_number}: ${err.message}`;
      log(msg, '—', errInfo(err));
      failures.push({
        tramite_id: it.tramite_id,
        receipt_number: it.receipt_number,
        error: err.message,
      });

      // Si falló por Cloudflare, espera más antes del próximo intento
      if (/Cloudflare/i.test(err.message)) {
        await sleep(4000 + Math.floor(Math.random() * 3000));
      }
    }
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

  // Contexto PERSISTENTE para mantener cookies del guard
  const { context, page, userDataDir } = await launchPersistent();
  try {
    const { successes, failures } = await processQueueSequential(page, queue);

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
  } finally {
    await context.close().catch(() => {});
    // Limpieza del perfil temporal
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  log('--- Scraping Cycle Finished ---');
}

main().catch(err => { console.error(err); process.exit(1); });

