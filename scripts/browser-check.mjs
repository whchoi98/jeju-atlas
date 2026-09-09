import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const baseUrl = process.argv[2] || 'http://127.0.0.1:8097';
const playwrightModule = process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';
const chrome = process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome';
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const output = resolve('.local', process.argv[3] || 'browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const checks = [];
const errors = [];
const tileResponses = { terrain: 0, satellite: 0 };
let page;

function passed(name, detail) {
  const result = { check: name, passed: true, ...(detail ? { detail } : {}) };
  checks.push(result);
  console.log(JSON.stringify(result));
}

async function waitForMap(target, terrain = true) {
  await target.waitForFunction(() => {
    const map = window.__JEJU_MAP__;
    return map && map.isStyleLoaded() && !map.isMoving()
      && map.areTilesLoaded() && !document.querySelector('#mode-3d')?.disabled;
  }, null, { timeout: 90_000 });
  if (terrain) {
    await target.waitForFunction(() => {
      const map = window.__JEJU_MAP__;
      return map && map.getTerrain() && typeof map.queryTerrainElevation([126.5292, 33.3617]) === 'number';
    }, null, { timeout: 30_000 });
  }
}

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
    reducedMotion: 'reduce',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() === 200 && response.url().includes('/terrarium/')) tileResponses.terrain++;
    if (response.status() === 200 && response.url().includes('World_Imagery/MapServer/tile/')) tileResponses.satellite++;
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await waitForMap(page);
  const initial = await page.evaluate(() => {
    const map = window.__JEJU_MAP__;
    return {
      pitch: map.getPitch(),
      terrain: map.getTerrain(),
      hallasan: map.queryTerrainElevation([126.5292, 33.3617]),
      size: [map.getCanvas().width, map.getCanvas().height],
      credit: document.querySelector('.maplibregl-ctrl-attrib')?.textContent,
    };
  });
  assert.ok(initial.pitch > 40);
  assert.equal(initial.terrain.source, 'terrain-dem');
  assert.ok(initial.hallasan > 1000 && initial.hallasan < 4000, `unexpected real DEM height ${initial.hallasan}`);
  assert.ok(tileResponses.terrain > 0 && tileResponses.satellite > 0);
  assert.match(initial.credit, /Esri/);
  assert.match(initial.credit, /Mapzen/);
  passed('Real 3D terrain, satellite tiles and visible attribution', { ...initial, tileResponses });
  await page.screenshot({ path: resolve(output, 'desktop-satellite.png'), fullPage: true });

  await page.locator('#place-search').fill('성산일출봉');
  assert.equal(await page.locator('#place-list .place-card').count(), 1);
  await page.locator('#place-list [data-place="seongsan"]').click();
  await page.waitForFunction(() => {
    const map = window.__JEJU_MAP__;
    const center = map.getCenter();
    return !map.isMoving() && Math.abs(center.lng - 126.9425) < 0.03 && Math.abs(center.lat - 33.4581) < 0.03;
  });
  assert.match(await page.locator('#selected-place').innerText(), /성산일출봉/);
  passed('Search selects Seongsan and moves the real map camera');

  await page.locator('#place-search').fill('없는장소xyz');
  assert.equal(await page.locator('#place-list .place-card').count(), 0);
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#place-list .place-card').count(), 12);
  await page.locator('[data-category="island"]').click();
  const islands = await page.locator('#place-list .place-card strong').allTextContents();
  assert.deepEqual(islands.sort(), ['가파도', '비양도', '우도'].sort());
  await page.locator('[data-category="all"]').click();
  passed('Empty search recovery and island category filtering');

  await page.locator('#mode-2d').click();
  await page.waitForFunction(() => !window.__JEJU_MAP__.getTerrain() && window.__JEJU_MAP__.getPitch() === 0);
  assert.equal(await page.locator('#mode-2d').getAttribute('aria-pressed'), 'true');
  await page.locator('#mode-3d').click();
  await page.waitForFunction(() => Boolean(window.__JEJU_MAP__.getTerrain()) && window.__JEJU_MAP__.getPitch() > 40);
  await page.locator('#actual-scale').click();
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getTerrain().exaggeration), 1);
  await page.locator('#elevation-range').focus();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getTerrain().exaggeration), 2);
  passed('2D/3D transition and actual terrain exaggeration controls');

  await page.locator('#basemap-relief').click();
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayoutProperty('elevation-colors', 'visibility')), 'visible');
  assert.equal(await page.evaluate(() => window.__JEJU_MAP__.getLayoutProperty('satellite', 'visibility')), 'none');
  await page.locator('#reset-view').click();
  await waitForMap(page);
  await page.screenshot({ path: resolve(output, 'desktop-terrain.png'), fullPage: true });
  passed('DEM relief map renders and overview resets');

  await page.locator('#tour-button').click();
  await page.waitForFunction(() => !document.querySelector('#tour-progress').hidden);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#tour-progress').hidden);
  passed('Guided tour starts and Escape stops it');

  await page.locator('#share-button').click();
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(shared.startsWith(baseUrl));
  assert.ok(shared.includes('map=') && shared.includes('base=relief'));
  const restored = await context.newPage();
  await restored.goto(shared, { waitUntil: 'domcontentloaded' });
  await waitForMap(restored);
  const restoredState = await restored.evaluate(() => ({
    exaggeration: window.__JEJU_MAP__.getTerrain().exaggeration,
    relief: window.__JEJU_MAP__.getLayoutProperty('elevation-colors', 'visibility'),
  }));
  assert.equal(restoredState.exaggeration, 2);
  assert.equal(restoredState.relief, 'visible');
  await restored.close();
  passed('Share copies a URL that restores camera and terrain settings');

  await page.locator('#about-button').click();
  assert.equal(await page.locator('#about-dialog').evaluate((dialog) => dialog.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#about-dialog').evaluate((dialog) => dialog.open), false);
  passed('Accessible help dialog opens and dismisses');
  assert.deepEqual(errors, [], 'Browser console/page errors');
  passed('No desktop JavaScript or map source errors');

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true,
    hasTouch: true, locale: 'ko-KR', reducedMotion: 'reduce',
  });
  const mobilePage = await mobile.newPage();
  page = mobilePage;
  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitForMap(mobilePage);
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await mobilePage.locator('#sidebar-content').evaluate((element) => element.inert), true);
  await mobilePage.screenshot({ path: resolve(output, 'mobile-map.png'), fullPage: true });
  await mobilePage.locator('#drawer-toggle').click();
  assert.equal(await mobilePage.locator('#drawer-toggle').getAttribute('aria-expanded'), 'true');
  await mobilePage.locator('#place-search').fill('우도');
  await mobilePage.locator('#place-list [data-place="udo"]').click();
  await mobilePage.waitForFunction(() => document.querySelector('#drawer-toggle').getAttribute('aria-expanded') === 'false');
  assert.match(await mobilePage.locator('#selected-place').innerText(), /우도/);
  await mobilePage.locator('#layer-trigger').click();
  assert.equal(await mobilePage.locator('#layer-trigger').getAttribute('aria-expanded'), 'true');
  await mobilePage.locator('#basemap-relief').click();
  await mobilePage.locator('#layer-close').click();
  await mobilePage.screenshot({ path: resolve(output, 'mobile-place.png'), fullPage: true });
  passed('Mobile map, drawer, search, selection and settings remain usable');
  await mobile.close();

  const report = { url: baseUrl, checkedAt: new Date().toISOString(), passed: true, checks, errors, tileResponses };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, screenshots: output }));
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    url: baseUrl, passed: false, checks, errors, tileResponses, failure: error.stack,
  }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
