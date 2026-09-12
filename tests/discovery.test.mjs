import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryAdapter, DiscoveryError } from '../server/discovery.mjs';

const at = Date.parse('2026-09-12T05:00:00.000Z');
const secret = 'discovery-selection-test-secret'.repeat(2);
const provider = (overrides = {}) => ({
  id: '12345', name: '검사국수', category: '음식점 > 한식 > 국수', group: 'FD6', groupName: '음식점',
  address: '제주 시험 주소', road_address: '제주 시험로 1', phone: '064-000-0000',
  url: 'https://place.map.kakao.com/12345', lat: 33.4, lng: 126.5, providerDistance: 2,
  ...overrides,
});
const request = { query: '', category: '맛집', scope: 'nearby', center: { lat: 33.4, lng: 126.5 }, radius_m: 2000, page: 1 };
const result = items => ({ items, total: 179, pageable: 45, page: 1, page_size: 15, end: false,
  truncated: true, queried_at: new Date(at).toISOString() });
const canonical = (overrides = {}) => ({
  id: 'poi_0092', name: '검사국수', name_en: null, category: '맛집', source: 'sample',
  lat: 33.4, lng: 126.50005, address: '검증되지 않은 기본 주소', summary: '샘플 소개',
  tags: ['sample'], phone: null, hours: null, source_label: '큐레이션 원자료', updated_at: null,
  photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null, menu: [],
  business_status: null, tips: null, sources: [], official_details: [], field_evidence: {},
  ...overrides,
});
const store = rows => ({
  search: () => ({ items: rows, total: rows.length, has_more: false }),
  detail: id => rows.find(row => row.id === id),
});

test('live result keeps native identity and truthful bounded pagination', () => {
  const adapter = createDiscoveryAdapter({ secret, clock: () => at });
  const raw = result([provider()]);
  const before = JSON.stringify(raw);
  const page = adapter.toSearch(raw, request, 'actor-one');
  assert.equal(page.source, 'Kakao Local');
  assert.equal(page.total, 179);
  assert.equal(page.pageable, 45);
  assert.equal(page.truncated, true);
  assert.equal(page.has_more, true);
  const place = page.items[0];
  assert.equal(place.id, 'kakao:12345');
  assert.equal(place.category, '맛집');
  assert.equal(place.provider_category, '음식점 > 한식 > 국수');
  assert.equal(place.address, '제주 시험로 1');
  assert.equal(place.url, 'https://place.map.kakao.com/12345');
  assert.equal(place.field_evidence.name.state, 'source_reported');
  assert.ok(place.selection_token.length > 100);
  assert.equal(JSON.stringify(raw), before);
});

test('a current signed selection opens without a provider lookup or catalog mutation', () => {
  const rows = [canonical()];
  const before = JSON.stringify(rows);
  const first = createDiscoveryAdapter({ secret, catalog: store(rows), clock: () => at });
  const second = createDiscoveryAdapter({ secret, catalog: store(rows), clock: () => at });
  const token = first.toSearch(result([provider()]), request, 'actor-one').items[0].selection_token;
  const detail = second.detail(token, 'actor-one');
  assert.equal(detail.id, 'kakao:12345');
  assert.equal(detail.name, '검사국수');
  assert.equal(detail.address, '제주 시험로 1');
  assert.equal(detail.source, 'Kakao Local');
  assert.equal(detail.kakao_lookup.status, 'matched');
  assert.equal(detail.kakao_lookup.canonical_id, 'kakao:12345');
  assert.equal(detail.kakao_lookup.place.id, '12345');
  assert.equal(JSON.stringify(rows), before);
});

test('selection proofs reject tampering, cross-actor replay, expiry and future timestamps', () => {
  let now = at;
  const adapter = createDiscoveryAdapter({ secret, clock: () => now });
  const token = adapter.toSearch(result([provider()]), request, 'actor-one').items[0].selection_token;
  const rejected = fn => assert.throws(fn, error => error instanceof DiscoveryError && error.status === 400);
  rejected(() => adapter.detail(token, 'actor-two'));
  rejected(() => adapter.detail(token.slice(0, -5) + 'xxxxx', 'actor-one'));
  rejected(() => adapter.detail(token + '=', 'actor-one'));
  rejected(() => adapter.detail('x'.repeat(20_000), 'actor-one'));
  now = at + 15 * 60_000;
  rejected(() => adapter.detail(token, 'actor-one'));
  now = at - 1;
  rejected(() => adapter.detail(token, 'actor-one'));
});

