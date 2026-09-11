import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Focused component checks: real DOM/controllers, a deterministic map boundary
// and intercepted elevation responses. No terrain, routing engine or AI calls.
const output = resolve(process.argv[2] || '.local/terrain-state-review');
await mkdir(output, { recursive: true });
const { outputFiles } = await build({
  stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
    import { TerrainScenes } from './src/scenes.ts';
    import { setLocale } from './src/i18n.ts';
    const shell = document.querySelector('.map-shell');
    const canvas = document.querySelector('canvas');
    const data = new Map();
    let doubleClick = true;
    const map = {
      addSource(id, source) { data.set(id, { data: source.data, setData(value) { this.data = value; } }); },
      addLayer() {}, getSource(id) { return data.get(id); }, getCanvas() { return canvas; },
      getContainer() { return document.querySelector('#map'); },
      getCenter() { return { lng: 126.4, lat: 33.3 }; },
      doubleClickZoom: { isEnabled: () => doubleClick, disable: () => { doubleClick = false; }, enable: () => { doubleClick = true; } }
    };
    window.cursorPoint = null;
    const atlas = {
      map, stop() {}, stopRoutePreview() {},
      setProfilePoint(point) { window.cursorPoint = point; },
      getState() { return { is3D: true, exaggeration: 1.5 }; }
    };
    window.scenes = new TerrainScenes(shell, {
      atlas: () => atlas, onSelect() {}, onDetails() {}, stopOtherPlayback() {}, closeDrawer() {}, notify() {}
    });
    window.scenes.attach(atlas);
    window.measureData = data;
    window.setLocale = setLocale;
  ` },
  bundle: true, write: false, format: 'iife', target: 'es2022',
});
const script = outputFiles[0].text;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE
  || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs').href);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
const errors = [], checks = [], requests = [];
let held, release;
const oldRequest = new Promise(resolve => { held = resolve; });
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const path = new URL(route.request().url()).pathname;
  const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <section class="map-shell"><div id="map"><canvas tabindex="0"></canvas></div><div class="map-tools"></div><div id="layer-panel"></div></section>
    <script>${script.replaceAll('</script', '<\\/script')}</script></body></html>` });
  if (path === '/api/config') return json({ routing: { csrf_token: 'fixture-proof' } });
  if (path === '/api/elevation') {
    const coordinates = route.request().postDataJSON().coordinates;
    requests.push(coordinates);
    if (requests.length === 1) { held(); await new Promise(resolve => { release = resolve; }); }
    return json({
      available: true, elevations_m: coordinates.map((_point, index) => index * 2),
      source: { name: 'Mapzen / Skadi DEM · source 2016-04-23 · sampled by Valhalla',
        url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md' },
    }).catch(() => {});
  }
  throw new Error(`Unexpected request: ${path}`);
});
const sendRoute = async (coordinates, mode = 'walk') => {
  await page.evaluate(({ coordinates, mode }) => {
    const route = coordinates ? {
      available: true, mode, source: { provider: 'valhalla', data: 'OpenStreetMap',
        attribution: 'OSM fixture', url: 'https://www.openstreetmap.org/copyright', data_updated_at: null },
      coordinates, distance_m: 100, duration_s: 80, snapped: [], warnings: [], traffic: 'not_live',
      legs: [{ coordinates, distance_m: 100, duration_s: 80, steps: [] }],
    } : null;
    window.dispatchEvent(new CustomEvent('atlas:route-change', { detail: { route } }));
  }, { coordinates, mode });
};
try {
  await page.goto('https://terrain-review.test/');
  await page.evaluate(() => window.scenes.show('measure'));
  await page.locator('#measurement-toggle').click();
  assert.equal(await page.locator('.map-shell').evaluate(node => node.classList.contains('is-measuring')), true);
  await page.evaluate(() => window.scenes.setReady(false));
  assert.equal(await page.locator('#measurement-toggle').isDisabled(), true,
    'A lost graphics context must not permit another measurement');
  assert.equal(await page.locator('#terrain-tools-panel').isHidden(), true,
    'The tools must not cover the fatal map recovery notice');
  assert.equal(await page.locator('#terrain-tools-toggle').isDisabled(), true);
  await page.evaluate(() => window.scenes.measurement.start());
  assert.equal(await page.locator('.map-shell').evaluate(node => node.classList.contains('is-measuring')), false);
  await page.evaluate(() => { window.scenes.setReady(true); window.scenes.show('measure'); });
  await page.locator('#measurement-toggle').click();
  await page.locator('#measurement-center').click();
  assert.equal(await page.evaluate(() => window.measureData.get('measurement-points').data.features.length), 1);
  checks.push('Readiness loss disables measurement and reveals recovery; restored readiness enables it again');

  const first = [[126.4, 33.3], [126.41, 33.31]];
  const latest = [[126.6, 33.4], [126.61, 33.41]];
  await sendRoute(first);
  await page.evaluate(() => window.scenes.show('route'));
  await page.locator('#profile-load').click();
  await oldRequest;
  await sendRoute(latest, 'car');
  assert.equal(await page.locator('#terrain-profile').getAttribute('data-state'), 'idle');
  assert.equal(await page.evaluate(() => window.cursorPoint), null);
  await page.locator('#profile-load').click();
  await page.waitForFunction(() => document.querySelector('#terrain-profile').dataset.state === 'ready');
  release();
  await page.waitForTimeout(25);
  await page.locator('#profile-cursor').evaluate(node => { node.value = node.max; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.deepEqual(await page.evaluate(() => window.cursorPoint), latest.at(-1));
  assert.deepEqual(requests[1][0], latest[0]);
  assert.deepEqual(requests[1].at(-1), latest.at(-1));
  assert.match(await page.locator('.profile-source').innerText(), /2016-04-23/);
  await page.evaluate(() => window.setLocale('en'));
  assert.deepEqual(await page.evaluate(() => window.cursorPoint), latest.at(-1));
  assert.match(await page.locator('#terrain-profile h3').innerText(), /elevation/i);
  await sendRoute(null);
  assert.equal(await page.evaluate(() => window.cursorPoint), null);
  assert.equal(await page.locator('#profile-cursor').count(), 0);
  checks.push('Late old elevation response, changed mode, English render and null route preserve the correct profile coordinates');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, checks, errors, requests: requests.length, fixtureOnly: true }, null, 2));
} catch (error) {
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, failure: error.stack }, null, 2));
  throw error;
} finally {
  release?.();
  await browser.close();
}
