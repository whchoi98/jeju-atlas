import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';

const key = '0'.repeat(32);
const place = { id: 'poi_0093', name: '우진해장국', source: 'sample', category: '맛집',
  lat: 33.5115, lng: 126.5202, phone: null, address: null };
const providerBody = {
  meta: { total_count: 1, pageable_count: 1, is_end: true },
  documents: [{ id: '12345', place_name: '우진해장국', category_group_code: 'FD6',
    category_group_name: '음식점', category_name: '음식점 > 한식',
    address_name: '제주 테스트 주소', road_address_name: '제주 테스트 도로명',
    x: '126.5202', y: '33.5115', phone: '064-000-0000',
    place_url: 'http://place.map.kakao.com/12345', distance: '0' }],
};

async function fixture(t, { enabled = true, budgetError } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-kakao-api-'));
  await writeFile(join(root, 'index.html'), '<title>test</title>');
  let providerCalls = 0, budgetCalls = 0;
  const api = createApiHandler({
    env: { NODE_ENV: 'test', ...(enabled ? { KAKAO_REST_API_KEY: key } : {}) },
    publicOrigin: 'https://atlas.test', secret: 'kakao-test-signing'.repeat(3),
    catalog: {
      status: () => ({ status: 'ready' }), refreshIfNeeded: async () => {},
      detail: id => id === place.id ? structuredClone(place) : null,
    },
    kakaoOptions: {
      consumeBudget: async () => { budgetCalls++; if (budgetError) throw budgetError; },
      fetch: async (url, options) => {
        providerCalls++;
        assert.equal(new URL(url).origin, 'https://dapi.kakao.com');
        assert.equal(options.headers.Authorization, `KakaoAK ${key}`);
        return new Response(JSON.stringify(providerBody), { headers: { 'Content-Type': 'application/json' } });
      },
    },
  });
  const server = createAppServer({ root, api });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = await fetch(base + '/api/config');
  const cookie = config.headers.get('set-cookie')?.split(';')[0];
  const settings = await config.json();
  return {
    api, settings, providerCalls: () => providerCalls, budgetCalls: () => budgetCalls,
    get: (path, headers = {}) => fetch(base + path, { headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(settings.kakao?.csrf_token ? { 'X-Atlas-CSRF': settings.kakao.csrf_token } : {}), ...headers,
    } }),
    bare: path => fetch(base + path),
  };
}

test('Kakao config exposes only an enabled flag and session-bound proof', async t => {
  const f = await fixture(t);
  assert.equal(f.settings.kakao?.enabled, true);
  assert.ok(f.settings.kakao.csrf_token);
  assert.equal(JSON.stringify(f.settings).includes(key), false);
  assert.equal(f.providerCalls(), 0);
});

test('canonical detail lookup returns separate safe Kakao information without changing map data', async t => {
  const f = await fixture(t);
  const response = await f.get('/api/kakao/place?id=poi_0093');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.status, 'matched');
  assert.equal(result.canonical_id, place.id);
  assert.equal(result.place.url, 'https://place.map.kakao.com/12345');
  assert.equal(result.place.phone, '064-000-0000');
  assert.equal('lat' in result.place || 'lng' in result.place, false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(f.providerCalls(), 1);
  assert.equal(f.budgetCalls(), 1);
  assert.equal(place.phone, null);
});

test('missing proof, forged proof, unknown IDs and caller-supplied query/coordinates make no provider calls', async t => {
  const f = await fixture(t);
  assert.equal((await f.bare('/api/kakao/place?id=poi_0093')).status, 401);
  assert.equal((await f.get('/api/kakao/place?id=poi_0093', { 'X-Atlas-CSRF': 'forged' })).status, 403);
  assert.equal((await f.get('/api/kakao/place?id=missing')).status, 404);
  for (const path of ['/api/kakao/place', '/api/kakao/place?id=poi_0093&q=other', '/api/kakao/place?id=poi_0093&lat=33.5']) {
    assert.equal((await f.get(path)).status, 400, path);
  }
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.budgetCalls(), 0);
});

test('a disabled optional key and a draining server leave base readiness intact', async t => {
  const disabled = await fixture(t, { enabled: false });
  assert.equal(disabled.settings.kakao?.enabled, false);
  assert.equal(disabled.settings.kakao.csrf_token, undefined);
  assert.equal((await disabled.get('/api/kakao/place?id=poi_0093')).status, 503);
  assert.equal(await disabled.api.ready(), true);
  const active = await fixture(t);
  active.api.beginDrain();
  assert.equal((await active.get('/api/kakao/place?id=poi_0093')).status, 503);
  assert.equal(active.providerCalls(), 0);
});

test('repeated requests from one session stop before another provider call', async t => {
  const f = await fixture(t);
  for (let count = 0; count < 20; count++) assert.equal((await f.get('/api/kakao/place?id=poi_0093')).status, 200);
  const refused = await f.get('/api/kakao/place?id=poi_0093');
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error.code, 'kakao_busy');
  assert.equal(f.providerCalls(), 20);
  assert.equal(f.budgetCalls(), 20);
});
