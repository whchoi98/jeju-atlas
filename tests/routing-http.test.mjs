import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApiHandler } from '../server/api.mjs';
import { createAppServer } from '../server/server.mjs';

const body = { mode: 'car', locale: 'ko', stops: [{ lng: 126.5, lat: 33.4 }, { lng: 126.501, lat: 33.401 }] };
const elevationBody = { coordinates: [[126.5, 33.4], [126.501, 33.401]] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function engineResult() {
  return { trip: {
    status: 0, units: 'kilometers', language: 'ko-KR',
    summary: { length: 0.205, time: 180, has_ferry: false },
    legs: [{
      shape: '_kqu~@_i}gpFo}@??o}@', summary: { length: 0.205, time: 180, has_ferry: false },
      maneuvers: [{ type: 1, instruction: '북쪽으로 이동하세요.', length: 0.205, time: 180,
        begin_shape_index: 0, end_shape_index: 2, travel_mode: 'drive' }],
    }],
  } };
}
async function fixture(t, options = {}) {
  let now = Date.parse('2026-09-10T00:00:00Z'), calls = 0, quotas = 0;
  const diagnostics = [];
  const api = createApiHandler({
    env: { NODE_ENV: 'production', ROUTING_URL: 'http://127.0.0.1:8002',
      ROUTING_DATA_UPDATED_AT: '2026-09-09T00:00:00Z', ...options.env },
    secret: 'routing-test-secret-at-least-thirty-two-bytes',
    publicOrigin: 'https://atlas.example.test', clock: () => now,
    consumeQuota: async () => { quotas++; return true; },
    fetch: async (url, init) => {
      calls++;
      return options.fetch ? options.fetch(url, init) : json(String(url).endsWith('/height')
        ? { height: [0, null] } : engineResult());
    },
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    routingOptions: options.routingOptions,
  });
  const server = createAppServer({ root: 'public', api });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (path, headers = {}, value, method = value === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { /* Some server-level errors are intentionally text. */ }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.on('error', reject);
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
  const config = async cookie => {
    const response = await call('/api/config', cookie ? { Cookie: cookie } : {});
    return { ...response, cookie: response.headers['set-cookie']?.[0].split(';')[0] ?? cookie,
      token: response.data.routing?.csrf_token };
  };
  return {
    api, server, call, config, diagnostics, counts: () => ({ calls, quotas }), advance: ms => { now += ms; },
    headers: session => ({ 'Content-Type': 'application/json', Cookie: session.cookie, 'X-Atlas-CSRF': session.token }),
  };
}

test('private config enables routing independently of AI and supplies actor-bound proof and source', async t => {
  const f = await fixture(t);
  const first = await f.config();
  assert.equal(first.data.features.guide, false);
  assert.equal(first.data.features.routing, true);
  assert.equal(first.data.routing.enabled, true);
  assert.deepEqual(first.data.routing.modes, ['walk', 'car']);
  assert.equal(first.data.routing.source.data_updated_at, '2026-09-09T00:00:00Z');
  assert.match(first.token ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['access-control-allow-origin'], undefined);
  assert.match(first.headers['set-cookie'][0], /HttpOnly/);
  assert.match(first.headers['set-cookie'][0], /Secure/);
  assert.equal((await f.config(first.cookie)).token, first.token);
  assert.notEqual((await f.config()).token, first.token);
  assert.deepEqual(f.counts(), { calls: 0, quotas: 0 });
});

test('valid signed cookie and CSRF pair supports both viewer hosts and never uses the guide quota', async t => {
  const f = await fixture(t);
  const session = await f.config();
  assert.ok(session.token);
  for (const origin of ['https://atlas.example.test', 'https://distribution.cloudfront.net', undefined, 'null']) {
    const headers = { ...f.headers(session), ...(origin ? { Origin: origin } : {}) };
    const result = await f.call('/api/routes', headers, body);
    assert.equal(result.status, 200);
    assert.equal(result.data.available, true);
    assert.equal(result.data.distance_m, 205);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  const elevation = await f.call('/api/elevation', f.headers(session), elevationBody);
  assert.equal(elevation.status, 200);
  assert.deepEqual(elevation.data.elevations_m, [0, null]);
  assert.deepEqual(f.counts(), { calls: 2, quotas: 0 });
});

test('new routing endpoints reject anonymous, forged and cross-actor proofs even on canonical Origin', async t => {
  const f = await fixture(t), own = await f.config(), other = await f.config();
  assert.ok(own.token);
  for (const path of ['/api/routes', '/api/elevation']) {
    const value = path === '/api/routes' ? body : elevationBody;
    const anonymous = await f.call(path, { 'Content-Type': 'application/json', Origin: 'https://atlas.example.test' }, value);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.error.code, 'session_required');
    for (const headers of [
      { Cookie: own.cookie }, { Cookie: own.cookie, 'X-Atlas-CSRF': 'forged' },
      { Cookie: other.cookie, 'X-Atlas-CSRF': own.token },
    ]) {
      const result = await f.call(path, { 'Content-Type': 'application/json', Origin: 'https://atlas.example.test', ...headers }, value);
      assert.equal(result.status, 403);
      assert.equal(result.data.error.code, 'csrf_invalid');
    }
  }
  assert.deepEqual(f.counts(), { calls: 0, quotas: 0 });
});

test('routing enforces POST, JSON, body size, query allowlist and coordinate validation before engine work', async t => {
  const f = await fixture(t), session = await f.config();
  assert.ok(session.token);
  assert.equal((await f.call('/api/routes')).status, 405);
  assert.equal((await f.call('/api/elevation')).headers.allow, 'POST');
  assert.equal((await f.call('/api/routes', { ...f.headers(session), 'Content-Type': 'text/plain' }, body)).status, 415);
  assert.equal((await f.call('/api/routes', f.headers(session), { ...body, mode: 'bus' })).status, 400);
  assert.equal((await f.call('/api/routes?url=http://example.test', f.headers(session), body)).status, 400);
  assert.equal((await f.call('/api/routes', f.headers(session), { ...body, extra: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.call('/api/elevation', f.headers(session), { coordinates: [[126.5, 34], [126.5, 33.4]] })).status, 400);
  assert.deepEqual(f.counts(), { calls: 0, quotas: 0 });
});

test('trip editing fits within a bounded minute of route and elevation calls, with actor isolation and expiry', async t => {
  const f = await fixture(t), session = await f.config();
  assert.ok(session.token);
  for (let i = 0; i < 60; i++) {
    const height = i % 2 === 1;
    assert.equal((await f.call(height ? '/api/elevation' : '/api/routes', f.headers(session),
      height ? elevationBody : body)).status, 200);
  }
  const limited = await f.call('/api/routes', f.headers(session), body);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'rate_limited');
  assert.equal(limited.headers['retry-after'], '60');
  const other = await f.config();
  assert.equal((await f.call('/api/routes', f.headers(other), body)).status, 200);
  f.advance(60_000);
  assert.equal((await f.call('/api/routes', f.headers(session), body)).status, 200);
  assert.equal(f.counts().quotas, 0);
});

test('domain failures retain source without invented routes; upstream failures are 503 and private', async t => {
  let status = 400;
  const f = await fixture(t, { fetch: async () => json({ error_code: 442, error: 'sensitive-body-126.5' }, status) });
  const session = await f.config();
  assert.ok(session.token);
  const missing = await f.call('/api/routes', f.headers(session), body);
  assert.equal(missing.status, 200);
  assert.equal(missing.data.code, 'no_route');
  assert.equal(missing.data.coordinates, undefined);
  status = 500;
  const failed = await f.call('/api/routes', f.headers(session), body);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'routing_unavailable');
  assert.doesNotMatch(failed.text + JSON.stringify(f.diagnostics), /sensitive-body|126\.5/);
  assert.equal((await f.call('/readyz')).status, 200);
  assert.equal((await f.call('/healthz')).status, 200);
});

test('missing engine configuration disables only routing and does not hand out routing proofs', async t => {
  const f = await fixture(t, { env: { ROUTING_URL: '' } });
  const config = await f.config();
  assert.equal(config.data.features.routing, false);
  assert.equal(config.data.routing.enabled, false);
  assert.equal(config.data.routing.csrf_token, undefined);
  assert.equal((await f.call('/readyz')).status, 200);
  assert.equal(f.counts().calls, 0);
});

test('client disconnect aborts the engine and drain rejects new routing work', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let engineSignal;
  const f = await fixture(t, { fetch: (_url, init) => {
    engineSignal = init.signal; entered();
    return new Promise(() => {});
  } });
  const session = await f.config();
  assert.ok(session.token);
  const req = request({ hostname: '127.0.0.1', port: f.server.address().port, path: '/api/routes',
    method: 'POST', headers: f.headers(session) });
  req.on('error', () => {});
  req.end(JSON.stringify(body));
  await started;
  req.destroy();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('disconnect did not abort engine')), 1000);
    const done = () => { clearTimeout(timer); resolve(); };
    if (engineSignal.aborted) done();
    else engineSignal.addEventListener('abort', done, { once: true });
  });
  f.api.beginDrain();
  const rejected = await f.call('/api/routes', f.headers(session), body);
  assert.equal(rejected.status, 503);
  assert.equal(f.counts().calls, 1);
});

test('same-origin geolocation remains available for the user-triggered route origin control', async t => {
  const f = await fixture(t);
  const result = await f.call('/healthz');
  assert.match(result.headers['permissions-policy'], /geolocation=\(self\)/);
  assert.match(result.headers['permissions-policy'], /camera=\(\)/);
});
