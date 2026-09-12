import test from 'node:test';
import assert from 'node:assert/strict';

let subject;
try { subject = await import('../src/browsing-history.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const start = Date.parse('2026-09-12T00:00:00Z');
const day = 86_400_000;
const key = 'jeju-atlas.browsing.v1';
function memory() {
  const data = new Map();
  return {
    getItem: name => data.get(name) ?? null,
    setItem: (name, value) => { data.set(name, value); },
    removeItem: name => { data.delete(name); },
  };
}
function place(id = 'poi_0001', extra = {}) {
  return {
    id, name: `제주 장소 ${id}`, name_en: `Jeju place ${id}`, category: '관광지',
    lat: 33.4, lng: 126.5, source: 'sample', source_label: '큐레이션 시드',
    base_note: '원자료입니다.', address: '제주시', summary: '기록된 장소',
    updated_at: '2024-01-02',
    sources: [{ source: 'tourapi', url: 'https://api.visitkorea.or.kr/', observed_at: '2024-01-03', license: 'KOGL-1' }],
    ...extra,
  };
}
function make(t, options = {}) {
  assert.equal(typeof subject?.BrowsingHistory, 'function', 'browsing history needs an independent local store');
  const history = new subject.BrowsingHistory({ storage: memory(), clock: () => start, events: null, ...options });
  t.after(() => history.dispose());
  return history;
}
function storageEvent(events, name, value, storage) {
  const event = new Event('storage');
  Object.assign(event, { key: name, newValue: value, storageArea: storage });
  events.dispatchEvent(event);
}

test('queries and places remain bounded, deduplicated and ordered by explicit use', async t => {
  let now = start;
  const h = make(t, { clock: () => now });
  for (let i = 0; i < 15; i++) { now++; await h.rememberQuery(`검색 ${i}`); }
  assert.equal(h.queries.length, 12);
  assert.deepEqual(h.queries.slice(0, 3), ['검색 14', '검색 13', '검색 12']);
  now++;
  await h.rememberQuery('  JEJU   Cafe  ');
  now++;
  await h.rememberQuery('jeju cafe');
  assert.equal(h.queries[0], 'jeju cafe');
  assert.equal(h.queries.filter(query => query.toLowerCase() === 'jeju cafe').length, 1);
  for (let i = 0; i < 23; i++) { now++; await h.rememberPlace(place(`poi_${i}`)); }
  now++;
  await h.rememberPlace(place('poi_10', { name: '다시 연 장소' }));
  assert.equal(h.places.length, 20);
  assert.equal(h.places[0].id, 'poi_10');
  assert.equal(h.places[0].name, '다시 연 장소');
  assert.equal(h.places.filter(item => item.id === 'poi_10').length, 1);
  const queries = h.queries;
  const places = h.places;
  queries.length = 0;
  places[0].name = 'external mutation';
  assert.equal(h.queries.length, 12);
  assert.equal(h.places[0].name, '다시 연 장소');
});

test('only sanitized snapshots are persisted; source timestamps are not visit timestamps', async t => {
  const storage = memory();
  const h = make(t, { storage });
  const raw = place('kakao:123', {
    source: 'Kakao Local', selection_token: 'private-selection-proof', conversation_id: 'private-conversation',
    kakao_lookup: { place: { selection_token: 'nested-private-proof' } },
    field_evidence: { address: { state: 'source_reported', source: 'Kakao Local', observed_at: '2024-01-04', evidence_url: null } },
  });
  await h.rememberPlace(raw);
  const serialized = storage.getItem(key);
  assert.doesNotMatch(serialized, /selection_token|kakao_lookup|conversation_id|private-/);
  assert.equal(h.places[0].updated_at, '2024-01-02');
  assert.equal(h.places[0].sources[0].observed_at, '2024-01-03');
  assert.equal(h.places[0].field_evidence.address.observed_at, '2024-01-04');
  assert.deepEqual(h.places[0].geometry, { type: 'Point', coordinates: [126.5, 33.4] });
  assert.equal(h.persisted, true);
  assert.equal(make(t, { storage }).places[0].updated_at, '2024-01-02');
});

test('unnamed, invalid and automatically supplied GPS/map points are not remembered', async t => {
  const h = make(t);
  for (const invalid of [
    { lat: 33.4, lng: 126.5 }, place('point:123', { source: 'user_point', name: '현재 위치' }),
    place('gps-reading', { source: 'user_point' }), place('bad', { lat: 0 }),
    place('bad', { geometry: { type: 'Point', coordinates: [127, 33.4] } }),
    place('bad', { name: '' }), place('bad', { source: undefined }),
  ]) assert.equal(await h.rememberPlace(invalid), false);
  for (const query of ['', '   ', null, 'x'.repeat(201)]) assert.equal(await h.rememberQuery(query), false);
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.places, []);
});

test('30-day expiry uses local visit time and preserves explicit favorite pins', async t => {
  let now = start;
  const storage = memory();
  const h = make(t, { storage, clock: () => now });
  await h.rememberQuery('오래된 검색');
  await h.rememberPlace(place());
  await h.togglePin('poi_0001');
  now += 30 * day - 1;
  assert.equal(h.queries.length, 1);
  assert.equal(h.places.length, 1);
  now++;
  assert.deepEqual(h.queries, []);
  assert.deepEqual(h.places, []);
  const reopened = make(t, { storage, clock: () => now });
  assert.deepEqual(reopened.places, []);
  assert.deepEqual(reopened.pinnedIds, ['poi_0001']);
  await reopened.rememberQuery('새 검색');
  const stored = JSON.parse(storage.getItem(key));
  assert.equal(stored.places.length, 0);
  assert.equal(stored.queries.length, 1);
});

test('pinning accepts at most five IDs and an explicit unpin is idempotent', async t => {
  const h = make(t);
  for (let i = 0; i < 5; i++) assert.equal(await h.togglePin(`poi_${i}`), true);
  assert.equal(await h.togglePin('poi_5'), false);
  assert.equal(h.pinnedIds.length, 5);
  assert.equal(await h.togglePin('poi_2'), true);
  assert.equal(h.pinnedIds.includes('poi_2'), false);
  await h.togglePin('poi_2', false);
  assert.equal(h.pinnedIds.includes('poi_2'), false);
  assert.equal(await h.togglePin('poi_5'), true);
  const ids = h.pinnedIds;
  ids.length = 0;
  assert.equal(h.pinnedIds.length, 5);
});

test('each removal/clear affects only its named history, not favorites, trip data or pins', async t => {
  const storage = memory();
  storage.setItem('jeju-atlas.saved.v1', '{"favorites":["unchanged"],"stops":["unchanged"]}');
  storage.setItem('other-app', 'unchanged');
  const h = make(t, { storage });
  await h.rememberQuery('한라산');
  await h.rememberQuery('성산');
  await h.rememberPlace(place('poi_a'));
  await h.rememberPlace(place('poi_b'));
  await h.togglePin('poi_a');
  await h.removeQuery('한라산');
  await h.removePlace('poi_b');
  assert.deepEqual(h.queries, ['성산']);
  assert.deepEqual(h.places.map(p => p.id), ['poi_a']);
  await h.clearQueries();
  assert.equal(h.places.length, 1);
  await h.clearPlaces();
  assert.deepEqual(h.pinnedIds, ['poi_a']);
  assert.equal(storage.getItem('jeju-atlas.saved.v1'), '{"favorites":["unchanged"],"stops":["unchanged"]}');
  assert.equal(storage.getItem('other-app'), 'unchanged');
});

test('unavailable, corrupt and denied storage retain usable in-memory history without claiming persistence', async t => {
  const broken = memory();
  broken.setItem(key, '{broken');
  for (const storage of [
    null, broken,
    { getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new Error('denied'); } },
  ]) {
    const h = make(t, { storage });
    assert.equal(h.persisted, false);
    await h.rememberQuery('로컬 검색');
    await h.rememberPlace(place());
    assert.deepEqual(h.queries, ['로컬 검색']);
    assert.equal(h.places.length, 1);
    assert.equal(h.persisted, false);
    await h.clearQueries();
    assert.deepEqual(h.queries, []);
    assert.equal(h.places.length, 1);
  }
  assert.equal(broken.getItem(key), '{broken');
});

