/** Phone catalog visibility and touch scrolling; no model or Kakao calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createApiHandler } from '../server/api.mjs';
import { createAppServer } from '../server/server.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' } } });
const output = resolve(values.output || '.local/mobile-catalog-20260912/browser');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const report = { passed: false, checks: [], errors: [], modelCalls: 0, kakaoCalls: 0, liveCatalog: Boolean(values.url) };
let server, browser, api;
let base = values.url?.replace(/\/$/, '');
const check = async (name, work) => {
  try { report.checks.push({ name, passed: true, detail: await work() }); }
  catch (error) { report.checks.push({ name, passed: false, failure: error.message }); }
};
const snapshot = page => page.evaluate(() => {
  const root = document.getElementById('catalog-explorer');
  const rect = root.getBoundingClientRect();
  const cards = [...root.querySelectorAll('.catalog-card')];
  const fullyVisible = cards.filter(card => {
    const b = card.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = card.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return b.top >= top - 1 && b.bottom <= bottom + 1 && b.left >= left - 1 && b.right <= right + 1;
  });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, height: root.clientHeight,
    top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width,
    cardCount: cards.length, fullyVisible: fullyVisible.length,
    firstVisible: fullyVisible[0]?.querySelector('strong')?.textContent,
    pageWidth: document.documentElement.scrollWidth,
  };
});
const ready = page => page.waitForFunction(() =>
  document.getElementById('catalog-list')?.getAttribute('aria-busy') !== 'true'
  && document.querySelectorAll('#catalog-list .catalog-card').length > 0);

try {
  if (!base) {
    const places = Array.from({ length: 85 }, (_, i) => ({
      id: `beach-fixture-${i}`, name: `시험 해변 ${String(i + 1).padStart(2, '0')}`, name_en: null,
      category: '해변', source: 'sample', source_label: '브라우저 시험 자료', lat: 33.4, lng: 126.5,
      address: '목록 가독성을 확인하는 시험 주소', phone: null, summary: null, tags: [],
      base_note: '실제 여행 안내 자료가 아닙니다.', updated_at: null, region: null, avg_stay_min: null,
      url: null, hours: null, distance_m: null,
    }));
    api = createApiHandler({
      secret: 'mobile-catalog-fixture'.repeat(2), env: { NODE_ENV: 'test' },
      catalog: {
        status: () => ({ status: 'ready', total: places.length, categories: [{ id: '해변', count: places.length }],
          by_source: { sample: places.length }, built_at: new Date().toISOString(), stale: false,
          photos_count: 0, hours_week_count: 0 }),
        refreshIfNeeded: async () => {},
        search: ({ offset = 0, limit = 40 }) => ({
          items: places.slice(offset, offset + limit), total: places.length, has_more: offset + limit < places.length,
        }),
        points: () => ({ type: 'FeatureCollection', features: [] }),
        detail: () => null,
      },
    });
    server = createAppServer({ root: resolve('dist'), api });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE
      || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({
      viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
      locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/guide') report.modelCalls++;
      if (new URL(request.url()).pathname === '/api/kakao/place') report.kakaoCalls++;
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-map-category="해변"]')?.disabled === false);
    await page.locator('#drawer-toggle').click();
    await page.locator('[data-map-category="해변"]').click();
    await ready(page);

    await check(`${viewport.width}×${viewport.height}: category selection leaves readable complete result cards`, async () => {
      const state = await snapshot(page);
      assert.ok(state.fullyVisible >= 1, JSON.stringify(state));
      assert.ok(state.height >= 280, JSON.stringify(state));
      assert.ok(state.pageWidth <= viewport.width + 1);
      return state;
    });
    await page.screenshot({ path: resolve(output, `beaches-${viewport.width}.png`) });

    await check(`${viewport.width}×${viewport.height}: a touch swipe moves the catalog and reveals more places`, async () => {
      const state = await snapshot(page), cdp = await context.newCDPSession(page);
      const x = state.left + state.width / 2;
      const startY = Math.min(state.bottom - 45, viewport.height - 60);
      const endY = Math.max(state.top + 20, startY - 210);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
      for (let step = 1; step <= 12; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x, y: startY + (endY - startY) * step / 12 }],
        });
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(before => document.getElementById('catalog-explorer').scrollTop > before + 80, state.scrollTop);
      const after = await snapshot(page);
      assert.ok(after.fullyVisible >= 2, JSON.stringify(after));
      await page.screenshot({ path: resolve(output, `beaches-scrolled-${viewport.width}.png`) });
      return after;
    });

    await check(`${viewport.width}×${viewport.height}: optional filters remain available and results can be paged`, async () => {
      await page.locator('#catalog-filter-toggle').click();
      assert.equal(await page.locator('#catalog-filter-toggle').getAttribute('aria-expanded'), 'true');
      assert.ok(await page.locator('#catalog-category').isVisible());
      await page.locator('#catalog-filter-toggle').click();
      assert.equal(await page.locator('#catalog-filter-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#catalog-category').isVisible(), false);
      const first = await page.locator('#catalog-list [data-catalog-id]').first().getAttribute('data-catalog-id');
      await page.locator('#catalog-next').click();
      await ready(page);
      await page.waitForFunction(id => document.querySelector('#catalog-list [data-catalog-id]')?.getAttribute('data-catalog-id') !== id, first);
      const next = await snapshot(page);
      assert.ok(next.fullyVisible >= 1, JSON.stringify(next));
      assert.match(await page.locator('#catalog-page').innerText(), /^2\s*\//);
      await page.locator('#language-toggle').click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      assert.equal(await page.locator('#catalog-filter-toggle').innerText(), 'Filters & map');
      await page.locator('#drawer-toggle').click();
      assert.equal(await page.locator('#sidebar-content').evaluate(node => node.inert), true);
      await page.locator('#drawer-toggle').click();
      assert.match(await page.locator('#catalog-page').innerText(), /^2\s*\//);
      return next;
    });
    await context.close();
  }
  assert.equal(report.modelCalls, 0);
  assert.equal(report.kakaoCalls, 0);
  assert.deepEqual(report.errors, []);
  report.passed = report.checks.every(check => check.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  api?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  report.checkedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
