import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/api.ts';
import { snapshot } from '../src/saved-data.ts';

let lookupPlaces;
try { ({ lookupPlaces } = await import('../src/place-search.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const center = { lng: 126.55, lat: 33.4 };
const when = '2026-09-12T01:02:03.000Z';
const native = {
  id: 'kakao:123', provider_id: '123', name: '시험 카페', name_en: null,
  category: '카페', provider_category: '음식점 > 카페', category_code: 'CE7',
  ...center, address: '제주 시험 도로 1', summary: '', tags: [],
  source: 'Kakao Local', source_label: 'Kakao Local', base_note: '제공처 등록 정보',
  updated_at: when, region: null, avg_stay_min: null,
  url: 'https://place.map.kakao.com/123', phone: '064-123-4567', hours: null, distance_m: null,
  queried_at: when, selection_token: 'do-not-save.session-proof',
};
const catalogPlace = {
  id: 'catalog:beach', name: '카탈로그 해변', name_en: 'Catalog beach', category: '해변',
  lat: 33.41, lng: 126.54, address: '저장된 주소', summary: '원자료 소개',
  source: 'sample', source_label: '큐레이션 원자료', base_note: '검증되지 않은 원자료',
  updated_at: '2026-09-10', sources: [{ source: 'sample', url: 'https://example.test/place', observed_at: '2026-09-10', license: null }],
  selection_token: 'never-a-saved-token',
};
function ready() { assert.equal(typeof lookupPlaces, 'function'); }
async function fixture(t, { enabled = true, fail, items = [catalogPlace] } = {}) {
  const calls = [];
  const config = { discovery: { enabled, csrf_token: 'fixture-csrf',
    categories: ['맛집', '카페', '숙소', '주차장'], page_size: 15, max_results: 45 } };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url, 'https://atlas.example.test');
    calls.push({ path, init });
    if (path.pathname === '/api/config') return Response.json(config);
    if (path.pathname === '/api/kakao/search') {
      if (fail) return Response.json({ error: { code: 'kakao_unavailable' } }, { status: 503 });
      const body = JSON.parse(init.body);
      return Response.json({ available: true, source: 'Kakao Local', ...body, items: [native],
        total: 1, pageable: 1, page_size: 15, has_more: false, truncated: false, queried_at: when });
    }
    assert.equal(path.pathname, '/api/catalog/search');
    return Response.json({ items, total: items.length, has_more: false });
  });
  await getConfig(true);
  calls.length = 0;
  return { calls };
}

test('auto lookup submits one current Kakao query and returns validated token-free coordinates', async t => {
  ready();
  const f = await fixture(t);
  const result = await lookupPlaces('  시험   카페  ', center, new AbortController().signal);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path.pathname, '/api/kakao/search');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { query: '시험 카페', category: '', scope: 'all', center, page: 1 });
  assert.equal(result[0].name, native.name);
  assert.equal(result[0].address, native.address);
  assert.equal(result[0].source, 'Kakao Local');
  assert.deepEqual([result[0].lng, result[0].lat], [126.55, 33.4]);
  assert.doesNotMatch(JSON.stringify(result), /selection_token|session-proof|csrf/);
  assert.doesNotMatch(JSON.stringify(snapshot(result[0])), /selection_token|session-proof/);
});

test('provider failure never falls back to catalog; catalog is an explicit subsequent choice', async t => {
  ready();
  const f = await fixture(t, { fail: true });
  await assert.rejects(lookupPlaces('시험', center, new AbortController().signal));
  assert.deepEqual(f.calls.map(call => call.path.pathname), ['/api/kakao/search']);
  const result = await lookupPlaces('시험', center, new AbortController().signal, 'catalog');
  assert.deepEqual(f.calls.map(call => call.path.pathname), ['/api/kakao/search', '/api/catalog/search']);
  assert.equal(result[0].source, 'sample');
  assert.equal(result[0].base_note, catalogPlace.base_note);
  assert.equal(result[0].address, catalogPlace.address);
  assert.doesNotMatch(JSON.stringify(result), /selection_token|never-a-saved-token/);
});

test('auto uses the labeled catalog when discovery is disabled and deduplicates catalog identities', async t => {
  ready();
  const f = await fixture(t, { enabled: false, items: [catalogPlace, catalogPlace] });
  const result = await lookupPlaces('해변', center, new AbortController().signal);
  assert.equal(result.length, 1);
  assert.equal(result[0].source_label, catalogPlace.source_label);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path.pathname, '/api/catalog/search');
  assert.equal(f.calls[0].path.searchParams.get('q'), '해변');
  assert.equal(f.calls[0].path.searchParams.get('limit'), '15');
});

test('bad input and cancellation make no search request', async t => {
  ready();
  const f = await fixture(t);
  for (const query of ['', ' ', 'x'.repeat(161), 'bad\0query']) {
    await assert.rejects(lookupPlaces(query, center, new AbortController().signal));
  }
  await assert.rejects(lookupPlaces('해변', { lng: 0, lat: 0 }, new AbortController().signal));
  await assert.rejects(lookupPlaces('해변', center, AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(lookupPlaces('해변', center, new AbortController().signal, 'unexpected'));
  assert.equal(f.calls.length, 0);
});

test('catalog lookup refuses missing or non-Jeju coordinates instead of inventing a point', async t => {
  ready();
  await fixture(t, { items: [{ ...catalogPlace, lng: 0 }] });
  await assert.rejects(lookupPlaces('해변', center, new AbortController().signal, 'catalog'),
    error => error.code === 'invalid_response');
});

test('an unavailable config does not silently select the old catalog', async t => {
  ready();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    calls++;
    assert.equal(url, '/api/config');
    return Response.json({}, { status: 503 });
  });
  await getConfig(true).catch(() => {});
  calls = 0;
  await assert.rejects(lookupPlaces('해변', center, new AbortController().signal));
  assert.equal(calls, 1);
});
