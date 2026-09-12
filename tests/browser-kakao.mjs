/** Full detail UI against the real BFF with a controlled provider; no live keys or model calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApiHandler } from '../server/api.mjs';
import { createAppServer } from '../server/server.mjs';

const output = resolve(process.argv[2] || '.local/kakao-integration-20260911/browser');
await mkdir(output, { recursive: true });
const makePlace = (id, name, lng) => ({
  id, name, name_en: null, category: '맛집', source: 'sample', source_label: '시험용 원본',
  lat: 33.4, lng, address: null, phone: null, summary: '제어된 브라우저 시험 자료', tags: [],
  base_note: '실제 여행 안내 자료가 아닙니다.', updated_at: null, region: null, avg_stay_min: null,
  url: null, hours: null, distance_m: null, photos: [], hours_week: [], hours_source: null,
  facilities: {}, overview: null, menu: [], business_status: null, tips: null, sources: [], enriched_at: null,
});
const places = [makePlace('poi_0900', '검사 식당 하나', 126.55), makePlace('poi_0901', '검사 식당 둘', 126.56)];
const before = JSON.stringify(places);
let calls = 0, failing = false, differentName = false;
const api = createApiHandler({
  env: { NODE_ENV: 'test', KAKAO_REST_API_KEY: 'browser-fixture-key' },
  secret: 'kakao-browser-test'.repeat(2), publicOrigin: 'http://localhost:5173',
  catalog: {
    status: () => ({ status: 'ready', total: 2, categories: [{ id: '맛집', count: 2 }],
      by_source: { sample: 2 }, built_at: new Date().toISOString(), stale: false, photos_count: 0, hours_week_count: 0 }),
    refreshIfNeeded: async () => {},
    search: () => ({ items: places, total: 2, has_more: false }),
    points: () => ({ type: 'FeatureCollection', features: [] }),
    detail: id => places.find(place => place.id === id) || null,
  },
  kakaoOptions: {
    consumeBudget: async () => {},
    fetch: async (url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, 'KakaoAK browser-fixture-key');
      if (failing) return new Response('{}', { status: 503 });
      const name = new URL(url).searchParams.get('query');
      const place = places.find(place => place.name === name);
      assert.ok(place);
      const id = place.id === 'poi_0900' ? '12345' : '67890';
      return new Response(JSON.stringify({
        meta: { total_count: 1, pageable_count: 1, is_end: true },
        documents: [{ id, place_name: differentName ? '다른 식당' : name, category_group_code: 'FD6', category_group_name: '음식점',
          category_name: '음식점 > 한식', address_name: '시험 주소', road_address_name: '시험 도로명 1',
          phone: '064-000-0000', x: String(place.lng), y: String(place.lat), distance: '0',
          place_url: `http://place.map.kakao.com/${id}` }],
      }), { headers: { 'Content-Type': 'application/json' } });
    },
  },
});
const server = createAppServer({ root: resolve('dist'), api });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const report = { passed: false, checks: [], errors: [], providerFixture: true, modelCalls: 0 };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce', serviceWorkers: 'block', locale: 'ko-KR' });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector('[data-catalog-id="poi_0900"]');
  await page.locator('[data-catalog-id="poi_0900"]').first().click();
  await page.locator('#kakao-place-details [data-kakao-focus="place"]').waitFor();
  assert.equal(await page.locator('#kakao-place-details a[data-kakao-focus="place"]').getAttribute('href'),
    'https://place.map.kakao.com/12345');
  assert.equal(await page.locator('#kakao-place-details a[href^="tel:"]').getAttribute('href'), 'tel:0640000000');
  assert.match(await page.locator('#kakao-place-details').innerText(), /카카오 방문 정보|조회 시각/);
  assert.equal(calls, 1);
  await page.screenshot({ path: resolve(output, 'detail-ko.png') });
  report.checks.push('Canonical detail opens a safe Kakao contact card through the authenticated BFF');

  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.match(await page.locator('#kakao-place-details').innerText(), /Kakao|Retrieved/);
  assert.equal(calls, 1, 'Changing language must reuse only this open view');
  await page.screenshot({ path: resolve(output, 'detail-en.png') });
  report.checks.push('English labels preserve provider data without another lookup');

  await page.locator('[data-detail-action="close"]').click();
  differentName = true;
  await page.locator('[data-catalog-id="poi_0901"]').first().click();
  await page.locator('#kakao-place-details a[data-kakao-focus="search"]').waitFor();
  assert.match(await page.locator('#kakao-place-details').innerText(), /name or branch differs/);
  assert.equal(await page.locator('#kakao-place-details a[data-kakao-focus="place"]').count(), 0);
  report.checks.push('Unconfirmed name differences explain the reason and offer search without claiming absence');
  await page.locator('[data-detail-action="close"]').click();
  differentName = false;
  failing = true;
  await page.locator('[data-catalog-id="poi_0901"]').first().click();
  await page.locator('[data-detail-action="kakao-retry"]').waitFor();
  assert.match(await page.locator('.detail-heading').innerText(), /검사 식당 둘/);
  assert.ok(await page.locator('#detail-add-trip').isVisible());
  failing = false;
  await page.locator('[data-detail-action="kakao-retry"]').click();
  await page.locator('#kakao-place-details a[href="https://place.map.kakao.com/67890"]').waitFor();
  report.checks.push('Provider failure leaves base detail usable and explicit retry restores the card');
  assert.equal(JSON.stringify(places), before);
  assert.equal(await page.locator('body').innerText().then(text => text.includes('browser-fixture-key')), false);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  api.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.providerCalls = calls;
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
