import test from 'node:test';
import assert from 'node:assert/strict';

let routing;
try { routing = await import('../src/routing.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const source = {
  provider: 'valhalla', data: 'OpenStreetMap', attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: null,
};
const stops = [
  { id: 'a', name: '검증 장소 A', name_en: 'Fixture A', lng: 126.5, lat: 33.4, stay_min: 30 },
  { id: 'b', name: '검증 장소 B', name_en: 'Fixture B', lng: 126.51, lat: 33.41, stay_min: 45 },
];
const result = (mode, marker = 126.502) => ({
  available: true, mode, source, distance_m: mode === 'car' ? 2500 : 1600,
  duration_s: mode === 'car' ? 600 : 1200,
  coordinates: [[126.5, 33.4], [marker, 33.408], [126.51, 33.41]],
  legs: [{
    distance_m: mode === 'car' ? 2500 : 1600, duration_s: mode === 'car' ? 600 : 1200,
    coordinates: [[126.5, 33.4], [marker, 33.408], [126.51, 33.41]],
    steps: [{ instruction: '검증 도로를 따라 이동하세요.', distance_m: 2500, duration_s: 600, start_index: 0, end_index: 2 }],
  }],
  snapped: [], warnings: [], traffic: 'not_live',
});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferredPlanner() {
  assert.equal(typeof routing?.RoutingController, 'function', 'routing coordination must be implemented');
  const calls = [], painted = [], events = [];
  const controller = new routing.RoutingController({
    mode: 'car', onChange() {},
    onRoute(route) { painted.push(route); events.push(route ? route.mode : 'clear'); },
    request(body, signal) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      signal.addEventListener('abort', () => events.push('abort'));
      calls.push({ body, signal, resolve, reject });
      return promise;
    },
  });
  return { controller, calls, painted, events };
}

test('input changes clear the map before aborting and late generations cannot redraw it', async () => {
  const f = deferredPlanner();
  f.controller.setInput(stops, 'ko');
  assert.deepEqual(f.calls.map(call => call.body.mode).sort(), ['car', 'walk']);
  f.calls.find(call => call.body.mode === 'car').resolve(result('car'));
  await tick();
  assert.equal(f.controller.route.mode, 'car');
  f.events.length = 0;
  f.controller.setInput([...stops].reverse(), 'ko');
  assert.equal(f.controller.route, null);
  assert.equal(f.events[0], 'clear');
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls.find(call => call.body.mode === 'walk').resolve(result('walk', 126.503));
  await tick();
  assert.equal(f.controller.route, null);
  const latest = f.calls.at(-1).body;
  assert.deepEqual(latest.stops, [{ lng: 126.51, lat: 33.41 }, { lng: 126.5, lat: 33.4 }]);
});

test('one unavailable mode preserves the successful comparison and selecting it clears the map', async () => {
  const f = deferredPlanner();
  f.controller.setInput(stops, 'ko');
  f.calls.find(call => call.body.mode === 'car').resolve(result('car'));
  f.calls.find(call => call.body.mode === 'walk').resolve({ available: false, mode: 'walk', source, code: 'no_route' });
  await tick();
  assert.equal(f.controller.route.mode, 'car');
  f.controller.setMode('walk');
  assert.equal(f.controller.route, null);
  assert.equal(f.controller.states.car.status, 'success');
  assert.equal(f.controller.states.walk.status, 'unavailable');
  f.controller.setMode('car');
  assert.equal(f.controller.route.mode, 'car');
  assert.equal(f.calls.length, 2, 'completed comparisons do not need another request');
});

test('locale and mode changes cannot publish results in the old language or selected mode', async () => {
  const f = deferredPlanner();
  f.controller.setInput(stops, 'ko');
  f.controller.setMode('walk');
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve(result('walk'));
  f.calls[1].resolve(result('car'));
  await tick();
  assert.equal(f.controller.route, null);
  f.controller.setInput(stops, 'en');
  assert.equal(f.calls.at(-1).body.locale, 'en');
  const latest = f.calls.filter(call => !call.signal.aborted);
  latest.find(call => call.body.mode === 'walk').resolve(result('walk'));
  latest.find(call => call.body.mode === 'car').resolve(result('car'));
  await tick();
  assert.equal(f.controller.route.mode, 'walk');
});

