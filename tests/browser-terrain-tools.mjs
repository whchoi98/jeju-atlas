import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Full built app and real public terrain; the catalog/routing/elevation BFFs are
// controlled fixtures. This test never invokes a model or an AWS account API.
const root = resolve(process.env.STATIC_ROOT || 'dist');
const output = resolve(process.argv[2] || '.local/browser-terrain-tools');
await mkdir(output, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.geojson': 'application/geo+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, path === '/' ? 'index.html' : `.${path}`);
    if (!file.startsWith(root + sep)) throw new Error('path');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  window.terrainTestEvents = [];
  const record = event => {
    const entry = event.type === 'atlas:camera-activity'
      ? { event: event.type, kind: event.detail.kind, running: event.detail.running }
      : { event: event.type, target: event.target.id || event.target.tagName };
    window.terrainTestEvents.push(entry);
    if (window.terrainTestEvents.length > 40) window.terrainTestEvents.shift();
  };
  window.addEventListener('atlas:camera-activity', record);
  document.addEventListener('pointerdown', record, true);
});
const checks = [], errors = [], elevationCalls = [], catalogDetails = [];
let terrainResponses = 0, imageryResponses = 0, modelCalls = 0;
let elevationMode = 'partial', releaseElevation;
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() !== 200) return;
  if (response.url().includes('/terrarium/')) terrainResponses++;
  if (response.url().includes('World_Imagery/MapServer')) imageryResponses++;
});
const routeSource = {
  provider: 'valhalla', data: 'OpenStreetMap', attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: '2026-09-10T00:00:00Z',
};
const coordinates = [[126.4, 33.3], [126.4, 33.301], [126.401, 33.301], [126.401, 33.302]];
const routeFixture = {
  available: true, mode: 'walk', source: routeSource, coordinates, distance_m: 310, duration_s: 250,
  legs: [{ coordinates, distance_m: 310, duration_s: 250,
    steps: [{ instruction: 'Controlled route fixture', distance_m: 310, duration_s: 250, start_index: 0, end_index: 3 }] }],
  snapped: [{ lng: 126.4, lat: 33.3, distance_m: 0 }, { lng: 126.401, lat: 33.302, distance_m: 0 }],
  warnings: [], traffic: 'not_live',
};
const place = {
  id: 'poi_0008', name: '성산일출봉', name_en: 'Seongsan Ilchulbong', category: '오름',
  lng: 126.9425, lat: 33.4581, address: '제주 테스트 주소', summary: 'Controlled catalog fixture',
  source: 'sample', source_label: 'UI fixture', base_note: 'Controlled browser test', tags: [],
  updated_at: null, region: null, avg_stay_min: null, url: null, phone: null, hours: null, distance_m: null,
  photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null,
  menu: [], business_status: null, tips: null, sources: [], enriched_at: null,
};
await context.route('**/api/**', async intercepted => {
  const request = intercepted.request(), path = new URL(request.url()).pathname;
  const reply = (data, status = 200) => intercepted.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  if (path === '/api/guide') { modelCalls++; return reply({ code: 'model_disabled' }, 503); }
  if (path === '/api/config') return reply({
    version: 'terrain-tools-fixture', features: { catalog: true, guide: false, planner: true, pwa: false, routing: true },
    guide: { daily_limit: 30 }, routing: { enabled: true, modes: ['walk', 'car'], csrf_token: 'fixture-proof', source: routeSource },
  });
  if (path === '/api/elevation') {
    const body = request.postDataJSON();
    elevationCalls.push({ body, proof: request.headers()['x-atlas-csrf'] });
    const mode = elevationMode;
    if (mode === 'delay') await new Promise(resolve => { releaseElevation = resolve; });
    if (mode === 'error') return reply({ code: 'elevation_unavailable' }, 503);
    const elevations_m = body.coordinates.map((_point, index) =>
      mode === 'partial' && index === Math.floor(body.coordinates.length / 2) ? null : index * 3);
    return reply({
      available: true, elevations_m,
      source: { name: 'Controlled elevation fixture', url: 'https://registry.opendata.aws/terrain-tiles/' },
    }).catch(() => {});
  }
  if (path === '/api/routes') return reply({ ...routeFixture, mode: request.postDataJSON().mode });
  if (path === '/api/catalog/status') return reply({
    status: 'ready', total: 1, by_source: { sample: 1 }, categories: [{ id: '오름', count: 1 }],
    built_at: null, refreshed_at: null, stale: false, attribution: 'UI fixture', photos_count: 0, hours_week_count: 0,
  });
  if (path === '/api/catalog/search') return reply({ items: [place], total: 1, has_more: false });
  if (path === '/api/catalog/points') return reply({
    type: 'FeatureCollection', features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
      properties: { id: place.id, name: place.name, category: place.category, source_label: place.source_label } }],
  });
  if (path.startsWith('/api/catalog/places/')) { catalogDetails.push(decodeURIComponent(path.slice('/api/catalog/places/'.length))); return reply(place); }
  return reply({ code: 'fixture_unavailable' }, 503);
});
const pass = value => { checks.push(value); console.log(value); };
const sendRoute = route => page.evaluate(route => window.dispatchEvent(new CustomEvent('atlas:route-change', { detail: { route } })), route);
const source = name => page.evaluate(name => window.__JEJU_MAP__.getSource(name)?.serialize().data, name);
const bearing = () => page.evaluate(() => window.__JEJU_MAP__.getBearing());
const open = async () => { if (!(await page.locator('#terrain-tools-panel').isVisible())) await page.locator('#terrain-tools-toggle').click(); };
const previewStopped = async () => {
  assert.equal(await page.locator('#route-preview-start').getAttribute('aria-pressed'), 'false');
  const center = await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray());
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__JEJU_MAP__.getCenter().toArray()), center);
};
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.isStyleLoaded()
    && !document.querySelector('#mode-3d')?.disabled, null, { timeout: 90000 });
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  assert.equal(await page.locator('#terrain-tools-panel').isVisible(), false);
  assert.equal(elevationCalls.length, 0);
  assert.ok(terrainResponses > 0 && imageryResponses > 0);
  pass('Quiet initial map retains real DEM/imagery and makes no elevation request');

  await open();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'terrain-tab-places');
  assert.match(await page.locator('#terrain-scale').innerText(), /1\.5×/);
  assert.equal(await page.locator('.scene-grid [data-scene-id]').count(), 12);
  await page.locator('#scene-hallasan').click();
  await page.waitForFunction(() => {
    const map = window.__JEJU_MAP__, center = map.getCenter();
    return Math.abs(center.lng - 126.5292) < 0.0001 && Math.abs(center.lat - 33.3617) < 0.0001 && map.getPitch() > 40;
  });
  await page.waitForFunction(() => {
    const map = window.__JEJU_MAP__;
    const elevation = map.queryTerrainElevation([126.5292, 33.3617]);
    return typeof elevation === 'number' && elevation / map.getTerrain().exaggeration > 1000;
  }, null, { timeout: 30000 });
  await page.screenshot({ path: resolve(output, 'desktop-scene.png') });
  pass('Twelve named terrain scenes fly to a real elevated Hallasan viewpoint');

  await page.locator('#scene-orbit').click();
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'true');
  const firstBearing = await bearing();
  await page.waitForFunction(start => Math.abs(((window.__JEJU_MAP__.getBearing() - start + 540) % 360) - 180) > 1,
    firstBearing, { timeout: 6000 });
  await page.locator('#scene-orbit').click();
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'false');
  const stoppedBearing = await bearing();
  await page.waitForTimeout(300);
  assert.equal(await bearing(), stoppedBearing);
  await page.locator('#scene-orbit').click();
  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.move(mapBox.x + 190, mapBox.y + 180);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + 235, mapBox.y + 190, { steps: 6 });
  await page.mouse.up();
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'false');
  pass('Rotation changes the real camera; stop button and manual map drag cancel it');

  await page.locator('#scene-above').click();
  await page.waitForFunction(() => window.__JEJU_MAP__.getPitch() < 0.1);
  await page.locator('#scene-actual').click();
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getTerrain().exaggeration), 1);
  assert.match(await page.locator('#terrain-scale').innerText(), /1\.0×/);
  await page.locator('#scene-seongsan').click();
  await page.locator('#scene-details').click();
  await page.locator('#catalog-detail h2').filter({ hasText: '성산일출봉' }).waitFor();
  assert.equal(catalogDetails.at(-1), 'poi_0008');
  assert.equal(await page.locator('#terrain-tools-panel').isVisible(), false);
  await page.locator('[data-detail-action="close"]').click();
  pass('Overhead and actual-scale views work; a scene opens its existing catalog detail ID');

  await open();
  await sendRoute(routeFixture);
  await page.locator('#terrain-tab-route').click();
  await page.locator('#route-preview-start').click();
  await page.waitForFunction(() => document.querySelector('#route-preview-start').getAttribute('aria-pressed') === 'true');
  await page.waitForTimeout(350);
  const following = await page.evaluate(() => {
    const map = window.__JEJU_MAP__;
    return { position: map.getSource('terrain-route-position').serialize().data.geometry.coordinates,
      center: map.getCenter().toArray(), pitch: map.getPitch() };
  });
  const position = following.position;
  assert.ok(Math.abs(position[0] - 126.4) < 1e-8 || Math.abs(position[1] - 33.301) < 1e-8 || Math.abs(position[0] - 126.401) < 1e-8);
  assert.ok(Math.abs(following.center[0] - position[0]) < 0.0001 && following.pitch > 40);
  assert.deepEqual((await source('terrain-route-preview')).geometry.coordinates, coordinates);
  assert.match(await page.locator('.maplibregl-ctrl-attrib').innerText(), /OpenStreetMap/);
  await sendRoute(null);
  await previewStopped();
  assert.deepEqual((await source('terrain-route-preview')).features, []);
  pass('3D preview follows the supplied route shape and a new/cleared route removes old playback');

  await sendRoute(routeFixture);
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => document.querySelector('#terrain-profile').dataset.state === 'ready');
  assert.equal(elevationCalls.length, 1);
  assert.equal(elevationCalls[0].proof, 'fixture-proof');
  assert.ok(elevationCalls[0].body.coordinates.length >= 2 && elevationCalls[0].body.coordinates.length <= 256);
  assert.equal(await page.locator('.profile-line').count(), 2);
  assert.match(await page.locator('.profile-stats').innerText(), /미확인/);
  assert.match(await page.locator('#profile-position').innerText(), /0 m/);
  const beforeScale = await page.locator('#terrain-profile').innerText();
  await page.evaluate(() => {
    const input = document.querySelector('#elevation-range');
    input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.locator('#terrain-profile').innerText(), beforeScale);
  await page.locator('#profile-cursor').evaluate(input => { input.value = String(input.max); input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual((await source('terrain-profile-point')).geometry.coordinates, coordinates.at(-1));
  await page.screenshot({ path: resolve(output, 'desktop-profile.png') });
  pass('Profile uses bounded BFF heights, marks gaps, ignores display exaggeration and links its cursor to the map');

  elevationMode = 'error';
  await sendRoute(routeFixture);
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => document.querySelector('#terrain-profile').dataset.state === 'error');
  elevationMode = 'complete';
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => document.querySelector('#terrain-profile').dataset.state === 'ready');
  assert.match(await page.locator('#profile-coverage').innerText(), /100%/);
  elevationMode = 'delay';
  await sendRoute(routeFixture);
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => document.querySelector('#terrain-profile').dataset.state === 'loading');
  await page.waitForTimeout(150);
  await page.locator('#profile-cancel').click();
  releaseElevation?.(); releaseElevation = undefined;
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#terrain-profile').getAttribute('data-state'), 'idle');
  pass('Elevation failure has a working retry; cancelling a delayed response leaves no stale profile');

  await page.locator('#terrain-tab-measure').click();
  await page.locator('#measurement-toggle').click();
  assert.equal(await page.locator('.map-shell').evaluate(node => node.classList.contains('is-measuring')), true);
  for (const lat of [33.3, 33.301, 33.302]) {
    await page.evaluate(lat => { window.__JEJU_MAP__.jumpTo({ center: [126.4, lat], pitch: 0, zoom: 13 }); }, lat);
    await page.locator('#measurement-center').click();
  }
  assert.equal(await page.locator('#measurement-segments li').count(), 2);
  assert.match(await page.locator('#measurement-total').innerText(), /222 m/);
  assert.equal((await source('measurement-points')).features.length, 3);
  await page.locator('#measurement-undo').click();
  assert.match(await page.locator('#measurement-total').innerText(), /111 m/);
  await page.locator('#measurement-clear').click();
  assert.equal((await source('measurement-points')).features.length, 0);
  await page.locator('#map canvas').focus();
  await page.keyboard.press('Enter');
  assert.equal((await source('measurement-points')).features.length, 1);
  await page.keyboard.press('Backspace');
  assert.equal((await source('measurement-points')).features.length, 0);
  const clickPoint = await page.evaluate(() => {
    const map = window.__JEJU_MAP__, point = map.project([126.4, 33.302]);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.mouse.click(clickPoint.x + 45, clickPoint.y + 20);
  assert.equal((await source('measurement-points')).features.length, 2);
  assert.equal(await page.locator('#measurement-segments li').count(), 1);
  await page.evaluate(coordinates => window.dispatchEvent(new CustomEvent('atlas:preview-route', { detail: { coordinates } })), coordinates);
  assert.equal(await page.locator('.map-shell').evaluate(node => node.classList.contains('is-measuring')), false);
  assert.equal(await page.locator('#route-preview-start').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#terrain-tools-panel').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'terrain-tools-toggle');
  pass('Multiple-point straight measurement, center/keyboard addition, undo/clear and playback exclusion work');

  await open();
  await page.locator('#terrain-tab-places').click();
  await page.locator('#scene-orbit').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('#scene-orbit').disabled
    && document.querySelector('#scene-orbit').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('#scene-orbit').isDisabled(), true);
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'false');
  await page.locator('#language-toggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.locator('#terrain-tab-route').innerText(), /Route/);
  assert.match(await page.locator('#scene-motion-note').innerText(), /Reduced motion/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#scene-hallasan').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector('#terrain-tools-panel').getBoundingClientRect();
    const credits = document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect();
    const map = document.querySelector('#map').getBoundingClientRect();
    return { above: panel.top - map.top, panelBottom: panel.bottom, creditsTop: credits.top,
      font: getComputedStyle(document.querySelector('#scene-name')).fontFamily };
  });
  assert.ok(mobile.above > 110 && mobile.panelBottom <= mobile.creditsTop, JSON.stringify(mobile));
  assert.match(mobile.font, /NanumSquare/);
  await page.screenshot({ path: resolve(output, 'mobile-scenes-en.png') });
  await page.locator('#terrain-tools-close').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__JEJU_MAP__?.isStyleLoaded()
    && !document.querySelector('#mode-3d')?.disabled, null, { timeout: 90000 });
  await open();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.locator('#terrain-tab-measure').innerText(), /Measure/);
  pass('Reduced motion stops playback; English persists and mobile controls keep terrain, credits and NanumSquare visible');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#scene-orbit').click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('#scene-orbit').click();
  await page.evaluate(() => {
    const canvas = window.__JEJU_MAP__.getCanvas();
    const gl = canvas.getContext('webgl2');
    const loss = gl.getExtension('WEBGL_lose_context');
    if (!loss) throw new Error('WebGL context loss extension unavailable');
    loss.loseContext();
  });
  await page.waitForFunction(() => document.querySelector('#scene-orbit').disabled);
  assert.equal(await page.locator('#scene-orbit').getAttribute('aria-pressed'), 'false');
  pass('Background lifecycle and real WebGL context loss stop automatic movement');

  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    passed: true, checks, errors, terrainResponses, imageryResponses,
    elevationRequests: elevationCalls.length, controlledCatalog: true, controlledRoute: true,
    controlledElevation: true, modelCalls, staticRoot: root,
  }, null, 2));
} catch (error) {
  const state = await page.evaluate(() => ({
    orbit: document.querySelector('#scene-orbit')?.getAttribute('aria-pressed'),
    bearing: window.__JEJU_MAP__?.getBearing(),
    events: window.terrainTestEvents,
  })).catch(() => null);
  await page.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    passed: false, checks, errors, failure: error.stack, terrainResponses, imageryResponses,
    controlledCatalog: true, controlledRoute: true, controlledElevation: true, modelCalls, state,
  }, null, 2));
  throw error;
} finally {
  releaseElevation?.();
  await browser.close();
  // This server belongs only to this test. Close outstanding asset sockets so
  // a cancelled browser download cannot keep the successful test alive.
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