test('failed writes retain edits and deletions; recovery merges those intents with newer storage', async t => {
  let now = start;
  const storage = memory();
  const write = storage.setItem;
  const a = make(t, { storage, clock: () => now });
  await a.rememberQuery('삭제할 검색');
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  now++;
  await a.rememberQuery('창 안의 검색');
  await a.removeQuery('삭제할 검색');
  assert.deepEqual(a.queries, ['창 안의 검색']);
  assert.equal(a.persisted, false);
  storage.setItem = write;
  const b = make(t, { storage, clock: () => now });
  now++;
  await b.rememberQuery('다른 창의 검색');
  a.sync();
  assert.deepEqual(a.queries, ['다른 창의 검색', '창 안의 검색']);
  assert.equal(a.persisted, false);
  now++;
  await a.rememberQuery('새 검색');
  assert.deepEqual(make(t, { storage, clock: () => now }).queries, ['새 검색', '다른 창의 검색', '창 안의 검색']);
  assert.equal(a.persisted, true);
});

test('stale tabs reread storage before writing and cannot resurrect deleted history', async t => {
  const storage = memory();
  const a = make(t, { storage });
  const b = make(t, { storage });
  await a.rememberQuery('A');
  await b.rememberQuery('B');
  assert.deepEqual(b.queries, ['B', 'A']);
  await a.removeQuery('A');
  await b.rememberQuery('C');
  assert.deepEqual(make(t, { storage }).queries, ['C', 'B']);
  await a.clearQueries();
  await b.rememberPlace(place());
  assert.deepEqual(make(t, { storage }).queries, []);
});

