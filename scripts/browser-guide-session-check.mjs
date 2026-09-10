import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAppServer } from '../server/server.mjs';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

// Isolated, model-free HTTP/SSE fixtures. Never proxy /api to a real runtime.
const root = resolve(process.env.STATIC_ROOT || 'dist');
const output = resolve(process.argv[2] || '.local/guide-session-browser');
await mkdir(output, { recursive: true });
const requests = [];
let configRequests = 0;
let proofRevision = 1;
const proofHeaders = [];
const counts = new Map();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const markdown = '# 한라산 주변 식사\n\n**확인된 장소**를 먼저 살펴보세요.\n\n- 주차 정보 확인\n- *방문 전 문의*\n\n| 항목 | 안내 |\n| --- | --- |\n| 영업시간 | 정보 없음 |\n\n[안전한 출처](https://example.com/source)\n\n```html\n<img src=x onerror="window.__unsafe=1">\n```\n\n<script>window.__unsafe=2</script>\n\n[x](javascript:alert(1)) ![추적 이미지](https://tracker.invalid/pixel.png)';
const map = {
  answer: markdown, center: { lat: 33.38, lng: 126.54 }, zoom: 11,
  markers: [{ id: 'fixture-place', name: '검증 식당', lat: 33.38, lng: 126.54, category: '맛집', summary: '검증 자료', source: 'OpenStreetMap', observed_at: '2026-09-10' }],
  route: [], route_meta: null, warnings: [], place_info: [{
    id: 'fixture-place', name: '검증 식당', facilities: { parking: 'yes' },
    hours_week: [], hours_source: null, enriched_at: '2026-09-10',
    base_note: '검증용 원자료 출처 안내', business_status: null,
    sources: [{ source: 'OpenStreetMap', url: 'https://example.com/source', observed_at: '2026-09-10', license: 'ODbL' }],
  }],
};

const api = async (req, res, url) => {
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/config') {
    configRequests++;
    return json(200, { version: 'controlled-guide-ui', features: { guide: true, catalog: false, planner: true, pwa: false }, guide: { daily_limit: 30, csrf_token: `fixture-proof-${proofRevision}` } });
  }
  if (url.pathname === '/api/catalog/status') return json(200, { status: 'unavailable', total: 0, by_source: {}, categories: [], built_at: null, refreshed_at: null, stale: false, attribution: '', photos_count: 0, hours_week_count: 0 });
  if (url.pathname === '/api/catalog/search') return json(200, { items: [], total: 0, has_more: false });
  if (url.pathname === '/api/catalog/points') return json(200, { type: 'FeatureCollection', features: [] });
  if (url.pathname === '/api/weather') return json(503, { error: { code: 'unavailable' } });
  if (url.pathname === '/api/catalog/places/fixture-place') return json(200, {
    id: 'fixture-place', name: '검증 식당', name_en: null, category: '맛집', lat: 33.38, lng: 126.54,
    address: null, summary: '검증 자료', tags: [], source: 'OpenStreetMap', source_label: 'OpenStreetMap',
    base_note: null, updated_at: '2026-09-10', region: null, avg_stay_min: null, url: null, phone: null, hours: null, distance_m: null,
    photos: [], hours_week: [], hours_source: null, facilities: { parking: 'yes' }, overview: null,
    menu: [], business_status: null, tips: null, sources: [], enriched_at: null,
  });
  if (url.pathname !== '/api/guide' || req.method !== 'POST') return json(404, {});
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  proofHeaders.push({ message: body.message, proof: req.headers['x-atlas-csrf'] ?? null });
  const count = (counts.get(body.message) ?? 0) + 1;
  counts.set(body.message, count);
  if (body.message === '한라산 근처 맛집?' && count === 1) return json(403, { error: { code: 'invalid_conversation' } });
  if (body.message.startsWith('선택한 장소 근처 카페를 찾아 주세요.') && count === 1) return json(403, { error: { code: 'invalid_conversation' } });
  if (body.message === '쿠키 갱신 확인' && count === 1) {
    proofRevision++;
    return json(401, { error: { code: 'session_required' } });
  }
  if (body.message === 'CSRF 갱신 확인' && count === 1) {
    proofRevision++;
    return json(403, { error: { code: 'csrf_invalid' } });
  }
  if (body.message === '허용되지 않은 페이지') return json(403, { error: { code: 'origin_forbidden' } });
  if (body.message === '오늘 한도 확인') return json(429, { error: { code: 'daily_limit' } });
  if (body.message === '서버 오류 확인') return json(503, { error: { code: 'guide_unavailable' } });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.flushHeaders();
  res.write(frame('session', { conversation_id: body.message === '연결 확인' ? 'expired-test-conversation' : 'renewed-test-conversation' }));
  if (body.message === '스트림 오류 확인') return res.end(frame('error', { code: 'invalid_conversation' }) + frame('done', {}));
  if (body.message === '도구 표시 확인' || body.message === '기다리기 중지 확인') {
    const timers = [
      setTimeout(() => { if (!res.destroyed) res.write(frame('status', { stage: 'tool', tool: 'find_places', label: '장소 검색', message: '장소를 찾고 있어요.' })); }, 200),
      setTimeout(() => { if (!res.destroyed) res.write(frame('status', { stage: 'tool', tool: 'place_details', label: '상세 정보 확인', message: '등록된 자료를 확인하고 있어요.' })); }, 450),
      setTimeout(() => { if (!res.destroyed) res.write(frame('text', { delta: markdown })); }, 3000),
      setTimeout(() => { if (!res.destroyed) res.end(frame('map', map) + frame('done', {})); }, 3500),
    ];
    res.on('close', () => timers.forEach(clearTimeout));
    return;
  }
  res.end(frame('text', { delta: body.message === '연결 확인' ? '연결되었습니다.' : markdown }) + frame('map', map) + frame('done', {}));
};
const server = createAppServer({ root, api });
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(8112, '127.0.0.1', resolve);
});
let browser;
let page;
const checks = [];
const errors = [];
const pass = (name) => { checks.push(name); console.log(name); };

