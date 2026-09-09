import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createAppServer } from '../server/server.mjs';

let apiModule;
try {
  apiModule = await import('../server/api.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const secret = 'api-test-secret-with-at-least-32-bytes';
const place = {
  id: 'osm:node/8441493336', name: '테스트 장소', name_en: null,
  category: '카페', lat: 33.45, lng: 126.55, address: null, summary: '테스트 소개',
  tags: [], source: 'osm', source_label: 'OpenStreetMap', base_note: null,
  updated_at: null, region: null, avg_stay_min: null, url: null, phone: null,
  hours: null, distance_m: null,
};
const status = {
  status: 'ready', total: 1, by_source: { osm: 1 },
  categories: [{ id: '카페', count: 1 }], built_at: null, refreshed_at: null,
  stale: false, attribution: '© OpenStreetMap contributors · ODbL',
  photos_count: 0, hours_week_count: 0,
};

function catalogFixture() {
  const calls = [];
  return {
    calls,
    async refreshIfNeeded() {},
    status: () => status,
    search(options) {
      calls.push(['search', options]);
      return { items: [place], total: 1, has_more: false };
    },
    points(options) {
      calls.push(['points', options]);
      return {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', geometry: { type: 'Point', coordinates: [126.55, 33.45] },
          properties: { id: place.id, name: place.name, category: place.category },
        }],
      };
    },
    detail(id) {
      calls.push(['detail', id]);
      return id === place.id ? {
        ...place, photos: [], hours_week: [], hours_source: null, facilities: {},
        overview: null, menu: [], business_status: null, tips: null, sources: [],
        enriched_at: null,
      } : null;
    },
  };
}

async function fixture(t, options = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'atlas-api-'));
  const root = join(temp, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<title>제주</title>');
  await writeFile(join(root, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  await writeFile(join(root, 'manifest.webmanifest'), '{"name":"제주"}');
  await writeFile(join(root, 'assets', 'app-abc.js'), 'export {};');
  await writeFile(join(temp, 'private.txt'), 'private-outside-root');
  await symlink(join(temp, 'private.txt'), join(root, 'link.txt'));
  let api = options.api;
  const catalog = options.catalog ?? catalogFixture();
  if (!api) {
    assert.equal(typeof apiModule?.createApiHandler, 'function', 'API handler must be implemented');
    api = apiModule.createApiHandler({
      catalog, release: 'api-test', env: { NODE_ENV: 'test' }, secret,
      publicOrigin: 'http://localhost:5173', ...options,
    });
  }
  const server = createAppServer({ root, release: 'api-test', api });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  const get = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let bytes = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
        resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString() });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  return { get, server, catalog, root };
}

test('API dispatch happens after path validation and before the static method gate', async (t) => {
  const paths = [];
  const { get } = await fixture(t, {
    api(req, res, url) {
      paths.push(url.pathname);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"accepted":true}');
    },
  });
  assert.equal((await get('/api/echo', { method: 'POST', body: '{}' })).status, 201);
  for (const path of ['/api/%2e%2e/private.txt', '/api/%2e%2e%2fprivate.txt', '/api/%00', '/api/%ZZ']) {
    const response = await get(path, { method: 'POST' });
    assert.ok([400, 403].includes(response.status), path);
    assert.doesNotMatch(response.body, /private-outside-root/);
  }
  assert.deepEqual(paths, ['/api/echo']);
  assert.equal((await get('/', { method: 'POST' })).status, 405);
});

test('config verifies secure host-only sessions without exposing runtime settings', async (t) => {
  const { get } = await fixture(t);
  const first = await get('/api/config');
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), {
    version: 'api-test',
    features: { catalog: true, guide: false, planner: true, pwa: true },
    guide: { daily_limit: 30 },
  });
  assert.equal(first.headers['cache-control'], 'no-store');
  const setCookie = first.headers['set-cookie'][0];
  for (const pattern of [/^atlas_sid=/, /; HttpOnly/i, /; Secure/i, /; SameSite=Lax/i, /; Path=\//]) {
    assert.match(setCookie, pattern);
  }
  assert.doesNotMatch(setCookie, /; Domain=/i);
  assert.doesNotMatch(first.body, /arn:|secret|runtime|quota_table/i);
  const cookie = setCookie.split(';')[0];
  const verified = await get('/api/config', { headers: { cookie } });
  assert.equal(verified.headers['set-cookie'], undefined);
  const forged = await get('/api/config', { headers: { cookie: `${cookie}x` } });
  assert.notEqual(forged.headers['set-cookie'][0].split(';')[0], cookie);
});

