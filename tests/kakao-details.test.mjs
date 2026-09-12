import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/api.ts';
import { setLocale } from '../src/i18n.ts';

let KakaoDetails;
try { ({ KakaoDetails } = await import('../src/kakao-details.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const tick = () => new Promise(resolve => setImmediate(resolve));
const first = { id: 'osm:node/7036109099', name: '협재해변', lng: 126.24, lat: 33.39 };
const second = { id: 'seed:hallasan', name: '한라산' };
const lookup = (canonical = first, overrides = {}) => ({
  available: true, status: 'matched', canonical_id: canonical.id,
  queried_at: '2026-09-10T03:04:05.000Z', source: 'Kakao Local',
  place: {
    id: '123456789', name: '협재해변', category: '여행 > 해수욕장',
    address: '제주 제주시 한림읍 협재리', road_address: '제주 제주시 한림읍 한림로 329',
    phone: '064-123-4567', url: 'https://place.map.kakao.com/123456789',
  },
  match: { method: 'name_category_distance', distance_m: 42 },
  ...overrides,
});

// A replaceable mount exercises the real panel/model and network boundary.
// Full DOM layout and native focus behavior need the integrated browser check.
function mount() {
  return {
    hidden: true, innerHTML: '', attributes: new Map(),
    ownerDocument: { activeElement: null },
    contains() { return false; }, querySelector() { return null; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

async function fixture(t, config = { kakao: { enabled: true, csrf_token: 'first-proof' } }) {
  assert.equal(typeof KakaoDetails, 'function', 'the supplementary panel must be implemented');
  const originalFetch = globalThis.fetch;
  const f = { root: mount(), config, requests: [], pending: [] };
  globalThis.fetch = (url, init) => {
    f.requests.push({ url, init });
    if (url === '/api/config') return Promise.resolve(Response.json(f.config));
    assert.match(url, /^\/api\/kakao\/place\?id=/, 'all requests stay on the local API');
    return new Promise((resolve, reject) => f.pending.push({ url, init, resolve, reject }));
  };
  t.after(() => {
    f.panel?.clear();
    globalThis.fetch = originalFetch;
    setLocale('ko', null);
  });
  await getConfig(true);
  f.panel = new KakaoDetails(() => f.root);
  return f;
}

test('older and disabled configurations hide the entire card without a place lookup', async t => {
  for (const config of [{}, { kakao: { enabled: false } }, { kakao: { enabled: 'true' } }]) {
    await t.test(JSON.stringify(config), async t => {
      const f = await fixture(t, config);
      f.panel.show(first);
      await tick();
      assert.equal(f.root.hidden, true);
      assert.equal(f.root.innerHTML, '');
      f.root = mount();
      f.panel.show(first);
      assert.equal(f.root.hidden, true);
      assert.equal(f.pending.length, 0);
      assert.equal(f.requests.length, 1, 'remounting a disabled view does not fetch config again');
    });
  }
});

test('matched data uses only the canonical ID request and safely renders source fields', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  const request = f.pending[0];
  assert.equal(request.url, '/api/kakao/place?id=osm%3Anode%2F7036109099');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.headers['X-Atlas-CSRF'], 'first-proof');
  assert.equal(request.init.body, undefined);
  const data = lookup();
  data.place.name = '<img src=x onerror=alert(1)> & 해변';
  data.place.category = '여행 > 해수욕장';
  request.resolve(Response.json(data));
  await tick();
  assert.equal(f.root.hidden, false);
  assert.match(f.root.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; &amp; 해변/);
  assert.doesNotMatch(f.root.innerHTML, /<img|onerror="/);
  assert.match(f.root.innerHTML, /여행 &gt; 해수욕장/);
  assert.match(f.root.innerHTML, /한림로 329/);
  assert.doesNotMatch(f.root.innerHTML, /협재리/);
  assert.match(f.root.innerHTML, /href="tel:0641234567"/);
  assert.match(f.root.innerHTML, /href="https:\/\/place\.map\.kakao\.com\/123456789"/);
  assert.match(f.root.innerHTML, /rel="noopener noreferrer"/);
  assert.match(f.root.innerHTML, /Kakao Local/);
  assert.match(f.root.innerHTML, /<time datetime="2026-09-10T03:04:05.000Z"/);
  assert.doesNotMatch(f.root.innerHTML, /name_category_distance|distance_m|osm:node|영업 중|리뷰/);
});

test('a locale change during loading or after completion remounts without another lookup', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  const oldRoot = f.root;
  setLocale('en', null);
  f.root = mount();
  f.panel.show(first);
  assert.match(f.root.innerHTML, /Loading/i);
  f.pending[0].resolve(Response.json(lookup()));
  await tick();
  assert.match(f.root.innerHTML, /Kakao visiting information/);
  assert.match(f.root.innerHTML, /not independently reviewed/i);
  assert.doesNotMatch(oldRoot.innerHTML, /123456789/);
  setLocale('ko', null);
  f.root = mount();
  f.panel.show(first);
  assert.match(f.root.innerHTML, /카카오 방문 정보/);
  assert.match(f.root.innerHTML, /123456789/);
  assert.equal(f.requests.length, 2, 'language changes reuse only the current-view result');
});

test('switching places aborts the old request and its late response cannot replace the new place', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  f.root = mount();
  f.panel.show(second);
  await tick();
  assert.equal(f.pending[0].init.signal.aborted, true);
  const data = lookup(second);
  data.place.name = '한라산';
  f.pending[1].resolve(Response.json(data));
  await tick();
  f.pending[0].resolve(Response.json(lookup()));
  await tick();
  assert.match(f.root.innerHTML, /한라산/);
  assert.doesNotMatch(f.root.innerHTML, /협재해변/);
});

test('closing clears the result and reopening the same place cannot reuse a cancelled response', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  f.panel.clear();
  assert.equal(f.pending[0].init.signal.aborted, true);
  assert.equal(f.root.hidden, true);
  assert.equal(f.root.innerHTML, '');
  f.panel.show(first);
  await tick();
  f.pending[0].resolve(Response.json(lookup()));
  await tick();
  assert.doesNotMatch(f.root.innerHTML, /123456789/);
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(Response.json(lookup(first, { status: 'not_found', place: null })));
  await tick();
  assert.match(f.root.innerHTML, /map\.kakao\.com\/link\/search\//);
});

test('closing while config is pending prevents a later place lookup', async t => {
  const f = await fixture(t);
  let resolveConfig;
  globalThis.fetch = (url, init) => {
    f.requests.push({ url, init });
    if (url !== '/api/config') throw new Error('A closed detail must not start a lookup');
    return new Promise(resolve => { resolveConfig = resolve; });
  };
  const pendingConfig = getConfig(true);
  f.panel.show(first);
  f.panel.clear();
  resolveConfig(Response.json({ kakao: { enabled: true, csrf_token: 'late-proof' } }));
  await pendingConfig;
  await tick();
  assert.equal(f.pending.length, 0);
  assert.ok(f.requests.every(request => request.url === '/api/config'));
  assert.equal(f.root.hidden, true);
});

test('invalid canonical inputs cannot start a lookup or break name-search rendering', async t => {
  for (const place of [
    { id: 'osm:node/1?query=another-place', name: '장소' },
    { id: first.id, name: 'broken \ud800' },
  ]) {
    await t.test(JSON.stringify(place), async t => {
      const f = await fixture(t);
      f.panel.show(place);
      await tick();
      assert.equal(f.pending.length, 0);
      assert.equal(f.root.hidden, true);
    });
  }
});

for (const status of [401, 403]) {
  test(`HTTP ${status} refreshes config once and retries with the refreshed CSRF proof`, async t => {
    const f = await fixture(t);
    f.panel.show(first);
    await tick();
    f.config = { kakao: { enabled: true, csrf_token: 'fresh-proof' } };
    f.pending[0].resolve(new Response('', { status }));
    await tick();
    assert.equal(f.requests.filter(r => r.url === '/api/config').length, 2);
    assert.equal(f.pending.length, 2);
    assert.equal(f.pending[1].init.headers['X-Atlas-CSRF'], 'fresh-proof');
    assert.equal(f.pending[1].url, f.pending[0].url);
    f.pending[1].resolve(new Response('', { status }));
    await tick();
    assert.equal(f.pending.length, 2, 'a second authentication error must not loop');
    assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
  });
}

test('a refreshed disabled config prevents the authentication retry and hides the card', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  f.config = { kakao: { enabled: false } };
  f.pending[0].resolve(new Response('', { status: 403 }));
  await tick();
  assert.equal(f.pending.length, 1);
  assert.equal(f.root.hidden, true);
  assert.equal(f.root.innerHTML, '');
});

for (const status of [429, 502, 503, 'network']) {
  test(`${status} leaves an optional unavailable card with explicit recovery`, async t => {
    const f = await fixture(t);
    f.panel.show(first);
    await tick();
    if (status === 'network') f.pending[0].reject(new TypeError('Failed to fetch'));
    else f.pending[0].resolve(new Response('not JSON', { status }));
    await tick();
    assert.equal(f.root.hidden, false);
    assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
    assert.equal(f.pending.length, 1, 'provider failures are not automatically retried');
    f.panel.retry();
    f.panel.retry();
    await tick();
    assert.equal(f.pending.length, 2, 'rapid retries share the one active request');
    assert.equal(f.requests.filter(r => r.url === '/api/config').length, 2);
    f.pending[1].resolve(Response.json(lookup()));
    await tick();
    assert.match(f.root.innerHTML, /123456789/);
    assert.doesNotMatch(f.root.innerHTML, /data-detail-action="kakao-retry"/);
  });
}

test('a stalled lookup becomes unavailable and aborts rather than loading indefinitely', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.panel.show(first);
  await tick();
  t.mock.timers.tick(20_001);
  await tick();
  assert.equal(f.pending[0].init.signal.aborted, true);
  assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
});

test('an enabled config without a valid proof offers retry without sending a place request', async t => {
  const f = await fixture(t, { kakao: { enabled: true, csrf_token: 'unsafe\nproof' } });
  f.panel.show(first);
  await tick();
  assert.equal(f.pending.length, 0);
  assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
});

test('empty and ambiguous results offer a labelled name search, never an exact-place link', async t => {
  for (const status of ['not_found', 'ambiguous', 'unsupported']) {
    await t.test(status, async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      f.pending[0].resolve(Response.json(lookup(first, { status, place: null })));
      await tick();
      assert.doesNotMatch(f.root.innerHTML, /href="https:\/\/place\.map\.kakao\.com/);
      assert.doesNotMatch(f.root.innerHTML, /data-detail-action="kakao-retry"/);
      if (status !== 'unsupported') {
        assert.match(f.root.innerHTML, /카카오맵에서 장소 찾기/);
        assert.ok(f.root.innerHTML.includes('https://map.kakao.com/link/search/%EC%A0%9C%EC%A3%BC%20%ED%98%91%EC%9E%AC%ED%95%B4%EB%B3%80'));
      }
    });
  }
});

test('lookup reasons explain the matching limitation in both languages and survive remounts', async t => {
  const cases = [
    { reason: 'no_results', status: 'not_found', ko: /이 이름과 위치/, en: /this name and location/i },
    { reason: 'name_mismatch', status: 'not_found', ko: /이름이나 지점명/, en: /name or branch/i },
    { reason: 'category_mismatch', status: 'not_found', ko: /장소 분류가 달라/, en: /category differs/i },
    { reason: 'distance_mismatch', status: 'not_found', ko: /등록된 위치가 달라/, en: /registered location differs/i },
    { reason: 'multiple_candidates', status: 'ambiguous', ko: /같은 이름의 장소가 여러 곳/, en: /places share this name/i },
    { reason: 'incomplete_results', status: 'ambiguous', ko: /검색 결과가 많거나 일부만/, en: /too many or incomplete search results/i },
  ];
  for (const { reason, status, ko, en } of cases) {
    await t.test(reason, async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      f.pending[0].resolve(Response.json(lookup(first, { status, place: null, reason })));
      await tick();
      const message = f.root.innerHTML.match(/<p class="kakao-details-message">([^<]+)<\/p>/)?.[1];
      assert.equal(f.root.hidden, false);
      assert.match(message ?? '', ko);
      if (reason === 'no_results') assert.match(message, /다른 이름으로 등록되어 있을 수/);
      assert.doesNotMatch(f.root.innerHTML, /no_results|name_mismatch|category_mismatch|distance_mismatch|multiple_candidates|incomplete_results/);
      assert.doesNotMatch(f.root.innerHTML, /data-detail-action="kakao-retry"|href="https:\/\/place\.map\.kakao\.com/);
      assert.ok(f.root.innerHTML.includes('https://map.kakao.com/link/search/%EC%A0%9C%EC%A3%BC%20%ED%98%91%EC%9E%AC%ED%95%B4%EB%B3%80'));
      setLocale('en', null);
      f.root = mount();
      f.panel.show(first);
      const english = f.root.innerHTML.match(/<p class="kakao-details-message">([^<]+)<\/p>/)?.[1];
      assert.match(english ?? '', en);
      if (reason === 'no_results') assert.match(english, /may be listed under another name/i);
      assert.match(f.root.innerHTML, /Search for this place on Kakao Map/);
      assert.doesNotMatch(f.root.innerHTML, /place (?:does not|doesn.t) exist/i);
      assert.equal(f.requests.length, 2, 'the reason is retained with the current result, without a language lookup');
    });
  }
});

test('older responses without a reason keep a generic automatic-match explanation and the search link', async t => {
  for (const status of ['not_found', 'ambiguous']) {
    await t.test(status, async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      f.pending[0].resolve(Response.json(lookup(first, { status, place: null })));
      await tick();
      assert.match(f.root.innerHTML, /자동 연결을 확정하지 못했어요\./);
      assert.match(f.root.innerHTML, /카카오맵에서 장소 찾기/);
      assert.doesNotMatch(f.root.innerHTML, /검색 결과가 없어요|같은 이름의 장소가 여러 곳|data-detail-action="kakao-retry"/);
      setLocale('en', null);
      f.root = mount();
      f.panel.show(first);
      assert.match(f.root.innerHTML, /An automatic match could not be confirmed\./);
      assert.equal(f.requests.length, 2);
    });
  }
});

