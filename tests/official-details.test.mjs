import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Catalog } from '../server/catalog.mjs';
import { catalogPlaceInfo } from '../server/guide-facts.mjs';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';

let OfficialDetailsLoader;
let normalizeOfficialDetails, normalizeOfficialSnapshot, officialDetailsDiagnostic;
try {
  ({ OfficialDetailsLoader, normalizeOfficialDetails, normalizeOfficialSnapshot, officialDetailsDiagnostic } =
    await import('../server/official-details.mjs'));
}
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const NOW = Date.parse('2026-09-10T12:00:00Z');
const MEDIA = 'https://jeju-atlas.whchoi.net';
const PHOTO = {
  url: '/media/official/peak.jpg', thumb_url: '/media/official/peak-thumb.jpg',
  origin_url: 'https://tong.visitkorea.or.kr/cms/resource/peak.jpg',
  credit: '한국관광공사', license: 'KOGL-3', source: 'tourapi',
};
function record(extra = {}) {
  return {
    provider: 'tourapi', provider_id: '12345', locale: 'ko',
    source_url: 'https://korean.visitkorea.or.kr/detail/12345',
    fetched_at: '2026-09-10T10:00:00Z',
    title: '성산일출봉 공식 안내', address: '제주특별자치도 서귀포시 성산읍',
    phone: '064-123-4567', website: 'https://www.jeju.go.kr/hallasan/',
    latitude: 33.458, longitude: 126.942,
    overview: '바다와 분화구를 둘러볼 수 있는 명소입니다.',
    facts: [
      { key: 'hours', label_ko: '이용시간', label_en: 'Hours', value: '09:00–18:00' },
      { key: 'fees', label_ko: '이용요금', label_en: 'Fees', value: '성인 3,000원' },
    ],
    photos: [PHOTO], match: { method: 'name_distance', distance_m: 22.5 }, ...extra,
  };
}
const snapshot = (records = { 'seed:peak': [record()] }) => ({
  version: 1, generated_at: '2026-09-10T11:00:00Z', records,
});
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-official-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function loader(t, options) {
  assert.equal(typeof OfficialDetailsLoader, 'function', 'official snapshot loader must be implemented');
  const value = new OfficialDetailsLoader({ clock: () => NOW, mediaOrigin: MEDIA, ...options });
  t.after(() => value.close());
  return value;
}
async function sqlite(t, directory, options = {}) {
  const path = join(directory, 'catalog.sqlite');
  const child = spawn('python3', [fileURLToPath(new URL('./fixtures/catalog-fixture.py', import.meta.url)), path],
    { stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify(options));
  assert.equal((await once(child, 'exit'))[0], 0, errors);
  return path;
}

test('local official snapshot retains real multilingual details, source context and original-image restrictions', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'details.json');
  await writeFile(path, JSON.stringify(snapshot({
    'seed:peak': [record(), record({ locale: 'en', title: 'Seongsan Ilchulbong', photos: [] })],
  })));
  const details = loader(t, { localPath: path, s3Client: { send() { throw new Error('local mode must not use AWS'); } } });
  await details.init();
  assert.equal(details.status().status, 'ready');
  assert.equal(details.status().place_count, 1);
  assert.equal(details.status().record_count, 2);
  const result = details.get('seed:peak');
  assert.equal(result[0].title, '성산일출봉 공식 안내');
  assert.equal(result[1].locale, 'en');
  assert.equal(result[0].phone, '064-123-4567');
  assert.equal(result[0].facts[1].value, '성인 3,000원');
  assert.equal(result[0].source_url, 'https://korean.visitkorea.or.kr/detail/12345');
  assert.equal(result[0].photos[0].url, `${MEDIA}/media/official/peak.jpg`);
  assert.equal(result[0].photos[0].thumb_url, null);
  result[0].facts[0].value = 'mutated';
  assert.equal(details.get('seed:peak')[0].facts[0].value, '09:00–18:00');
  assert.deepEqual(details.get('unknown'), []);
  assert.deepEqual(await readdir(directory), ['details.json']);
});

