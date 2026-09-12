import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';

const key = 'discovery-provider-fixture-key';
const request = { query: '', category: '맛집', scope: 'nearby', center: { lat: 33.4, lng: 126.5 }, radius_m: 2000, page: 1 };
const native = { id: '12345', place_name: '검사국수', category_group_code: 'FD6', category_group_name: '음식점',
  category_name: '음식점 > 한식', address_name: '제주 시험 주소', road_address_name: '제주 시험로 1',
  x: '126.5', y: '33.4', phone: '064-000-0000', place_url: 'http://place.map.kakao.com/12345', distance: '0' };

async function fixture(t, { discoveryEnabled = true, budgetError } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-discovery-api-'));
  await writeFile(join(root, 'index.html'), '<title>test</title>');
  let calls = 0, budgets = 0, now = Date.now(), doc = structuredClone(native);
  const api = createApiHandler({
    env: { NODE_ENV: 'test', KAKAO_REST_API_KEY: key, KAKAO_DISCOVERY_ENABLED: String(discoveryEnabled) },
    publicOrigin: 'https://atlas.test', secret: 'discovery-http-secret'.repeat(3), clock: () => now,
    catalog: {
      status: () => ({ status: 'ready' }), refreshIfNeeded: async () => {},
      search: () => ({ items: [], total: 0, has_more: false }),
      detail: id => id === 'legacy-1' ? { id, name: '기존 저장 장소', source: 'sample', category: '해변', lat: 33.4, lng: 126.5 } : null,
    },
    kakaoOptions: {
      consumeBudget: async () => { budgets++; if (budgetError) throw budgetError; },
      fetch: async (_url, options) => {
        calls++;
        assert.equal(options.headers.Authorization, `KakaoAK ${key}`);
        return new Response(JSON.stringify({
          meta: { total_count: doc ? 1 : 0, pageable_count: doc ? 1 : 0, is_end: true },
          documents: doc ? [doc] : [],
        }), { headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  const server = createAppServer({ root, api });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    api.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = await fetch(base + '/api/config');
  const cookie = config.headers.get('set-cookie')?.split(';')[0];
  const settings = await config.json();
  return {
    api, settings, calls: () => calls, budgets: () => budgets,
    expire: () => { now += 16 * 60_000; }, change: value => { doc = value; },
    post: (path, body, headers = {}) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie,
        'X-Atlas-CSRF': settings.discovery?.csrf_token ?? '', ...headers }, body: JSON.stringify(body),
    }),
    get: path => fetch(base + path),
    secondSession: async () => {
      const response = await fetch(base + '/api/config');
      const data = await response.json();
      return { Cookie: response.headers.get('set-cookie')?.split(';')[0], 'X-Atlas-CSRF': data.discovery.csrf_token };
    },
  };
}

test('new discovery is advertised without provider credentials and preserves legacy lookup/config', async t => {
  const f = await fixture(t);
  assert.equal(f.settings.discovery.enabled, true);
  assert.equal(f.settings.discovery.max_results, 45);
  assert.equal(f.settings.discovery.page_size, 15);
  assert.deepEqual(f.settings.discovery.categories, ['맛집', '카페', '숙소', '주차장']);
  assert.equal(f.settings.kakao.enabled, true);
  assert.equal(JSON.stringify(f.settings).includes(key), false);
  assert.equal(f.calls(), 0);
  const legacy = await f.get('/api/catalog/places/legacy-1');
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).id, 'legacy-1');
});

test('native search and detail share session proof; opening a selected card adds no provider call', async t => {
  const f = await fixture(t);
  const response = await f.post('/api/kakao/search', request, { Origin: 'null' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json();
  assert.equal(page.items[0].id, 'kakao:12345');
  assert.equal(page.items[0].address, '제주 시험로 1');
  assert.equal(page.items[0].provider_category, '음식점 > 한식');
  assert.equal(JSON.stringify(page).includes(key), false);
  assert.equal(f.calls(), 1);
  const detail = await f.post('/api/kakao/detail', { token: page.items[0].selection_token });
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  assert.equal((await detail.json()).kakao_lookup.place.url, 'https://place.map.kakao.com/12345');
  assert.equal(f.calls(), 1);
  assert.equal(f.budgets(), 1);
});

test('bad methods, cookies, proofs, requests and cross-session selections cannot call the provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('/api/kakao/search')).status, 405);
  assert.equal((await f.post('/api/kakao/search', request, { Cookie: '' })).status, 401);
  assert.equal((await f.post('/api/kakao/search', request, { Origin: 'https://foreign.test', 'X-Atlas-CSRF': 'forged' })).status, 403);
  for (const body of [null, { ...request, category: 'not-a-category' }, { ...request, center: { lat: 37.5, lng: 127 } },
    { ...request, page: 4 }, { ...request, apiKey: 'client-key' }]) {
    assert.equal((await f.post('/api/kakao/search', body)).status, 400);
  }
  assert.equal(f.calls(), 0);
  assert.equal(f.budgets(), 0);
  const page = await (await f.post('/api/kakao/search', request)).json();
  const other = await f.secondSession();
  assert.equal((await f.post('/api/kakao/detail', { token: page.items[0].selection_token }, other)).status, 400);
  assert.equal((await f.post('/api/kakao/detail', { token: 'forged' })).status, 400);
  assert.equal(f.calls(), 1);
});

test('expired selections can be refreshed only through a new exact provider-ID lookup', async t => {
  const f = await fixture(t);
  const page = await (await f.post('/api/kakao/search', request)).json();
  f.expire();
  const expired = await f.post('/api/kakao/detail', { token: page.items[0].selection_token });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error.code, 'kakao_selection_expired');
  const hint = { id: 'kakao:12345', name: '검사국수', category: '맛집', lat: 33.4, lng: 126.5 };
  const refreshed = await f.post('/api/kakao/reopen', hint);
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).id, hint.id);
  assert.equal(f.calls(), 2);
  f.change({ ...native, id: '54321', place_url: 'https://place.map.kakao.com/54321' });
  const different = await f.post('/api/kakao/reopen', hint);
  assert.equal(different.status, 404);
  assert.equal((await different.json()).error.code, 'kakao_place_unavailable');
  assert.equal((await f.post('/api/kakao/reopen', { ...hint, id: 'legacy-1' })).status, 400);
  assert.equal(f.calls(), 3);
});

test('discovery disable/drain and rate admission keep the original catalog available', async t => {
  const disabled = await fixture(t, { discoveryEnabled: false });
  assert.equal(disabled.settings.discovery.enabled, false);
  assert.equal(disabled.settings.kakao.enabled, true);
  assert.equal((await disabled.post('/api/kakao/search', request)).status, 503);
  assert.equal((await disabled.get('/api/catalog/places/legacy-1')).status, 200);
  const active = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await active.post('/api/kakao/search', request)).status, 200);
  assert.equal((await active.post('/api/kakao/search', request)).status, 429);
  assert.equal(active.calls(), 20);
  active.api.beginDrain();
  assert.equal((await active.post('/api/kakao/search', request)).status, 503);
});

test('replayed detail selections remain rate limited without more provider charges', async t => {
  const f = await fixture(t);
  const page = await (await f.post('/api/kakao/search', request)).json();
  const body = { token: page.items[0].selection_token };
  for (let i = 0; i < 19; i++) assert.equal((await f.post('/api/kakao/detail', body)).status, 200);
  const limited = await f.post('/api/kakao/detail', body);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(f.calls(), 1);
  assert.equal(f.budgets(), 1);
});
