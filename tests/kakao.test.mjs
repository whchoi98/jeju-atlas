import test from 'node:test';
import assert from 'node:assert/strict';

let kakaoModule;
try {
  kakaoModule = await import('../server/kakao.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const KEY = 'fixture-kakao-'.repeat(3);
const NOW = Date.parse('2026-09-11T03:04:05Z');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});

function canonical(overrides = {}) {
  return {
    id: 'osm:node:42', name: '돌담카페', name_en: 'Doldam Cafe',
    category: '카페', source: 'osm', lat: 33.45, lng: 126.55,
    ...overrides,
  };
}

function document(id = '101', overrides = {}) {
  return {
    id, place_name: '돌담카페', category_name: '음식점 > 카페',
    category_group_code: 'CE7', category_group_name: '카페',
    phone: '064-123-4567', address_name: '제주특별자치도 제주시 돌담길 1',
    road_address_name: '제주특별자치도 제주시 돌담로 1',
    x: '126.55', y: '33.45', distance: '0',
    place_url: `http://place.map.kakao.com/${id}`,
    ...overrides,
  };
}

function page(documents = [], { total = documents.length, pageable = total, end = true } = {}) {
  return {
    meta: {
      total_count: total, pageable_count: pageable, is_end: end,
      same_name: { region: [], keyword: '돌담카페', selected_region: '' },
    },
    documents,
  };
}

function unrelated(count, firstId = 200, group = 'CE7') {
  return Array.from({ length: count }, (_, index) => document(String(firstId + index), {
    place_name: `다른 카페 ${firstId + index}`, category_group_code: group,
  }));
}

function service(t, options = {}) {
  assert.equal(typeof kakaoModule?.createKakaoService, 'function', 'Kakao service must be implemented');
  const instance = kakaoModule.createKakaoService({
    key: KEY, clock: () => NOW,
    fetch: async () => Response.json(page([document()])),
    consumeBudget: async () => {},
    ...options,
  });
  t.after(() => instance.close());
  return instance;
}

function kakaoError(code, status) {
  return (error) => {
    assert.ok(error instanceof kakaoModule.KakaoError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(KEY));
    assert.doesNotMatch(error.message, /private upstream|response-body-marker/);
    return true;
  };
}

function abortError(error) {
  assert.equal(error.name, 'AbortError');
  assert.ok(!String(error.stack).includes(KEY));
  return true;
}

function emptyResult(status, canonicalId = 'osm:node:42') {
  return {
    available: true, status, canonical_id: canonicalId,
    queried_at: '2026-09-11T03:04:05.000Z', source: 'Kakao Local', place: null,
  };
}

