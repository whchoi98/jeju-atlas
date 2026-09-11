import test from 'node:test';
import assert from 'node:assert/strict';

let routing;
try { routing = await import('../server/routing.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const stops = [{ lng: 126.5, lat: 33.4 }, { lng: 126.501, lat: 33.401 }];
const input = (changes = {}) => ({ mode: 'car', locale: 'ko', stops, ...changes });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

// Hand-checked polyline6. Expected coordinates do not use the production decoder.
function trip(language = 'ko-KR', mode = 'drive') {
  return {
    trip: {
      status: 0, status_message: 'Found route between points', units: 'kilometers', language,
      locations: [{ lat: 33.4, lon: 126.5 }, { lat: 33.401, lon: 126.501 }],
      summary: { length: 0.205, time: 180, has_ferry: false },
      legs: [{
        shape: '_kqu~@_i}gpFo}@??o}@',
        summary: { length: 0.205, time: 180, has_ferry: false },
        maneuvers: [
          { type: 1, instruction: language === 'ko-KR' ? '북쪽으로 이동하세요.' : 'Head north.',
            length: 0.111, time: 100, begin_shape_index: 0, end_shape_index: 1, travel_mode: mode },
          { type: 10, instruction: language === 'ko-KR' ? '우회전하세요.' : 'Turn right.',
            length: 0.094, time: 80, begin_shape_index: 1, end_shape_index: 2, travel_mode: mode },
          { type: 4, instruction: language === 'ko-KR' ? '도착했습니다.' : 'You have arrived.',
            length: 0, time: 0, begin_shape_index: 2, end_shape_index: 2, travel_mode: mode },
        ],
      }],
    },
  };
}
function service(t, options = {}) {
  assert.equal(typeof routing?.createRoutingService, 'function', 'routing service must be implemented');
  const instance = routing.createRoutingService({
    url: 'http://127.0.0.1:8002', dataUpdatedAt: '2026-09-09T00:00:00Z',
    fetch: async () => json(trip()), ...options,
  });
  t.after(() => instance.close());
  return instance;
}

test('canonical polyline6 becomes real coordinates, metric lengths and local maneuver indexes', async t => {
  let sent;
  const router = service(t, { fetch: async (url, init) => {
    sent = { url: String(url), ...init }; return json(trip());
  } });
  const result = await router.route(input());
  assert.equal(result.available, true);
  assert.equal(result.distance_m, 205);
  assert.equal(result.duration_s, 180);
  assert.equal(result.traffic, 'not_live');
  assert.deepEqual(result.coordinates, [[126.5, 33.4], [126.5, 33.401], [126.501, 33.401]]);
  assert.deepEqual(result.legs[0].steps[1], {
    instruction: '우회전하세요.', distance_m: 94, duration_s: 80, start_index: 1, end_index: 2,
  });
  assert.deepEqual(result.snapped, [
    { lng: 126.5, lat: 33.4, distance_m: 0 }, { lng: 126.501, lat: 33.401, distance_m: 0 },
  ]);
  assert.equal(result.source.data_updated_at, '2026-09-09T00:00:00Z');
  assert.equal(result.source.provider, 'valhalla');
  assert.equal(result.source.data, 'OpenStreetMap');
  assert.match(result.source.attribution, /OpenStreetMap/);
  assert.equal(sent.url, 'http://127.0.0.1:8002/route');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.redirect, 'error');
  const body = JSON.parse(sent.body);
  assert.equal(body.language, 'ko-KR');
  assert.equal(body.costing, 'auto');
  assert.equal(body.costing_options.auto.use_ferry, 0);
  assert.equal(body.shape_format, undefined, 'canonical JSON uses polyline6, not the OSRM shape_format option');
  assert.deepEqual(body.locations, [
    { lat: 33.4, lon: 126.5, type: 'break', search_cutoff: 200, search_filter: { exclude_ferry: true } },
    { lat: 33.401, lon: 126.501, type: 'break', search_cutoff: 200, search_filter: { exclude_ferry: true } },
  ]);
});

test('pedestrian costing and native English instructions remain separate from car cache entries', async t => {
  const requests = [];
  const router = service(t, { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return json(trip(body.language, body.costing === 'auto' ? 'drive' : 'pedestrian'));
  } });
  await router.route(input());
  const walk = await router.route(input({ mode: 'walk', locale: 'en' }));
  assert.equal(walk.mode, 'walk');
  assert.equal(walk.legs[0].steps[0].instruction, 'Head north.');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].costing, 'pedestrian');
  assert.equal(requests[1].costing_options.pedestrian.use_ferry, 0);
  assert.equal(requests[1].language, 'en-US');
});

