import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

let Catalog;
try {
  ({ Catalog } = await import('../server/catalog.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('/server/catalog.mjs')) throw error;
}

const fixtureScript = fileURLToPath(new URL('./fixtures/catalog-fixture.py', import.meta.url));
const NOW = Date.parse('2026-09-09T00:00:00Z');

async function fixture(t, options = {}) {
  assert.equal(typeof Catalog, 'function', 'Catalog backend must be implemented');
  const dir = await mkdtemp(join(tmpdir(), 'jeju-catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.sqlite');
  const result = spawnSync('python3', [fixtureScript, path], {
    input: JSON.stringify(options), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return { dir, path };
}

async function local(t, options = {}) {
  const files = await fixture(t, options);
  const catalog = new Catalog({ localPath: files.path, clock: () => NOW });
  t.after(() => catalog.close());
  await catalog.init();
  return { ...files, catalog };
}

function ids(result) {
  return result.items.map((item) => item.id);
}

function badQuery(fn) {
  assert.throws(fn, (error) => error.statusCode === 400);
}

test('local catalog opens without AWS and never modifies its SQLite file', async (t) => {
  const { path, dir } = await fixture(t);
  const before = await readFile(path);
  const info = await stat(path);
  const catalog = new Catalog({
    localPath: path, bucket: 'unused', cacheDir: join(dir, 'unused'),
    s3Client: { send() { throw new Error('Local mode must not call AWS'); } },
    clock: () => NOW,
  });
  t.after(() => catalog.close());
  await Promise.all([catalog.init(), catalog.init()]);
  await catalog.refreshIfNeeded();
  assert.equal(catalog.search({}).total, 9);
  assert.deepEqual(catalog.status(), {
    status: 'ready', total: 9, by_source: { OpenStreetMap: 8, sample: 1 },
    categories: [
      { id: '관광지', count: 2 }, { id: '맛집', count: 3 }, { id: '오름', count: 1 },
      { id: '카페', count: 2 }, { id: '해변', count: 1 },
    ],
    built_at: '2026-09-08T21:48:10+00:00', refreshed_at: '2026-09-09T00:00:00.000Z',
    stale: false,
    attribution: '장소 데이터 © OpenStreetMap contributors (ODbL) · 큐레이션 데이터 오마이제주',
    photos_count: 0, hours_week_count: 1,
  });
  catalog.close();
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await readdir(dir), ['fixture.sqlite']);
});

test('search finds one/two/three-character Korean, normalized names and tags', async (t) => {
  const { catalog } = await local(t);
  for (const q of ['성', '일출', '일출봉', '성산 일출봉', '성산일출봉'.normalize('NFD')]) {
    assert.deepEqual(ids(catalog.search({ q })), ['seed:peak'], q);
  }
  assert.deepEqual(ids(catalog.search({ q: '풍경' })), ['seed:peak']);
  assert.deepEqual(ids(catalog.search({ q: 'OCEAN' })), ['osm:cafe']);
  assert.equal(catalog.search({ q: '카페', category: '맛집' }).total, 0);
});

test('quoted input, wildcard characters, backslashes and SQL syntax are literal', async (t) => {
  const { catalog } = await local(t);
  for (const q of ['%', '_', '%_', '100%_', '"카페"']) {
    assert.deepEqual(ids(catalog.search({ q })), ['osm:literal'], q);
  }
  assert.deepEqual(ids(catalog.search({ q: '\\' })), ['osm:slash']);
  assert.equal(catalog.search({ q: "' OR 1=1 --" }).total, 0);
  assert.equal(catalog.search({ q: '" OR * NOT "' }).total, 0);
  assert.equal(catalog.detail("' OR 1=1 --"), null);
  assert.equal(catalog.search({}).total, 9);
});

test('search works with a catalog that has no FTS index', async (t) => {
  const { catalog } = await local(t, { no_fts: true });
  assert.deepEqual(ids(catalog.search({ q: '일출봉' })), ['seed:peak']);
});

test('browse pagination counts all matches and applies a stable category filter', async (t) => {
  const { catalog } = await local(t);
  const all = catalog.search({});
  const page = catalog.search({ limit: '2', offset: '2' });
  assert.equal(page.total, 9);
  assert.equal(page.has_more, true);
  assert.deepEqual(ids(page), ids(all).slice(2, 4));
  const tail = catalog.search({ limit: 2, offset: 8 });
  assert.equal(tail.items.length, 1);
  assert.equal(tail.has_more, false);
  assert.deepEqual(catalog.search({ offset: 20000 }), { items: [], total: 9, has_more: false });
  assert.equal(catalog.search({ category: '카페' }).total, 2);
  assert.ok(all.items.every((item) => item.distance_m === null));
});

test('radius uses exact unrounded distances before filtering, sorting and pagination', async (t) => {
  const { catalog } = await local(t);
  const query = { lat: 33.45, lng: 126.5, radius_m: 1000 };
  const all = catalog.search(query);
  assert.deepEqual(ids(all), ['osm:cafe', 'osm:literal', 'osm:near']);
  assert.equal(all.total, 3);
  assert.equal(all.items[0].distance_m, 0);
  assert.ok(all.items[2].distance_m >= 444 && all.items[2].distance_m <= 446);
  const page = catalog.search({ ...query, limit: 1, offset: 2 });
  assert.deepEqual(ids(page), ['osm:near']);
  assert.equal(page.total, 3);
  assert.equal(page.has_more, false);
  // This point is just over 1000 m, but its rounded distance is 1000 m.
  assert.ok(!ids(all).includes('osm:edge'));
  assert.equal(catalog.search({ lat: 33.45, lng: 126.5 }).total, 9);
});

test('invalid query shapes, limits, categories and coordinates fail with HTTP 400', async (t) => {
  const { catalog } = await local(t);
  for (const query of [
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 'abc' }, { limit: true },
    { offset: -1 }, { offset: 20001 }, { offset: 0.5 }, { offset: Infinity },
    { q: {} }, { q: 'a'.repeat(201) }, { category: "카페' OR 1=1" }, { category: [] },
    { lat: 33.45 }, { lng: 126.5 }, { lat: 33, lng: 126.5 },
    { lat: 33.61, lng: 126.5 }, { lat: 33.45, lng: 126.14 },
    { lat: 33.45, lng: 126.99 }, { lat: NaN, lng: 126.5 },
    { radius_m: 1000 }, { lat: 33.45, lng: 126.5, radius_m: 99 },
    { lat: 33.45, lng: 126.5, radius_m: 50001 },
    { lat: 33.45, lng: 126.5, radius_m: 'NaN' },
    [], null,
  ]) badQuery(() => catalog.search(query));
  assert.equal(catalog.search({ limit: 100, offset: 0 }).total, 9);
  assert.ok(catalog.search({ lat: 33.1, lng: 126.15, radius_m: 100 }).total > 0);
});

test('map points retain all sources, use compact GeoJSON and clamp bounding boxes', async (t) => {
  const { catalog } = await local(t);
  const all = catalog.points({});
  assert.equal(all.type, 'FeatureCollection');
  assert.equal(all.features.length, 9);
  const seed = all.features.find((feature) => feature.properties.id === 'seed:peak');
  assert.equal(seed.type, 'Feature');
  assert.deepEqual(seed.geometry, { type: 'Point', coordinates: [126.942, 33.458] });
  assert.deepEqual(seed.properties, {
    id: 'seed:peak', name: '성산일출봉', category: '관광지', source_label: '큐레이션 원자료',
  });
  assert.equal(catalog.points({ bbox: '120,30,130,40' }).features.length, 9);
  assert.equal(catalog.points({ bbox: [126.4, 33.44, 126.6, 33.46], category: '카페' }).features.length, 2);
  assert.equal(catalog.points({ bbox: '127,34,128,35' }).features.length, 0);
  for (const bbox of ['x,33,127,34', '127,34,126,33', '126,33,127', [126, 33, Infinity, 34], {}, '']) {
    badQuery(() => catalog.points({ bbox }));
  }
  badQuery(() => catalog.points({ category: 'imaginary' }));
});

test('seed base provenance remains separate from official extras and registration state', async (t) => {
  const { catalog } = await local(t);
  const seed = catalog.detail('seed:peak');
  assert.equal(seed.source, 'sample');
  assert.equal(seed.source_label, '큐레이션 원자료');
  assert.match(seed.base_note, /좌표.*주소/);
  assert.match(seed.base_note, /검증되지/);
  assert.equal(seed.summary, '시드 소개');
  assert.equal(seed.address, '시드 주소');
  assert.equal(seed.overview, '공식 보강 소개');
  assert.equal(seed.phone, null, 'do not parse a phone out of a source note');
  assert.equal(seed.hours, null, 'do not promote weekly hours into a base field');
  assert.deepEqual(seed.hours_week, [{ day: 0, open: '09:00', close: '24:00' }]);
  assert.equal(seed.hours_source, 'tourapi_usetime');
  assert.equal(seed.sources[1].observed_at, '2026-09-08T21:46:33+00:00');
  assert.equal(seed.sources[0].observed_at, null);
  assert.equal(seed.business_status, 'open');
  assert.equal('open_now' in seed, false);
  assert.equal(seed.enriched_at, '2026-09-08T21:48:08+00:00');
  assert.deepEqual(seed.menu, [{ name: '입장권', price_krw: null, source: 'tourapi' }]);
  const osm = catalog.detail('osm:cafe');
  assert.equal(osm.source_label, 'OpenStreetMap');
  assert.equal(osm.base_note, null);
  assert.equal(osm.phone, '064-000-0000');
  assert.equal(osm.hours, 'Mo-Su 09:00-18:00');
  assert.match(catalog.status().attribution, /OpenStreetMap.*ODbL/);
});

test('missing enrichment stays null or empty without fabricated descriptions or hours', async (t) => {
  for (const options of [{}, { no_extra_table: true }]) {
    const { catalog } = await local(t, options);
    const place = catalog.detail('osm:north');
    assert.equal(place.summary, '');
    for (const field of ['name_en', 'address', 'phone', 'hours', 'url', 'region', 'avg_stay_min',
      'hours_source', 'overview', 'business_status', 'tips', 'enriched_at']) {
      assert.equal(place[field], null, field);
    }
    for (const field of ['photos', 'hours_week', 'menu', 'sources']) assert.deepEqual(place[field], [], field);
    assert.deepEqual(place.facilities, {});
    assert.equal(catalog.detail('does-not-exist'), null);
  }
});

test('photos preserve credited originals, drop KOGL 3/4 thumbnails and reject unsafe or unlicensed URLs', async (t) => {
  const { catalog } = await local(t, { extras: { 'osm:cafe': { photos: [
    { url: '/media/original.jpg', thumb_url: '/media/thumb.webp', origin_url: 'https://example.org/original.jpg',
      credit: '한국관광공사', license: 'KOGL-3', source: 'tourapi' },
    { url: 'https://example.org/four.jpg', thumb_url: 'https://example.org/four-thumb.jpg',
      credit: '작가', license: 'KOGL-4', source: 'tourapi' },
    { url: '/media/allowed.jpg', thumb_url: '/media/allowed-thumb.webp', origin_url: 'https://example.org/allowed.jpg',
      credit: '사진가', license: 'CC-BY-4.0', source: 'commons' },
    { url: 'javascript:alert(1)', credit: '작가', license: 'KOGL-1', source: 'tourapi' },
    { url: 'data:image/png;base64,aaaa', credit: '작가', license: 'KOGL-1', source: 'tourapi' },
    { url: '//evil.example/a.jpg', credit: '작가', license: 'KOGL-1', source: 'tourapi' },
    { url: 'https://example.org/unknown.jpg', credit: '작가', license: 'unknown', source: 'tourapi' },
    { url: 'https://example.org/uncredited.jpg', credit: '', license: 'KOGL-1', source: 'tourapi' },
    { url: '/media/../not-media.jpg', credit: '작가', license: 'KOGL-1', source: 'tourapi' },
  ] } } });
  assert.deepEqual(catalog.detail('osm:cafe').photos, [
    { url: 'https://ohmyjeju.whchoi.net/media/original.jpg', thumb_url: null,
      origin_url: 'https://example.org/original.jpg', credit: '한국관광공사', license: 'KOGL-3', source: 'tourapi' },
    { url: 'https://example.org/four.jpg', thumb_url: null, origin_url: null,
      credit: '작가', license: 'KOGL-4', source: 'tourapi' },
    { url: 'https://ohmyjeju.whchoi.net/media/allowed.jpg',
      thumb_url: 'https://ohmyjeju.whchoi.net/media/allowed-thumb.webp',
      origin_url: 'https://example.org/allowed.jpg', credit: '사진가', license: 'CC-BY-4.0', source: 'commons' },
  ]);
});

test('invalid, empty, incomplete or inconsistent snapshots never become an empty ready catalog', async (t) => {
  for (const options of [
    { empty: true }, { meta: { count: '999' } }, { meta: { schema_version: '99' } },
    { drop_column: 'phone' },
  ]) {
    const { path } = await fixture(t, options);
    const catalog = new Catalog({ localPath: path });
    t.after(() => catalog.close());
    await assert.rejects(catalog.init(), (error) => error.statusCode === 503);
    assert.equal(catalog.status().status, 'unavailable');
    assert.throws(() => catalog.search({}), (error) => error.statusCode === 503);
  }
  const { dir } = await fixture(t);
  const broken = join(dir, 'broken.sqlite');
  await writeFile(broken, 'not sqlite');
  const catalog = new Catalog({ localPath: broken });
  t.after(() => catalog.close());
  await assert.rejects(catalog.init(), (error) => error.statusCode === 503);
});

test('S3 refresh is conditional and deduplicated, atomically swaps valid files and retains stale data', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, { append: [
    { id: 'osm:new', name: '새 장소', category: '관광지', lat: 33.4, lng: 126.4, tags: [] },
  ] });
  const bytes1 = await readFile(first.path);
  const bytes2 = await readFile(second.path);
  const cacheDir = join(first.dir, 'cache');
  let now = NOW;
  let calls = 0;
  let release;
  let fail = false;
  const s3Client = {
    async send(command) {
      calls++;
      assert.equal(command.constructor.name, 'GetObjectCommand');
      assert.equal(command.input.Bucket, 'fixture-bucket');
      assert.equal(command.input.Key, 'catalog/catalog.sqlite');
      if (calls === 1) {
        assert.equal(command.input.IfNoneMatch, undefined);
        return { Body: Readable.from([bytes1]), ETag: '"v1"', ContentLength: bytes1.length };
      }
      assert.equal(command.input.IfNoneMatch, calls <= 3 ? '"v1"' : '"v2"');
      if (calls === 2) throw Object.assign(new Error('Not Modified'), { $metadata: { httpStatusCode: 304 } });
      if (calls === 3) {
        await new Promise((resolve) => { release = resolve; });
        return { Body: Readable.from([bytes2]), ETag: '"v2"', ContentLength: bytes2.length };
      }
      if (fail) throw new Error('transient S3 outage');
      return { Body: Readable.from([Buffer.from('bad sqlite')]), ETag: '"invalid"' };
    },
  };
  const catalog = new Catalog({ bucket: 'fixture-bucket', cacheDir, s3Client, clock: () => now });
  t.after(() => catalog.close());
  await Promise.all([catalog.init(), catalog.init()]);
  assert.equal(calls, 1);
  now += 599999;
  await catalog.refreshIfNeeded();
  assert.equal(calls, 1);
  now++;
  await catalog.refreshIfNeeded();
  assert.equal(calls, 2);
  assert.equal(catalog.status().stale, false);
  now += 600000;
  const pending = catalog.refreshIfNeeded();
  const duplicate = catalog.refreshIfNeeded();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catalog.search({}).total, 9, 'old database serves throughout the pending download');
  release();
  await Promise.all([pending, duplicate]);
  assert.equal(calls, 3);
  assert.equal(catalog.search({}).total, 10);
  assert.equal(catalog.detail('osm:new').name, '새 장소');
  const successfulAt = catalog.status().refreshed_at;
  now += 600000;
  await catalog.refreshIfNeeded();
  assert.equal(catalog.search({}).total, 10);
  assert.equal(catalog.status().stale, true);
  assert.equal(catalog.status().refreshed_at, successfulAt);
  fail = true;
  now += 600000;
  await catalog.refreshIfNeeded();
  assert.equal(catalog.status().stale, true);
  assert.equal(catalog.search({}).total, 10);
  assert.ok((await readdir(cacheDir)).every((name) => !name.includes('.part')));
  catalog.close();
  const restored = new Catalog({ bucket: 'fixture-bucket', cacheDir,
    s3Client: { async send() { throw new Error('still offline'); } }, clock: () => now });
  t.after(() => restored.close());
  await restored.init();
  assert.equal(restored.search({}).total, 10);
  assert.equal(restored.status().stale, true);
});

