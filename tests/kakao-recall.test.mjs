import test from 'node:test';
import assert from 'node:assert/strict';
import { createKakaoService } from '../server/kakao.mjs';

const origin = { id: 'poi_0092', name: '올래국수', category: '맛집', source: 'sample',
  lat: 33.45, lng: 126.55 };
const raw = (overrides = {}) => ({
  id: '12345', place_name: '올래국수', category_group_code: 'FD6',
  category_group_name: '음식점', category_name: '음식점 > 한식 > 국수',
  x: '126.55', y: '33.4501', address_name: '시험 주소', road_address_name: '',
  phone: '', place_url: 'https://place.map.kakao.com/12345', distance: '11', ...overrides,
});
const response = documents => Response.json({
  meta: { total_count: documents.length, pageable_count: documents.length, is_end: true }, documents,
});
function fixture(t, rows) {
  const calls = [];
  const service = createKakaoService({
    key: 'fixture-key'.repeat(3), consumeBudget: async () => {},
    fetch: async url => {
      const query = new URL(url).searchParams;
      calls.push(Object.fromEntries(query));
      return response(typeof rows === 'function' ? rows(query) : rows);
    },
  });
  t.after(() => service.close());
  return { service, calls };
}

test('a nearby mountain with an empty group code can match its detailed category', async t => {
  const { service, calls } = fixture(t, [
    raw({ place_name: '성산일출봉', category_group_code: '', category_group_name: '',
      category_name: '여행 > 관광,명소 > 산봉우리', y: '33.4515' }),
  ]);
  const result = await service.lookup({ ...origin, name: '성산일출봉', category: '관광지' });
  assert.equal(result.status, 'matched');
  assert.equal(result.place.name, '성산일출봉');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].radius, '200');
  assert.equal(calls[0].category_group_code, undefined);
});

test('an added main-store label needs both close coordinates and the complete base name', async t => {
  const { service } = fixture(t, [raw({ place_name: '올래국수 본점' })]);
  assert.equal((await service.lookup(origin)).status, 'matched');
  assert.equal((await service.lookup({ ...origin, name: '제주올래국수' })).status, 'not_found');
  assert.equal((await service.lookup({ ...origin, name: '올래국수 서귀포점' })).status, 'not_found');
  const far = fixture(t, [raw({ place_name: '올래국수 본점', y: '33.4514' })]);
  const rejected = await far.service.lookup(origin);
  assert.equal(rejected.status, 'not_found');
  assert.equal(rejected.reason, 'distance_mismatch');
});

test('distinct nearby homonyms remain ambiguous, including an exact name and a main-store label', async t => {
  const { service, calls } = fixture(t, [raw(),
    raw({ id: '54321', place_url: 'https://place.map.kakao.com/54321', place_name: '올래국수 본점' })]);
  const result = await service.lookup(origin);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.reason, 'multiple_candidates');
  assert.equal(calls.length, 1);
});

test('a strong complete nearby match does not need the wider unverified seed search', async t => {
  const { service, calls } = fixture(t, query => query.get('radius') === '200' ? [raw()] : [
    raw(), raw({ id: '54321', place_url: 'https://place.map.kakao.com/54321', y: '33.461' }),
  ]);
  assert.equal((await service.lookup(origin)).status, 'matched');
  assert.deepEqual(calls.map(q => q.radius), ['200']);
});

test('the wider seed search is a fallback and OSM coordinates remain limited to 200 metres', async t => {
  const { service, calls } = fixture(t, query => query.get('radius') === '200' ? [] : [raw({ y: '33.457' })]);
  assert.equal((await service.lookup(origin)).status, 'matched');
  assert.deepEqual(calls.map(q => q.radius), ['200', '2000']);
  calls.length = 0;
  const result = await service.lookup({ ...origin, source: 'OpenStreetMap' });
  assert.equal(result.status, 'not_found');
  assert.equal(result.reason, 'no_results');
  assert.deepEqual(calls.map(q => q.radius), ['200']);
});

test('an empty group does not turn a bank branch or an ancillary facility into a landmark', async t => {
  for (const category_name of ['금융,보험 > 금융서비스 > 은행', '여행 > 관광지부속시설 > 샤워장',
    '문화,예술 > 문화시설 > 주차장']) {
    const { service } = fixture(t, [raw({ place_name: '성산일출봉', category_group_code: '',
      category_group_name: '', category_name })]);
    const result = await service.lookup({ ...origin, name: '성산일출봉', category: '관광지' });
    assert.equal(result.status, 'not_found');
    assert.equal(result.reason, 'category_mismatch');
  }
});

test('nearby valid detailed categories cover beaches, museums, parking and cafés', async t => {
  for (const [category, category_name] of [
    ['해변', '여행 > 관광,명소 > 해수욕장,해변'],
    ['박물관', '문화,예술 > 문화시설 > 박물관'],
    ['주차장', '교통,수송 > 교통시설 > 주차장'],
    ['카페', '음식점 > 카페 > 커피전문점'],
  ]) {
    const { service } = fixture(t, [raw({ category_group_code: '', category_group_name: '', category_name })]);
    assert.equal((await service.lookup({ ...origin, category })).status, 'matched', category);
  }
});

test('the public no-match reason distinguishes different names from no provider results', async t => {
  const named = fixture(t, [raw({ place_name: '다른 식당' })]);
  assert.equal((await named.service.lookup(origin)).reason, 'name_mismatch');
  const empty = fixture(t, []);
  assert.equal((await empty.service.lookup(origin)).reason, 'no_results');
});
