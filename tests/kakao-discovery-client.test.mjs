import test from 'node:test';
import assert from 'node:assert/strict';
import { KakaoDetails } from '../src/kakao-details.ts';
import { setLocale } from '../src/i18n.ts';
import { snapshot } from '../src/saved-data.ts';

let client;
try { client = await import('../src/kakao-discovery.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const config = { discovery: { enabled: true, csrf_token: 'first-proof',
  categories: ['맛집', '카페', '숙소', '주차장'], page_size: 15, max_results: 45 } };
const input = { query: '', category: '카페', scope: 'all', center: { lng: 126.55, lat: 33.4 }, page: 1 };
const item = (number = 123) => ({
  id: `kakao:${number}`, provider_id: String(number), name: `시험 카페 ${number}`, name_en: null,
  category: '카페', provider_category: '음식점 > 카페 > 커피전문점', category_code: 'CE7',
  lat: 33.4, lng: 126.55, address: '제주 시험 도로 1', summary: '', tags: [],
  source: 'Kakao Local', source_label: 'Kakao Local', base_note: '제공처 등록 정보',
  updated_at: '2026-09-12T01:02:03.000Z', region: null, avg_stay_min: null,
  url: `https://place.map.kakao.com/${number}`, phone: '064-123-4567', hours: null, distance_m: null,
  queried_at: '2026-09-12T01:02:03.000Z', selection_token: `fixture-${number}.session-proof`,
});
const result = (overrides = {}) => ({
  available: true, source: 'Kakao Local', query: '', category: '카페', scope: 'all',
  items: [item()], total: 62, pageable: 45, page: 1, page_size: 15, has_more: true,
  truncated: true, queried_at: '2026-09-12T01:02:03.000Z', ...overrides,
});
const detail = () => {
  const place = item();
  delete place.selection_token;
  return {
    ...place, photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null, menu: [],
    business_status: null, tips: null, sources: [], enriched_at: null, official_details: [],
    selection_token: 'fixture-detail-native.proof',
    kakao_lookup: { available: true, status: 'matched', canonical_id: place.id, source: 'Kakao Local',
      queried_at: place.queried_at, place: { id: place.provider_id, name: place.name,
        category: place.provider_category, address: place.address, road_address: null, phone: place.phone, url: place.url } },
    linked_catalog: { id: 'poi_0900', name: '이전 공공정보 이름', source: 'sample', distance_m: 45 },
  };
};
const ready = () => assert.equal(typeof client?.searchKakao, 'function', 'the discovery client must be implemented');
const tick = () => new Promise(resolve => setImmediate(resolve));
function transport(responses = [result()], configs = [config]) {
  const calls = [], configCalls = [];
  return {
    calls, configCalls,
    options: {
      loadConfig: async refresh => { configCalls.push(refresh); return configs[Math.min(configCalls.length - 1, configs.length - 1)]; },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const value = responses.shift();
        if (value instanceof Error) throw value;
        return value instanceof Response ? value : Response.json(value);
      },
    },
  };
}

test('source routing preserves nature and legacy choices while preferring native commercial discovery', () => {
  ready();
  for (const [source, query, category, enabled, expected] of [
    ['auto', '', '', true, 'catalog'], ['auto', '', '해변', true, 'catalog'],
    ['auto', '해변', '오름', true, 'catalog'], ['auto', '협재', '', true, 'kakao'],
    ['auto', '', '맛집', true, 'kakao'], ['auto', '', '카페', true, 'kakao'],
    ['auto', '', '숙소', true, 'kakao'], ['auto', '', '주차장', true, 'kakao'],
    ['catalog', '커피', '카페', true, 'catalog'], ['kakao', '박물관', '', true, 'kakao'],
    ['auto', '커피', '카페', false, 'catalog'], ['kakao', '커피', '', false, 'catalog'],
  ]) assert.equal(client.discoverySource(source, query, category, enabled), expected);
});

