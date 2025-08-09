#!/usr/bin/env node

/**
 * USCIS checker (GitHub Actions)
 * - Pide cola a tu API protegida
 * - Hace scraping en egov.uscis.gov para cada receipt
 * - Devuelve el HTML íntegro al endpoint /api/uscis/report
 * Requiere:
 *   - Node 20+ (tiene fetch nativo)
 *   - Playwright (chromium)
 *   - ENV: API_BASE, API_TOKEN
 */

const { chromium } = require('playwright');

const API_BASE  = process.env.API_BASE  || 'https://aroeservices.com';
const API_TOKEN = process.env.API_TOKEN;

function log(...a) { console.log(...a); }

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST ${path} -> ${res.status} ${res.statusText} ${txt}`);
  }
  return res.json();
}

async function scrapeReceipt(page, receiptNumber) {
  // Consulta directa por querystring (más estable que el formulario)
  const url = `https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=${encodeURIComponent(receiptNumber)}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Espera contenedor de estado o main; el sitio cambia clases a menudo
  try {
    await page.waitForSelector('#caseStatus, #formCaseStatus, main', { timeout: 30_000 });
  } catch (_) { /* continuamos igual: devolveremos el HTML completo */ }

  // Devolvemos TODO el HTML para que el backend lo parsee con su servicio
  const html = await page.content();
  return html;
}

(async () => {
  log('USCIS Actions: iniciando…');

  if (!API_TOKEN) {
    console.error('Falta API_TOKEN en variables de entorno.');
    process.exit(1);
  }

  // 1) Obtener cola
  let data;
  try {
    data = await apiGet('/api/uscis/queue');
  } catch (err) {
    console.error('Error pidiendo cola:', err.message);
    process.exit(1);
  }

  // Compatibilidad con respuestas antiguas y nuevas:
  // - nueva: { ok: true, count, items: [{ tramite_id, receipt_number }] }
  // - antigua: { status:'ok', queue: [{ id, receipt_number, ... }] }
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.queue)
      ? data.queue.map(x => ({
          tramite_id: x.tramite_id ?? x.id ?? x.tramite ?? x.tramiteId ?? null,
          receipt_number: x.receipt_number ?? x.receipt ?? x.number ?? null
        }))
      : [];

  log(`Se recibieron ${items.length} item(s) para revisar.`);

  if (!items.length) {
    log('Nada para hacer.');
    return;
  }

  // 2) Scraping
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36'
  });

  const results = [];

  try {
    for (const item of items) {
      const tramite_id     = item.tramite_id ?? item.id;
      const receipt_number = item.receipt_number;

      if (!tramite_id || !receipt_number) {
        log('Item inválido (falta tramite_id o receipt_number):', JSON.stringify(item));
        continue;
      }

      log(`→ ${receipt_number} (tramite ${tramite_id})`);

      const page = await context.newPage();
      try {
        const html = await scrapeReceipt(page, receipt_number);
        results.push({ tramite_id, html });
        log(`  ✓ scrape OK (${html.length} bytes)`);
      } catch (err) {
        log(`  ✗ error scrape: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (!results.length) {
    log('No hay resultados para reportar.');
    return;
  }

  // 3) Reportar HTMLs al backend para que parsee y actualice estados
  try {
    const resp = await apiPost('/api/uscis/report', { items: results });
    log('Reporte enviado:', JSON.stringify(resp));
  } catch (err) {
    console.error('Error reportando resultados:', err.message);
    process.exit(1);
  }
})();
