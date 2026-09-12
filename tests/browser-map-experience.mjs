/** Full search → saved → directions → map flow with controlled place/route APIs. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppServer } from '../server/server.mjs';
import { createDiscoveryAdapter } from '../server/discovery.mjs';

const output = resolve(process.argv[2] || '.local/kakao-map-experience-20260912/browser');
await mkdir(output, { recursive: true });
const now = () => new Date().toISOString();
const catalogPlace = (id, name, category = '해변') => ({
  id, name, name_en: null, category, lat: 33.4, lng: 126.5, address: '시험 장소 주소',
  summary: '브라우저 시험 자료', tags: [], source: 'sample', source_label: '시험 자료',
  base_note: '실제 방문 안내가 아닙니다.', updated_at: null, region: null, avg_stay_min: null,
  url: null, phone: null, hours: null, distance_m: null, photos: [], hours_week: [], hours_source: null,
  facilities: {}, overview: null, menu: [], business_status: null, tips: null, sources: [], enriched_at: null,
});
const originals = Array.from({ length: 55 }, (_, index) => catalogPlace(`poi_${String(index + 1).padStart(4, '0')}`, `시험 해변 ${index + 1}`));
const catalog = {
  search: ({ q = '', category = '', offset = 0, limit = 40 } = {}) => {
    const items = originals.filter(item => (!q || item.name.includes(q)) && (!category || item.category === category));
    return { items: items.slice(offset, offset + limit), total: items.length, has_more: offset + limit < items.length };
  },
  detail: id => originals.find(item => item.id === id) || null,
};
const raw = (id, name = `카카오 카페 ${id}`, lat = 33.4, lng = 126.5) => ({
  id: String(id), name, category: '음식점 > 카페', group: 'CE7', groupName: '카페',
  lat, lng, address: `카카오 지번 ${id}`, road_address: `카카오 도로 ${id}`,
  phone: '064-123-4567', url: `https://place.map.kakao.com/${id}`,
});
const native = new Map(Array.from({ length: 30 }, (_, index) => [String(1001 + index), raw(1001 + index)]));
native.set('2001', raw(2001, '도착 카페', 33.38, 126.53));
native.set('2002', raw(2002, '출발 카페', 33.42, 126.48));
const adapter = createDiscoveryAdapter({ secret: 'map-experience-fixture-secret-32bytes', catalog });
const actor = 'map-experience-reader';
const requests = [], errors = [];
let failingSearch = false, holdReopen = false, releaseReopen, holdSearch = false, releaseSearch, searchHeld;
const source = { provider: 'valhalla', data: 'OpenStreetMap', attribution: 'Controlled browser route fixture',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: null };
const bodyOf = async req => { let body = ''; for await (const chunk of req) body += chunk; return body ? JSON.parse(body) : {}; };
const server = createAppServer({
  root: resolve('dist'),
  api: async (req, res, url) => {
    const send = (value, status = 200) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const body = req.method === 'POST' ? await bodyOf(req) : {};
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      if (url.pathname === '/api/config') return send({
        version: 'map-experience-fixture', features: { catalog: true, guide: false, planner: true, pwa: true, routing: true },
        guide: { limits_enabled: false, daily_limit: null }, presence: { enabled: false, heartbeat_ms: 30000, window_ms: 90000 },
        routing: { enabled: true, modes: ['walk', 'car'], source, csrf_token: 'fixture-proof' },
        kakao: { enabled: true, csrf_token: 'fixture-proof' },
        discovery: { enabled: true, csrf_token: 'fixture-proof', categories: ['카페', '맛집', '숙소', '주차장'], page_size: 15, max_results: 45 },
      });
      if (url.pathname === '/api/catalog/status') return send({
        status: 'ready', total: originals.length, by_source: { sample: originals.length },
        categories: ['해변', '카페', '맛집', '숙소', '주차장'].map(id => ({ id, count: 15 })),
        stale: false, built_at: now(), photos_count: 0, hours_week_count: 0,
      });
      if (url.pathname === '/api/catalog/search') return send(catalog.search({
        q: url.searchParams.get('q') || '', category: url.searchParams.get('category') || '',
        offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 40),
      }));
      if (url.pathname === '/api/catalog/points') return send({ type: 'FeatureCollection', features: originals.map(item => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
        properties: { id: item.id, name: item.name, category: item.category, source_label: item.source_label },
      })) });
      if (url.pathname.startsWith('/api/catalog/places/')) return send(catalog.detail(decodeURIComponent(url.pathname.split('/').at(-1))) || {}, 200);
      if (url.pathname === '/api/kakao/search') {
        if (holdSearch) await new Promise(resolve => { releaseSearch = resolve; searchHeld?.(); });
        if (failingSearch) return send({ error: { code: 'kakao_unavailable' } }, 503);
        const all = body.query === '도착' ? [native.get('2001')] : body.query === '출발' ? [native.get('2002')]
          : [...native.values()].filter(item => Number(item.id) < 2000);
        const items = all.slice(((body.page || 1) - 1) * 15, (body.page || 1) * 15);
        return send(adapter.toSearch({
          items, total: all.length, pageable: all.length, page: body.page || 1, page_size: 15,
          end: (body.page || 1) * 15 >= all.length, truncated: false, queried_at: now(),
        }, body, actor));
      }
      if (url.pathname === '/api/kakao/detail') return send(adapter.detail(body.token, actor));
      if (url.pathname === '/api/kakao/reopen') {
        if (holdReopen) await new Promise(resolve => { releaseReopen = resolve; });
        const place = native.get(String(body.id).slice(6));
        return place ? send(adapter.detailFor(place, now(), actor)) : send({ error: { code: 'kakao_place_unavailable' } }, 404);
      }
      if (url.pathname === '/api/routes') {
        const points = body.stops.map(point => [point.lng, point.lat]);
        const legs = points.slice(1).map((point, index) => ({
          distance_m: 1000, duration_s: body.mode === 'walk' ? 800 : 120,
          coordinates: [points[index], [(points[index][0] + point[0]) / 2 + .0001, (points[index][1] + point[1]) / 2], point],
          steps: [{ instruction: '브라우저 시험 경로', distance_m: 1000, duration_s: body.mode === 'walk' ? 800 : 120, start_index: 0, end_index: 2 }],
        }));
        return send({ available: true, mode: body.mode, source, legs, coordinates: legs.flatMap((leg, index) => index ? leg.coordinates.slice(1) : leg.coordinates),
          distance_m: legs.length * 1000, duration_s: legs.reduce((sum, leg) => sum + leg.duration_s, 0),
          snapped: body.stops.map(point => ({ ...point, distance_m: 0 })), warnings: ['시험용 경로입니다.'], traffic: 'not_live' });
      }
      return send({ error: { code: 'fixture_unavailable' } }, 503);
    } catch (error) { errors.push(error.message); send({ error: { code: 'fixture_error' } }, 500); }
  },
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const report = { passed: false, checks: [], errors, controlledAPIs: true, modelCalls: 0 };
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__copied.push(value); } } });
    window.__geoMode = 'inside'; window.__geoCalls = 0;
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(ok, fail) {
      window.__geoCalls++;
      if (window.__geoMode === 'denied') fail({ code: 1 });
      else if (window.__geoMode === 'deferred') window.__finishLocation = () => ok({ coords: { latitude: 33.5, longitude: 126.8, accuracy: 20 } });
      else ok({ coords: { latitude: window.__geoMode === 'outside' ? 37.5 : 33.43, longitude: 126.49, accuracy: 20 } });
    } } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('catalog-points'), null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__geoCalls), 0);
  assert.equal(await page.locator('.sidebar-tabs [role="tab"]').count(), 4);
  const searchCount = () => requests.filter(request => request.path === '/api/kakao/search').length;
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')));
  await page.locator('#catalog-search').fill('카페');
  await page.locator('#catalog-search').press('Enter');
  await page.waitForSelector('[data-catalog-id="kakao:1001"]');
  for (let i = 0; i < 8; i++) {
    await page.locator('#catalog-search').press('ArrowDown');
    if (await page.evaluate(() => {
      const input = document.querySelector('#catalog-search');
      return document.getElementById(input.getAttribute('aria-activedescendant'))?.textContent.includes('카카오 카페 1001');
    })) break;
  }
  await page.locator('#catalog-search').press('Enter');
  await page.waitForFunction(() => document.querySelector('.detail-heading h2')?.textContent === '카카오 카페 1001');
  await page.locator('#detail-favorite').click();
  await page.waitForFunction(() => document.querySelector('#detail-favorite')?.getAttribute('aria-pressed') === 'true');
  const addressURL = page.url();
  await page.locator('[data-detail-action="copy-address"]').click();
  assert.equal(await page.evaluate(() => window.__copied.at(-1)), '카카오 도로 1001');
  assert.equal(page.url(), addressURL);
  await page.locator('[data-detail-action="share-place"]').click();
  const sharedURL = await page.evaluate(() => window.__copied.at(-1));
  assert.match(sharedURL, /atlas_place=kakao/);
  assert.doesNotMatch(sharedURL, /token|signature|trip=/);
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#tab-saved').click();
  const favorite = page.locator('[data-library-id="kakao:1001"]');
  await favorite.waitFor();
  await favorite.locator('[data-library-action="pin"]').click();
  await page.locator('[data-library-pinned="kakao:1001"]').waitFor();
  await page.locator('[data-library-filter]').fill('없는 장소');
  assert.equal(await page.locator('[data-library-id]').count(), 0);
  await page.locator('[data-library-reset]').click();
  await page.locator('[data-library-tab="recent"]').click();
  await page.locator('[data-library-id="kakao:1001"]').waitFor();
  await page.locator('[data-library-tab="queries"]').click();
  await page.locator('[data-library-query="카페"]').waitFor();
  const historyJSON = await page.evaluate(() => localStorage.getItem('jeju-atlas.browsing.v1'));
  assert.doesNotMatch(historyJSON, /selection_token|kakao_lookup/);
  report.checks.push('Search keyboard suggestions lead to verified detail, copy/share, recent records, favorites and pinned shortcuts');

  await page.locator('[data-library-query-open]').first().click();
  await page.waitForSelector('[data-catalog-id="kakao:1001"]');
  await page.locator('#catalog-search').blur();
  const canvas = page.locator('#map canvas').first();
  const bounds = await canvas.boundingBox();
  const beforePan = searchCount();
  await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .62, bounds.y + bounds.height * .43, { steps: 12 });
  await page.mouse.up();
  await page.locator('#map-search-area').waitFor();
  assert.equal(searchCount(), beforePan, 'Panning alone must not replace the result set');
  const areaResponse = page.waitForResponse(response => response.url().endsWith('/api/kakao/search')
    && response.request().postDataJSON()?.scope === 'view');
  await page.locator('#map-search-area').click();
  await areaResponse;
  await page.waitForFunction(() => document.querySelector('#catalog-list')?.getAttribute('aria-busy') !== 'true');
  assert.equal(requests.filter(request => request.path === '/api/kakao/search').at(-1).body.scope, 'view');
  await page.locator('[data-catalog-id="kakao:1001"]').hover();
  await page.waitForFunction(() => window.__JEJU_MAP__.getSource('catalog-preview').serialize().data.features.length === 1);
  await page.mouse.move(bounds.x + 60, bounds.y + 140);
  await page.waitForFunction(() => window.__JEJU_MAP__.getSource('catalog-preview').serialize().data.features.length === 0);
  const pan = async () => {
    await page.mouse.move(bounds.x + bounds.width * .58, bounds.y + bounds.height * .4);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .64, bounds.y + bounds.height * .42, { steps: 10 });
    await page.mouse.up();
    await page.locator('#map-search-area').waitFor();
  };
  const firstBounds = requests.filter(request => request.path === '/api/kakao/search').at(-1).body.bounds;
  await pan();
  const pageTwo = page.waitForResponse(response => response.url().endsWith('/api/kakao/search') && response.request().postDataJSON()?.page === 2);
  await page.locator('#catalog-next').click();
  await pageTwo;
  assert.deepEqual(requests.filter(request => request.path === '/api/kakao/search').at(-1).body.bounds, firstBounds,
    'Paging preserves the searched area until a new area search is requested');
  assert.equal(await page.locator('#map-search-area').isVisible(), true);
  holdSearch = true;
  const heldRequest = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The deferred area search did not start')), 20_000);
    timer.unref?.();
    searchHeld = () => { clearTimeout(timer); resolve(); };
  });
  const delayedArea = page.waitForResponse(response => response.url().endsWith('/api/kakao/search') && response.request().postDataJSON()?.page === 1);
  await Promise.all([page.locator('#map-search-area').click(), heldRequest]);
  assert.ok(releaseSearch);
  await pan();
  holdSearch = false; releaseSearch(); releaseSearch = undefined;
  await delayedArea;
  await page.waitForFunction(() => document.querySelector('#catalog-list')?.getAttribute('aria-busy') !== 'true');
  assert.equal(await page.locator('#map-search-area').isVisible(), true, 'An older area result cannot acknowledge a newer pan');
  failingSearch = true;
  const failedArea = page.waitForResponse(response => response.url().endsWith('/api/kakao/search') && response.status() === 503);
  await page.locator('#map-search-area').click();
  await failedArea;
  await page.locator('#catalog-retry').waitFor();
  assert.equal(await page.locator('#map-search-area').isVisible(), true, 'Failed area searches remain retryable');
  failingSearch = false;
  const freshArea = page.waitForResponse(response => response.url().endsWith('/api/kakao/search') && response.status() === 200);
  await page.locator('#map-search-area').click();
  await freshArea;
  await page.waitForFunction(() => document.querySelector('#map-search-area')?.hidden === true);
  report.checks.push('Map movement keeps results stable until explicit area search; list hover highlights the corresponding point');

  await page.locator('#tab-trip').click();
  await page.locator('[data-endpoint-query="destination"]').fill('도착');
  await page.locator('[data-endpoint-form="destination"] button[type="submit"]').click();
  await page.locator('[data-endpoint-results="destination"] button').first().click();
  await page.locator('[data-endpoint-pending]').waitFor();
  assert.equal((await saved()).stops.length, 0);
  await page.locator('[data-endpoint-query="origin"]').fill('출발');
  await page.locator('[data-endpoint-form="origin"] button[type="submit"]').click();
  await page.locator('[data-endpoint-results="origin"] button').first().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')).stops.length === 2);
  assert.deepEqual((await saved()).stops.map(place => place.id), ['kakao:2002', 'kakao:2001']);
  await page.waitForFunction(() => document.querySelectorAll('.route-actions').length > 0);
  await page.locator('[data-endpoint-reverse]').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')).stops[0]?.id === 'kakao:2001');
  assert.deepEqual((await saved()).stops.map(place => place.id), ['kakao:2001', 'kakao:2002']);
  assert.doesNotMatch(JSON.stringify(await saved()), /selection_token|kakao_lookup/);
  failingSearch = true;
  await page.locator('[data-endpoint-query="origin"]').fill('실패');
  await page.locator('[data-endpoint-form="origin"] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-endpoint-status="origin"]')?.dataset.state === 'error');
  assert.deepEqual((await saved()).stops.map(place => place.id), ['kakao:2001', 'kakao:2002']);
  failingSearch = false;
  report.checks.push('Destination-first search waits for an explicit start, routes both modes, reverses the itinerary and preserves stops on lookup failure');

  await page.locator('#tab-explore').click();
  await canvas.focus();
  await page.keyboard.press('Shift+F10');
  await page.locator('#map-point-menu').waitFor();
  await page.locator('[data-map-point-action="copy"]').click();
  assert.match(await page.evaluate(() => window.__copied.at(-1)), /^\d+\.\d+, \d+\.\d+$/);
  await page.mouse.click(bounds.x + bounds.width * .65, bounds.y + bounds.height * .35, { button: 'right' });
  await page.locator('#map-point-menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#map-point-menu').isVisible(), false);
  await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .35);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + bounds.width * .65 + 4, bounds.y + bounds.height * .35, { steps: 2 });
  await page.mouse.up({ button: 'right' });
  assert.equal(await page.locator('#map-point-menu').isVisible(), false, 'A 4px rotation must not become a context click');
  const bearing = await page.evaluate(() => window.__JEJU_MAP__.getBearing());
  await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .35);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + bounds.width * .75, bounds.y + bounds.height * .39, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  assert.equal(await page.locator('#map-point-menu').isVisible(), false);
  assert.notEqual(await page.evaluate(() => window.__JEJU_MAP__.getBearing()), bearing);
  await page.locator('#map-current-location').click();
  await page.waitForFunction(() => !document.querySelector('#map-current-location')?.disabled);
  assert.equal(await page.locator('.map-current-point').isVisible(), true);
  const location = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
  await page.evaluate(() => { window.__geoMode = 'outside'; });
  await page.locator('#map-current-location').click();
  await page.waitForFunction(() => !document.querySelector('#map-current-location')?.disabled);
  assert.deepEqual(await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray()), location);
  await page.evaluate(() => { window.__geoMode = 'denied'; });
  await page.locator('#map-current-location').click();
  await page.waitForFunction(() => !document.querySelector('#map-current-location')?.disabled);
  assert.deepEqual(await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray()), location);
  await page.evaluate(() => {
    window.__geoMode = 'deferred'; window.__gpsFlights = 0;
    const map = window.__JEJU_MAP__, original = map.flyTo.bind(map);
    map.flyTo = (...args) => { if (args[0]?.center?.[0] === 126.8) window.__gpsFlights++; return original(...args); };
  });
  await page.locator('#map-current-location').click();
  await page.mouse.move(bounds.x + bounds.width * .6, bounds.y + bounds.height * .4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .66, bounds.y + bounds.height * .4, { steps: 8 });
  await page.evaluate(() => window.__finishLocation());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.__gpsFlights), 0, 'A delayed location must not interrupt a held pan');
  await page.mouse.up();
  assert.equal(await page.locator('#map-current-location').isDisabled(), false);
  await canvas.focus();
  await page.keyboard.press('Shift+F10');
  await page.locator('[data-map-point-action="origin"]').click();
  await page.locator('.trip-place-name[data-id^="point:"]').click();
  await page.locator('#selected-copy-point').waitFor();
  assert.equal(await page.locator('#selected-catalog-detail').count(), 0);
  assert.equal(requests.some(request => request.path.includes('/api/catalog/places/point')), false);
  report.checks.push('Keyboard/right-click point actions preserve right-drag rotation; current location handles success, outside Jeju and denial without inventing coordinates');

  holdReopen = true;
  const tampered = new URL(sharedURL);
  tampered.searchParams.set('atlas_name', '조작된 링크 이름');
  tampered.searchParams.set('atlas_lat', '33.55');
  tampered.searchParams.set('atlas_lng', '126.8');
  const linked = await context.newPage();
  linked.on('pageerror', error => errors.push(error.message));
  await linked.goto(tampered.href, { waitUntil: 'domcontentloaded' });
  await linked.waitForFunction(() => document.querySelector('.detail-heading h2')?.textContent.includes('공유한 장소 확인'));
  assert.ok(releaseReopen, 'Shared links must verify the exact native ID');
  const beforeVerify = await linked.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
  assert.ok(Math.abs(beforeVerify[0] - 126.8) > .05);
  holdReopen = false; releaseReopen();
  await linked.waitForFunction(() => document.querySelector('.detail-heading h2')?.textContent === '카카오 카페 1001');
  assert.doesNotMatch(await linked.locator('#catalog-detail').innerText(), /조작된 링크 이름/);
  await linked.close();
  report.checks.push('A shared native link verifies its exact ID before using names or coordinates, and never trusts tampered hints');

  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('#tab-saved').innerText(), 'Saved');
  await page.locator('#tab-saved').click();
  await page.locator('[data-library-tab="queries"]').click();
  await page.locator('[data-library-clear="queries"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-library-query]').length === 0);
  assert.equal(await page.locator('[data-library-query]').count(), 0);
  assert.equal((await saved()).favorites.length, 1);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.locator('#drawer-toggle').click();
  assert.ok(await page.locator('#saved-panel').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: resolve(output, 'saved-mobile-en.png') });
  await page.locator('#tab-explore').click();
  await page.locator('[data-map-category="해변"]').click();
  assert.equal(await page.locator('#catalog-search').inputValue(), '', 'Category shortcuts clear a previous keyword');
  await page.waitForFunction(() => document.querySelector('#catalog-list')?.getAttribute('aria-busy') !== 'true');
  const visible = await page.evaluate(() => {
    const box = document.querySelector('#catalog-explorer').getBoundingClientRect();
    return [...document.querySelectorAll('#catalog-list .catalog-card')].filter(card => {
      const rect = card.getBoundingClientRect(); return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
    }).length;
  });
  assert.ok(visible >= 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(output, 'explore-mobile-en.png') });
  report.checks.push('English saved/history controls and mobile layout remain usable; clearing history leaves favorites intact');
  report.modelCalls = requests.filter(request => request.path === '/api/guide').length;
  assert.equal(report.modelCalls, 0);
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  report.searchRequests = requests.filter(request => request.path === '/api/kakao/search')
    .map(request => ({ query: request.body.query, scope: request.body.scope, category: request.body.category }));
  await browser.contexts()[0]?.pages()[0]?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  holdSearch = false; holdReopen = false;
  releaseSearch?.();
  releaseReopen?.();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.checkedAt = now();
  report.searches = requests.filter(request => request.path === '/api/kakao/search').length;
  report.routes = requests.filter(request => request.path === '/api/routes').length;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