test('a recovered clear does not delete searches added afterward by another tab', async t => {
  const storage = memory();
  const write = storage.setItem;
  const a = make(t, { storage });
  await a.rememberQuery('오래된 검색');
  for (let i = 0; i < 5; i++) await a.togglePin(`poi_${i}`);
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  await a.clearQueries();
  storage.setItem = write;
  const b = make(t, { storage });
  await b.clearQueries();
  assert.equal(await a.togglePin('sixth-pin'), false);
  assert.equal(a.persisted, true, 'the requested clear now matches storage');
  await b.rememberQuery('새로운 검색');
  await a.rememberPlace(place());
  assert.deepEqual(make(t, { storage }).queries, ['새로운 검색']);
});

test('a shared clear discards older failed additions and updates before unrelated writes can replay them', async t => {
  let now = start;
  const storage = memory();
  const write = storage.setItem;
  const a = make(t, { storage, clock: () => now });
  await a.rememberQuery('지울 검색');
  await a.rememberPlace(place('poi_old'));
  const b = make(t, { storage, clock: () => now });
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  now++;
  await a.rememberQuery('지울 검색');
  await a.rememberQuery('아직 저장되지 않은 검색');
  await a.rememberPlace(place('poi_old', { name: '임시 변경' }));
  await a.rememberPlace(place('poi_unsaved'));
  storage.setItem = write;
  now++;
  await b.clearQueries();
  await b.clearPlaces();
  a.sync();
  assert.deepEqual(a.queries, []);
  assert.deepEqual(a.places, []);
  await a.togglePin('poi_pin');
  const reopened = make(t, { storage, clock: () => now });
  assert.deepEqual(reopened.queries, []);
  assert.deepEqual(reopened.places, []);
});

