/** Built UI and real map gestures; AI text is a controlled fixture, never a model call. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' } } });
const output = resolve(values.output || '.local/ui-layout-drag-20260911/browser');
await mkdir(output, { recursive: true });
const report = { passed: false, checks: [], errors: [], controlledGuideResponse: true, modelCalls: 0 };
let server;
let browser;
let base = values.url?.replace(/\/$/, '');
const routeSource = { provider: 'valhalla', data: 'OpenStreetMap', attribution: 'UI fixture',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: null };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const answer = '# 읽기 폭 검사\n\n' + Array.from({ length: 5 }, (_, index) =>
  `## ${index + 1}. 방문 전 확인할 항목\n\n긴 한국어 답변과 **강조된 문장**이 화면 안에서 읽히는지 확인하는 시험 문장입니다. `
  + '실제 장소의 이용시간이나 편의시설을 안내하는 답변이 아닙니다.\n\n- 제공된 출처 확인\n- 조회 시각 확인\n').join('\n');
const check = async (name, fn) => {
  try { report.checks.push({ name, passed: true, detail: await fn() }); }
  catch (error) { report.checks.push({ name, passed: false, failure: error.message }); }
};

try {
  if (!base) {
    server = createAppServer({ root: resolve('dist'), api: async (_req, res, url) => {
      let data;
      if (url.pathname === '/api/config') data = {
        version: 'layout-gesture-fixture', features: { catalog: true, guide: true, planner: true, pwa: false, routing: true },
        guide: { daily_limit: 30, csrf_token: 'fixture-proof' },
        routing: { enabled: true, modes: ['walk', 'car'], source: routeSource, csrf_token: 'fixture-proof' },
      };
      if (url.pathname === '/api/catalog/status') data = {
        status: 'ready', total: 0, by_source: {}, categories: [], built_at: null, refreshed_at: null,
        stale: false, attribution: 'UI fixture', photos_count: 0, hours_week_count: 0,
      };
      if (url.pathname === '/api/catalog/search') data = { items: [], total: 0, has_more: false };
      if (url.pathname === '/api/catalog/points') data = { type: 'FeatureCollection', features: [] };
      res.writeHead(data ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data || { error: { code: 'fixture_unavailable' } }));
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE
      || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route(`${base}/api/guide`, route => route.fulfill({
    contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-store' },
    body: frame('session', { conversation_id: 'layout-fixture' }) + frame('text', { delta: answer }) + frame('done', {}),
  }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.isStyleLoaded()
    && !document.querySelector('#mode-3d')?.disabled, null, { timeout: 90000 });
  const canvasReady = () => page.waitForFunction(() => {
    const map = window.__JEJU_MAP__;
    return Math.abs(map.getCanvas().getBoundingClientRect().width - map.getContainer().clientWidth) <= 1;
  });
  const normalWidth = await page.locator('.sidebar').evaluate(node => node.clientWidth);

  await check('Korean and English introduction fit on one visible line', async () => {
    const metrics = [];
    for (const locale of ['ko', 'en']) {
      if (locale === 'en') await page.locator('#language-toggle').click();
      metrics.push(await page.locator('.sidebar-intro h1').evaluate(node => ({
        locale: document.documentElement.lang, text: node.textContent,
        height: node.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
        width: node.clientWidth, scrollWidth: node.scrollWidth,
      })));
    }
    await page.locator('#language-toggle').click();
    for (const metric of metrics) {
      assert.ok(metric.height <= metric.lineHeight * 1.15, JSON.stringify(metric));
      assert.ok(metric.scrollWidth <= metric.width + 1, JSON.stringify(metric));
    }
    return metrics;
  });

  await page.locator('#tab-guide').click();
  await canvasReady();
  await check('AI tab gives answers more width without leaving a stale map canvas size', async () => {
    const sizes = await page.evaluate(() => ({
      sidebar: document.querySelector('.sidebar').clientWidth,
      messages: document.querySelector('#guide-messages').clientWidth,
      heading: document.querySelector('#guide-panel .panel-intro').getBoundingClientRect().height,
      map: window.__JEJU_MAP__.getContainer().clientWidth,
      canvas: window.__JEJU_MAP__.getCanvas().getBoundingClientRect().width,
    }));
    assert.ok(sizes.sidebar >= normalWidth * 1.25, JSON.stringify(sizes));
    assert.ok(sizes.messages >= 380, JSON.stringify(sizes));
    assert.ok(sizes.heading <= 60, JSON.stringify(sizes));
    assert.ok(Math.abs(sizes.canvas - sizes.map) <= 1, JSON.stringify(sizes));
    return sizes;
  });
  await check('Long AI answers scroll while the composer and suggestions remain usable', async () => {
    await page.locator('#guide-send').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
    await page.locator('#guide-input').fill('화면 읽기 검사용 문장을 보여 주세요.');
    await page.locator('#guide-send').click();
    await page.locator('.guide-markdown h1').waitFor();
    await page.waitForFunction(() => document.querySelector('#guide-thinking').hidden);
    const metrics = await page.locator('#guide-messages').evaluate(node => ({
      client: node.clientHeight, scroll: node.scrollHeight, width: node.clientWidth, scrollWidth: node.scrollWidth,
    }));
    assert.ok(metrics.client >= 280, JSON.stringify(metrics));
    assert.ok(metrics.scroll > metrics.client, JSON.stringify(metrics));
    assert.ok(metrics.scrollWidth <= metrics.width + 1, JSON.stringify(metrics));
    assert.ok(await page.locator('#guide-input').isVisible());
    assert.equal(await page.locator('#guide-followups button').count(), 3);
    await page.screenshot({ path: resolve(output, 'guide-desktop.png') });
    return metrics;
  });
  await check('Collapsing and restoring the sidebar preserves the AI tab, draft and answer', async () => {
    const answerBefore = await page.locator('#guide-messages').innerText();
    await page.locator('#guide-input').fill('사이드바 복원 검사');
    await page.locator('#sidebar-toggle').click();
    await canvasReady();
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#place-drawer').evaluate(node => node.inert), true);
    assert.ok(await page.evaluate(() => window.__JEJU_MAP__.getContainer().clientWidth >= innerWidth - 1));
    await page.locator('#sidebar-toggle').click();
    await canvasReady();
    assert.equal(await page.locator('#tab-guide').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#guide-input').inputValue(), '사이드바 복원 검사');
    assert.equal(await page.locator('#guide-messages').innerText(), answerBefore);
    await page.locator('#guide-input').fill('');
    await page.locator('#sidebar-toggle').click();
    await page.keyboard.press('/');
    await canvasReady();
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#place-drawer').evaluate(node => node.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'catalog-search');
  });

  await page.locator('#tab-trip').click();
  await check('Walking and driving cards are compact and remain selectable', async () => {
    const cards = await page.locator('.route-mode').evaluateAll(nodes => nodes.map(node => ({
      width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      overflow: node.scrollWidth > node.clientWidth + 1,
    })));
    assert.equal(cards.length, 2);
    assert.ok(cards.every(card => card.width <= 132 && card.height >= 44 && !card.overflow), JSON.stringify(cards));
    await page.locator('.route-mode').last().click();
    assert.ok(await page.locator('.route-mode').last().locator('input').isChecked());
    await page.screenshot({ path: resolve(output, 'trip-desktop.png') });
    return cards;
  });
  await page.locator('#tab-explore').click();
  await canvasReady();

  const mouseDrag = async (pitch, zoom, button = 'left') => {
    await page.locator(pitch === 0 ? '#mode-2d' : '#mode-3d').click();
    await page.evaluate(({ pitch, zoom }) => {
      const map = window.__JEJU_MAP__;
      map.jumpTo({ center: [126.55, 33.37], zoom, pitch, bearing: 0 });
      window.__dragSamples = [];
      if (window.__dragListener) map.off('drag', window.__dragListener);
      window.__dragListener = event => window.__dragSamples.push({ lng: map.getCenter().lng, original: Boolean(event.originalEvent) });
      map.on('drag', window.__dragListener);
    }, { pitch, zoom });
    const point = await page.locator('.maplibregl-canvas').evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      for (const y of [.35, .42, .5]) for (const x of [.32, .4, .5]) {
        const point = { x: rect.left + rect.width * x, y: rect.top + rect.height * y };
        if (document.elementFromPoint(point.x, point.y) === canvas) return point;
      }
      return null;
    });
    assert.ok(point, 'A clear map area must receive the drag');
    const before = await page.evaluate(() => ({
      center: window.__JEJU_MAP__.getCenter().toArray(), bearing: window.__JEJU_MAP__.getBearing(),
    }));
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button });
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(point.x + 10 * i, point.y + 3 * i);
      await page.waitForTimeout(20);
    }
    await page.mouse.up({ button });
    const after = await page.evaluate(() => ({
      center: window.__JEJU_MAP__.getCenter().toArray(), bearing: window.__JEJU_MAP__.getBearing(),
      samples: window.__dragSamples.length,
    }));
    if (button === 'left') {
      assert.ok(after.samples >= 8, JSON.stringify({ before, after }));
      assert.ok(Math.hypot(after.center[0] - before.center[0], after.center[1] - before.center[1]) > .005,
        JSON.stringify({ before, after }));
    } else assert.ok(Math.abs(after.bearing - before.bearing) > 5, JSON.stringify({ before, after }));
    return { before, after };
  };
  await check('Mouse drag continues through a 2D gesture', () => mouseDrag(0, 12));
  await check('Mouse drag continues through a 3D gesture', () => mouseDrag(55, 12));
  await check('Right-button rotation continues through a gesture', () => mouseDrag(40, 12, 'right'));
  await check('Wheel zoom and keyboard navigation still move the camera', async () => {
    await page.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.55, 33.37], zoom: 12, pitch: 0, bearing: 0 }));
    const canvas = page.locator('.maplibregl-canvas');
    const rect = await canvas.boundingBox();
    await page.mouse.move(rect.x + rect.width * .4, rect.y + rect.height * .4);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(() => window.__JEJU_MAP__.getZoom() > 12.1);
    await page.waitForFunction(() => !window.__JEJU_MAP__.isMoving());
    const before = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(before => {
      const center = window.__JEJU_MAP__.getCenter();
      return !window.__JEJU_MAP__.isMoving() && Math.abs(center.lng - before[0]) > .0001;
    }, before);
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('#tab-guide').click();
  await canvasReady();
  await check('Tablet-width AI panel and heading fit without horizontal page overflow', async () => {
    const metric = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth, viewport: innerWidth,
      title: document.querySelector('.sidebar-intro h1').scrollWidth,
      titleWidth: document.querySelector('.sidebar-intro h1').clientWidth,
      map: window.__JEJU_MAP__.getContainer().clientWidth,
      canvas: window.__JEJU_MAP__.getCanvas().getBoundingClientRect().width,
    }));
    assert.ok(metric.page <= metric.viewport + 1 && metric.title <= metric.titleWidth + 1, JSON.stringify(metric));
    assert.ok(Math.abs(metric.canvas - metric.map) <= 1, JSON.stringify(metric));
    return metric;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#drawer-toggle').click();
  await check('Mobile AI drawer retains its input and three recommendation bubbles', async () => {
    assert.ok(await page.locator('#guide-input').isVisible());
    assert.equal(await page.locator('#guide-followups button').count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await page.locator('#sidebar-toggle').isVisible(), false);
    assert.equal(await page.locator('#place-drawer').evaluate(node => node.inert), false);
    await page.screenshot({ path: resolve(output, 'guide-mobile.png') });
  });
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
    locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const touchPage = await touchContext.newPage();
  touchPage.on('pageerror', error => report.errors.push(error.message));
  await touchPage.goto(base, { waitUntil: 'domcontentloaded' });
  await touchPage.waitForFunction(() => window.__JEJU_MAP__?.isStyleLoaded()
    && !document.querySelector('#mode-2d')?.disabled, null, { timeout: 90000 });
  await touchPage.locator('#mode-2d').click();
  await touchPage.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.55, 33.37], zoom: 12, pitch: 0, bearing: 0 }));
  const touchProtocol = await touchContext.newCDPSession(touchPage);
  const touchPoint = (x, y, id = 0) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  await check('One-finger touch pan continues across the gesture', async () => {
    const before = await touchPage.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
    await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(80, 330)] });
    for (let i = 1; i <= 12; i++) {
      await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(80 + i * 8, 330 + i * 2)] });
      await touchPage.waitForTimeout(20);
    }
    await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const after = await touchPage.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
    assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) > .005, JSON.stringify({ before, after }));
    return { before, after };
  });
  await check('Adding a second finger does not cancel pinch zoom', async () => {
    await touchPage.evaluate(() => window.__JEJU_MAP__.jumpTo({ center: [126.55, 33.37], zoom: 12, pitch: 0, bearing: 0 }));
    await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(110, 330)] });
    await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(110, 330), touchPoint(210, 330, 1)] });
    for (let i = 1; i <= 12; i++) {
      await touchProtocol.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [touchPoint(110 - i * 3, 330), touchPoint(210 + i * 3, 330, 1)],
      });
      await touchPage.waitForTimeout(20);
    }
    await touchProtocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const zoom = await touchPage.evaluate(() => window.__JEJU_MAP__.getZoom());
    assert.ok(zoom > 12.25, String(zoom));
    return { zoom };
  });
  await touchContext.close();
  report.passed = report.checks.every(check => check.passed) && report.errors.length === 0;
} catch (error) {
  report.failure = error.stack;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
}
