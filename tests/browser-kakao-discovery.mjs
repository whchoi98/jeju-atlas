/** Built UI with a real selection adapter and controlled API responses; no live Kakao or AI calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';
import { createDiscoveryAdapter } from '../server/discovery.mjs';
import { snapshot } from '../src/saved-data.ts';

const output = resolve(process.argv[2] || '/tmp/jeju-kakao-discovery-browser');
await mkdir(output, { recursive: true });
const now = () => new Date().toISOString();
const place = (id, name, category = '해변') => ({
  id, name, category, name_en: null, lat: 33.4, lng: 126.55,
  source: 'sample', source_label: '기존 카탈로그 시험 자료', address: '공공정보 시험 주소',
  summary: '브라우저 검사용 자료', tags: [], base_note: '실제 방문 안내 자료가 아닙니다.',
  updated_at: '2026-09-01T01:00:00.000Z', region: null, avg_stay_min: null, url: null, phone: null, hours: null, distance_m: null,
  photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null, menu: [],
  business_status: null, tips: null, sources: [], enriched_at: null, official_details: [],
});
const nature = place('poi_beach', '기존 해변');
// Controlled images exercise provider-neutral rendering and retry, never actual venue photography.
nature.photos = ['available', 'retry'].map(name => ({
  url: `https://upload.wikimedia.org/atlas-browser-fixture/${name}.svg`,
  thumb_url: null, origin_url: 'https://commons.wikimedia.org/wiki/File:Atlas_browser_fixture.svg',
  credit: '브라우저 시험 사진 크레딧', license: 'CC-BY-SA-4.0', source: 'wikimedia',
}));
const old = place('poi_old', '이전 저장 식당', '맛집');
const publicPlace = {
  ...place('poi_public', '카카오 맛집 1001', '맛집'), source: 'visitjeju',
  address: '다른 공공정보 주소', overview: '공공정보에서 제공한 시험 소개',
  enriched_at: '2026-09-10T01:00:00.000Z',
  field_evidence: { overview: { state: 'source_reported', source: 'visitjeju',
    observed_at: '2026-09-10T01:00:00.000Z', evidence_url: 'https://www.visitjeju.net/' } },
  sources: [{ source: 'visitjeju', url: 'https://www.visitjeju.net/', observed_at: '2026-09-10T01:00:00.000Z', license: null }],
};
const originals = [nature, old, publicPlace];
const originalJSON = JSON.stringify(originals);
const nativeCategories = ['맛집', '카페', '숙소', '주차장'];
const providerPaths = {
  맛집: '음식점 > 한식 > 국수', 카페: '음식점 > 카페 > 커피전문점',
  숙소: '여행 > 숙박 > 펜션', 주차장: '교통,수송 > 교통시설 > 주차장',
  문화시설: '문화,예술 > 문화시설 > 박물관',
};
const rawPlace = (id, category = '맛집') => ({
  id: String(id), name: `카카오 ${category} ${id}`, category: providerPaths[category],
  group: ({ 맛집: 'FD6', 카페: 'CE7', 숙소: 'AD5', 주차장: 'PK6' })[category] || 'CT1',
  groupName: category, address: `카카오 지번 ${id}`, road_address: `카카오 도로 ${id}`,
  phone: '064-123-4567', url: `https://place.map.kakao.com/${id}`, lat: 33.4, lng: 126.55,
});
const catalog = {
  search({ q = '', category = '', exclude_commercial = false } = {}) {
    const items = originals.filter(item => (!q || item.name.includes(q)) && (!category || item.category === category)
      && (!exclude_commercial || !nativeCategories.includes(item.category)));
    return { items, total: items.length, has_more: false };
  },
  detail: id => originals.find(item => item.id === id) || null,
};
const adapter = createDiscoveryAdapter({ secret: 'fixture-browser-discovery-secret-1234567890', catalog });
const actor = 'fixture-browser-actor';
assert.equal(adapter.detailFor(rawPlace(1001), now()).linked_catalog?.id, publicPlace.id,
  'The native fixture must qualify for the public-enrichment assertion');
const savedNative = {
  ...snapshot(adapter.detailFor(rawPlace(5000, '카페'), now())),
  name: '이전 카카오 이름', updated_at: '2026-09-01T01:00:00.000Z',
};
const initialSaved = {
  version: 1, favorites: [snapshot(old), savedNative], stops: [{ ...snapshot(old), stay_min: 45 }],
};
const requests = [], issuedTokens = new Set(), errors = [];
let failing = false, expireNextSelection = false, missingSaved = false;
let holdPoints = false, releasePoints;
const readBody = async req => {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw new Error('Oversized client request');
  }
  return body ? JSON.parse(body) : {};
};
const server = createAppServer({
  root: resolve('dist'),
  api: async (req, res, url) => {
    const json = (value, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      if (url.pathname === '/api/config') return json({
        version: 'discovery-browser-fixture', features: { catalog: true, guide: false, planner: true, routing: false, pwa: true },
        guide: { daily_limit: 0 }, routing: { enabled: false },
        kakao: { enabled: true, csrf_token: 'fixture-csrf' },
        discovery: { enabled: true, csrf_token: 'fixture-csrf', categories: nativeCategories, page_size: 15, max_results: 45 },
      });
      if (url.pathname === '/api/catalog/status') return json({
        status: 'ready', total: 6724, by_source: { sample: 6724 },
        categories: ['해변', '오름', '맛집', '카페', '숙소', '주차장'].map(id => ({ id, count: 3 })),
        built_at: now(), refreshed_at: now(), stale: false, photos_count: 0, hours_week_count: 0,
      });
      if (url.pathname === '/api/catalog/search') return json(catalog.search({
        ...Object.fromEntries(url.searchParams), exclude_commercial: url.searchParams.get('exclude_commercial') === 'true',
      }));
      if (url.pathname === '/api/catalog/points') {
        if (holdPoints) await new Promise(resolve => { releasePoints = resolve; });
        return json({ type: 'FeatureCollection', features: originals.map(item => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
          properties: { id: item.id, name: item.name, category: item.category, source_label: item.source_label },
        })) });
      }
      if (url.pathname.startsWith('/api/catalog/places/')) {
        const item = catalog.detail(decodeURIComponent(url.pathname.split('/').at(-1)));
        return json(item || {}, item ? 200 : 404);
      }
      if (url.pathname === '/api/kakao/place') return json({
        available: true, status: 'unsupported', canonical_id: url.searchParams.get('id'), queried_at: now(),
        source: 'Kakao Local', place: null,
      });
      if (url.pathname.startsWith('/api/kakao/')) {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers['x-atlas-csrf'], 'fixture-csrf');
      }
      if (url.pathname === '/api/kakao/search') {
        if (failing) return json({ error: { code: 'kakao_unavailable' } }, 503);
        assert.ok(body.page >= 1 && body.page <= 3);
        const category = body.category || '문화시설';
        const empty = body.query === '없는결과';
        const first = (nativeCategories.indexOf(category) + 1 || 6) * 1000 + 1 + (body.page - 1) * 15;
        const items = empty ? [] : Array.from({ length: 15 }, (_, i) => rawPlace(first + i, category));
        const result = adapter.toSearch({
          items, total: empty ? 0 : 62, pageable: empty ? 0 : 45, page: body.page, page_size: 15,
          end: empty || body.page === 3, truncated: !empty, queried_at: now(),
        }, body, actor);
        result.items.forEach(item => issuedTokens.add(item.selection_token));
        return json(result);
      }
      if (url.pathname === '/api/kakao/detail') {
        assert.deepEqual(Object.keys(body), ['token']);
        if (expireNextSelection) {
          expireNextSelection = false;
          return json({ error: { code: 'kakao_selection_expired' } }, 400);
        }
        return json(adapter.detail(body.token, actor));
      }
      if (url.pathname === '/api/kakao/reopen') {
        assert.deepEqual(Object.keys(body).sort(), ['category', 'id', 'lat', 'lng', 'name']);
        if (missingSaved) return json({ error: { code: 'kakao_place_unavailable' } }, 404);
        const id = Number(body.id.slice(6));
        const item = rawPlace(id, body.category);
        if (id === 5000) {
          item.name = '현재 카카오 이름';
          item.group = 'AD5'; item.groupName = '숙소'; item.category = '여행 > 숙박 > 시험 숙소';
        }
        return json(adapter.detailFor(item, now(), actor));
      }
      return json({ error: { code: 'fixture_unavailable' } }, 503);
    } catch (error) {
      if (!req.destroyed) errors.push(error.message);
      json({ error: { code: 'fixture_error' } }, 500);
    }
  },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const report = { passed: false, checks: [], errors, controlledProvider: true };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', locale: 'ko-KR' });
  await context.addInitScript(data => {
    if (!localStorage.getItem('jeju-atlas.saved.v1')) localStorage.setItem('jeju-atlas.saved.v1', JSON.stringify(data));
  }, initialSaved);
  const page = await context.newPage();
  let photoUnavailable = true;
  await page.route('https://upload.wikimedia.org/atlas-browser-fixture/**', route => {
    const missing = photoUnavailable && route.request().url().endsWith('/retry.svg');
    return route.fulfill({
      status: missing ? 404 : 200, contentType: 'image/svg+xml', headers: { 'Cache-Control': 'no-store' },
      body: missing ? '' : '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#232f3e"/><text x="30" y="110" fill="white" font-size="24">BROWSER TEST IMAGE</text></svg>',
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-catalog-id="poi_beach"]');
  await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('catalog-points'), null, { timeout: 90_000 });
  const count = path => requests.filter(request => request.path === path).length;
  const cards = () => page.locator('#catalog-list [data-catalog-id]');
  const waitNative = id => page.waitForSelector(`#catalog-list [data-catalog-id="${id}"]`);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')));
  const closeDetail = () => page.locator('#catalog-detail [data-detail-action="close"]').click();
  const points = () => page.evaluate(() => window.__JEJU_MAP__.getSource('catalog-points').serialize().data.features);
  const selectSource = async value => {
    if (await page.locator('#catalog-filter-toggle').getAttribute('aria-expanded') !== 'true') {
      await page.locator('#catalog-filter-toggle').click();
    }
    await page.locator('#catalog-source').selectOption(value);
  };

  assert.equal((await cards().all()).length, 1);
  assert.equal(requests.find(request => request.path === '/api/catalog/search').query.exclude_commercial, 'true');
  assert.equal(await page.locator('#catalog-source').inputValue(), 'auto');
  report.checks.push('Automatic blank landing retains public catalog places and excludes commercial records');

  holdPoints = true;
  await page.locator('[data-map-category="해변"]').click();
  await page.waitForFunction(() => document.querySelector('[data-map-category="해변"]').getAttribute('aria-pressed') === 'true');
  for (let i = 0; i < 100 && !releasePoints; i++) await page.waitForTimeout(20);
  assert.ok(releasePoints, 'A previous catalog points request should be in flight');
  const oldPointsCount = count('/api/catalog/points');
  await page.locator('[data-map-category="맛집"]').click();
  await waitNative('kakao:1001');
  holdPoints = false;
  releasePoints();
  await page.waitForTimeout(50);
  assert.equal(await cards().count(), 15);
  assert.equal(count('/api/catalog/points'), oldPointsCount);
  assert.deepEqual((await points()).map(item => item.properties.id), Array.from({ length: 15 }, (_, i) => `kakao:${1001 + i}`));
  assert.match(await page.locator('.catalog-provider-category').first().innerText(), /음식점 > 한식 > 국수/);
  assert.doesNotMatch(await page.locator('#catalog-total').innerText(), /6,?724/);
  assert.match(await page.locator('#catalog-total').innerText(), /62/);
  await page.locator('#catalog-native-info > summary').click();
  assert.match(await page.locator('#catalog-native-note').innerText(), /15|45/);
  await page.locator('#catalog-native-info > summary').click();
  report.checks.push('Native cards and current-page markers replace a late catalog points response without a second search');

  // Blocked workers show the real retry footer, which also consumes vertical space in production.
  await page.locator('#pwa-retry').waitFor();
  const visibility = [];
  for (const viewport of [
    { width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1024, height: 600 },
    { width: 375, height: 667 }, { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 760 && await page.locator('#drawer-toggle').getAttribute('aria-expanded') !== 'true') {
      await page.locator('#drawer-toggle').click();
    }
    await page.evaluate(() => { document.querySelector('#catalog-explorer').scrollTop = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const state = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#catalog-list .catalog-card')];
      const fullyVisible = cards.filter(card => {
        const bounds = card.getBoundingClientRect();
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let parent = card.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            left = Math.max(left, rect.left); right = Math.min(right, rect.right);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
          }
        }
        return bounds.top >= top - 1 && bounds.bottom <= bottom + 1
          && bounds.left >= left - 1 && bounds.right <= right + 1;
      });
      return { width: innerWidth, height: innerHeight, fullyVisible: fullyVisible.length,
        cardHeight: cards[0].getBoundingClientRect().height, pageWidth: document.documentElement.scrollWidth };
    });
    visibility.push(state);
    await page.screenshot({ path: resolve(output, `native-results-${viewport.width}.png`) });
  }
  report.visibility = visibility;
  assert.ok(visibility.every(state => state.fullyVisible >= 2 && state.pageWidth <= state.width + 1), JSON.stringify(visibility));
  report.checks.push('At least two complete native place cards are visible before scrolling on laptops and phones');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const originalLookupCalls = count('/api/kakao/place');
  await cards().first().click();
  await page.locator('#kakao-place-details a[data-kakao-focus="place"]').waitFor();
  assert.equal(await page.locator('#kakao-place-details a[data-kakao-focus="place"]').getAttribute('href'), 'https://place.map.kakao.com/1001');
  assert.match(await page.locator('#kakao-place-details').innerText(), /카카오 도로 1001/);
  assert.match(await page.locator('.detail-linked-catalog').innerText(), /공공정보 보강/);
  assert.match(await page.locator('.detail-visit-summary [data-evidence-field="overview"]').innerText(), /비짓제주/);
  assert.match(await page.locator('.detail-heading h2').innerText(), /카카오 맛집 1001/);
  assert.match(await page.locator('#catalog-detail .place-visual-title').innerText(), /제공된 실제 사진 없음/);
  assert.equal(await page.locator('#detail-photo-image').count(), 0);
  assert.equal(count('/api/kakao/place'), originalLookupCalls);
  const searchCalls = count('/api/kakao/search'), detailCalls = count('/api/kakao/detail');
  await page.locator('#language-toggle').click();
  assert.match(await page.locator('#kakao-place-details').innerText(), /Kakao visiting information/);
  assert.match(await page.locator('#catalog-detail .place-visual').innerText(), /Actual photo unavailable/);
  assert.match(await page.locator('#catalog-detail .place-visual').innerText(), /Category illustration/);
  assert.equal(count('/api/kakao/search'), searchCalls);
  assert.equal(count('/api/kakao/detail'), detailCalls);
  await page.locator('#detail-favorite').click();
  await page.locator('#detail-add-trip').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')).stops.some(item => item.id === 'kakao:1001'));
  let data = await saved();
  assert.equal(data.favorites.find(item => item.id === 'poi_old').name, old.name);
  assert.doesNotMatch(JSON.stringify(data), /selection_token|kakao_lookup|linked_catalog/);
  assert.ok([...issuedTokens].every(token => !JSON.stringify(data).includes(token)));
  report.checks.push('Native detail reuses its source lookup, keeps public enrichment separate, and saves token-free snapshots');
  await closeDetail();

  await page.locator('#catalog-next').click();
  await waitNative('kakao:1016');
  assert.equal(await cards().count(), 15);
  assert.deepEqual((await points()).map(item => item.properties.id), Array.from({ length: 15 }, (_, i) => `kakao:${1016 + i}`));
  const mapReopenBefore = count('/api/kakao/reopen');
  await page.locator('#selected-catalog-detail').click();
  await page.locator('#kakao-place-details a[href="https://place.map.kakao.com/1001"]').waitFor();
  assert.equal(count('/api/kakao/reopen'), mapReopenBefore + 1);
  assert.equal(requests.filter(request => request.path === '/api/kakao/reopen').at(-1).body.id, 'kakao:1001');
  assert.equal(count('/api/kakao/place'), originalLookupCalls);
  assert.deepEqual((await points()).map(item => item.properties.id), Array.from({ length: 15 }, (_, i) => `kakao:${1016 + i}`));
  assert.match(await page.locator('.detail-heading h2').innerText(), /카카오 맛집 1001/);
  await closeDetail();
  report.checks.push('A selected native map place reopens by its exact ID after closing its detail and changing the result page');
  await page.locator('#catalog-next').click();
  await waitNative('kakao:1031');
  assert.equal(await page.locator('#catalog-next').isDisabled(), true);
  assert.equal(await page.locator('#catalog-page').innerText(), '3 / 3');
  expireNextSelection = true;
  const reopenBefore = count('/api/kakao/reopen');
  await cards().first().click();
  await page.locator('#kakao-place-details a[href="https://place.map.kakao.com/1031"]').waitFor();
  assert.equal(count('/api/kakao/reopen'), reopenBefore + 1);
  await closeDetail();
  report.checks.push('Paging stops at 45 and an expired selection refreshes the same native ID');

  failing = true;
  await page.locator('#catalog-refresh').click();
  await page.locator('#catalog-retry').waitFor();
  assert.match(await page.locator('#catalog-list').innerText(), /unavailable/i);
  assert.doesNotMatch(await page.locator('#catalog-list').innerText(), /No Kakao results/i);
  failing = false;
  await page.locator('#catalog-retry').click();
  await waitNative('kakao:1031');
  await page.locator('#catalog-search').fill('없는결과');
  await page.waitForFunction(() => document.querySelector('#catalog-list').textContent.includes('No Kakao results'));
  assert.equal(await page.locator('#catalog-retry').count(), 0);
  assert.equal(await page.locator('#catalog-result-count').innerText(), '0–0 / 0');
  report.checks.push('A valid empty native search is distinguished from outage and explicit recovery');

  await page.locator('#catalog-search').fill('');
  await selectSource('catalog');
  await page.locator('[data-map-category="해변"]').click();
  await page.waitForSelector('[data-catalog-id="poi_beach"]');
  await page.locator('[data-catalog-id="poi_beach"]').click();
  await page.waitForFunction(() => document.querySelector('#detail-photo-image')?.naturalWidth > 0);
  assert.equal(await page.locator('#detail-photo-image').evaluate(image => getComputedStyle(image).objectFit), 'contain');
  assert.match(await page.locator('#detail-photo-caption').innerText(), /CC-BY-SA-4.0/);
  assert.match(await page.locator('#detail-photo-caption').innerText(), /브라우저 시험 사진 크레딧/);
  await page.locator('#detail-photo-next').click();
  await page.locator('#detail-photo-error .place-visual').waitFor();
  assert.match(await page.locator('#detail-photo-error').innerText(), /This photo could not load/);
  assert.equal(await page.locator('#detail-photo-image').isVisible(), false);
  photoUnavailable = false;
  await page.locator('[data-detail-action="photo-retry"]').click();
  await page.waitForFunction(() => document.querySelector('#detail-photo-image')?.naturalWidth > 0);
  assert.equal(await page.locator('#detail-photo-error').isVisible(), false);
  await closeDetail();
  report.checks.push('Non-TourAPI photos keep their credit and aspect ratio; missing photos disclose artwork and failed images can recover');
  await selectSource('kakao');
  assert.equal(await page.locator('#catalog-category').inputValue(), '');
  await page.locator('#catalog-search').fill('박물관');
  await waitNative('kakao:6001');
  await page.locator('#catalog-search').fill('');
  await page.locator('[data-map-category="해변"]').click();
  await page.waitForSelector('[data-catalog-id="poi_beach"]');
  assert.equal(await page.locator('#catalog-source').inputValue(), 'auto');
  await selectSource('catalog');
  await page.locator('#catalog-category').selectOption('');
  await page.waitForSelector('[data-catalog-id="poi_old"]');
  assert.notEqual(requests.filter(request => request.path === '/api/catalog/search').at(-1).query.exclude_commercial, 'true');
  report.checks.push('Explicit original searches keep all records; unsupported native categories reset and nature chips restore automatic mode');

  await page.locator('#tab-trip').click();
  await page.locator('#favorite-list [data-action="select"][data-id="kakao:5000"]').click();
  await page.locator('#kakao-place-details a[href="https://place.map.kakao.com/5000"]').waitFor();
  assert.match(await page.locator('.detail-heading h2').innerText(), /현재 카카오 이름/);
  assert.equal((await saved()).favorites.find(item => item.id === 'kakao:5000').name, '이전 카카오 이름');
  assert.match(await page.locator('.detail-breadcrumb').innerText(), /숙박/);
  await closeDetail();
  missingSaved = true;
  await page.locator('#favorite-list [data-action="select"][data-id="kakao:5000"]').click();
  await page.waitForFunction(() => document.querySelector('#catalog-detail .detail-base-note')?.textContent.includes('Current Kakao information could not be checked'));
  assert.match(await page.locator('.detail-heading h2').innerText(), /이전 카카오 이름/);
  assert.equal(await page.locator('#kakao-place-details').count(), 0);
  assert.match(await page.locator('#catalog-detail').innerText(), /2026/);
  await closeDetail();
  missingSaved = false;
  await context.setOffline(true);
  await page.locator('#favorite-list [data-action="select"][data-id="kakao:5000"]').click();
  await page.waitForFunction(() => document.querySelector('#catalog-detail .detail-base-note')?.textContent.includes('Current Kakao information could not be checked'));
  assert.match(await page.locator('.detail-heading h2').innerText(), /이전 카카오 이름/);
  await context.setOffline(false);
  await closeDetail();
  await page.locator('#favorite-list [data-action="select"][data-id="poi_old"]').click();
  await page.waitForSelector('#catalog-reference-details');
  assert.ok(requests.some(request => request.path === '/api/catalog/places/poi_old'));
  await closeDetail();
  report.checks.push('Saved native IDs refresh without renaming bookmarks; missing/offline native places and original bookmarks retain their own identities');

  await page.locator('#tab-explore').click();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#drawer-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#drawer-toggle').click();
  await selectSource('auto');
  await page.locator('[data-map-category="카페"]').click();
  await waitNative('kakao:2001');
  assert.equal(await page.locator('#catalog-source').isVisible(), false);
  await page.locator('#catalog-filter-toggle').click();
  assert.equal(await page.locator('#catalog-source').isVisible(), true);
  await page.locator('#catalog-filter-toggle').click();
  await page.locator('#catalog-next').click();
  await waitNative('kakao:2016');
  assert.equal(await cards().count(), 15);
  assert.ok(await page.locator('#catalog-explorer').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  assert.ok(await page.locator('#catalog-explorer').evaluate(node => node.scrollHeight > node.clientHeight));
  assert.ok((await cards().first().boundingBox()).height > 44);
  await page.setViewportSize({ width: 375, height: 667 });
  assert.ok(await cards().first().isVisible());
  await page.screenshot({ path: resolve(output, 'native-mobile.png') });
  data = await saved();
  assert.doesNotMatch(JSON.stringify(data), /selection_token|kakao_lookup|linked_catalog/);
  assert.equal(JSON.stringify(originals), originalJSON);
  assert.deepEqual(errors, []);
  report.checks.push('Mobile optional source filters and 15-place paging use the full explorer scroll area without horizontal overflow');
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  releasePoints?.();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.searchRequests = requests.filter(request => request.path === '/api/kakao/search').length;
  report.detailRequests = requests.filter(request => request.path === '/api/kakao/detail').length;
  report.reopenRequests = requests.filter(request => request.path === '/api/kakao/reopen').length;
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
