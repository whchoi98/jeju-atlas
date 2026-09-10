import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
).href);
const base = process.argv[2] || 'http://127.0.0.1:8124';
const output = resolve(process.argv[3] || '.local/browser-tours');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', serviceWorkers: 'block',
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [], errors = [], unexpectedMethods = [], points = [], geometryRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname === '/api/catalog/points') points.push(url.pathname);
  if (/\/data\/olle-\d+\.geojson$/.test(url.pathname)) geometryRequests.push(url.pathname);
});
// Exercise the production frontend and published geometry. Catalog/config are
// controlled read-only fixtures; no guide, AWS, or model endpoint is called.
await context.route('**/api/**', async route => {
  const request = route.request();
  if (request.method() !== 'GET') {
    unexpectedMethods.push(request.method());
    return route.abort();
  }
  const path = new URL(request.url()).pathname;
  let data;
  if (path === '/api/config') data = {
    version: 'tour-browser-fixture', features: { catalog: true, guide: false, planner: true, pwa: false },
    guide: { daily_limit: 30 },
  };
  else if (path === '/api/catalog/status') data = {
    status: 'ready', total: 0, by_source: {}, categories: [], stale: false,
    built_at: null, refreshed_at: null, attribution: 'Browser fixture', photos_count: 0, hours_week_count: 0,
  };
  else if (path === '/api/catalog/points') data = { type: 'FeatureCollection', features: [] };
  else if (path === '/api/catalog/search') data = { items: [], total: 0, has_more: false };
  else return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"fixture_not_found"}' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});
const pass = check => { checks.push(check); console.log(check); };
const source = id => page.evaluate(id => window.__JEJU_MAP__.getSource(id)?.serialize().data, id);
const painted = () => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));
const stopped = async () => {
  assert.equal(await page.locator('#tour-button').getAttribute('aria-pressed'), 'false');
  const point = await source('olle-tour-position');
  await page.waitForTimeout(180);
  assert.deepEqual(await source('olle-tour-position'), point);
};
const selectRoute = async id => {
  await page.locator('#tour-theme').selectOption(id);
  await page.waitForFunction(id =>
    window.__JEJU_MAP__?.getSource('olle-tour-route')?.serialize().data?.properties?.id === id
    && !document.querySelector('#tour-button').disabled, id);
};
let releaseDelayed;
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.isStyleLoaded()
    && !document.querySelector('#mode-3d')?.disabled
    && document.querySelector('#tour-theme option[value="olle-5232945"]'), null, { timeout: 90000 });
  assert.equal(await page.locator('#tour-theme').inputValue(), 'jeju-loop');
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  assert.equal(points.length, 0);
  assert.equal(geometryRequests.length, 0, 'Trail geometry loads only when selected');
  assert.equal(await page.locator('#tour-theme option[value="olle-missing-18-1"]').isDisabled(), true);
  pass('Jeju loop remains default; catalog points and trail geometry are not prefetched');

  await selectRoute('olle-5232945');
  const original = await (await context.request.get(new URL('/data/olle-5232945.geojson', base).href)).json();
  assert.deepEqual((await source('olle-tour-route')).geometry, original.geometry);
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayer('olle-tour-line').type), 'line');
  assert.ok(await page.evaluate(() => window.__JEJU_MAP__.getTerrain()));
  await page.locator('#tour-info summary').click();
  assert.match(await page.locator('#tour-info').innerText(), /표시 경로.*km/);
  assert.equal(await page.locator('#tour-info a').first().getAttribute('href'), original.properties.source_url);
  assert.match(await page.locator('#tour-info').innerText(), /OpenStreetMap.*ODbL/);
  assert.match(await page.locator('#tour-info').innerText(), /자료 조회: \d{4}-\d{2}-\d{2}/);
  await page.waitForFunction(() => !window.__JEJU_MAP__.isMoving());
  await page.screenshot({ path: resolve(output, 'desktop-route.png') });
  await page.locator('#tour-info summary').click();
  pass('Actual source geometry, mapped distance, source date, license and 3D trail layer are shown');

  await page.locator('#tour-button').click();
  await page.waitForFunction(() => document.querySelector('#tour-count')?.textContent !== '0%');
  assert.equal(await page.locator('#tour-button').getAttribute('aria-pressed'), 'true');
  const following = await page.evaluate(() => {
    const map = window.__JEJU_MAP__, point = map.getSource('olle-tour-position').serialize().data.geometry.coordinates;
    const center = map.getCenter();
    return { offset: Math.abs(center.lng - point[0]) + Math.abs(center.lat - point[1]), pitch: map.getPitch(), terrain: !!map.getTerrain() };
  });
  assert.ok(following.offset < 0.000001 && following.pitch > 40 && following.terrain);
  await page.keyboard.press('Escape');
  await stopped();
  pass('Camera follows the real trail in 3D, and Escape stops playback');

  await selectRoute('olle-3793206');
  const split = await (await context.request.get(new URL('/data/olle-3793206.geojson', base).href)).json();
  assert.ok(split.geometry.coordinates.length > 1);
  assert.deepEqual((await source('olle-tour-route')).geometry.coordinates, split.geometry.coordinates);
  await page.locator('#tour-button').click();
  await page.locator('#zoom-in').click();
  await stopped();
  assert.ok((await source('olle-tour-route')).geometry.coordinates.length > 1);
  pass('Separate source sections remain separate; manual map controls cancel the tour');

  let capturedResolve, settledResolve;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const settled = new Promise(resolve => { settledResolve = resolve; });
  const delayed = new Promise(resolve => { releaseDelayed = resolve; });
  await page.route('**/data/olle-6089470.geojson', async route => {
    const response = await route.fetch();
    capturedResolve();
    await delayed;
    try { await route.fulfill({ response }); }
    catch { /* Expected when a pending route selection is cancelled. */ }
    finally { settledResolve(); }
  });
  await page.locator('#tour-theme').selectOption('olle-6089470');
  await Promise.race([captured, new Promise((_, reject) => setTimeout(() => reject(new Error('No delayed trail request')), 5000))]);
  await page.locator('#tour-theme').selectOption('jeju-loop');
  releaseDelayed();
  await settled;
  await painted();
  assert.equal(await page.locator('#tour-theme').inputValue(), 'jeju-loop');
  assert.deepEqual((await source('olle-tour-route')).features, []);
  await stopped();
  pass('A late route download cannot overwrite a newer theme selection');

  let firstFailure = true;
  await page.route('**/data/olle-3793143.geojson', route => {
    if (firstFailure) {
      firstFailure = false;
      return route.fulfill({ status: 503, body: 'controlled unavailable source' });
    }
    return route.continue();
  });
  await page.locator('#tour-theme').selectOption('olle-3793143');
  await page.locator('#tour-retry').waitFor();
  assert.match(await page.locator('#tour-info').innerText(), /불러오지 못/);
  await page.locator('#tour-retry').click();
  await page.waitForFunction(() => window.__JEJU_MAP__.getSource('olle-tour-route').serialize().data.properties?.id === 'olle-3793143');
  pass('A failed geometry download is visible and can be retried');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#language-toggle').click();
  assert.equal(await page.locator('#tour-theme').inputValue(), 'olle-3793143');
  assert.match(await page.locator('#tour-info').innerText(), /Olle Route 7|Mapped length/);
  assert.match(await page.locator('#tour-theme option:checked').innerText(), /Olle Route 7/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const selectBox = await page.locator('#tour-theme').boundingBox();
  const buttonBox = await page.locator('#tour-button').boundingBox();
  assert.ok(selectBox.width >= 120 && selectBox.x + selectBox.width <= buttonBox.x + 1);
  assert.ok(buttonBox.x + buttonBox.width <= 390);
  await page.locator('#tour-info summary').click();
  await page.screenshot({ path: resolve(output, 'mobile-route-en.png') });
  pass('English labels, source details and theme controls fit a mobile viewport');

  await page.locator('#tour-theme').selectOption('jeju-loop');
  await page.locator('#tour-button').click();
  assert.equal(await page.locator('#tour-button').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#tour-stops > span').count(), 5);
  await page.keyboard.press('Escape');
  await stopped();
  assert.equal(points.length, 0);
  assert.deepEqual(unexpectedMethods, []);
  assert.deepEqual(errors, []);
  pass('The original five-landmark loop still works without enabling or fetching all POIs');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    passed: true, checks, errors, pointRequests: points.length, unexpectedMethods,
    mode: 'Real application and bundled OSM geometry; catalog/config fixtures; public basemap and terrain tiles',
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, failure: error.stack }, null, 2));
  throw error;
} finally {
  releaseDelayed?.();
  await browser.close();
}
