/* scripts/uscis_check.cjs */
/* Versión del scraper con manejo de errores mejorado y logging. */
#!/usr/bin/env node
const { chromium } = require('playwright-chromium');

// --- HELPERS ---
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeBase = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/\/api\/uscis\/?$/, '');

// --- CONFIGURATION ---
const API_BASE_URL = normalizeBase(process.env.API_BASE);
const API_TOKEN = process.env.API_TOKEN;
const USCIS_LANDING_URL = 'https://egov.uscis.gov/casestatus/landing.do';
const USCIS_LEGACY_URL = 'https://egov.uscis.gov/casestatus/mycasestatus.do';

if (!API_BASE_URL || !API_TOKEN) {
    log('FATAL: API_BASE and API_TOKEN environment variables are required.');
    process.exit(1);
}

/**
 * Detecta si la página es un interstitial de Cloudflare.
 * @param {import('playwright-chromium').Page} page
 * @returns {Promise<boolean>}
 */
async function isCloudflareBlocked(page) {
    try {
        const title = await page.title();
        if (/just a moment/i.test(title) || /attention required/i.test(title)) {
            return true;
        }
        const cfLocator = page.locator('#cf-wrapper, #cf-error-details');
        return await cfLocator.first().isVisible({ timeout: 1000 });
    } catch {
        return false;
    }
}

/**
 * Intenta "calentar" la página para pasar el control de Cloudflare.
 * @param {import('playwright-chromium').Page} page
 * @returns {Promise<boolean>} - True si se pasó el bloqueo, false si persiste.
 */
async function warmUpPage(page) {
    for (let i = 0; i < 3; i++) {
        if (!(await isCloudflareBlocked(page))) return true;
        log(`Cloudflare detected. Waiting and reloading... (Attempt ${i + 1})`);
        await sleep(4000 + Math.random() * 2000);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    return !(await isCloudflareBlocked(page));
}

/**
 * Lógica principal de scraping para una URL y un número de recibo.
 * @param {import('playwright-chromium').BrowserContext} context
 * @param {string} url
 * @param {string} receiptNumber
 * @returns {Promise<{html: string|null, error: string|null, fullPageHtml: string|null}>}
 */
async function scrapeReceiptOnUrl(context, url, receiptNumber) {
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        if (!(await warmUpPage(page))) {
            return { html: null, error: 'cloudflare_block', fullPageHtml: await page.content() };
        }

        const inputSelector = 'input[name="appReceiptNum"]';
        const input = page.locator(inputSelector);
        await input.waitFor({ state: 'visible', timeout: 15000 });

        await input.fill(receiptNumber);
        await page.locator('input[type="submit"]').click();

        await page.waitForLoadState('domcontentloaded', { timeout: 30000 });

        const statusDiv = page.locator('.rows.text-center');
        await statusDiv.waitFor({ state: 'visible', timeout: 20000 });
        
        const resultHtml = await statusDiv.innerHTML();
        return { html: resultHtml, error: null, fullPageHtml: null };

    } catch (e) {
        log(`Scraping failed for ${receiptNumber} on ${url}: ${e.message}`);
        const fullHtml = await page.content().catch(() => 'Could not get page content.');
        // Identifica el tipo de error para un mejor reporte.
        const errorType = e.message.includes('Timeout') ? 'element_timeout' : 'generic_error';
        return { html: null, error: errorType, fullPageHtml: fullHtml };
    } finally {
        await page.close();
    }
}

/**
 * Reporta los resultados (éxitos o fallos) a la API de Laravel.
 * @param {string} endpoint
 * @param {object[]} items
 */
async function reportToApi(endpoint, items) {
    if (items.length === 0) return;
    const url = `${API_BASE_URL}/api/uscis/${endpoint}`;
    log(`Reporting ${items.length} items to ${endpoint}...`);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_TOKEN}`,
                'Accept': 'application/json',
            },
            body: JSON.stringify({ items }),
        });
        if (!response.ok) {
            log(`API Error: Failed to report to ${endpoint}. Status: ${response.status}`, await response.text());
        }
    } catch (e) {
        log(`Network Error: Could not report to ${endpoint}: ${e.message}`);
    }
}

// --- MAIN EXECUTION ---
(async () => {
    log('--- Starting USCIS Scraping Cycle ---');
    let queue = [];
    try {
        const response = await fetch(`${API_BASE_URL}/api/uscis/queue`, {
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        });
        if (!response.ok) throw new Error(`API returned status ${response.status}`);
        const data = await response.json();
        queue = data.queue || [];
        log(`Fetched ${queue.length} cases to process.`);
    } catch (e) {
        log(`FATAL: Could not fetch queue from API: ${e.message}`);
        process.exit(1);
    }

    if (queue.length === 0) {
        log('Queue is empty. Exiting.');
        return;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
    });

    const successfulScrapes = [];
    const failedScrapes = [];

    for (const item of queue) {
        const { tramite_id, receipt_number } = item;
        log(`Processing: ${receipt_number}`);

        let result = await scrapeReceiptOnUrl(context, USCIS_LANDING_URL, receipt_number);
        // Si falla en la URL principal, intenta con la URL legacy como fallback.
        if (result.error) {
            log(`Primary URL failed for ${receipt_number}. Trying legacy URL...`);
            await sleep(2000); // Pausa antes del reintento
            result = await scrapeReceiptOnUrl(context, USCIS_LEGACY_URL, receipt_number);
        }

        if (result.html) {
            log(`SUCCESS for ${receipt_number}`);
            successfulScrapes.push({ tramite_id, html: result.html });
        } else {
            log(`FAILURE for ${receipt_number}. Error: ${result.error}`);
            failedScrapes.push({
                receipt_number,
                error: result.error,
                // **MEJORA**: Enviamos el HTML de la página fallida para diagnóstico.
                meta: { failed_html: result.fullPageHtml }
            });
        }
        await sleep(1500 + Math.random() * 1500); // Jitter entre peticiones
    }

    await reportToApi('report', successfulScrapes);
    await reportToApi('report-failed', failedScrapes);

    await browser.close();
    log('--- Scraping Cycle Finished ---');
})();
