import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/server.mjs';

let apiModule;
let guideModule;
try {
  apiModule = await import('../server/api.mjs');
  guideModule = await import('../server/guide.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const secret = 'guide-test-secret-with-at-least-32-bytes';
const origin = 'https://atlas.example.test';
const runtimeArn = 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/TestRuntime-1234567890';

const mapResponse = (extra = {}) => ({
  version: '2', answer: '제주에서 바다를 감상해 보세요.', center: { lat: 33.4, lng: 126.5 },
  zoom: 11, markers: [], route: [], route_meta: null, warnings: [], ...extra,
});
const eventsFrom = async function* (events) { yield* events; };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function events(body) {
  return body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return name && data ? [{ event: name, data: JSON.parse(data) }] : [];
  });
}

async function fixture(t, options = {}) {
  assert.equal(typeof apiModule?.createApiHandler, 'function', 'API handler must be implemented');
  const root = await mkdtemp(join(tmpdir(), 'atlas-guide-'));
  await writeFile(join(root, 'index.html'), '<title>guide test</title>');
  const invocations = [];
  const quotas = [];
  const api = apiModule.createApiHandler({
    release: 'guide-test', env: { NODE_ENV: 'production' }, secret, publicOrigin: origin,
    consumeQuota: async (input) => { quotas.push(input); return true; },
    invokeEvents: (input) => {
      invocations.push(input);
      return eventsFrom([
        { type: 'status', stage: 'thinking' },
        { type: 'status', stage: 'tool', tool: 'find_places' },
        { type: 'token', text: '제주 바다' },
        { type: 'map', ...mapResponse() },
        { type: 'done' },
      ]);
    },
    ...options,
  });
  const server = createAppServer({ root, api });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  function start(path, { method = 'GET', headers = {}, body, chunks } = {}) {
    const opened = deferred();
    const completed = deferred();
    let text = '';
    const req = request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', completed.reject);
      res.on('end', () => completed.resolve({ status: res.statusCode, headers: res.headers, body: text }));
      opened.resolve(res);
    });
    req.on('error', (error) => { opened.reject(error); completed.reject(error); });
    // A streaming client may deliberately disconnect before the full response.
    completed.promise.catch(() => {});
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else req.end(body);
    return { req, opened: opened.promise, completed: completed.promise, text: () => text };
  }
  const get = (path, options) => start(path, options).completed;
  const cookie = async () => (await get('/api/config')).headers['set-cookie'][0].split(';')[0];
  const post = (sid, body = { message: '바다 여행을 추천해 주세요.' }, options = {}) => start('/api/guide', {
    method: 'POST', body: JSON.stringify(body), ...options,
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(sid ? { Cookie: sid } : {}), ...options.headers },
  });
  return { get, cookie, post, start, invocations, quotas };
}

test('missing, forged, duplicate, and tampered cookies never consume quota or call the guide', async (t) => {
  const f = await fixture(t);
  const valid = await f.cookie();
  for (const cookie of [undefined, 'atlas_sid=forged', `${valid}x`, `${valid}; ${valid}`]) {
    const response = await f.post(cookie).completed;
    assert.equal(response.status, 401);
    assert.match(response.headers['set-cookie'][0], /^atlas_sid=/);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.invocations.length, 0);
  assert.equal(f.quotas.length, 0);
});

test('origin is required and compared with the explicitly configured origin before invocation', async (t) => {
  const f = await fixture(t);
  const cookie = await f.cookie();
  for (const foreign of ['', 'null', 'https://evil.example', `${origin}.evil.example`, `${origin}/`]) {
    const response = await f.post(cookie, undefined, { headers: { Origin: foreign } }).completed;
    assert.equal(response.status, 403, foreign);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const missing = await f.start('/api/guide', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{"message":"안녕"}',
  }).completed;
  assert.equal(missing.status, 403);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.quotas.length, 0);
});

test('only a configured loopback origin is allowed for local use', async (t) => {
  const f = await fixture(t, { publicOrigin: 'http://localhost:5173', env: { NODE_ENV: 'test' } });
  const response = await f.post(await f.cookie(), undefined, { headers: { Origin: 'http://localhost:5173' } }).completed;
  assert.equal(response.status, 200);
  assert.equal(f.invocations.length, 1);
  assert.equal((await f.post(await f.cookie(), undefined, { headers: { Origin: 'http://127.0.0.1:5173' } }).completed).status, 403);
});

test('guide body validation rejects identity fields, invalid JSON, and both declared and chunked oversize bodies', async (t) => {
  const f = await fixture(t);
  const cookie = await f.cookie();
  for (const body of [null, [], {}, { message: '' }, { message: ' ' }, { message: 2 },
    { message: '가'.repeat(2001) }, { message: '안녕', actor: 'someone' },
    { message: '안녕', user_id: 'someone' }, { message: '안녕', runtimeSessionId: 'x' },
    { message: '안녕', conversation_id: 123 }]) {
    assert.equal((await f.post(cookie, body).completed).status, 400, JSON.stringify(body).slice(0, 90));
  }
  assert.equal((await f.post(cookie, undefined, { body: '{broken' }).completed).status, 400);
  assert.equal((await f.post(cookie, undefined, { headers: { 'Content-Type': 'text/plain' } }).completed).status, 415);
  const oversized = JSON.stringify({ message: 'x'.repeat(17_000) });
  assert.equal((await f.post(cookie, undefined, {
    body: oversized, headers: { 'Content-Length': Buffer.byteLength(oversized) },
  }).completed).status, 413);
  assert.equal((await f.post(cookie, undefined, {
    chunks: ['{"message":"', 'x'.repeat(9000), 'x'.repeat(9000), '"}'],
  }).completed).status, 413);
  assert.equal(f.invocations.length, 0);
  assert.equal(f.quotas.length, 0);
});

