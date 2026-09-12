import test from 'node:test';
import assert from 'node:assert/strict';
import { createKakaoService, KakaoError } from '../server/kakao.mjs';

const KEY = 'fixture-discovery-'.repeat(3);
const NOW = Date.parse('2026-09-12T03:04:05Z');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});

function request(overrides = {}) {
  return {
    query: '', category: '맛집', scope: 'all',
    center: { lat: 33.45, lng: 126.55 }, page: 1, ...overrides,
  };
}

function canonical() {
  return {
    id: 'osm:node:42', name: '바람국수', name_en: null,
    category: '맛집', source: 'osm', lat: 33.45, lng: 126.55,
  };
}

function document(id = '101', overrides = {}) {
  return {
    id, place_name: '바람국수', category_name: '음식점 > 한식 > 국수',
    category_group_code: 'FD6', category_group_name: '음식점',
    phone: '064-123-4567', address_name: '제주특별자치도 제주시 예시로 1',
    road_address_name: '', x: '126.55', y: '33.4501', distance: '11',
    place_url: `http://place.map.kakao.com/${id}`, ...overrides,
  };
}

function page(documents = [], { total = documents.length, pageable = total, end = true } = {}) {
  return { meta: { total_count: total, pageable_count: pageable, is_end: end }, documents };
}

function documents(length) {
  return Array.from({ length }, (_, index) => document(String(index + 101)));
}

function service(t, options = {}) {
  const instance = createKakaoService({
    key: KEY, clock: () => NOW, consumeBudget: async () => {},
    fetch: async () => Response.json(page([document()])), ...options,
  });
  t.after(() => instance.close());
  assert.equal(typeof instance.search, 'function', 'Discovery search must be implemented');
  return instance;
}

function safeError(code, status) {
  return (error) => {
    assert.ok(error instanceof KakaoError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(KEY));
    assert.doesNotMatch(error.message, /private upstream|response-body-marker|bad-query-marker/);
    return true;
  };
}

function abortError(error) {
  assert.equal(error.name, 'AbortError');
  assert.ok(!String(error.stack).includes(KEY));
  return true;
}

test('category discovery uses the fixed Jeju endpoint and returns the normalized provider page', async (t) => {
  let sent;
  const input = Object.freeze(request({ center: Object.freeze({ lat: 33.45, lng: 126.55 }) }));
  const lookup = service(t, {
    fetch: async (url, options) => {
      sent = { url: new URL(url), options };
      return Response.json(page([document('101', { photos: ['ignored'], hours: 'ignored' })]));
    },
  });
  assert.deepEqual(await lookup.search(input), {
    items: [{
      id: '101', name: '바람국수', category: '음식점 > 한식 > 국수',
      group: 'FD6', groupName: '음식점', address: '제주특별자치도 제주시 예시로 1',
      road_address: null, phone: '064-123-4567', url: 'https://place.map.kakao.com/101',
      lng: 126.55, lat: 33.4501, providerDistance: 11,
    }],
    total: 1, pageable: 1, page: 1, page_size: 15, end: true, truncated: false,
    queried_at: '2026-09-12T03:04:05.000Z',
  });
  assert.equal(sent.url.origin, 'https://dapi.kakao.com');
  assert.equal(sent.url.pathname, '/v2/local/search/category.json');
  assert.deepEqual(Object.fromEntries(sent.url.searchParams), {
    category_group_code: 'FD6', rect: '126.15,33.1,126.98,33.6',
    x: '126.55', y: '33.45', sort: 'distance', page: '1', size: '15',
  });
  assert.equal(sent.options.method, 'GET');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.body, undefined);
  assert.equal(new Headers(sent.options.headers).get('Authorization'), `KakaoAK ${KEY}`);
  assert.ok(sent.options.signal instanceof AbortSignal);
  assert.ok(!sent.url.toString().includes(KEY));
});

