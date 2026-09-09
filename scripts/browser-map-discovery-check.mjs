import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

// Regression: initial catalog prefetch/rendering, filters that affect only the
// list, and representative markers disconnected from real catalog details.
const base = process.argv[2] || 'http://127.0.0.1:8098';
const output = resolve(process.argv[3] || '/tmp/jeju-map-discovery');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', locale: 'ko-KR',
  serviceWorkers: 'block',
});
const page = await context.newPage();
const checks = [];
const errors = [];
const pointRequests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (new URL(request.url()).pathname === '/api/catalog/points') pointRequests.push(request.url());
});
const sourceData = (id) => page.evaluate((id) => window.__JEJU_MAP__.getSource(id).serialize().data, id);
const ready = () => page.waitForFunction(() =>
  window.__JEJU_MAP__?.isStyleLoaded() && !window.__JEJU_MAP__.isMoving()
  && !document.querySelector('#mode-3d')?.disabled, null, { timeout: 90000 });
const pass = (check) => { checks.push(check); console.log(check); };

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ready();
  await page.waitForFunction(() => document.querySelector('#catalog-total')?.textContent.includes('6,724'));
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false, 'Catalog must start hidden');
  assert.equal(pointRequests.length, 0, 'Initial view must not prefetch the full catalog');
  assert.equal((await sourceData('catalog-points')).features.length, 0);
  assert.equal(await page.locator('.place-marker').count(), 12);
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayoutProperty('catalog-dots', 'visibility')), 'none');
  await page.screenshot({ path: resolve(output, 'initial-representatives.png'), fullPage: true });
  pass('Initial map has only representative landmarks and makes no points request');

  await page.locator('[data-map-category="해변"]').click();
  await page.waitForFunction(() => {
    const data = window.__JEJU_MAP__.getSource('catalog-points').serialize().data;
    return data.features.length > 0 && data.features.every((feature) => feature.properties.category === '해변');
  });
  assert.equal(await page.locator('#catalog-category').inputValue(), '해변');
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), true);
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayer('catalog-dots').type), 'symbol');
  assert.ok((await sourceData('catalog-points')).features.every((feature) => feature.properties.category_icon === 'coast'));
  pass('Category chip enables only matching places with wave pictograms');

  await page.locator('#catalog-reset').click();
  await ready();
  await page.locator('.place-marker[data-landmark-id="hyeopjae"]').click();
  await page.waitForSelector('#detail-add-trip');
  assert.match(await page.locator('#catalog-detail').innerText(), /협재해수욕장/);
  assert.match(await page.locator('.detail-base-note').innerText(), /대조 검증되지/);
  assert.ok((await sourceData('catalog-selection')).features.some((feature) => feature.properties.id === 'poi_0057'));
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  await page.locator('[data-detail-action="close"]').click();
  await page.screenshot({ path: resolve(output, 'representative-detail-link.png'), fullPage: true });
  pass('Hyeopjae representative opens the verified catalog ID with its original provenance');

  await page.locator('#catalog-search').fill('오설록');
  await page.waitForFunction(() => {
    const list = [...document.querySelectorAll('#catalog-list [data-catalog-id]')].map((item) => item.dataset.catalogId).sort();
    const map = window.__JEJU_MAP__.getSource('catalog-points').serialize().data.features.map((item) => item.properties.id).sort();
    return list.includes('poi_0011') && list.length === map.length && list.join('|') === map.join('|');
  });
  const queryData = await sourceData('catalog-points');
  assert.ok(queryData.features.length <= 40);
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), true);
  await page.locator('#catalog-list [data-catalog-id="poi_0011"]').click();
  await page.waitForSelector('#detail-add-trip');
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#catalog-map-toggle').uncheck();
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayoutProperty('catalog-dots', 'visibility')), 'none');
  assert.ok((await sourceData('catalog-selection')).features.some((feature) => feature.properties.id === 'poi_0011'));
  pass('Search matches map and list; selected place stays visible when catalog is hidden');

  await page.locator('#catalog-reset').click();
  assert.equal(await page.locator('#catalog-search').inputValue(), '');
  assert.equal(await page.locator('#catalog-category').inputValue(), '');
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  assert.equal((await sourceData('catalog-points')).features.length, 0);
  pass('Reset restores the quiet representative overview');

  await page.locator('[data-scope="view"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#catalog-list [data-catalog-id]').length > 0);
  await page.locator('#catalog-map-toggle').uncheck();
  await page.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.925, 33.46], zoom: 14, pitch: 0 }));
  const expectedViewIds = await page.evaluate(async () => {
    const bounds = window.__JEJU_MAP__.getBounds();
    const bbox = [Math.max(126.15, bounds.getWest()), Math.max(33.1, bounds.getSouth()),
      Math.min(126.98, bounds.getEast()), Math.min(33.6, bounds.getNorth())].map((n) => n.toFixed(6)).join(',');
    const data = await (await fetch(`/api/catalog/points?${new URLSearchParams({ bbox })}`)).json();
    return data.features.slice(0, 40).map((feature) => feature.properties.id);
  });
  assert.ok(expectedViewIds.length > 0);
  await page.waitForFunction((expected) => {
    const ids = [...document.querySelectorAll('#catalog-list [data-catalog-id]')].map((item) => item.dataset.catalogId);
    return ids.join('|') === expected.join('|');
  }, expectedViewIds, { timeout: 5000 });
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayoutProperty('catalog-dots', 'visibility')), 'none');
  pass('Current-view list follows map movement while its place icons stay hidden');
  await page.locator('#catalog-reset').click();
  await ready();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#drawer-toggle').click();
  await page.locator('[data-map-category="카페"]').click();
  await page.waitForFunction(() => {
    const features = window.__JEJU_MAP__.getSource('catalog-points').serialize().data.features;
    return features.length > 0 && features.every((feature) => feature.properties.category === '카페');
  });
  assert.equal(await page.locator('#catalog-category').inputValue(), '카페');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'mobile-category.png'), fullPage: true });
  await page.locator('#catalog-search').fill('오설록');
  await page.locator('#catalog-category').selectOption('');
  await page.waitForSelector('#catalog-list [data-catalog-id="poi_0011"]');
  await page.locator('#catalog-list [data-catalog-id="poi_0011"]').click();
  await page.waitForSelector('#detail-add-trip');
  assert.equal(await page.locator('#drawer-toggle').getAttribute('aria-expanded'), 'false');
  assert.ok((await sourceData('catalog-selection')).features.some((feature) => feature.properties.id === 'poi_0011'));
  pass('Mobile category filters, search and selected marker remain usable');

  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, checks, pointRequests, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, pointRequests, errors, failure: error.stack }, null, 2));
  throw error;
} finally {
  await browser.close();
}
