import test from 'node:test';
import assert from 'node:assert/strict';

let subject;
try { subject = await import('../src/saved-data.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const key = 'jeju-atlas.saved.v1';
function memoryStorage() {
  const records = new Map();
  return {
    records, getItem: name => records.get(name) ?? null,
    setItem: (name, value) => records.set(name, value),
    removeItem: name => records.delete(name),
  };
}
function place(id = 'osm:node/101') {
  return {
    id, name: `장소 ${id}`, lat: 33.4, lng: 126.5, category: '카페',
    source: 'osm', source_label: 'OpenStreetMap', base_note: '기본 자료',
    address: '검증용 주소', summary: '저장된 소개', updated_at: '2026-09-10',
    geometry: { type: 'Point', coordinates: [126.5, 33.4] },
    sources: [{ source: 'osm', url: 'https://www.openstreetmap.org/node/101', observed_at: '2026-09-10', license: 'ODbL', note: '필드 근거' }],
  };
}
const saved = () => ({ version: 1, favorites: [place()], stops: [{ ...place(), stay_min: 90 }] });
function make(storage = memoryStorage(), extra = {}) {
  assert.equal(typeof subject?.SavedDataStore, 'function', 'SavedDataStore must implement durable device storage');
  return new subject.SavedDataStore({ storage, ...extra });
}

test('legacy saved data round-trips every source, coordinate and dwell value through a validated export', async () => {
  const storage = memoryStorage();
  storage.setItem(key, JSON.stringify(saved()));
  const original = make(storage);
  const preview = subject.previewImport(original.export());
  assert.deepEqual(preview.data, saved());
  const restored = make();
  assert.equal((await restored.replace(preview.data, restored.revision)).ok, true);
  assert.deepEqual(restored.data, saved());
});

test('quota and denied reads retain an exportable draft and never claim durable success', async () => {
  const storage = memoryStorage();
  const planner = make(storage);
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  const result = await planner.update(data => { data.stops.push({ ...place(), stay_min: 45 }); });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quota');
  assert.equal(planner.hasUnsavedChanges, true);
  assert.equal(subject.previewImport(planner.export()).data.stops[0].stay_min, 45);
  assert.equal(storage.getItem(key), null);
  const blocked = make({ getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } });
  assert.equal((await blocked.update(data => { data.favorites.push(place()); })).ok, false);
  assert.equal(subject.previewImport(blocked.export()).data.favorites.length, 1);
});

test('two stale editors and simultaneous writes preserve both additions', async () => {
  const storage = memoryStorage();
  let serial = Promise.resolve();
  const withLock = operation => {
    const pending = serial.then(operation);
    serial = pending.then(() => {}, () => {});
    return pending;
  };
  const a = make(storage, { withLock });
  const b = make(storage, { withLock });
  await Promise.all([
    a.update(data => { data.stops.push({ ...place('a'), stay_min: 30 }); }),
    b.update(data => { data.stops.push({ ...place('b'), stay_min: 60 }); }),
  ]);
  assert.deepEqual(make(storage).data.stops.map(stop => stop.id), ['a', 'b']);
  a.sync();
  assert.deepEqual(a.data.stops.map(stop => stop.id), ['a', 'b']);
});

test('an import preview cannot overwrite a different tab edit made after review began', async () => {
  const storage = memoryStorage();
  const a = make(storage);
  const b = make(storage);
  const reviewedRevision = a.revision;
  await b.update(data => { data.stops.push({ ...place('other-tab'), stay_min: 60 }); });
  const result = await a.replace(saved(), reviewedRevision);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.deepEqual(make(storage).data.stops.map(stop => stop.id), ['other-tab']);
});

test('an unsaved draft is not discarded when another tab publishes a saved change', async () => {
  const storage = memoryStorage();
  const a = make(storage);
  const write = storage.setItem;
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  await a.update(data => { data.stops.push({ ...place('draft'), stay_min: 60 }); });
  storage.setItem = write;
  const b = make(storage);
  await b.update(data => { data.stops.push({ ...place('published'), stay_min: 60 }); });
  a.sync();
  assert.equal(a.status, 'conflict');
  assert.equal(a.data.stops[0].id, 'draft');
  assert.equal((await a.retry()).ok, false);
  assert.equal(make(storage).data.stops[0].id, 'published');
});

test('corrupt or unsupported saved data stays untouched until an explicit reviewed replacement', async () => {
  for (const raw of ['{broken', '{"version":99,"stops":[],"favorites":[]}']) {
    const storage = memoryStorage();
    storage.setItem(key, raw);
    const a = make(storage);
    assert.equal(a.status, 'invalid');
    assert.equal((await a.update(data => { data.favorites.push(place()); })).ok, false);
    assert.equal(storage.getItem(key), raw);
    assert.equal((await a.replace(saved(), a.revision)).ok, true);
    assert.deepEqual(make(storage).data, saved());
  }
});

test('last good backup can be inspected after corruption, and deletion removes only Atlas saved keys', async () => {
  const storage = memoryStorage();
  storage.setItem('unrelated-preference', 'keep');
  const a = make(storage);
  await a.replace(saved(), a.revision);
  await a.update(data => { data.stops[0].stay_min = 120; });
  storage.setItem(key, '{corrupt');
  const damaged = make(storage);
  assert.equal(damaged.backup().stops[0].stay_min, 90);
  assert.equal((await damaged.clear(damaged.revision)).ok, true);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem(`${key}.backup`), null);
  assert.equal(storage.getItem('unrelated-preference'), 'keep');
  assert.deepEqual(damaged.data, { version: 1, favorites: [], stops: [] });
});