test('commercial categories map to native codes and keywords choose the keyword endpoint', async (t) => {
  for (const [category, group] of [['맛집', 'FD6'], ['카페', 'CE7'], ['숙소', 'AD5'], ['주차장', 'PK6']]) {
    for (const keyword of ['', '  바람 국수  ']) {
      let sent;
      const lookup = service(t, {
        fetch: async (url) => {
          sent = new URL(url);
          return Response.json(page([document('101', { category_group_code: group })]));
        },
      });
      const result = await lookup.search(request({ category, query: keyword }));
      assert.equal(sent.origin, 'https://dapi.kakao.com');
      assert.equal(sent.pathname, `/v2/local/search/${keyword ? 'keyword' : 'category'}.json`);
      assert.equal(sent.searchParams.get('query'), keyword ? '바람 국수' : null);
      assert.equal(sent.searchParams.get('category_group_code'), group);
      assert.equal(result.items[0].group, group);
    }
  }
});

test('keyword-only discovery accepts other native groups and uncoded places without name matching', async (t) => {
  let query;
  const lookup = service(t, {
    fetch: async (url) => {
      query = new URL(url).searchParams;
      return Response.json(page([
        document('101', { place_name: '해변 전망대', category_group_code: 'AT4' }),
        document('102', { place_name: '산봉우리', category_group_code: '', category_name: '여행 > 관광,명소 > 산봉우리' }),
      ]));
    },
  });
  const result = await lookup.search(request({ query: '풍경', category: '' }));
  assert.equal(query.has('category_group_code'), false);
  assert.equal(query.get('query'), '풍경');
  assert.deepEqual(result.items.map(({ id, group }) => [id, group]), [['101', 'AT4'], ['102', '']]);
});

test('view search uses the supplied rectangle and accepts its exact edges', async (t) => {
  let query;
  const lookup = service(t, {
    fetch: async (url) => {
      query = new URL(url).searchParams;
      return Response.json(page([
        document('101', { x: '126.4', y: '33.4' }),
        document('102', { x: '126.6', y: '33.5' }),
      ]));
    },
  });
  const result = await lookup.search(request({ scope: 'view', bounds: [126.4, 33.4, 126.6, 33.5] }));
  assert.equal(query.get('rect'), '126.4,33.4,126.6,33.5');
  assert.equal(query.has('radius'), false);
  assert.equal(result.items.length, 2);
});

test('all scope always uses Jeju while nearby uses only its center and radius', async (t) => {
  const queries = [];
  const lookup = service(t, {
    fetch: async (url) => { queries.push(new URL(url).searchParams); return Response.json(page([document()])); },
  });
  await lookup.search(request({ bounds: [126.4, 33.4, 126.6, 33.5], radius_m: 1000 }));
  await lookup.search(request({ scope: 'nearby', radius_m: 200 }));
  assert.equal(queries[0].get('rect'), '126.15,33.1,126.98,33.6');
  assert.equal(queries[0].has('radius'), false);
  assert.equal(queries[1].get('radius'), '200');
  assert.equal(queries[1].has('rect'), false);
  for (const query of queries) {
    assert.equal(query.get('x'), '126.55');
    assert.equal(query.get('y'), '33.45');
    assert.equal(query.get('sort'), 'distance');
  }
});

