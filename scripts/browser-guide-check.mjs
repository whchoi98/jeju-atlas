import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
).href);

const base = process.argv[2] || 'http://127.0.0.1:8097';
const output = resolve('.local', process.argv[3] || 'guide-browser');
const liveGuide = process.argv.includes('--live-guide');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const results = [];
const errors = [];
let page;
function pass(name, detail) {
  const result = { check: name, passed: true, ...(detail ? { detail } : {}) };
  results.push(result);
  console.log(JSON.stringify(result));
}
async function ready(target, catalog = true) {
  await target.waitForFunction(() => {
    const map = window.__JEJU_MAP__;
    return map && map.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving()
      && !document.querySelector('#mode-3d')?.disabled;
  }, null, { timeout: 90_000 });
  if (catalog) {
    await target.waitForFunction(() => {
      const map = window.__JEJU_MAP__;
      return map?.getLayer('catalog-clusters')
        && map.queryRenderedFeatures(undefined, { layers: ['catalog-clusters', 'catalog-dots'] }).length > 0;
    }, null, { timeout: 60_000 });
  }
}
async function selectPlace(target, query, id) {
  await target.locator('#tab-explore').click();
  await target.locator('#catalog-search').fill(query);
  const card = target.locator(`[data-catalog-id="${id}"]`);
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  await card.click();
  await target.locator('#detail-add-trip').waitFor({ state: 'visible', timeout: 30_000 });
}
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /6,\d{3}/.test(document.querySelector('#catalog-total')?.textContent || ''), null, { timeout: 40_000 });
  await ready(page);
  const status = await page.evaluate(async () => (await fetch('/api/catalog/status')).json());
  assert.ok(status.total >= 6000 && status.by_source.OpenStreetMap >= 6000);
  assert.ok(status.by_source.sample >= 130);
  assert.ok(await page.locator('#catalog-list .catalog-card').count() <= 40);
  const mapState = await page.evaluate(async () => {
    const map = window.__JEJU_MAP__;
    return {
      terrain: map.getTerrain(),
      elevation: map.queryTerrainElevation([126.5292, 33.3617]),
      clusters: map.queryRenderedFeatures(undefined, { layers: ['catalog-clusters'] }).length,
      domMarkers: document.querySelectorAll('.maplibregl-marker').length,
    };
  });
  assert.ok(mapState.terrain && mapState.elevation > 1000 && mapState.clusters > 0);
  assert.ok(mapState.domMarkers < 100, 'Catalog must not create thousands of DOM markers');
  pass('Live 6,000+ catalog, paginated list and GPU clusters preserve real 3D terrain', { total: status.total, ...mapState });
  await page.screenshot({ path: resolve(output, 'catalog-overview.png'), fullPage: true });

  await selectPlace(page, '김녕미로공원', 'poi_0001');
  assert.match(await page.locator('#catalog-detail .detail-base-note').innerText(), /큐레이션|원자료/);
  assert.match(await page.locator('#catalog-detail .detail-base-note').innerText(), /공식|검증/);
  assert.equal(await page.locator('.hours-table tbody tr').count(), 7);
  assert.match(await page.locator('.hours-table').innerText(), /09:00/);
  await page.locator('#detail-favorite').click();
  assert.equal(await page.locator('#detail-favorite').getAttribute('aria-pressed'), 'true');
  await page.locator('#detail-add-trip').click();
  await page.locator('[data-detail-action="close"]').click();
  pass('Curated base provenance stays distinct from official weekday hours; favorites and stops save');

  await selectPlace(page, '생원전복', 'osm:node/8441493336');
  const photo = page.locator('#catalog-detail .detail-photos img').first();
  await photo.waitFor({ state: 'visible' });
  await photo.evaluate((img) => img.decode());
  assert.ok(await photo.evaluate((img) => img.naturalWidth > 0));
  assert.equal(await photo.evaluate((img) => getComputedStyle(img).objectFit), 'contain');
  assert.match(await page.locator('#catalog-detail .detail-photos').innerText(), /한국관광공사/);
  assert.match(await page.locator('#catalog-detail .detail-photos').innerText(), /KOGL-3/);
  assert.match(await page.locator('#business-registration').innerText(), /인허가 상태: 영업\/정상/);
  assert.match(await page.locator('#catalog-detail').innerText(), /현재 시각의 영업 여부를 뜻하지/);
  await page.locator('#detail-add-trip').click();
  await page.screenshot({ path: resolve(output, 'official-detail.png'), fullPage: true });
  await page.locator('#place-weather').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#place-weather .weather-current, #place-weather [data-detail-action="weather"]'), null, { timeout: 25_000 });
  const weatherText = await page.locator('#place-weather').innerText();
  assert.ok(/출처|불러오지 못했/.test(weatherText));
  pass('Official photo license, unaltered display, registration wording and honest weather state');
  await page.locator('[data-detail-action="close"]').click();

  await selectPlace(page, '성산일출봉', 'poi_0008');
  await page.locator('#detail-add-trip').click();
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  const before = await page.locator('#trip-stops > li').evaluateAll((items) => items.map((item) => item.dataset.tripId));
  await page.locator(`#trip-stops button[data-action="up"][data-id="${before[1]}"]`).click();
  const after = await page.locator('#trip-stops > li').evaluateAll((items) => items.map((item) => item.dataset.tripId));
  assert.equal(after[0], before[1]);
  const stay = page.locator('#trip-stops input[data-stay]').first();
  await stay.fill('90');
  await stay.dispatchEvent('change');
  await page.locator('#trip-nearest').click();
  const geometry = await page.evaluate(async () => await window.__JEJU_MAP__.getSource('trip-route').getData());
  assert.equal(geometry.features[0].geometry.coordinates.length, 3);
  assert.match(await page.locator('#trip-panel').innerText(), /직선/);
  await page.screenshot({ path: resolve(output, 'trip-planner.png'), fullPage: true });
  pass('Trip editing, dwell time, nearest-next ordering and 3D connection line');

  await page.locator('#trip-share').click();
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(shared.startsWith(base) && shared.includes('trip='));
  const other = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  const imported = await other.newPage();
  await imported.goto(shared, { waitUntil: 'domcontentloaded' });
  await imported.locator('#tab-trip').click();
  assert.equal(await imported.locator('#trip-stops > li').count(), 3);
  assert.ok((await imported.locator('#trip-stops input[data-stay]').evaluateAll((items) => items.map((item) => item.value))).includes('90'));
  await other.close();
  pass('Shared trip restores in a fresh browser without private session state');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  assert.equal(await page.locator('#favorite-list .favorite-row').count(), 1);
  pass('Favorites and itinerary survive a browser reload');

  if (liveGuide) {
    await page.locator('#tab-guide').click();
    await page.locator('#guide-input').fill('제주 동쪽의 실제 카탈로그 장소 두 곳을 한국어로 짧게 소개해 주세요. 운영시간은 확인된 정보만 말해 주세요.');
    // Chromium may discard a streamed CDP response body. Tee the actual fetch
    // stream in the page so the UI still consumes the original, unmocked data.
    await page.evaluate(() => {
      const fetchOriginal = window.fetch.bind(window);
      window.__atlasGuideWire = null;
      window.fetch = async (...args) => {
        const response = await fetchOriginal(...args);
        const input = args[0];
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname === '/api/guide') {
          response.clone().text().then(
            (body) => { window.__atlasGuideWire = { status: response.status, body }; },
            (error) => { window.__atlasGuideWire = { status: response.status, error: String(error) }; },
          );
        }
        return response;
      };
    });
    await page.locator('#guide-send').click();
    await page.waitForFunction(() => Boolean(window.__atlasGuideWire), null, { timeout: 110_000 });
    const guideWire = await page.evaluate(() => window.__atlasGuideWire);
    assert.equal(guideWire.status, 200);
    assert.equal(guideWire.error, undefined);
    const guideBody = guideWire.body;
    assert.match(guideBody, /event: map/);
    assert.match(guideBody, /event: done/);
    assert.doesNotMatch(guideBody, /event: error/);
    const resultEvent = guideBody.split('\n\n').find((event) => event.startsWith('event: map'));
    const result = JSON.parse(resultEvent.split('\ndata: ')[1]);
    assert.ok(result.answer?.length > 40 && result.markers?.length > 0);
    await page.waitForFunction(() => {
      const log = document.querySelector('#guide-messages');
      return log && log.textContent.length > 100 && document.querySelector('#guide-send')?.disabled === false;
    }, null, { timeout: 110_000 });
    const conversation = await page.locator('#guide-messages').innerText();
    assert.doesNotMatch(conversation, /모의 응답|mock agent/i);
    assert.ok(conversation.length > 100);
    await page.screenshot({ path: resolve(output, 'live-guide.png'), fullPage: true });
    pass('Live guide returns through the public session-protected SSE endpoint', { markers: result.markers.length });
  }

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20_000 });
  const cachedPaths = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith('jeju-atlas-shell-'));
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)))).flat();
  });
  assert.ok(cachedPaths.includes('/index.html'));
  assert.ok(!cachedPaths.some((path) => path.startsWith('/api/') || path.startsWith('/terrarium/')));
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  assert.match(await page.locator('#connection-status').innerText(), /오프라인/);
  await page.screenshot({ path: resolve(output, 'offline-trip.png'), fullPage: true });
  await context.setOffline(false);
  pass('PWA shell restores saved itinerary offline without caching private APIs or map tiles');
  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'ko-KR', reducedMotion: 'reduce',
  });
  page = await mobile.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.locator('#drawer-toggle').click();
  await page.locator('#catalog-search').fill('김녕미로공원');
  await page.locator('[data-catalog-id="poi_0001"]').click();
  await page.locator('#detail-add-trip').waitFor({ state: 'visible' });
  await page.locator('#detail-add-trip').click();
  await page.screenshot({ path: resolve(output, 'mobile-detail.png'), fullPage: true });
  await page.locator('[data-detail-action="close"]').click();
  if (await page.locator('#drawer-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#drawer-toggle').click();
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(output, 'mobile-trip.png'), fullPage: true });
  await mobile.close();
  pass('Mobile catalog search, detail and saved-trip controls work without horizontal overflow');

  assert.deepEqual(errors, [], 'Page errors');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), url: base, passed: true, liveGuide, results, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: results.length, output }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, results, errors, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
