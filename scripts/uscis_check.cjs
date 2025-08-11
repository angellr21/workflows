#!/usr/bin/env node
"use strict";

/**
 * USCIS scraper runner
 * - Lee la cola desde tu API
 * - Navega a la página de USCIS con Playwright
 * - Reporta éxitos o fallos a tu API
 *
 * Funciona tanto si API_BASE es:
 *   - https://aroeservices.com
 *   - https://aroeservices.com/api/uscis
 */

const { chromium } = require("playwright");

// ---------- Config ----------
const RAW_BASE = (process.env.API_BASE || "").replace(/\/+$/, "");
const API_TOKEN = process.env.API_TOKEN || "";
const LIMIT = Number(process.env.LIMIT || 10);
const FORCE = (process.env.FORCE || "").toString().trim();

// Normaliza las rutas para evitar "api/uscis/api/uscis"
function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const hasPrefix = /\/api\/uscis\/?$/.test(RAW_BASE);
  return hasPrefix ? `${RAW_BASE}${p}` : `${RAW_BASE}/api/uscis${p}`;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Accept": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GET ${url} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function snippetOf(str, len = 300) {
  if (!str) return "";
  const clean = str.replace(/\s+/g, " ").trim();
  return clean.length > len ? clean.slice(0, len) : clean;
}

// ---------- Scraping ----------
async function processOne(page, receipt) {
  // Página de status de casos de USCIS
  const START_URL = "https://egov.uscis.gov/casestatus/landing.do";

  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Heurística básica para detectar Cloudflare / interstitials
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  if (/Verify you are human|Performance & security by Cloudflare|Just a moment/i.test(bodyText)) {
    throw new Error("Cloudflare challenge / interstitial");
  }

  // Diferentes selectores por si cambian el markup
  const inputSelectors = [
    'input#receipt_number',
    'input[name="appReceiptNum"]',
    'input[name="receipt_number"]',
    'input[type="text"]',
  ];

  let found = false;
  for (const sel of inputSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.fill(receipt, { timeout: 5000 }).catch(() => {});
      found = true;
      break;
    }
  }
  if (!found) {
    // Dump rápido de la página para debug
    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText || "");
    throw new Error(`Receipt input not found — ${snippetOf(text || html, 300)}`);
  }

  // Click en el botón "Check Status" (varias opciones)
  const clickSelectors = [
    'button:has-text("Check Status")',
    'input[type="submit"][value*="Check"]',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  let clicked = false;
  for (const sel of clickSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click({ timeout: 8000 }).catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    throw new Error("Submit button not found");
  }

  // Espera algo de contenido de resultado
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await sleep(800);

  // Extrae HTML completo para que el backend lo procese
  const html = await page.content();
  const text2 = await page.evaluate(() => document.body.innerText || "");
  if (/Verify you are human|Performance & security by Cloudflare|Just a moment/i.test(text2)) {
    throw new Error("Cloudflare challenge after submit");
  }

  // Opcional: validación mínima de que no es la pantalla inicial
  if (/Enter a receipt number|Status Information/i.test(text2) === false && html.length < 1000) {
    throw new Error("Unexpected result page");
  }

  return html;
}

// ---------- Main ----------
(async () => {
  console.log(`[${new Date().toISOString()}] --- Scraping Cycle Started ---`);
  console.log(`[${new Date().toISOString()}] API_BASE_URL: ${RAW_BASE || "(not set)"}`);

  if (!RAW_BASE || !API_TOKEN) {
    console.error("Missing API_BASE or API_TOKEN env vars");
    process.exit(1);
  }

  const limitParam = isFinite(LIMIT) && LIMIT > 0 ? `limit=${LIMIT}` : "limit=10";
  const forceParam = FORCE ? `&force=${encodeURIComponent(FORCE)}` : "";
  const queueUrl = apiUrl(`/queue?${limitParam}${forceParam}`);

  let list = [];
  try {
    console.log(`[${new Date().toISOString()}] Fetching queue from API (GET): ***${queueUrl.endsWith("/queue") ? "/queue" : "/queue?"}`);
    const data = await getJson(queueUrl);
    // Soporta { queue: [...] } o { tramites: [...] }
    list = data.queue || data.tramites || [];
  } catch (err) {
    console.warn(`[${new Date().toISOString()}] Queue API error (soft-fail): ${err.message}`);
    console.log(`[${new Date().toISOString()}] Queue size: 0`);
    console.log(`[${new Date().toISOString()}] No receipts to process (or API unavailable). Exiting gracefully.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Queue size: ${list.length}`);

  if (!Array.isArray(list) || list.length === 0) {
    console.log(`[${new Date().toISOString()}] No receipts to process (or API unavailable). Exiting gracefully.`);
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  const successes = [];
  const failures = [];

  try {
    for (const item of list) {
      const receipt = item.receipt_number || item.uscis_receipt_number;
      if (!receipt) continue;

      console.log(`[${new Date().toISOString()}] Processing: ${receipt}`);

      try {
        const html = await processOne(page, receipt);
        successes.push({ tramite_id: item.tramite_id, html });
      } catch (err) {
        const content = await page.content().catch(() => "");
        const txt = await page.evaluate(() => document.body.innerText || "").catch(() => "");
        const snap = snippetOf(txt || content, 300);
        console.log(`[${new Date().toISOString()}] FAIL ${receipt}: ${err.message}`);
        if (snap) console.log(`[${new Date().toISOString()}] FAIL ${receipt} SNIPPET: ${snap}`);
        failures.push({ receipt_number: receipt, error: err.message });
      }

      // Pequeña pausa anti-bloqueos
      await sleep(1200 + Math.random() * 1200);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Reporte de éxitos
  if (successes.length > 0) {
    try {
      await postJson(apiUrl("/report"), { items: successes });
      console.log(`[${new Date().toISOString()}] Reported successes: ${successes.length}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error reporting successes: ${err.message}`);
    }
  } else {
    console.log(`[${new Date().toISOString()}] No successful scrapes to report.`);
  }

  // Reporte de fallos (estructura que tu API espera)
  if (failures.length > 0) {
    try {
      console.log(`[${new Date().toISOString()}] Reporting failed items: ${failures.length}`);
      await postJson(apiUrl("/report-failed"), { items: failures });
    } catch (err) {
      console.error(err.stack || err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] --- Scraping Cycle Finished ---`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