test('signed conversations bind an opaque actor to a UUID and expire after fourteen minutes', async (t) => {
  let now = Date.parse('2026-09-09T03:00:00Z');
  const f = await fixture(t, { clock: () => now });
  const firstCookie = await f.cookie();
  const secondCookie = await f.cookie();
  const first = await f.post(firstCookie).completed;
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'], /^text\/event-stream/);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['set-cookie'], undefined);
  const firstEvents = events(first.body);
  const token = firstEvents.find((event) => event.event === 'session').data.conversation_id;
  const invocation = f.invocations[0];
  assert.match(invocation.actorId, /^atlas_[a-f0-9]{64}$/);
  assert.match(invocation.conversationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(token, invocation.conversationId);
  assert.doesNotMatch(JSON.stringify(invocation), /atlas_sid=/);
  assert.ok(firstEvents.some((event) => event.event === 'status' && /[가-힣]/.test(event.data.message)));
  assert.deepEqual(firstEvents.find((event) => event.event === 'text').data, { delta: '제주 바다' });
  assert.equal(firstEvents.at(-1).event, 'done');
  assert.deepEqual(firstEvents.at(-1).data, {});
  assert.equal((await f.post(firstCookie, { message: '계속', conversation_id: token }).completed).status, 200);
  assert.equal(f.invocations[1].actorId, invocation.actorId);
  assert.equal(f.invocations[1].conversationId, invocation.conversationId);
  for (const badToken of [token, `${token}x`, invocation.conversationId]) {
    assert.equal((await f.post(secondCookie, { message: '계속', conversation_id: badToken }).completed).status, 403);
  }
  now += 14 * 60_000;
  assert.equal((await f.post(firstCookie, { message: '계속', conversation_id: token }).completed).status, 403);
  assert.equal(f.invocations.length, 2);
  assert.equal(f.quotas.length, 2);
  await f.post(secondCookie).completed;
  assert.notEqual(f.invocations[2].actorId, invocation.actorId);
});

test('daily quota exhaustion and store failure close the request before any model call', async (t) => {
  for (const [name, consumeQuota, expected] of [
    ['exhausted', async () => false, 429],
    ['unavailable', async () => { throw new Error('AWS credential secret detail'); }, 503],
  ]) {
    await t.test(name, async (child) => {
      const f = await fixture(child, { consumeQuota });
      const response = await f.post(await f.cookie()).completed;
      assert.equal(response.status, expected);
      assert.equal(f.invocations.length, 0);
      assert.doesNotMatch(response.body, /AWS credential|secret detail/);
      assert.equal(response.headers['cache-control'], 'no-store');
    });
  }
});

test('each actor gets at most five model starts in a rolling hour, including failed invocations', async (t) => {
  let now = Date.parse('2026-09-09T03:00:00Z');
  let count = 0;
  const f = await fixture(t, {
    clock: () => now,
    invokeEvents: async function* () { count++; throw new Error('private AWS failure'); },
  });
  const cookie = await f.cookie();
  for (let i = 0; i < 5; i++) {
    const response = await f.post(cookie).completed;
    const output = events(response.body);
    assert.equal(output.filter((event) => event.event === 'error').length, 1);
    assert.equal(output.filter((event) => event.event === 'done').length, 1);
    assert.doesNotMatch(response.body, /private AWS failure/);
  }
  assert.equal((await f.post(cookie).completed).status, 429);
  assert.equal(count, 5);
  assert.equal(f.quotas.length, 5);
  now += 3_600_000;
  assert.equal((await f.post(cookie).completed).status, 200);
  assert.equal(count, 6);
});

test('heartbeats and health checks continue while awaiting the SDK, and body completion is not a disconnect', async (t) => {
  const called = deferred();
  const release = deferred();
  let signal;
  const f = await fixture(t, {
    heartbeatMs: 10, deadlineMs: 2000,
    invokeEvents: async (input) => {
      signal = input.signal;
      called.resolve();
      await release.promise;
      return eventsFrom([{ type: 'map', ...mapResponse() }, { type: 'done' }]);
    },
  });
  const active = f.post(await f.cookie());
  const response = await active.opened;
  await called.promise;
  while (!active.text().includes(': heartbeat')) await once(response, 'data');
  assert.equal(signal.aborted, false);
  const health = await f.get('/healthz');
  assert.equal(health.status, 200);
  release.resolve();
  const result = await active.completed;
  assert.equal(events(result.body).at(-1).event, 'done');
  assert.equal(events(result.body).filter((event) => event.event === 'error').length, 0);
});

test('a hard deadline aborts a non-cooperating SDK wait and sends exactly one error followed by done', async (t) => {
  let signal;
  const f = await fixture(t, {
    heartbeatMs: 10, deadlineMs: 40,
    invokeEvents: async (input) => { signal = input.signal; return new Promise(() => {}); },
  });
  const result = await f.post(await f.cookie()).completed;
  assert.equal(signal.aborted, true);
  const output = events(result.body);
  assert.equal(output.filter((event) => event.event === 'error').length, 1);
  assert.equal(output.filter((event) => event.event === 'done').length, 1);
  assert.equal(output.at(-1).event, 'done');
  assert.equal(output.find((event) => event.event === 'error').data.code, 'guide_timeout');
});

test('global and per-actor concurrency reject excess calls and response disconnect releases the slot', async (t) => {
  const starts = [];
  const f = await fixture(t, {
    deadlineMs: 2000,
    invokeEvents: async function* (input) {
      const released = deferred();
      starts.push({ input, released });
      input.signal.addEventListener('abort', () => released.resolve(), { once: true });
      yield { type: 'status', stage: 'thinking' };
      await released.promise;
      yield { type: 'map', ...mapResponse() };
      yield { type: 'done' };
    },
  });
  const cookies = await Promise.all([f.cookie(), f.cookie(), f.cookie()]);
  const first = f.post(cookies[0]);
  await first.opened;
  const second = f.post(cookies[1]);
  await second.opened;
  assert.equal((await f.post(cookies[0]).completed).status, 429);
  assert.equal((await f.post(cookies[2]).completed).status, 429);
  assert.equal(f.quotas.length, 2);
  const aborted = once(starts[0].input.signal, 'abort');
  (await first.opened).destroy();
  await aborted;
  const third = f.post(cookies[2]);
  assert.equal((await third.opened).statusCode, 200);
  starts[1].released.resolve();
  // Headers can arrive before the invocation starts; observe a data frame.
  while (starts.length < 3) await once(await third.opened, 'data');
  starts[2].released.resolve();
  await Promise.all([second.completed, third.completed]);
});

test('runtime SSE decodes split Korean UTF-8 and double JSON, and whole JSON gets the map fallback', async () => {
  assert.equal(typeof guideModule?.decodeAgentResponse, 'function');
  const wire = [
    ': upstream heartbeat\r\n\r\n',
    `data: ${JSON.stringify(JSON.stringify({ type: 'token', text: '제주 바다 🌊' }))}\r\n\r\n`,
    `data: ${JSON.stringify({ type: 'map', ...mapResponse() })}\n\n`,
    'data: {"type":"done"}\n\n',
  ].join('');
  const bytes = Buffer.from(wire);
  const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
  const output = [];
  for await (const event of guideModule.decodeAgentResponse({
    contentType: 'text/event-stream; charset=utf-8', response: Readable.from(chunks),
  })) output.push(event);
  assert.deepEqual(output[0], { type: 'token', text: '제주 바다 🌊' });
  assert.equal(output[1].type, 'map');
  assert.equal(output[2].type, 'done');
  const fallback = [];
  const jsonBytes = Buffer.from(JSON.stringify(JSON.stringify(mapResponse())));
  for await (const event of guideModule.decodeAgentResponse({
    contentType: 'application/json',
    response: Readable.from(Array.from(jsonBytes, (byte) => Buffer.from([byte]))),
  })) fallback.push(event);
  assert.equal(fallback[0].type, 'map');
  assert.equal(fallback[0].answer, '제주에서 바다를 감상해 보세요.');
  assert.deepEqual(fallback[1], { type: 'done' });
});

test('AgentCore invocation uses only backend identities and response disconnect destroys its SDK body', async (t) => {
  assert.equal(typeof guideModule?.createAgentInvoker, 'function');
  const sdkBody = new PassThrough();
  const sent = deferred();
  let command;
  let options;
  const invokeEvents = guideModule.createAgentInvoker({
    runtimeArn, region: 'ap-northeast-2',
    client: {
      async send(input, opts) {
        command = input;
        options = opts;
        sent.resolve();
        return { contentType: 'text/event-stream', response: sdkBody };
      },
    },
  });
  const f = await fixture(t, { invokeEvents });
  const active = f.post(await f.cookie(), { message: '제주 바다를 보여 주세요.' });
  const response = await active.opened;
  await sent.promise;
  assert.equal(command.constructor.name, 'InvokeAgentRuntimeCommand');
  assert.equal(command.input.agentRuntimeArn, runtimeArn);
  assert.equal(command.input.accept, 'text/event-stream');
  assert.equal(command.input.contentType, 'application/json');
  assert.equal(command.input.runtimeSessionId.length, 36);
  assert.match(command.input.runtimeUserId, /^atlas_/);
  assert.deepEqual(JSON.parse(Buffer.from(command.input.payload).toString()), {
    prompt: '제주 바다를 보여 주세요.', user_id: command.input.runtimeUserId,
    conversation_id: command.input.runtimeSessionId, locale: 'ko', stream: true,
  });
  const closed = once(sdkBody, 'close');
  response.destroy();
  await closed;
  assert.equal(options.abortSignal.aborted, true);
  assert.equal(sdkBody.destroyed, true);
});

test('DynamoDB quota writes the KST day atomically and store errors fail closed over HTTP', async (t) => {
  assert.equal(typeof guideModule?.createDynamoQuotaConsumer, 'function');
  const commands = [];
  let mode = 'ok';
  const quota = guideModule.createDynamoQuotaConsumer({
    table: 'test-quota', dailyLimit: 30, clock: () => Date.parse('2026-09-09T15:01:00Z'),
    client: {
      async send(command) {
        commands.push(command);
        if (mode !== 'ok') throw Object.assign(new Error('private storage detail'), { name: mode });
        return {};
      },
    },
  });
  const f = await fixture(t, { consumeQuota: quota });
  const cookie = await f.cookie();
  assert.equal((await f.post(cookie).completed).status, 200);
  const input = commands[0].input;
  assert.equal(commands[0].constructor.name, 'UpdateItemCommand');
  assert.equal(input.TableName, 'test-quota');
  assert.deepEqual(input.Key, { id: { S: 'day#2026-09-10' } });
  assert.match(input.UpdateExpression, /\bSET\b/);
  assert.match(input.UpdateExpression, /\bADD\b/);
  assert.match(input.ConditionExpression, /attribute_not_exists/);
  assert.deepEqual(input.ExpressionAttributeValues[':limit'], { N: '30' });
  assert.deepEqual(input.ExpressionAttributeValues[':one'], { N: '1' });
  assert.equal(Number(input.ExpressionAttributeValues[':expires'].N), Date.parse('2026-09-12T15:01:00Z') / 1000);
  mode = 'ConditionalCheckFailedException';
  assert.equal((await f.post(cookie).completed).status, 429);
  mode = 'ProvisionedThroughputExceededException';
  const unavailable = await f.post(cookie).completed;
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(unavailable.body, /private storage detail/);
  assert.equal(f.invocations.length, 1);
  assert.equal(commands.length, 3);
});

test('guide maps use exact catalog IDs, bound geometry, keep route metadata, and never promote seed sources', async (t) => {
  const known = {
    id: 'poi_0001', name: '카탈로그 이름', lat: 33.45, lng: 126.55,
    category: '관광지', summary: '시드 소개', source: 'curated',
    updated_at: '2026-09-01T00:00:00Z', base_note: '공식 대조 검증 전 큐레이션 시드',
  };
  const road = { mode: 'car', distance_m: 1200, duration_s: 180, provider: 'osrm' };
  const input = mapResponse({
    answer: '가'.repeat(7000), center: { lat: 90, lng: 0 }, zoom: 99,
    markers: [
      { id: 'poi_0001', name: '잘못된 이름', lat: 0, lng: 0, source: 'official', category: '카페' },
      { id: 'unknown', name: '알 수 없는 카페', lat: 33.3, lng: 126.4, category: '카페', source: 'official' },
      { id: 'outside', name: '서울', lat: 37.5, lng: 127, category: '카페' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, name: `장소${i}`, lat: 33.3, lng: 126.4, category: '카페' })),
    ],
    route: [{ lat: 33.4, lng: 126.5 }, { lat: 33.41, lng: 126.51 }],
    route_meta: { ...road, private: 'drop' }, itinerary: { arbitrary: true }, private: 'drop',
  });
  const f = await fixture(t, {
    catalog: { status: () => ({ status: 'ready' }), detail: (id) => id === known.id ? known : null },
    invokeEvents: () => eventsFrom([{ type: 'map', ...input }, { type: 'done' }]),
  });
  const response = await f.post(await f.cookie()).completed;
  const map = events(response.body).find((event) => event.event === 'map').data;
  assert.deepEqual(Object.keys(map).sort(), ['answer', 'center', 'markers', 'place_info', 'route', 'route_meta', 'warnings', 'zoom']);
  assert.equal(map.answer.length, 6000);
  assert.equal(map.center, null);
  assert.ok(map.zoom >= 1 && map.zoom <= 20);
  assert.equal(map.markers.length, 12);
  assert.equal(map.markers[0].name, '카탈로그 이름');
  assert.equal(map.markers[0].lat, 33.45);
  assert.equal(map.markers[0].source, 'curated');
  assert.equal(map.markers[1].id, 'unknown');
  assert.equal(map.markers[1].name, '알 수 없는 카페');
  assert.equal(map.markers[1].source, null);
  assert.deepEqual(map.place_info, [{
    id: 'poi_0001', name: '카탈로그 이름', facilities: {}, hours_week: [], hours_source: null,
    enriched_at: null, sources: [], base_note: '공식 대조 검증 전 큐레이션 시드', business_status: null,
  }]);
  assert.ok(map.warnings.some((warning) => /시드|검증/.test(warning)));
  assert.deepEqual(map.route_meta, road);
  assert.ok(map.markers.every((marker) => marker.lat >= 33.1 && marker.lat <= 33.6 && marker.lng >= 126.15 && marker.lng <= 126.98));
});