test('finds the exact place among unrelated keyword hits and returns only the shared DTO', async (t) => {
  let sent;
  const input = Object.freeze(canonical());
  const before = structuredClone(input);
  const lookup = service(t, {
    fetch: async (url, options) => {
      sent = { url: new URL(url), options };
      return Response.json(page([
        ...unrelated(2), document('101', { hours: 'invented', photos: ['invented'], facilities: {} }),
      ]));
    },
  });

  assert.equal(lookup.enabled, true);
  const result = await lookup.lookup(input);
  assert.deepEqual(result, {
    ...emptyResult('matched'),
    place: {
      id: '101', name: '돌담카페', category: '음식점 > 카페',
      address: '제주특별자치도 제주시 돌담길 1',
      road_address: '제주특별자치도 제주시 돌담로 1',
      phone: '064-123-4567', url: 'https://place.map.kakao.com/101',
    },
    match: { method: 'name_category_distance', distance_m: 0 },
  });
  assert.deepEqual(input, before);
  assert.equal(sent.url.origin, 'https://dapi.kakao.com');
  assert.equal(sent.url.pathname, '/v2/local/search/keyword.json');
  assert.deepEqual(Object.fromEntries(sent.url.searchParams), {
    query: '돌담카페', x: '126.55', y: '33.45', radius: '200', size: '15', page: '1',
    category_group_code: 'CE7',
  });
  assert.equal(sent.options.method, 'GET');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(new Headers(sent.options.headers).get('Authorization'), `KakaoAK ${KEY}`);
  assert.ok(sent.options.signal instanceof AbortSignal);
  assert.equal(sent.options.body, undefined);
  assert.ok(!sent.url.toString().includes(KEY));
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('normalizes only NFKC, case, punctuation and whitespace, including a complete English alias', async (t) => {
  for (const [name, expected] of [
    ['돌담 카페!', 'matched'],
    ['ＤＯＬＤＡＭ　ＣＡＦＥ', 'matched'],
    ['Doldam-Cafe', 'matched'],
    ['돌담카페 제주점', 'not_found'],
    ['큰돌담카페', 'not_found'],
    ['Doldam', 'not_found'],
    ['Doldam Cafè', 'not_found'],
    ['돌담+카페', 'not_found'],
    ['돌담\u200b카페', 'not_found'],
  ]) {
    const lookup = service(t, { fetch: async () => Response.json(page([document('101', { place_name: name })])) });
    assert.equal((await lookup.lookup(canonical())).status, expected, name);
  }
});

test('homonyms with distinct eligible IDs remain ambiguous', async (t) => {
  const lookup = service(t, { fetch: async () => Response.json(page([document(), document('102')])) });
  assert.deepEqual(await lookup.lookup(canonical()), emptyResult('ambiguous'));
});

test('queries every compatible group, including when only the second group contains the match', async (t) => {
  for (const [category, allowed] of [
    ['맛집', ['FD6']], ['카페', ['CE7']], ['주차장', ['PK6']],
    ['관광지', ['AT4', 'CT1']], ['오름', ['AT4']], ['해변', ['AT4']],
    ['올레길', ['AT4']], ['박물관', ['CT1']], ['시장', ['MT1', 'AT4']],
  ]) {
    for (const group of allowed) {
      const requests = [];
      const lookup = service(t, {
        fetch: async (url) => {
          const params = new URL(url).searchParams;
          const requested = params.get('category_group_code');
          requests.push([requested, params.get('page')]);
          return Response.json(page(requested === group
            ? [document('102', { category_group_code: group }), ...unrelated(1, 200, group)]
            : []));
        },
      });
      const result = await lookup.lookup(canonical({ category }));
      assert.equal(result.status, 'matched', `${category}/${group}`);
      assert.equal(result.place.id, '102');
      assert.deepEqual(requests, allowed.map((code) => [code, '1']));
    }
  }
});

test('category filters recover an exact landmark otherwise buried in capped unrelated keyword hits', async (t) => {
  const requests = [];
  const lookup = service(t, {
    fetch: async (url) => {
      const params = new URL(url).searchParams;
      const group = params.get('category_group_code');
      requests.push(group);
      if (group === 'AT4') {
        return Response.json(page([document('101', { place_name: '성산일출봉', category_group_code: 'AT4' })]));
      }
      if (group === 'CT1') return Response.json(page());
      return Response.json(page(unrelated(15, Number(params.get('page')) * 1000), {
        total: 100, pageable: 45, end: params.get('page') === '3',
      }));
    },
  });
  const result = await lookup.lookup(canonical({ name: '성산일출봉', category: '관광지' }));
  assert.equal(result.status, 'matched');
  assert.equal(result.place.id, '101');
  assert.deepEqual(requests, ['AT4', 'CT1']);
});

test('an ignored category filter fails even when the unexpected group is otherwise compatible', async (t) => {
  for (const [category, group] of [['카페', 'FD6'], ['관광지', 'CT1'], ['시장', 'AT4']]) {
    const lookup = service(t, {
      fetch: async () => Response.json(page([document('101', { category_group_code: group })])),
    });
    await assert.rejects(lookup.lookup(canonical({ category })), kakaoError('kakao_invalid_response', 502));
  }
  const laterGroup = service(t, {
    fetch: async (url) => Response.json(page(new URL(url).searchParams.get('category_group_code') === 'CT1'
      ? [document('102', { category_group_code: 'AT4', place_name: '관련 없는 이름' })]
      : [document('101', { category_group_code: 'AT4' })])),
  });
  await assert.rejects(laterGroup.lookup(canonical({ category: '관광지' })), kakaoError('kakao_invalid_response', 502));
});

test('an ignored category filter on a later page cannot prove completeness', async (t) => {
  let calls = 0;
  const lookup = service(t, {
    fetch: async () => Response.json(++calls === 1
      ? page([document(), ...unrelated(14)], { total: 16, end: false })
      : page([document('999', { category_group_code: 'FD6', place_name: '관련 없는 이름' })], { total: 16 })),
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  assert.equal(calls, 2);
});

test('homonyms in the second compatible category remain ambiguous', async (t) => {
  for (const [category, groups] of [['관광지', ['AT4', 'CT1']], ['시장', ['MT1', 'AT4']]]) {
    const requests = [];
    const lookup = service(t, {
      fetch: async (url) => {
        const group = new URL(url).searchParams.get('category_group_code') ?? groups[0];
        requests.push(group);
        return Response.json(page([document(group === groups[0] ? '101' : '102', { category_group_code: group })]));
      },
    });
    assert.deepEqual(await lookup.lookup(canonical({ category })), emptyResult('ambiguous'));
    assert.deepEqual(requests, groups);
  }
});

test('the second group still requires the exact full name and unrounded distance', async (t) => {
  for (const changes of [
    { place_name: '돌담카페 별관' }, { place_name: 'Doldam' }, { y: '33.4517992' },
  ]) {
    const requests = [];
    const lookup = service(t, {
      fetch: async (url) => {
        const group = new URL(url).searchParams.get('category_group_code') ?? 'AT4';
        requests.push(group);
        return Response.json(page([document(group === 'CT1' ? '102' : '101', {
          category_group_code: group, ...(group === 'CT1' ? changes : {}),
        })]));
      },
    });
    const result = await lookup.lookup(canonical({ category: '관광지' }));
    assert.equal(result.status, 'matched');
    assert.equal(result.place.id, '101');
    assert.deepEqual(requests, ['AT4', 'CT1']);
  }
});

test('unsupported categories neither reserve quota nor fetch', async (t) => {
  let calls = 0;
  const lookup = service(t, {
    fetch: async () => { calls++; return Response.json(page()); },
    consumeBudget: async () => { calls++; },
  });
  for (const category of ['숙소', '학교', 'constructor']) {
    assert.deepEqual(await lookup.lookup(canonical({ category })), emptyResult('unsupported'));
  }
  assert.equal(calls, 0);
});

test('applies the unrounded 200 m OSM radius and 2000 m sample/curated/seed radius', async (t) => {
  for (const [source, y, expectedRadius, expectedStatus] of [
    ['osm', '33.4517977', '200', 'matched'],     // About 199.89 m.
    ['osm', '33.4517992', '200', 'not_found'],   // About 200.06 m, rounds to 200.
    ['OSM', '33.4517992', '200', 'not_found'],
    ['sample', '33.467985', '2000', 'matched'],  // About 1999.84 m.
    ['curated', '33.46', '2000', 'matched'],
    ['seed', '33.46', '2000', 'matched'],
    ['sample', '33.467987', '2000', 'not_found'], // About 2000.06 m.
    ['unknown', '33.46', '200', 'not_found'],
  ]) {
    let radius;
    const lookup = service(t, {
      fetch: async (url) => {
        radius = new URL(url).searchParams.get('radius');
        return Response.json(page([document('101', { y, distance: '0' })]));
      },
    });
    const result = await lookup.lookup(canonical({ source }));
    assert.equal(result.status, expectedStatus, `${source}/${y}`);
    assert.equal(radius, expectedRadius);
    if (result.match) assert.ok(result.match.distance_m <= Number(expectedRadius));
  }
});

test('uses longitude in distance calculations and excludes coordinates outside Jeju', async (t) => {
  for (const [input, x, y] of [
    [canonical(), '126.5524', '33.45'],
    [canonical({ source: 'sample', lat: 33.1 }), '126.55', '33.0999'],
    [canonical({ source: 'sample', lat: 33.6 }), '126.55', '33.6001'],
    [canonical({ source: 'sample', lng: 126.15 }), '126.1499', '33.45'],
    [canonical({ source: 'sample', lng: 126.98 }), '126.9801', '33.45'],
    [canonical(), '127', '37'],
  ]) {
    const lookup = service(t, { fetch: async () => Response.json(page([document('101', { x, y })])) });
    assert.deepEqual(await lookup.lookup(input), emptyResult('not_found'));
  }
});

test('invalid canonical coordinates fail before quota or provider work', async (t) => {
  let calls = 0;
  const lookup = service(t, {
    fetch: async () => { calls++; return Response.json(page()); },
    consumeBudget: async () => { calls++; },
  });
  for (const change of [{ lat: NaN }, { lng: Infinity }, { lat: 37 }, { lng: '126.55' }]) {
    await assert.rejects(lookup.lookup(canonical(change)), kakaoError('kakao_unavailable', 503));
  }
  assert.equal(calls, 0);
});

test('empty or absent optional contact fields stay null', async (t) => {
  const raw = document('101', { phone: '', address_name: null, road_address_name: '  ' });
  const lookup = service(t, { fetch: async () => Response.json(page([raw])) });
  const result = await lookup.lookup(canonical());
  assert.equal(result.place.phone, null);
  assert.equal(result.place.address, null);
  assert.equal(result.place.road_address, null);
});

test('only accepts an exact Kakao place URL for the same numeric ID', async (t) => {
  for (const place_url of [
    'https://place.map.kakao.com/102',
    'https://place.map.kakao.com.evil.example/101',
    'https://place.map.kakao.com@evil.example/101',
    'https://user@place.map.kakao.com/101',
    'https://place.map.kakao.com:443/101',
    'https://place.map.kakao.com/101?tracking=1',
    'https://place.map.kakao.com/101#fragment',
    'https://place.map.kakao.com/101/',
    'https://place.map.kakao.com/other/../101',
    'https://place.map.kakao.com/%31%30%31',
    'https://place.map.kakao.com\\@evil.example/101',
    'javascript:alert(101)',
    '//place.map.kakao.com/101',
  ]) {
    const lookup = service(t, { fetch: async () => Response.json(page([document('101', { place_url })])) });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502), place_url);
  }
});

test('validates bounded field types even on an unrelated keyword hit', async (t) => {
  for (const change of [
    { id: 'not-numeric' }, { id: 101 }, { id: '1'.repeat(80) },
    { place_name: '' }, { place_name: '가'.repeat(5000) }, { place_name: {} },
    { category_group_code: ['CE7'] }, { category_name: null },
    { phone: 641234567 }, { phone: '0'.repeat(1000) },
    { address_name: ['제주'] }, { road_address_name: '가'.repeat(5000) },
    { x: null }, { x: '' }, { x: ' ' }, { x: 'NaN' }, { y: 'Infinity' },
    { x: {} }, { y: true }, { x: '126.55oops' }, { x: '181' }, { y: '91' },
  ]) {
    const bad = document('102', { place_name: '관련 없는 장소', ...change });
    const lookup = service(t, { fetch: async () => Response.json(page([document(), bad])) });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  }
});

test('missing or malformed category codes cannot silently hide another possible match', async (t) => {
  for (const category_group_code of [undefined, null, ' ']) {
    const lookup = service(t, {
      fetch: async () => Response.json(page([document(), document('102', { category_group_code })])),
    });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  }
});

test('reads complete pages and awaits a quota reservation before every actual request', async (t) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const events = [];
  const quotaSignals = [];
  const lookup = service(t, {
    consumeBudget: ({ signal }) => {
      quotaSignals.push(signal);
      events.push(`budget${quotaSignals.length}`);
      return gates[quotaSignals.length - 1].promise;
    },
    fetch: async (url, { signal }) => {
      const number = Number(new URL(url).searchParams.get('page'));
      events.push(`fetch${number}`);
      assert.equal(signal, quotaSignals[number - 1]);
      return Response.json(number === 1
        ? page([document(), ...unrelated(14)], { total: 16, end: false })
        : page([document('999', { place_name: '다른 카페' })], { total: 16 }));
    },
  });
  let finished = false;
  const resultPromise = lookup.lookup(canonical()).then((result) => { finished = true; return result; });
  await tick();
  assert.deepEqual(events, ['budget1']);
  gates[0].resolve();
  await tick();
  assert.deepEqual(events, ['budget1', 'fetch1', 'budget2']);
  assert.equal(finished, false, 'a page-one candidate does not prove uniqueness');
  gates[1].resolve();
  const result = await resultPromise;
  assert.equal(result.status, 'matched');
  assert.equal(result.place.id, '101');
  assert.deepEqual(events, ['budget1', 'fetch1', 'budget2', 'fetch2']);
});

test('finds a homonym on a later page instead of declaring a page-one match unique', async (t) => {
  let calls = 0;
  const lookup = service(t, {
    fetch: async () => Response.json(++calls === 1
      ? page([document(), ...unrelated(14)], { total: 16, end: false })
      : page([document('999')], { total: 16 })),
  });
  assert.deepEqual(await lookup.lookup(canonical()), emptyResult('ambiguous'));
  assert.equal(calls, 2);
});

test('merges six complete group pages while reserving quota separately for every HTTP call', async (t) => {
  const requests = [];
  const budgetSignals = [];
  const lookup = service(t, {
    consumeBudget: async ({ signal }) => { budgetSignals.push(signal); },
    fetch: async (url, { signal }) => {
      const params = new URL(url).searchParams;
      const group = params.get('category_group_code') ?? 'AT4';
      const number = Number(params.get('page'));
      requests.push([group, number]);
      assert.equal(budgetSignals.length, requests.length);
      assert.equal(signal, budgetSignals[requests.length - 1]);
      const docs = unrelated(number === 3 ? 1 : 15, (group === 'AT4' ? 1000 : 5000) + number * 100, group);
      if (group === 'AT4' && number === 1) docs[0] = document('101', { category_group_code: group });
      return Response.json(page(docs, { total: 31, end: number === 3 }));
    },
  });
  const result = await lookup.lookup(canonical({ category: '관광지' }));
  assert.equal(result.status, 'matched', 'each group is complete even though merged results exceed 45 documents');
  assert.equal(result.place.id, '101');
  assert.deepEqual(requests, [['AT4', 1], ['AT4', 2], ['AT4', 3], ['CT1', 1], ['CT1', 2], ['CT1', 3]]);
  assert.equal(budgetSignals.length, 6);
  assert.ok(budgetSignals.every((signal) => signal === budgetSignals[0]));
});

test('waits for second-group quota and propagates its rejection without returning a partial match', async (t) => {
  const gate = Promise.withResolvers();
  const failure = Object.assign(new Error('Quota exhausted'), { status: 429, code: 'quota_exceeded' });
  let reservations = 0;
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: () => ++reservations === 1 ? Promise.resolve() : gate.promise,
    fetch: async () => { calls++; return Response.json(page([document('101', { category_group_code: 'AT4' })])); },
  });
  let settled = false;
  const pending = lookup.lookup(canonical({ category: '관광지' }));
  pending.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(reservations, 2);
  assert.equal(calls, 1);
  assert.equal(settled, false);
  const rejected = assert.rejects(pending, (error) => error === failure);
  gate.reject(failure);
  await rejected;
  assert.equal(calls, 1);
});

