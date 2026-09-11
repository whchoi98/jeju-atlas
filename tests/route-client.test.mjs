import test from 'node:test';
import assert from 'node:assert/strict';

let client;
try { client = await import('../src/route-client.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const source = {
  provider: 'valhalla', data: 'OpenStreetMap', attribution: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright', data_updated_at: '2026-09-09T00:00:00Z',
};
const stops = [{ lng: 126.5, lat: 33.4 }, { lng: 126.51, lat: 33.41 }];
const coordinates = [[126.5, 33.4], [126.502, 33.408], [126.51, 33.41]];
const success = (mode = 'car') => ({
  available: true, mode, source, distance_m: 2500, duration_s: 600, coordinates,
  legs: [{ distance_m: 2500, duration_s: 600, coordinates,
    steps: [{ instruction: '검증용 도로를 따라 이동하세요.', distance_m: 2500, duration_s: 600, start_index: 0, end_index: 2 }] }],
  snapped: stops.map(point => ({ ...point, distance_m: 3 })),
  warnings: [], traffic: 'not_live',
});
const config = (token = 'signed-proof') => ({
  features: { routing: true }, routing: { enabled: true, csrf_token: token, modes: ['walk', 'car'], source },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
function request(body = { mode: 'car', locale: 'ko', stops }, options = {}) {
  assert.equal(typeof client?.requestRoute, 'function', 'the route client must implement the routing contract');
  return client.requestRoute(body, { loadConfig: async () => config(), ...options });
}

test('routing sends only mode, locale and coordinates with the same-origin cookie and CSRF proof', async () => {
  let sent;
  const result = await request({
    mode: 'car', locale: 'en', stops: stops.map(point => ({ ...point, name: 'do-not-send', id: 'private-id' })),
  }, {
    fetchImpl: async (url, init) => { sent = { url, ...init }; return json(success()); },
  });
  assert.equal(sent.url, '/api/routes');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.credentials, 'same-origin');
  assert.equal(new Headers(sent.headers).get('X-Atlas-CSRF'), 'signed-proof');
  assert.equal(new Headers(sent.headers).get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(sent.body), { mode: 'car', locale: 'en', stops });
  assert.deepEqual(result.coordinates, coordinates);
  assert.equal(result.source.data_updated_at, source.data_updated_at);
});

test('invalid modes, locales, counts and coordinates never reach config or routing HTTP', async () => {
  for (const body of [
    { mode: 'bus', locale: 'ko', stops }, { mode: 'car', locale: 'ja', stops },
    { mode: { toString: () => 'car' }, locale: 'ko', stops },
    { mode: 'car', locale: { toString: () => 'ko' }, stops },
    { mode: 'walk', locale: 'ko', stops: stops.slice(0, 1) },
    { mode: 'walk', locale: 'ko', stops: Array(13).fill(stops[0]) },
    { mode: 'car', locale: 'ko', stops: [{ lng: 127, lat: 37 }, stops[1]] },
    { mode: 'car', locale: 'ko', stops: [{ lng: '126.5', lat: 33.4 }, stops[1]] },
  ]) {
    let calls = 0;
    await assert.rejects(request(body, {
      loadConfig: async () => { calls++; return config(); },
      fetchImpl: async () => { calls++; return json(success()); },
    }), error => error.code === 'invalid_request');
    assert.equal(calls, 0);
  }
});

test('routing disabled in config makes no route request', async () => {
  let calls = 0;
  await assert.rejects(request(undefined, {
    loadConfig: async () => ({ ...config(), features: { routing: false } }),
    fetchImpl: async () => { calls++; return json(success()); },
  }), error => error.code === 'routing_unavailable');
  assert.equal(calls, 0);
});

test('one expired session or CSRF proof is refreshed once without changing the route input', async () => {
  const bodies = [], proofs = [], refreshes = [];
  const result = await request(undefined, {
    loadConfig: async refresh => { refreshes.push(Boolean(refresh)); return config(refresh ? 'fresh-proof' : 'old-proof'); },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body)); proofs.push(new Headers(init.headers).get('X-Atlas-CSRF'));
      return bodies.length === 1 ? json({ error: { code: 'csrf_invalid' } }, 403) : json(success());
    },
  });
  assert.equal(result.available, true);
  assert.deepEqual(proofs, ['old-proof', 'fresh-proof']);
  assert.deepEqual(bodies, [{ mode: 'car', locale: 'ko', stops }, { mode: 'car', locale: 'ko', stops }]);
  assert.deepEqual(refreshes, [false, true]);
});

test('recovery has a single budget and origin, load and service failures do not retry', async () => {
  for (const [status, code, expected] of [
    [403, 'csrf_invalid', 2], [401, 'session_required', 2],
    [403, 'origin_forbidden', 1], [429, 'rate_limited', 1], [503, 'routing_unavailable', 1],
  ]) {
    let calls = 0;
    await assert.rejects(request(undefined, {
      fetchImpl: async () => { calls++; return json({ error: { code } }, status); },
    }), error => error.status === status);
    assert.equal(calls, expected);
  }
});

test('route unavailability stays unavailable without invented geometry or times', async () => {
  for (const code of ['no_route', 'endpoint_unreachable', 'ferry_required', 'routing_unavailable']) {
    const result = await request(undefined, { fetchImpl: async () => json({ available: false, mode: 'car', source, code }) });
    assert.equal(result.available, false);
    assert.equal(result.code, code);
    assert.equal(result.coordinates, undefined);
    assert.equal(result.duration_s, undefined);
  }
});

test('mismatched modes and malformed geometry, metrics or provenance cannot reach the map', async () => {
  for (const changes of [
    { mode: 'walk' }, { coordinates: [[126.5, 33.4]] },
    { coordinates: [[0, 0], [126.5, 33.4]] }, { duration_s: -1 },
    { distance_m: '2500' }, { traffic: 'live' }, { source: { ...source, url: 'javascript:alert(1)' } },
    { legs: [] },
    { coordinates: Array(30_001).fill([126.5, 33.4]) },
  ]) {
    await assert.rejects(request(undefined, { fetchImpl: async () => json({ ...success(), ...changes }) }),
      error => error.code === 'invalid_response');
  }
});

test('simultaneous walk and car session recovery share one config refresh', async () => {
  let refreshes = 0;
  const loadConfig = async refresh => {
    if (refresh) { refreshes++; await new Promise(resolve => setImmediate(resolve)); }
    return config(refresh ? 'fresh-proof' : 'old-proof');
  };
  const replies = new Map();
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    replies.set(body.mode, (replies.get(body.mode) ?? 0) + 1);
    return new Headers(init.headers).get('X-Atlas-CSRF') === 'old-proof'
      ? json({ error: { code: 'session_required' } }, 401) : json(success(body.mode));
  };
  const routes = await Promise.all(['walk', 'car'].map(mode => request({ mode, locale: 'ko', stops }, { loadConfig, fetchImpl })));
  assert.deepEqual(routes.map(route => route.mode), ['walk', 'car']);
  assert.equal(refreshes, 1);
  assert.deepEqual([...replies.values()], [2, 2]);
});

test('aborting a request also rejects an uncooperative late response and prevents recovery', async () => {
  const controller = new AbortController();
  let resolveResponse;
  let signal;
  let calls = 0;
  const pending = request(undefined, {
    signal: controller.signal,
    fetchImpl: (_url, init) => {
      calls++; signal = init.signal;
      return new Promise(resolve => { resolveResponse = resolve; });
    },
  });
  while (!resolveResponse) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(signal.aborted, true);
  resolveResponse(json({ error: { code: 'csrf_invalid' } }, 403));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
