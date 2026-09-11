#!/usr/bin/env node
/** Standalone production UI + real localhost Valhalla audit. Never invokes AI. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Catalog } from '../server/catalog.mjs';
import { createRoutingService } from '../server/routing.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : fallback;
};
const output = resolve(option('--output', join(root, '.local', `browser-mobility-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const engine = 'http://127.0.0.1:8002';
const dataDate = '2026-09-10T20:21:06Z';
const catalogPath = resolve(root, '.local/catalog-standalone.sqlite');
const hgtPath = resolve(root, '.local/routing-data/elevation_data/N33/N33E126.hgt');
const reference = [{ lng: 126.49302, lat: 33.50673 }, { lng: 126.52712, lat: 33.5117 }];
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const check = (value, message) => assert.ok(value, message);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanError = error => String(error?.message ?? error).replace(/https?:\/\/\S+/g, '[url]')
  .replace(/(?:csrf|secret|token|cookie)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 800);
const report = {
  started_at: new Date().toISOString(), root, build: {}, sources: {}, cases: [],
  models: { configured: false, invoked: 0, blocked_browser_requests: 0 },
  processes: { native_engine_owned: false, native_engine_stopped: false },
  cleanup: {},
};
let web, webExit, browser, catalog, direct;
let base;
const contexts = [];
const routes = new Map();
const serverErrors = [];

async function availablePort(start = 8127) {
  for (let port = start; port < start + 20; port++) {
    const probe = createServer();
    const free = await new Promise(resolve => {
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error('No free loopback port in the requested range');
}
async function build() {
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    let exists = false;
    try { await access(join(root, name)); exists = true; } catch {}
    check(!exists, 'Build refused: a dotenv file would be read');
  }
  if (!args.includes('--skip-build')) {
    let log = '';
    const process = spawn('npm', ['run', 'build'], {
      cwd: root, env: { PATH: `${dirname(globalThis.process.execPath)}:${globalThis.process.env.PATH}`, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    report.processes.build_pid = process.pid;
    process.stdout.on('data', chunk => { log += chunk; });
    process.stderr.on('data', chunk => { log += chunk; });
    const code = await new Promise((resolve, reject) => {
      process.once('error', reject); process.once('exit', resolve);
    });
    await writeFile(join(output, 'build.log'), log);
    check(code === 0, 'Standalone production build failed; see build.log');
    report.build.executed = true;
  } else report.build.executed = false;
  report.build.index_sha256 = hash(await readFile(join(root, 'dist/index.html')));
}
async function startWeb() {
  const port = await availablePort(Number(option('--port', 8127)));
  base = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, ['server/server.mjs'], {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`, LANG: 'C.UTF-8', NODE_ENV: 'production',
      PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: base,
      STATIC_ROOT: join(root, 'dist'), CATALOG_LOCAL_PATH: catalogPath,
      ROUTING_URL: engine, ROUTING_DATA_UPDATED_AT: dataDate,
      ATLAS_SESSION_SECRET: randomBytes(32).toString('base64url'),
      RELEASE: 'mobility-native-browser-audit', DRAIN_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  report.processes.web_pid = web.pid;
  report.processes.web_port = port;
  webExit = new Promise(resolve => web.once('exit', (code, signal) => resolve({ code, signal })));
  web.stderr.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      try {
        const value = JSON.parse(line);
        if (typeof value.event === 'string') serverErrors.push({
          event: value.event, ...(Number.isInteger(value.status) ? { status: value.status } : {}),
          ...(typeof value.code === 'string' && /^[a-z_]+$/.test(value.code) ? { code: value.code } : {}),
        });
      } catch { /* Never persist unstructured service stderr or request details. */ }
    }
  });
  web.stdout.resume();
  for (let attempt = 0; attempt < 80; attempt++) {
    check(web.exitCode === null, 'Owned web process exited before becoming ready');
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Owned web process did not become healthy');
}
function pointStop(point, index, stay = 0) {
  return {
    id: `point:native-audit-${index}`, name: `검증 위치 ${index + 1}`, name_en: `Audit position ${index + 1}`,
    lng: point.lng, lat: point.lat, category: 'other', source: 'user_point',
    source_label: '사용자 지정 위치', base_note: '검증을 위해 선택한 좌표이며 실제 장소 이름이 아닙니다.',
    address: null, summary: '', updated_at: null, sources: [], stay_min: stay,
    geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
  };
}
const referenceStops = reference.map((point, index) => pointStop(point, index, index ? 45 : 30));
function share(stops, mode = 'car') {
  return `${base}/#trip=${Buffer.from(JSON.stringify({ v: 1, mode, stops })).toString('base64url')}`;
}
function routeSummary(route) {
  return {
    available: route.available, mode: route.mode, code: route.code,
    distance_m: route.distance_m, duration_s: route.duration_s,
    coordinates: route.coordinates?.length, geometry_sha256: route.coordinates ? hash(route.coordinates) : null,
    legs: route.legs?.length, instructions: route.legs?.reduce((sum, leg) => sum + leg.steps.length, 0),
    source: route.source, traffic: route.traffic,
  };
}
async function context(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', serviceWorkers: 'block',
    acceptDownloads: true, ...options,
  });
  contexts.push(context);
  await context.route('**/api/guide', route => {
    report.models.blocked_browser_requests++;
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    window.__MOBILITY_AUDIT__ = { route: null, clears: 0, events: 0, camera: [] };
    window.addEventListener('atlas:camera-activity', event => {
      window.__MOBILITY_AUDIT__.camera.push({ ...event.detail, hidden: document.hidden, time: performance.now() });
    });
    window.addEventListener('atlas:route-change', event => {
      window.__MOBILITY_AUDIT__.route = event.detail?.route ?? null;
      window.__MOBILITY_AUDIT__.events++;
      if (!event.detail?.route) window.__MOBILITY_AUDIT__.clears++;
    });
  });
  return context;
}
function trace(page) {
  const entries = [], pending = new Set(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(cleanError(error)));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (!['/api/routes', '/api/elevation'].includes(path)) return;
    const promise = (async () => {
      const request = response.request();
      let input;
      try { input = request.postDataJSON(); } catch {}
      let result;
      try { result = await response.json(); } catch {}
      entries.push({ path, status: response.status(), input, result });
    })().finally(() => pending.delete(promise));
    pending.add(promise);
  });
  return {
    entries, pageErrors,
    flush: () => Promise.allSettled([...pending]),
    summary: () => ({
      routes: entries.filter(entry => entry.path === '/api/routes').length,
      elevations: entries.filter(entry => entry.path === '/api/elevation').length,
      rate_limited: entries.filter(entry => entry.status === 429).length,
      statuses: entries.map(entry => ({ path: entry.path, status: entry.status, mode: entry.input?.mode, stops: entry.input?.stops?.length })),
    }),
  };
}
async function openTrip(page, url = base) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tab-trip');
  const drawer = page.locator('#drawer-toggle');
  if (await drawer.isVisible() && await drawer.getAttribute('aria-expanded') === 'false') await drawer.click();
  await page.locator('#tab-trip').click();
}
async function settled(page, count) {
  await page.waitForFunction(count => document.querySelectorAll('#trip-stops > li').length === count
    && [...document.querySelectorAll('.route-mode-time')].every(node => !['loading', 'idle'].includes(node.dataset.routeState)), count,
  { timeout: 20_000 });
}
async function selected(page, mode) {
  await page.waitForFunction(mode => window.__MOBILITY_AUDIT__?.route?.mode === mode, mode, { timeout: 20_000 });
  return page.evaluate(() => window.__MOBILITY_AUDIT__.route);
}
async function mapGeometry(page, route) {
  await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('trip-route'), null, { timeout: 45_000 });
  const points = await page.evaluate(() => window.__JEJU_MAP__.getSource('trip-route').serialize().data.features[0]?.geometry.coordinates ?? []);
  check(hash(points) === hash(route.coordinates), 'The rendered map geometry differs from the real routing response');
  return { point_count: points.length, geometry_sha256: hash(points) };
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(output, `${name}.png`) });
  return `${name}.png`;
}
async function saveGPX(page, name, route) {
  const download = page.waitForEvent('download');
  await page.locator('[data-action="route-gpx"]').click();
  const file = await download;
  await file.saveAs(join(output, name));
  const xml = await readFile(join(output, name), 'utf8');
  const points = [...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(match => [Number(match[2]), Number(match[1])]);
  check(hash(points) === hash(route.coordinates), 'GPX does not contain the actual selected road geometry');
  check(!xml.includes('<ele>'), 'GPX must not invent unsampled elevations');
  return { file: name, point_count: points.length, geometry_sha256: hash(points) };
}
async function caseCheck(name, operation, kind = 'native') {
  const selectedCases = option('--case', '').split(',').filter(Boolean);
  if (selectedCases.length && name !== 'native_reference_routes' && !selectedCases.includes(name)) return;
  const record = { name, kind, started_at: new Date().toISOString(), passed: false };
  report.cases.push(record);
  try { Object.assign(record, await operation(record), { passed: true }); }
  catch (error) { record.error = cleanError(error); }
  record.finished_at = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ check: name, passed: record.passed, ...(record.error ? { error: record.error } : {}) }));
}
async function hgtSample(lng, lat) {
  const info = await stat(hgtPath);
  const side = Math.sqrt(info.size / 2);
  check(Number.isInteger(side) && [1201, 3601].includes(side), 'Unexpected local HGT dimensions');
  const x = (lng - 126) * (side - 1), y = (34 - lat) * (side - 1);
  const column = Math.floor(x), row = Math.floor(y);
  const handle = await open(hgtPath, 'r');
  try {
    const sample = async (r, c) => {
      const bytes = Buffer.alloc(2);
      await handle.read(bytes, 0, 2, (r * side + c) * 2);
      return bytes.readInt16BE();
    };
    const values = await Promise.all([sample(row, column), sample(row, column + 1), sample(row + 1, column), sample(row + 1, column + 1)]);
    if (values.some(value => value === -32768)) return null;
    const dx = x - column, dy = y - row;
    return values[0] * (1 - dx) * (1 - dy) + values[1] * dx * (1 - dy)
      + values[2] * (1 - dx) * dy + values[3] * dx * dy;
  } finally { await handle.close(); }
}
async function profile(page, network) {
  if (await page.locator('#terrain-tools-toggle').getAttribute('aria-expanded') !== 'true') {
    await page.locator('#terrain-tools-toggle').click();
  }
  await page.locator('#terrain-tab-route').click();
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => ['ready', 'error'].includes(document.querySelector('#terrain-profile')?.dataset.state), null, { timeout: 20_000 });
  await network.flush();
  const response = network.entries.filter(entry => entry.path === '/api/elevation').at(-1);
  check(response?.status === 200 && response.result?.available === true, 'Real BFF elevation is unavailable');
  check(await page.locator('#terrain-profile').getAttribute('data-state') === 'ready', 'The native profile did not render');
  const raw = await fetch(`${engine}/height`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shape: response.input.coordinates.map(([lon, lat]) => ({ lon, lat })) }),
    signal: AbortSignal.timeout(10_000),
  }).then(response => response.json());
  const heights = raw.height ?? raw.heights;
  check(Array.isArray(heights) && heights.length === response.result.elevations_m.length, 'Native /height returned a different sample count');
  check(response.result.elevations_m.every((value, index) => value === null
    ? heights[index] == null || heights[index] === -32768 : Math.abs(value - heights[index]) < 0.02), 'BFF elevations differ from native HGT output');
  const known = response.result.elevations_m.filter(value => value !== null);
  check(known.length > 0 && known.some(value => value > 0), 'No real positive elevation samples were obtained');
  const checks = [];
  for (const index of [0, Math.floor(heights.length / 2), heights.length - 1]) {
    const [lng, lat] = response.input.coordinates[index];
    const local = await hgtSample(lng, lat);
    checks.push({ index, native_m: heights[index], hgt_bilinear_m: local });
    check(local !== null && Math.abs(local - heights[index]) <= 1.1, 'Native elevation does not agree with the supplied HGT tile');
  }
  return {
    samples: heights.length, known: known.length, min_m: Math.min(...known), max_m: Math.max(...known),
    source: response.result.source, hgt_checks: checks, coverage_text: await page.locator('#profile-coverage').textContent(),
  };
}
async function catalogPlace(page, place, action) {
  const drawer = page.locator('#drawer-toggle');
  if (await drawer.isVisible() && await drawer.getAttribute('aria-expanded') === 'false') await drawer.click();
  await page.locator('#tab-explore').click();
  await page.locator('#catalog-search').fill(place.name);
  await page.locator(`[data-catalog-id="${place.id}"]`).waitFor({ state: 'visible' });
  await page.locator(`[data-catalog-id="${place.id}"]`).click();
  await page.locator(`#catalog-detail [data-detail-action="${action}"]`).click();
}