test('missing or disabled config cannot trigger discovery; malformed advertised limits are rejected', async () => {
  ready();
  for (const value of [{}, { discovery: { enabled: false } }]) {
    assert.equal(client.discoveryConfig(value), null);
    const f = transport([], [value]);
    await assert.rejects(client.searchKakao(input, f.options));
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => client.discoveryConfig({ discovery: { ...config.discovery, page_size: 40 } }));
  assert.throws(() => client.discoveryConfig({ discovery: { ...config.discovery, max_results: 100 } }));
  assert.throws(() => client.discoveryConfig({ discovery: { ...config.discovery, categories: ['해변'] } }));
});

test('search sends a bounded same-origin POST, preserves provider metadata, and strips unrecognized fields', async () => {
  ready();
  const data = result();
  data.items[0].untrusted_extra = '<script>bad</script>';
  const f = transport([data]);
  const found = await client.searchKakao({ ...input, secret: 'must-not-be-sent' }, f.options);
  assert.equal(f.calls[0].url, '/api/kakao/search');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.credentials, 'same-origin');
  assert.equal(f.calls[0].init.cache, 'no-store');
  assert.equal(f.calls[0].init.headers['X-Atlas-CSRF'], 'first-proof');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), input);
  assert.equal(found.items[0].provider_category, '음식점 > 카페 > 커피전문점');
  assert.equal(found.items[0].selection_token, 'fixture-123.session-proof');
  assert.equal(found.items[0].untrusted_extra, undefined);
  assert.equal(found.total, 62);
  assert.equal(found.page_size, 15);
  assert.equal(found.truncated, true);
});