test('only a unique nearby compatible reference supplies source-backed public extras', () => {
  const photo = { url: 'https://example.org/photo.jpg', origin_url: 'https://example.org/original.jpg',
    thumb_url: null, credit: '공공 사진', license: 'KOGL-3', source: 'TourAPI' };
  const proof = { state: 'source_reported', source: 'TourAPI', observed_at: null, evidence_url: null };
  const row = canonical({
    photos: [photo], hours_week: [{ day: 1, open: '09:00', close: '17:00' }], hours_source: 'tourapi_usetime',
    facilities: { parking: 'yes', wheelchair: 'yes' }, overview: '출처가 없는 평면 소개',
    business_status: '영업/정상', menu: [{ name: '국수', price_krw: 9000, source: 'TourAPI' }],
    field_evidence: { 'photos.0': proof, hours_week: { ...proof, state: 'parsed' },
      'facilities.parking': proof, 'facilities.wheelchair': { state: 'unknown' },
      'menu.0.name': proof, 'menu.0.price_krw': proof, overview: { state: 'unknown' } },
    official_details: [{ provider: 'tourapi', provider_id: '321', locale: 'ko',
      source_url: 'https://example.org/official', fetched_at: new Date(at).toISOString(), title: '검사국수',
      address: '공식 주소', phone: null, website: null, latitude: 33.4, longitude: 126.5,
      overview: '공공 소개', facts: [], photos: [photo] }],
  });
  const before = JSON.stringify(row);
  const adapter = createDiscoveryAdapter({ secret, catalog: store([row]), clock: () => at });
  const detail = adapter.detailFor(provider(), new Date(at).toISOString());
  assert.equal(detail.linked_catalog.id, row.id);
  assert.deepEqual(detail.photos, [photo]);
  assert.equal(detail.photos[0].thumb_url, null);
  assert.deepEqual(detail.hours_week, row.hours_week);
  assert.deepEqual(detail.facilities, { parking: 'yes' });
  assert.equal(detail.overview, null);
  assert.equal(detail.business_status, null);
  assert.equal(detail.summary, '');
  assert.deepEqual(detail.tags, []);
  assert.equal(detail.official_details[0].overview, '공공 소개');
  assert.equal(detail.field_evidence.hours_week.state, 'parsed');
  assert.equal(JSON.stringify(row), before);
  detail.photos[0].credit = 'caller edit';
  assert.equal(JSON.stringify(row), before);
});

test('homonyms, incompatible kinds, distant and incomplete reference searches attach nothing', () => {
  const fixtures = [
    store([canonical(), canonical({ id: 'osm:node/2' })]),
    store([canonical({ category: '카페' })]),
    store([canonical({ lng: 126.51 })]),
    { ...store([canonical()]), search: () => ({ items: [canonical()], total: 101, has_more: true }) },
  ];
  for (const catalog of fixtures) {
    const adapter = createDiscoveryAdapter({ secret, catalog, clock: () => at });
    const detail = adapter.detailFor(provider(), new Date(at).toISOString());
    assert.equal(detail.linked_catalog, undefined);
    assert.deepEqual(detail.photos, []);
    assert.equal(detail.kakao_lookup.status, 'matched');
  }
});

test('main-store aliases have a 100m ceiling and never erase other branch names', () => {
  const make = row => createDiscoveryAdapter({ secret, catalog: store([row]), clock: () => at });
  assert.equal(make(canonical()).detailFor(provider({ name: '검사국수 본점' }), new Date(at).toISOString()).linked_catalog.id, 'poi_0092');
  assert.equal(make(canonical({ lng: 126.5015 })).detailFor(provider({ name: '검사국수 본점' }), new Date(at).toISOString()).linked_catalog, undefined);
  assert.equal(make(canonical({ name: '검사국수 협재점' })).detailFor(provider({ name: '검사국수 본점' }), new Date(at).toISOString()).linked_catalog, undefined);
});

test('ancillary and incompatible natural facilities never inherit a landmark reference', () => {
  const beach = canonical({ name: '협재해변', category: '해변' });
  const adapter = createDiscoveryAdapter({ secret, catalog: store([beach]), clock: () => at });
  for (const category of ['여행 > 관광,명소 > 관광지부속시설 > 공중화장실',
    '여행 > 관광,명소 > 주차장', '여행 > 관광,명소 > 산봉우리']) {
    const detail = adapter.detailFor(provider({ name: '협재해변', group: '', groupName: null, category }), new Date(at).toISOString());
    assert.equal(detail.linked_catalog, undefined, category);
  }
  const real = adapter.detailFor(provider({
    name: '협재해변', group: 'AT4', groupName: '관광명소', category: '여행 > 관광,명소 > 해수욕장,해변',
  }), new Date(at).toISOString());
  assert.equal(real.linked_catalog.id, beach.id);
  assert.equal(adapter.detailFor(provider({
    name: '협재해변', group: 'BK9', groupName: '은행', category: '여행 > 관광,명소 > 해수욕장,해변',
  }), new Date(at).toISOString()).linked_catalog, undefined);
});

test('catalog outages do not remove valid Kakao address, contact and link', () => {
  const adapter = createDiscoveryAdapter({ secret, catalog: { search() { throw Error('offline'); } }, clock: () => at });
  const detail = adapter.detailFor(provider(), new Date(at).toISOString());
  assert.equal(detail.phone, '064-000-0000');
  assert.equal(detail.url, 'https://place.map.kakao.com/12345');
  assert.deepEqual(detail.official_details, []);
});