test('invalid requests fail with a safe 400 before reserving budget or fetching', async (t) => {
  let calls = 0;
  const messages = new Set();
  const lookup = service(t, {
    consumeBudget: async () => { calls++; },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  for (const input of [
    null, [], 'bad-query-marker',
    request({ query: null }), request({ query: {} }), request({ query: 'a'.repeat(201) }),
    request({ query: 'bad-query-marker\u0000' }), request({ query: KEY }),
    request({ query: '', category: '' }), request({ query: '   ', category: '' }),
    request({ category: '관광지' }), request({ category: 'constructor' }), request({ category: null }),
    request({ scope: 'world' }), request({ scope: null }),
    request({ center: null }), request({ center: { lat: '33.45', lng: 126.55 } }),
    request({ center: { lat: 33.45, lng: Infinity } }), request({ center: { lat: NaN, lng: 126.55 } }),
    request({ center: { lat: 37, lng: 127 } }),
    request({ page: 0 }), request({ page: 4 }), request({ page: 1.5 }), request({ page: '1' }), request({ page: NaN }),
    request({ scope: 'view' }), request({ bounds: null }), request({ bounds: [126.4, 33.4, 126.6] }),
    request({ bounds: [126.4, 33.4, 126.6, 33.5, 1] }),
    request({ bounds: [126.6, 33.4, 126.4, 33.5] }), request({ bounds: [126.4, 33.5, 126.6, 33.4] }),
    request({ bounds: [126.4, 33.4, 126.4, 33.5] }), request({ bounds: [126.4, 33.4, 126.6, 33.4] }),
    request({ bounds: [126.14, 33.4, 126.6, 33.5] }), request({ bounds: [126.4, 33.4, 126.99, 33.5] }),
    request({ bounds: [126.4, 33.09, 126.6, 33.5] }), request({ bounds: [126.4, 33.4, 126.6, 33.61] }),
    request({ bounds: [126.4, 33.4, Infinity, 33.5] }), request({ bounds: ['126.4', 33.4, 126.6, 33.5] }),
    request({ scope: 'nearby' }), request({ scope: 'nearby', radius_m: 99 }),
    request({ scope: 'nearby', radius_m: 20001 }), request({ radius_m: 100.5 }),
    request({ radius_m: '200' }), request({ radius_m: NaN }), request({ radius_m: null }),
  ]) {
    await assert.rejects(lookup.search(input), (error) => {
      safeError('kakao_invalid_query', 400)(error);
      messages.add(error.message);
      return true;
    });
  }
  assert.equal(calls, 0);
  assert.equal(messages.size, 1);
});

test('valid query, radius and Jeju boundary values remain accepted', async (t) => {
  const lookup = service(t, { fetch: async () => Response.json(page()) });
  for (const input of [
    request({ query: '가'.repeat(200), category: '' }), request({ query: '   ' }),
    request({ scope: 'nearby', radius_m: 100 }), request({ scope: 'nearby', radius_m: 20000 }),
    request({ center: { lat: 33.1, lng: 126.15 } }), request({ center: { lat: 33.6, lng: 126.98 } }),
    request({ scope: 'view', bounds: [126.15, 33.1, 126.98, 33.6] }),
  ]) {
    assert.deepEqual((await lookup.search(input)).items, []);
  }
});

test('search fetches one requested page and reports accessible counts and truncation honestly', async (t) => {
  for (const [number, total, pageable, rows, providerEnd, accessible, end, truncated] of [
    [1, 16, 16, 15, false, 16, false, false],
    [2, 16, 16, 1, true, 16, true, false],
    [3, 31, 31, 1, true, 31, true, false],
    [1, 100, 45, 15, false, 45, false, true],
    [3, 100, 100, 15, false, 45, true, true],
    [3, 45, 45, 15, true, 45, true, false],
    [1, 100, 16, 15, false, 16, false, true],
  ]) {
    const requests = [];
    let reservations = 0;
    const lookup = service(t, {
      consumeBudget: async () => { reservations++; },
      fetch: async (url) => {
        requests.push(new URL(url).searchParams.get('page'));
        return Response.json(page(documents(rows), { total, pageable, end: providerEnd }));
      },
    });
    const result = await lookup.search(request({ page: number }));
    assert.equal(result.items.length, rows);
    assert.deepEqual({ ...result, items: [] }, {
      items: [], total, pageable: accessible, page: number, page_size: 15, end, truncated,
      queried_at: '2026-09-12T03:04:05.000Z',
    });
    assert.deepEqual(requests, [String(number)]);
    assert.equal(reservations, 1);
  }
});

test('empty pages beyond accessible results are valid without requesting earlier pages', async (t) => {
  for (const [number, total, pageable] of [[3, 16, 16], [2, 0, 0], [1, 0, 0], [3, 100, 20]]) {
    let calls = 0;
    const lookup = service(t, {
      fetch: async () => { calls++; return Response.json(page([], { total, pageable })); },
    });
    assert.deepEqual(await lookup.search(request({ page: number })), {
      items: [], total, pageable, page: number, page_size: 15,
      end: true, truncated: total > pageable, queried_at: '2026-09-12T03:04:05.000Z',
    });
    assert.equal(calls, 1);
  }
});

test('malformed or incomplete pagination cannot become a discovery page', async (t) => {
  for (const [number, raw] of [
    [1, { documents: [], meta: null }],
    [1, page([document()], { total: '1' })], [1, page([document()], { total: -1 })],
    [1, page([document()], { total: 1.5 })], [1, page([document()], { total: 1, pageable: 2 })],
    [1, page([document()], { total: 2 })], [1, page([document()], { total: 1, end: false })],
    [1, page(documents(15), { total: 16, end: true })], [1, page(documents(16))],
    [2, page([], { total: 16 })], [3, page([document()], { total: 16 })],
    [3, page([], { total: 16, end: false })],
  ]) {
    const lookup = service(t, { fetch: async () => Response.json(raw) });
    await assert.rejects(lookup.search(request({ page: number })), safeError('kakao_invalid_response', 502));
  }
});

test('identical IDs coalesce but conflicting duplicate records fail closed', async (t) => {
  const identical = service(t, { fetch: async () => Response.json(page([document(), document()])) });
  assert.deepEqual((await identical.search(request())).items.map(({ id }) => id), ['101']);
  for (const changes of [
    { place_name: '다른 장소' }, { phone: '064-999-9999' },
    { x: '126.551' }, { category_name: '음식점 > 분식' }, { category_group_code: 'CE7' },
  ]) {
    const lookup = service(t, {
      fetch: async () => Response.json(page([document(), document('101', changes)])),
    });
    await assert.rejects(lookup.search(request({ query: '식당', category: '' })), safeError('kakao_invalid_response', 502));
  }
});

test('category filters must be obeyed even when detailed categories look compatible', async (t) => {
  for (const group of ['CE7', '', 'AD5']) {
    for (const query of ['', '바람']) {
      const lookup = service(t, {
        fetch: async () => Response.json(page([document(), document('102', { category_group_code: group })])),
      });
      await assert.rejects(lookup.search(request({ query })), safeError('kakao_invalid_response', 502));
    }
  }
});

test('all result records must remain inside Jeju and the requested scope', async (t) => {
  for (const [input, changes] of [
    [request(), { x: '126.1499' }], [request(), { y: '33.6001' }], [request(), { x: '127', y: '37' }],
    [request({ scope: 'view', bounds: [126.4, 33.4, 126.6, 33.5] }), { x: '126.60001' }],
    [request({ scope: 'view', bounds: [126.4, 33.4, 126.6, 33.5] }), { y: '33.39999' }],
    [request({ scope: 'nearby', radius_m: 200 }), { y: '33.4517992', distance: '0' }],
    [request({ scope: 'nearby', radius_m: 200 }), { x: '126.5524', y: '33.45', distance: '0' }],
  ]) {
    const lookup = service(t, {
      fetch: async () => Response.json(page([document(), document('102', changes)])),
    });
    await assert.rejects(lookup.search(input), safeError('kakao_invalid_response', 502));
  }
  const inside = service(t, {
    fetch: async () => Response.json(page([document('101', { y: '33.4517977' })])),
  });
  assert.equal((await inside.search(request({ scope: 'nearby', radius_m: 200 }))).items.length, 1);
});

test('discovery retains strict numeric IDs, bounded field types and exact provider URLs', async (t) => {
  for (const changes of [
    { id: 'not-numeric' }, { id: 101 }, { x: null }, { y: 'Infinity' },
    { place_name: {} }, { phone: '0'.repeat(1000) }, { category_group_code: null },
    { place_url: 'https://place.map.kakao.com/102' },
    { place_url: 'https://place.map.kakao.com.evil.example/101' },
    { place_url: 'https://user@place.map.kakao.com/101' },
    { place_url: 'https://place.map.kakao.com:443/101' },
    { place_url: 'https://place.map.kakao.com/101?tracking=1' },
    { place_url: 'https://place.map.kakao.com/101#fragment' },
    { place_url: 'https://place.map.kakao.com/other/../101' },
    { place_url: 'javascript:alert(101)' },
  ]) {
    const lookup = service(t, { fetch: async () => Response.json(page([document('101', changes)])) });
    await assert.rejects(lookup.search(request()), safeError('kakao_invalid_response', 502));
  }
});

test('key echoes and private provider diagnostics never become discovery output or public errors', async (t) => {
  for (const [fetch, code, status] of [
    [async () => { throw new Error(`private upstream ${KEY}`); }, 'kakao_unavailable', 503],
    [async () => new Response(`response-body-marker ${KEY}`, { status: 401 }), 'kakao_unavailable', 503],
    [async () => new Response(`{"response-body-marker":"${KEY}"`, {
      headers: { 'content-type': 'application/json' },
    }), 'kakao_invalid_response', 502],
    [async () => Response.json(page([document('101', { phone: KEY })])), 'kakao_invalid_response', 502],
    [async () => Response.json({ ...page([document()]), diagnostic: KEY }), 'kakao_invalid_response', 502],
  ]) {
    const lookup = service(t, { fetch });
    await assert.rejects(lookup.search(request()), safeError(code, status));
  }
});

test('discovery bounds streamed bodies and cancels oversize responses without Content-Length', async (t) => {
  let cancelled = false;
  let reads = 0;
  const lookup = service(t, {
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(lookup.search(request()), safeError('kakao_invalid_response', 502));
  await tick();
  assert.equal(cancelled, true);
  assert.ok(reads <= 6);
});

test('search and lookup share two slots and cancellation does not free an ignored fetch', { timeout: 1500 }, async (t) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const caller = new AbortController();
  const signals = [];
  let reservations = 0;
  const lookup = service(t, {
    consumeBudget: async () => { reservations++; },
    fetch: (_url, { signal }) => {
      signals.push(signal);
      return signals.length <= 2 ? gates[signals.length - 1].promise : Promise.resolve(Response.json(page([document()])));
    },
  });
  const search = lookup.search(request(), { signal: caller.signal });
  const rejected = assert.rejects(search, abortError);
  const match = lookup.lookup(canonical());
  await tick();
  await assert.rejects(lookup.search(request()), safeError('kakao_busy', 429));
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_busy', 429));
  assert.equal(reservations, 2);
  assert.equal(signals.length, 2);
  caller.abort(new Error(KEY));
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_busy', 429));
  gates[0].resolve(Response.json(page([document()])));
  await tick();
  assert.equal((await lookup.search(request())).items.length, 1);
  gates[1].resolve(Response.json(page([document()])));
  assert.equal((await match).status, 'matched');
  assert.equal(reservations, 3);
});

test('search awaits quota before HTTP and propagates parent quota errors unchanged', async (t) => {
  const gate = Promise.withResolvers();
  const failure = Object.assign(new Error('Quota exhausted'), { status: 429, code: 'quota_exceeded' });
  let reservations = 0;
  let calls = 0;
  const signals = [];
  const lookup = service(t, {
    consumeBudget: ({ signal }) => {
      signals.push(signal);
      reservations++;
      if (reservations === 1) return gate.promise;
      throw failure;
    },
    fetch: async (_url, { signal }) => {
      calls++;
      assert.equal(signal, signals[0]);
      return Response.json(page([document()]));
    },
  });
  const pending = lookup.search(request());
  await tick();
  assert.equal(reservations, 1);
  assert.equal(calls, 0);
  gate.resolve();
  assert.equal((await pending).items.length, 1);
  await assert.rejects(lookup.search(request()), (error) => error === failure);
  assert.equal(calls, 1);
});

test('disabled discovery and missing quota injection fail closed before provider calls', async (t) => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(page()); };
  for (const key of [undefined, null, '', '   ']) {
    const lookup = service(t, { key, fetch });
    assert.equal(lookup.enabled, false);
    await assert.rejects(lookup.search(request()), safeError('kakao_unavailable', 503));
  }
  const noBudget = service(t, { consumeBudget: undefined, fetch });
  await assert.rejects(noBudget.search(request()), safeError('kakao_unavailable', 503));
  assert.equal(calls, 0);
});

test('pre-aborted searches do not reserve quota or fetch', async (t) => {
  const caller = new AbortController();
  caller.abort(new Error(KEY));
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: async () => { calls++; },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  await assert.rejects(lookup.search(request(), { signal: caller.signal }), abortError);
  assert.equal(calls, 0);
});

test('cancelled quota admission cannot start a late discovery request', { timeout: 1500 }, async (t) => {
  const gate = Promise.withResolvers();
  const caller = new AbortController();
  let quotaSignal;
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: ({ signal }) => { quotaSignal = signal; return gate.promise; },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  const pending = lookup.search(request(), { signal: caller.signal });
  const rejected = assert.rejects(pending, abortError);
  await tick();
  caller.abort();
  await rejected;
  assert.equal(quotaSignal.aborted, true);
  gate.resolve();
  await tick();
  assert.equal(calls, 0);
});

test('the default 6500 ms deadline holds ignored fetch slots through late cleanup', { timeout: 1500 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = Promise.withResolvers();
  let signal;
  let calls = 0;
  let cancelled = false;
  const lookup = service(t, {
    maxConcurrent: 1,
    fetch: (_url, options) => { calls++; signal = options.signal; return gate.promise; },
  });
  let settled = false;
  let failure;
  const pending = lookup.search(request());
  pending.then(() => { settled = true; }, (error) => { settled = true; failure = error; });
  await tick();
  t.mock.timers.tick(6499);
  await tick();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(settled, true);
  safeError('kakao_unavailable', 503)(failure);
  assert.equal(signal.aborted, true);
  await assert.rejects(lookup.search(request()), safeError('kakao_busy', 429));
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_busy', 429));
  assert.equal(calls, 1);
  gate.resolve(new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.equal(cancelled, true);
});

test('a non-cooperating quota callback retains its shared slot after the search deadline', { timeout: 1500 }, async (t) => {
  const gate = Promise.withResolvers();
  let reservations = 0;
  let calls = 0;
  let signal;
  const lookup = service(t, {
    maxConcurrent: 1, timeoutMs: 20,
    consumeBudget: (options) => {
      reservations++;
      signal = options.signal;
      return reservations === 1 ? gate.promise : Promise.resolve();
    },
    fetch: async () => { calls++; return Response.json(page([document()])); },
  });
  await assert.rejects(lookup.search(request()), safeError('kakao_unavailable', 503));
  assert.equal(signal.aborted, true);
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_busy', 429));
  assert.equal(reservations, 1);
  gate.resolve();
  await tick();
  assert.equal(calls, 0);
  assert.equal((await lookup.search(request())).items.length, 1);
  assert.equal(calls, 1);
});

test('search body deadlines do not wait for non-cooperating stream cancellation', { timeout: 1500 }, async (t) => {
  let cancelled = false;
  const lookup = service(t, {
    maxConcurrent: 1, timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({
      pull: never,
      cancel() { cancelled = true; return never(); },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(lookup.search(request()), safeError('kakao_unavailable', 503));
  assert.equal(cancelled, true);
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_busy', 429));
});

test('provider AbortError stays an AbortError and close aborts both operation types', { timeout: 1500 }, async (t) => {
  const abortedProvider = service(t, {
    fetch: async () => { throw new DOMException(KEY, 'AbortError'); },
  });
  await assert.rejects(abortedProvider.search(request()), abortError);
  const signals = [];
  const lookup = service(t, {
    fetch: (_url, { signal }) => { signals.push(signal); return never(); },
  });
  const stopped = [
    assert.rejects(lookup.search(request()), safeError('kakao_unavailable', 503)),
    assert.rejects(lookup.lookup(canonical()), safeError('kakao_unavailable', 503)),
  ];
  await tick();
  lookup.close();
  lookup.close();
  await Promise.all(stopped);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  await assert.rejects(lookup.search(request()), safeError('kakao_unavailable', 503));
  await assert.rejects(lookup.lookup(canonical()), safeError('kakao_unavailable', 503));
});

test('request snapshots survive caller mutation and sequential discovery never caches results', async (t) => {
  const gate = Promise.withResolvers();
  const input = request({ query: '바람', scope: 'view', bounds: [126.4, 33.4, 126.6, 33.5] });
  const queries = [];
  let now = NOW;
  const lookup = service(t, {
    clock: () => now, consumeBudget: () => gate.promise,
    fetch: async (url) => {
      queries.push(new URL(url).searchParams);
      return Response.json(page([document(queries.length === 1 ? '101' : '102')]));
    },
  });
  const pending = lookup.search(input);
  input.query = 'changed-by-owner';
  input.center.lat = 37;
  input.bounds[0] = 120;
  now += 1000;
  gate.resolve();
  const first = await pending;
  assert.equal(queries[0].get('query'), '바람');
  assert.equal(queries[0].get('y'), '33.45');
  assert.equal(queries[0].get('rect'), '126.4,33.4,126.6,33.5');
  assert.equal(first.queried_at, '2026-09-12T03:04:06.000Z');
  assert.equal(first.items[0].id, '101');
  const second = await lookup.search(request());
  assert.equal(second.items[0].id, '102');
  assert.equal(queries.length, 2);
  assert.equal(input.query, 'changed-by-owner');
  assert.equal(input.bounds[0], 120);
});