test('request validation rejects unsupported categories, outside-Jeju areas and pages beyond 45 results', async () => {
  ready();
  for (const change of [
    { category: '해변' }, { category: '', query: '' }, { query: 'a'.repeat(161) }, { page: 0 }, { page: 4 },
    { center: { lat: 37.5, lng: 127 } }, { scope: 'view' },
    { scope: 'view', bounds: [126.5, 33.5, 126.4, 33.4] },
    { scope: 'nearby', radius_m: 999999 }, { query: 'bad\u0000query' },
  ]) {
    const f = transport();
    await assert.rejects(client.searchKakao({ ...input, ...change }, f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('one auth renewal keeps the original input and uses only the refreshed session proof', async () => {
  ready();
  for (const status of [401, 403]) {
    const f = transport([new Response('', { status }), result()], [
      config, { discovery: { ...config.discovery, csrf_token: 'new-proof' } },
    ]);
    const request = structuredClone(input);
    const pending = client.searchKakao(request, f.options);
    request.category = '숙소';
    await pending;
    assert.deepEqual(f.configCalls, [false, true]);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].init.headers['X-Atlas-CSRF'], 'new-proof');
    assert.equal(f.calls[0].init.body, f.calls[1].init.body);
    assert.equal(JSON.parse(f.calls[1].init.body).category, '카페');
  }
  const f = transport([new Response('', { status: 403 }), new Response('', { status: 403 })]);
  await assert.rejects(client.searchKakao(input, f.options));
  assert.equal(f.calls.length, 2);
  assert.equal(f.configCalls.length, 2);
});

test('empty native results are successful while outages and quota failures remain errors', async () => {
  ready();
  const empty = result({ items: [], total: 0, pageable: 0, has_more: false, truncated: false });
  assert.equal((await client.searchKakao(input, transport([empty]).options)).items.length, 0);
  for (const status of [429, 502, 503]) {
    const f = transport([new Response(JSON.stringify({ error: { code: 'kakao_unavailable' } }), { status })]);
    await assert.rejects(client.searchKakao(input, f.options), error => error.status === status);
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(client.searchKakao(input, transport([new TypeError('offline')]).options));
});

test('abort during config or provider reading prevents a stale result or another request', async () => {
  ready();
  let release;
  const controller = new AbortController();
  const f = transport();
  f.options.loadConfig = () => new Promise(resolve => { release = resolve; });
  const pending = client.searchKakao(input, { ...f.options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  release(config);
  await tick();
  assert.equal(f.calls.length, 0);

  const next = new AbortController();
  const waiting = client.searchKakao(input, { ...transport().options, signal: next.signal,
    fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  await tick();
  next.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  release(Response.json(result()));
});

test('malformed native response identity, counts, tokens, fields and links cannot become cards', async t => {
  ready();
  const changes = [
    value => { value.source = 'catalog'; }, value => { value.category = '숙소'; },
    value => { value.page = 2; }, value => { value.page_size = 40; },
    value => { value.total = -1; }, value => { value.pageable = 1000; },
    value => { value.truncated = 'false'; }, value => { value.items.push(value.items[0]); },
    value => { value.items = Array.from({ length: 16 }, (_, i) => item(i + 100)); },
    value => { value.items[0].id = 'poi_0900'; }, value => { value.items[0].provider_id = '456'; },
    value => { value.items[0].source = 'sample'; }, value => { value.items[0].lat = 37.5; },
    value => { value.items[0].selection_token = ''; }, value => { value.items[0].selection_token = 'x'.repeat(16001); },
    value => { value.items[0].provider_category = {}; }, value => { value.items[0].name = '<b>'.repeat(501); },
    value => { value.items[0].url = 'https://place.map.kakao.com.evil.test/123'; },
    value => { value.items[0].url = 'https://place.map.kakao.com/456'; },
    value => { value.items[0].queried_at = '2026-02-30T00:00:00Z'; },
  ];
  for (const [index, change] of changes.entries()) {
    await t.test(String(index + 1), async () => {
      const value = result();
      change(value);
      await assert.rejects(client.searchKakao(input, transport([value]).options));
    });
  }
});

test('bounded JSON handling rejects oversized and invalid bodies before publishing data', async () => {
  ready();
  for (const body of ['<html>error</html>', ' '.repeat(524_289) + JSON.stringify(result())]) {
    await assert.rejects(client.searchKakao(input, transport([new Response(body)]).options));
  }
});

test('the real adapter’s long signed selection and source evidence pass the client boundary', async () => {
  ready();
  const { createDiscoveryAdapter } = await import('../server/discovery.mjs');
  const when = '2026-09-12T01:02:03.000Z';
  const adapter = createDiscoveryAdapter({ secret: 'fixture-discovery-client-secret-1234567890', clock: () => Date.parse(when) });
  const provider = {
    id: '123', name: '가'.repeat(500), category: '분'.repeat(500), group: 'CE7', groupName: '카페',
    address: '주'.repeat(1000), road_address: '도'.repeat(1000), phone: '0'.repeat(100),
    url: 'https://place.map.kakao.com/123', lat: 33.4, lng: 126.55,
  };
  const search = adapter.toSearch({ items: [provider], total: 1, pageable: 1, page: 1, page_size: 15,
    end: true, truncated: false, queried_at: when }, input, 'fixture-actor');
  assert.ok(search.items[0].selection_token.length > 12000);
  const f = transport([search, adapter.detail(search.items[0].selection_token, 'fixture-actor')]);
  const response = await client.searchKakao(input, f.options);
  assert.equal(response.items[0].source_label, '카카오 조회 정보');
  assert.equal(response.items[0].field_evidence.name.state, 'source_reported');
  const selected = await client.detailKakao('kakao:123', response.items[0].selection_token, f.options);
  assert.equal(selected.name, provider.name);
  assert.ok(new TextEncoder().encode(f.calls[1].init.body).length <= 16_384);
});

test('normalized public detail limits and fractional source timestamps survive native enrichment', async () => {
  ready();
  const { normalizeOfficialDetails } = await import('../server/official-details.mjs');
  const { createDiscoveryAdapter } = await import('../server/discovery.mjs');
  const when = '2026-09-12T01:02:03.000Z';
  const fetched = '2026-09-10T01:02:03.123456789+00:00';
  const photos = Array.from({ length: 8 }, (_, i) => ({
    url: `https://example.org/photo-${i}.jpg`, origin_url: `https://example.org/original-${i}.jpg`,
    thumb_url: null, credit: '제'.repeat(300), license: 'KOGL-1', source: 'TourAPI',
  }));
  const official = normalizeOfficialDetails([{
    provider: 'tourapi', provider_id: '12345', locale: 'ko', source_url: 'https://korean.visitkorea.or.kr/',
    fetched_at: fetched, title: '시험 카페 123', address: '주'.repeat(1000), phone: null, website: null,
    latitude: 33.4, longitude: 126.55, overview: '개'.repeat(8000),
    facts: Array.from({ length: 40 }, (_, i) => ({
      key: `fact_${i}`, label_ko: '라'.repeat(120), label_en: 'L'.repeat(120), value: '값'.repeat(1000),
    })),
    photos, match: { method: 'name_category_distance', distance_m: 12 },
  }], { now: Date.parse(when) });
  const original = {
    ...detail(), id: 'poi_public', source: 'tourapi', official_details: official,
    field_evidence: { 'official_details.0': { state: 'source_reported', source: 'TourAPI', observed_at: fetched,
      evidence_url: 'https://korean.visitkorea.or.kr/' } },
  };
  const adapter = createDiscoveryAdapter({
    secret: 'fixture-public-limit-compatibility-1234567890', clock: () => Date.parse(when),
    catalog: { search: () => ({ items: [original], total: 1, has_more: false }), detail: () => original },
  });
  const value = adapter.detailFor({
    id: '123', name: item().name, category: '음식점 > 카페 > 커피전문점', group: 'CE7', groupName: '카페',
    address: item().address, road_address: null, phone: item().phone, url: item().url, lat: 33.4, lng: 126.55,
  }, when, 'fixture-actor');
  const found = await client.detailKakao('kakao:123', value.selection_token, transport([value]).options);
  assert.equal(found.linked_catalog.id, 'poi_public');
  assert.equal(found.official_details[0].fetched_at, fetched);
  assert.equal(found.field_evidence['official_details.0'].observed_at, fetched);
  assert.equal(found.official_details[0].facts.length, 40);
  assert.equal(found.official_details[0].facts[0].value.length, 1000);
  assert.equal(found.official_details[0].photos.length, 8);
});

test('detail and exact-ID reopen preserve native identity and expose public enrichment separately', async () => {
  ready();
  const f = transport([detail(), detail()]);
  const found = await client.detailKakao('kakao:123', 'fixture-123.session-proof', f.options);
  assert.equal(found.id, 'kakao:123');
  assert.equal(found.name, '시험 카페 123');
  assert.equal(found.selection_token, 'fixture-detail-native.proof');
  assert.equal(client.nativeCatalogPlace(found).selection_token, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot(found)), /selection_token|fixture-detail-native/);
  assert.equal(found.linked_catalog.id, 'poi_0900');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { token: 'fixture-123.session-proof' });
  assert.equal(f.calls[0].url, '/api/kakao/detail');
  const hint = { id: 'kakao:123', name: '예전 저장 이름', category: '카페', lat: 33.4, lng: 126.55 };
  await client.reopenKakao({ ...hint, selection_token: 'must-not-reopen-with-a-token' }, f.options);
  assert.equal(f.calls[1].url, '/api/kakao/reopen');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), hint);
  assert.equal(hint.name, '예전 저장 이름');
  const wrong = detail();
  wrong.id = 'kakao:456';
  await assert.rejects(client.detailKakao('kakao:123', 'fixture-proof', transport([wrong]).options));
  const wrongLookup = detail();
  wrongLookup.kakao_lookup.place.id = '456';
  wrongLookup.kakao_lookup.place.url = 'https://place.map.kakao.com/456';
  await assert.rejects(client.detailKakao('kakao:123', 'fixture-proof', transport([wrongLookup]).options));
  const invalidProof = detail();
  invalidProof.selection_token = 'x'.repeat(16001);
  await assert.rejects(client.detailKakao('kakao:123', 'fixture-proof', transport([invalidProof]).options));
});

test('invalid optional enrichment preserves native contacts and drops all public sections and proof', async () => {
  ready();
  const proof = { state: 'source_reported', source: 'VisitJeju', observed_at: null, evidence_url: 'https://www.visitjeju.net/' };
  for (const breakPublic of [
    data => { data.overview = '가'.repeat(40_001); },
    data => { data.facilities = { parking: { unexpected: true } }; },
    data => { data.photos = Array.from({ length: 41 }, () => ({})); },
    data => { data.field_evidence = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`photos.${i}`, proof])); },
    data => { data.field_evidence = ['not a field map']; },
    data => { data.sources = [{ source: 'VisitJeju', url: 'javascript:alert(1)', observed_at: null, license: null }]; },
    data => { data.linked_catalog = { id: 'poi_public', distance_m: 'unknown' }; },
  ]) {
    const value = { ...detail(), overview: '공공 소개', facilities: { parking: 'yes' },
      field_evidence: { overview: proof }, sources: [{ ...proof, license: null, url: proof.evidence_url }] };
    breakPublic(value);
    const found = await client.detailKakao('kakao:123', 'fixture-proof', transport([value]).options);
    assert.equal(found.id, 'kakao:123');
    assert.equal(found.address, '제주 시험 도로 1');
    assert.equal(found.phone, '064-123-4567');
    assert.equal(found.url, 'https://place.map.kakao.com/123');
    assert.equal(found.kakao_lookup.place.id, '123');
    assert.equal(found.selection_token, 'fixture-detail-native.proof');
    assert.equal(found.overview, null);
    assert.deepEqual(found.photos, []);
    assert.deepEqual(found.hours_week, []);
    assert.deepEqual(found.facilities, {});
    assert.deepEqual(found.menu, []);
    assert.deepEqual(found.official_details, []);
    assert.equal(found.linked_catalog, undefined);
    assert.equal(found.field_evidence, undefined);
    assert.ok(found.sources.every(source => source.source === 'Kakao Local'));
  }
  const search = result();
  search.items[0].field_evidence = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`photos.${i}`, proof]));
  const found = await client.searchKakao(input, transport([search]).options);
  assert.equal(found.items[0].url, 'https://place.map.kakao.com/123');
  assert.equal(found.items[0].field_evidence, undefined);
});