test('unsafe or oversized routes are omitted instead of reconnecting road geometry across invalid points', async () => {
  assert.equal(typeof guideModule?.normalizeGuideMap, 'function');
  for (const route of [
    [{ lat: 33.3, lng: 126.4 }, { lat: 0, lng: 0 }, { lat: 33.4, lng: 126.5 }],
    Array.from({ length: 513 }, () => ({ lat: 33.3, lng: 126.4 })),
  ]) {
    const result = guideModule.normalizeGuideMap(mapResponse({
      route, route_meta: { mode: 'straight', distance_m: 300, duration_s: null, provider: 'geodesic' },
    }));
    assert.deepEqual(result.route, []);
    assert.equal(result.route_meta.mode, 'straight');
    assert.ok(result.warnings.length > 0);
  }
});

test('disconnect during the quota check aborts its signal and prevents a later model start', async (t) => {
  const checking = deferred();
  const quotaDone = deferred();
  let quotaSignal;
  const f = await fixture(t, {
    consumeQuota: async ({ signal }) => {
      quotaSignal = signal;
      checking.resolve();
      await quotaDone.promise;
      return true;
    },
  });
  const active = f.post(await f.cookie());
  active.opened.catch(() => {});
  await checking.promise;
  const aborted = once(quotaSignal, 'abort');
  active.req.destroy();
  await aborted;
  quotaDone.resolve();
  // A second actor proves the request loop and its concurrency slots remain usable.
  assert.equal((await f.post(await f.cookie()).completed).status, 200);
  assert.equal(f.invocations.length, 1);
});