test('catalog routes preserve canonical data and encoded slash IDs without setting cookies', async (t) => {
  const { get, catalog } = await fixture(t);
  const response = await get('/api/catalog/search?q=%EC%B9%B4%ED%8E%98&category=%EC%B9%B4%ED%8E%98&lat=33.45&lng=126.55&radius_m=5000&limit=20&offset=0');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { items: [place], total: 1, has_more: false });
  assert.deepEqual(catalog.calls[0], ['search', {
    q: '카페', category: '카페', lat: 33.45, lng: 126.55,
    radius_m: 5000, limit: 20, offset: 0,
  }]);
  const detail = await get(`/api/catalog/places/${encodeURIComponent(place.id)}`);
  assert.equal(detail.status, 200);
  assert.equal(JSON.parse(detail.body).id, place.id);
  assert.deepEqual(catalog.calls.at(-1), ['detail', place.id]);
  const points = await get('/api/catalog/points?bbox=126.15,33.1,126.98,33.6');
  assert.equal(JSON.parse(points.body).type, 'FeatureCollection');
  assert.deepEqual(catalog.calls.at(-1), ['points', { bbox: [126.15, 33.1, 126.98, 33.6] }]);
  const health = await get('/api/catalog/status');
  assert.deepEqual(JSON.parse(health.body), status);
  for (const result of [response, detail, points, health]) {
    assert.equal(result.headers['cache-control'], 'public, max-age=60');
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.equal((await get('/api/catalog/places/missing')).status, 404);
});