test('TourAPI KO and VisitJeju KO/EN retain source-language facts with one merged photo', async t => {
  const directory = await temporary(t);
  const localPath = await sqlite(t, directory);
  const detailsPath = join(directory, 'details.json');
  const visitKo = record({
    provider: 'visitjeju', provider_id: 'CONT_123',
    source_url: 'https://www.visitjeju.net/kr/detail/view?contentsid=CONT_123',
    title: '성산일출봉 방문 안내',
  });
  const visitEn = {
    ...visitKo, locale: 'en', title: 'Seongsan Ilchulbong visitor information',
    source_url: 'https://www.visitjeju.net/en/detail/view?contentsid=CONT_123',
    facts: [
      { key: 'hours', label_ko: '이용시간', label_en: 'Hours', value: '09:00–18:00' },
      { key: 'fees', label_ko: '이용요금', label_en: 'Fees', value: 'Adults KRW 3,000' },
    ],
  };
  await writeFile(detailsPath, JSON.stringify(snapshot({
    'seed:peak': [record(), visitKo, visitEn, visitEn],
  })));
  const detailsLoader = loader(t, { localPath: detailsPath });
  const catalog = new Catalog({ localPath, detailsLoader, clock: () => NOW });
  t.after(() => catalog.close());
  await catalog.init();
  assert.equal(detailsLoader.status().record_count, 3);
  const place = catalog.detail('seed:peak');
  assert.deepEqual(place.official_details.map(row => [row.provider, row.provider_id, row.locale]), [
    ['tourapi', '12345', 'ko'], ['visitjeju', 'CONT_123', 'ko'], ['visitjeju', 'CONT_123', 'en'],
  ]);
  assert.equal(place.official_details[1].title, visitKo.title);
  assert.equal(place.official_details[2].title, visitEn.title);
  assert.equal(place.official_details[2].source_url, visitEn.source_url);
  assert.deepEqual(place.official_details.map(row => row.facts), [record().facts, visitKo.facts, visitEn.facts]);
  assert.equal(place.photos.length, 1);
  assert.equal(place.photos[0].thumb_url, null);
  assert.equal(place.name, '성산일출봉');
  const facts = catalogPlaceInfo(place);
  assert.equal(facts.official_details.length, 3);
  assert.deepEqual(facts.official_details.map(row => row.facts), [record().facts, visitKo.facts, visitEn.facts]);
  assert.ok(facts.official_details.every(row => row.photos.length === 0));
});

test('invalid snapshot envelopes, identities, timestamps and oversized fields never become usable details', async t => {
  const directory = await temporary(t);
  for (const [index, invalid] of [
    null, [], { ...snapshot(), version: 2 }, { ...snapshot(), records: [] },
    snapshot({ '../outside': [record()] }),
    snapshot({ '__proto__.polluted': [record()] }),
    snapshot({ 'seed:peak': [record({ provider: 'unknown' })] }),
    snapshot({ 'seed:peak': [record({ locale: 'fr' })] }),
    snapshot({ 'seed:peak': [record({ source_url: 'javascript:alert(1)' })] }),
    snapshot({ 'seed:peak': [record({ source_url: 'https://evil.example/claim-official' })] }),
    snapshot({ 'seed:peak': [record({ source_url: 'https://apis.data.go.kr/info?serviceKey=not-a-real-key' })] }),
    snapshot({ 'seed:peak': [record({ fetched_at: '2026-02-30T00:00:00Z' })] }),
    snapshot({ 'seed:peak': [record({ overview: 'x'.repeat(8001) })] }),
    snapshot({ 'seed:peak': [record({ facts: [{ key: 'fee', label_ko: '요금', label_en: 'Fee', value: 'x'.repeat(1001) }] })] }),
    snapshot({ 'seed:peak': [record({ match: { method: 'name', distance_m: -1 } })] }),
  ].entries()) {
    const path = join(directory, `invalid-${index}.json`);
    await writeFile(path, JSON.stringify(invalid));
    const details = loader(t, { localPath: path });
    await details.init();
    assert.equal(details.status().status, 'unavailable', String(index));
    assert.deepEqual(details.get('seed:peak'), []);
  }
  assert.equal({}.polluted, undefined);
});

