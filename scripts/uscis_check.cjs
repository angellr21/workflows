#!/usr/bin/env node

/**
 * USCIS status checker - Playwright
 * Ejecuta scraping contra el portal de USCIS para los receipt numbers en cola.
 * Lee la cola de:   {API_BASE}/api/uscis/queue
 * Notifica hallazgos a: {API_BASE}/api/uscis/webhook
 */

const { chromium } = require('playwright');

const API_BASE  = process.env.API_BASE;
const API_TOKEN = process.env.API_TOKEN;

if (!API_BASE || !API_TOKEN) {
  console.error("Faltan variables API_BASE o API_TOKEN.");
  process.exit(1);
}

// --- LOGGING TEMPORAL (sin exponer token) ---
try {
  const host = (() => {
    try { return new URL(API_BASE).host; } catch { return API_BASE; }
  })();
  console.log(`[debug] Node: ${process.version}`);
  try {
    const pwv = require('playwright/package.json').version;
    console.log(`[debug] Playwright: ${pwv}`);
  } catch {}
  console.log(`[debug] Working dir: ${process.cwd()}`);
  console.log(`[debug] API_BASE host: ${host}`);
} catch (e) { console.log('[debug] logging error', e?.message); }
// --------------------------------------------

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchQueue() {
  console.log('[debug] fetchQueue ->', `${API_BASE}/api/uscis/queue`);
  const res = await fetch(`${API_BASE}/api/uscis/queue`, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Queue request failed: ${res.status} ${res.statusText}`);
  }
  const j = await res.json();
  console.log('[debug] queue payload keys:', Object.keys(j || {}));
  if (j && (j.items || j.queue)) {
    const arr = j.items || j.queue;
    console.log('[debug] queue length:', Array.isArray(arr) ? arr.length : 'n/a');
  }
  return j;
}

async function postWebhook(payload) {
  const res = await fetch(`${API_BASE}/api/uscis/webhook`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(()=>'');
    throw new Error(`Webhook failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json().catch(()=> ({}));
}

async function updateFail(receipt) {
  try {
    await fetch(`${API_BASE}/api/uscis/fail`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ receipt_number: receipt })
    });
  } catch (e) {
    console.error(`[warn] No se pudo marcar fail para ${receipt}:`, e.message);
  }
}

async function markDone(receipt) {
  try {
    await fetch(`${API_BASE}/api/uscis/done`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ receipt_number: receipt })
    });
  } catch (e) {
    console.error(`[warn] No se pudo marcar done para ${receipt}:`, e.message);
  }
}

async function scrapeStatus(page, receipt) {
  // Abre el portal de USCIS y consulta el receipt
  await page.goto('https://egov.uscis.gov/coa/displayCOAForm.do', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await page.goto('https://egov.uscis.gov/casestatus/landing.do', { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('#receipt_number', { timeout: 15000 });
  await page.fill('#receipt_number', receipt);
  await page.click('button[type="submit"]');

  await page.waitForSelector('#caseStatus', { timeout: 30000 });
  const title = await page.textContent('#caseStatus h1').catch(()=> null);
  const body  = await page.textContent('#caseStatus .rows.text-center').catch(()=> null);

  return {
    title: title ? title.trim() : null,
    message: body ? body.trim() : null
  };
}

async function main() {
  console.log('USCIS Actions: iniciando…');

  let queue;
  try {
    queue = await fetchQueue();
  } catch (e) {
    console.error('Error obteniendo la cola:', e.message);
    process.exit(1);
  }

  const items = Array.isArray(queue?.items) ? queue.items
               : Array.isArray(queue?.queue) ? queue.queue
               : [];

  console.log(`Se recibieron ${items.length} item(s) para revisar.`);

  if (!items.length) {
    console.log('Nada para hacer.');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    for (const item of items) {
      const receipt = item.receipt_number || item.receipt || item.number;
      if (!receipt) {
        console.warn('Elemento sin receipt_number, se omite.');
        continue;
      }

      console.log(`→ Consultando ${receipt}…`);
      try {
        const result = await scrapeStatus(page, receipt);

        if (result?.title || result?.message) {
          console.log(`   ✓ Hallado contenido para ${receipt}. Notificando webhook…`);
          await postWebhook({
            receipt_number: receipt,
            title: result.title,
            message: result.message,
            raw: result
          });
          await markDone(receipt);
        } else {
          console.log(`   ✗ Sin contenido para ${receipt}. Marcando fail…`);
          await updateFail(receipt);
        }
      } catch (e) {
        console.error(`   ⚠ Error consultando ${receipt}:`, e.message);
        await updateFail(receipt);
        // Respiro breve para no golpear el sitio con errores seguidos
        await sleep(1000);
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fallo no controlado:', err);
  process.exit(1);
});