test('real HTTP relay accepts split UTF-8 SSE and JSON fallback through the AgentCore adapter', async (t) => {
  for (const contentType of ['application/json', 'text/event-stream']) {
    await t.test(contentType, async (child) => {
      const raw = mapResponse({ answer: '제주 바다 🌊' });
      const wire = contentType === 'application/json'
        ? JSON.stringify(JSON.stringify(raw))
        : `data: ${JSON.stringify(JSON.stringify({ type: 'map', ...raw }))}\r\n\r\ndata: {"type":"done"}\r\n\r\n`;
      const invokeEvents = guideModule.createAgentInvoker({
        runtimeArn,
        client: {
          async send() {
            return {
              contentType, statusCode: 200,
              response: Readable.from(Array.from(Buffer.from(wire), (byte) => Buffer.from([byte]))),
            };
          },
        },
      });
      const f = await fixture(child, { invokeEvents });
      const response = await f.post(await f.cookie()).completed;
      const output = events(response.body);
      assert.equal(response.status, 200);
      assert.equal(output.find((event) => event.event === 'map').data.answer, '제주 바다 🌊');
      assert.equal(output.filter((event) => event.event === 'error').length, 0);
      assert.deepEqual(output.at(-1), { event: 'done', data: {} });
    });
  }
});

