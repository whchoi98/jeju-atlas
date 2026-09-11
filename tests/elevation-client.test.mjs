import test from 'node:test';
import assert from 'node:assert/strict';

const elevation = await import('../src/elevation-profile.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const coordinates = [[126.4, 33.3], [126.401, 33.301]];
const reply = (values = [0, 83]) => ({
  available: true, elevations_m: values,
  source: { name: 'Mapzen / AWS Terrain Tiles · USGS', url: 'https://registry.opendata.aws/terrain-tiles/' },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('elevation sends only bounded coordinates and the session proof, preserving real zero and missing heights', async () => {
  assert.equal(typeof elevation.fetchElevation, 'function');
  const calls = [];
  const result = await elevation.fetchElevation(coordinates, new AbortController().signal, {
    config: async () => ({ routing: { csrf_token: 'fixture-proof' } }),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return json(reply([0, null]));
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/elevation');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers['X-Atlas-CSRF'], 'fixture-proof');
  assert.deepEqual(JSON.parse(calls[0][1].body), { coordinates });
  assert.deepEqual(result.elevations_m, [0, null]);
});

test('one exact pre-invocation CSRF failure refreshes the proof without changing the submitted coordinates', async () => {
  assert.equal(typeof elevation.fetchElevation, 'function');
  const input = structuredClone(coordinates), sent = [], refreshed = [];
  const result = await elevation.fetchElevation(input, new AbortController().signal, {
    config: async refresh => { refreshed.push(refresh); return { routing: { csrf_token: refresh ? 'new-proof' : 'old-proof' } }; },
    fetchImpl: async (_url, init) => {
      sent.push(init);
      if (sent.length === 1) { input[0][0] = 0; return json({ code: 'csrf_invalid' }, 403); }
      return json(reply());
    },
  });
  assert.deepEqual(refreshed, [false, true]);
  assert.deepEqual(sent.map(init => init.headers['X-Atlas-CSRF']), ['old-proof', 'new-proof']);
  assert.equal(sent[0].body, sent[1].body);
  assert.deepEqual(result.elevations_m, [0, 83]);
});

test('unrelated HTTP failures and transport failures never cause automatic elevation retries', async () => {
  assert.equal(typeof elevation.fetchElevation, 'function');
  for (const [status, code] of [[403, 'origin_forbidden'], [429, 'rate_limited'], [503, 'elevation_unavailable']]) {
    let calls = 0;
    await assert.rejects(elevation.fetchElevation(coordinates, new AbortController().signal, {
      config: async () => ({ routing: { csrf_token: 'proof' } }),
      fetchImpl: async () => { calls++; return json({ code }, status); },
    }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(elevation.fetchElevation(coordinates, new AbortController().signal, {
    config: async () => ({ routing: { csrf_token: 'proof' } }),
    fetchImpl: async () => { calls++; throw new TypeError('network'); },
  }));
  assert.equal(calls, 1);
});

test('auth recovery has a total budget of one and cancellation prevents its second POST', async () => {
  assert.equal(typeof elevation.fetchElevation, 'function');
  let calls = 0;
  await assert.rejects(elevation.fetchElevation(coordinates, new AbortController().signal, {
    config: async () => ({ routing: { csrf_token: 'proof' } }),
    fetchImpl: async () => { calls++; return json({ code: calls === 1 ? 'session_required' : 'csrf_invalid' }, calls === 1 ? 401 : 403); },
  }));
  assert.equal(calls, 2);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(elevation.fetchElevation(coordinates, controller.signal, {
    config: async refresh => {
      if (refresh) controller.abort();
      return { routing: { csrf_token: 'proof' } };
    },
    fetchImpl: async () => { calls++; return json({ code: 'csrf_invalid' }, 403); },
  }));
  assert.equal(calls, 1);
});

test('malformed or oversized elevation results cannot be plotted as trustworthy heights or source links', async () => {
  assert.equal(typeof elevation.fetchElevation, 'function');
  for (const value of [
    reply([20]), reply(['0', 20]), reply([NaN, 20]),
    { ...reply(), source: { name: 'DEM', url: 'javascript:alert(1)' } },
    { ...reply(), source: { name: 'DEM', url: 'https://example.org/?api_key=private' } },
    { ...reply(), padding: 'x'.repeat(70000) },
  ]) {
    // NaN cannot exist in JSON; test a non-finite-looking string explicitly.
    if (Number.isNaN(value.elevations_m[0])) value.elevations_m[0] = 'NaN';
    await assert.rejects(elevation.fetchElevation(coordinates, new AbortController().signal, {
      config: async () => ({ routing: { csrf_token: 'proof' } }),
      fetchImpl: async () => json(value),
    }));
  }
  let calls = 0;
  await assert.rejects(elevation.fetchElevation(Array.from({ length: 257 }, () => coordinates[0]), new AbortController().signal, {
    config: async () => ({ routing: { csrf_token: 'proof' } }),
    fetchImpl: async () => { calls++; return json(reply()); },
  }));
  assert.equal(calls, 0);
});
