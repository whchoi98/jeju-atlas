import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(
  process.env.PLAYWRIGHT_MODULE || '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs',
).href);
const base = process.argv[2] || 'http://127.0.0.1:8097';
const output = resolve('.local', process.argv[3] || 'guide-regression');
await mkdir(output, { recursive: true });
const response = await fetch(`${base}/api/catalog/places/poi_0001`);
assert.ok(response.ok);
const place = await response.json();
assert.equal(place.name, '김녕미로공원');
const recommendation = {
  answer: '김녕미로공원을 살펴보세요. 편의 정보는 아래 카탈로그 자료에서 확인할 수 있어요.',
  center: { lat: place.lat, lng: place.lng }, zoom: 12,
  markers: [{
    id: place.id, name: place.name, category: place.category, lat: place.lat, lng: place.lng,
    source: place.source, observed_at: place.updated_at, summary: place.summary,
  }],
  route: [], route_meta: null, warnings: [],
  place_info: [{
    id: place.id, name: place.name, facilities: place.facilities, hours_week: place.hours_week,
    hours_source: place.hours_source, enriched_at: place.enriched_at, sources: place.sources,
    base_note: place.base_note, business_status: place.business_status,
  }],
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE || '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const results = [];
const pageErrors = [];
const requests = [];
let page;
const pass = (check) => {
  results.push({ check, passed: true });
  console.log(JSON.stringify(results.at(-1)));
};
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  await context.route('**/api/config', (route) => route.fulfill({
    json: { version: 'controlled-ui-regression', features: { catalog: true, guide: true, planner: true, pwa: true }, guide: { daily_limit: 30 } },
  }));
  await context.route('**/api/guide', (route) => {
    const body = route.request().postDataJSON();
    requests.push(body.message);
    const map = structuredClone(recommendation);
    // A second controlled turn verifies honest handling of absent data.
    if (requests.length === 2) {
      Object.assign(map.place_info[0], { facilities: {}, hours_week: [], hours_source: null, sources: [], enriched_at: null });
    }
    const sse = [
      ['session', { conversation_id: 'controlled-ui-conversation' }],
      ['text', { delta: map.answer }], ['map', map], ['done', {}],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
  });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-guide').click();
  await page.locator('.guide-quick-prompts button').filter({ hasText: '아이와 함께' }).click();
  await page.locator('#guide-send').click();
  await page.locator('#guide-apply-map').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(requests[0], '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.');
  pass('Family quick prompt sends the user question without an implicit camera radius');
  assert.equal(await page.locator('.guide-place-facts').getAttribute('open'), '');
  const facts = await page.locator('.guide-place-facts').innerText();
  assert.doesNotMatch(facts, /\bunknown\b/);
  assert.match(facts, /미확인/);
  assert.match(facts, /자료상 있음/);
  assert.match(facts, /이용시간 문구에서 추출/);
  assert.match(facts, /휴무일 미확인/);
  assert.match(facts, /공식.*검증|독립적으로.*검증/);
  pass('Controlled SSE displays real catalog facts with separate curated-base provenance');
  await page.waitForFunction(() => window.__JEJU_MAP__?.getLayer('catalog-clusters'), null, { timeout: 90000 });
  await page.locator('[data-guide-place="poi_0001"]').click();
  await page.locator('#detail-add-trip').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await page.locator('#catalog-detail h2').innerText(), /김녕미로공원/);
  pass('A recommendation opens the matching catalog detail');
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#guide-input').fill('여기 근처 카페를 찾아 주세요.');
  await page.locator('#guide-send').click();
  await page.waitForFunction(() => document.querySelector('#guide-send')?.disabled === false
    && document.querySelectorAll('.chat-message').length === 4, null, { timeout: 20000 });
  assert.ok(requests[1].startsWith('여기 근처 카페를 찾아 주세요.'));
  assert.match(requests[1], /지도 중심/);
  assert.match(requests[1], /선택 장소 김녕미로공원/);
  assert.equal(await page.locator('.guide-place-facts').getAttribute('open'), '');
  assert.match(await page.locator('.guide-place-facts').innerText(), /편의 정보 미확인/);
  assert.match(await page.locator('.guide-place-facts').innerText(), /요일별 영업시간 미확인/);
  pass('Explicit here-reference keeps the selected location; missing facilities remain unknown');
  const remainingScroll = await page.locator('#guide-messages').evaluate((log) =>
    log.scrollHeight - log.scrollTop - log.clientHeight);
  assert.ok(remainingScroll <= 2, 'The latest answer must stay in view when its fact panel opens');
  pass('Opening recommendation facts keeps the newest completed answer in view');
  await page.screenshot({ path: resolve(output, 'guide-facts.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), base, controlledSSE: true, passed: true, results, pageErrors,
  }, null, 2));
  await context.close();
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, results, pageErrors, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