test('an oversized streamed download is discarded and never replaces the last valid file', async (t) => {
  const { path, dir } = await fixture(t);
  const bytes = await readFile(path);
  let now = NOW;
  let request = 0;
  let streamClosed = false;
  const s3Client = { async send() {
    if (++request === 1) return { Body: Readable.from([bytes]), ETag: '"ok"' };
    return { Body: Readable.from((async function* () {
      try {
        for (let i = 0; i < 33; i++) yield Buffer.alloc(1024 * 1024);
      } finally {
        streamClosed = true;
      }
    })()), ETag: '"oversized"' };
  } };
  const cacheDir = join(dir, 'cache');
  const catalog = new Catalog({ bucket: 'fixture-bucket', cacheDir, s3Client, clock: () => now });
  t.after(() => catalog.close());
  await catalog.init();
  now += 600000;
  await catalog.refreshIfNeeded();
  assert.equal(catalog.search({}).total, 9);
  assert.equal(catalog.status().stale, true);
  assert.equal(streamClosed, true);
  assert.ok((await readdir(cacheDir)).every((name) => !name.includes('.part')));
});

test('startup without a valid snapshot fails explicitly and recovers on a later refresh', async (t) => {
  const { path, dir } = await fixture(t);
  const bytes = await readFile(path);
  let now = NOW;
  let offline = true;
  const catalog = new Catalog({
    bucket: 'fixture-bucket', cacheDir: join(dir, 'cache'), clock: () => now,
    s3Client: { async send() {
      if (offline) throw new Error('S3 unavailable');
      return { Body: Readable.from([bytes]), ETag: '"recovered"' };
    } },
  });
  t.after(() => catalog.close());
  await assert.rejects(catalog.init(), (error) => error.statusCode === 503);
  assert.equal(catalog.status().status, 'unavailable');
  assert.throws(() => catalog.points({}), (error) => error.statusCode === 503);
  assert.throws(() => catalog.detail('seed:peak'), (error) => error.statusCode === 503);
  offline = false;
  now += 600000;
  await catalog.refreshIfNeeded();
  assert.equal(catalog.search({}).total, 9);
  assert.equal(catalog.status().stale, false);
});