test('deduplicates identical provider IDs and rejects conflicting duplicate records', async (t) => {
  const identical = service(t, {
    fetch: async () => Response.json(page([document(), { ...document() }])),
  });
  assert.equal((await identical.lookup(canonical())).status, 'matched');
  for (const change of [
    { place_name: '다른 이름' }, { phone: '064-999-9999' },
    { x: '126.5501' }, { category_group_code: 'FD6' },
    { address_name: '다른 주소' },
  ]) {
    const lookup = service(t, {
      fetch: async () => Response.json(page([document(), document('101', change)])),
    });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  }
});

test('the same provider ID cannot represent conflicting records across category groups', async (t) => {
  for (const phone of ['064-123-4567', '064-999-9999']) {
    let calls = 0;
    const lookup = service(t, {
      fetch: async (url) => {
        calls++;
        const group = new URL(url).searchParams.get('category_group_code') ?? 'AT4';
        return Response.json(page([document('101', {
          category_group_code: group, ...(group === 'CT1' ? { phone } : {}),
        })]));
      },
    });
    await assert.rejects(lookup.lookup(canonical({ category: '관광지' })), kakaoError('kakao_invalid_response', 502));
    assert.equal(calls, 2);
  }
});

test('rejects incomplete pages, invalid metadata, count changes, and pages that make no progress', async (t) => {
  const first = page([document(), ...unrelated(14)], { total: 30, end: false });
  for (const responses of [
    [{ documents: [], meta: null }],
    [page([document()], { total: '1' })],
    [page([document()], { total: 1, pageable: 2 })],
    [page([document()], { total: 2 })],
    [page([document()], { total: 16, end: false })],
    [page([], { total: 1, end: false })],
    [page([document()], { total: 1, end: false })],
    [page(unrelated(16))],
    [first, page(unrelated(15, 500), { total: 31, end: false })],
    [first, page(first.documents, { total: 30 })],
    [first, page([], { total: 30 })],
    [first, page([document('101', { phone: '064-999-9999' }), ...unrelated(14, 500)], { total: 30 })],
  ]) {
    let calls = 0;
    const lookup = service(t, { fetch: async () => Response.json(responses[calls++]) });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
    assert.ok(calls <= 3);
  }
});

