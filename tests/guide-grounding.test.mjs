import test from 'node:test';
import assert from 'node:assert/strict';

let grounding;
try { grounding = await import('../server/guide-grounding.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function fixture() {
  const rows = [
    { id: 'maze', name: '가족미로공원', category: '관광지', tags: ['아이동반', '가족'], lat: 33.4, lng: 126.5, source: 'sample', base_note: '기본 정보는 공식 대조 검증되지 않았습니다.', facilities: { parking: 'yes', restroom: 'unknown' }, hours_week: [{ day: 0, open: '09:00', close: '17:50' }], hours_source: 'tourapi_usetime', sources: [{ source: 'tourapi' }] },
    { id: 'museum', name: '컴퓨터박물관', category: '박물관', tags: ['아이동반', '실내'], lat: 33.45, lng: 126.55, source: 'sample', facilities: {}, hours_week: [], sources: [] },
    { id: 'park', name: '어린이공원', category: '관광지', tags: ['어린이'], lat: 33.43, lng: 126.52, source: 'OpenStreetMap', facilities: {}, hours_week: [], sources: [] },
    { id: 'cafe', name: '가족카페', category: '카페', tags: ['아이동반'], lat: 33.4, lng: 126.5, source: 'OpenStreetMap', facilities: {} },
    { id: 'adult', name: '성문화박물관', category: '박물관', tags: ['아이동반', '실내'], lat: 33.4, lng: 126.5, source: 'sample', facilities: {} },
  ];
  const calls = [];
  return {
    rows, calls,
    catalog: {
      search(options) {
        calls.push(options);
        return { items: rows.filter((row) => row.category === options.category
          && `${row.name} ${row.tags.join(' ')}`.includes(options.q)).slice(0, options.limit) };
      },
      detail: (id) => rows.find((row) => row.id === id),
    },
  };
}

test('broad family requests use real catalog tags and categories before the model', () => {
  assert.equal(typeof grounding?.prepareGuideGrounding, 'function');
  const f = fixture();
  const message = '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.';
  const result = grounding.prepareGuideGrounding(message, f.catalog);
  assert.deepEqual(result.candidates.map((place) => place.id), ['maze', 'museum', 'park']);
  assert.ok(result.prompt.startsWith(message));
  assert.match(result.prompt, /가족미로공원/);
  assert.match(result.prompt, /sample/);
  assert.ok(result.prompt.length <= 2000);
  assert.ok(f.calls.every((call) => !('radius_m' in call) && !('lat' in call)));
  assert.ok(f.calls.length <= 6);
});

test('regional, nearby, non-recommendation and adult-only requests keep their own scope', () => {
  assert.equal(typeof grounding?.prepareGuideGrounding, 'function');
  const f = fixture();
  for (const message of ['협재해변 근처 아이와 갈 장소 추천', '제주 동쪽 아이와 방문할 장소 추천',
    '현재 지도에서 아이와 갈 장소', '아이 없이 성인끼리 방문할 장소 추천', '아이와 함께 갔던 기억을 지워 주세요.',
    '아이와 함께 먹을 맛집 추천', '아이와 함께 묵을 숙소 추천', '아이와 산책할 장소 추천']) {
    const result = grounding.prepareGuideGrounding(message, f.catalog);
    assert.equal(result.prompt, message);
    assert.deepEqual(result.candidates, []);
  }
  // Nearby aliases may verify one exact anchor name, but must not trigger
  // island-wide family/indoor candidate searches.
  assert.deepEqual(f.calls.map((call) => call.q), ['협재해수욕장']);
});

test('indoor family requests exclude outdoor-only candidates and preserve a long question', () => {
  assert.equal(typeof grounding?.prepareGuideGrounding, 'function');
  const f = fixture();
  const result = grounding.prepareGuideGrounding('아이와 함께 비 오는 날 실내 장소를 추천해 주세요.', f.catalog);
  assert.deepEqual(result.candidates.map((place) => place.id), ['museum']);
  const long = `아이와 함께 방문할 장소를 추천해 주세요. ${'조건 '.repeat(630)}`.slice(0, 2000);
  const bounded = grounding.prepareGuideGrounding(long, f.catalog);
  assert.ok(bounded.prompt.startsWith(long));
  assert.ok(bounded.prompt.length <= 2000);
});

test('unavailable catalogs and missing canonical details never fabricate candidates', () => {
  assert.equal(typeof grounding?.prepareGuideGrounding, 'function');
  const message = '아이와 함께 방문할 장소를 추천해 주세요.';
  assert.deepEqual(grounding.prepareGuideGrounding(message, undefined).candidates, []);
  assert.deepEqual(grounding.prepareGuideGrounding(message, { search() { throw new Error('offline'); } }).candidates, []);
  const f = fixture();
  f.catalog.detail = () => null;
  assert.deepEqual(grounding.prepareGuideGrounding(message, f.catalog).candidates, []);
});

test('a successful answer mentioning retrieved places can map only those canonical places', () => {
  assert.equal(typeof grounding?.catalogReference, 'function');
  const f = fixture();
  const prepared = grounding.prepareGuideGrounding('아이와 함께 방문할 장소 추천', f.catalog);
  const result = grounding.catalogReference('가족미로공원을 추천합니다.', prepared);
  assert.deepEqual(result.markers.map((place) => place.id), ['maze']);
  assert.equal(result.appendix, '');
});

test('empty model recommendations receive explicitly labelled catalog references with honest facility flags', () => {
  assert.equal(typeof grounding?.catalogReference, 'function');
  const f = fixture();
  const prepared = grounding.prepareGuideGrounding('아이와 함께 방문할 장소 추천', f.catalog);
  const result = grounding.catalogReference('검색한 복합 키워드와 일치하는 결과가 없습니다.', prepared);
  assert.equal(result.markers.length, 3);
  assert.match(result.appendix, /카탈로그 참고 장소/);
  assert.match(result.appendix, /자료상 있음/);
  assert.match(result.appendix, /미확인/);
  assert.match(result.appendix, /공식 대조 검증/);
});
