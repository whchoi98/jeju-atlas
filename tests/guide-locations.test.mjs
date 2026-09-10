import test from 'node:test';
import assert from 'node:assert/strict';

let normalizeGuideLocation;
try { ({ normalizeGuideLocation } = await import('../server/guide-locations.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function catalogFixture() {
  const calls = [];
  const places = [
    { id: 'national-park', name: '한라산국립공원', category: '관광지' },
    { id: 'similarly-named-cafe', name: '한라산도', category: '카페' },
    { id: 'beach', name: '협재해수욕장', category: '해변' },
    { id: 'hamdeok', name: '함덕해수욕장', category: '해변' },
  ];
  return {
    calls,
    search(query) {
      calls.push(query);
      return { items: places.filter((place) => place.category === query.category && place.name.includes(query.q)) };
    },
  };
}

test('Hallasan nearby questions use the verified national park name, keeping other conditions intact', () => {
  assert.equal(typeof normalizeGuideLocation, 'function');
  const catalog = catalogFixture();
  assert.equal(normalizeGuideLocation('한라산 근처 맛집?', catalog), '한라산국립공원 근처 맛집?');
  assert.equal(normalizeGuideLocation('아이와 함께 한라산 주변에서 해산물 없는 식당을 알려 주세요.', catalog),
    '아이와 함께 한라산국립공원 주변에서 해산물 없는 식당을 알려 주세요.');
  assert.ok(catalog.calls.every((query) => query.q === '한라산국립공원' && query.category === '관광지'));
});

test('a distinct cafe name and non-nearby Hallasan questions are not rewritten', () => {
  assert.equal(typeof normalizeGuideLocation, 'function');
  const catalog = catalogFixture();
  for (const message of ['한라산도 근처 맛집?', '한라산 등반 예약 방법', '성산일출봉 근처 카페', '제주한라산도 주변 음식점']) {
    assert.equal(normalizeGuideLocation(message, catalog), message);
  }
  assert.equal(catalog.calls.length, 0);
});

test('known beach aliases use canonical names only when the catalog confirms them', () => {
  assert.equal(typeof normalizeGuideLocation, 'function');
  const catalog = catalogFixture();
  assert.equal(normalizeGuideLocation('협재해변 인근 카페?', catalog), '협재해수욕장 인근 카페?');
  assert.equal(normalizeGuideLocation('함덕해변 주변 맛집?', catalog), '함덕해수욕장 주변 맛집?');
  const unavailable = { search() { throw new Error('Catalog unavailable'); } };
  assert.equal(normalizeGuideLocation('한라산 근처 맛집?', unavailable), '한라산 근처 맛집?');
  assert.equal(normalizeGuideLocation('한라산 근처 맛집?', undefined), '한라산 근처 맛집?');
  assert.equal(normalizeGuideLocation('한라산 근처 맛집?', { search: () => ({ items: [
    { name: '한라산국립공원식당', category: '관광지' },
  ] }) }), '한라산 근처 맛집?');
});

test('repeated aliases use one lookup and never exceed the runtime prompt limit', () => {
  assert.equal(typeof normalizeGuideLocation, 'function');
  const catalog = catalogFixture();
  assert.equal(normalizeGuideLocation('한라산 근처 맛집, 한라산 주변 카페', catalog),
    '한라산국립공원 근처 맛집, 한라산국립공원 주변 카페');
  assert.equal(catalog.calls.length, 1);
  const long = `한라산 근처 ${'가'.repeat(2000)}`.slice(0, 2000);
  assert.equal(normalizeGuideLocation(long, catalog), long, 'Do not truncate the original question to fit an alias');
});
