#!/usr/bin/env node
'use strict';

/**
 * USCIS Worker (Playwright + API)
 * - Lee cola desde /api/uscis/queue (con ?force=1&limit=N)
 * - Intenta obtener el estado por:
 *    1) URL directa mycasestatus.do
 *    2) Flujo del formulario (landing.do)
 * - Reporta éxitos a /api/uscis/report  (items: [{ tram ite_id, html }])
 * - Reporta fallos  a /api/uscis/report-failed (items: [{ receipt_number, error }])
 * - Maneja Cloudflare con esperas y pequeños parches “stealth”
 */

const { chromium } = require('playwright');

// ===== Configuración por ENV =====
const API_BASE = process.env.API_BASE || '';
const API_TOKEN = process.env.API_TOKEN || '';
const FORCE_QUEUE = (process.env.FORCE_QUEUE || '').toLowerCase() === '1' || (process.env.FORCE_QUEUE || '').toLowerCase() === 'true';
const QUEUE_LIMIT = Number.parseInt(process.env.QUEUE_LIMIT || '10', 10);
const HEADLESS = !['0', 'false', 'no'].includes((process.env.HEADLESS || '').toLowerCase());

// ===== Constantes de USCIS =====
const USCIS_LANDING_URL = 'https://egov.uscis.gov/casestatus/landing.do';
const USCIS_DIRECT_URL = 'https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=';

// ===== Utils =====
const ts = () => new Date().toISOString();
const log = (...args) => console.log(`[${ts()}]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CF_HINTS = [
  /verify you are human/i,
  /just a moment/i,
  /cloudflare/i,
  /enable javascript and cookies/i,
  /performance & security by cloudflare/i,
];

function apiUrl(endpoint) {
  const base = API_BASE.replace(/\/+$/, '');
  const ep = String(endpoint || '').replace(/^\/+/, '');
  return `${base}/api/uscis/${ep}`;
}

function epForLog(endpoint) {
  const ep = String(endpoint || '').replace(/^\/?/, '/');
  return `***${ep}`;
}

// ===== HTTP helpers (Node 20: fetch nativo) =====
async function getJson(endpoint) {
  const url = apiUrl(endpoint);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${epForLog(endpoint)} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${epForLog(endpoint)} returned non-JSON response`);
  }
}