test('multiple legs retain local indexes and join only at their shared real vertex', async t => {
  const data = trip();
  const second = structuredClone(data.trip.legs[0]);
  second.shape = 'oisu~@og_hpF?o}@o}@?';
  data.trip.legs.push(second);
  data.trip.summary = { length: 0.410, time: 360, has_ferry: false };
  const router = service(t, { fetch: async () => json(data) });
  const result = await router.route(input({ stops: [...stops, { lng: 126.502, lat: 33.402 }] }));
  assert.equal(result.available, true);
  assert.deepEqual(result.coordinates, [
    [126.5, 33.4], [126.5, 33.401], [126.501, 33.401], [126.502, 33.401], [126.502, 33.402],
  ]);
  assert.equal(result.distance_m, 410);
  assert.equal(result.legs[1].steps[0].start_index, 0);
  assert.equal(result.snapped.length, 3);
});

test('malformed inputs, extra engine options and out-of-scope coordinates never call the engine', async t => {
  let calls = 0;
  const router = service(t, { fetch: async () => { calls++; return json(trip()); } });
  for (const value of [
    null, [], input({ mode: 'transit' }), input({ locale: 'ja' }),
    input({ stops: [] }), input({ stops: [stops[0]] }), input({ stops: Array(13).fill(stops[0]) }),
    input({ stops: [{ lng: '126.5', lat: 33.4 }, stops[1]] }),
    input({ stops: [{ lng: NaN, lat: 33.4 }, stops[1]] }),
    input({ stops: [{ lng: 126.5, lat: 33.60001 }, stops[1]] }),
    input({ stops: [{ lng: 126.14999, lat: 33.4 }, stops[1]] }),
    input({ stops: [{ ...stops[0], name: 'private' }, stops[1]] }),
    input({ url: 'http://169.254.169.254/' }), input({ costing_options: { auto: { ignore_access: true } } }),
  ]) {
    await assert.rejects(router.route(value), error => error.status === 400 && error.code === 'invalid_request');
  }
  assert.equal(calls, 0);
});

test('inclusive Jeju boundaries and twelve stops pass validation without truncation', async t => {
  let captured;
  const router = service(t, { fetch: async (_url, init) => {
    captured = JSON.parse(init.body); return json({ error_code: 442 }, 400);
  } });
  const result = await router.route(input({ stops: [
    { lng: 126.15, lat: 33.1 }, ...Array(10).fill(stops[0]), { lng: 126.98, lat: 33.6 },
  ] }));
  assert.equal(result.code, 'no_route');
  assert.equal(captured.locations.length, 12);
  assert.equal(captured.locations.at(-1).lon, 126.98);
});

test('every documented ferry signal blocks a walking or driving result even when avoidance was requested', async t => {
  const mutations = [
    data => { data.trip.summary.has_ferry = true; },
    data => { data.trip.legs[0].summary.has_ferry = true; },
    data => { data.trip.legs[0].maneuvers[0].ferry = true; },
    data => { data.trip.legs[0].maneuvers[0].type = 28; },
    data => { data.trip.legs[0].maneuvers[0].type = 29; },
    data => { data.trip.legs[0].maneuvers[0].travel_type = 'ferry'; },
  ];
  for (const mutate of mutations) {
    const data = trip(); mutate(data);
    const result = await service(t, { fetch: async () => json(data) }).route(input());
    assert.equal(result.available, false);
    assert.equal(result.code, 'ferry_required');
    assert.equal(result.coordinates, undefined);
  }
});

test('snap distance uses decoded path endpoints rather than the echoed request locations', async t => {
  const data = trip();
  data.trip.legs[0].shape = '_kqu~@_zphpFo}@o}@';
  data.trip.legs[0].maneuvers = [{ ...data.trip.legs[0].maneuvers[0], end_shape_index: 1 }];
  const result = await service(t, { fetch: async () => json(data) }).route(input());
  assert.equal(result.code, 'endpoint_unreachable');
  assert.equal(result.coordinates, undefined);
});