test('invalid public extras never mask tampered native identity, URL, lookup or selection proof', async () => {
  ready();
  for (const tamper of [
    data => { data.id = 'kakao:456'; },
    data => { data.source = 'VisitJeju'; },
    data => { data.url = 'https://place.map.kakao.com/456'; },
    data => { data.kakao_lookup.canonical_id = 'kakao:456'; },
    data => { data.kakao_lookup.place.url = 'https://evil.example/123'; },
    data => { data.selection_token = 'bad\nproof'; },
  ]) {
    const value = { ...detail(), overview: 'a'.repeat(40_001), field_evidence: { invalid: null } };
    tamper(value);
    await assert.rejects(client.detailKakao('kakao:123', 'fixture-proof', transport([value]).options));
  }
});

test('canonical 24:00 opening is retained and untitled official rows do not misassign indexed evidence', async () => {
  ready();
  const proof = { state: 'source_reported', source: 'VisitJeju', observed_at: null, evidence_url: null };
  const keptProof = { ...proof, source: 'TourAPI' };
  const value = {
    ...detail(), hours_week: [{ day: 0, open: '24:00', close: '02:00' }], hours_source: 'tourapi_usetime',
    field_evidence: { hours_week: keptProof, 'official_details.0': proof, 'official_details.1': proof, 'official_details.2': keptProof },
    official_details: [
      { title: null }, { title: '   ' },
      { provider: 'tourapi', provider_id: '12345', locale: 'ko', title: '제공처 안내',
        source_url: 'https://korean.visitkorea.or.kr/', fetched_at: '2026-09-12T01:02:03.000Z',
        address: null, phone: null, website: null, latitude: null, longitude: null,
        overview: null, facts: [], photos: [], match: { method: 'name_category_distance', distance_m: 10 } },
    ],
  };
  const found = await client.detailKakao('kakao:123', 'fixture-proof', transport([value]).options);
  assert.deepEqual(found.hours_week, [{ day: 0, open: '24:00', close: '02:00' }]);
  assert.equal(found.official_details.length, 1);
  assert.equal(found.official_details[0].title, '제공처 안내');
  assert.equal(found.field_evidence['official_details.0'].source, 'TourAPI');
  assert.equal(found.field_evidence['official_details.1'], undefined);
  assert.equal(found.field_evidence['official_details.2'], undefined);
});

