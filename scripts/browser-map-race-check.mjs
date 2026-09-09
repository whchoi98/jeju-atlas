import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
).href);
const base = process.argv[2] || 'http://127.0.0.1:8100';
const output = resolve('.local', process.argv[3] || 'map-race');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage();
let capturedResolve;
const captured = new Promise((resolve) => { capturedResolve = resolve; });
let release;
const delayed = new Promise((resolve) => { release = resolve; });
let settledResolve;
const settled = new Promise((resolve) => { settledResolve = resolve; });
let interrupted = false;
let heldRequest;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.getLayer('catalog-dots'), null, { timeout: 90000 });
  await page.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.528, 33.499], zoom: 11, pitch: 0 }));
  page.on('requestfailed', (request) => {
    if (request === heldRequest) interrupted = true;
  });
  await page.route('**/api/catalog/points?*', async (route) => {
    if (heldRequest) return route.continue();
    heldRequest = route.request();
    const upstream = await route.fetch();
    capturedResolve();
    await delayed;
    try { await route.fulfill({ response: upstream }); }
    catch { /* A correctly cancelled viewport request cannot be fulfilled. */ }
    finally { settledResolve(); }
  });
  await page.locator('[data-scope="view"]').click();
  await Promise.race([captured, new Promise((_, reject) => setTimeout(() => reject(new Error('No viewport request captured')), 5000))]);
  await page.locator('[data-scope="nearby"]').click();
  await page.waitForFunction(() => {
    const ids = [...document.querySelectorAll('#catalog-list [data-catalog-id]')].map((item) => item.dataset.catalogId).sort();
    const pins = window.__JEJU_MAP__.getSource('catalog-points').serialize().data.features.map((item) => item.properties.id).sort();
    return ids.length > 0 && ids.join('|') === pins.join('|');
  }, null, { timeout: 10000 });
  const expected = await page.locator('#catalog-list [data-catalog-id]').evaluateAll((items) => items.map((item) => item.dataset.catalogId).sort());
  release();
  await settled;
  // Flush browser delivery and rendering after the held response has settled.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const actual = await page.evaluate(() => window.__JEJU_MAP__.getSource('catalog-points').serialize().data.features.map((item) => item.properties.id).sort());
  assert.equal(interrupted, true, 'Switching scopes must cancel the superseded viewport request');
  assert.deepEqual(actual, expected, 'A late viewport response must not replace nearby pins');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, interrupted, nearbyCount: expected.length }, null, 2));
  console.log(JSON.stringify({ passed: true, check: 'Delayed viewport response cannot overwrite a later nearby search', nearbyCount: expected.length }));
} catch (error) {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, interrupted, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  release?.();
  await browser.close();
}
