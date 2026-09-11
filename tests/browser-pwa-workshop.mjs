/**
 * Real browser check of the two PWA scopes. Uses a local static/API fixture by
 * default; --url verifies a deployed site without invoking AI or changing AWS.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAppServer } from '../server/server.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' } } });
const output = resolve(values.output || '.local/pwa-workshop-browser');
await mkdir(output, { recursive: true });
const checks = [];
const errors = [];
const report = { passed: false, checks, errors, fixtureOnly: !values.url };
let server;
let browser;
let base = values.url?.replace(/\/$/, '');
try {
  if (!base) {
    server = createAppServer({
      root: resolve('dist'), release: 'pwa-workshop-fixture',
      api: async (_req, res, url) => {
        res.writeHead(url.pathname === '/api/config' ? 200 : 503, {
          'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(url.pathname === '/api/config' ? {
          version: 'pwa-workshop-fixture',
          features: { pwa: true, planner: true, catalog: false, guide: false, routing: false },
          guide: { daily_limit: 30 }, routing: { enabled: false, modes: ['walk', 'car'] },
        } : { error: { code: 'unavailable', message: 'Local PWA fixture' } }));
      },
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
    || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE
      || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  if (!values.url) {
    await context.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort());
  }
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const reader = await context.newPage();
  assert.equal((await reader.goto(`${base}/workshop/`, { waitUntil: 'networkidle' })).status(), 200);
  await reader.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/workshop/sw.js'), null, { timeout: 30000 });
  const manifest = await reader.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    return { url: link.href, body: await (await fetch(link.href)).json() };
  });
  for (const field of ['scope', 'start_url']) {
    assert.equal(new URL(manifest.body[field], manifest.url).href, `${base}/workshop/`, field);
  }
  const readerProtocol = await context.newCDPSession(reader);
  const readerManifest = await readerProtocol.send('Page.getAppManifest');
  assert.equal(readerManifest.manifest.id, `${base}/workshop/`, 'The processed PWA identity must not collide with the map at /');
  report.workshopAppId = readerManifest.manifest.id;
  assert.equal(manifest.body.display, 'standalone');
  assert.equal(manifest.body.theme_color, '#232f3e');
  assert.equal(await reader.locator('[data-handbook-download]').isVisible(), true);
  assert.equal(await reader.locator('[data-handbook-download]').getAttribute('href'),
    `${base}/workshop/downloads/jeju-atlas-workshop-handbook.zip`);
  for (const icon of manifest.body.icons) {
    const dimensions = await reader.evaluate(async source => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }, new URL(icon.src, manifest.url).href);
    assert.equal(dimensions, icon.sizes);
  }
  checks.push('Workshop installs under its own manifest identity, scope, valid icons and active worker');
  await reader.screenshot({ path: resolve(output, 'workshop-desktop.png'), fullPage: true });

  const app = await context.newPage();
  assert.equal((await app.goto(`${base}/`, { waitUntil: 'domcontentloaded' })).status(), 200);
  await app.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js')
    && !navigator.serviceWorker.controller?.scriptURL.includes('/workshop/'), null, { timeout: 30000 });
  await app.locator('#about-button').click();
  assert.equal(await app.locator('#about-dialog a[href="/workshop/"]').getAttribute('target'), '_blank');
  await app.locator('#about-close').click();
  await app.locator('#language-toggle').click();
  await app.locator('#about-button').click();
  assert.match(await app.locator('#about-dialog a[href="/workshop/"]').innerText(), /Open deployment workshop/);
  await app.locator('#about-close').click();
  await app.locator('#language-toggle').click();
  assert.equal(await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-navy').trim()), '#232f3e');
  assert.equal(await reader.evaluate(() => navigator.serviceWorker.controller.scriptURL), `${base}/workshop/sw.js`);
  const appProtocol = await context.newCDPSession(app);
  const appManifest = await appProtocol.send('Page.getAppManifest');
  assert.equal(appManifest.manifest.id, `${base}/`);
  assert.notEqual(appManifest.manifest.id, readerManifest.manifest.id);
  report.mapAppId = appManifest.manifest.id;
  const cacheReport = await app.evaluate(async () => {
    const names = await caches.keys();
    return Promise.all(names.map(async name => ({
      name, paths: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname),
    })));
  });
  const shell = cacheReport.find(cache => cache.name.startsWith('jeju-atlas-shell-'));
  const book = cacheReport.find(cache => cache.name.startsWith('jeju-atlas-workshop-'));
  assert.ok(shell && book);
  assert.ok(shell.paths.every(path => !path.startsWith('/workshop/')));
  assert.ok(book.paths.every(path => path.startsWith('/workshop/') && !path.includes('/downloads/')));
  const chapters = book.paths.filter(path => path.includes('/chapters/') && path.endsWith('.html'));
  const references = book.paths.filter(path => path.includes('/reference/') && path.endsWith('.html'));
  assert.equal(chapters.length, 14);
  assert.equal(references.length, 6);
  assert.ok(cacheReport.every(cache => cache.paths.every(path => !path.startsWith('/api/'))));
  report.caches = cacheReport;
  checks.push('Map and workshop coexist without sharing cached HTML, API data or ZIP downloads');
  await app.screenshot({ path: resolve(output, 'app-desktop.png') });

  const zipUrl = `${base}/workshop/downloads/jeju-atlas-workshop-handbook.zip`;
  const zipResponse = await context.request.get(zipUrl);
  assert.equal(zipResponse.status(), 200);
  assert.equal(zipResponse.headers()['content-type'], 'application/zip');
  assert.equal(zipResponse.headers()['content-disposition'], 'attachment; filename="jeju-atlas-workshop-handbook.zip"');
  const digest = createHash('sha256').update(await zipResponse.body()).digest('hex');
  const digestResponse = await context.request.get(`${zipUrl}.sha256`);
  assert.match(await digestResponse.text(), new RegExp(`^${digest}  jeju-atlas-workshop-handbook\\.zip`));
  report.handbookSha256 = digest;
  checks.push('The public PC ZIP downloads as an attachment and matches its SHA-256');

  await reader.goto(base + chapters[0]);
  await reader.locator('[data-progress-toggle]').click();
  assert.match(await reader.locator('[data-chapter-state]').innerText(), /^읽음$/);
  await context.setOffline(true);
  // Current Chromium separates request-level disconnection from navigator
  // state. Exercise both, as a real device losing its connection would.
  const networkState = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await Promise.all([readerProtocol, appProtocol].map(protocol => protocol.send('Network.overrideNetworkState', networkState)));
  assert.equal(await app.evaluate(async () => {
    try { await fetch('/api/config?offline-verification=1'); return false; } catch { return true; }
  }), true, 'An uncached API request must fail while the cached reader still works');
  for (const path of [chapters[1], references[0], chapters[0]]) {
    assert.equal((await reader.goto(base + path)).status(), 200, path);
    assert.equal(await reader.locator('main h1').count(), 1);
    assert.equal(await reader.locator('body').getAttribute('data-page-kind'), path.includes('/chapters/') ? 'chapters' : 'reference');
  }
  assert.match(await reader.locator('[data-chapter-state]').innerText(), /^읽음$/);
  report.offlineReader = await reader.evaluate(() => ({
    online: navigator.onLine, downloadHidden: document.querySelector('[data-handbook-download]').hidden,
    status: document.querySelector('[data-pwa-status]').textContent,
    controller: navigator.serviceWorker.controller?.scriptURL,
  }));
  assert.equal(await reader.locator('[data-handbook-download]').isVisible(), false);
  await app.reload({ waitUntil: 'domcontentloaded' });
  await app.locator('#offline-notice').waitFor({ state: 'visible' });
  assert.match(await app.locator('#connection-status').innerText(), /오프라인/);
  checks.push('Offline chapter and reference navigation, reading progress and the map app shell survive reload');
  await reader.setViewportSize({ width: 390, height: 844 });
  assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await reader.screenshot({ path: resolve(output, 'workshop-offline-mobile.png'), fullPage: true });
  checks.push('The offline reader fits the mobile viewport');
  await context.setOffline(false);
  await Promise.all([readerProtocol, appProtocol].map(protocol =>
    protocol.send('Network.overrideNetworkState', { ...networkState, offline: false })));
  assert.deepEqual(errors, []);
  report.passed = true;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