test('overlapping pages cannot prove completeness even when some new IDs make progress', async (t) => {
  let calls = 0;
  const lookup = service(t, {
    fetch: async () => Response.json(++calls === 1
      ? page([document(), ...unrelated(14)], { total: 30, end: false })
      : page([document(), ...unrelated(14, 500)], { total: 30 })),
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  assert.equal(calls, 2);
});

test('the three-page/45-document cap and provider truncation never imply uniqueness', async (t) => {
  for (const [total, pageable, eligible] of [
    [45, 45, true], [100, 45, true], [100, 100, true], [100, 45, false],
  ]) {
    let calls = 0;
    let reservations = 0;
    const lookup = service(t, {
      consumeBudget: async () => { reservations++; },
      fetch: async () => {
        calls++;
        const docs = unrelated(15, calls * 1000);
        if (calls === 1 && eligible) docs[0] = document();
        return Response.json(page(docs, { total, pageable, end: calls * 15 >= pageable }));
      },
    });
    assert.deepEqual(await lookup.lookup(canonical()), emptyResult('ambiguous'));
    assert.equal(calls, 3);
    assert.equal(reservations, 3);
  }
  const truncated = service(t, {
    fetch: async () => Response.json(page([document()], { total: 20, pageable: 1 })),
  });
  assert.deepEqual(await truncated.lookup(canonical()), emptyResult('ambiguous'));
});

test('a cap or truncation in either group prevents a unique result from the other group', async (t) => {
  for (const cappedGroup of ['AT4', 'CT1']) {
    for (const [total, pageable, pages] of [[45, 45, 3], [100, 45, 3], [100, 100, 3], [20, 1, 1]]) {
      const requests = [];
      let reservations = 0;
      const lookup = service(t, {
        consumeBudget: async () => { reservations++; },
        fetch: async (url) => {
          const params = new URL(url).searchParams;
          const group = params.get('category_group_code') ?? 'AT4';
          const number = Number(params.get('page'));
          requests.push([group, number]);
          if (group !== cappedGroup) {
            return Response.json(page([document('101', { category_group_code: group })]));
          }
          return Response.json(page(unrelated(pageable === 1 ? 1 : 15, number * 1000, group), {
            total, pageable, end: number * 15 >= pageable,
          }));
        },
      });
      assert.deepEqual(await lookup.lookup(canonical({ category: '관광지' })), emptyResult('ambiguous'));
      assert.equal(requests.length, pages + 1);
      assert.equal(reservations, pages + 1);
      assert.deepEqual([...new Set(requests.map(([group]) => group))], ['AT4', 'CT1']);
    }
  }
});

test('two capped groups stop at six HTTP calls and six quota reservations', async (t) => {
  const requests = [];
  let reservations = 0;
  const lookup = service(t, {
    consumeBudget: async () => { reservations++; },
    fetch: async (url) => {
      const params = new URL(url).searchParams;
      const group = params.get('category_group_code') ?? 'AT4';
      const number = Number(params.get('page'));
      requests.push([group, number]);
      return Response.json(page(unrelated(15, (group === 'AT4' ? 1000 : 5000) + number * 100, group), {
        total: 100, pageable: 100, end: false,
      }));
    },
  });
  assert.deepEqual(await lookup.lookup(canonical({ category: '관광지' })), emptyResult('ambiguous'));
  assert.deepEqual(requests, [['AT4', 1], ['AT4', 2], ['AT4', 3], ['CT1', 1], ['CT1', 2], ['CT1', 3]]);
  assert.equal(reservations, 6);
});

test('incomplete pagination in either group cannot be replaced by a match from the other', async (t) => {
  for (const brokenGroup of ['AT4', 'CT1']) {
    const lookup = service(t, {
      fetch: async (url) => {
        const group = new URL(url).searchParams.get('category_group_code') ?? 'AT4';
        return Response.json(page([document(group === 'AT4' ? '101' : '102', { category_group_code: group })], {
          total: group === brokenGroup ? 2 : 1,
        }));
      },
    });
    await assert.rejects(lookup.lookup(canonical({ category: '관광지' })), kakaoError('kakao_invalid_response', 502));
  }
});

test('empty complete results are not_found and sequential lookups do not cache results', async (t) => {
  let now = NOW;
  let calls = 0;
  const lookup = service(t, {
    clock: () => now,
    fetch: async () => Response.json(++calls === 1 ? page() : page([document()])),
  });
  assert.deepEqual(await lookup.lookup(canonical()), emptyResult('not_found'));
  now += 1000;
  const next = await lookup.lookup(canonical());
  assert.equal(next.status, 'matched');
  assert.equal(next.queried_at, '2026-09-11T03:04:06.000Z');
  assert.equal(calls, 2);
});

test('provider errors and malformed bodies cannot leak keys, bodies, URLs, or causes', async (t) => {
  for (const [fetch, code, status] of [
    [async () => { throw new Error(`private upstream ${KEY}`); }, 'kakao_unavailable', 503],
    [async () => new Response(`response-body-marker ${KEY}`, { status: 401 }), 'kakao_unavailable', 503],
    [async () => new Response(`response-body-marker ${KEY}`, { status: 429 }), 'kakao_unavailable', 503],
    [async () => new Response(`{"response-body-marker": "${KEY}"`, {
      headers: { 'content-type': 'application/json' },
    }), 'kakao_invalid_response', 502],
    [async () => Response.json({ response_body_marker: KEY }), 'kakao_invalid_response', 502],
    [async () => Response.json(page([document('101', { phone: KEY })])), 'kakao_invalid_response', 502],
  ]) {
    const lookup = service(t, { fetch });
    await assert.rejects(lookup.lookup(canonical()), kakaoError(code, status));
  }
  const error = new kakaoModule.KakaoError(`private upstream ${KEY}`);
  assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(KEY));
  assert.equal(error.status, 503);
});

test('caps response bytes with and without Content-Length and cancels oversized streams', async (t) => {
  for (const declared of [true, false]) {
    let cancelled = false;
    let reads = 0;
    const lookup = service(t, {
      fetch: async () => new Response(new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(64 * 1024).fill(32));
        },
        cancel() { cancelled = true; },
      }), {
        headers: {
          'content-type': 'application/json',
          ...(declared ? { 'content-length': '999999999' } : {}),
        },
      }),
    });
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
    await tick();
    assert.equal(cancelled, true);
    assert.ok(reads <= 6, 'the reader must stop without consuming an unbounded body');
  }
});

