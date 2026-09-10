import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
).href);
const base = process.argv[2] || 'http://localhost:8120';
const output = resolve('.local', process.argv[3] || 'guide-live');
const seongsan = process.argv.includes('--seongsan');
const simulateNullOrigin = process.argv.includes('--origin-null');
const question = seongsan ? '성산일출봉 근처 맛집을 알려주세요.' : '한라산 근처 맛집?';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
let requestProofPresent = false;
if (simulateNullOrigin) {
  await page.route('**/api/guide', (route) => {
    const headers = route.request().headers();
    requestProofPresent = Boolean(headers['x-atlas-csrf']);
    return route.continue({ headers: { ...headers, origin: 'null' } });
  });
}
const errors = [];
const checks = [];
page.on('pageerror', (error) => errors.push(error.message));
const pass = (name, detail) => { checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log(JSON.stringify(checks.at(-1))); };
await page.addInitScript(() => {
  const original = window.fetch.bind(window);
  window.__guideLiveResult = null;
  window.__guideSubmitted = [];
  window.fetch = async (...args) => {
    const input = args[0];
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/guide') window.__guideSubmitted.push(JSON.parse(args[1].body).message);
    const response = await original(...args);
    if (path === '/api/guide') response.clone().text().then(
      (body) => { window.__guideLiveResult = { status: response.status, body }; },
      (error) => { window.__guideLiveResult = { status: response.status, error: String(error) }; },
    );
    return response;
  };
});
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-guide').click();
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    input: getComputedStyle(document.querySelector('#guide-input')).fontFamily,
    loaded: [...document.fonts].filter((face) => face.family.replace(/['"]/g, '') === 'NanumSquare' && face.status === 'loaded').length,
  }));
  assert.match(fonts.body, /NanumSquare/);
  assert.match(fonts.input, /NanumSquare/);
  assert.ok(fonts.loaded >= 1);
  pass('Original NanumSquare font is loaded for the page and guide input', fonts);
  assert.ok(await page.locator('#guide-followups button').count() >= 2);
  const followupBox = await page.locator('#guide-followups').boundingBox();
  assert.ok(followupBox && followupBox.y + followupBox.height <= 1000);
  await page.locator('#guide-input').fill(question);
  const start = Date.now();
  await page.locator('#guide-send').click();
  await page.locator('#guide-thinking').waitFor({ state: 'visible', timeout: 5000 });
  const robot = page.locator('#guide-thinking img[data-emoji="🤖"]');
  await robot.evaluate((image) => image.decode());
  assert.ok(await robot.evaluate((image) => image.naturalWidth > 0));
  assert.match(await page.locator('#guide-thinking').innerText(), /생각\s*중/);
  assert.equal(await page.locator('#guide-followups').isVisible(), true);
  await page.screenshot({ path: resolve(output, 'thinking.png'), fullPage: true });
  pass('Thinking robot and persistent follow-up bubbles appear before the answer');
  await page.waitForFunction(() => Boolean(window.__guideLiveResult), null, { timeout: 115000 });
  const wire = await page.evaluate(() => window.__guideLiveResult);
  assert.equal(wire.status, 200);
  assert.equal(wire.error, undefined);
  const events = wire.body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return event && data && event !== 'session' ? [{ event, data: JSON.parse(data) }] : [];
  });
  assert.ok(!events.some((event) => event.event === 'error'));
  const map = events.find((event) => event.event === 'map')?.data;
  assert.ok(map && map.answer.length > 50 && map.markers.length > 0);
  if (seongsan) {
    assert.ok(map.center.lng > 126.85 && map.center.lat > 33.4 && map.center.lat < 33.54, 'The guide must use the Seongsan area');
    assert.ok(map.markers.every((place) => place.category === '맛집' && place.lng > 126.85));
  } else {
    assert.doesNotMatch(map.answer, /한라산도/);
    assert.ok(map.center.lat > 33.3 && map.center.lat < 33.47, 'The guide must use Hallasan, not the similarly named city cafe');
    assert.ok(map.markers.every((place) => place.category === '맛집' && place.lat < 33.48));
  }
  if (simulateNullOrigin) assert.equal(requestProofPresent, true, 'The app must send its session-bound request proof');
  assert.deepEqual(await page.evaluate(() => window.__guideSubmitted), [question]);
  const toolNames = [...new Set(events.filter((event) => event.event === 'status' && event.data.tool).map((event) => event.data.tool))];
  assert.ok(toolNames.includes('find_places'));
  await page.waitForFunction(() => document.querySelector('#guide-send')?.disabled === false, null, { timeout: 10000 });
  assert.match(await page.locator('#guide-tool-list').innerText(), /find_places/);
  assert.equal(await page.locator('#guide-followups').isVisible(), true);
  pass('Actual AgentCore answers the original nearby question with the correct area and tool history', {
    seconds: Math.round((Date.now() - start) / 100) / 10,
    tools: toolNames, places: map.markers.map((place) => place.name), simulateNullOrigin,
  });
  await page.waitForFunction(() => window.__JEJU_MAP__?.getLayer('guide-stops'), null, { timeout: 60000 });
  await page.locator('#guide-apply-map').click();
  await page.waitForFunction((count) => window.__JEJU_MAP__.getSource('guide-places').serialize().data.features.length === count,
    map.markers.length, { timeout: 15000 });
  await page.locator('#guide-followups button').first().click();
  assert.ok((await page.locator('#guide-input').inputValue()).length > 10);
  assert.deepEqual(await page.evaluate(() => window.__guideSubmitted), [question], 'A suggestion fills the input without spending another model call');
  await page.screenshot({ path: resolve(output, seongsan ? 'seongsan-answer.png' : 'hallasan-answer.png'), fullPage: true });
  pass('Live recommendation points apply to the map and a follow-up bubble fills the composer');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), base, passed: true, question, checks, errors,
    answer: map.answer, places: map.markers, tools: toolNames,
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