test('a failed clear removes only the observed records while preserving later stored searches and places', async t => {
  const storage = memory();
  const write = storage.setItem;
  const a = make(t, { storage });
  await a.rememberQuery('오래된 검색');
  await a.rememberPlace(place('poi_old'));
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  await a.clearQueries();
  await a.clearPlaces();
  storage.setItem = write;
  const b = make(t, { storage });
  await b.rememberQuery('새로운 검색');
  await b.rememberPlace(place('poi_new'));
  // These actions intentionally share a clock tick; distinct uses still need identities.
  await b.rememberQuery('오래된 검색');
  await b.rememberPlace(place('poi_old', { name: '다시 연 장소' }));
  await a.togglePin('poi_pin');
  const reopened = make(t, { storage });
  assert.deepEqual(reopened.queries, ['오래된 검색', '새로운 검색']);
  assert.deepEqual(reopened.places.map(item => item.id), ['poi_old', 'poi_new']);
  assert.equal(reopened.places[0].name, '다시 연 장소');
});

test('a later individual removal wins over an older failed update of the same history record', async t => {
  let now = start;
  const storage = memory();
  const write = storage.setItem;
  const a = make(t, { storage, clock: () => now });
  await a.rememberQuery('제주');
  await a.rememberPlace(place('poi_old'));
  const b = make(t, { storage, clock: () => now });
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  now++;
  await a.rememberQuery('제주');
  await a.rememberPlace(place('poi_old', { name: '실패한 변경' }));
  storage.setItem = write;
  now++;
  await b.removeQuery('제주');
  await b.removePlace('poi_old');
  await a.rememberQuery('새로운 검색');
  assert.deepEqual(make(t, { storage, clock: () => now }).queries, ['새로운 검색']);
  assert.deepEqual(make(t, { storage, clock: () => now }).places, []);
});

test('shared browser locks preserve concurrent additions and never overfill the pin bound', async t => {
  const storage = memory();
  let queue = Promise.resolve();
  const withLock = work => {
    const pending = queue.then(work);
    queue = pending.catch(() => {});
    return pending;
  };
  const a = make(t, { storage, withLock });
  const b = make(t, { storage, withLock });
  await Promise.all([a.rememberQuery('A'), b.rememberQuery('B')]);
  assert.deepEqual(make(t, { storage }).queries, ['B', 'A']);
  const accepted = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).togglePin(`poi_${i}`)));
  assert.equal(accepted.filter(Boolean).length, 5);
  assert.equal(make(t, { storage }).pinnedIds.length, 5);
});

test('storage events synchronize additions and deletions, ignore other keys, and detach on disposal', async t => {
  const storage = memory();
  const events = new EventTarget();
  const a = make(t, { storage, events });
  const b = make(t, { storage });
  let changes = 0;
  const unsubscribe = a.subscribe(() => changes++);
  await b.rememberQuery('다른 탭');
  storageEvent(events, 'unrelated', 'anything', storage);
  assert.deepEqual(a.queries, []);
  storageEvent(events, key, storage.getItem(key), storage);
  assert.deepEqual(a.queries, ['다른 탭']);
  assert.ok(changes > 0);
  await b.clearQueries();
  storageEvent(events, key, storage.getItem(key), storage);
  assert.deepEqual(a.queries, []);
  unsubscribe();
  a.dispose();
  await b.rememberQuery('나중 검색');
  storageEvent(events, key, storage.getItem(key), storage);
  assert.deepEqual(a.queries, []);
});

test('recognized stored documents sanitize invalid/duplicate entries and never expose stored transient fields', async t => {
  const storage = memory();
  storage.setItem(key, JSON.stringify({
    version: 1,
    queries: [{ query: '제주', at: start - 1 }, { query: ' 제주 ', at: start }, { query: '미래', at: start + day }],
    places: [
      { place: place('poi_a', { selection_token: 'must-not-return' }), at: start },
      { place: place('poi_a', { name: 'older' }), at: start - 1 },
      { place: place('invalid', { lat: 1 }), at: start },
    ],
    pinnedIds: ['poi_a', 'poi_a', '<bad>'],
  }));
  const h = make(t, { storage });
  assert.deepEqual(h.queries, ['제주']);
  assert.deepEqual(h.places.map(p => p.id), ['poi_a']);
  assert.equal(h.places[0].selection_token, undefined);
  assert.deepEqual(h.pinnedIds, ['poi_a']);
  await h.rememberQuery('추가');
  assert.doesNotMatch(storage.getItem(key), /selection_token|must-not-return/);
});