test('runtime failures and malformed bodies produce no invented map or upstream diagnostic text', async (t) => {
  for (const [name, result] of [
    ['runtime status', { statusCode: 500, contentType: 'application/json', body: JSON.stringify(mapResponse({ answer: 'private diagnostic detail' })) }],
    ['upstream error', { statusCode: 200, contentType: 'text/event-stream', body: 'data: {"type":"error","code":"CredentialsProviderError","message":"private diagnostic detail"}\n\n' }],
    ['truncated JSON', { statusCode: 200, contentType: 'text/event-stream', body: 'data: {"type":"map","answer":"private diagnostic detail"' }],
    ['empty stream', { statusCode: 200, contentType: 'text/event-stream', body: '' }],
  ]) {
    await t.test(name, async (child) => {
      const invokeEvents = guideModule.createAgentInvoker({
        runtimeArn,
        client: {
          async send() {
            return { contentType: result.contentType, statusCode: result.statusCode, response: Readable.from([Buffer.from(result.body)]) };
          },
        },
      });
      const f = await fixture(child, { invokeEvents });
      const response = await f.post(await f.cookie()).completed;
      const output = events(response.body);
      assert.equal(output.filter((event) => event.event === 'error').length, 1);
      assert.equal(output.filter((event) => event.event === 'map').length, 0);
      assert.equal(output.filter((event) => event.event === 'done').length, 1);
      assert.equal(output.at(-1).event, 'done');
      assert.doesNotMatch(response.body, /private diagnostic detail|CredentialsProviderError/);
    });
  }
});

test('hourly actor storage stays bounded without evicting limits, and expired actors are pruned', async (t) => {
  let now = Date.parse('2026-09-09T03:00:00Z');
  const f = await fixture(t, { maxActors: 1, clock: () => now });
  const first = await f.cookie();
  const second = await f.cookie();
  assert.equal((await f.post(first).completed).status, 200);
  assert.equal((await f.post(second).completed).status, 503);
  assert.equal(f.invocations.length, 1);
  now += 3_600_000;
  assert.equal((await f.post(second).completed).status, 200);
  assert.equal(f.invocations.length, 2);
});

test('HTTP guide place_info carries exact catalog facts and ignores model-supplied enrichment', async (t) => {
  const detail = Object.freeze({
    id: 'sample:family', name: '카탈로그 가족 공원', category: '관광지',
    lat: 33.4, lng: 126.5, source: 'sample', summary: '시드 기본 소개',
    facilities: Object.freeze({ parking: 'yes', wheelchair: 'unknown' }),
    hours_week: Object.freeze([Object.freeze({ day: 0, open: '09:00', close: '18:00' })]),
    hours_source: 'tourapi_usetime', enriched_at: '2026-09-08T21:48:08+00:00',
    sources: Object.freeze([Object.freeze({
      source: 'tourapi', url: 'https://example.org/place/family',
      observed_at: '2026-09-08T21:46:33+00:00', license: 'KOGL-1',
      note: '장소 보강 자료; 개별 편의시설의 검증 근거는 아님',
    })]),
    base_note: '큐레이션 기본 좌표·주소·소개는 공식 대조 검증되지 않았습니다.',
    business_status: 'open',
  });
  const empty = {
    id: 'osm:node/1', name: '편의 정보 없는 장소', category: '카페',
    lat: 33.41, lng: 126.51, source: 'OpenStreetMap',
  };
  const reads = [];
  let modelStarts = 0;
  const f = await fixture(t, {
    catalog: {
      status: () => ({ status: 'ready' }),
      detail(id) {
        reads.push(id);
        return id === detail.id ? detail : id === empty.id ? empty : null;
      },
    },
    invokeEvents: () => {
      modelStarts++;
      return eventsFrom([
        { type: 'token', text: '아이와 방문할 장소를 안내합니다.' },
        { type: 'map', ...mapResponse({
          markers: [
            { ...detail, name: '모델이 바꾼 이름', facilities: { stroller: 'yes' } },
            { ...empty, facilities: { parking: 'yes' } },
            { id: 'unknown', name: detail.name, category: '관광지', lat: 33.4, lng: 126.5 },
          ],
          place_info: [
            { id: detail.id, name: '가짜 공식 명칭', facilities: { stroller: 'yes' }, hours_source: 'model', open_now: true },
            { id: empty.id, facilities: { wheelchair: 'yes' } },
            { id: 'unknown', facilities: { parking: 'yes' }, sources: [{ source: 'official' }] },
          ],
        }) },
        { type: 'done' },
      ]);
    },
  });
  const response = await f.post(await f.cookie(), {
    message: '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.',
  }).completed;
  assert.equal(response.status, 200);
  const output = events(response.body);
  const map = output.find((event) => event.event === 'map').data;
  assert.deepEqual(map.place_info, [{
    id: 'sample:family', name: '카탈로그 가족 공원',
    facilities: { parking: 'yes', wheelchair: 'unknown' },
    hours_week: [{ day: 0, open: '09:00', close: '18:00' }],
    hours_source: 'tourapi_usetime', enriched_at: '2026-09-08T21:48:08+00:00',
    sources: [{
      source: 'tourapi', url: 'https://example.org/place/family',
      observed_at: '2026-09-08T21:46:33+00:00', license: 'KOGL-1',
      note: '장소 보강 자료; 개별 편의시설의 검증 근거는 아님',
    }],
    base_note: '큐레이션 기본 좌표·주소·소개는 공식 대조 검증되지 않았습니다.',
    business_status: 'open',
  }, {
    id: 'osm:node/1', name: '편의 정보 없는 장소', facilities: {}, hours_week: [],
    hours_source: null, enriched_at: null, sources: [], base_note: null, business_status: null,
  }]);
  assert.deepEqual(reads, ['sample:family', 'osm:node/1', 'unknown']);
  assert.equal(modelStarts, 1);
  assert.equal(f.quotas.length, 1);
  assert.equal(output.filter((event) => event.event === 'error').length, 0);
  assert.deepEqual(output.at(-1), { event: 'done', data: {} });
  assert.doesNotMatch(JSON.stringify(map.place_info), /open_now|stroller|facility_sources|가짜 공식/);
});