test('large valid galleries keep native contacts and fit the client photo limit', () => {
  const proof = { state: 'source_reported', source: 'TourAPI', observed_at: null, evidence_url: null };
  const photos = Array.from({ length: 41 }, (_, index) => ({
    url: `https://example.org/${index}.jpg`, thumb_url: null, origin_url: `https://example.org/${index}.jpg`,
    credit: '공공 사진', license: 'KOGL-3', source: 'TourAPI',
  }));
  const row = canonical({ photos, field_evidence: Object.fromEntries(photos.map((_, index) => [`photos.${index}`, proof])) });
  const adapter = createDiscoveryAdapter({ secret, catalog: store([row]), clock: () => at });
  const detail = adapter.detailFor(provider(), new Date(at).toISOString());
  assert.equal(detail.photos.length, 40);
  assert.equal(detail.photos[39].origin_url, photos[39].origin_url);
  assert.equal(detail.field_evidence['photos.40'], undefined);
  assert.equal(detail.kakao_lookup.place.url, 'https://place.map.kakao.com/12345');
  assert.equal(row.photos.length, 41);
});

test('oversized public evidence cannot invalidate the native contact card', () => {
  const proof = { state: 'source_reported', source: 'TourAPI', observed_at: null, evidence_url: null };
  const menu = Array.from({ length: 100 }, (_, index) => ({ name: `메뉴 ${index}`, price_krw: 1000, source: 'TourAPI' }));
  const fields = Object.fromEntries(menu.flatMap((_, index) => [
    [`menu.${index}.name`, proof], [`menu.${index}.price_krw`, proof],
  ]));
  const adapter = createDiscoveryAdapter({ secret, catalog: store([canonical({ menu, field_evidence: fields })]), clock: () => at });
  const detail = adapter.detailFor(provider(), new Date(at).toISOString());
  assert.ok(Object.keys(detail.field_evidence).length <= 128);
  assert.equal(detail.kakao_lookup.status, 'matched');
});

test('public records with no usable title do not hide native identity', () => {
  const adapter = createDiscoveryAdapter({ secret, catalog: store([canonical({
    official_details: [{ provider: 'tourapi', title: null, facts: [], photos: [] }],
    field_evidence: { 'official_details.0': { state: 'source_reported', source: 'TourAPI' } },
  })]), clock: () => at });
  const detail = adapter.detailFor(provider(), new Date(at).toISOString());
  assert.deepEqual(detail.official_details, []);
  assert.equal(detail.field_evidence['official_details.0'], undefined);
  assert.equal(detail.kakao_lookup.place.name, '검사국수');
});

test('the final detail byte limit includes its echoed selection proof', () => {
  const proof = { state: 'source_reported', source: 'TourAPI', observed_at: null, evidence_url: null };
  const photos = Array.from({ length: 40 }, (_, i) => ({
    url: `https://example.org/${'a'.repeat(1100)}${i}`, origin_url: `https://example.org/${'b'.repeat(1100)}${i}`,
    thumb_url: null, credit: 'c'.repeat(1000), license: 'KOGL-3', source: 'TourAPI',
  }));
  const row = canonical({ photos,
    sources: Array.from({ length: 99 }, () => ({ source: 'TourAPI', url: null, observed_at: null, license: null, note: '' })),
    field_evidence: Object.fromEntries(photos.map((_, i) => [`photos.${i}`, proof])),
  });
  const adapter = createDiscoveryAdapter({ secret, catalog: store([row]), clock: () => at });
  let low = 0, high = 4000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    row.sources.forEach(source => { source.note = 'x'.repeat(middle); });
    if (adapter.detailFor(provider(), new Date(at).toISOString()).linked_catalog) low = middle;
    else high = middle - 1;
  }
  row.sources.forEach(source => { source.note = 'x'.repeat(low); });
  const token = adapter.toSearch(result([provider()]), request, 'actor-one').items[0].selection_token;
  const detail = adapter.detail(token, 'actor-one');
  assert.equal(detail.selection_token, token);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 512 * 1024);
});

test('provider fields cannot forge external links or inject selection metadata', () => {
  const adapter = createDiscoveryAdapter({ secret, clock: () => at });
  for (const item of [provider({ id: '../bad' }), provider({ url: 'https://evil.example/12345' }),
    provider({ lat: 37.5 }), provider({ name: '' }), provider({ phone: 'x' + String.fromCharCode(0) + 'y' })]) {
    assert.throws(() => adapter.toSearch(result([item]), request, 'actor-one'));
  }
  const page = adapter.toSearch(result([provider({ selection_token: 'injected', source: 'official' })]), request, 'actor-one');
  assert.equal(page.items[0].source, 'Kakao Local');
  assert.notEqual(page.items[0].selection_token, 'injected');
});