test('does not fall back to an unbounded response.json method', async (t) => {
  let jsonCalls = 0;
  const lookup = service(t, {
    fetch: async () => ({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => { jsonCalls++; return page([document()]); },
    }),
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_invalid_response', 502));
  assert.equal(jsonCalls, 0);
});

test('rejects disabled optional lookup and missing quota injection without calling the provider', async (t) => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(page([document()])); };
  for (const key of [undefined, null, '', '   ']) {
    const lookup = service(t, { key, fetch });
    assert.equal(lookup.enabled, false);
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_unavailable', 503));
  }
  const missingBudget = service(t, { fetch, consumeBudget: undefined });
  assert.equal(missingBudget.enabled, true);
  await assert.rejects(missingBudget.lookup(canonical()), kakaoError('kakao_unavailable', 503));
  assert.equal(calls, 0);
});

test('propagates parent budget failures unchanged and does not fetch after quota rejection', async (t) => {
  const failure = Object.assign(new Error('Quota exhausted'), { status: 429, code: 'quota_exceeded' });
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: async () => { throw failure; },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  await assert.rejects(lookup.lookup(canonical()), (error) => error === failure);
  await assert.rejects(lookup.lookup(canonical()), (error) => error === failure);
  assert.equal(calls, 0);
});