test('unknown or malformed lookup reasons fail validation without exposing provider text', async t => {
  for (const reason of ['__proto__', 'constructor', 'new_reason', '<img src=x onerror=alert(1)>', null, 42, ['no_results'], { code: 'no_results' }]) {
    await t.test(JSON.stringify(reason), async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      f.pending[0].resolve(Response.json(lookup(first, { status: 'not_found', place: null, reason })));
      await tick();
      assert.equal(f.root.hidden, false);
      assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
      assert.doesNotMatch(f.root.innerHTML, /__proto__|constructor|new_reason|onerror|no_results|map\.kakao\.com\/link\/search/);
    });
  }
});

test('missing road address falls back to address and unsafe phone text cannot create a tel link', async t => {
  const f = await fixture(t);
  f.panel.show(first);
  await tick();
  const data = lookup();
  data.place.road_address = null;
  data.place.phone = '<a href="javascript:alert(1)">전화</a>';
  f.pending[0].resolve(Response.json(data));
  await tick();
  assert.match(f.root.innerHTML, /협재리/);
  assert.doesNotMatch(f.root.innerHTML, /href="tel:|href="javascript:/);
  assert.match(f.root.innerHTML, /&lt;a href=&quot;javascript:/);
});

test('malformed identity, fields, dates and exact-place links are unavailable at the browser boundary', async t => {
  const invalid = [
    data => { data.canonical_id = second.id; },
    data => { data.available = false; },
    data => { data.source = 'another provider'; },
    data => { data.status = 'open'; },
    data => { data.place = null; },
    data => { data.status = 'not_found'; },
    data => { data.place.name = 7; },
    data => { data.place.name = 'a'.repeat(501); },
    data => { data.place.category = 'a'.repeat(501); },
    data => { data.place.address = {}; },
    data => { data.place.road_address = 'a'.repeat(1001); },
    data => { data.place.phone = 641234567; },
    data => { data.place.phone = 'a'.repeat(201); },
    data => { data.place.name = 'bad\u0000name'; },
    data => { data.place.name = 'broken \ud800'; },
    data => { data.place.id = 'not-numeric'; },
    data => { data.place.url = 'javascript:alert(1)'; },
    data => { data.place.url = 'http://place.map.kakao.com/123456789'; },
    data => { data.place.url = 'https://place.map.kakao.com.evil.test/123456789'; },
    data => { data.place.url = 'https://place.map.kakao.com@evil.test/123456789'; },
    data => { data.place.url = 'https://place.map.kakao.com/987654321'; },
    data => { data.place.url += '?redirect=https://evil.test'; },
    data => { data.queried_at = '2026-02-30T03:04:05.000Z'; },
    data => { data.queried_at = '2026-09-10T03:04:05'; },
    data => { data.queried_at = '20999-09-10T03:04:05.000Z'; },
    data => { data.match.distance_m = -1; },
    data => { data.match.distance_m = 1e20; },
    data => { data.match.method = 'reviewed'; },
  ];
  for (const [index, change] of invalid.entries()) {
    await t.test(`invalid response ${index + 1}`, async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      const data = lookup();
      change(data);
      f.pending[0].resolve(Response.json(data));
      await tick();
      assert.equal(f.root.hidden, false);
      assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
      assert.doesNotMatch(f.root.innerHTML, /href="https:\/\/place\.map\.kakao\.com/);
    });
  }
});

test('non-JSON and oversized responses cannot publish a place', async t => {
  for (const body of ['<html>Bad gateway</html>', ' '.repeat(33_000) + JSON.stringify(lookup())]) {
    await t.test(body.length.toString(), async t => {
      const f = await fixture(t);
      f.panel.show(first);
      await tick();
      f.pending[0].resolve(new Response(body));
      await tick();
      assert.match(f.root.innerHTML, /data-detail-action="kakao-retry"/);
      assert.doesNotMatch(f.root.innerHTML, /href="https:\/\/place\.map\.kakao\.com/);
    });
  }
});