try {
  await mkdir(output, { recursive: true });
  report.sources.catalog = { bytes: (await stat(catalogPath)).size, sha256: hash(await readFile(catalogPath)) };
  report.sources.hgt = { bytes: (await stat(hgtPath)).size, sha256: hash(await readFile(hgtPath)) };
  const native = await fetch(`${engine}/status`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  check(native.version === '3.8.3', 'Expected native Valhalla 3.8.3');
  report.sources.native = { version: native.version, tileset_last_modified: native.tileset_last_modified, available_actions: native.available_actions };
  await build();
  await startWeb();
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  report.processes.browser_owned = true;
  catalog = new Catalog({ localPath: catalogPath });
  await catalog.init();
  check(catalog.status().total === 6724, 'The audit must use the actual 6,724-place catalog');
  direct = createRoutingService({ url: engine, dataUpdatedAt: dataDate });
  await caseCheck('native_reference_routes', async () => {
    const evidence = [];
    for (const [mode, distance, seconds] of [['walk', 3885, 2770.64], ['car', 4571, 410.673]]) {
      const route = await direct.route({ mode, locale: 'ko', stops: reference });
      check(route.available && route.coordinates.length > 2, 'Native reference route is unavailable');
      check(Math.abs(route.distance_m - distance) < 2 && Math.abs(route.duration_s - seconds) < 1, 'Native reference metrics changed');
      check(route.legs[0].steps.some(step => /[가-힣]/.test(step.instruction)), 'Native Korean directions are missing');
      routes.set(mode, route);
      evidence.push(routeSummary(route));
    }
    return { routes: evidence };
  });

  let shared;
  await caseCheck('native_desktop_route_gpx_dem_and_3d', async record => {
    const ctx = await context({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page, share(referenceStops));
      await settled(page, 2);
      const config = await page.evaluate(() => fetch('/api/config', { credentials: 'same-origin' }).then(response => response.json()));
      check(config.features.guide === false && config.features.routing === true, 'Routing must be enabled independently of disabled AI');
      const car = await selected(page, 'car');
      check(hash(car.coordinates) === hash(routes.get('car').coordinates), 'UI car response differs from native reference');
      check((await page.locator('.route-plan-total').textContent()).includes('1시간 22분'), 'Stay-inclusive car time is incorrect');
      record.map = await mapGeometry(page, car);
      record.car = routeSummary(car);
      await page.locator('[data-action="route-fit"]').click();
      record.car_gpx = await saveGPX(page, 'native-car.gpx', car);
      await page.locator('#trip-route-walk').check();
      const walk = await selected(page, 'walk');
      check(hash(walk.coordinates) === hash(routes.get('walk').coordinates), 'UI walking response differs from native reference');
      check((await page.locator('.route-plan-total').textContent()).includes('2시간 2분'), 'Stay-inclusive walking time is incorrect');
      await mapGeometry(page, walk);
      record.walk = routeSummary(walk);
      record.walk_gpx = await saveGPX(page, 'native-walk.gpx', walk);
      await page.locator('#language-toggle').click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await settled(page, 2);
      const english = await selected(page, 'walk');
      check(english.legs[0].steps.some(step => /[A-Za-z]/.test(step.instruction)), 'Native English instructions are missing');
      record.english_instructions = english.legs[0].steps.length;
      await page.locator('#trip-share').click();
      shared = await page.evaluate(() => navigator.clipboard.readText());
      const payload = JSON.parse(Buffer.from(new URLSearchParams(new URL(shared).hash.slice(1)).get('trip'), 'base64url'));
      check(payload.mode === 'walk' && payload.stops.length === 2 && payload.v === 1, 'Share did not retain mode and v1 stops');
      record.share = { version: payload.v, mode: payload.mode, stops: payload.stops.length };
      record.elevation = await profile(page, network);
      record.profile_screenshot = await screenshot(page, 'native-dem-profile');
      const beforeDwell = { routes: network.entries.filter(entry => entry.path === '/api/routes').length,
        elevations: network.entries.filter(entry => entry.path === '/api/elevation').length,
        clears: await page.evaluate(() => window.__MOBILITY_AUDIT__.clears) };
      await page.locator('#trip-stops > li:first-child input[data-stay]').fill('35');
      await page.locator('#trip-stops > li:first-child input[data-stay]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('.route-plan-total')?.textContent.includes('2 h 7 min'));
      await network.flush();
      check(network.entries.filter(entry => entry.path === '/api/routes').length === beforeDwell.routes
        && network.entries.filter(entry => entry.path === '/api/elevation').length === beforeDwell.elevations
        && await page.evaluate(() => window.__MOBILITY_AUDIT__.clears) === beforeDwell.clears,
      'Dwell-only change recalculated the route or elevation');
      check(await page.locator('#terrain-profile').getAttribute('data-state') === 'ready', 'Dwell-only change discarded the real profile');
      record.dwell_change = { requests_added: 0, route_clears: 0, profile_retained: true };
      await page.bringToFront();
      await page.locator('#route-preview-start').click();
      const before = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
      try {
        await page.waitForFunction(before => JSON.stringify(window.__JEJU_MAP__.getCenter().toArray()) !== JSON.stringify(before),
          before, { timeout: 3000 });
      } catch { /* Record camera activity before reporting the failed movement assertion. */ }
      const after = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
      record.preview_diagnostic = await page.evaluate(() => ({
        pressed: document.querySelector('#route-preview-start')?.getAttribute('aria-pressed'),
        hidden: document.hidden, activity: window.__MOBILITY_AUDIT__.camera.slice(-12),
        reduced_motion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      }));
      check(hash(before) !== hash(after), '3D preview did not move the real map camera');
      const stop = await page.evaluate(() => {
        const button = document.querySelector('#route-preview-start');
        // Inspect and act in one browser turn: software-rendered terrain can
        // finish playback while Playwright is waiting to dispatch a pointer.
        const running = button.getAttribute('aria-pressed') === 'true';
        if (running) button.click();
        return { was_running: running, stopped: button.getAttribute('aria-pressed') === 'false' };
      });
      check(stop.stopped, 'Route preview did not stop');
      record.preview = { moved: true, ...stop };
      record.screenshot = await screenshot(page, 'native-desktop-profile');
      await page.locator('#terrain-tab-places').click();
      check(await page.locator('[data-scene-id]').count() === 12, 'Twelve real terrain scene controls are missing');
      await page.locator('#scene-hallasan').click();
      await page.locator('#scene-actual').click();
      await page.waitForFunction(() => !window.__JEJU_MAP__.isMoving(), null, { timeout: 10_000 });
      await page.waitForFunction(() => {
        const map = window.__JEJU_MAP__, height = map.queryTerrainElevation(map.getCenter());
        return Number.isFinite(height) && height > 500;
      }, null, { timeout: 30_000 });
      record.terrain = await page.evaluate(() => ({
        exaggeration: window.__JEJU_MAP__.getTerrain()?.exaggeration,
        center_height_m: window.__JEJU_MAP__.queryTerrainElevation(window.__JEJU_MAP__.getCenter()),
      }));
      check(record.terrain.exaggeration === 1, 'The actual-scale control did not restore terrain scale');
      record.terrain_screenshot = await screenshot(page, 'native-hallasan-dem');
      check(network.pageErrors.length === 0, 'Production page emitted a JavaScript error');
    } finally { await network.flush(); record.network = network.summary(); record.page_errors = network.pageErrors; await ctx.close(); }
  });

  await caseCheck('native_mobile_share_restore', async record => {
    check(shared, 'The native desktop share was not produced');
    const ctx = await context({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page, shared);
      await settled(page, 2);
      const route = await selected(page, 'walk');
      await mapGeometry(page, route);
      check(await page.locator('#trip-route-walk').isChecked(), 'The shared walking mode was not restored');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile content overflows horizontally');
      await page.locator('#language-toggle').click();
      await settled(page, 2);
      await selected(page, 'walk');
      check((await page.locator('.route-plan-total').textContent()).includes('2 h 2 min'), 'English mobile planned duration is wrong');
      record.screenshot = await screenshot(page, 'native-mobile-route');
      record.route = routeSummary(route);
      check(network.pageErrors.length === 0, 'Mobile production page emitted a JavaScript error');
    } finally { await network.flush(); record.network = network.summary(); await ctx.close(); }
  });

  const nearby = catalog.search({ q: '', lat: reference[0].lat, lng: reference[0].lng, radius_m: 5000, limit: 50 }).items;
  const named = nearby.filter(place => place.name && !['주차장'].includes(place.category)).slice(0, 12);
  await caseCheck('native_catalog_origin_destination_and_permission_denial', async record => {
    check(named.length >= 2, 'Not enough actual local catalog places for endpoint controls');
    const ctx = await context();
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page);
      await catalogPlace(page, named[0], 'origin');
      await catalogPlace(page, named[1], 'destination');
      await settled(page, 2);
      const route = await selected(page, 'car');
      record.endpoints = named.slice(0, 2).map(({ id, name, source }) => ({ id, name, source }));
      record.route = routeSummary(route);
      await mapGeometry(page, route);
      const session = await ctx.newCDPSession(page);
      await session.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: base });
      await page.locator('[data-action="route-current-origin"]').click();
      await page.waitForFunction(() => !document.querySelector('#toast').hidden
        && /권한|위치|permission|position/i.test(document.querySelector('#toast').textContent));
      record.permission_message = await page.locator('#toast').textContent();
      check(/권한|permission/i.test(record.permission_message), 'Denied geolocation did not produce the permission-specific message');
      record.screenshot = await screenshot(page, 'native-endpoints-permission');
    } finally { await network.flush(); record.network = network.summary(); await ctx.close(); }
  }, 'native_with_browser_permission_control');

  await caseCheck('native_no_route_never_draws_a_straight_fallback', async record => {
    const ctx = await context();
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page, share([pointStop(reference[0], 0), pointStop({ lng: 126.2, lat: 33.2 }, 1)]));
      await settled(page, 2);
      await network.flush();
      const results = network.entries.filter(entry => entry.path === '/api/routes');
      check(results.length === 2 && results.every(entry => entry.result?.available === false), 'Expected native unconnected endpoints');
      check(await page.evaluate(() => window.__MOBILITY_AUDIT__.route === null), 'An unavailable native route remained selected');
      check(await page.locator('[data-action="route-gpx"]').count() === 0, 'Unavailable route can still export a fabricated GPX');
      await page.waitForFunction(() => window.__JEJU_MAP__?.getSource('trip-route'), null, { timeout: 45_000 });
      check(await page.evaluate(() => window.__JEJU_MAP__.getSource('trip-route').serialize().data.features.length === 0), 'Failure left a straight line on the map');
      record.results = results.map(entry => ({ mode: entry.input.mode, status: entry.status, code: entry.result?.code }));
      record.screenshot = await screenshot(page, 'native-no-route');
    } finally { await network.flush(); record.network = network.summary(); await ctx.close(); }
  });

  await caseCheck('native_twelve_stop_share', async record => {
    const path = routes.get('car')?.coordinates;
    check(path?.length >= 12, 'Native reference geometry was not acquired');
    const stops = Array.from({ length: 12 }, (_, index) => {
      const [lng, lat] = path[Math.round(index * (path.length - 1) / 11)];
      return pointStop({ lng, lat }, index);
    });
    const ctx = await context({ reducedMotion: 'reduce' });
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page, share(stops));
      await settled(page, 12);
      const route = await selected(page, 'car');
      check(route.legs.length === 11, 'Native twelve-stop trip did not produce eleven legs');
      await mapGeometry(page, route);
      record.route = routeSummary(route);
      record.screenshot = await screenshot(page, 'native-twelve-stop-share');
    } finally { await network.flush(); record.network = network.summary(); await ctx.close(); }
  });

  await caseCheck('native_interactive_twelve_stop_rate_budget', async record => {
    check(named.length === 12, 'Twelve actual catalog places are required');
    const ctx = await context({ reducedMotion: 'reduce' });
    const page = await ctx.newPage(), network = trace(page);
    try {
      await openTrip(page);
      for (let index = 0; index < named.length; index++) {
        await catalogPlace(page, named[index], index ? 'destination' : 'origin');
        await page.waitForFunction(count => document.querySelectorAll('#trip-stops > li').length === count, index + 1);
        if (index) await settled(page, index + 1);
        await network.flush();
        if (!record.first_rate_limit_stop && network.entries.some(entry => entry.status === 429)) {
          record.first_rate_limit_stop = index + 1;
          record.rate_limit_feedback = await page.locator('.route-feedback').textContent();
          record.rate_limit_screenshot = await screenshot(page, 'native-interactive-first-429');
        }
      }
      record.saved_stops = await page.locator('#trip-stops > li').count();
      record.screenshot = await screenshot(page, 'native-twelve-stop-interactive');
      record.feedback = await page.locator('.route-feedback').textContent();
      check(!record.first_rate_limit_stop, 'Normal interactive twelve-stop planning hits the per-actor rate limit; no sixty-second wait was used');
      const route = await selected(page, 'car');
      check(route.legs.length === 11, 'Interactive twelve-stop planning did not finish');
      record.route = routeSummary(route);
    } finally { await network.flush(); record.network = network.summary(); await ctx.close(); }
  });

  await caseCheck('native_late_response_cancellation', async record => {
    const ctx = await context();
    const page = await ctx.newPage(), network = trace(page);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let held = 0;
    try {
      await openTrip(page, share(referenceStops));
      await settled(page, 2);
      const original = await selected(page, 'car');
      await mapGeometry(page, original);
      await page.route('**/api/routes', async interception => {
        const body = interception.request().postDataJSON();
        const reverse = body.stops[0].lng === reference[1].lng;
        try {
          const response = await interception.fetch();
          if (reverse) { held++; await gate; }
          await interception.fulfill({ response });
        } catch { /* A cancelled browser request cannot be fulfilled later. */ }
      });
      const cleared = await page.evaluate(() => {
        document.querySelector('#trip-stops > li:nth-child(2) [data-action="up"]').click();
        return window.__MOBILITY_AUDIT__.route === null;
      });
      check(cleared, 'Reordering did not clear the route synchronously');
      for (let count = 0; count < 750 && held < 2; count++) await sleep(20);
      record.held_native_responses = held;
      check(held === 2, 'Could not acquire both real reversed responses for the delay test');
      await page.locator('#trip-stops > li:nth-child(2) [data-action="up"]').click();
      await settled(page, 2);
      const latest = await selected(page, 'car');
      check(hash(latest.coordinates) === hash(original.coordinates), 'Restored input did not restore the real reference route');
      release();
      await sleep(200);
      check(hash((await selected(page, 'car')).coordinates) === hash(original.coordinates), 'A late response replaced the current geometry');
      record.map = await mapGeometry(page, original);
      record.transport_control = 'Two actual BFF/native responses delayed; no geometry fixture or response replacement';
    } finally { release(); await network.flush(); record.network = network.summary(); await ctx.close(); }
  }, 'native_with_transport_delay');
} catch (error) {
  report.fatal = cleanError(error);
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  if (browser) { await browser.close().catch(() => {}); report.cleanup.browser_closed = true; }
  catalog?.close(); direct?.close();
  if (web) {
    if (web.exitCode === null && web.signalCode === null) web.kill('SIGTERM');
    let exited = await Promise.race([webExit, sleep(5000).then(() => null)]);
    if (!exited) { web.kill('SIGKILL'); exited = await webExit; }
    report.cleanup.web = exited;
  }
  try {
    report.cleanup.catalog_unchanged = report.sources.catalog.sha256 === hash(await readFile(catalogPath));
    report.cleanup.hgt_unchanged = report.sources.hgt.sha256 === hash(await readFile(hgtPath));
    const response = await fetch(`${engine}/status`, { signal: AbortSignal.timeout(5000) });
    report.cleanup.parent_native_engine_running = response.ok;
  } catch { report.cleanup.parent_native_engine_running = false; }
  report.server_diagnostics = serverErrors;
  report.finished_at = new Date().toISOString();
  report.full_coverage = !option('--case', '');
  report.passed = !report.fatal && report.cases.length > 0 && report.cases.every(record => record.passed)
    && report.models.blocked_browser_requests === 0 && report.cleanup.catalog_unchanged
    && report.cleanup.hgt_unchanged && report.cleanup.parent_native_engine_running;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.cases.length, report: join(output, 'report.json'), fatal: report.fatal }));
  if (!report.passed) process.exitCode = 1;
}