test('only the current page plus active selection retain tokens; snapshots contain neither tokens nor live lookup', () => {
  ready();
  const selections = new client.KakaoSelections();
  const firstPage = Array.from({ length: 15 }, (_, index) => item(index + 100));
  const nextPage = Array.from({ length: 15 }, (_, index) => item(index + 200));
  selections.replacePage(firstPage);
  selections.activate('kakao:100');
  const refreshed = detail();
  refreshed.id = 'kakao:100';
  refreshed.url = 'https://place.map.kakao.com/100';
  refreshed.kakao_lookup.canonical_id = refreshed.id;
  refreshed.kakao_lookup.place.id = '100';
  refreshed.kakao_lookup.place.url = refreshed.url;
  selections.remember(refreshed);
  assert.equal(selections.get('kakao:100').selection_token, 'fixture-detail-native.proof');
  selections.replacePage(nextPage);
  assert.ok(selections.get('kakao:100'));
  assert.equal(selections.get('kakao:101'), undefined);
  assert.ok(selections.get('kakao:214'));
  selections.activate(null);
  assert.equal(selections.get('kakao:100'), undefined);
  selections.replacePage([]);
  assert.equal(selections.get('kakao:214'), undefined);
  const plain = client.nativeCatalogPlace(item());
  assert.equal(plain.selection_token, undefined);
  assert.doesNotMatch(JSON.stringify(snapshot(plain)), /selection_token|session-proof|kakao_lookup|linked_catalog/);
  assert.doesNotMatch(JSON.stringify(snapshot(detail())), /selection_token|session-proof|kakao_lookup|linked_catalog/);
  assert.equal(snapshot({ ...plain, id: 'poi_0900', name: '오래된 즐겨찾기', source: 'sample' }).id, 'poi_0900');
});

