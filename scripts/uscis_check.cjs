// scripts/uscis_check.cjs
const { chromium } = require('playwright'); // CommonJS

const API_BASE  = process.env.API_BASE;
const API_TOKEN = process.env.API_TOKEN;

if (!API_BASE || !API_TOKEN) {
  console.error("Faltan variables API_BASE o API_TOKEN.");
  process.exit(1);
}

async function fetchQueue() {
  const res = await fetch(`${API_BASE}/api/uscis/queue`, {
    headers: { 'Authorization': `Bearer ${API_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Queue error ${res.status}: ${await res.text()}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log("USCIS Actions: iniciando…");
  const queue = await fetchQueue();
  const items = (queue && queue.items) ? queue.items : [];
  console.log(`Se recibieron ${items.length} item(s) para revisar.`);
  if (items.length === 0) { console.log("Nada para hacer."); return; }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const results = [];
  for (const it of items) {
    const page = await context.newPage();
    try {
      await page.goto('https://egov.uscis.gov/casestatus/landing.do', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(700 + Math.random()*900);

      const url = `https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=${encodeURIComponent(it.receipt_number)}&initCaseSearch=CHECK+STATUS`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });

      const html = await page.content();

      results.push({
        tramite_id: it.tramite_id,
        receipt_number: it.receipt_number,
        html,
        fetched_at: new Date().toISOString(),
      });

      console.log(`OK: ${it.receipt_number}`);
    } catch (err) {
      console.error(`Fallo ${it.receipt_number}: ${err.message}`);
      results.push({
        tramite_id: it.tramite_id,
        receipt_number: it.receipt_number,
        html: '',
        fetched_at: new Date().toISOString(),
      });
    } finally {
      await page.close();
      await sleep(900 + Math.random()*1300);
    }
  }

  await browser.close();

  const resp = await fetch(`${API_BASE}/api/uscis/report`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ items: results }),
  });
  if (!resp.ok) throw new Error(`Report error ${resp.status}: ${await resp.text()}`);
  const j = await resp.json();
  console.log("Reporte enviado:", j);
  console.log("USCIS Actions: fin.");
})().catch(err => {
  console.error("Proceso falló:", err);
  process.exit(1);
});