test('close during a streaming refresh aborts it without reopening the database or retaining partial files', async (t) => {
  const { path, dir } = await fixture(t);
  const bytes = await readFile(path);
  let now = NOW;
  let calls = 0;
  let started;
  let release;
  const streaming = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const cacheDir = join(dir, 'cache');
  const catalog = new Catalog({
    bucket: 'fixture-bucket', cacheDir, clock: () => now,
    s3Client: { async send() {
      if (++calls === 1) return { Body: Readable.from([bytes]), ETag: '"v1"' };
      return { Body: Readable.from((async function* () {
        yield bytes.subarray(0, 1024);
        started();
        await gate;
        yield bytes.subarray(1024);
      })()), ETag: '"v2"' };
    } },
  });
  t.after(() => catalog.close());
  await catalog.init();
  now += 600000;
  const pending = catalog.refreshIfNeeded();
  const rejected = assert.rejects(pending, (error) => error.statusCode === 503);
  await streaming;
  assert.equal(catalog.search({}).total, 9);
  catalog.close();
  release();
  await rejected;
  assert.equal(catalog.status().status, 'unavailable');
  assert.throws(() => catalog.search({}), (error) => error.statusCode === 503);
  assert.ok((await readdir(cacheDir)).every((name) => !name.includes('.part')));
  assert.doesNotThrow(() => catalog.close());
});