test('resolved Kakao detail paints safely across locale changes without any name lookup', async t => {
  assert.equal(typeof KakaoDetails.prototype.showResolved, 'function');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Unexpected lookup'); };
  t.after(() => { globalThis.fetch = original; setLocale('ko', null); });
  let root = { hidden: true, innerHTML: '', ownerDocument: { activeElement: null }, contains: () => false, setAttribute() {} };
  const panel = new KakaoDetails(() => root);
  panel.showResolved(item(), detail().kakao_lookup);
  assert.match(root.innerHTML, /https:\/\/place\.map\.kakao\.com\/123/);
  setLocale('en', null);
  root = { ...root, innerHTML: '' };
  panel.showResolved(item(), detail().kakao_lookup);
  assert.match(root.innerHTML, /Kakao visiting information/);
  const wrong = detail().kakao_lookup;
  wrong.place.id = '456';
  wrong.place.url = 'https://place.map.kakao.com/456';
  panel.showResolved(item(), wrong);
  assert.match(root.innerHTML, /data-detail-action="retry"/);
  assert.doesNotMatch(root.innerHTML, /href="https:\/\/place\.map\.kakao\.com\/456"/);
  panel.retry();
  panel.clear();
  await tick();
  assert.equal(root.hidden, true);
  assert.equal(calls, 0);
});