test('pre-aborted callers do not reserve budget or fetch', async (t) => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error(KEY));
  const lookup = service(t, {
    fetch: async () => { calls++; return Response.json(page()); },
    consumeBudget: async () => { calls++; },
  });
  await assert.rejects(lookup.lookup(canonical(), { signal: controller.signal }), abortError);
  assert.equal(calls, 0);
});

test('caller cancellation stops waiting for quota and late admission cannot start a fetch', { timeout: 1500 }, async (t) => {
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  let quotaSignal;
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: ({ signal }) => { quotaSignal = signal; return gate.promise; },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  const pending = lookup.lookup(canonical(), { signal: controller.signal });
  const rejected = assert.rejects(pending, abortError);
  await tick();
  controller.abort(new Error(KEY));
  await rejected;
  assert.equal(quotaSignal.aborted, true);
  gate.resolve();
  await tick();
  assert.equal(calls, 0);
});

test('cancellation while reserving second-group quota never starts that HTTP call', { timeout: 1500 }, async (t) => {
  const gate = Promise.withResolvers();
  const controller = new AbortController();
  const signals = [];
  let calls = 0;
  const lookup = service(t, {
    consumeBudget: ({ signal }) => {
      signals.push(signal);
      return signals.length === 1 ? Promise.resolve() : gate.promise;
    },
    fetch: async () => { calls++; return Response.json(page([document('101', { category_group_code: 'AT4' })])); },
  });
  const pending = lookup.lookup(canonical({ category: '관광지' }), { signal: controller.signal });
  pending.catch(() => {});
  await tick();
  assert.equal(signals.length, 2);
  assert.equal(calls, 1);
  const rejected = assert.rejects(pending, abortError);
  controller.abort(new Error(KEY));
  await rejected;
  assert.ok(signals.every((signal) => signal === signals[0] && signal.aborted));
  gate.resolve();
  await tick();
  assert.equal(calls, 1);
});