test('unsafe links and noncommercial or uncredited photos are omitted while useful text remains', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'details.json');
  const bad = (index, changes) => ({
    ...PHOTO, url: `/media/invalid-${index}.jpg`,
    origin_url: `https://tong.visitkorea.or.kr/cms/resource/invalid-${index}.jpg`, ...changes,
  });
  await writeFile(path, JSON.stringify(snapshot({ 'seed:peak': [record({
    website: 'https://user:password@example.org/private',
    photos: [
      bad(0, { license: 'KOGL-2' }), bad(1, { license: 'KOGL-4' }),
      bad(2, { license: 'unknown' }), bad(3, { credit: '' }),
      bad(4, { url: '/media/%2e%2e/private.jpg' }),
      bad(5, { origin_url: 'javascript:alert(1)' }),
      bad(6, { url: 'http://127.0.0.1/private.jpg' }),
      bad(7, { url: `${MEDIA}/media/%2e%2e/private.jpg` }),
      bad(8, { url: `${MEDIA}/api/config` }),
      { ...PHOTO, license: 'KOGL-1' }, PHOTO, PHOTO,
    ],
  })] })));
  const details = loader(t, { localPath: path });
  await details.init();
  const result = details.get('seed:peak')[0];
  assert.equal(result.website, null);
  assert.equal(result.phone, '064-123-4567');
  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].license, 'KOGL-3');
  assert.equal(result.photos[0].thumb_url, null);
});

test('conditional S3 refresh is deduplicated, atomically keeps last-good data and survives restart offline', async t => {
  const directory = await temporary(t);
  let now = NOW;
  let mode = 'good';
  let calls = 0;
  const inputs = [];
  const client = {
    async send(command) {
      calls++;
      inputs.push(command.input);
      assert.equal(command.constructor.name, 'GetObjectCommand');
      if (mode === 'not-modified') throw Object.assign(new Error('304'), { name: 'NotModified' });
      if (mode === 'offline') throw new Error('private storage detail');
      const body = Buffer.from(mode === 'bad' ? '{"version":1,"records":' : JSON.stringify(snapshot({
        'seed:peak': [record({ phone: mode === 'updated' ? '064-999-9999' : '064-123-4567' })],
      })));
      return { Body: Readable.from([body]), ContentLength: body.length, ETag: mode === 'updated' ? '"two"' : '"one"' };
    },
  };
  const details = loader(t, { bucket: 'test-details', cacheDir: directory, clock: () => now, s3Client: client });
  await Promise.all([details.init(), details.init()]);
  assert.equal(calls, 1);
  assert.equal(inputs[0].Key, 'place-details/latest.json');
  await details.refreshIfNeeded();
  assert.equal(calls, 1);
  mode = 'not-modified'; now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(inputs.at(-1).IfNoneMatch, '"one"');
  assert.equal(details.status().stale, false);
  const cacheFiles = await readdir(directory);
  const good = await Promise.all(cacheFiles.map(file => readFile(join(directory, file))));
  mode = 'bad'; now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(details.status().stale, true);
  assert.equal(details.get('seed:peak')[0].phone, '064-123-4567');
  assert.deepEqual(await Promise.all(cacheFiles.map(file => readFile(join(directory, file)))), good);
  mode = 'updated'; now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(details.get('seed:peak')[0].phone, '064-999-9999');
  assert.equal(details.status().stale, false);
  assert.equal(inputs.at(-1).IfNoneMatch, '"one"', 'invalid snapshots must not advance the ETag');
  details.close();
  mode = 'offline';
  const restored = loader(t, { bucket: 'test-details', cacheDir: directory, s3Client: client });
  await restored.init();
  assert.equal(restored.status().status, 'ready');
  assert.equal(restored.status().stale, true);
  assert.equal(restored.get('seed:peak')[0].phone, '064-999-9999');
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.part')));
});

