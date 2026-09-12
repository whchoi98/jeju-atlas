import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as saved from '../src/saved-data.ts';
import * as api from '../src/api.ts';
import * as i18n from '../src/i18n.ts';
import { RoutingController } from '../src/routing.ts';

let endpoint;
try { endpoint = await import('../src/endpoint-search.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const exports = {};
const modules = { './saved-data': saved, './api': api, './i18n': i18n, './endpoint-search': endpoint };
vm.runInNewContext(ts.transpileModule(await readFile(new URL('../src/trip.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports, require: name => modules[name] ?? {}, URL, URLSearchParams, crypto, structuredClone,
  location: { href: 'https://atlas.example.test/', hash: '' }, history: { replaceState() {} },
});
const place = (id, index = 0) => ({
  id, name: `장소 ${id}`, name_en: `Place ${id}`, category: '관광지',
  lng: 126.4 + index * .01, lat: 33.4,
  address: `제주 주소 ${index}`, source: `source-${id}`, source_label: `Source ${id}`,
  base_note: '저장된 원자료', summary: `소개 ${id}`, updated_at: '2026-09-12',
  sources: [{ source: `source-${id}`, url: `https://example.test/${id}`, observed_at: '2026-09-12', license: 'fixture' }],
});
const stop = (id, index) => ({ ...place(id, index), stay_min: 15 + index * 15 });
function fixture(stops = [], favorites = []) {
  const rows = new Map([[saved.savedKey, JSON.stringify({ version: 1, stops, favorites })]]);
  const storage = {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: key => rows.delete(key),
  };
  const store = new saved.SavedDataStore({ storage, withLock: async operation => operation() });
  const calls = [], notices = [], painted = [];
  const planner = Object.create(exports.TripPlanner.prototype);
  Object.assign(planner, {
    store, management: { hasPendingReview: false }, pendingDestination: null,
    notify: text => notices.push(text), routeInputKey: '', locationGeneration: 0, locating: false,
    render() {},
    routing: new RoutingController({
      onChange() {}, onRoute: route => painted.push(route),
      request: async body => {
        calls.push(body);
        return { available: false, mode: body.mode, code: 'no_route',
          source: { provider: 'valhalla', data: 'OpenStreetMap', url: 'https://www.openstreetmap.org/', attribution: 'OSM', data_updated_at: null } };
      },
    }),
  });
  store.subscribe(() => planner.syncRouting());
  return { planner, store, storage, calls, notices, painted };
}
const ids = planner => Array.from(planner.stops, stop => stop.id);

test('destination-first remains an unsaved draft with no origin or route until a distinct start is selected', async () => {
  const f = fixture();
  await f.planner.setDestination(place('finish', 3));
  assert.deepEqual(ids(f.planner), []);
  assert.equal(f.planner.hasUnsavedChanges, true);
  assert.equal(f.planner.isSaved, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.data.stops, []);
  await f.planner.setOrigin(place('start'));
  assert.deepEqual(ids(f.planner), ['start', 'finish']);
  assert.equal(f.planner.hasUnsavedChanges, false);
  assert.equal(f.planner.isSaved, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].stops, [{ lng: 126.4, lat: 33.4 }, { lng: 126.43, lat: 33.4 }]);
});

test('replacing a pending destination keeps only the latest draft; choosing it as the start does not invent a second point', async () => {
  const f = fixture();
  await f.planner.setDestination(place('old'));
  await f.planner.setDestination(place('latest', 2));
  await f.planner.setOrigin(place('latest', 2));
  assert.deepEqual(ids(f.planner), []);
  assert.equal(f.planner.hasUnsavedChanges, true);
  await f.planner.setOrigin(place('start'));
  assert.deepEqual(ids(f.planner), ['start', 'latest']);
});

test('legacy endpoint actions retain the previous boundaries as waypoints', async () => {
  const f = fixture([stop('a', 0), stop('via', 1), stop('b', 2)]);
  const originals = f.store.data.stops;
  await f.planner.setOrigin(place('new-start', 3));
  await f.planner.setDestination(place('new-finish', 4));
  assert.deepEqual(ids(f.planner), ['new-start', 'a', 'via', 'b', 'new-finish']);
  assert.deepEqual(f.store.data.stops.slice(1, 4), originals);
  await f.planner.setOrigin(f.planner.stops.at(-1));
  assert.deepEqual(ids(f.planner), ['new-finish', 'new-start', 'a', 'via', 'b']);
});

test('promoting an existing stop from a lightweight catalog result retains its saved source records and dwell', async () => {
  const f = fixture([stop('a', 0), stop('via', 1), stop('b', 2)]);
  const original = f.store.data.stops[1];
  const lightweight = place('via', 1);
  delete lightweight.sources;
  await f.planner.setOrigin(lightweight);
  assert.deepEqual(f.store.data.stops[0].sources, original.sources);
  assert.equal(f.store.data.stops[0].stay_min, original.stay_min);
  assert.deepEqual(ids(f.planner), ['via', 'a', 'b']);
});

test('explicit form edits replace only the chosen boundary and retain waypoint metadata', async () => {
  const f = fixture([stop('a', 0), stop('via1', 1), stop('via2', 2), stop('b', 3)]);
  const vias = f.store.data.stops.slice(1, -1);
  await f.planner.setEndpoint(place('c', 4), true, true);
  await f.planner.setEndpoint(place('d', 5), false, true);
  assert.deepEqual(ids(f.planner), ['c', 'via1', 'via2', 'd']);
  assert.deepEqual(f.store.data.stops.slice(1, -1), vias);
  await f.planner.setEndpoint(f.store.data.stops[1], true, true);
  assert.deepEqual(ids(f.planner), ['via1', 'via2', 'd']);
  assert.deepEqual(f.store.data.stops[0], vias[0]);
});

test('an explicit finish edit appends to a single start and rejects the same endpoint identity', async () => {
  const f = fixture([stop('start', 0)]);
  await f.planner.setEndpoint(place('finish', 2), false, true);
  assert.deepEqual(ids(f.planner), ['start', 'finish']);
  const before = f.store.data.stops;
  await f.planner.setEndpoint(place('finish', 2), true, true);
  assert.deepEqual(f.store.data.stops, before);
  await f.planner.setEndpoint(place('start'), false, true);
  assert.deepEqual(f.store.data.stops, before);
});

test('full reversal retains every stop and its dwell/source metadata and recalculates both real route modes', async () => {
  const f = fixture([stop('a', 0), stop('via1', 1), stop('via2', 2), stop('b', 3)]);
  const before = f.store.data.stops;
  assert.equal(typeof f.planner.reverseOrder, 'function');
  await f.planner.reverseOrder();
  assert.deepEqual(f.store.data.stops, [...before].reverse());
  assert.deepEqual(f.calls.map(call => call.mode).sort(), ['car', 'walk']);
  assert.deepEqual(f.calls[0].stops, before.map(({ lng, lat }) => ({ lng, lat })).reverse());
  assert.equal(f.painted[0], null);
});

test('the 12-stop bound rejects insertion but allows an explicit boundary replacement without dropping a waypoint', async () => {
  const f = fixture(Array.from({ length: 12 }, (_, i) => stop(String(i), i)));
  const before = f.store.data.stops;
  await f.planner.setOrigin(place('thirteenth', 12));
  await f.planner.setDestination(place('thirteenth', 12));
  await f.planner.add(place('thirteenth', 12));
  await f.planner.add(place('1', 1));
  assert.deepEqual(f.store.data.stops, before);
  await f.planner.setEndpoint(place('replacement', 12), false, true);
  assert.equal(f.store.data.stops.length, 12);
  assert.deepEqual(f.store.data.stops.slice(0, -1), before.slice(0, -1));
  assert.equal(f.store.data.stops.at(-1).id, 'replacement');
});

test('new endpoints and favorites strip proofs while the readonly favorites getter returns detached snapshots', async () => {
  const f = fixture();
  const native = { ...place('kakao:123', 2), source: 'Kakao Local', selection_token: 'private-selection-proof', csrf_token: 'private-csrf' };
  await f.planner.setDestination(native);
  await f.planner.setOrigin(place('start'));
  await f.planner.toggleFavorite(native);
  assert.doesNotMatch(f.store.export(), /selection_token|csrf_token|private-selection-proof|private-csrf/);
  const favorites = f.planner.favorites;
  assert.ok(Array.isArray(favorites));
  favorites[0].name = 'changed outside the planner';
  favorites.length = 0;
  assert.equal(f.planner.favorites.length, 1);
  assert.equal(f.planner.favorites[0].name, native.name);
});

test('invalid endpoint coordinates cannot change the plan or consume a pending destination', async () => {
  const f = fixture();
  await f.planner.setDestination(place('finish', 2));
  await f.planner.setOrigin({ ...place('outside'), lng: 0 });
  assert.deepEqual(ids(f.planner), []);
  assert.equal(f.planner.hasUnsavedChanges, true);
  assert.equal(f.calls.length, 0);
});

test('a failed storage write retains both endpoint coordinates in an exportable unsaved draft', async () => {
  const f = fixture();
  await f.planner.setDestination(place('finish', 2));
  f.storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  await f.planner.setOrigin(place('start'));
  assert.deepEqual(ids(f.planner), ['start', 'finish']);
  assert.equal(f.planner.hasUnsavedChanges, true);
  assert.equal(f.planner.isSaved, false);
  assert.equal(saved.previewImport(f.store.export()).data.stops.length, 2);
});