test('both groups share one deadline, including a non-cooperating second-group fetch', { timeout: 1500 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstResponse = Promise.withResolvers();
  const signals = [];
  let reservations = 0;
  const lookup = service(t, {
    timeoutMs: 100, maxConcurrent: 1,
    consumeBudget: async () => { reservations++; },
    fetch: (_url, { signal }) => {
      signals.push(signal);
      return signals.length === 1 ? firstResponse.promise : never();
    },
  });
  let settled = false;
  let failure;
  const pending = lookup.lookup(canonical({ category: '관광지' }));
  pending.then(() => { settled = true; }, (error) => { settled = true; failure = error; });
  await tick();
  t.mock.timers.tick(75);
  firstResponse.resolve(Response.json(page([document('101', { category_group_code: 'AT4' })])));
  await tick();
  assert.equal(signals.length, 2);
  assert.equal(settled, false);
  t.mock.timers.tick(25);
  await tick();
  assert.equal(settled, true, 'the second group must not receive a new 100 ms timeout');
  kakaoError('kakao_unavailable', 503)(failure);
  assert.equal(reservations, 2);
  assert.ok(signals.every((signal) => signal === signals[0] && signal.aborted));
  await assert.rejects(lookup.lookup(canonical({ category: '관광지' })), kakaoError('kakao_busy', 429));
  assert.equal(signals.length, 2);
});

