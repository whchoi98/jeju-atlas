import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/saved-data.ts';

let subject;
try { subject = await import('../src/search-suggestions.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const place = (id, name, extra = {}) => snapshot({
  id, name, category: '카페', lat: 33.4, lng: 126.5, source: 'Kakao Local', updated_at: '2026-09-12T00:00:00Z',
  address: '제주시 협재', summary: '', source_label: 'Kakao Local', base_note: null, ...extra,
});
function build(query, queries, favorites, results) {
  assert.equal(typeof subject?.buildSuggestions, 'function');
  return subject.buildSuggestions(query, queries, favorites, results);
}

test('suggestions combine saved queries and places within eight options without duplicating place IDs', () => {
  const favorites = Array.from({ length: 8 }, (_, i) => place(`kakao:${i + 1}`, `협재 카페 ${i + 1}`));
  const results = [place('kakao:1', '협재 카페 최신 이름', { updated_at: '2026-09-12T12:00:00Z' })];
  const options = build('협재', ['협재', '협재 카페', '협재 해변', '협재 주차'], favorites, results);
  assert.equal(options.length, 8);
  assert.equal(options.filter(option => option.kind === 'query').length, 3);
  const matches = options.filter(option => option.kind === 'place');
  assert.equal(new Set(matches.map(option => option.place.id)).size, matches.length);
  assert.equal(matches[0].place.name, '협재 카페 최신 이름');
  assert.equal(matches[0].place.updated_at, '2026-09-12T12:00:00Z');
  assert.equal(matches[0].origin, 'result');
  assert.equal(favorites[0].name, '협재 카페 1');
});

test('local filtering supports Korean spacing, English names, addresses and category constraints', () => {
  assert.equal(typeof subject?.filterPlaces, 'function');
  const places = [
    place('kakao:1', '호텔샌드', { name_en: 'Hotel Sand', address: '제주시 한림읍' }),
    place('poi_1', '협재해수욕장', { category: '해변', address: '제주시 한림읍' }),
  ];
  assert.deepEqual(build('hotel sand', [], places, []).map(option => option.place.id), ['kakao:1']);
  assert.deepEqual(build('호텔 샌드', [], places, []).map(option => option.place.id), ['kakao:1']);
  assert.deepEqual(subject.filterPlaces(places, '한림', '해변').map(item => item.id), ['poi_1']);
  assert.deepEqual(subject.filterPlaces(places, '없는 이름', ''), []);
});

test('empty input offers available local history/favorites and never invents a query or place', () => {
  assert.deepEqual(build('', [], [], []), []);
  const options = build('', ['제주 카페'], [place('kakao:1', '호텔샌드')], [place('poi_random', '첫 카탈로그 페이지')]);
  assert.deepEqual(options.map(option => option.kind), ['query', 'place']);
  assert.equal(options[0].query, '제주 카페');
  assert.equal(options[1].place.id, 'kakao:1');
  assert.deepEqual(build('호텔샌', [], [], []), []);
});
