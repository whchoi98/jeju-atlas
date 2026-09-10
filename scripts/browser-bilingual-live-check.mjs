// Explicit live verification: two billable guide turns only with --live.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

const base = new URL(process.argv[2] || 'https://jeju-atlas.whchoi.net').origin;
const output = resolve(process.argv[3] || '.local/bilingual-live');
const live = process.argv.includes('--live');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
const results = [];
const requests = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('request', request => {
  if (new URL(request.url()).pathname === '/api/guide' && request.method() === 'POST') {
    const body = request.postDataJSON();
    requests.push({ message: body.message, locale: body.locale, request_id: body.request_id });
  }
});
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#language-toggle').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  await page.locator('#tab-guide').click();
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  if (live) {
    const started = Date.now();
    await page.locator('#guide-input').fill('성산일출봉 근처 맛집 두 곳과 확인된 이용 정보, 출처를 알려 주세요.');
    await page.locator('#guide-send').click();
    await page.locator('#guide-thinking').waitFor({ state: 'visible' });
    await page.locator('#guide-messages[aria-busy="false"]').waitFor({ timeout: 100000 });
    const answer = await page.locator('.chat-message--assistant').last().innerText();
    assert.match(answer, /[가-힣]/);
    assert.doesNotMatch(answer, /답변이 중단|요청이 허용되지|완성된 답변을 받지/);
    results.push({ locale: 'ko', elapsedSeconds: (Date.now() - started) / 1000, answer });
    await page.screenshot({ path: resolve(output, 'korean-answer.png'), fullPage: true });
  }
  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.locator('#tab-guide').click();
  assert.match(await page.locator('#guide-input').getAttribute('placeholder'), /where|travel|enjoy/i);
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  if (live) {
    const started = Date.now();
    await page.locator('#guide-input').fill('Plan a short family day trip around Seongsan with two places. State which amenity information is confirmed and cite sources.');
    await page.locator('#guide-send').click();
    await page.locator('#guide-thinking').waitFor({ state: 'visible' });
    await page.locator('#guide-messages[aria-busy="false"]').waitFor({ timeout: 100000 });
    const answer = await page.locator('.chat-message--assistant').last().innerText();
    assert.ok((answer.match(/\b[A-Za-z]{3,}\b/g) || []).length > 8);
    assert.doesNotMatch(answer, /interrupted|not allowed|could not receive a complete/i);
    assert.doesNotMatch(answer, /Curation confirms|anchored to a Starbucks/i);
    results.push({ locale: 'en', elapsedSeconds: (Date.now() - started) / 1000, answer });
    await page.screenshot({ path: resolve(output, 'english-answer.png'), fullPage: true });
    assert.equal(requests.length, 2, 'No automatic billable retry or extra submission');
    assert.deepEqual(requests.map(request => request.locale), ['ko', 'en']);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'english-mobile.png'), fullPage: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ base, live, passed: true, requests, results }, null, 2));
  console.log(JSON.stringify({ passed: true, live, turns: requests.length, results, output }));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ base, live, passed: false, requests, results, error: error.message }, null, 2));
  throw error;
} finally { await browser.close(); }
