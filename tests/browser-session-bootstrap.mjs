/** Two simultaneous visible windows with an empty cookie jar and disabled HTTP cache. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { createPresenceService, createMemoryPresenceStore } from '../server/presence.mjs';

const output = resolve(process.argv[2] || '.local/ai-presence-20260912/bootstrap-browser');
await mkdir(output, { recursive: true });
const store = createMemoryPresenceStore();
const presence = createPresenceService({ store, cacheMs: 0 });
const api = createApiHandler({
  secret: 'cold-bootstrap-fixture-with-32-characters',
  publicOrigin: 'https://atlas.example.test', env: { NODE_ENV: 'test' }, presence,
  catalog: {
    status: () => ({ status: 'ready', total: 0, categories: [], by_source: {}, stale: false,
      built_at: new Date().toISOString(), photos_count: 0, hours_week_count: 0 }),
    async refreshIfNeeded() {}, search: () => ({ items: [], total: 0, has_more: false }),
    points: () => ({ type: 'FeatureCollection', features: [] }), detail: () => null,
  },
});
const report = { passed: false, emptyCookieConfigRequests: 0, successfulHeartbeats: 0, errors: [] };
let secondArrived, firstRegistered;
const overlap = new Promise(resolve => { secondArrived = resolve; });
const firstHeartbeat = new Promise(resolve => { firstRegistered = resolve; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createAppServer({
  root: resolve('dist'),
  api: async (req, res, url) => {
    if (url.pathname === '/api/config' && !req.headers.cookie) {
      report.emptyCookieConfigRequests++;
      if (report.emptyCookieConfigRequests === 1) await Promise.race([overlap, delay(300)]);
      else {
        secondArrived();
        // Expose the cookie race: one window registers before the second
        // cookie-less config response arrives and replaces the shared cookie.
        await Promise.race([firstHeartbeat, delay(1000)]);
      }
    }
    if (url.pathname === '/api/presence/heartbeat') res.once('finish', () => {
      if (res.statusCode === 200) { report.successfulHeartbeats++; firstRegistered(); }
    });
    return api(req, res, url);
  },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    // Model two foreground browser windows sharing one profile, not a suspended tab.
    Object.defineProperty(document, 'hidden', { get: () => false });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  });
  const pages = await Promise.all([0, 1].map(async () => {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#visitor-presence')?.dataset.presenceState === 'live');
    return page;
  }));
  assert.ok(report.successfulHeartbeats >= 2, 'Both windows must complete real heartbeats');
  report.counts = await presence.snapshot();
  assert.equal(report.emptyCookieConfigRequests, 1, 'Only one initial cookie-less config fetch may mint the shared session');
  assert.equal(report.counts.active_visitors, 1);
  assert.equal(report.counts.total_visitors, 1);
  await pages[0].reload({ waitUntil: 'domcontentloaded' });
  await pages[0].waitForFunction(() => document.querySelector('#visitor-presence')?.dataset.presenceState === 'live');
  assert.equal((await presence.snapshot()).total_visitors, 1);
  const unsupported = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  await unsupported.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { get: () => undefined });
  });
  const legacy = await unsupported.newPage();
  await legacy.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await legacy.waitForFunction(() => document.querySelector('#visitor-presence')?.dataset.presenceState === 'unavailable');
  assert.equal((await presence.snapshot()).total_visitors, 1, 'An uncoordinated transport must not register a misleading visitor');
  assert.equal(await legacy.locator('#tab-explore').isVisible(), true);
  await unsupported.close();
  report.unsupportedTransport = 'count unavailable; ordinary app configuration remains usable';
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  api.close();
  presence.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.checkedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