test('failed deletion remains an error and retains recovery data', async () => {
  const storage = memoryStorage();
  storage.setItem(key, JSON.stringify(saved()));
  storage.removeItem = () => { throw new DOMException('denied', 'SecurityError'); };
  const a = make(storage);
  assert.equal((await a.clear(a.revision)).ok, false);
  assert.deepEqual(a.data, saved());
});

test('discarding a reviewed unsaved draft restores the prior document without deleting persisted data', async () => {
  const storage = memoryStorage();
  const a = make(storage);
  await a.replace(saved(), a.revision);
  const original = storage.getItem(key);
  const write = storage.setItem;
  storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  await a.update(data => { data.stops[0].stay_min = 120; });
  storage.setItem = write;
  a.discardDraft();
  assert.equal(a.hasUnsavedChanges, false);
  assert.equal(a.data.stops[0].stay_min, 90);
  assert.equal(storage.getItem(key), original);
});

test('an uncoordinated legacy tab cannot silently erase a newer editor snapshot', async () => {
  const storage = memoryStorage();
  const a = make(storage);
  await a.replace(saved(), a.revision);
  storage.setItem(key, JSON.stringify({ version: 1, favorites: [], stops: [] }));
  const result = await a.update(data => { data.stops[0].stay_min = 125; });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(a.data.stops[0].stay_min, 125);
  assert.equal(subject.previewImport(a.export()).data.favorites.length, 1);
});

test('imports reject invalid shape, excessive records, duplicate IDs, unsafe URLs and non-Jeju geometry without silent trimming', () => {
  assert.equal(typeof subject?.previewImport, 'function');
  const cases = [
    { ...saved(), version: 99 },
    { ...saved(), favorites: Array.from({ length: 101 }, (_, i) => place(String(i))) },
    { ...saved(), stops: Array.from({ length: 13 }, (_, i) => ({ ...place(String(i)), stay_min: 1 })) },
    { ...saved(), favorites: [place(), place()] },
    { ...saved(), favorites: [{ ...place(), lat: 0 }] },
    { ...saved(), favorites: [{ ...place(), geometry: { type: 'Point', coordinates: [0, 0] } }] },
    { ...saved(), favorites: [{ ...place(), sources: [{ source: 'evil', url: 'javascript:alert(1)' }] }] },
    { ...saved(), stops: [{ ...place(), stay_min: -1 }] },
  ];
  for (const value of cases) assert.throws(() => subject.previewImport(JSON.stringify(value)));
  assert.throws(() => subject.previewImport(' '.repeat(700001)));
  assert.throws(() => subject.previewImport('{bad json'));
});

test('merge preserves reviewed current records, adds new IDs once and refuses overflow', () => {
  assert.equal(typeof subject?.mergeSavedData, 'function');
  const incoming = { version: 1, favorites: [place('new')], stops: [{ ...place(), stay_min: 20 }, { ...place('new'), stay_min: 60 }] };
  const merged = subject.mergeSavedData(saved(), incoming);
  assert.deepEqual(merged.stops.map(stop => [stop.id, stop.stay_min]), [[place().id, 90], ['new', 60]]);
  assert.equal(merged.favorites.length, 2);
  assert.throws(() => subject.mergeSavedData(
    { version: 1, favorites: [], stops: Array.from({ length: 12 }, (_, i) => ({ ...place(String(i)), stay_min: 1 })) },
    incoming,
  ));
});