test('oversized S3 bodies and close during a refresh cannot replace the active snapshot', async t => {
  const directory = await temporary(t);
  const body = new PassThrough();
  let now = NOW;
  let mode = 'good';
  const details = loader(t, {
    bucket: 'test-details', cacheDir: directory, clock: () => now,
    s3Client: { async send() {
      if (mode === 'oversize') return { Body: Readable.from([Buffer.alloc(16 * 1024 * 1024 + 1)]), ETag: '"bad"' };
      if (mode === 'waiting') return { Body: body, ETag: '"waiting"' };
      return { Body: Readable.from([Buffer.from(JSON.stringify(snapshot()))]), ETag: '"one"' };
    } },
  });
  await details.init();
  mode = 'oversize'; now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(details.status().stale, true);
  assert.equal(details.get('seed:peak').length, 1);
  mode = 'waiting'; now += 600_000;
  const refreshing = details.refreshIfNeeded();
  await new Promise(resolve => setImmediate(resolve));
  details.close();
  await refreshing;
  assert.equal(body.destroyed, true);
  assert.equal(details.status().status, 'unavailable');
  assert.deepEqual(details.get('seed:peak'), []);
});

test('Catalog HTTP details expose official fields and deduplicated commercial photos without rewriting seed identity', async t => {
  const directory = await temporary(t);
  const localPath = await sqlite(t, directory, { extras: { 'seed:peak': {
    photos: [{ ...PHOTO, url: `${MEDIA}/media/official/peak.jpg`, license: 'KOGL-1' }],
    overview: '기존 보강 소개',
  } } });
  const detailsPath = join(directory, 'details.json');
  await writeFile(detailsPath, JSON.stringify(snapshot({ 'seed:peak': [record({ latitude: 33.4581, longitude: 126.9421 })] })));
  const detailsLoader = loader(t, { localPath: detailsPath });
  const catalog = new Catalog({ localPath, detailsLoader });
  await catalog.init();
  t.after(() => catalog.close());
  assert.equal(catalog.status().total, 9);
  assert.equal(catalog.status().official_details_status.record_count, 1);
  const result = catalog.detail('seed:peak');
  assert.equal(result.name, '성산일출봉');
  assert.equal(result.address, '시드 주소');
  assert.equal(result.summary, '시드 소개');
  assert.equal(result.overview, '기존 보강 소개');
  assert.equal(result.source, 'sample');
  assert.equal(result.lat, 33.458);
  assert.equal(result.lng, 126.942);
  assert.equal(result.official_details[0].latitude, 33.4581);
  assert.equal(result.field_evidence.name.state, 'unverified');
  assert.match(result.base_note, /검증되지/);
  assert.equal(result.official_details[0].phone, '064-123-4567');
  assert.equal(result.field_evidence['official_details.0'].state, 'source_reported');
  assert.equal(result.photos.length, 1);
  assert.equal(result.photos[0].license, 'KOGL-3');
  assert.equal(result.photos[0].thumb_url, null);
  await writeFile(join(directory, 'index.html'), '<title>official details</title>');
  const api = createApiHandler({ catalog, env: { NODE_ENV: 'test' } });
  const server = createAppServer({ root: directory, api });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/catalog/places/seed%3Apeak`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).official_details[0].facts[0].key, 'hours');
});

test('optional details failures do not break base catalog initialization, refresh or readiness', async t => {
  const directory = await temporary(t);
  const localPath = await sqlite(t, directory);
  const catalog = new Catalog({ localPath, detailsLoader: {
    async init() { throw new Error('optional init failure'); },
    async refreshIfNeeded() { throw new Error('optional refresh failure'); },
    get() { throw new Error('optional get failure'); },
    status: () => ({ status: 'unavailable', stale: true }),
    close() {},
  } });
  t.after(() => catalog.close());
  await catalog.init();
  await catalog.refreshIfNeeded();
  assert.equal(catalog.status().status, 'ready');
  assert.equal(catalog.status().stale, false);
  assert.equal(catalog.status().total, 9);
  assert.equal(catalog.detail('seed:peak').name, '성산일출봉');
  assert.deepEqual(catalog.detail('seed:peak').official_details, []);
  const api = createApiHandler({ catalog, env: { NODE_ENV: 'test' } });
  t.after(() => api.close());
  assert.equal(await api.ready(), true);
});

test('guide facts carry official contact, hours and fees with bounded source context, without copying pictures', () => {
  const official = record({
    overview: '소개'.repeat(4000),
    facts: [
      ...Array.from({ length: 20 }, (_, i) => ({ key: `extra_${i}`, label_ko: '추가', label_en: 'Extra', value: 'x'.repeat(1000) })),
      ...record().facts,
    ],
  });
  const facts = catalogPlaceInfo({
    id: 'seed:peak', name: '성산일출봉', source: 'sample', base_note: '공식 대조 검증 전',
    official_details: [official],
  });
  assert.equal(facts.official_details[0].overview.length, 512);
  assert.equal(facts.official_details[0].source_url, official.source_url);
  assert.equal(facts.official_details[0].phone, '064-123-4567');
  assert.ok(facts.official_details[0].facts.some(item => item.key === 'hours'));
  assert.ok(facts.official_details[0].facts.some(item => item.key === 'fees'));
  assert.ok(facts.official_details[0].facts.length <= 8);
  assert.ok(facts.official_details[0].facts.every(item => item.value.length <= 240));
  assert.deepEqual(facts.official_details[0].photos, []);
  assert.equal(facts.name, '성산일출봉');
  assert.equal(facts.base_note, '공식 대조 검증 전');
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) < 16 * 1024);
});

test('provider retrieval ages are computed from the injected clock without trusting supplied freshness flags', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'details.json');
  await writeFile(path, JSON.stringify(snapshot({ 'seed:peak': [
    record({ fetched_at: new Date(NOW - 15 * 86400_000).toISOString(), age_days: 0, stale: false }),
    record({ provider: 'visitjeju', provider_id: 'CONT_123', locale: 'en',
      source_url: 'https://www.visitjeju.net/en/detail/view?contentsid=CONT_123',
      fetched_at: new Date(NOW - 86400_000).toISOString(), stale: true }),
  ] })));
  let now = NOW;
  const details = loader(t, { localPath: path, clock: () => now });
  await details.init();
  const records = details.get('seed:peak');
  assert.equal(records[0].age_days, 15);
  assert.equal(records[0].stale, true);
  assert.equal(records[1].age_days, 1);
  assert.equal(records[1].stale, false);
  now += 14 * 86400_000;
  assert.equal(details.get('seed:peak')[1].stale, true);
});

test('credential query parameters cannot escape through source, website, photo or evidence URLs', async t => {
  const directory = await temporary(t);
  for (const parameter of ['apiKey', 'serviceKey', 'access_token', 'auth']) {
    const path = join(directory, `${parameter}.json`);
    const url = `https://korean.visitkorea.or.kr/detail?contentId=12345&${parameter}=dummy`;
    await writeFile(path, JSON.stringify(snapshot({ 'seed:peak': [record({ source_url: url })] })));
    const rejected = loader(t, { localPath: path });
    await rejected.init();
    assert.equal(rejected.status().status, 'unavailable', parameter);
    const info = catalogPlaceInfo({
      id: 'seed:peak', name: '성산일출봉',
      field_evidence: { hours_week: { state: 'source_reported', source: 'tourapi', observed_at: null, evidence_url: url } },
      official_details: [record({
        website: url, photos: [{ ...PHOTO, url }], facts: [
          { key: 'hours', label_ko: '계절별 이용시간', label_en: 'Seasonal hours', value: '여름 07:00–20:00\n겨울 09:00–18:00' },
        ],
      })],
    });
    assert.equal(info.field_evidence.hours_week.evidence_url, null);
    assert.equal(info.official_details[0].website, null);
    assert.deepEqual(info.official_details[0].photos, []);
    assert.equal(info.official_details[0].facts[0].value, '여름 07:00–20:00\n겨울 09:00–18:00');
    assert.equal(JSON.stringify(info).includes('=dummy'), false);
  }
});