test('bounds active lookups with no queue, including ignored aborts and independent same-place callers', { timeout: 1500 }, async (t) => {
  const responses = [Promise.withResolvers(), Promise.withResolvers()];
  const controller = new AbortController();
  const signals = [];
  let reservations = 0;
  const lookup = service(t, {
    consumeBudget: async () => { reservations++; },
    fetch: (_url, { signal }) => {
      signals.push(signal);
      return responses[signals.length - 1].promise;
    },
  });
  const first = lookup.lookup(canonical(), { signal: controller.signal });
  const firstRejected = assert.rejects(first, abortError);
  const second = lookup.lookup(canonical());
  await tick();
  await assert.rejects(lookup.lookup(canonical({ id: 'third' })), kakaoError('kakao_busy', 429));
  assert.equal(signals.length, 2);
  assert.equal(reservations, 2);
  controller.abort();
  await firstRejected;
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_busy', 429));
  responses[1].resolve(Response.json(page([document()])));
  assert.equal((await second).status, 'matched');
  responses[0].resolve(Response.json(page([document()])));
  await tick();
});

test('timeout settles non-cooperating fetches but retains their slots until actual settlement', { timeout: 1500 }, async (t) => {
  const response = Promise.withResolvers();
  let calls = 0;
  let providerSignal;
  let lateBodyCancelled = false;
  const lookup = service(t, {
    timeoutMs: 20, maxConcurrent: 1,
    fetch: (_url, { signal }) => {
      calls++;
      providerSignal = signal;
      return calls === 1 ? response.promise : Promise.resolve(Response.json(page([document()])));
    },
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_unavailable', 503));
  assert.equal(providerSignal.aborted, true);
  for (let index = 0; index < 5; index++) {
    await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_busy', 429));
  }
  assert.equal(calls, 1);
  response.resolve(new Response(new ReadableStream({
    cancel() { lateBodyCancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.equal(lateBodyCancelled, true);
  assert.equal((await lookup.lookup(canonical())).status, 'matched');
  assert.equal(calls, 2);
});

test('timeout also bounds a non-cooperating quota callback', { timeout: 1500 }, async (t) => {
  let reservations = 0;
  let calls = 0;
  let quotaSignal;
  const lookup = service(t, {
    timeoutMs: 20, maxConcurrent: 1,
    consumeBudget: ({ signal }) => {
      reservations++;
      quotaSignal = signal;
      return never();
    },
    fetch: async () => { calls++; return Response.json(page()); },
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_unavailable', 503));
  assert.equal(quotaSignal.aborted, true);
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_busy', 429));
  assert.equal(reservations, 1);
  assert.equal(calls, 0);
});

test('body timeout cancels the reader without waiting for non-cooperating cancellation', { timeout: 1500 }, async (t) => {
  let cancelled = false;
  const lookup = service(t, {
    timeoutMs: 20, maxConcurrent: 1,
    fetch: async () => new Response(new ReadableStream({
      pull() { return never(); },
      cancel() { cancelled = true; return never(); },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_unavailable', 503));
  assert.equal(cancelled, true);
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_busy', 429));
});

test('provider AbortError remains an AbortError with a safe message', async (t) => {
  const lookup = service(t, {
    fetch: async () => { throw new DOMException(`private upstream ${KEY}`, 'AbortError'); },
  });
  await assert.rejects(lookup.lookup(canonical()), abortError);
});

test('close is idempotent, aborts active work, and rejects further lookups', { timeout: 1500 }, async (t) => {
  let signal;
  const lookup = service(t, {
    fetch: (_url, options) => { signal = options.signal; return never(); },
  });
  const pending = lookup.lookup(canonical());
  const rejected = assert.rejects(pending, kakaoError('kakao_unavailable', 503));
  await tick();
  lookup.close();
  lookup.close();
  await rejected;
  assert.equal(signal.aborted, true);
  await assert.rejects(lookup.lookup(canonical()), kakaoError('kakao_unavailable', 503));
});

test('captures the original canonical identity before asynchronous work', async (t) => {
  const gate = Promise.withResolvers();
  const input = canonical();
  const lookup = service(t, { consumeBudget: () => gate.promise });
  const pending = lookup.lookup(input);
  input.id = 'changed-by-owner';
  input.name = '다른 장소';
  input.lat = 37;
  gate.resolve();
  const result = await pending;
  assert.equal(result.canonical_id, 'osm:node:42');
  assert.equal(result.status, 'matched');
  assert.equal(input.id, 'changed-by-owner');
});