test('broken polylines, indexes, metrics, languages and unexpected modes fail closed', async t => {
  for (const mutate of [
    data => { data.trip.legs[0].shape = '_'; },
    data => { data.trip.legs[0].shape = '~~~~~~~??'; },
    data => { data.trip.legs[0].shape = '????'; },
    data => { data.trip.legs[0].maneuvers[0].end_shape_index = 3; },
    data => { data.trip.legs[0].maneuvers[0].begin_shape_index = -1; },
    data => { data.trip.legs[0].maneuvers[0].instruction = 'x'.repeat(3000); },
    data => { data.trip.legs[0].maneuvers[0].travel_mode = 'transit'; },
    data => { data.trip.legs[0].summary.length = -1; },
    data => { data.trip.summary.time = '180'; },
    data => { data.trip.summary.length = 100000; },
    data => { data.trip.units = 'miles'; },
    data => { data.trip.language = 'en-US'; },
    data => { data.trip.legs = []; },
  ]) {
    const data = trip(); mutate(data);
    const result = await service(t, { fetch: async () => json(data) }).route(input());
    assert.equal(result.available, false);
    assert.equal(result.code, 'routing_unavailable');
  }
});

test('discontinuous legs do not become a fabricated connecting line', async t => {
  const data = trip();
  data.trip.legs.push(structuredClone(data.trip.legs[0]));
  data.trip.summary = { length: 0.410, time: 360, has_ferry: false };
  const result = await service(t, { fetch: async () => json(data) }).route(
    input({ stops: [...stops, stops[1]] }),
  );
  assert.equal(result.available, false);
  assert.equal(result.coordinates, undefined);
});

test('known no-path errors are distinct from transport failures and never expose upstream input text', async t => {
  for (const [status, error_code, expected] of [
    [400, 171, 'endpoint_unreachable'], [400, 170, 'no_route'], [400, 442, 'no_route'],
    [500, 442, 'routing_unavailable'], [400, 100, 'routing_unavailable'],
  ]) {
    const result = await service(t, { fetch: async () => json({
      error_code, error: 'private-coordinate-or-body-sentinel', status_code: status,
    }, status) }).route(input());
    assert.equal(result.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /private-coordinate-or-body-sentinel/);
  }
  const result = await service(t, { fetch: async () => { throw new Error('private-coordinate-sentinel'); } }).route(input());
  assert.equal(result.code, 'routing_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private-coordinate/);
});

test('engine configuration cannot target external hosts, credentials, paths, ports or redirects', async t => {
  for (const url of [
    'https://example.com', 'http://169.254.169.254:8002', 'http://127.0.0.1:8080',
    'http://user:pass@localhost:8002', 'http://localhost:8002/route', 'http://localhost:8002/?url=x',
    'http://localhost:8002/#x',
  ]) assert.throws(() => service(t, { url }), /loopback/i);
  let calls = 0;
  const disabled = service(t, { url: undefined, fetch: async () => { calls++; return json(trip()); } });
  assert.equal(disabled.enabled, false);
  assert.equal((await disabled.route(input())).code, 'routing_unavailable');
  assert.equal(calls, 0);
});

test('response limits apply while streaming and to decoded geometry without truncation', async t => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128)); },
    cancel() { cancelled = true; },
  });
  const large = await service(t, {
    maxResponseBytes: 256, fetch: async () => new Response(stream),
  }).route(input());
  assert.equal(large.code, 'routing_unavailable');
  assert.equal(cancelled, true);
  const tooMany = await service(t, { maxCoordinates: 2 }).route(input());
  assert.equal(tooMany.code, 'routing_unavailable');
  const header = await service(t, { fetch: async () => new Response('{}', {
    headers: { 'Content-Length': '999999999' },
  }) }).route(input());
  assert.equal(header.code, 'routing_unavailable');
});

test('cache is bounded, expires, separates locales and cannot be poisoned by caller mutation', async t => {
  let now = 0, calls = 0;
  const router = service(t, { clock: () => now, maxCacheEntries: 1, cacheTtlMs: 100,
    fetch: async (_url, init) => { calls++; return json(trip(JSON.parse(init.body).language)); } });
  const first = await router.route(input());
  first.coordinates[0][0] = 0;
  assert.equal((await router.route(input())).coordinates[0][0], 126.5);
  assert.equal(calls, 1);
  await router.route(input({ locale: 'en' }));
  await router.route(input());
  assert.equal(calls, 3, 'the one-entry cache evicts the older locale');
  now = 101;
  await router.route(input());
  assert.equal(calls, 4);
});