test('standalone startup warms the optional details snapshot before serving the first place request', async t => {
  const directory = await temporary(t);
  const localPath = await sqlite(t, directory);
  await writeFile(join(directory, 'index.html'), '<title>Official startup</title>');
  const detailsPath = join(directory, 'details.json');
  await writeFile(detailsPath, JSON.stringify(snapshot()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/server.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', STATIC_ROOT: directory, HOST: '127.0.0.1', PORT: '0',
      CATALOG_LOCAL_PATH: localPath, DETAILS_LOCAL_PATH: detailsPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  });
  child.stderr.resume();
  const listening = new Promise(resolve => {
    let text = '';
    child.stdout.on('data', chunk => {
      text += chunk;
      for (const line of text.split('\n')) {
        try { const event = JSON.parse(line); if (event.event === 'listening') resolve(event); } catch {}
      }
    });
  });
  const address = await Promise.race([
    listening, exited.then(() => { throw new Error('Standalone server exited before readiness'); }),
  ]);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/catalog/places/seed%3Apeak`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).official_details[0].phone, '064-123-4567');
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status, 200);
});

test('record collection caps and compact guide facts keep a twelve-place response within its SSE frame budget', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'details.json');
  const photos = Array.from({ length: 12 }, (_, i) => ({
    ...PHOTO, url: `/media/${i}.jpg`, origin_url: `https://tong.visitkorea.or.kr/cms/resource/${i}.jpg`,
  }));
  const source = record({
    match: { method: 'exact name and distance', distance_m: null },
    facts: Array.from({ length: 45 }, (_, i) => ({ key: `key_${i}`, label_ko: '안내', label_en: 'Information', value: '가'.repeat(1000) })),
    overview: '가'.repeat(8000), photos,
  });
  await writeFile(path, JSON.stringify(snapshot({ 'seed:peak': [source] })));
  const details = loader(t, { localPath: path });
  await details.init();
  assert.equal(details.get('seed:peak')[0].facts.length, 40);
  assert.equal(details.get('seed:peak')[0].photos.length, 8);
  const { normalizeGuideMap } = await import('../server/guide.mjs');
  const places = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`, name: `장소 ${i}`, category: '관광지', lat: 33.4, lng: 126.5, source: 'sample',
    official_details: details.get('seed:peak'),
  }));
  const map = normalizeGuideMap({ answer: '실제 응답', markers: places }, { catalog: { detail: id => places.find(place => place.id === id) } });
  assert.equal(map.place_info.length, 12);
  assert.ok(map.place_info.every(place => JSON.stringify(place.official_details).length <= 8192));
  assert.ok(`event: map\ndata: ${JSON.stringify(map)}\n\n`.length < 512 * 1024);
});

test('standalone normalization identifies provider-source mismatches and text bounds without printing values', () => {
  assert.equal(typeof officialDetailsDiagnostic, 'function');
  const cases = [
    [record({ source_url: 'https://www.visitjeju.net/kr/detail/view?contentsid=PRIVATE_PROBE' }),
      { code: 'provider_domain_mismatch', field: 'source_url', record_index: 0 }],
    [record({ source_url: 'https://apis.data.go.kr/detail?serviceKey=PRIVATE_PROBE' }),
      { code: 'unsafe_url', field: 'source_url', record_index: 0 }],
    [record({ overview: 'PRIVATE_PROBE'.repeat(1000) }),
      { code: 'field_too_long', field: 'overview', limit: 8000, record_index: 0 }],
    [record({ facts: [{ key: 'hours', label_ko: '시간', label_en: 'Hours', value: 'PRIVATE_PROBE'.repeat(100) }] }),
      { code: 'field_too_long', field: 'facts[0].value', limit: 1000, record_index: 0 }],
  ];
  for (const [input, expected] of cases) {
    assert.throws(() => normalizeOfficialDetails([input], { now: NOW }), error => {
      assert.deepEqual(officialDetailsDiagnostic(error), expected);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(officialDetailsDiagnostic(error))}`, /PRIVATE_PROBE|https?:/);
      return true;
    });
  }
});

