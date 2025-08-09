/* eslint-disable no-console */
const { chromium } = require('playwright');

function stripTrailingSlashes(s) {
  return (s || '').replace(/\/+$/, '');
}

async function main() {
  const API_BASE_RAW = process.env.API_BASE || '';
  const API_BASE = stripTrailingSlashes(API_BASE_RAW);
  const API_TOKEN = process.env.API_TOKEN || '';

  if (!API_BASE || !API_TOKEN) {
    console.error('Faltan variables de entorno: API_BASE y/o API_TOKEN.');
    process.exit(1);
  }

  console.log('USCIS Actions: iniciando…');
  console.log(`API_BASE: ${API_BASE}`);

  // 1) Obtener cola
  const qUrl = `${API_BASE}/uscis/queue`;
  const qRes = await fetch(qUrl, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Accept': 'application/json',
    },
  });

  if (!qRes.ok) {
    const body = await qRes.text().catch(() => '');
    console.error(`GET /uscis/queue -> HTTP ${qRes.status}`);
    console.error(body.slice(0, 400));
    process.exit(1);
  }

  const qJson = await qRes.json().catch(() => ({}));
  const items = Array.isArray(qJson.queue) ? qJson.queue : [];
  console.log(`Se recibieron ${items.length} item(s) para revisar.`);

  if (items.length === 0) {
    console.log('Nada para hacer.');
    return;
  }

  // 2) (Demo) Solo mostramos qué revisaríamos.
  //    Aquí iría tu scraping real y el POST al backend para guardar resultados.
  //    Como en tu backend solo existe /uscis/queue, por ahora solo navega y lee la página.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  for (const it of items) {
    const rn = it.receipt_number;
    console.log(`→ Revisando ${rn}…`);

    // Abre la página de USCIS de status por número de recibo
    // (No guardamos nada porque tu API aún no expone un endpoint de “guardar”.)
    try {
      await page.goto('https://egov.uscis.gov/casestatus/landing.do', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.fill('#receipt_number', rn);
      await Promise.all([
        page.click('button[type="submit"], #caseStatusSearchButton'),
        page.waitForLoadState('domcontentloaded'),
      ]);

      // Intenta leer los bloques principales
      const title = (await page.locator('#receipt_number+div h1, .rows.text-center h1, .appointment-sec h1').first().textContent().catch(() => '') || '').trim();
      const details = (await page.locator('.text-center p, .rows p, .appt-sec p').allTextContents().catch(() => [])).join('\n').trim();
      console.log(`   Título: ${title || '(no leído)'}`);
      console.log(`   Detalle (primeros 200): ${(details || '').slice(0, 200)}`);
    } catch (e) {
      console.error(`   Error navegando para ${rn}:`, e.message);
    }
  }

  await browser.close();
  console.log('Listo.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
