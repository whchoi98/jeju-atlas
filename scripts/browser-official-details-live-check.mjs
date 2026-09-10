// Public, read-only detail/media verification. --live adds one billable AI turn.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

const base = new URL(process.argv[2] || 'https://jeju-atlas.whchoi.net').origin;
const output = resolve(process.argv[3] || '.local/official-details-live');
const live = process.argv.includes('--live');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', serviceWorkers: 'block' });
const page = await context.newPage();
const checks = [], errors = [], submissions = [];
const report = { base, live, checkedAt: new Date().toISOString(), checks, errors, passed: false };
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/guide' && request.method() === 'POST') {
    const body = request.postDataJSON();
    submissions.push({ message: body.message, locale: body.locale, request_id: body.request_id });
  }
});
const pass = name => { checks.push(name); console.log(name); };

try {
  const response = await context.request.get(`${base}/api/catalog/places/poi_0008`);
  assert.equal(response.status(), 200);
  const place = await response.json();
  assert.equal(place.name, '성산일출봉');
  const tour = place.official_details.find(record => record.provider === 'tourapi');
  const english = place.official_details.find(record => record.provider === 'visitjeju' && record.locale === 'en');
  assert.ok(tour && tour.facts.length >= 3 && tour.overview && tour.phone);
  assert.ok(english?.overview);
  assert.ok(place.photos.length >= 1);
  assert.ok(tour.match.distance_m > 0, 'Provider coordinates remain separately attributed');
  report.place = {
    id: place.id, providers: place.official_details.map(record => `${record.provider}:${record.locale}`),
    photos: place.photos.length, facts: tour.facts.length, fetchedAt: tour.fetched_at,
  };
  pass('The deployed API returns official facts, source dates and an English provider record');

  const photo = place.photos.find(item => new URL(item.url).pathname.startsWith('/media/'));
  assert.ok(photo);
  const image = await context.request.get(photo.url);
  assert.equal(image.status(), 200);
  assert.match(image.headers()['content-type'], /^image\/(?:jpeg|png|webp)/);
  assert.match(image.headers()['cache-control'], /immutable/);
  assert.ok((await image.body()).length > 1000);
  const direct = await context.request.get(`https://jeju-3d-data-061525506239-ap-northeast-2.s3.ap-northeast-2.amazonaws.com${new URL(photo.url).pathname}`);
  assert.equal(direct.status(), 403);
  pass('An authorized original photo is delivered by CloudFront while direct S3 access is denied');

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#catalog-search').fill('성산일출봉');
  await page.locator('#catalog-list [data-catalog-id="poi_0008"]').click();
  await page.locator('#official-provider-panel').waitFor();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-provider-id'), tour.provider_id);
  assert.ok(await page.locator('#official-provider-panel a[href^="tel:"]').count());
  assert.match(await page.locator('.official-source > a').innerText(), /정보 제공처/);
  await page.locator('#detail-photo-image').evaluate(image => image.decode());
  assert.ok(await page.locator('#detail-photo-image').evaluate(image => image.naturalWidth > 0));
  await page.screenshot({ path: resolve(output, 'korean-detail.png'), fullPage: true });
  pass('The real gallery, telephone action, provider introduction and visiting facts render');

  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.locator('[data-official-provider="visitjeju"]').click();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'en');
  assert.match(await page.locator('#official-overview').innerText(), /[A-Za-z]{4}/);
  await page.locator('[data-official-provider="tourapi"]').click();
  assert.equal(await page.locator('#official-provider-panel').getAttribute('data-official-locale'), 'ko');
  assert.match(await page.locator('.official-language').innerText(), /Korean/);
  await page.screenshot({ path: resolve(output, 'english-detail.png'), fullPage: true });
  pass('English provider text is available and Korean-only visiting facts remain labelled');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'mobile-detail.png'), fullPage: true });
  pass('The expanded detail panel fits a mobile viewport');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'ko');

  if (live) {
    await page.locator('#tab-guide').click();
    const question = '성산일출봉의 이용시간, 휴무일, 입장료와 확인한 출처를 알려 주세요.';
    const started = Date.now();
    await page.locator('#guide-input').fill(question);
    await page.locator('#guide-send').click();
    await page.locator('#guide-thinking').waitFor({ state: 'visible' });
    await page.locator('#guide-messages[aria-busy="false"]').waitFor({ timeout: 115000 });
    const answer = await page.locator('.chat-message--assistant').last().innerText();
    const tools = await page.locator('#guide-tool-list').innerText();
    report.guide = { answer, tools, seconds: (Date.now() - started) / 1000, turns: submissions.length };
    assert.doesNotMatch(answer, /답변이 중단|요청이 허용되지|완성된 답변을 받지/);
    assert.match(answer, /5,?000|5천/);
    assert.match(answer, /월요일/);
    assert.doesNotMatch(answer, /112월|58월|\d{2}:\d{4}:\d{2}/, 'Month/time range separators must remain visible');
    assert.equal(await page.locator('.chat-message--assistant').last().locator('del').count(), 0);
    assert.match(answer, /TourAPI|한국관광공사|VisitJeju|비짓제주|visitkorea/);
    assert.match(tools, /place_detail/);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].message, question);
    await page.screenshot({ path: resolve(output, 'official-guide-answer.png'), fullPage: true });
    pass('One real AgentCore turn uses place_detail and completes an answer with sourced fees and closed days');
  }
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