test('guide place_info only covers accepted exact-ID catalog matches, including empty known rows', () => {
  const marker = { id: 'known', name: '모델 이름', category: '관광지', lat: 33.4, lng: 126.5 };
  const modelFacts = [{ id: marker.id, name: marker.name, facilities: { parking: 'yes' } }];
  for (const catalog of [
    undefined, { detail: () => null }, { detail: () => { throw new Error('unavailable'); } },
    { detail: () => ({ ...marker, id: 'different-id', facilities: { parking: 'yes' } }) },
    { detail: () => ({ ...marker, name: null, facilities: { parking: 'yes' } }) },
    { detail: () => ({ ...marker, lat: 90, facilities: { parking: 'yes' } }) },
  ]) {
    const map = guideModule.normalizeGuideMap(mapResponse({ markers: [marker], place_info: modelFacts }), { catalog });
    assert.deepEqual(map.place_info ?? [], []);
  }
  const catalog = { detail: (id) => ({ ...marker, id, name: `카탈로그 ${id}` }) };
  const map = guideModule.normalizeGuideMap(mapResponse({
    markers: [marker, marker, ...Array.from({ length: 13 }, (_, i) => ({ ...marker, id: `p${i}` }))],
    place_info: modelFacts,
  }), { catalog });
  assert.equal(map.place_info.length, 12);
  assert.deepEqual(map.place_info.map((info) => info.id), map.markers.map((item) => item.id));
  assert.deepEqual(map.place_info[0], {
    id: 'known', name: '카탈로그 known', facilities: {}, hours_week: [], hours_source: null,
    enriched_at: null, sources: [], base_note: null, business_status: null,
  });
});

test('guide place_info bounds facility text and validates hours without making open-now claims', () => {
  const inherited = { inherited_facility: 'yes' };
  const facilities = Object.assign(Object.create(inherited), {
    parking: '가'.repeat(450), wheelchair: 'unknown', empty: '', malformed: true,
    ['k'.repeat(61)]: 'do not rename an oversized facility key',
  });
  Object.defineProperty(facilities, '__proto__', { enumerable: true, value: 'no pollution' });
  for (let i = 0; i < 12; i++) facilities[`facility${i}`] = '확인된 문구';
  const known = {
    id: 'hours', name: '카탈로그 시간', category: '관광지', lat: 33.4, lng: 126.5, facilities,
    hours_source: 'catalog-provider/use-time-v2',
    hours_week: [
      { day: 0, open: '09:00', close: '24:00', open_now: true },
      { day: 6, open: '20:00', close: '08:00' },
      ...[
        { day: -1, open: '09:00', close: '18:00' }, { day: 7, open: '09:00', close: '18:00' },
        { day: '1', open: '09:00', close: '18:00' }, { day: 1.5, open: '09:00', close: '18:00' },
        { day: 1, open: '24:00', close: '24:01' }, { day: 1, open: '9:00', close: '18:00' },
        { day: 1, open: '09:60', close: '18:00' }, { day: 1, open: '09:00', close: null },
      ],
      ...Array.from({ length: 20 }, () => ({ day: 2, open: '10:00', close: '17:00' })),
    ],
    enriched_at: 'invalid date', business_status: 'open', open_now: true,
  };
  const map = guideModule.normalizeGuideMap(mapResponse({ markers: [known] }), { catalog: { detail: () => known } });
  const info = map.place_info?.[0];
  assert.ok(info, 'accepted catalog place should include facts');
  assert.equal(Object.keys(info.facilities).length, 8);
  assert.equal(info.facilities.parking, '가'.repeat(400));
  assert.equal(info.facilities.wheelchair, 'unknown');
  for (const key of ['inherited_facility', '__proto__', 'empty', 'malformed', 'k'.repeat(61)]) {
    assert.equal(Object.hasOwn(info.facilities, key), false, key);
  }
  assert.ok(Object.keys(info.facilities).every((key) => key.length <= 60));
  assert.equal(info.hours_week.length, 14);
  assert.deepEqual(info.hours_week.slice(0, 2), [
    { day: 0, open: '09:00', close: '24:00' }, { day: 6, open: '20:00', close: '08:00' },
  ]);
  assert.ok(info.hours_week.slice(2).every((hour) => hour.day === 2));
  assert.equal(info.hours_source, 'catalog-provider/use-time-v2');
  assert.equal(info.enriched_at, null);
  assert.equal(info.business_status, 'open');
  assert.doesNotMatch(JSON.stringify(info), /open_now/);
});