test('route summaries use provider duration plus stays and GPX preserves road geometry without fake elevations', () => {
  assert.equal(typeof routing?.routePlanSeconds, 'function');
  assert.equal(routing.routePlanSeconds(result('car'), stops), 5100);
  assert.equal(routing.routeDuration(5100, 'ko'), '1시간 25분');
  assert.equal(routing.routeDuration(5100, 'en'), '1 h 25 min');
  assert.equal(routing.routeDistance(2500, 'en'), '2.5 km');
  const gpx = routing.routeGPX(result('car'), 'A & <B>', 'en');
  assert.match(gpx, /A &amp; &lt;B&gt;/);
  assert.match(gpx, /lat="33\.408" lon="126\.502"/);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 3);
  assert.doesNotMatch(gpx, /<ele>|live traffic data/i);
  assert.match(gpx, /OpenStreetMap/);
});

test('comparison cards distinguish engine failures and busy states from an actual absent route', () => {
  const f = deferredPlanner();
  f.controller.states.car = { status: 'error', code: 'routing_busy' };
  f.controller.states.walk = { status: 'unavailable', result: { available: false, mode: 'walk', source, code: 'no_route' } };
  const markup = routing.routingMarkup(f.controller, stops, 'en');
  assert.match(markup, /Busy/);
  assert.match(markup, /No route/);
  assert.match(routing.routeMessage('routing_busy', 'en'), /busy|requests/i);
  assert.match(routing.routeMessage('endpoint_unreachable', 'en'), /200|entrance|parking/i);
  f.controller.states.car = { status: 'error', code: 'network' };
  assert.match(routing.routingMarkup(f.controller, stops, 'en'), /Calculation failed/);
});