try {
  browser = await chromium.launch({
    executablePath: '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const externalImages = [];
  page.on('request', (request) => { if (request.url().includes('tracker.invalid')) externalImages.push(request.url()); });
  await page.goto('http://127.0.0.1:8112', { waitUntil: 'domcontentloaded' });
  await page.locator('#tab-guide').click();
  const send = async (question) => {
    await page.locator('#guide-input').fill(question);
    await page.locator('#guide-send').click();
    await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
  };
  await send('연결 확인');
  assert.equal(proofHeaders[0].proof, 'fixture-proof-1');
  assert.equal(requests[0].csrf_token, undefined);
  await send('한라산 근처 맛집?');
  const hallasan = requests.filter((request) => request.message === '한라산 근처 맛집?');
  assert.equal(hallasan.length, 2, 'Expired conversation must retry the SAME submitted question once');
  assert.equal(hallasan[0].conversation_id, 'expired-test-conversation');
  assert.equal(hallasan[1].conversation_id, undefined);
  assert.equal(await page.locator('.chat-message--user > p').filter({ hasText: '한라산 근처 맛집?' }).count(), 1);
  assert.doesNotMatch(await page.locator('.chat-message--assistant').last().innerText(), /답변이 중단/);
  pass('Expired conversation recovers the same question with one transcript entry');

  const answer = page.locator('.chat-message--assistant').last();
  await answer.locator('.guide-markdown[data-markdown-state="ready"]').waitFor();
  assert.ok(await answer.locator('.guide-markdown strong').count() > 0);
  assert.equal(await answer.locator('table').count(), 1);
  assert.equal(await answer.locator('pre code').count(), 1);
  assert.equal(await answer.locator('.guide-markdown script, .guide-markdown img, .guide-markdown iframe, .guide-markdown svg').count(), 0);
  assert.equal(await answer.locator('img.guide-ui-emoji').count(), 1);
  assert.ok((await answer.locator('img.guide-ui-emoji').getAttribute('src')).startsWith('/emoji/'));
  assert.equal(await answer.locator('a[href^="javascript:"], a[href^="data:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.equal(externalImages.length, 0);
  assert.match(await answer.locator('a').first().getAttribute('rel'), /noopener/);
  pass('Markdown renders safely without raw HTML, executable links or image requests');

  await page.waitForFunction(() => window.__JEJU_MAP__?.getLayer('catalog-clusters'), null, { timeout: 90000 });
  await page.locator('[data-guide-place="fixture-place"]').click();
  await page.locator('#detail-add-trip').waitFor({ state: 'visible' });
  await page.locator('[data-detail-action="close"]').click();
  const explicit = '선택한 장소 근처 카페를 찾아 주세요.';
  await send(explicit);
  const contextual = requests.filter((request) => request.message.startsWith(explicit));
  assert.equal(contextual.length, 2);
  assert.equal(contextual[0].message, contextual[1].message, 'Session recovery must reuse the already composed context exactly');
  assert.match(contextual[0].message, /선택 장소 검증 식당/);
  assert.match(contextual[0].message, /지도 중심/);
  assert.equal(await page.locator('.chat-message--user > p').filter({ hasText: explicit }).innerText(), explicit);
  const broad = '아이와 함께 갈 곳을 추천해 주세요.';
  await send(broad);
  assert.equal(requests.at(-1).message, broad);
  const named = '성산일출봉 근처 맛집?';
  await send(named);
  assert.equal(requests.at(-1).message, named);
  pass('Explicit references compose selected/map context once; broad and named questions stay raw');

  const configsBefore = configRequests;
  await send('쿠키 갱신 확인');
  assert.equal(counts.get('쿠키 갱신 확인'), 2);
  assert.equal(configRequests - configsBefore, 1);
  assert.deepEqual(proofHeaders.filter((request) => request.message === '쿠키 갱신 확인').map((request) => request.proof), ['fixture-proof-1', 'fixture-proof-2']);
  const beforeProofRefresh = configRequests;
  await send('CSRF 갱신 확인');
  assert.equal(counts.get('CSRF 갱신 확인'), 2);
  assert.equal(configRequests - beforeProofRefresh, 1);
  assert.deepEqual(proofHeaders.filter((request) => request.message === 'CSRF 갱신 확인').map((request) => request.proof), ['fixture-proof-2', 'fixture-proof-3']);
  assert.equal(requests.filter((request) => request.message === 'CSRF 갱신 확인')[1].conversation_id, undefined);
  pass('Private config proof reaches the header and is replaced once on session/CSRF recovery');
  for (const question of ['허용되지 않은 페이지', '오늘 한도 확인', '서버 오류 확인', '스트림 오류 확인']) {
    await send(question);
    assert.equal(counts.get(question), 1);
    const reason = await page.locator('#guide-status').innerText();
    assert.match(await page.locator('.chat-message--assistant').last().innerText(), new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  pass('Only exact pre-invocation session errors retry; origin, quota, server and SSE errors do not');

  assert.equal(await page.locator('#guide-followups button').count(), 3);
  const beforeSuggestion = requests.length;
  await page.locator('#guide-input').fill('아이와 함께 박물관');
  await page.locator('#guide-followups button').first().click();
  assert.ok((await page.locator('#guide-input').inputValue()).length > 5);
  assert.equal(requests.length, beforeSuggestion);
  assert.equal(await page.locator('#guide-input').evaluate((input) => input === document.activeElement), true);
  pass('Contextual footer suggestions remain present and fill input without a model request');

  await page.locator('#guide-input').fill('도구 표시 확인');
  await page.locator('#guide-send').click();
  await page.locator('#guide-thinking').waitFor({ state: 'visible' });
  assert.match(await page.locator('#guide-thinking').innerText(), /생각 중/);
  const robot = page.locator('#guide-thinking img[data-emoji="🤖"]');
  await robot.evaluate((image) => image.decode());
  assert.ok(await robot.evaluate((image) => image.naturalWidth > 0));
  await page.waitForFunction(() => document.querySelectorAll('#guide-tools .guide-tool-chip').length === 2);
  assert.match(await page.locator('#guide-tools').innerText(), /find_places/);
  assert.match(await page.locator('#guide-tools').innerText(), /place_details/);
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  await page.locator('#guide-panel').screenshot({ path: resolve(output, 'thinking-tools-suggestions.png') });
  await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
  assert.equal(await page.locator('#guide-thinking').isVisible(), false);
  assert.equal(counts.get('도구 표시 확인'), 1);
  assert.ok(await page.locator('.guide-place-facts').count() > 0);
  const remaining = await page.locator('#guide-messages').evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight);
  assert.ok(remaining <= 2);
  await page.locator('#guide-panel').screenshot({ path: resolve(output, 'markdown-answer.png') });
  pass('Thinking state, real tool metadata, final facts and latest-answer scrolling coexist');

  await page.locator('#guide-input').fill('기다리기 중지 확인');
  await page.locator('#guide-send').click();
  await page.locator('#guide-thinking').waitFor({ state: 'visible' });
  await page.locator('#guide-cancel').click();
  await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
  assert.match(await page.locator('#guide-status').innerText(), /중지/);
  assert.equal(counts.get('기다리기 중지 확인'), 1);
  pass('Cancellation does not resubmit a started stream');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#drawer-toggle').click();
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  const dimensions = await page.evaluate(() => ({
    footer: document.querySelector('#guide-footer').getBoundingClientRect().toJSON(),
    panel: document.querySelector('#guide-panel').getBoundingClientRect().toJSON(),
    log: document.querySelector('#guide-messages').getBoundingClientRect().toJSON(),
    width: document.documentElement.scrollWidth, viewport: innerWidth,
  }));
  assert.ok(dimensions.footer.bottom <= dimensions.panel.bottom + 1);
  assert.ok(dimensions.log.height >= 55, 'Mobile must retain usable conversation space');
  assert.ok(dimensions.width <= dimensions.viewport);
  const emojiAssets = [
    '1f916.svg', '1f9ed.svg', '1f37d.svg', '1f33f.svg', '2614.svg',
    '1f468-200d-1f469-200d-1f467.svg',
  ];
  const decoded = await page.evaluate(async (files) => Promise.all(files.map(async (file) => {
    const image = new Image();
    image.src = `/emoji/${file}`;
    await image.decode();
    return image.naturalWidth > 0;
  })), emojiAssets);
  assert.ok(decoded.every(Boolean));
  await page.locator('#guide-followups img[data-emoji]').first().evaluate((image) => image.decode());
  await page.locator('#guide-panel').screenshot({ path: resolve(output, 'mobile-guide.png') });
  pass('Mobile footer suggestions stay visible without overflowing the conversation panel');
  pass('All six local SVG emoji decode without an emoji font');
  await page.locator('#about-button').click();
  assert.match(await page.locator('#emoji-attribution').innerText(), /Twemoji.*Twitter.*CC BY 4\.0/);
  assert.equal(await page.locator('#about-dialog a[href="/emoji/LICENSE-GRAPHICS.txt"]').count(), 1);
  await page.locator('#about-close').click();
  pass('Help dialog exposes Twemoji creator and CC BY attribution');
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, controlledSSE: true, checks, errors, requests, configRequests }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, requests, failure: error.stack }, null, 2));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