test('guide place_info source links are bounded public HTTP URLs, with row provenance kept separate', () => {
  const known = { id: 'source', name: '출처 장소', category: '관광지', lat: 33.4, lng: 126.5 };
  const cases = [
    ['https://example.org/place?a=1', 'https://example.org/place?a=1'],
    ['http://example.org/place', 'http://example.org/place'],
    ['javascript:alert(1)', null], ['data:text/html,hi', null], ['file:///etc/passwd', null],
    ['/relative', null], ['https://name:password@example.org/place', null],
    ['https://example.org/with\\backslash', null], ['https://example.org/\npath', null],
    ['http://localhost/place', null], ['http://127.1/place', null], ['http://10.0.0.1/place', null],
    ['http://[::1]/place', null], ['https://catalog.local/place', null],
    [`https://example.org/${'x'.repeat(3000)}`, null],
  ];
  for (const [url, expected] of cases) {
    const detail = {
      ...known,
      sources: [{
        source: 'tourapi', url, observed_at: 'bad date', license: 'KOGL-1',
        note: '주차장별 검증 출처로 해석하지 않는 행 보강 자료', fields: ['parking'], open_now: true,
      }],
    };
    const map = guideModule.normalizeGuideMap(mapResponse({ markers: [known] }), { catalog: { detail: () => detail } });
    assert.deepEqual(map.place_info?.[0]?.sources, [{
      source: 'tourapi', url: expected, observed_at: null, license: 'KOGL-1',
      note: '주차장별 검증 출처로 해석하지 않는 행 보강 자료',
    }], url);
    assert.deepEqual(map.place_info[0].facilities, {});
    assert.equal(map.place_info[0].hours_source, null);
  }
});

test('guide place_info keeps the worst-case twelve-place response finite and strips unknown fields', () => {
  const places = Array.from({ length: 13 }, (_, i) => ({
    id: `p${i}`, name: '이'.repeat(1000), category: '관광지', lat: 33.4, lng: 126.5,
    facilities: Object.fromEntries(Array.from({ length: 12 }, (_, j) => [`${'편'.repeat(55)}${j}`, '값'.repeat(1000)])),
    hours_week: Array.from({ length: 20 }, () => ({ day: 0, open: '00:00', close: '24:00' })),
    hours_source: '공급자'.repeat(100), base_note: '시드 검증 전 '.repeat(1000),
    business_status: '상태'.repeat(200), enriched_at: '2026-09-09T00:00:00Z',
    sources: [
      null, { source: null }, { source: '' },
      ...Array.from({ length: 20 }, (_, j) => ({
        source: `provider-${j}`, url: `https://example.org/${'x'.repeat(2000)}`,
        license: '허가'.repeat(1000), observed_at: '2026-09-09T00:00:00Z',
        note: '보강 자료 '.repeat(1000), unknown: 'x'.repeat(50_000),
      })),
    ],
    unknown: 'x'.repeat(50_000),
  }));
  const byId = new Map(places.map((place) => [place.id, place]));
  const map = guideModule.normalizeGuideMap(mapResponse({ markers: places }), { catalog: { detail: (id) => byId.get(id) } });
  assert.equal(map.place_info.length, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(map)) < 1024 * 1024);
  for (const info of map.place_info) {
    assert.equal(info.name.length, 160);
    assert.equal(Object.keys(info.facilities).length, 8);
    assert.equal(info.hours_week.length, 14);
    assert.equal(info.hours_source, null, 'oversized source identifiers must not become different identifiers');
    assert.equal(info.sources.length, 8);
    assert.ok(info.base_note.length <= 1000);
    assert.ok(info.business_status.length <= 80);
    for (const source of info.sources) {
      assert.ok(source.source.length <= 120);
      assert.ok(source.url === null || source.url.length <= 2048);
      assert.ok(source.license === null || source.license.length <= 120);
      assert.ok(source.note === null || source.note.length <= 400);
      assert.equal(Object.hasOwn(source, 'unknown'), false);
    }
    assert.equal(Object.hasOwn(info, 'unknown'), false);
  }
});

function largeFrameFixture(escaped = false) {
  const text = escaped ? '"' : '가';
  const modelText = escaped ? '\u0001' : '가';
  const point = { lat: 33.333333333333336, lng: 126.33333333333333 };
  const places = Array.from({ length: 12 }, (_, i) => ({
    id: escaped ? `p${'\u0001'.repeat(252)}${i}` : `p${i}`,
    name: (escaped ? '\ud800' : text).repeat(160),
    category: modelText.repeat(80), summary: modelText.repeat(1200),
    source: modelText.repeat(120), ...point,
    facilities: Object.fromEntries(Array.from({ length: 8 }, (_, j) => [text.repeat(59) + j, text.repeat(400)])),
    hours_week: Array.from({ length: 14 }, () => ({ day: 0, open: '00:00', close: '24:00' })),
    hours_source: text.repeat(160), base_note: text.repeat(1000), business_status: text.repeat(80),
    enriched_at: '2026-09-09T00:00:00.000+00:00',
    sources: Array.from({ length: 8 }, () => ({
      source: text.repeat(120), url: 'https://example.org/' + 'x'.repeat(2028),
      observed_at: '2026-09-09T00:00:00.000+00:00', license: text.repeat(120), note: text.repeat(400),
    })),
  }));
  const byId = new Map(places.map((place) => [place.id, place]));
  const catalog = { status: () => ({ status: 'ready' }), detail: (id) => byId.get(id) };
  const input = mapResponse({
    answer: modelText.repeat(6000), center: point, markers: places.map(({ id }) => ({ id })),
    route: Array.from({ length: 512 }, () => ({ ...point })),
    route_meta: { mode: 'straight', distance_m: 123456789.123456789, duration_s: null, provider: modelText.repeat(160) },
    warnings: Array.from({ length: 32 }, (_, i) => modelText.repeat(298) + String(i).padStart(2, '0')),
  });
  return { catalog, input };
}