test('Trip UI compares routes, preserves v1 sharing, exports GPX, and handles user-selected origins', {
  skip: process.env.RUN_ROUTING_BROWSER !== '1',
  timeout: 90_000,
}, async t => {
  const { createServer: httpServer } = await import('node:http');
  const { mkdir, mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const { createServer } = await import('vite');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
    || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  const temp = await mkdtemp(join(tmpdir(), 'jeju-routing-ui-'));
  const root = new URL('..', import.meta.url).pathname;
  const vite = await createServer({
    root, configFile: false, envFile: false, cacheDir: join(temp, 'vite-cache'),
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  const requests = [];
  const fixturePlace = (id, name, name_en, point) => ({
    id, name, name_en, ...point, category: '관광지', source: 'sample', source_label: '큐레이션 원자료',
    base_note: 'Unverified fixture', address: null, summary: 'Test fixture', updated_at: null, sources: [],
    geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
  });
  const places = [
    fixturePlace('fixture:a', '검증 장소 A', 'Fixture A', { lng: 126.5, lat: 33.4 }),
    fixturePlace('fixture:b', '검증 장소 B', 'Fixture B', { lng: 126.51, lat: 33.41 }),
  ];
  const document = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/explore.css"></head>
    <body><main id="trip" class="trip-panel" style="position:relative;width:340px;max-width:100vw;height:100vh"></main>
    <script type="module">
      import { TripPlanner } from '/src/trip.ts';
      import { setLocale } from '/src/i18n.ts';
      window.places = ${JSON.stringify(places)};
      window.painted = []; window.notices = []; window.locationCalls = 0; window.denyLocation = false; window.fitCalls = 0;
      window.addEventListener('atlas:fit-route', () => { window.fitCalls++; });
      window.planner = new TripPlanner(document.getElementById('trip'), {
        notify: message => window.notices.push(message), onChange() {}, onSelect() {},
        shareCamera: () => location.href, copy: async url => { window.shared = url; },
        onRoute: route => window.painted.push(route),
        getMapCenter: () => ({lng:126.49,lat:33.405}),
        requestCurrentLocation: async () => { window.locationCalls++; if(window.denyLocation) throw new Error('location_denied'); return {lng:126.48,lat:33.4}; }
      });
      window.setLocale = setLocale; window.ready = true;
    </script></body></html>`;
  const server = httpServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(document); return; }
    if (req.url === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'route-fixture=ok; HttpOnly; SameSite=Lax; Path=/');
      res.end(JSON.stringify({ features: { routing: true }, routing: {
        enabled: true, csrf_token: 'fixture-proof', modes: ['walk', 'car'], source,
      } }));
      return;
    }
    if (req.url === '/api/routes') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ body, proof: req.headers['x-atlas-csrf'], cookie: req.headers.cookie });
      const route = result(body.mode);
      route.legs = body.stops.slice(1).map((stop, index) => ({
        ...route.legs[0],
        coordinates: [[body.stops[index].lng, body.stops[index].lat], [126.502, 33.408], [stop.lng, stop.lat]],
        steps: [{ instruction: body.locale === 'en' ? 'Turn left onto Fixture Road <script>window.injected=true</script>' : '검증 도로로 좌회전하세요.',
          distance_m: route.distance_m, duration_s: route.duration_s, start_index: 0, end_index: 2 }],
      }));
      route.coordinates = route.legs.flatMap((leg, index) => index ? leg.coordinates.slice(1) : leg.coordinates);
      route.distance_m *= route.legs.length;
      route.duration_s *= route.legs.length;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(route));
      return;
    }
    vite.middlewares(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  t.after(async () => {
    await browser.close();
    await vite.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => typeof window.planner.setOrigin), 'function');
  assert.equal(await page.evaluate(() => window.locationCalls), 0);
  await page.evaluate(async () => {
    await window.planner.setOrigin(window.places[0]);
    await window.planner.setDestination(window.places[1]);
  });
  await page.waitForFunction(() => window.planner.route?.mode === 'car');
  assert.equal(await page.locator('.route-mode').count(), 2);
  assert.match(await page.locator('.route-mode.is-selected').textContent(), /2\.5 km/);
  assert.match(await page.locator('.route-source').textContent(), /실시간 교통/);
  assert.match(await page.locator('.route-snap').textContent(), /확인되지/);
  await page.locator('[data-action="route-fit"]').click();
  assert.equal(await page.evaluate(() => window.fitCalls), 1);
  const cleared = await page.evaluate(() => {
    document.querySelector('button[data-action="up"][data-id="fixture:b"]').click();
    return { route: window.planner.route, painted: window.painted.at(-1) };
  });
  assert.deepEqual(cleared, { route: null, painted: null });
  await page.waitForFunction(() => window.planner.route && window.planner.stops[0]?.id === 'fixture:b');
  assert.deepEqual(await page.evaluate(() => window.planner.route.coordinates[0]), [126.51, 33.41]);
  await page.evaluate(() => window.planner.setOrigin(window.places[0]));
  await page.waitForFunction(() => window.planner.route && window.planner.stops[0]?.id === 'fixture:a');
  await page.waitForFunction(() => [...document.querySelectorAll('.route-mode-time')].every(node => node.dataset.routeState === 'success'));
  const requestsBeforeStay = requests.length;
  const clearsBeforeStay = await page.evaluate(() => window.painted.filter(route => route === null).length);
  await page.locator('input[data-stay="fixture:a"]').fill('30');
  await page.locator('input[data-stay="fixture:a"]').dispatchEvent('change');
  await page.locator('input[data-stay="fixture:b"]').fill('45');
  await page.locator('input[data-stay="fixture:b"]').dispatchEvent('change');
  await page.waitForFunction(() => window.planner.route?.mode === 'car' && window.planner.stops[1]?.stay_min === 45);
  assert.equal(requests.length, requestsBeforeStay, 'dwell-only changes must not spend route requests');
  assert.equal(await page.evaluate(() => window.painted.filter(route => route === null).length), clearsBeforeStay);
  assert.match(await page.locator('.route-plan-total').textContent(), /1시간 25분/);
  await page.evaluate(() => window.setLocale('en'));
  await page.waitForFunction(() => window.planner.route && document.querySelector('.route-mode-name')?.textContent === 'Walk');
  assert.match(await page.locator('.route-plan-total').textContent(), /1 h 25 min/);
  await page.locator('.route-legs summary').click();
  assert.match(await page.locator('.route-legs').textContent(), /Turn left onto Fixture Road/);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.locator('.route-legs script').count(), 0);
  await page.evaluate(() => window.planner.toggleFavorite(window.places[0]));
  assert.equal(await page.evaluate(() => window.notices.at(-1)), 'Saved to favorites.');
  await page.evaluate(() => document.fonts.ready);
  for (const selector of ['.trip-routing h3', '.trip-routing button', '.trip-stay input']) {
    assert.match(await page.locator(selector).first().evaluate(element => getComputedStyle(element).fontFamily), /NanumSquare/);
  }
  await page.locator('input[name="trip-route-mode"][value="walk"]').check();
  await page.waitForFunction(() => window.planner.route?.mode === 'walk');
  const download = page.waitForEvent('download');
  await page.locator('[data-action="route-gpx"]').click();
  const file = await download;
  const gpx = await readFile(await file.path(), 'utf8');
  assert.match(file.suggestedFilename(), /walk.*\.gpx$/);
  assert.match(gpx, /lat="33\.408" lon="126\.502"/);
  assert.doesNotMatch(gpx, /<ele>/);
  await page.locator('#trip-share').click();
  const shared = await page.evaluate(() => window.shared);
  const payload = JSON.parse(Buffer.from(new URLSearchParams(new URL(shared).hash.slice(1)).get('trip'), 'base64url'));
  assert.equal(payload.v, 1);
  assert.equal(payload.mode, 'walk');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeju-atlas.saved.v1')));
  assert.equal(saved.version, 1);
  assert.equal(saved.mode, undefined);
  const restored = await browser.newContext({ viewport: { width: 320, height: 720 } });
  const restoredPage = await restored.newPage();
  await restoredPage.goto(shared);
  await restoredPage.waitForFunction(() => window.planner?.route?.mode === 'walk');
  assert.equal(await restoredPage.locator('#trip-stops > li').count(), 2);
  assert.equal(await restoredPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const legacy = { ...payload };
  delete legacy.mode;
  const legacyContext = await browser.newContext();
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(`${base}/#trip=${Buffer.from(JSON.stringify(legacy)).toString('base64url')}`);
  await legacyPage.waitForFunction(() => window.planner?.route?.mode === 'car');
  assert.equal(await legacyPage.locator('#trip-stops > li').count(), 2);
  const invalidShare = await restoredPage.evaluate(encoded => {
    const before = JSON.stringify(window.planner.stops);
    location.hash = `trip=${encoded}`;
    return { accepted: window.planner.restoreShared(), same: before === JSON.stringify(window.planner.stops) };
  }, Buffer.from(JSON.stringify({ ...payload, mode: 'bus' })).toString('base64url'));
  assert.deepEqual(invalidShare, { accepted: false, same: true });
  await restoredPage.locator('#trip-route-walk').focus();
  await restoredPage.locator('#trip-route-walk').press('ArrowRight');
  await restoredPage.waitForFunction(() => window.planner.route?.mode === 'car');
  assert.equal(await restoredPage.locator('#trip-route-car').getAttribute('type'), 'radio');
  await restoredPage.locator('[data-action="route-map-origin"]').click();
  await restoredPage.waitForFunction(() => window.planner.stops[0]?.id.startsWith('point:'));
  assert.equal(await restoredPage.evaluate(() => window.planner.stops[0].source), 'user_point');
  assert.equal(await restoredPage.evaluate(() => window.planner.stops[0].updated_at), null);
  const point = await restoredPage.evaluate(() => window.planner.stops[0]);
  const pointStops = [point, {
    ...point, id: 'point:fixture-finish', lng: 126.51, lat: 33.42,
    geometry: { type: 'Point', coordinates: [126.51, 33.42] },
  }];
  const pointContext = await browser.newContext();
  const pointPage = await pointContext.newPage();
  await pointPage.goto(`${base}/#trip=${Buffer.from(JSON.stringify({ v: 1, mode: 'car', stops: pointStops })).toString('base64url')}`);
  await pointPage.waitForFunction(() => window.planner?.route?.mode === 'car');
  await pointPage.evaluate(() => window.planner.setOrigin(window.planner.stops[1]));
  assert.deepEqual(await pointPage.evaluate(() => window.planner.stops.map(stop => stop.id)), ['point:fixture-finish', point.id]);
  await pointPage.evaluate(() => window.planner.setOrigin(window.planner.stops[0]));
  assert.equal(await pointPage.evaluate(() => window.planner.stops.length), 2);
  await restoredPage.evaluate(() => { window.denyLocation = true; });
  await restoredPage.locator('[data-action="route-current-origin"]').click();
  await restoredPage.waitForFunction(() => window.locationCalls === 1 && window.notices.length > 0);
  assert.match(await restoredPage.evaluate(() => window.notices.at(-1)), /권한/);
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(request => request.proof === 'fixture-proof' && request.cookie?.includes('route-fixture=ok')));
  assert.ok(requests.every(request => request.body.stops.every(point => Object.keys(point).sort().join(',') === 'lat,lng')));
  assert.deepEqual(errors, []);
  if (process.env.ROUTING_UI_ARTIFACT_DIR) {
    await mkdir(process.env.ROUTING_UI_ARTIFACT_DIR, { recursive: true });
    await page.locator('.trip-panel').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: join(process.env.ROUTING_UI_ARTIFACT_DIR, 'routing-en.png') });
    await restoredPage.locator('.trip-panel').evaluate(element => { element.scrollTop = 0; });
    await restoredPage.screenshot({ path: join(process.env.ROUTING_UI_ARTIFACT_DIR, 'routing-ko-mobile.png') });
  }
});
