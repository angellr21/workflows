#!/usr/bin/env node
/**
 * USCIS Checker — sin dependencias externas (usa fetch nativo de Node 18+)
 * Requisitos en el runner:
 *  - Node 18+ (el workflow usa Node 20)
 *  - Playwright instalado con Chromium (el workflow lo instala)
 * Entradas:
 *  - API_BASE (secreto): base del API, p.ej. https://aroeservices.com/api/uscis
 *  - API_TOKEN (secreto): token Bearer para autorización
 *
 * Flujo:
 *  1) GET  {API_BASE}/queue      -> obtiene items {tramite_id, receipt_number}
 *  2) Navega a USCIS y genera HTML del resultado para cada receipt
 *  3) POST {API_BASE}/report     -> envía [{tramite_id, html}]
 */

const { chromium } = require('playwright');

function normalizeBase(u) {
  let b = String(u || '').trim();
  b = b.replace(/[?#].*$/, '');   // quita query/fragment
  b = b.replace(/\/+$/, '');      // quita trailing slash
  b = b.replace(/\/queue$/i, ''); // por si pasan /queue por error
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** Pequeña redacción del dominio al imprimir (evita mostrar secretos en claro) */
function redact(url) {
  try {
    const u = new URL(url);
    const host = u.host;
    const safeHost = host.length > 8 ? host.slice(0, host.length - 4) + '****' : host;
    return `${u.protocol}//${safeHost}${u.pathname}`;
  } catch {
    return String(url).replace(/.{4}$/, '****');
  }
}

(async () => {
  log('USCIS Actions: iniciando…');

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

  log('API_BASE (raw):', RAW_API_BASE ? redact(RAW_API_BASE) : '(vacío)');
  log('API_BASE (normalizada):', redact(API_BASE));

  const queueUrl = `${API_BASE}/queue`;
  log('URL de cola:', redact(queueUrl));

  let queueJson;
  try {
    const res = await fetch(queueUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    });
    if (!res.ok) throw new Error(`Queue HTTP ${res.status}`);
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

  // Lanzar navegador headless
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const USCIS_URL = 'https://egov.uscis.gov/casestatus/landing.do';

  async function fetchCaseHtml(receipt) {
    const page = await context.newPage();
    try {
      await page.goto(USCIS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Campo probable (pueden variar IDs/names)
      const inputSel = 'input[name="appReceiptNum"], #receipt_number, #receiptNum';
      await page.waitForSelector(inputSel, { timeout: 30000 });
      await page.fill(inputSel, receipt);

      // Intentar diferentes botones
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
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
            page.click(sel).catch(() => {}),
          ]);
          clicked = true;
          break;
        }
      }
      if (!clicked) throw new Error('No se encontró el botón de "Check Status".');

      // Esperar resultados (varios selectores candidatos)
      const resultSelectors = [
        '#caseStatus',
        '.rows.text-center',
        '.appointment-sec',
        '.content',
        'main',
      ];
      await page.waitForSelector(resultSelectors.join(', '), { timeout: 60000 });

      // Intentar extraer fragmento significativo primero
      for (const sel of resultSelectors) {
        const el = await page.$(sel);
        if (el) {
          const html = await el.evaluate((node) => node.outerHTML);
          if (html && html.trim().length > 200) return html;
        }
      }

      // Si no, devolver toda la página
      return await page.content();
    } finally {
      await page.close().catch(() => {});
    }
  }

  const itemsForReport = [];
  for (const it of queue) {
    const receipt = String(it.receipt_number || '').trim();
    // el backend acepta tramite_id (preferente) o id según tu implementación
    const tramiteId = it.tramite_id ?? it.id;

    if (!receipt || !tramiteId) {
      log('• Item inválido (sin receipt o tramite_id):', JSON.stringify(it));
      continue;
    }

    log('• Pendiente:', receipt);

    try {
      // Pequeño jitter para no machacar
      await sleep(1000 + Math.floor(Math.random() * 500));

      const html = await fetchCaseHtml(receipt);
      if (!html || html.length < 200) throw new Error('HTML de resultado demasiado corto.');

      itemsForReport.push({ tramite_id: tramiteId, html });
    } catch (err) {
      console.error(`✗ Error con ${receipt}:`, err.message);
    }
  }

  if (!itemsForReport.length) {
    await browser.close();
    log('No hay items válidos para reportar.');
    process.exit(0);
  }

  const reportUrl = `${API_BASE}/report`;
  log('URL de reporte:', redact(reportUrl));

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

    const bodyText = await res.text().catch(() => '');
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      // puede no ser JSON
    }

    if (!res.ok) throw new Error(`Report HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
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