async function postJson(endpoint, body) {
  const url = apiUrl(endpoint);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${epForLog(endpoint)} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

// ===== Detección / espera de Cloudflare =====
async function pageInnerText(page) {
  try {
    return (await page.evaluate(() => document.body?.innerText || '')) || '';
  } catch {
    return '';
  }
}

async function isCloudflarePage(page) {
  const txt = await pageInnerText(page);
  return CF_HINTS.some((re) => re.test(txt));
}

async function waitThroughCloudflare(page, maxMs = 90_000) {
  const started = Date.now();
  let notified = false;

  // si ya estamos en resultados
  if (page.url().includes('mycasestatus.do')) return;

  while (Date.now() - started < maxMs) {
    if (await isCloudflarePage(page)) {
      if (!notified) {
        log('Cloudflare challenge detectado. Esperando a que se complete…');
        notified = true;
      }
      try {
        await Promise.race([
          page.waitForURL(/mycasestatus\.do/i, { timeout: 5000 }),
          page.waitForLoadState('networkidle', { timeout: 5000 }),
        ]);
      } catch (_) {
        // ignorar timeouts cortos, seguimos esperando
      }
      await sleep(1500 + Math.random() * 1500);
      continue;
    }

    // ¿ya hay UI de resultados?
    const inResults = page.url().includes('mycasestatus.do');
    const hasUi = await page
      .locator('#caseStatus, .current-status-sec, .rows.text-center, .case-status')
      .first()
      .count()
      .catch(() => 0);
    if (inResults || hasUi) return;

    await sleep(1200 + Math.random() * 1200);
  }
}

// ===== Extracción de HTML de estado =====
async function extractStatusHtml(page) {
  const candidates =
    '#caseStatus, .current-status-sec, .rows.text-center, .case-status, main .container';
  const node = page.locator(candidates).first();
  try {
    if ((await node.count()) > 0) {
      const html = await node.evaluate((el) => el.outerHTML);
      if (html && html.trim().length > 0) return html;
    }
  } catch (_) {}
  // fallback muy laxo si ya estamos en mycasestatus
  if (page.url().includes('mycasestatus.do')) {
    try {
      const h1 = await page.locator('h1').first().textContent().catch(() => '');
      const p = await page.locator('p').first().textContent().catch(() => '');
      if ((h1 && h1.trim()) || (p && p.trim())) {
        const safe = (s) => (s || '').toString().trim();
        return `<div id="uscisStatusExtract"><h1>${safe(h1)}</h1><p>${safe(p)}</p></div>`;
      }
    } catch (_) {}
  }
  return null;
}

async function textSnippet(page, max = 300) {
  const t = await pageInnerText(page);
  return t.replace(/\s+/g, ' ').trim().slice(0, max);
}

// ===== Flujos de scraping =====
async function tryDirectResults(page, receipt) {
  const url = `${USCIS_DIRECT_URL}${encodeURIComponent(receipt)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch (_) {}
  await waitThroughCloudflare(page, 90_000);

  return extractStatusHtml(page);
}

async function tryFormFlow(page, receipt) {
  await page.goto(USCIS_LANDING_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch (_) {}
  await waitThroughCloudflare(page, 90_000);

  const input = page.locator('input[name="appReceiptNum"], input#receipt_number').first();
  if ((await input.count().catch(() => 0)) === 0) {
    const snip = await textSnippet(page);
    const err = new Error('Receipt input not found');
    err.snippet = snip;
    throw err;
  }

  await input.click({ timeout: 10_000 });
  await input.fill(receipt, { timeout: 10_000 });

  // Posibles botones de submit
  const submitCandidates = [
    'button:has-text("Check")',
    'button:has-text("Check Status")',
    '#caseStatusSearch',
    '#casestatus-search',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  let clicked = false;
  for (const sel of submitCandidates) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) > 0) {
        await Promise.allSettled([btn.click({ timeout: 5000 })]);
        clicked = true;
        break;
      }
    } catch (_) {}
  }

  if (!clicked) {
    // fallback con Enter
    try {
      await input.press('Enter', { delay: 20 });
    } catch (_) {}
  }

  try {
    await Promise.race([
      page.waitForURL(/mycasestatus\.do/i, { timeout: 20_000 }),
      page.waitForSelector('#caseStatus, .current-status-sec, #formErrors, .rows.text-center', {
        timeout: 20_000,
      }),
    ]);
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch (_) {}
  } catch (_) {}

  await waitThroughCloudflare(page, 90_000);

  const html = await extractStatusHtml(page);
  if (html) return html;

  const snip = await textSnippet(page);
  const err = new Error('No status content found');
  err.snippet = snip;
  throw err;
}

// ===== Ejecución principal =====
(async () => {
  if (!API_BASE || !API_TOKEN) {
    console.error('Faltan variables de entorno: API_BASE y/o API_TOKEN');
    process.exit(1);
  }

  log('--- Scraping Cycle Started ---');
  log(`API_BASE_URL: ${API_BASE}`);

  const params = [];
  if (FORCE_QUEUE) params.push('force=1');
  if (QUEUE_LIMIT && Number.isFinite(QUEUE_LIMIT)) params.push(`limit=${QUEUE_LIMIT}`);
  const queueEndpoint = `queue${params.length ? `?${params.join('&')}` : ''}`;

  let items = [];
  try {
    log(`Fetching queue from API (GET): ${epForLog(queueEndpoint)}`);
    const data = await getJson(queueEndpoint);
    items = Array.isArray(data.queue) ? data.queue : [];
  } catch (e) {
    log(`Queue API error (soft-fail): ${e.message}`);
    items = [];
  }

  log(`Queue size: ${items.length}`);
  if (items.length === 0) {
    log('No receipts to process (or API unavailable). Exiting gracefully.');
    return;
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1366, height: 768 },
    javaScriptEnabled: true,
  });

  // Pequeños parches anti-automation
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // @ts-ignore
    window.chrome = { runtime: {} };
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters);
    }
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  const successes = [];
  const failures = [];

  for (const item of items) {
    const receipt =
      (item && (item.receipt_number || item.uscis_receipt_number || '')).toString().trim();
    const tramiteId = item && item.tramite_id;

    if (!receipt) continue;

    log(`Processing: ${receipt}`);
    const page = await ctx.newPage();
    try {
      // 1) Intento directo
      let html = await tryDirectResults(page, receipt);

      // 2) Si no hubo suerte, intentar flujo formulario (en una pestaña limpia)
      if (!html) {
        await page.close({ runBeforeUnload: false }).catch(() => {});
        const page2 = await ctx.newPage();
        html = await tryFormFlow(page2, receipt);
        await page2.close({ runBeforeUnload: false }).catch(() => {});
      } else {
        await page.close({ runBeforeUnload: false }).catch(() => {});
      }

      if (html && tramiteId) {
        successes.push({ tramite_id: tramiteId, html });
      } else if (html && !tramiteId) {
        // Debería venir siempre, pero si no: reporta como fallo suave
        failures.push({ receipt_number: receipt, error: 'Missing tramite_id in queue item' });
      } else {
        failures.push({ receipt_number: receipt, error: 'No status content found' });
      }
    } catch (e) {
      const msg = e && e.message ? e.message : 'Unknown error';
      const snip = e && e.snippet ? e.snippet : await textSnippet(page);
      log(`FAIL ${receipt}: ${msg}`);
      if (snip) log(`FAIL ${receipt} SNIPPET: ${snip}`);
      failures.push({ receipt_number: receipt, error: msg });
    } finally {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      await sleep(400 + Math.random() * 400);
    }
  }

  // Reporte de éxitos
  if (successes.length > 0) {
    try {
      log(`Reporting successful items: ${successes.length}`);
      await postJson('report', {
        items: successes.map((i) => ({ tramite_id: i.tramite_id, html: i.html })),
      });
    } catch (e) {
      // Si falla el reporte de éxitos, es crítico
      await browser.close().catch(() => {});
      throw e;
    }
  } else {
    log('No successful scrapes to report.');
  }

  // Reporte de fallos (no crítico)
  if (failures.length > 0) {
    try {
      log(`Reporting failed items: ${failures.length}`);
      await postJson('report-failed', {
        items: failures.map((f) => ({
          receipt_number: f.receipt_number,
          error: f.error || 'Unknown error',
        })),
      });
    } catch (e) {
      // lo registramos pero no reventamos el job si ya reportamos éxitos
      log(`Warn: reporting failures failed — ${e.message}`);
    }
  }

  await browser.close().catch(() => {});
  log('--- Scraping Cycle Finished ---');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
