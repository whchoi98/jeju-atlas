import test from 'node:test';
import assert from 'node:assert/strict';

const enabled = process.env.RUN_ENDPOINT_BROWSER === '1';
let endpointModule;
try { endpointModule = await import('../src/endpoint-search.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const when = '2026-09-12T01:02:03.000Z';
const native = (id, name, lng) => ({
  id: `kakao:${id}`, provider_id: String(id), name, name_en: name,
  category: '카페', provider_category: '음식점 > 카페', category_code: 'CE7',
  lng, lat: 33.4, address: `제주 주소 ${id}`, summary: '', tags: [],
  source: 'Kakao Local', source_label: 'Kakao Local', base_note: '제공처 등록 정보',
  updated_at: when, region: null, avg_stay_min: null, url: `https://place.map.kakao.com/${id}`,
  phone: null, hours: null, distance_m: null, queried_at: when, selection_token: 'never-persist.fixture-proof',
});
const places = {
  start: native(123, 'Start café', 126.5),
  finish: native(456, 'Finish café', 126.55),
  replacement: native(789, 'Replacement café', 126.51),
  saved: { id: 'catalog:saved', name: '저장된 해변', name_en: 'Saved beach', lat: 33.42, lng: 126.54,
    category: '해변', address: '저장된 제주 주소', source: 'sample', source_label: '큐레이션 원자료',
    base_note: '원자료', summary: '', updated_at: '2026-09-10', sources: [
      { source: 'sample', url: 'https://example.test/beach', observed_at: '2026-09-10', license: 'fixture' },
    ] },
};
const source = { provider: 'valhalla', data: 'OpenStreetMap', attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: null };

async function capture(page, name) {
  const output = process.env.ENDPOINT_UI_ARTIFACT_DIR;
  if (!output) return;
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(output, { recursive: true });
  await page.locator('#trip-endpoint-search').screenshot({ path: join(output, name) });
}

async function fixture(t) {
  assert.equal(typeof endpointModule?.EndpointSearch, 'function');
  const { createServer: httpServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createServer } = await import('vite');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
    || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  const temp = await mkdtemp(join(tmpdir(), 'jeju-endpoint-ui-'));
  let vite, server, browser;
  t.after(async () => {
    await browser?.close();
    await vite?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  vite = await createServer({
    root: new URL('..', import.meta.url).pathname, configFile: false, envFile: false,
    cacheDir: join(temp, 'vite-cache'), server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const searches = [], routes = [];
  const document = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/explore.css">
    <body style="overflow:auto"><main id="trip" class="trip-panel" style="position:relative;width:360px;max-width:100vw;height:auto"></main><div id="unit-search" style="width:340px;max-width:100vw"></div>
    <script type="module">
      import { TripPlanner } from '/src/trip.ts';
      import { EndpointSearch } from '/src/endpoint-search.ts';
      import { setLocale } from '/src/i18n.ts';
      window.places = ${JSON.stringify(places)};
      window.notices = []; window.painted = []; window.pending = []; window.picked = [];
      window.planner = new TripPlanner(document.getElementById('trip'), {
        notify: value => window.notices.push(value), onChange() {}, onSelect() {},
        shareCamera: () => location.href, copy: async () => {},
        onRoute: route => window.painted.push(route),
        getMapCenter: () => ({lng:126.5,lat:33.4}), getRecentPlaces: () => [window.places.saved],
      });
      window.search = new EndpointSearch(document.getElementById('unit-search'), {
        getCenter: () => ({lng:126.5,lat:33.4}),
        getFavorites: () => [window.places.saved],
        getRecentPlaces: () => [window.places.saved, window.places.finish],
        onPick: async (kind, place) => { window.picked.push({kind,place}); return true; },
        onReverse() {}, onClearDraft() {},
        lookup: (query, center, signal, source) => new Promise((resolve,reject) => window.pending.push({query,center,signal,source,resolve,reject})),
      });
      window.setLocale = setLocale; window.ready = true;
    </script></body></html>`;
  server = httpServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost');
    if (path.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(document); return; }
    if (path.pathname === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ features: { routing: true },
        routing: { enabled: true, csrf_token: 'route-proof', modes: ['walk', 'car'], source },
        discovery: { enabled: true, csrf_token: 'search-proof',
          categories: ['맛집', '카페', '숙소', '주차장'], page_size: 15, max_results: 45 } }));
      return;
    }
    if (path.pathname === '/api/kakao/search') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      searches.push({ path: path.pathname, body });
      res.setHeader('Content-Type', 'application/json');
      if (body.query === 'failure') { res.statusCode = 503; res.end('{"error":{"code":"kakao_unavailable"}}'); return; }
      const item = body.query === 'replacement' ? places.replacement : places.start;
      res.end(JSON.stringify({ available: true, source: 'Kakao Local', ...body, items: [item],
        total: 1, pageable: 1, page_size: 15, has_more: false, truncated: false, queried_at: when }));
      return;
    }
    if (path.pathname === '/api/catalog/search') {
      searches.push({ path: path.pathname, query: path.searchParams.get('q') });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ items: [places.saved], total: 1, has_more: false }));
      return;
    }
    if (path.pathname === '/api/routes') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      routes.push(body);
      const coordinates = body.stops.map(({ lng, lat }) => [lng, lat]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ available: true, mode: body.mode, source, traffic: 'not_live',
        distance_m: 1000, duration_s: 300, coordinates, snapped: [], warnings: [],
        legs: coordinates.slice(1).map((point, i) => ({ distance_m: 1000, duration_s: 300,
          coordinates: [coordinates[i], point], steps: [] })) }));
      return;
    }
    vite.middlewares(req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  return { page, searches, routes, errors };
}

test('endpoint search submits explicitly, ignores stale completions and keeps inputs/results mounted', {
  skip: !enabled, timeout: 60_000,
}, async t => {
  const { page, searches, errors } = await fixture(t);
  const root = page.locator('#unit-search');
  const query = root.locator('[data-endpoint-query="origin"]');
  await query.fill('old query');
  assert.equal(await page.evaluate(() => window.pending.length), 0);
  await query.press('Enter');
  await page.waitForFunction(() => window.pending.length === 1);
  await query.fill('new query');
  await query.press('Enter');
  await page.waitForFunction(() => window.pending.length === 2);
  assert.equal(await page.evaluate(() => window.pending[0].signal.aborted), true);
  await page.evaluate(() => window.pending[1].resolve([window.places.replacement]));
  const result = root.locator('[data-endpoint-results="origin"] button');
  await result.waitFor();
  assert.match(await result.textContent(), /Replacement café/);
  await page.evaluate(async () => { window.pending[0].resolve([window.places.start]); await new Promise(resolve => setTimeout(resolve, 0)); });
  assert.match(await result.textContent(), /Replacement café/);
  await query.focus();
  await query.evaluate(input => { window.savedInput = input; input.setSelectionRange(2, 5); });
  await page.evaluate(() => window.search.update({ origin: window.places.start, destination: window.places.finish,
    pendingDestination: false, canReverse: true }));
  assert.equal(await query.evaluate(input => input === window.savedInput && input === document.activeElement && input.selectionStart === 2), true);
  await result.focus();
  await result.evaluate(button => { window.savedResult = button; });
  await page.evaluate(() => window.search.update({ origin: window.places.start, destination: window.places.finish,
    pendingDestination: false, canReverse: true }));
  assert.equal(await result.evaluate(button => button === window.savedResult && button === document.activeElement), true);
  await root.locator('[data-endpoint-source]').selectOption('catalog');
  assert.equal(await query.inputValue(), 'new query');
  assert.equal(await page.evaluate(() => window.pending.length), 2);
  await query.press('Enter');
  await page.waitForFunction(() => window.pending.length === 3);
  await page.evaluate(() => window.pending[2].reject(new Error('private-provider-detail')));
  await page.waitForFunction(() => document.querySelector('#unit-search [data-endpoint-status="origin"]').dataset.state === 'error');
  assert.doesNotMatch(await root.textContent(), /private-provider-detail/);
  await root.locator('[data-endpoint-shortcuts="destination"] summary').click();
  await root.locator('[data-endpoint-shortcuts="destination"] button').first().waitFor();
  assert.equal(await root.locator('[data-endpoint-shortcuts="destination"] button').count(), 2);
  await root.locator('[data-endpoint-shortcuts="destination"] button').last().click();
  assert.equal(await page.evaluate(() => window.picked[0].place.lng), places.finish.lng);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.picked)), /selection_token|fixture-proof/);
  await page.evaluate(() => window.setLocale('en'));
  assert.match(await root.locator('[data-endpoint-label="origin"]').textContent(), /Start/);
  assert.equal(await query.inputValue(), 'new query');
  assert.equal(searches.length, 0, 'the standalone controller must not make extra provider requests');
  assert.deepEqual(errors, []);
});

test('TripPlanner supports destination-first, stable route updates, explicit replacement, reversal and catalog fallback choice', {
  skip: !enabled, timeout: 60_000,
}, async t => {
  const { page, searches, routes, errors } = await fixture(t);
  const root = page.locator('#trip');
  await page.evaluate(() => window.planner.setDestination(window.places.finish));
  assert.deepEqual(await page.evaluate(() => window.planner.stops), []);
  assert.equal(await page.evaluate(() => window.planner.hasUnsavedChanges), true);
  assert.equal(routes.length, 0);
  assert.match(await root.locator('[data-endpoint-selected="destination"]').textContent(), /Finish café/);
  assert.doesNotMatch(await root.locator('[data-endpoint-selected="origin"]').textContent(), /Finish café/);
  assert.equal(await root.locator('[data-endpoint-pending]').isVisible(), true);
  await capture(page, 'destination-first-ko.png');
  const query = root.locator('[data-endpoint-query="origin"]');
  await query.fill('start');
  assert.equal(searches.length, 0);
  await query.press('Enter');
  const result = root.locator('[data-endpoint-results="origin"] button');
  await result.waitFor();
  assert.match(await result.textContent(), /Start café.*제주 주소 123.*Kakao Local/s);
  await query.focus();
  await query.evaluate(input => { window.tripInput = input; input.setSelectionRange(1, 3); });
  await page.evaluate(() => window.planner.setOrigin(window.places.start));
  await page.waitForFunction(() => window.planner.route !== null);
  assert.deepEqual(await page.evaluate(() => window.planner.stops.map(stop => stop.id)), ['kakao:123', 'kakao:456']);
  assert.equal(await query.evaluate(input => input === window.tripInput && input === document.activeElement && input.selectionStart === 1), true);
  assert.equal(await page.evaluate(() => window.planner.hasUnsavedChanges), false);
  await result.focus();
  await result.evaluate(button => { window.tripResult = button; });
  await page.evaluate(async () => { await window.planner.add(window.places.saved); await window.planner.setDestination(window.places.finish); });
  await page.waitForFunction(() => window.planner.route?.legs.length === 2);
  assert.equal(await result.evaluate(button => button === window.tripResult && button === document.activeElement), true);
  await root.locator('input[data-stay="catalog:saved"]').fill('95');
  await root.locator('input[data-stay="catalog:saved"]').dispatchEvent('change');
  await query.fill('replacement');
  await query.press('Enter');
  await result.waitFor();
  await result.click();
  await page.waitForFunction(() => window.planner.stops[0]?.id === 'kakao:789');
  assert.deepEqual(await page.evaluate(() => window.planner.stops.map(stop => stop.id)), ['kakao:789', 'catalog:saved', 'kakao:456']);
  assert.equal(await page.evaluate(() => window.planner.stops[1].stay_min), 95);
  const before = await page.evaluate(() => window.planner.stops);
  await root.locator('[data-endpoint-reverse]').click();
  await page.waitForFunction(() => window.planner.route && window.planner.stops[0]?.id === 'kakao:456');
  assert.deepEqual(await page.evaluate(() => window.planner.stops), [...before].reverse());
  assert.deepEqual(routes.at(-1).stops, before.map(({ lat, lng }) => ({ lng, lat })).reverse());
  await query.fill('failure');
  await query.press('Enter');
  await page.waitForFunction(() => document.querySelector('#trip [data-endpoint-status="origin"]').dataset.state === 'error');
  assert.equal(searches.filter(item => item.path === '/api/catalog/search').length, 0);
  const beforeSource = searches.length;
  await root.locator('[data-endpoint-source]').selectOption('catalog');
  assert.equal(await query.inputValue(), 'failure');
  assert.equal(searches.length, beforeSource);
  await query.press('Enter');
  await result.waitFor();
  assert.match(await result.textContent(), /저장된 해변/);
  assert.equal(searches.at(-1).path, '/api/catalog/search');
  assert.doesNotMatch(await page.evaluate(() => localStorage.getItem('jeju-atlas.saved.v1')), /selection_token|fixture-proof/);
  await page.evaluate(() => window.setLocale('en'));
  assert.match(await root.locator('[data-endpoint-label="destination"]').textContent(), /Finish/);
  assert.equal(await query.inputValue(), 'failure');
  assert.equal(await query.evaluate(input => getComputedStyle(input).fontFamily.includes('NanumSquare')), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await capture(page, 'endpoint-editor-en.png');
});