test('invalid catalog query bounds are rejected before accessing the catalog', async (t) => {
  const { get, catalog } = await fixture(t);
  for (const query of [
    'lat=33.4', 'lat=0&lng=126.5', 'lat=33.4&lng=NaN',
    'lat=33.4&lng=126.5&radius_m=-1', 'radius_m=100',
    'limit=10001', 'limit=1.5', 'limit=', 'offset=-1', 'offset=1000001',
    'q=a&q=b', `q=${'a'.repeat(201)}`, `category=${'a'.repeat(81)}`,
  ]) {
    const response = await get(`/api/catalog/search?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const bbox of ['126,33,127,34', '126.9,33.1,126.2,33.5', '126.2,33.1,126.8', 'NaN,33.1,126.8,33.5']) {
    assert.equal((await get(`/api/catalog/points?bbox=${bbox}`)).status, 400, bbox);
  }
  assert.deepEqual(catalog.calls, []);
});

test('large public JSON can be gzipped, while gzip q=0 and identity stay uncompressed', async (t) => {
  const catalog = catalogFixture();
  catalog.points = () => ({
    type: 'FeatureCollection',
    features: Array.from({ length: 100 }, (_, i) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [126.55, 33.45] },
      properties: { id: `p${i}`, name: '제주의 장소', category: '카페' },
    })),
  });
  const { get } = await fixture(t, { catalog });
  const compressed = await get('/api/catalog/points', { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.match(compressed.headers.vary, /Accept-Encoding/i);
  assert.equal(JSON.parse(compressed.body).features.length, 100);
  assert.equal(compressed.headers['set-cookie'], undefined);
  for (const accepted of ['gzip;q=0, *;q=1', 'identity']) {
    const response = await get('/api/catalog/points', { headers: { 'accept-encoding': accepted } });
    assert.equal(response.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(response.body), JSON.parse(compressed.body));
  }
});

test('API errors and static PWA responses keep their independent cache and security policies', async (t) => {
  const { get } = await fixture(t);
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers['cache-control'], 'no-cache');
  assert.match(sw.headers['content-type'], /javascript/);
  const manifest = await get('/manifest.webmanifest');
  assert.match(manifest.headers['content-type'], /^application\/manifest\+json/);
  assert.equal((await get('/assets/app-abc.js', { method: 'HEAD' })).body, '');
  for (const path of ['/link.txt', '/%2e%2e/private.txt', '/.env']) {
    const response = await get(path);
    assert.ok([400, 403, 404].includes(response.status));
    assert.doesNotMatch(response.body, /private-outside-root/);
  }
  const unknown = await get('/api/missing');
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers['content-type'], /application\/json/);
  assert.equal(unknown.headers['cache-control'], 'no-store');
  assert.equal(unknown.headers['set-cookie'], undefined);
  assert.equal((await get('/api/catalog/status', { method: 'POST' })).status, 405);
});

test('real SQLite catalog HTTP routes preserve pagination, enrichment, slash IDs, and query errors', async (t) => {
  const { Catalog } = await import('../server/catalog.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'atlas-api-sqlite-'));
  const localPath = join(dir, 'catalog.sqlite');
  const script = fileURLToPath(new URL('./fixtures/catalog-fixture.py', import.meta.url));
  const child = spawn('python3', [script, localPath], { stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  child.stdin.end(JSON.stringify({
    append: [{
      id: 'osm:node/8441493336', name: '슬래시 카페', category: '카페',
      lat: 33.45, lng: 126.5, tags: ['커피'], source: 'OpenStreetMap',
    }],
  }));
  assert.equal((await once(child, 'exit'))[0], 0, diagnostics);
  const catalog = new Catalog({ localPath });
  await catalog.init();
  t.after(async () => { catalog.close(); await rm(dir, { recursive: true, force: true }); });
  const { get } = await fixture(t, { catalog });
  const full = JSON.parse((await get('/api/catalog/status')).body);
  assert.equal(full.total, 10);
  assert.deepEqual(full.by_source, { OpenStreetMap: 9, sample: 1 });
  const search = JSON.parse((await get('/api/catalog/search?lat=33.45&lng=126.5&radius_m=1000&limit=1&offset=2')).body);
  assert.equal(search.total, 4);
  assert.equal(search.items.length, 1);
  assert.equal(search.has_more, true);
  assert.ok(search.items[0].distance_m >= 0);
  const seed = JSON.parse((await get('/api/catalog/places/seed%3Apeak')).body);
  assert.equal(seed.name, '성산일출봉');
  assert.equal(seed.source, 'sample');
  assert.match(seed.base_note, /검증/);
  assert.equal(seed.overview, '공식 보강 소개');
  assert.equal(seed.hours_source, 'tourapi_usetime');
  assert.equal(seed.business_status, 'open');
  assert.ok(seed.sources.some((source) => source.source === 'tourapi' && source.license === 'KOGL-1'));
  const encoded = await get('/api/catalog/places/osm%3Anode%2F8441493336');
  assert.equal(JSON.parse(encoded.body).name, '슬래시 카페');
  assert.equal((await get('/api/catalog/places/missing')).status, 404);
  const points = JSON.parse((await get('/api/catalog/points')).body);
  assert.equal(points.features.length, 10);
  for (const query of ['category=imaginary', 'offset=20001', 'lat=33.45&lng=126.5&radius_m=99', 'lat=33.45&lng=126.5&radius_m=50001']) {
    const invalid = await get(`/api/catalog/search?${query}`);
    assert.equal(invalid.status, 400, query);
    assert.equal(invalid.headers['cache-control'], 'no-store');
    assert.doesNotMatch(invalid.body, /SQLITE|SELECT|Unknown catalog category/);
  }
  assert.equal((await get('/api/catalog/points?category=imaginary')).status, 400);
});

test('standalone entry initializes a configured SQLite catalog before accepting requests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-entry-'));
  const root = join(dir, 'dist');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<title>standalone</title>');
  const localPath = join(dir, 'catalog.sqlite');
  const script = fileURLToPath(new URL('./fixtures/catalog-fixture.py', import.meta.url));
  const builder = spawn('python3', [script, localPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buildErrors = '';
  builder.stderr.on('data', (chunk) => { buildErrors += chunk; });
  assert.equal((await once(builder, 'exit'))[0], 0, buildErrors);
  const entry = fileURLToPath(new URL('../server/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', STATIC_ROOT: root,
      HOST: '127.0.0.1', PORT: '0', RELEASE: 'entry-test',
      CATALOG_LOCAL_PATH: localPath, ATLAS_SESSION_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const listening = await new Promise((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Server exited before listen: ${stderr}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening') resolve(event);
        } catch { /* wait for the rest of a JSON line */ }
      }
    });
  });
  assert.ok(listening.port > 0, 'entry should report its actual bound port');
  const response = await fetch(`http://127.0.0.1:${listening.port}/api/catalog/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 9);
  const health = await fetch(`http://127.0.0.1:${listening.port}/healthz`);
  assert.equal((await health.json()).release, 'entry-test');
});