test('map point cap rejects an oversized response instead of silently truncating the catalog', async (t) => {
  const { catalog } = await local(t, {
    no_fts: true,
    append: Array.from({ length: 19992 }, (_, index) => ({
      id: `osm:bulk-${index}`, name: `장소 ${index}`, category: '관광지',
      lat: 33.4, lng: 126.4, tags: [],
    })),
  });
  assert.equal(catalog.status().total, 20001);
  assert.throws(() => catalog.points({}), (error) => error.statusCode === 503);
  assert.equal(catalog.points({ category: '카페' }).features.length, 2);
  assert.equal(catalog.search({ limit: 100 }).items.length, 100);
});

test('malformed enrichment values cannot leak unsafe links or violate nullable API fields', async (t) => {
  const { catalog } = await local(t, { extras: { 'osm:cafe': {
    photos: { url: 'https://example.org/not-an-array.jpg' },
    hours_week: [{ day: 8, open: '09:00', close: '18:00' }, { day: 1, open: '09:00' }],
    facilities: { parking: 'unknown', wifi: true, ignored: null },
    menu: [{ name: '정식', price_krw: 'not a price' }, { price_krw: 10000 }],
    sources: [{ source: 'tourapi', url: 'javascript:alert(1)', license: 'KOGL-1',
      observed_at: '2025-12-15 16:15:28' }, null],
    tips: { note: '원문 팁', observed_at: null },
  } } });
  const detail = catalog.detail('osm:cafe');
  assert.deepEqual(detail.photos, []);
  assert.deepEqual(detail.hours_week, []);
  assert.deepEqual(detail.facilities, { parking: 'unknown' });
  assert.deepEqual(detail.menu, [{ name: '정식', price_krw: null, source: null }]);
  assert.deepEqual(detail.sources, [
    { source: 'tourapi', url: null, observed_at: '2025-12-15 16:15:28', license: 'KOGL-1' },
  ]);
  assert.deepEqual(detail.tips, { note: '원문 팁', observed_at: null });
});