test('whole-snapshot normalization uses the loader rules and identifies a rejected place without exposing its ID', () => {
  assert.equal(typeof normalizeOfficialSnapshot, 'function');
  const input = snapshot({
    'seed:peak': [record()],
    'PRIVATE_PROBE': [record(), record({ locale: 'en', overview: 'x'.repeat(8001) })],
  });
  assert.throws(() => normalizeOfficialSnapshot(input, { now: NOW }), error => {
    assert.deepEqual(officialDetailsDiagnostic(error), {
      code: 'field_too_long', field: 'overview', limit: 8000, record_index: 1, place_index: 1,
    });
    assert.doesNotMatch(JSON.stringify(officialDetailsDiagnostic(error)), /PRIVATE_PROBE/);
    return true;
  });
  const valid = normalizeOfficialSnapshot(snapshot(), { now: NOW, mediaOrigin: MEDIA });
  assert.equal(valid.version, 1);
  assert.equal(valid.records['seed:peak'][0].phone, '064-123-4567');
  assert.equal(valid.records['seed:peak'][0].photos[0].thumb_url, null);
});

test('loader diagnostics identify an invalid refresh, retain last-good content, and clear after recovery', async t => {
  assert.equal(typeof officialDetailsDiagnostic, 'function');
  const directory = await temporary(t);
  const path = join(directory, 'details.json');
  await writeFile(path, JSON.stringify(snapshot()));
  let now = NOW;
  const details = loader(t, { localPath: path, clock: () => now });
  await details.init();
  assert.equal(details.status().last_error, null);
  await writeFile(path, JSON.stringify(snapshot({ 'seed:peak': [record({
    source_url: 'https://www.visitjeju.net/PRIVATE_PROBE',
  })] })));
  now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(details.status().status, 'ready');
  assert.equal(details.status().stale, true);
  assert.deepEqual(details.status().last_error, {
    code: 'provider_domain_mismatch', field: 'source_url', record_index: 0, place_index: 0,
  });
  assert.equal(details.get('seed:peak')[0].phone, '064-123-4567');
  assert.doesNotMatch(JSON.stringify(details.status()), /PRIVATE_PROBE/);
  await writeFile(path, '{"PRIVATE_PROBE": ');
  now += 600_000;
  await details.refreshIfNeeded();
  assert.deepEqual(details.status().last_error, { code: 'invalid_json', field: 'snapshot' });
  await writeFile(path, JSON.stringify(snapshot()));
  now += 600_000;
  await details.refreshIfNeeded();
  assert.equal(details.status().last_error, null);
  assert.equal(details.status().stale, false);
  assert.deepEqual(officialDetailsDiagnostic(new Error('PRIVATE_PROBE')), {
    code: 'details_unavailable', field: 'snapshot',
  });
});
