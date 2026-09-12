import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDiscoveryAdapter } from '../server/discovery.mjs';

let createGuideDiscovery;
try { ({ createGuideDiscovery } = await import('../server/guide-discovery.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const at = '2026-09-12T10:00:00.000Z';
const provider = (index = 1, group = 'CE7') => ({
  id: String(index), name: `제주 테스트 ${index}`, category: '음식점 > 카페', group,
  groupName: '카페', address: '제주시 테스트로', road_address: '제주시 테스트로 1',
  phone: '064-000-0000', url: `https://place.map.kakao.com/${index}`,
  lat: 33.45, lng: 126.55, providerDistance: null,
});

function fixture({ rows = [], failure, enabled = true, items = [provider()], search, catalogSearch } = {}) {
  assert.equal(typeof createGuideDiscovery, 'function', 'Implement the BFF-owned Guide discovery bridge');
  let now = Date.parse(at);
  const calls = [], slots = [];
  const catalog = {
    search: catalogSearch ?? (({ q }) => {
      const found = rows.filter(row => [row.name, row.name_en].includes(q));
      return { items: found, total: found.length, has_more: false };
    }),
    detail: id => rows.find(row => row.id === id) ?? null,
  };
  const discovery = createDiscoveryAdapter({ secret: 'guide-discovery-fixture-'.repeat(3), catalog, clock: () => now });
  const raw = {
    items, total: items.length, pageable: items.length, page: 1,
    page_size: 15, end: true, truncated: false, queried_at: at,
  };
  const kakao = {
    enabled: true,
    async search(request, options) {
      calls.push({ request, options });
      if (failure) throw failure;
      return search ? search(request, options) : raw;
    },
  };
  const bridge = createGuideDiscovery({
    catalog, kakao, discovery, enabled: () => enabled, clock: () => now,
    takeSlot: actor => slots.push(actor),
  });
  const token = discovery.toSearch(raw, { query: '', category: '카페', scope: 'all', center: { lat: 33.45, lng: 126.55 } }, 'reader').items[0]?.selection_token;
  return { bridge, token, calls, slots, setNow: value => { now = value; } };
}

test('a valid selection produces bounded token-free grounding without another provider call', async () => {
  const f = fixture();
  const selection = f.bridge.validateSelection(f.token, 'reader');
  assert.equal(f.calls.length, 0);
  assert.equal(f.slots.length, 0);
  const result = await f.bridge.resolve({ message: '선택한 장소의 이용시간을 알려 주세요.', actorId: 'reader', selection });
  assert.equal(result.payload.kind, 'selection');
  assert.equal(result.payload.status, 'ready');
  assert.equal(result.payload.items[0].id, 'kakao:1');
  assert.equal(result.payload.items[0].observed_at, at);
  assert.equal(result.places[0].id, 'kakao:1');
  assert.ok(!JSON.stringify(result).includes(f.token));
  assert.ok(!JSON.stringify(result.payload).includes('selection_token'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.slots.length, 0);
});

test('selection signature, actor and expiry are checked synchronously without provider work', () => {
  const f = fixture();
  for (const [token, actor] of [[`${f.token}x`, 'reader'], [f.token, 'another-reader'], ['', 'reader']]) {
    assert.throws(() => f.bridge.validateSelection(token, actor), error => error.code === 'kakao_selection_invalid');
  }
  f.setNow(Date.parse(at) + 15 * 60_000);
  assert.throws(() => f.bridge.validateSelection(f.token, 'reader'), error => error.code === 'kakao_selection_expired');
  assert.equal(f.calls.length, 0);
  assert.equal(f.slots.length, 0);
});

test('commercial recommendations make one shared first-page search and take one actor slot', async () => {
  for (const [message, category] of [
    ['제주 카페 추천해 주세요.', '카페'], ['맛집 추천', '맛집'],
    ['숙소를 찾아 주세요.', '숙소'], ['주차장 찾아줘', '주차장'],
    ['Recommend restaurants in Jeju.', '맛집'], ['Find cafes in Jeju.', '카페'],
    ['Recommend hotels in Jeju.', '숙소'], ['Find parking in Jeju.', '주차장'],
  ]) {
    const f = fixture({ items: Array.from({ length: 15 }, (_, index) => provider(index + 1)) });
    const result = await f.bridge.resolve({ message, actorId: 'reader' });
    assert.equal(f.calls.length, 1, message);
    assert.equal(f.calls[0].request.category, category, message);
    assert.equal(f.calls[0].request.page, 1);
    assert.equal(f.calls[0].request.scope, 'all');
    assert.deepEqual(f.slots, ['reader']);
    assert.equal(result.payload.items.length, 3);
    assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= 16 * 1024);
  }
});

test('named nearby searches resolve exact catalog anchors including existing aliases', async () => {
  const f = fixture({ rows: [
    { id: 'beach', name: '함덕해수욕장', name_en: 'Hamdeok Beach', category: '해변', lat: 33.543, lng: 126.669 },
  ] });
  const result = await f.bridge.resolve({ message: '함덕해변 근처 카페 추천', actorId: 'reader' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.scope, 'nearby');
  assert.deepEqual(f.calls[0].request.center, { lat: 33.543, lng: 126.669 });
  assert.equal(f.calls[0].request.radius_m, 5000);
  assert.equal(result.payload.anchor.name, '함덕해수욕장');
  const english = fixture({ rows: [
    { id: 'beach', name: '함덕해수욕장', name_en: 'Hamdeok Beach', category: '해변', lat: 33.543, lng: 126.669 },
  ] });
  await english.bridge.resolve({ message: 'Find cafes near Hamdeok Beach.', actorId: 'reader', locale: 'en' });
  assert.deepEqual(english.calls[0].request.center, { lat: 33.543, lng: 126.669 });
});

const hyeopjae = [
  { id: 'osm:node/368950786', name: '협재 해수욕장', name_en: 'Hyeopjae Beach',
    category: '관광지', lat: 33.395112, lng: 126.2402796, source: 'OpenStreetMap' },
  { id: 'poi_0057', name: '협재해수욕장', name_en: 'Hyeopjae Beach',
    category: '해변', lat: 33.3942, lng: 126.2396, source: 'sample' },
];
const anchorFixture = (rows, extra = {}) => fixture({
  rows, catalogSearch: () => ({ items: rows, total: rows.length, has_more: false }), ...extra,
});

test('the declared Seongsan identity resolves co-located tourism duplicates and makes one restaurant lookup', async () => {
  const rows = [
    { id: 'osm:node/330006952', name: '성산일출봉', name_en: 'Seongsan Ilchulbong', category: '관광지', lat: 33.4588891, lng: 126.9408178 },
    { id: 'poi_0008', name: '성산일출봉', name_en: 'Seongsan Ilchulbong', category: '관광지', lat: 33.45842, lng: 126.93892 },
  ];
  for (const ordered of [rows, rows.toReversed()]) {
    const f = anchorFixture(ordered);
    const result = await f.bridge.resolve({ message: '성산일출봉 근처 맛집 한 곳과 확인된 주소, 출처를 간단히 알려 주세요.', actorId: 'reader' });
    assert.equal(result.payload.anchor?.id, 'poi_0008');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].request.category, '맛집');
    assert.deepEqual(f.calls[0].request.center, { lat: 33.45842, lng: 126.93892 });
  }
  for (const invalid of [
    rows.map(row => ({ ...row, id: `other-${row.id}` })),
    [rows[0], { ...rows[1], category: '카페' }],
    [rows[0], { ...rows[1], lat: 33.47 }],
  ]) {
    const f = anchorFixture(invalid);
    const result = await f.bridge.resolve({ message: '성산일출봉 근처 맛집', actorId: 'reader' });
    assert.equal(result.payload.status, 'anchor_required');
    assert.equal(f.calls.length, 0);
  }
});

test('production Hyeopjae beach rows reconcile only the anchor without merging catalog or provider identities', async () => {
  const other = { id: 'non-exact-search-hit', name: '협재해수욕장 앞 카페', category: '카페', lat: 33.3943, lng: 126.24 };
  for (const rows of [[...hyeopjae, other], [other, ...hyeopjae.toReversed()]]) {
    const before = structuredClone(rows);
    const f = anchorFixture(rows);
    const result = await f.bridge.resolve({ message: '협재해수욕장 근처 맛집 추천', actorId: 'reader' });
    assert.equal(result.payload.status, 'ready');
    assert.deepEqual(result.payload.anchor, {
      id: 'poi_0057', name: '협재해수욕장', lat: 33.3942, lng: 126.2396,
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].request.category, '맛집');
    assert.deepEqual(f.calls[0].request.center, { lat: 33.3942, lng: 126.2396 });
    assert.equal(result.payload.items[0].id, 'kakao:1');
    assert.deepEqual(rows, before, 'Anchor reconciliation must not alter either stored record');
  }
});

test('a declared natural landmark category resolves identical literal names and English aliases', async () => {
  const rows = hyeopjae.map(row => ({ ...row, name: '협재해수욕장' }));
  for (const message of ['협재해수욕장 근처 카페 추천', 'Find cafes near Hyeopjae Beach.']) {
    const f = anchorFixture(rows);
    const result = await f.bridge.resolve({ message, actorId: 'reader' });
    assert.equal(result.payload.anchor.id, 'poi_0057', message);
    assert.deepEqual(f.calls[0].request.center, { lat: 33.3942, lng: 126.2396 });
  }
});

test('other co-located natural rows need a unique literal full-name match', async () => {
  const rows = [
    { id: 'mountain-spaced', name: '테스트 오름', category: '관광지', lat: 33.4, lng: 126.55 },
    { id: 'mountain-literal', name: '테스트오름', category: '오름', lat: 33.4005, lng: 126.55 },
  ];
  for (const ordered of [rows, rows.toReversed()]) {
    const f = anchorFixture(ordered);
    const result = await f.bridge.resolve({ message: '테스트오름 근처 카페 추천', actorId: 'reader' });
    assert.equal(result.payload.anchor.id, 'mountain-literal');
  }
});

test('commercial homonyms, incompatible natural categories and unresolved natural ties remain ambiguous', async () => {
  const cases = [
    ['business homonyms', '바다카페', [
      { id: 'cafe-literal', name: '바다카페', category: '카페', lat: 33.4, lng: 126.55 },
      { id: 'cafe-spaced', name: '바다 카페', category: '카페', lat: 33.4005, lng: 126.55 },
    ]],
    ['mixed business/natural', '협재해수욕장', [hyeopjae[1], { ...hyeopjae[0], category: '카페' }]],
    ['incompatible natural categories', '협재해수욕장', [hyeopjae[1], { ...hyeopjae[0], category: '오름' }]],
    ['two canonical-category literal matches', '협재해수욕장', hyeopjae.map(row => ({
      ...row, name: '협재해수욕장', category: '해변',
    }))],
    ['no unique literal or declared category', '테스트해변', [
      { id: 'beach-a', name: '테스트 해변', category: '해변', lat: 33.4, lng: 126.55 },
      { id: 'beach-b', name: '테스트 해 변', category: '해변', lat: 33.4005, lng: 126.55 },
    ]],
    ['tourism alone does not establish a natural landmark', '같은장소', [
      { id: 'tourism-a', name: '같은장소', category: '관광지', lat: 33.4, lng: 126.55 },
      { id: 'tourism-b', name: '같은 장소', category: '관광지', lat: 33.4005, lng: 126.55 },
    ]],
  ];
  for (const [label, name, rows] of cases) {
    const f = anchorFixture(rows);
    const result = await f.bridge.resolve({ message: `${name} 근처 맛집 추천`, actorId: 'reader' });
    assert.equal(result.payload.status, 'anchor_required', label);
    assert.equal(f.calls.length, 0, label);
    assert.equal(f.slots.length, 0, label);
  }
});

test('every exact natural candidate must be within 200m of every other candidate', async () => {
  for (const rows of [
    [{ ...hyeopjae[0], lat: 33.405 }, hyeopjae[1]],
    // Each outer point is <200m from the canonical one, but >200m apart.
    [{ ...hyeopjae[0], lat: 33.3927, lng: 126.2396 }, hyeopjae[1],
      { ...hyeopjae[0], id: 'opposite-side', lat: 33.3957, lng: 126.2396 }],
  ]) {
    const f = anchorFixture(rows);
    const result = await f.bridge.resolve({ message: '협재해수욕장 근처 맛집 추천', actorId: 'reader' });
    assert.equal(result.payload.status, 'anchor_required');
    assert.equal(f.calls.length, 0);
  }
});

test('shared English aliases and incomplete search windows cannot reconcile different natural places', async () => {
  const different = [hyeopjae[1], { ...hyeopjae[0], name: '다른해수욕장', category: '해변' }];
  for (const f of [
    anchorFixture(different),
    anchorFixture(hyeopjae, { catalogSearch: () => ({ items: hyeopjae, total: 3, has_more: true }) }),
  ]) {
    const result = await f.bridge.resolve({ message: 'Find cafes near Hyeopjae Beach.', actorId: 'reader' });
    assert.equal(result.payload.status, 'anchor_required');
    assert.equal(f.calls.length, 0);
  }
});

test('a selected native place anchors an explicit nearby search without searching its name again', async () => {
  const f = fixture();
  const selection = f.bridge.validateSelection(f.token, 'reader');
  const result = await f.bridge.resolve({ message: '여기 근처 맛집 추천', actorId: 'reader', selection });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.category, '맛집');
  assert.deepEqual(f.calls[0].request.center, { lat: 33.45, lng: 126.55 });
  assert.equal(result.payload.anchor.id, 'kakao:1');
});

test('category words in a selected anchor name do not override the requested nearby category', async () => {
  for (const [name, message] of [
    ['바다카페', '바다카페 근처 맛집 추천'],
    ['바다카페', '여기 근처 맛집 추천'],
    ['Sea Cafe', 'Find restaurants near Sea Cafe.'],
    ['Sea Cafe', 'Near Sea Cafe, recommend restaurants.'],
  ]) {
    const f = fixture({ items: [{ ...provider(), name }] });
    const selection = f.bridge.validateSelection(f.token, 'reader');
    const result = await f.bridge.resolve({ message, actorId: 'reader', selection });
    assert.equal(f.calls.length, 1, message);
    assert.equal(f.calls[0].request.category, '맛집', message);
    assert.equal(f.calls[0].request.scope, 'nearby');
    assert.deepEqual(f.calls[0].request.center, { lat: 33.45, lng: 126.55 });
    assert.equal(result.payload.anchor.id, selection.id);
  }
});

test('catalog anchor names and English aliases are excluded from nearby category detection', async () => {
  for (const message of [
    '바다카페 근처 맛집 추천',
    'Find restaurants near Sea Cafe.',
    'Near Sea Cafe, recommend restaurants.',
  ]) {
    const f = fixture({ rows: [
      { id: 'anchor-cafe', name: '바다카페', name_en: 'Sea Cafe', category: '카페', lat: 33.48, lng: 126.59 },
    ] });
    const result = await f.bridge.resolve({ message, actorId: 'reader' });
    assert.equal(f.calls.length, 1, message);
    assert.equal(f.calls[0].request.category, '맛집', message);
    assert.deepEqual(f.calls[0].request.center, { lat: 33.48, lng: 126.59 });
    assert.equal(result.payload.anchor.id, 'anchor-cafe');
  }
});

test('anchor category exclusion preserves selected-place details and nearby nature/weather handling', async () => {
  const f = fixture({
    items: [{ ...provider(), name: '바다카페' }],
    rows: [{ id: 'anchor-cafe', name: '바다카페', category: '카페', lat: 33.45, lng: 126.55 }],
  });
  const selection = f.bridge.validateSelection(f.token, 'reader');
  const detail = await f.bridge.resolve({ message: '바다카페 이용시간 알려줘', actorId: 'reader', selection });
  assert.equal(detail.payload.kind, 'selection');
  assert.equal(detail.payload.items[0].id, selection.id);
  for (const context of [selection, null]) {
    for (const message of ['바다카페 근처 해변 추천', '바다카페 근처 날씨']) {
      assert.equal(await f.bridge.resolve({ message, actorId: 'reader', selection: context }), null, message);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('a selection that expires while admission waits cannot initiate a provider search', async () => {
  const f = fixture();
  const selection = f.bridge.validateSelection(f.token, 'reader');
  f.setNow(Date.parse(at) + 15 * 60_000);
  await assert.rejects(f.bridge.resolve({ message: '여기 근처 맛집', actorId: 'reader', selection }),
    error => error.code === 'kakao_selection_expired');
  assert.equal(f.calls.length, 0);
});

test('unknown, ambiguous or unrelated anchors never become island-wide searches', async () => {
  for (const rows of [
    [],
    [{ id: 'wrong', name: '다른 장소', category: '관광지', lat: 33.4, lng: 126.5 }],
    [1, 2].map(index => ({ id: `p${index}`, name: '같은장소', category: '관광지', lat: 33.4, lng: 126.5 })),
  ]) {
    const f = fixture({ rows });
    const result = await f.bridge.resolve({ message: '같은장소 근처 카페 추천', actorId: 'reader' });
    assert.equal(result.payload.status, 'anchor_required');
    assert.deepEqual(result.places, []);
    assert.equal(f.calls.length, 0);
    assert.equal(f.slots.length, 0);
  }
});

test('named regions remain search terms and nature/weather questions stay with existing grounding', async () => {
  const f = fixture();
  await f.bridge.resolve({ message: '애월 카페 추천', actorId: 'reader' });
  assert.match(f.calls[0].request.query, /애월/);
  for (const message of ['한라산 날씨', '해변 추천', '비 오는 날 실내 박물관 추천', '카페 말고 해변 추천']) {
    assert.equal(await f.bridge.resolve({ message, actorId: 'reader' }), null, message);
  }
  assert.equal(f.calls.length, 1);
});

test('provider failure, empty results and a disabled service never substitute legacy commercial records', async () => {
  for (const options of [
    { failure: new Error('provider-body-private-sentinel') },
    { items: [] },
    { enabled: false },
  ]) {
    const f = fixture({ ...options, rows: [
      { id: 'legacy-cafe', name: '시드 카페', category: '카페', lat: 33.4, lng: 126.5 },
    ] });
    const result = await f.bridge.resolve({ message: '카페 추천', actorId: 'reader' });
    assert.ok(['empty', 'unavailable'].includes(result.payload.status));
    assert.deepEqual(result.places, []);
    assert.ok(!JSON.stringify(result).includes('legacy-cafe'));
    assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
});

test('cancellation reaches the shared provider and is never converted into an empty recommendation', async () => {
  const controller = new AbortController();
  const f = fixture({ search: async (_request, { signal }) => {
    assert.equal(signal, controller.signal);
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    throw signal.reason;
  } });
  await assert.rejects(f.bridge.resolve({ message: '카페 추천', actorId: 'reader', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
  const before = fixture();
  await assert.rejects(before.bridge.resolve({ message: '카페 추천', actorId: 'reader', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(before.calls.length, 0);
  assert.equal(before.slots.length, 0);
});

test('the real BFF projection satisfies the Python Guide payload contract including public evidence', async () => {
  const f = fixture({ rows: [{
    id: 'public-reference', name: '제주 테스트 1', category: '카페', lat: 33.45, lng: 126.55,
    source: 'VisitJeju', facilities: { parking: 'yes' }, hours_week: [], sources: [],
    field_evidence: { 'facilities.parking': { state: 'source_reported', source: 'VisitJeju', observed_at: at } },
  }] });
  const resolved = await f.bridge.resolve({ message: '카페 추천', actorId: 'reader' });
  assert.equal(resolved.payload.items[0].details.facilities.parking, 'yes');
  const verification = spawnSync(process.env.ATLAS_PYTHON || 'python3', ['-B', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from atlas_agent.payload import parse_payload
request = parse_payload({"prompt": "카페 추천", "grounding": json.load(sys.stdin)})
assert request.grounding["items"][0]["details"]["facilities"]["parking"] == "yes"
assert request.grounding["items"][0]["source"] == "Kakao Local"
print("BFF and Guide contracts agree")
`, fileURLToPath(new URL('../agent/guide', import.meta.url))], {
    input: JSON.stringify(resolved.payload), encoding: 'utf8',
  });
  assert.equal(verification.status, 0, verification.stderr);
});
