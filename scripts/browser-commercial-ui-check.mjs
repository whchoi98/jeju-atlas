import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from '/tmp/jeju-browser-tools/node_modules/playwright/index.mjs';

// Self-hosted controlled APIs and generated tile fixtures. No external API,
// imagery provider, AWS or model request is allowed through this browser context.
const root = resolve(process.env.STATIC_ROOT || 'dist');
const output = resolve(process.argv[2] || '.local/commercial-ui-browser');
await mkdir(output, { recursive: true });
const requests = [];
const checks = [];
const errors = [];
const pass = name => { checks.push(name); console.log(name); };
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const place = (id, name, lng) => ({
  id, name, lng, lat: 33.4, category: '카페', source: id === 'fixture-a' ? 'sample' : 'osm', source_label: id === 'fixture-a' ? '큐레이션 시드' : 'OpenStreetMap',
  base_note: '제어된 브라우저 검사 자료', summary: '기록된 장소 소개', address: '검사 주소',
  updated_at: '2026-09-10', name_en: id === 'fixture-a' ? 'Audit Café One' : null, tags: [], region: null, avg_stay_min: null,
  url: 'https://www.openstreetmap.org/', phone: null, hours: null, distance_m: null,
  photos: [], hours_week: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '18:00' })), hours_source: 'tourapi_usetime', facilities: { parking: 'yes' }, overview: null, menu: [],
  business_status: 'open', registration_note: '연결된 인허가 자료의 상태이며, 장소 전체의 운영 여부나 현재 시각의 영업 여부를 확정하지 않습니다.',
  field_evidence: {
    lat: { state: id === 'fixture-a' ? 'unverified' : 'source_reported', source: id === 'fixture-a' ? 'sample' : 'osm', observed_at: null, evidence_url: null },
    'facilities.parking': { state: 'unknown', source: null, observed_at: null, evidence_url: null },
    hours_week: { state: 'parsed', source: 'tourapi_usetime', observed_at: null, evidence_url: null },
  },
  tips: null, enriched_at: null,
  sources: [{ source: 'osm', url: 'https://www.openstreetmap.org/', observed_at: '2026-09-10', license: 'ODbL', note: '출처 보존 확인' }],
});
const places = [place('fixture-a', '검사 카페 하나', 126.5), place('fixture-b', '검사 카페 둘', 126.6), place('fixture-c', '검사 카페 셋', 126.7)];
let guideEnabled = true;
let variant = 1;
let failDetail = false;
let pointRequests = 0;
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.pbf': 'application/x-protobuf' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/config') {
      res.setHeader('Set-Cookie', 'atlas-audit-session=preserve-me; HttpOnly; SameSite=Lax; Path=/');
      return json(200, { version: `commercial-fixture-${variant}`, features: { guide: guideEnabled, catalog: true, planner: true, pwa: true }, guide: { daily_limit: 30, csrf_token: 'fixture-proof' } });
    }
    if (url.pathname === '/api/catalog/status') return json(200, { status: 'ready', total: 3, by_source: { osm: 2, sample: 1 }, categories: [{ id: '카페', count: 3 }], built_at: '2026-09-10', refreshed_at: '2026-09-10', stale: false, attribution: 'OpenStreetMap', photos_count: 0, hours_week_count: 3 });
    if (url.pathname === '/api/catalog/search') {
      const q = url.searchParams.get('q') || '';
      const items = places.filter(place => place.name.includes(q));
      return json(200, { items, total: items.length, has_more: false });
    }
    if (url.pathname === '/api/catalog/points') {
      pointRequests++;
      return json(200, { type: 'FeatureCollection', features: places.map(place => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [place.lng, place.lat] }, properties: { id: place.id, name: place.name, category: place.category, source_label: place.source_label } })) });
    }
    if (url.pathname.startsWith('/api/catalog/places/')) {
      if (failDetail) return json(503, { error: { code: 'unavailable' } });
      return json(200, places.find(place => place.id === decodeURIComponent(url.pathname.slice('/api/catalog/places/'.length))) || places[0]);
    }
    if (url.pathname === '/api/weather') return json(503, { error: { code: 'unavailable' } });
    if (url.pathname === '/api/guide') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.message === '세션 복구 검사' && requests.filter(item => item.message === body.message).length === 1) return json(403, { error: { code: 'invalid_conversation' } });
      if (body.message === 'English recovery check' && requests.filter(item => item.message === body.message).length === 1) {
        const timer = setTimeout(() => { if (!res.destroyed) json(403, { error: { code: 'invalid_conversation' } }); }, 450);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(frame('session', { conversation_id: 'fixture-conversation' }));
      const timers = [
        setTimeout(() => { if (!res.destroyed) res.write(frame('status', { stage: 'tool', tool: 'find_places', label: '장소 검색', message: '장소를 찾고 있어요.' })); }, 50),
        setTimeout(() => { if (!res.destroyed) res.end(frame('text', { delta: body.locale === 'en' ? '**Controlled answer** in English.\n\n- Check sources\n- Confirm before visiting' : '**검사 답변**입니다.\n\n- 출처 확인\n- 방문 전 문의' }) + frame('done', {})); }, body.message.includes('기다림') ? 8000 : 350),
      ];
      res.on('close', () => timers.forEach(clearTimeout));
      return;
    }
    if (url.pathname.startsWith('/api/')) return json(404, {});
    const file = resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(root + sep) && file !== resolve(root, 'index.html')) return json(403, {});
    let data = await readFile(file);
    if (url.pathname === '/sw.js') data = Buffer.from(data.toString().replace(/jeju-atlas-shell-([a-f0-9]{16})/g, `jeju-atlas-shell-$1-fixture-${variant}`));
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function png(terrain) {
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, body) => {
    const data = Buffer.concat([Buffer.from(name), body]);
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
    return Buffer.concat([length, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((256 * 3 + 1) * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const i = y * 769 + 1 + x * 3;
    const height = 32768 + 300 + Math.round(300 * Math.sin(x / 255 * Math.PI) * Math.sin(y / 255 * Math.PI));
    raw[i] = terrain ? height >> 8 : 165; raw[i + 1] = terrain ? height & 255 : 196; raw[i + 2] = terrain ? 0 : 189;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dem = png(true);
const imagery = png(false);
let browser;
let page;
try {
  browser = await chromium.launch({
    executablePath: '/home/ec2-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome',
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const routeFixture = route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    if (url.pathname.includes('/terrarium/')) return route.fulfill({ contentType: 'image/png', body: dem, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.pathname.includes('/World_Imagery/MapServer/tile/')) return route.fulfill({ contentType: 'image/png', body: imagery, headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.abort();
  };
  await context.route('**/*', routeFixture);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  await page.waitForFunction(() => window.__JEJU_MAP__?.loaded() && !document.querySelector('#zoom-in').disabled, null, { timeout: 30000 });
  assert.equal(await page.locator('#catalog-map-toggle').isChecked(), false);
  assert.equal(pointRequests, 0);
  assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /NanumSquare/);
  pass('Initial quiet terrain map and NanumSquare remain intact');

  await page.evaluate(() => {
    const canvas = window.__JEJU_MAP__.getCanvas();
    window.__auditLostContext = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__auditLostContext.loseContext();
  });
  await page.locator('#map-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);
  await page.evaluate(() => window.__auditLostContext.restoreContext());
  await page.waitForFunction(() => !document.querySelector('#zoom-in').disabled, null, { timeout: 10000 });
  await page.locator('#map-notice').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.place-marker').count(), 12);
  pass('Real WebGL context loss/restoration re-enables controls without duplicate landmarks');

  const add = async (target, id) => {
    await target.locator('#tab-explore').click();
    await target.locator(`[data-catalog-id="${id}"]`).click();
    await target.locator('#detail-add-trip').click();
    await target.locator('[data-detail-action="close"]').click();
  };
  await add(page, 'fixture-a');
  await page.locator('#tab-trip').click();
  await page.locator('#trip-share').click();
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(shared.includes('trip='));
  await add(page, 'fixture-b');
  await page.reload();
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 2);
  pass('Editing after sharing and then reloading retains the edited course');

  const second = await context.newPage();
  await second.goto(base);
  await second.locator('#catalog-list [data-catalog-id="fixture-c"]').waitFor();
  await add(second, 'fixture-c');
  await page.waitForFunction(() => document.querySelectorAll('#trip-stops > li').length === 3);
  await second.close();
  pass('Another tab updates saved places without losing earlier additions');

  await page.locator('#trip-data').click();
  const dialog = page.locator('#saved-data-dialog');
  await dialog.waitFor({ state: 'visible' });
  const exported = page.waitForEvent('download');
  await page.locator('#saved-export').click();
  const download = await exported;
  const backupText = await readFile(await download.path(), 'utf8');
  const backup = JSON.parse(backupText);
  assert.equal(backup.stops.length, 3);
  assert.deepEqual(backup.stops[0].geometry.coordinates, [126.5, 33.4]);
  assert.equal(backup.stops[0].sources[0].note, '출처 보존 확인');
  await page.locator('#saved-delete').click();
  assert.match(await dialog.innerText(), /이 기기/);
  assert.match(await dialog.innerText(), /서버/);
  assert.equal(await page.locator('#saved-confirm').isDisabled(), true);
  await page.locator('#saved-delete-confirm').check();
  await page.locator('#saved-confirm').click();
  await page.waitForFunction(() => document.querySelectorAll('#trip-stops > li').length === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('jeju-atlas.saved.v1')), null);
  assert.ok((await context.cookies()).some(cookie => cookie.name === 'atlas-audit-session' && cookie.value === 'preserve-me'));
  pass('Backup includes full snapshots; reviewed device deletion leaves session cookies intact');

  await page.locator('#saved-import-file').setInputFiles({ name: 'trip-backup.json', mimeType: 'application/json', buffer: Buffer.from(backupText) });
  await page.locator('#saved-import-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#trip-stops > li').count(), 0);
  await page.locator('#saved-confirm').click();
  await page.waitForFunction(() => document.querySelectorAll('#trip-stops > li').length === 3);
  await page.locator('#saved-import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await page.waitForFunction(() => /버전|형식/.test(document.querySelector('#saved-data-status').textContent));
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  await dialog.screenshot({ path: resolve(output, 'data-management.png') });
  const injected = structuredClone(backup);
  injected.stops[0].name = '<img src=x onerror="window.__savedXss=1">';
  await page.locator('#saved-import-file').setInputFiles({ name: 'untrusted.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(injected)) });
  await page.locator('#saved-import-preview').waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('img,script,iframe').count(), 0);
  assert.match(await dialog.innerText(), /<img src=x/);
  assert.equal(await page.evaluate(() => window.__savedXss), undefined);
  await page.locator('#saved-back').click();
  await page.locator('#saved-data-close').click();
  await page.waitForFunction(() => document.activeElement?.id === 'trip-data', null, { timeout: 3000 });
  assert.equal(await page.locator('#trip-data').evaluate(node => node === document.activeElement), true);
  pass('File import requires review, rejects invalid input and restores control focus');

  const deniedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
  await deniedContext.route('**/*', routeFixture);
  const denied = await deniedContext.newPage();
  await denied.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('jeju-atlas.saved.v1')) throw new DOMException('controlled quota refusal', 'QuotaExceededError');
      return write.call(this, key, value);
    };
  });
  await denied.goto(base);
  await denied.locator('[data-catalog-id="fixture-a"]').click();
  await denied.locator('#detail-add-trip').click();
  await denied.locator('#detail-save-status').waitFor({ state: 'visible' });
  assert.match(await denied.locator('#toast').innerText(), /저장.*못|저장 공간/);
  assert.equal(await denied.evaluate(() => localStorage.getItem('jeju-atlas.saved.v1')), null);
  await denied.locator('[data-detail-action="close"]').click();
  await denied.locator('#tab-trip').click();
  await denied.locator('#trip-data').click();
  const failedDownload = denied.waitForEvent('download');
  await denied.locator('#saved-export').click();
  const draftFile = await failedDownload;
  assert.equal(JSON.parse(await readFile(await draftFile.path(), 'utf8')).stops.length, 1);
  await denied.locator('#saved-discard').click();
  await denied.locator('#saved-discard-confirm').check();
  await denied.locator('#saved-confirm').click();
  await denied.waitForFunction(() => document.querySelectorAll('#trip-stops > li').length === 0);
  await deniedContext.close();
  pass('Quota failure stays visible, exports its unsaved draft and supports reviewed discard');

  const privateContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
  await privateContext.route('**/*', routeFixture);
  const privatePage = await privateContext.newPage();
  privatePage.on('pageerror', error => errors.push(error.message));
  await privatePage.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('controlled storage denial', 'SecurityError'); } });
    Object.defineProperty(navigator, 'serviceWorker', { get() { throw new DOMException('controlled worker denial', 'SecurityError'); } });
  });
  await privatePage.goto(base);
  await privatePage.locator('[data-catalog-id="fixture-a"]').click();
  await privatePage.locator('#detail-add-trip').click();
  await privatePage.locator('#detail-save-status').waitFor({ state: 'visible' });
  await privatePage.locator('[data-detail-action="close"]').click();
  await privatePage.locator('#tab-trip').click();
  await privatePage.locator('#trip-data').click();
  const privateExport = privatePage.waitForEvent('download');
  await privatePage.locator('#saved-export').click();
  assert.equal(JSON.parse(await readFile(await (await privateExport).path(), 'utf8')).stops.length, 1);
  await privateContext.close();
  pass('Denied localStorage and service-worker access still allow browsing, editing and export');

  await page.locator('#tab-explore').click();
  failDetail = true;
  await page.locator('[data-catalog-id="fixture-a"]').click();
  await page.locator('[data-detail-action="retry"]').waitFor();
  assert.doesNotMatch(await page.locator('#catalog-detail').innerText(), /불러오는 중/);
  failDetail = false;
  await page.locator('[data-detail-action="retry"]').click();
  await page.locator('#detail-add-trip').waitFor();
  await page.locator('#tab-guide').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#tab-guide').evaluate(node => node === document.activeElement), true);
  pass('Detail retry replaces loading state; tab activation retains keyboard focus');

  const send = async text => {
    await page.locator('#guide-input').fill(text);
    await page.locator('#guide-send').click();
    await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
  };
  await send('세션 복구 검사');
  const recovered = requests.filter(request => request.message === '세션 복구 검사');
  assert.equal(recovered.length, 2);
  assert.match(recovered[0].request_id, uuid);
  assert.equal(recovered[0].request_id, recovered[1].request_id);
  await send('새 질문 검사');
  assert.notEqual(requests.at(-1).request_id, recovered[0].request_id);
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  assert.equal(await page.locator('#guide-tool-list [data-tool="find_places"]').count(), 1);
  await page.locator('.guide-markdown strong').last().waitFor();
  pass('Per-submission UUIDs survive auth recovery and preserve real tools, Markdown and suggestions');

  guideEnabled = false;
  await page.locator('#guide-refresh').click();
  await page.waitForFunction(() => document.querySelector('#guide-availability').textContent.includes('중지'));
  guideEnabled = true;
  await send('서비스 재개 검사');
  assert.equal(requests.at(-1).message, '서비스 재개 검사');
  await page.locator('#guide-input').fill('기다림 초기화 검사');
  await page.locator('#guide-send').click();
  await page.locator('#guide-thinking').waitFor({ state: 'visible' });
  await page.locator('#guide-new-chat').click();
  assert.equal(await page.locator('#guide-messages .chat-message').count(), 0);
  await send('초기화 뒤 질문');
  assert.equal(requests.at(-1).conversation_id, undefined);
  assert.equal(await page.locator('.chat-message--user').count(), 1);
  pass('Service availability refreshes; new conversation aborts the old stream and retains the actor cookie');

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 });
  variant++;
  await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
  await page.locator('#pwa-update').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#guide-input').fill('아직 보내지 않은 질문');
  await page.locator('#pwa-update-apply').click();
  assert.equal(await page.locator('#guide-input').inputValue(), '아직 보내지 않은 질문');
  assert.match(await page.locator('#pwa-update-status').innerText(), /질문|편집|완료|저장/);
  await page.locator('#guide-input').fill('');
  const busyTab = await context.newPage();
  await busyTab.goto(base);
  await busyTab.locator('#tab-guide').click();
  await busyTab.locator('#guide-input').fill('다른 탭에서 작성 중');
  await page.locator('#pwa-update-apply').click();
  await page.waitForFunction(() => /다른 탭/.test(document.querySelector('#pwa-update-status').textContent));
  assert.equal(await busyTab.locator('#guide-input').inputValue(), '다른 탭에서 작성 중');
  await busyTab.close();
  await page.locator('#pwa-update-apply').click();
  await page.waitForFunction(async () => (await caches.keys()).some(name => name.endsWith('-fixture-2')), null, { timeout: 20000 });
  await page.locator('#pwa-update').waitFor({ state: 'hidden', timeout: 20000 });
  pass('Waiting update checks drafts in every tab and applies only after they are safe');

  await context.setOffline(true);
  await page.reload();
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  await page.locator('#trip-data').click();
  assert.equal(await page.locator('#saved-export').isEnabled(), true);
  await page.locator('#saved-data-close').click();
  const cachePaths = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat());
  assert.ok(!cachePaths.some(path => path.startsWith('/api/') || path.includes('/terrarium/')));
  await context.setOffline(false);
  pass('Updated shell loads saved courses offline and never caches APIs or terrain');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#drawer-toggle').click();
  await page.locator('#tab-explore').click();
  await page.locator('[data-catalog-id="fixture-a"]').click();
  await page.locator('#detail-add-trip').waitFor();
  await page.locator('[data-detail-action="close"]').click();
  assert.equal(await page.locator('#drawer-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[inert]'))), false);
  await page.locator('#tab-guide').click();
  assert.equal(await page.locator('#guide-followups button').count(), 3);
  assert.ok(await page.locator('#guide-followups').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
  await page.screenshot({ path: resolve(output, 'mobile-guide.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 720, height: 500 });
  assert.ok(await page.locator('#guide-followups').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
  assert.ok(await page.locator('#guide-messages').evaluate(node => node.getBoundingClientRect().height >= 50));
  pass('Mobile detail returns to a usable drawer; guide footer stays reachable at narrow widths');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { window.__auditLocaleMap = window.__JEJU_MAP__; });
  const callsBeforeToggle = requests.length;
  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('#tab-trip').textContent.includes('My trip'));
  assert.equal(await page.evaluate(() => window.__auditLocaleMap === window.__JEJU_MAP__), true);
  assert.equal(requests.length, callsBeforeToggle);
  assert.equal(await page.locator('#language-toggle').innerText(), '한국어');
  assert.match(await page.locator('#guide-followups').innerText(), /Find food|Nearby food|Nature walks/);
  assert.equal(await page.locator('#guide-input').getAttribute('placeholder'), 'Tell us where you want to go and what you enjoy.');
  await page.locator('#tab-explore').click();
  assert.equal(await page.locator('[data-catalog-id="fixture-a"] strong').innerText(), 'Audit Café One');
  assert.equal(await page.locator('[data-catalog-id="fixture-b"] strong').innerText(), '검사 카페 둘');
  await page.locator('[data-catalog-id="fixture-a"]').click();
  await page.locator('#detail-add-trip').waitFor();
  assert.equal(await page.locator('#catalog-detail h2').innerText(), 'Audit Café One');
  await page.locator('#catalog-reference-details > summary').click();
  assert.equal(await page.locator('#catalog-reference-details').getAttribute('open'), '');
  assert.equal(await page.locator('[data-evidence-field="lat"]').getAttribute('data-evidence-state'), 'unverified');
  assert.match(await page.locator('[data-evidence-field="facilities.parking"]').innerText(), /Source unconfirmed/);
  assert.match(await page.locator('.hours-table caption').innerText(), /parsed.*Closed days unconfirmed/);
  assert.match(await page.locator('#business-registration').innerText(), /Licensing status/);
  assert.doesNotMatch(await page.locator('#business-registration').innerText(), /open now/i);
  await page.locator('#catalog-detail').screenshot({ path: resolve(output, 'english-place-evidence.png') });
  await page.locator('[data-detail-action="close"]').click();
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops .trip-place-name').first().innerText(), 'Audit Café One');
  await page.locator('#trip-data').click();
  assert.match(await page.locator('#saved-data-title').innerText(), /Travel data on this device/);
  assert.doesNotMatch(await page.locator('.saved-data-summary').innerText(), /[가-힣]/);
  await page.locator('.device-privacy').last().locator('summary').click();
  assert.match(await page.locator('#saved-data-dialog').innerText(), /AWS|server/);
  await page.locator('#saved-data-dialog').screenshot({ path: resolve(output, 'english-data-management.png') });
  await page.locator('#saved-data-close').click();
  await page.locator('#tab-guide').click();
  await page.locator('#guide-input').fill('English recovery check');
  await page.locator('#guide-send').click();
  await page.locator('#guide-thinking').waitFor({ state: 'visible' });
  assert.match(await page.locator('#guide-thinking').innerText(), /Thinking/);
  await page.locator('#language-toggle').click();
  await page.waitForFunction(() => !document.querySelector('#guide-send').disabled);
  const englishRequests = requests.filter(request => request.message === 'English recovery check');
  assert.equal(englishRequests.length, 2);
  assert.ok(englishRequests.every(request => request.locale === 'en'));
  assert.equal(englishRequests[0].request_id, englishRequests[1].request_id);
  assert.match(await page.locator('.chat-message--assistant').last().innerText(), /Controlled answer/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  await page.locator('#language-toggle').click();
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('#tab-trip').click();
  assert.equal(await page.locator('#trip-stops > li').count(), 3);
  await page.locator('#tab-guide').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#drawer-toggle').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('#guide-followups').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
  await page.screenshot({ path: resolve(output, 'english-mobile-guide.png'), fullPage: true });
  pass('KO/EN changes labels and supplied names without reloading the map, persists, and captures the answer locale through recovery');

  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, controlledAPIs: true, generatedTileFixtures: true, noModelCalls: true, checks, requests, errors }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: false, checks, requests, errors, failure: error.stack }, null, 2));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
