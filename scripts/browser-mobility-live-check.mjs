#!/usr/bin/env node
/**
 * Run only AFTER the parent confirms ECS stabilization:
 * node scripts/browser-mobility-live-check.mjs --run-live
 * No AWS SDK, model call, server management or replacement API responses.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
};
const PRIMARY = 'https://jeju-atlas.whchoi.net';
const SECONDARY = 'https://d2mznud99i2mdr.cloudfront.net';
const RELEASE = option('--release', 'release-20260911T013430Z');
const SOURCE_DATE = '2026-09-10T20:21:06Z';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(option('--output', join(root, '.local', `browser-mobility-live-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const POST_BUDGET = 24; // Per fresh context, below the service's 60/min limit.
const reference = [{ lng: 126.49302, lat: 33.50673 }, { lng: 126.52712, lat: 33.5117 }];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (value, message) => assert.ok(value, message);
const cleanError = error => String(error?.message ?? error).replace(/https?:\/\/\S+/g, '[url]')
  .replace(/(?:csrf|cookie|token|secret)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 600);
const report = {
  expected_release: RELEASE, expected_source_date: SOURCE_DATE,
  expected_images_from_parent: { web_prefix: '92f16ae', routing_prefix: 'bae4b2' },
  image_digest_verification: 'Not browser-verifiable; the deployment owner verifies container digests.',
  fixtures: { route: false, elevation: false, catalog: false, failure_injection: false },
  policy: { fresh_contexts: true, service_workers: 'block', max_posts_per_context: POST_BUDGET },
  models: { invoked: 0, blocked_requests: 0 }, hosts: [], checks: [], contexts: [], cleanup: {},
};
let browser;
const contexts = [], pending = new Set();
const flush = () => Promise.allSettled([...pending]);
const persist = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));

function validRoute(route, mode) {
  check(route?.available === true && route.mode === mode, 'Requested mode has no real route');
  check(route.source?.provider === 'valhalla' && route.source.data === 'OpenStreetMap'
    && route.source.data_updated_at === SOURCE_DATE && route.traffic === 'not_live', 'Unexpected route provenance/date');
  check(Number.isFinite(route.distance_m) && route.distance_m > 0
    && Number.isFinite(route.duration_s) && route.duration_s > 0, 'Invalid route metrics');
  check(Array.isArray(route.coordinates) && route.coordinates.length > 2 && route.coordinates.length <= 30_000,
    'Real bounded route geometry is missing');
  check(route.coordinates.every(point => Array.isArray(point) && point.length === 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && point[0] >= 126.15 && point[0] <= 126.98 && point[1] >= 33.1 && point[1] <= 33.6), 'Invalid route coordinates');
  check(Array.isArray(route.legs) && route.legs.length > 0, 'Missing route legs');
  return route;
}
const metrics = route => ({
  mode: route.mode, distance_m: route.distance_m, duration_s: route.duration_s,
  point_count: route.coordinates.length, geometry_sha256: hash(route.coordinates), legs: route.legs.length,
  instructions: route.legs.reduce((sum, leg) => sum + leg.steps.length, 0), source: route.source, traffic: route.traffic,
});
function tripURL() {
  const stops = reference.map((point, index) => ({
    id: `point:live-audit-${index}`, name: `운영 검증 위치 ${index + 1}`, name_en: `Live audit position ${index + 1}`,
    ...point, category: 'other', source: 'user_point', source_label: '사용자 지정 위치',
    base_note: '검증용 좌표이며 실제 장소 이름이 아닙니다.', summary: '', address: null, updated_at: null,
    sources: [], stay_min: index ? 45 : 30, geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
  }));
  return `${PRIMARY}/#trip=${Buffer.from(JSON.stringify({ v: 1, mode: 'car', stops })).toString('base64url')}`;
}
function planTime(seconds, locale, stay = 75) {
  const minutes = Math.ceil((seconds + stay * 60) / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return locale === 'ko' ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${hours} h${rest ? ` ${rest} min` : ''}`;
}
async function step(name, operation) {
  const entry = { name, started_at: new Date().toISOString(), passed: false };
  report.checks.push(entry);
  try { Object.assign(entry, await operation(), { passed: true }); }
  catch (error) { entry.error = cleanError(error); }
  entry.finished_at = new Date().toISOString();
  await persist();
  console.log(JSON.stringify({ check: name, passed: entry.passed, ...(entry.error ? { error: entry.error } : {}) }));
  return entry.passed;
}
async function newPage(name, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', serviceWorkers: 'block', acceptDownloads: true, ...options,
  });
  contexts.push(context);
  const audit = { name, posts: 0, budget_blocked: 0, unexpected_writes: 0, configs: [], statuses: [], page_errors: [] };
  report.contexts.push(audit);
  // Never fulfill or change a response. Interception is only a safety gate.
  await context.route('**/api/**', interception => {
    const request = interception.request(), path = new URL(request.url()).pathname;
    if (path === '/api/guide' || path.startsWith('/api/guide/')) {
      report.models.blocked_requests++;
      return interception.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (request.method() !== 'POST' || !['/api/routes', '/api/elevation'].includes(path)) {
        audit.unexpected_writes++;
        return interception.abort('blockedbyclient');
      }
      if (audit.posts >= POST_BUDGET) {
        audit.budget_blocked++;
        return interception.abort('blockedbyclient');
      }
      audit.posts++;
    }
    return interception.continue();
  });
  await context.addInitScript(() => {
    window.__MOBILITY_LIVE_AUDIT__ = { route: null, clears: 0, camera: [] };
    window.addEventListener('atlas:route-change', event => {
      window.__MOBILITY_LIVE_AUDIT__.route = event.detail?.route ?? null;
      if (!event.detail?.route) window.__MOBILITY_LIVE_AUDIT__.clears++;
    });
    window.addEventListener('atlas:camera-activity', event => {
      window.__MOBILITY_LIVE_AUDIT__.camera.push({ ...event.detail, hidden: document.hidden });
    });
  });
  const page = await context.newPage(), responses = [];
  let resolveConfig;
  const firstConfig = new Promise(resolve => { resolveConfig = resolve; });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => audit.page_errors.push(cleanError(error)));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!['/api/config', '/api/routes', '/api/elevation'].includes(path)) return;
    const job = (async () => {
      let data, input;
      try { data = await response.json(); } catch {}
      if (path === '/api/config') {
        audit.configs.push({
          status: response.status(),
          issued_cookie: Boolean(await response.headerValue('set-cookie')),
          request_had_cookie: Boolean(await response.request().headerValue('cookie')),
        });
        if (response.ok() && data) resolveConfig(data);
        return;
      }
      try { input = response.request().postDataJSON(); } catch {}
      // Bodies/proofs remain in memory. Saved reports contain only safe metrics.
      responses.push({ path, status: response.status(), data, input });
      const code = data?.error?.code ?? data?.code;
      audit.statuses.push({
        path, status: response.status(), mode: input?.mode, locale: input?.locale, stop_count: input?.stops?.length,
        ...(typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? { code } : {}),
      });
    })().finally(() => pending.delete(job));
    pending.add(job);
  });
  return { context, page, responses, audit, firstConfig };
}
async function config(fixture, manual = false) {
  let timer;
  let data;
  try {
    // Do not race the application's initial config GET with another cookie-
    // issuing request. The JSON-only secondary smoke has no application GET.
    data = manual ? await fixture.page.evaluate(() => fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json()))
      : await Promise.race([fixture.firstConfig, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Application config was not received')), 20_000);
      })]);
  } finally { clearTimeout(timer); }
  check(data.version === RELEASE, 'Config release differs; deployment is not stable');
  check(data.features?.routing && data.routing?.enabled, 'Public routing is disabled');
  check(data.routing.source?.data_updated_at === SOURCE_DATE
    && data.routing.modes.includes('walk') && data.routing.modes.includes('car'), 'Unexpected routing config');
  check(typeof data.routing.csrf_token === 'string' && data.routing.csrf_token.length > 0, 'Missing routing session proof');
  return data; // Never serialize this proof-bearing object into the report.
}
async function openTrip(page) {
  const drawer = page.locator('#drawer-toggle');
  if (await drawer.isVisible() && await drawer.getAttribute('aria-expanded') === 'false') await drawer.click();
  await page.locator('#tab-trip').click();
}
async function settled(page, count = 2) {
  await page.waitForFunction(count => document.querySelectorAll('#trip-stops > li').length === count
    && [...document.querySelectorAll('.route-mode-time')].every(node => !['idle', 'loading'].includes(node.dataset.routeState)),
  count, { timeout: 20_000 });
}
async function selected(fixture, mode) {
  const { page, responses } = fixture;
  await page.waitForFunction(mode => window.__MOBILITY_LIVE_AUDIT__?.route?.mode === mode, mode);
  await flush();
  const route = validRoute(await page.evaluate(() => window.__MOBILITY_LIVE_AUDIT__.route), mode);
  const real = responses.filter(entry => entry.path === '/api/routes' && entry.status === 200 && entry.data?.mode === mode).at(-1);
  check(real?.data.available && hash(real.data.coordinates) === hash(route.coordinates), 'UI route differs from actual HTTP response');
  await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('trip-route'), null, { timeout: 45_000 });
  const mapped = await page.evaluate(() => window.__JEJU_MAP__.getSource('trip-route').serialize().data.features[0]?.geometry.coordinates ?? []);
  check(hash(mapped) === hash(real.data.coordinates), 'Map coordinates differ from actual HTTP response');
  return route;
}
async function gpx(page, route, filename) {
  const waiting = page.waitForEvent('download');
  await page.locator('[data-action="route-gpx"]').click();
  await (await waiting).saveAs(join(output, filename));
  const text = await readFile(join(output, filename), 'utf8');
  const points = [...text.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(match => [Number(match[2]), Number(match[1])]);
  check(hash(points) === hash(route.coordinates) && !text.includes('<ele>'), 'GPX changed route coordinates or invented elevations');
  return { filename, point_count: points.length, geometry_sha256: hash(points) };
}
async function screenshot(page, filename) {
  await page.screenshot({ path: join(output, filename) });
  return filename;
}
async function terrainTab(page, tab) {
  if (await page.locator('#terrain-tools-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#terrain-tools-toggle').click();
  await page.locator(`#terrain-tab-${tab}`).click();
}

async function primaryChecks() {
  const fixture = await newPage('canonical-desktop', { permissions: ['clipboard-read', 'clipboard-write'] });
  const { page } = fixture;
  let shared, walking;
  const initial = await step('canonical_initial_quiet_map_and_catalog', async () => {
    await page.goto(PRIMARY, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#catalog-map-toggle');
    await config(fixture);
    await page.waitForFunction(() => window.__JEJU_MAP__?.getLayer('catalog-dots'), null, { timeout: 45_000 });
    check(!(await page.locator('#catalog-map-toggle').isChecked()), 'All catalog facilities are enabled on first visit');
    const visibility = await page.evaluate(() => ['catalog-dots', 'catalog-clusters'].map(id => window.__JEJU_MAP__.getLayoutProperty(id, 'visibility')));
    check(visibility.every(value => value === 'none'), 'Catalog layers are visible on a fresh initial map');
    check(fixture.audit.posts === 0, 'Initial browsing unexpectedly calculated routes/elevations');
    const status = await page.evaluate(() => fetch('/api/catalog/status', { cache: 'no-store' }).then(response => response.json()));
    check(status.status === 'ready' && status.total > 0, 'Public catalog is unavailable');
    return { catalog_count: status.total, visibility, screenshot: await screenshot(page, 'initial-quiet.png') };
  });
  check(initial, 'Initial public state failed; dependent requests were not started');

  const routed = await step('canonical_real_modes_map_gpx_share_and_no_403', async () => {
    await page.goto(tripURL(), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tab-trip');
    await openTrip(page);
    await settled(page);
    const car = await selected(fixture, 'car');
    check((await page.locator('.route-plan-total').textContent()).includes(planTime(car.duration_s, 'ko')), 'Car planned time is incorrect');
    const carGPX = await gpx(page, car, 'live-car.gpx');
    await page.locator('#trip-route-walk').check();
    walking = await selected(fixture, 'walk');
    check(walking.distance_m !== car.distance_m && hash(walking.coordinates) !== hash(car.coordinates),
      'Walk and drive did not return distinct actual routes');
    check((await page.locator('.route-plan-total').textContent()).includes(planTime(walking.duration_s, 'ko')), 'Walking planned time is incorrect');
    const walkGPX = await gpx(page, walking, 'live-walk.gpx');
    await page.locator('[data-action="route-fit"]').click();
    await page.locator('#trip-share').click();
    shared = await page.evaluate(() => navigator.clipboard.readText());
    const url = new URL(shared);
    check(url.origin === PRIMARY, 'Shared route points outside the service');
    const payload = JSON.parse(Buffer.from(new URLSearchParams(url.hash.slice(1)).get('trip'), 'base64url'));
    check(payload.v === 1 && payload.mode === 'walk' && payload.stops.length === 2, 'Shared v1 course/mode is incorrect');
    check(!fixture.audit.statuses.some(entry => entry.status === 403), 'Canonical CNAME routing still returns 403');
    return {
      car: metrics(car), walk: metrics(walking), gpx: [carGPX, walkGPX],
      share: { version: payload.v, mode: payload.mode, stops: payload.stops.length },
      screenshot: await screenshot(page, 'canonical-route-ko.png'),
    };
  });
  check(routed, 'Real public route verification failed');

  await step('canonical_english_real_elevation_and_dwell_preservation', async () => {
    await page.locator('#language-toggle').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await settled(page);
    const route = await selected(fixture, 'walk');
    check(route.legs.some(leg => leg.steps.some(step => /[A-Za-z]/.test(step.instruction))), 'Native English directions are missing');
    await terrainTab(page, 'route');
    await page.locator('#profile-load').click();
    await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#terrain-profile')?.dataset.state), null, { timeout: 20_000 });
    await flush();
    const elevation = fixture.responses.filter(entry => entry.path === '/api/elevation').at(-1);
    check(elevation?.status === 200 && elevation.data?.available, 'Actual public elevation request failed');
    const values = elevation.data.elevations_m;
    check(values.length === elevation.input.coordinates.length, 'Elevation sample correspondence is broken');
    const known = values.filter(value => value !== null);
    check(known.length > 0 && known.every(Number.isFinite) && known.some(value => value > 0), 'No real positive elevation values were returned');
    check(await page.locator('#terrain-profile').getAttribute('data-state') === 'ready', 'Elevation profile did not render');
    const before = { posts: fixture.audit.posts, clears: await page.evaluate(() => window.__MOBILITY_LIVE_AUDIT__.clears) };
    await page.locator('#trip-stops > li:first-child input[data-stay]').fill('35');
    await page.locator('#trip-stops > li:first-child input[data-stay]').dispatchEvent('change');
    const expected = planTime(route.duration_s, 'en', 80);
    await page.waitForFunction(expected => document.querySelector('.route-plan-total')?.textContent.includes(expected), expected);
    check(fixture.audit.posts === before.posts && await page.evaluate(() => window.__MOBILITY_LIVE_AUDIT__.clears) === before.clears,
      'Dwell edit recalculated the route or elevation');
    check(await page.locator('#terrain-profile').getAttribute('data-state') === 'ready', 'Dwell edit discarded the profile');
    return {
      samples: values.length, known: known.length, min_m: Math.min(...known), max_m: Math.max(...known),
      source: elevation.data.source, dwell_added_requests: 0,
      screenshot: await screenshot(page, 'canonical-elevation-en.png'),
    };
  });

  await step('canonical_real_3d_preview_and_terrain', async () => {
    await terrainTab(page, 'route');
    await page.bringToFront();
    await page.locator('#route-preview-start').click();
    const before = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
    await page.waitForFunction(before => JSON.stringify(window.__JEJU_MAP__.getCenter().toArray()) !== JSON.stringify(before),
      before, { timeout: 12_000 });
    const stopped = await page.evaluate(() => {
      const button = document.querySelector('#route-preview-start');
      if (button.getAttribute('aria-pressed') === 'true') button.click();
      return button.getAttribute('aria-pressed') === 'false';
    });
    check(stopped, 'Live route preview did not stop');
    await page.locator('#terrain-tab-places').click();
    check(await page.locator('[data-scene-id]').count() === 12, 'Expected twelve terrain scene choices');
    await page.locator('#scene-hallasan').click();
    await page.locator('#scene-actual').click();
    await page.waitForFunction(() => {
      const map = window.__JEJU_MAP__, height = map.queryTerrainElevation(map.getCenter());
      return !map.isMoving() && Number.isFinite(height) && height > 500;
    }, null, { timeout: 30_000 });
    const terrain = await page.evaluate(() => ({
      exaggeration: window.__JEJU_MAP__.getTerrain()?.exaggeration,
      height_m: window.__JEJU_MAP__.queryTerrainElevation(window.__JEJU_MAP__.getCenter()),
    }));
    check(terrain.exaggeration === 1, 'Actual-scale terrain was not restored');
    return { preview_moved: true, preview_stopped: true, terrain, screenshot: await screenshot(page, 'canonical-hallasan.png') };
  });

  await step('canonical_real_measurement_add_undo_clear', async () => {
    await terrainTab(page, 'measure');
    await page.locator('#measurement-toggle').click();
    const before = fixture.audit.posts;
    const canvas = await page.locator('.maplibregl-canvas').boundingBox();
    check(canvas, 'Map canvas is unavailable for measurement');
    for (const [x, y] of [[110, 0.58], [210, 0.66], [280, 0.57]]) {
      await page.mouse.click(canvas.x + x, canvas.y + canvas.height * y);
    }
    await page.waitForFunction(() => document.querySelector('#measurement-count')?.textContent.startsWith('3 /'));
    const coordinates = await page.evaluate(() => window.__JEJU_MAP__.getSource('measurement-line').serialize().data.geometry.coordinates);
    check(coordinates.length === 3, 'Measurement did not use three actual map clicks');
    const total = await page.locator('#measurement-total').textContent();
    check(total !== '0 m' && /Straight-line|직선/.test(await page.locator('#measurement-count').textContent()), 'Measurement is not labelled as a nonzero straight-line total');
    await page.locator('#measurement-undo').click();
    check((await page.locator('#measurement-count').textContent()).startsWith('2 /'), 'Measurement undo failed');
    await page.locator('#measurement-clear').click();
    check((await page.locator('#measurement-count').textContent()).startsWith('0 /'), 'Measurement clear failed');
    check(fixture.audit.posts === before, 'Straight-line measurement called routing or elevation');
    await page.locator('#measurement-toggle').click();
    return { initial_points: 3, displayed_total: total, undo_points: 2, cleared_points: 0, added_requests: 0,
      screenshot: await screenshot(page, 'canonical-measurement.png') };
  });

  await step('canonical_real_catalog_endpoint_controls', async () => {
    if (await page.locator('#terrain-tools-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#terrain-tools-close').click();
    const ids = ['osm:node/13830055813', 'osm:node/9813550151'];
    const records = [];
    for (let index = 0; index < ids.length; index++) {
      const place = await page.evaluate(id => fetch(`/api/catalog/places/${encodeURIComponent(id)}`, { cache: 'no-store' }).then(response => response.json()), ids[index]);
      check(place.id === ids[index] && typeof place.name === 'string', 'Actual catalog endpoint fixture is unavailable');
      records.push({ id: place.id, name: place.name, source: place.source });
      await page.locator('#tab-explore').click();
      await page.locator('#catalog-search').fill(place.name);
      await page.locator(`[data-catalog-id="${place.id}"]`).click();
      await page.locator(`#catalog-detail [data-detail-action="${index ? 'destination' : 'origin'}"]`).click();
      await settled(page, 3 + index);
    }
    check(await page.locator('#trip-stops > li:first-child').getAttribute('data-trip-id') === ids[0]
      && await page.locator('#trip-stops > li:last-child').getAttribute('data-trip-id') === ids[1], 'Catalog origin/destination controls did not update the course');
    const route = await selected(fixture, 'walk');
    return { catalog_endpoints: records, route: metrics(route), screenshot: await screenshot(page, 'canonical-catalog-endpoints.png') };
  });
  return shared;
}

async function mobileCheck(shared) {
  return step('canonical_mobile_share_locale_and_font', async () => {
    check(shared, 'No actual shared course was produced');
    const fixture = await newPage('canonical-mobile', { viewport: { width: 390, height: 844 } });
    const { page } = fixture;
    await page.goto(shared, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tab-trip');
    await config(fixture);
    await openTrip(page);
    await settled(page);
    const route = await selected(fixture, 'walk');
    check(await page.locator('#trip-route-walk').isChecked(), 'Shared walking mode was not restored');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflows horizontally');
    await page.evaluate(() => document.fonts.ready);
    check(/NanumSquare/.test(await page.locator('.trip-routing h3').evaluate(element => getComputedStyle(element).fontFamily)),
      'Routing UI lost the requested font family');
    const korean = await screenshot(page, 'mobile-route-ko.png');
    await page.locator('#language-toggle').click();
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await settled(page);
    await selected(fixture, 'walk');
    check((await page.locator('.route-plan-total').textContent()).includes(planTime(route.duration_s, 'en')), 'Mobile English duration is incorrect');
    const english = await screenshot(page, 'mobile-route-en.png');
    return { mode: route.mode, stops: 2, screenshots: [korean, english] };
  });
}

async function secondaryCheck() {
  return step('cloudfront_config_cookie_proof_real_routes_and_elevation', async () => {
    const fixture = await newPage('cloudfront-api-smoke');
    const { page } = fixture;
    // JSON health page avoids downloading a second full map, while browser
    // cookies/Origin/CSRF still exercise the actual CloudFront viewer hostname.
    await page.goto(`${SECONDARY}/healthz`, { waitUntil: 'domcontentloaded' });
    await config(fixture, true);
    const values = await page.evaluate(async points => {
      const config = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json());
      const headers = { 'Content-Type': 'application/json', 'X-Atlas-CSRF': config.routing.csrf_token };
      const results = [];
      for (const mode of ['walk', 'car']) {
        const response = await fetch('/api/routes', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
          body: JSON.stringify({ mode, locale: 'en', stops: points }),
        });
        results.push({ status: response.status, data: await response.json() });
      }
      const response = await fetch('/api/elevation', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers,
        body: JSON.stringify({ coordinates: points.map(point => [point.lng, point.lat]) }),
      });
      return { routes: results, elevation: { status: response.status, data: await response.json() } };
    }, reference);
    check(values.routes.every(value => value.status === 200), 'CloudFront viewer route request failed or returned 403');
    const walk = validRoute(values.routes[0].data, 'walk'), car = validRoute(values.routes[1].data, 'car');
    check(hash(walk.coordinates) !== hash(car.coordinates), 'CloudFront viewer returned identical walk/car geometry');
    check(values.elevation.status === 200 && values.elevation.data.available === true
      && values.elevation.data.elevations_m.length === 2, 'CloudFront viewer elevation request failed');
    return {
      routes: [metrics(walk), metrics(car)],
      elevation: { status: values.elevation.status, samples: 2, source: values.elevation.data.source },
      routing_posts: 2, elevation_posts: 1,
    };
  });
}

async function runLive() {
  report.started_at = new Date().toISOString();
  await mkdir(output, { recursive: true });
  try {
    // Fail closed before any routing POST if either viewer still serves the
    // previous release. This is not an automated deployment-wait/retry loop.
    for (const origin of [PRIMARY, SECONDARY]) {
      const response = await fetch(`${origin}/healthz`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      check(response.ok, 'Public health check failed');
      const health = await response.json();
      check(health.release === RELEASE, 'Unexpected release; wait for ECS/CloudFront stabilization before rerunning');
      report.hosts.push({ origin, release: health.release, status: response.status });
    }
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
      || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
    browser = await chromium.launch({
      executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
      headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
    });
    let shared;
    try { shared = await primaryChecks(); }
    catch (error) { report.primary_error = cleanError(error); }
    await mobileCheck(shared);
    await secondaryCheck();
  } catch (error) {
    report.fatal = cleanError(error);
  } finally {
    await flush();
    await Promise.allSettled(contexts.map(context => context.close()));
    if (browser) { await browser.close(); report.cleanup.browser_closed = true; }
    report.finished_at = new Date().toISOString();
    report.passed = !report.fatal && !report.primary_error && report.hosts.length === 2
      && report.checks.length === 8 && report.checks.every(entry => entry.passed)
      && report.models.blocked_requests === 0
      && report.contexts.every(context => context.posts <= POST_BUDGET && !context.budget_blocked
        && !context.unexpected_writes && !context.page_errors.length
        && context.statuses.every(entry => entry.status >= 200 && entry.status < 300));
    await persist();
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: join(output, 'report.json'), fatal: report.fatal }));
    if (!report.passed) process.exitCode = 1;
  }
}

if (args.includes('--run-live')) {
  await runLive();
} else {
  console.log(`Prepared only; no network or browser started. After ECS stabilization: node scripts/browser-mobility-live-check.mjs --run-live --release ${RELEASE}`);
}
