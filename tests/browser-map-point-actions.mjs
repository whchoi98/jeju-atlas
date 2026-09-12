/** Real pointer gestures on the built map; no model, Kakao or routing provider calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';

const output = resolve(process.argv[2] || '.local/kakao-map-experience-20260912/touch');
await mkdir(output, { recursive: true });
const requests = [], errors = [];
const server = createAppServer({ root: resolve('dist'), api: async (req, res, url) => {
  requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
  const data = url.pathname === '/api/config'
    ? { version: 'map-point-fixture', features: { catalog: true, guide: false, planner: true, pwa: false, routing: false },
      guide: { daily_limit: null, limits_enabled: false }, routing: { enabled: false }, discovery: { enabled: false } }
    : url.pathname === '/api/catalog/status'
      ? { status: 'ready', total: 0, categories: [], by_source: {}, stale: false, built_at: new Date().toISOString(), photos_count: 0, hours_week_count: 0 }
      : url.pathname === '/api/catalog/search' ? { items: [], total: 0, has_more: false }
        : url.pathname === '/api/catalog/points' ? { type: 'FeatureCollection', features: [] } : null;
  res.writeHead(data ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data || { error: { code: 'fixture_unavailable' } }));
} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const report = { passed: false, checks: [], errors };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('catalog-preview'), null, { timeout: 90000 });
  await page.locator('#mode-2d').click();
  await page.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.5, 33.4], zoom: 12, pitch: 0, bearing: 0 }));
  await page.evaluate(() => {
    window.__pointEvents = [];
    for (const type of ['focusout', 'pointerup', 'mousedown', 'click']) document.addEventListener(type, event => {
      window.__pointEvents.push({ type, target: event.target?.id || event.target?.tagName,
        related: event.relatedTarget?.id || event.relatedTarget?.tagName,
        hidden: document.querySelector('#map-point-menu').hidden });
    }, true);
    for (const type of ['movestart', 'moveend']) window.__JEJU_MAP__.on(type, () => {
      window.__pointEvents.push({ type, hidden: document.querySelector('#map-point-menu').hidden });
    });
  });
  const rect = await page.locator('#map canvas').first().boundingBox();
  const x = rect.x + rect.width * .45, y = rect.y + rect.height * .42;
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [{ id: 1, x, y }]);
  await page.waitForTimeout(750);
  assert.equal(await page.locator('#map-point-menu').isVisible(), true, 'A stationary long press must open point actions');
  await touch('touchEnd', []);
  await page.waitForTimeout(60);
  assert.equal(await page.locator('#map-point-menu').isVisible(), true, JSON.stringify(await page.evaluate(() => window.__pointEvents)));
  await page.locator('[data-map-point-action="nearby"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-scope="nearby"]')?.getAttribute('aria-pressed') === 'true');
  const nearby = requests.filter(request => request.path === '/api/catalog/search' && request.query.radius_m).at(-1);
  assert.ok(nearby);
  assert.ok(Number(nearby.query.lat) > 33.1 && Number(nearby.query.lat) < 33.6);
  assert.equal(await page.locator('#map-point-menu').isVisible(), false);
  report.checks.push('A stationary touch hold opens actions and nearby search uses the actual selected Jeju point');
  await page.locator('#drawer-toggle').tap();

  const before = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
  await touch('touchStart', [{ id: 1, x, y }]);
  for (let step = 1; step <= 12; step++) {
    await touch('touchMove', [{ id: 1, x: x + 70 * step / 12, y: y + 15 * step / 12 }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  const after = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
  assert.notDeepEqual(after, before);
  assert.equal(await page.locator('#map-point-menu').isVisible(), false);
  report.checks.push('A moving finger pans the map instead of opening the long-press menu');

  const zoom = await page.evaluate(() => window.__JEJU_MAP__.getZoom());
  await touch('touchStart', [{ id: 1, x: x - 45, y }]);
  await page.waitForTimeout(100);
  await touch('touchStart', [{ id: 1, x: x - 45, y }, { id: 2, x: x + 45, y }]);
  for (let step = 1; step <= 12; step++) {
    await touch('touchMove', [{ id: 1, x: x - 45 - step * 4, y }, { id: 2, x: x + 45 + step * 4, y }]);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', []);
  assert.notEqual(await page.evaluate(() => window.__JEJU_MAP__.getZoom()), zoom);
  assert.equal(await page.locator('#map-point-menu').isVisible(), false);
  report.checks.push('A second finger cancels pending long press and preserves pinch zoom');
  await page.screenshot({ path: resolve(output, 'mobile-map-actions.png') });
  assert.equal(requests.filter(request => request.path === '/api/guide').length, 0);
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