test('one caller aborts its own engine request without cancelling a different in-flight route', async t => {
  const pending = [];
  const router = service(t, { fetch: (_url, init) => new Promise(resolve => { pending.push({ init, resolve }); }) });
  const controller = new AbortController();
  const first = router.route(input(), controller.signal);
  const second = router.route(input({ locale: 'en' }));
  await tick();
  controller.abort();
  await assert.rejects(first, error => error.name === 'AbortError');
  assert.equal(pending[0].init.signal.aborted, true);
  assert.equal(pending[1].init.signal.aborted, false);
  pending[1].resolve(json(trip('en-US')));
  assert.equal((await second).available, true);
  pending[0].resolve(json(trip()));
});

test('capacity and deadline bound uncooperative engines; close aborts ongoing work', async t => {
  let activeSignal;
  const router = service(t, { maxConcurrent: 1, timeoutMs: 25,
    fetch: (_url, init) => { activeSignal = init.signal; return new Promise(() => {}); } });
  const pending = router.route(input());
  await tick();
  await assert.rejects(router.route(input()), error => error.status === 429);
  assert.equal((await pending).code, 'routing_unavailable');
  assert.equal(activeSignal.aborted, true);
  const next = router.route(input());
  await tick();
  router.close();
  assert.equal((await next).code, 'routing_unavailable');
  assert.equal(activeSignal.aborted, true);
  assert.equal((await router.route(input())).code, 'routing_unavailable');
});

test('height endpoint preserves coordinate order, valid zero and unknown values with honest DEM attribution', async t => {
  let sent;
  const router = service(t, { fetch: async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return json({ height: [0, 1950.4, null, -32768] });
  } });
  const result = await router.elevation({ coordinates: [
    [126.5, 33.4], [126.51, 33.41], [126.52, 33.42], [126.53, 33.43], [126.54, 33.44],
  ] });
  assert.equal(result.available, true);
  assert.deepEqual(result.elevations_m, [0, 1950.4, null, null, null]);
  assert.equal(sent.url, 'http://127.0.0.1:8002/height');
  assert.deepEqual(sent.body, { shape: [
    { lon: 126.5, lat: 33.4 }, { lon: 126.51, lat: 33.41 }, { lon: 126.52, lat: 33.42 },
    { lon: 126.53, lat: 33.43 }, { lon: 126.54, lat: 33.44 },
  ] });
  assert.match(result.source.name, /Skadi/);
  assert.match(result.source.name, /2016-04-23/);
  assert.match(result.source.url, /^https:/);
});

test('height alias, missing data, malformed bodies and request limits remain distinguishable', async t => {
  const coordinates = [[126.5, 33.4], [126.51, 33.41]];
  const alias = await service(t, { fetch: async () => json({ heights: [4, 'unknown'] }) }).elevation({ coordinates });
  assert.deepEqual(alias.elevations_m, [4, null]);
  const missing = await service(t, { fetch: async () => json({ height: [null, null] }) }).elevation({ coordinates });
  assert.equal(missing.available, true);
  assert.deepEqual(missing.elevations_m, [null, null]);
  for (const response of [{ height: 'bad' }, { height: [1, 2, 3] }, { error_code: 500 }]) {
    const result = await service(t, { fetch: async () => json(response) }).elevation({ coordinates });
    assert.equal(result.available, false);
    assert.equal(result.code, 'elevation_unavailable');
  }
  let calls = 0;
  const router = service(t, { fetch: async () => { calls++; return json({ height: [] }); } });
  for (const body of [
    { coordinates: [coordinates[0]] }, { coordinates: Array(257).fill(coordinates[0]) },
    { coordinates: [[126.5, 34], coordinates[0]] },
    { coordinates: [[126.5, 33.4, 50], coordinates[1]] },
    { coordinates, shape: [] },
  ]) await assert.rejects(router.elevation(body), error => error.status === 400);
  assert.equal(calls, 0);
  const bounded = await router.elevation({ coordinates: Array(256).fill(coordinates[0]) });
  assert.equal(bounded.elevations_m.length, 256);
});
