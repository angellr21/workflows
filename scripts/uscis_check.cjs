#!/usr/bin/env node
/**
 * USCIS Checker (Opción B) — sin dependencias externas (usa fetch nativo de Node 18+)
 *
 * Flujo:
 * 1) Lee API_BASE y API_TOKEN desde env.
 * 2) GET {API_BASE}/queue  -> obtiene { status:"ok", queue:[ { tramite_id, receipt_number, ... } ] }
 * 3) Por cada item: abre USCIS, consulta el receipt y obtiene el HTML de resultado.
 * 4) POST {API_BASE}/report con { items: [ { tramite_id, html } ] }
 * 5) Log estructurado para CI.
 */

const { chromium } = require('playwright'); // Playwright viene por acciones previas del workflow

// Utilidad: normalizar base URL
function normalizeBase(u) {
  let b = String(u || '').trim();
  b = b.replace(/[?#].*$/, '');      // quita query/fragment
  b = b.replace(/\/+$/, '');         // quita trailing slash
  b = b.replace(/\/queue$/i, '');    // por si mandan .../queue
  return b;
}

// Pequeños helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

(async () => {
  log('USCIS Actions: iniciando…');

  // 1) ENV
  const RAW_API_BASE = process.env.API_BASE || '';
  const API_TOKEN = process.env.API_TOKEN || '';
  const API_BASE = normalizeBase(RAW_API_BASE);

  if (!API_BASE) {
    console.error('ERROR: API_BASE no definido.');
    process.exit(1);
  }
  if (!API_TOKEN) {
    console.error('ERROR: API_TOKEN no definido.');
    process.exit(1);
  }

  log('API_BASE (raw):', RAW_API_BASE.replace(/.{4}$/,'****'));
  log('API_BASE (normalizada):', API_BASE.replace(/.{4}$/,'****'));

  // 2) Traer cola
  const queueUrl = `${API_BASE}/queue`;
  log('URL de cola:', queueUrl.replace(/.{4}$/,'****'));

  let queueJson;
  try {
    const res = await fetch(queueUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Queue HTTP ${res.status}`);
    }
    queueJson = await res.json();
  } catch (err) {
    console.error('ERROR al pedir cola:', err.message);
    process.exit(1);
  }

  const queue = Array.isArray(queueJson?.queue) ? queueJson.queue : [];
  log(`Se recibieron ${queue.length} item(s) para revisar.`);

  if (!queue.length) {
    log('Nada para hacer.');
    process.exit(0);
  }

  // 3) Playwright (headless 100%)
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing.do';

  // Función: consultar un receipt y devolver HTML de resultado
  async function fetchCaseHtml(receipt) {
    const page = await context.newPage();
    try {
      await page.goto(USCIS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Campo de receipt
      const inputSel = 'input[name="appReceiptNum"], #receipt_number, #receiptNum';
      await page.waitForSelector(inputSel, { timeout: 30000 });
      await page.fill(inputSel, receipt);

      // Botón "Check Status" (varía con cambios de USCIS; probamos varios)
      const btnSelectors = [
        'input[type="submit"][value*="Check"]',
        'button[type="submit"]',
        '#caseStatusSearch, #caseStatusButton, #allFormSubmitButton',
        'input[type="submit"]',
      ];
      let clicked = false;
      for (const sel of btnSelectors) {
        const exists = await page.$(sel);
        if (exists) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{}),
            page.click(sel).catch(()=>{}),
          ]);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        throw new Error('No se encontró el botón de "Check Status".');
      }

      // Esperar contenido del resultado; probamos varios contenedores típicos
      const resultSelectors = [
        '#caseStatus',               // container general
        '.rows.text-center',         // muy común
        '.appointment-sec',          // fallback
        '.content',                  // fallback genérico
        'main',                      // último recurso
      ];
      await page.waitForSelector(resultSelectors.join(', '), { timeout: 60000 });

      // Capturamos el HTML de la sección principal si existe; si no, toda la página
      for (const sel of resultSelectors) {
        const el = await page.$(sel);
        if (el) {
          const html = await el.evaluate((node) => node.outerHTML);
          if (html && html.trim().length > 200) return html;
        }
      }
      // fallback: toda la página
      const fullHtml = await page.content();
      return fullHtml;
    } finally {
      await page.close().catch(()=>{});
    }
  }

  // 4) Procesar cola y preparar payload para /report
  const itemsForReport = [];
  for (const it of queue) {
    const receipt = String(it.receipt_number || '').trim();
    const tramiteId = it.tramite_id ?? it.id; // prioridad a tramite_id; si no, usa id
    if (!receipt || !tramiteId) {
      log('• Item inválido (sin receipt o tramite_id):', JSON.stringify(it));
      continue;
    }

    log('• Pendiente:', receipt);

    try {
      // Pequeño delay entre consultas para evitar rate-limits
      await sleep(1000 + Math.floor(Math.random() * 500));

      const html = await fetchCaseHtml(receipt);

      // Validación básica
      if (!html || html.length < 200) {
        throw new Error('HTML de resultado demasiado corto.');
      }

      itemsForReport.push({ tramite_id: tramiteId, html });
    } catch (err) {
      // No abortamos el lote completo; continuamos con los demás
      console.error(`✗ Error con ${receipt}:`, err.message);
      // (Opcional: podríamos reportar fails individualmente a otra ruta)
    }
  }

  // Si no hay nada que reportar, cerramos
  if (!itemsForReport.length) {
    await browser.close();
    log('No hay items válidos para reportar.');
    process.exit(0);
  }

  // 5) POST /report
  const reportUrl = `${API_BASE}/report`;
  try {
    const res = await fetch(reportUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: itemsForReport }),
    });
    const bodyText = await res.text().catch(()=> '');
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch {}
    if (!res.ok) {
      throw new Error(`Report HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    log('Reporte enviado. Respuesta:', bodyJson ? JSON.stringify(bodyJson).slice(0, 500) : bodyText.slice(0, 500));
  } catch (err) {
    console.error('ERROR al enviar reporte:', err.message);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  log('Listo.');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