test('large valid guide frames are accepted by character count even above 512 KiB of UTF-8 bytes', async (t) => {
  const { catalog, input } = largeFrameFixture();
  const f = await fixture(t, {
    catalog,
    invokeEvents: () => eventsFrom([{ type: 'map', ...input }, { type: 'done' }]),
  });
  const response = await f.post(await f.cookie()).completed;
  assert.equal(response.status, 200);
  const output = events(response.body);
  const map = output.find((event) => event.event === 'map')?.data;
  assert.ok(map, 'large bounded catalog facts must reach the browser');
  assert.equal(map.markers.length, 12);
  assert.equal(map.place_info.length, 12);
  assert.equal(map.place_info[0].sources.length, 8);
  const frame = response.body.split('\n\n').find((part) => part.startsWith('event: map\n')) + '\n\n';
  assert.ok(frame.length > 100_000);
  assert.ok(frame.length <= 512 * 1024, 'the complete frame, including its wrapper, must fit');
  assert.ok(Buffer.byteLength(frame) > 512 * 1024, 'bytes must not be mistaken for characters');
  assert.equal(output.filter((event) => event.event === 'error').length, 0);
  assert.deepEqual(output.at(-1), { event: 'done', data: {} });
});

test('JSON escaping beyond the guide frame character limit sends invalid_response and done without a partial map', async (t) => {
  const { catalog, input } = largeFrameFixture(true);
  const normalized = guideModule.normalizeGuideMap(input, { catalog });
  const oversized = `event: map\ndata: ${JSON.stringify(normalized)}\n\n`;
  assert.ok(oversized.length > 512 * 1024, 'escape expansion must exercise the output guard');
  const f = await fixture(t, {
    catalog,
    invokeEvents: () => eventsFrom([{ type: 'map', ...input }, { type: 'done' }]),
  });
  const response = await f.post(await f.cookie()).completed;
  assert.equal(response.status, 200, 'the SSE headers are already sent');
  const output = events(response.body);
  assert.equal(output.filter((event) => event.event === 'map').length, 0);
  const errors = output.filter((event) => event.event === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].data.code, 'invalid_response');
  assert.equal(output.filter((event) => event.event === 'done').length, 1);
  assert.deepEqual(output.at(-1), { event: 'done', data: {} });
  assert.ok(response.body.split('\n\n').filter(Boolean).every((part) => (part + '\n\n').length <= 512 * 1024));
});

test('broad family requests relay bounded catalog context and label catalog-assisted empty model results', async (t) => {
  const place = {
    id: 'family-park', name: '가족공원', category: '관광지', lat: 33.4, lng: 126.5,
    source: 'sample', tags: ['아이동반', '가족'], base_note: '기본 정보 공식 대조 검증 미확인',
    facilities: { parking: 'yes', restroom: 'unknown' }, hours_week: [], sources: [],
  };
  const invoked = [];
  const f = await fixture(t, {
    catalog: {
      status: () => ({ status: 'ready' }),
      search: ({ category }) => ({ items: category === place.category ? [place] : [] }),
      detail: (id) => id === place.id ? place : null,
    },
    invokeEvents: (input) => {
      invoked.push(input);
      return eventsFrom([
        { type: 'token', text: '검색한 복합 키워드와 일치하는 결과를 찾지 못했습니다.' },
        { type: 'map', ...mapResponse({ answer: '검색한 복합 키워드와 일치하는 결과를 찾지 못했습니다.' }) },
        { type: 'done' },
      ]);
    },
  });
  const response = await f.post(await f.cookie(), {
    message: '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.',
  }).completed;
  assert.equal(response.status, 200);
  assert.equal(invoked.length, 1);
  assert.equal(f.quotas.length, 1);
  assert.ok(invoked[0].message.length <= 2000);
  assert.match(invoked[0].message, /가족공원/);
  const output = events(response.body);
  const map = output.find((event) => event.event === 'map').data;
  assert.deepEqual(map.markers.map((marker) => marker.id), [place.id]);
  assert.equal(map.place_info[0].facilities.restroom, 'unknown');
  assert.match(map.answer, /카탈로그 참고 장소/);
  assert.match(output.filter((event) => event.event === 'text').map((event) => event.data.delta).join(''), /카탈로그 참고 장소/);
  assert.match(map.warnings.join(' '), /AI의 검색 결과가 부족/);
  assert.equal(output.at(-1).event, 'done');
});

test('catalog grounding does not bypass exhausted guide quotas', async (t) => {
  let searches = 0;
  const f = await fixture(t, {
    consumeQuota: async () => false,
    catalog: {
      status: () => ({ status: 'ready' }),
      search: () => { searches++; return { items: [] }; }, detail: () => null,
    },
  });
  const response = await f.post(await f.cookie(), { message: '아이와 함께 방문할 장소 추천' }).completed;
  assert.equal(response.status, 429);
  assert.equal(searches, 0);
  assert.equal(f.invocations.length, 0);
});
