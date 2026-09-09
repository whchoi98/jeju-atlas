import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/server.mjs';

let weatherModule;
let apiModule;
try {
  weatherModule = await import('../server/weather.mjs');
  apiModule = await import('../server/api.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const upstream = () => ({
  current: {
    time: '2026-09-09T12:00', temperature_2m: 26.5, wind_speed_10m: 12.3,
    precipitation: 0, weather_code: 2,
  },
  daily: {
    time: ['2026-09-09', '2026-09-10', '2026-09-11'],
    temperature_2m_min: [23, 22, 21],
    temperature_2m_max: [28, 27, 26],
    precipitation_probability_max: [10, 20, 30],
    weather_code: [2, 3, 61],
  },
});
const fixedTime = Date.parse('2026-09-09T03:01:00Z');

function service(options = {}) {
  assert.equal(typeof weatherModule?.createWeatherService, 'function', 'Weather service must be implemented');
  return weatherModule.createWeatherService({ clock: () => fixedTime, ...options });
}

test('weather requests only the fixed HTTPS provider and returns the canonical three-day shape', async () => {
  let seen;
  const weather = service({
    fetch: async (url, options) => {
      seen = { url: new URL(url), options };
      return Response.json(upstream());
    },
  });
  const result = await weather.get({ lat: 33.45, lng: 126.55 });
  assert.equal(seen.url.origin, 'https://api.open-meteo.com');
  assert.equal(seen.url.pathname, '/v1/forecast');
  assert.equal(seen.url.searchParams.get('latitude'), '33.45');
  assert.equal(seen.url.searchParams.get('longitude'), '126.55');
  assert.equal(seen.url.searchParams.get('forecast_days'), '3');
  assert.equal(seen.url.searchParams.get('timezone'), 'Asia/Seoul');
  assert.equal(seen.url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.match(seen.url.searchParams.get('current'), /temperature_2m/);
  assert.match(seen.url.searchParams.get('daily'), /precipitation_probability_max/);
  assert.equal(seen.options.redirect, 'error');
  assert.ok(seen.options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    available: true, lat: 33.45, lng: 126.55, source: 'Open-Meteo',
    fetched_at: '2026-09-09T03:01:00.000Z',
    current: {
      time: '2026-09-09T12:00', temperature_c: 26.5, wind_kmh: 12.3,
      precipitation_mm: 0, weather_code: 2, summary: '구름 조금',
    },
    daily: [
      { date: '2026-09-09', min_c: 23, max_c: 28, precipitation_probability: 10, weather_code: 2 },
      { date: '2026-09-10', min_c: 22, max_c: 27, precipitation_probability: 20, weather_code: 3 },
      { date: '2026-09-11', min_c: 21, max_c: 26, precipitation_probability: 30, weather_code: 61 },
    ],
  });
});

test('weather deduplicates coordinates, caches for five minutes, and bounds cached entries', async () => {
  let now = fixedTime;
  let calls = 0;
  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const weather = service({
    clock: () => now, maxEntries: 2,
    fetch: async () => {
      calls++;
      if (calls === 1) await pending;
      return Response.json(upstream());
    },
  });
  const first = weather.get({ lat: 33.4, lng: 126.5 });
  const duplicate = weather.get({ lat: 33.4, lng: 126.5 });
  resolveFetch();
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1);
  now += 299_999;
  await weather.get({ lat: 33.4, lng: 126.5 });
  assert.equal(calls, 1);
  now++;
  await weather.get({ lat: 33.4, lng: 126.5 });
  assert.equal(calls, 2);
  await weather.get({ lat: 33.41, lng: 126.5 });
  await weather.get({ lat: 33.42, lng: 126.5 });
  await weather.get({ lat: 33.4, lng: 126.5 });
  assert.equal(calls, 5, 'oldest cached coordinate should have been evicted');
});

test('missing numbers remain null and malformed or failed weather never becomes a forecast', async () => {
  const partial = upstream();
  partial.current.temperature_2m = null;
  partial.current.precipitation = 'not a number';
  partial.daily.temperature_2m_min[1] = null;
  const result = await service({ fetch: async () => Response.json(partial) }).get({ lat: 33.4, lng: 126.5 });
  assert.equal(result.current.temperature_c, null);
  assert.equal(result.current.precipitation_mm, null);
  assert.equal(result.daily[1].min_c, null);
  for (const fetch of [
    async () => { throw new Error('private upstream diagnostic'); },
    async () => new Response('down', { status: 503 }),
    async () => Response.json({}),
    async () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
  ]) {
    const unavailable = await service({ fetch }).get({ lat: 33.4, lng: 126.5 });
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.current, null);
    assert.deepEqual(unavailable.daily, []);
    assert.doesNotMatch(unavailable.message, /private upstream/);
  }
});

test('weather timeout aborts even a non-cooperating fetch and pending entries cannot grow unbounded', async () => {
  let calls = 0;
  const signals = [];
  const weather = service({
    timeoutMs: 30, maxEntries: 2, maxPending: 2,
    fetch: async (_url, { signal }) => {
      calls++;
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  const first = weather.get({ lat: 33.4, lng: 126.5 });
  const second = weather.get({ lat: 33.41, lng: 126.5 });
  const excess = await weather.get({ lat: 33.42, lng: 126.5 });
  assert.equal(excess.available, false);
  assert.equal(calls, 2);
  for (const result of await Promise.all([first, second])) assert.equal(result.available, false);
  assert.ok(signals.every((signal) => signal.aborted));
  weather.close();
});

test('weather HTTP responses stay no-store, validate Jeju bounds, and return 503 on upstream failure', async (t) => {
  assert.equal(typeof apiModule?.createApiHandler, 'function', 'API handler must be implemented');
  let calls = 0;
  const root = await mkdtemp(join(tmpdir(), 'atlas-weather-http-'));
  await writeFile(join(root, 'index.html'), '<title>weather test</title>');
  const api = apiModule.createApiHandler({
    env: { NODE_ENV: 'test' }, secret: 'weather-test-secret-at-least-32-bytes',
    clock: () => fixedTime,
    fetch: async () => {
      calls++;
      return calls === 1 ? Response.json(upstream()) : new Response('down', { status: 503 });
    },
  });
  const server = createAppServer({ root, api });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const get = (query) => new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: server.address().port, path: `/api/weather?${query}`,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
  const success = await get('lat=33.4&lng=126.5');
  assert.equal(success.status, 200);
  assert.equal(success.body.available, true);
  assert.equal(success.headers['cache-control'], 'no-store');
  assert.equal(success.headers['set-cookie'], undefined);
  await get('lat=33.4&lng=126.5');
  assert.equal(calls, 1);
  for (const query of ['lat=0&lng=0', 'lat=33.4', 'lat=NaN&lng=126.5', 'lat=&lng=126.5', 'lat=33.4&lat=33.5&lng=126.5']) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.equal(calls, 1);
  const failed = await get('lat=33.41&lng=126.5');
  assert.equal(failed.status, 503);
  assert.equal(failed.body.available, false);
  assert.equal(failed.body.current, null);
  assert.deepEqual(failed.body.daily, []);
  assert.equal(failed.headers['cache-control'], 'no-store');
});
