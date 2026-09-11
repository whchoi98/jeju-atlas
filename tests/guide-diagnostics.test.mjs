import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { createAgentInvoker } from '../server/guide.mjs';

const SECRET = 'diagnostics-unit-secret-with-at-least-32-bytes';
const ORIGIN = 'https://diagnostics.example.test';
const PRIVATE_PROMPT = '한라산 근처 맛집? PRIVATE_PROMPT';
const PRIVATE_ANSWER = 'PRIVATE_ANSWER_FOR_BROWSER_ONLY';
const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/DiagnosticsTest-1234567890';
const NOW = Date.parse('2026-09-10T00:00:00Z');
const map = { answer: PRIVATE_ANSWER, center: null, zoom: 10, markers: [], route: [], route_meta: null, warnings: [] };
const source = async function* (items) { yield* items; };
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
function events(body) {
  return body.split('\n\n').flatMap((frame) => {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    return name && data ? [{ event: name, data: JSON.parse(data) }] : [];
  });
}
function assertRedacted(diagnostics, extra = []) {
  const json = JSON.stringify(diagnostics);
  for (const privateValue of [SECRET, PRIVATE_PROMPT, PRIVATE_ANSWER, RUNTIME_ARN, ...extra]) {
    assert.equal(json.includes(privateValue), false, 'diagnostics must not contain private data');
  }
  for (const entry of diagnostics) {
    assert.ok(Object.keys(entry).every((key) => ['event', 'code', 'status', 'type', 'elapsed_ms'].includes(key)));
    if (entry.type !== undefined) assert.match(entry.type, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
    if (entry.elapsed_ms !== undefined) assert.ok(Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0);
  }
}

async function fixture(t, { onDiagnostic: logger, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-diagnostics-'));
  await writeFile(join(root, 'index.html'), '<title>diagnostics test</title>');
  const diagnostics = [];
  const calls = [];
  const onDiagnostic = (entry) => {
    diagnostics.push(entry);
    return logger?.(entry);
  };
  const api = createApiHandler({
    env: { NODE_ENV: 'production' }, secret: SECRET, publicOrigin: ORIGIN,
    clock: () => NOW, consumeQuota: async () => true,
    invokeEvents: (input) => {
      calls.push(input);
      return source([{ type: 'map', ...map }, { type: 'done' }]);
    },
    ...options, onDiagnostic,
  });
  const server = createAppServer({ root, api, onDiagnostic });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  function start(path, { method = 'GET', headers = {}, body } = {}) {
    const opened = deferred();
    let responseText = '';
    const completed = new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: server.address().port, path, method, headers,
      }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => { responseText += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseText }));
        opened.resolve(res);
      });
      req.on('error', reject);
      req.end(body);
    });
    completed.catch(() => {});
    return { opened: opened.promise, completed, text: () => responseText };
  }
  const get = (path) => start(path).completed;
  const cookie = async () => (await get('/api/config')).headers['set-cookie'][0].split(';')[0];
  const post = (cookieValue, body = { message: PRIVATE_PROMPT }, overrides = {}) => start('/api/guide', {
    method: 'POST', body: JSON.stringify(body), ...overrides,
    headers: {
      'Content-Type': 'application/json', Origin: ORIGIN,
      ...(cookieValue ? { Cookie: cookieValue } : {}), ...overrides.headers,
    },
  });
  return { diagnostics, calls, cookie, post, get };
}

test('invalid conversation rejection records only code and status before any runtime call', async (t) => {
  const f = await fixture(t);
  const cookie = await f.cookie();
  const token = 'PRIVATE_INVALID_CONVERSATION_TOKEN';
  const result = await f.post(cookie, { message: PRIVATE_PROMPT, conversation_id: token }).completed;
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).error.code, 'invalid_conversation');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.diagnostics, [{ event: 'guide_rejected', code: 'invalid_conversation', status: 403 }]);
  assertRedacted(f.diagnostics, [cookie, token]);
});

test('session, origin, body-limit and quota rejections produce one safe diagnostic each', async (t) => {
  for (const [name, options, send, code, status] of [
    ['session', {}, (f) => f.post(undefined), 'session_required', 401],
    ['origin', {}, async (f) => f.post(await f.cookie(), undefined, { headers: { Origin: 'https://foreign.example' } }), 'origin_forbidden', 403],
    ['body', {}, async (f) => {
      const body = JSON.stringify({ message: 'x'.repeat(17_000) });
      return f.post(await f.cookie(), undefined, { body, headers: { 'Content-Length': Buffer.byteLength(body) } });
    }, 'body_too_large', 413],
    ['quota limit', { consumeQuota: async () => false }, async (f) => f.post(await f.cookie()), 'daily_limit', 429],
    ['quota failure', { consumeQuota: async () => { throw new Error(`${SECRET} ${RUNTIME_ARN}`); } }, async (f) => f.post(await f.cookie()), 'quota_unavailable', 503],
  ]) {
    await t.test(name, async (child) => {
      const f = await fixture(child, options);
      const active = await send(f);
      assert.equal((await active.completed).status, status);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.diagnostics, [{ event: 'guide_rejected', code, status }]);
      assertRedacted(f.diagnostics);
    });
  }
});

test('SDK failure records a bounded error type and elapsed time without identities or error contents', async (t) => {
  let now = NOW;
  let command;
  const invokeEvents = createAgentInvoker({
    runtimeArn: RUNTIME_ARN,
    client: {
      async send(input) {
        command = input;
        now += 4321;
        throw Object.assign(new Error(`${PRIVATE_PROMPT} ${PRIVATE_ANSWER} ${SECRET} ${RUNTIME_ARN}`), {
          name: 'AccessDeniedException', actor: input.input.runtimeUserId, payload: input.input.payload,
        });
      },
    },
  });
  const f = await fixture(t, { clock: () => now, invokeEvents });
  const cookie = await f.cookie();
  const result = await f.post(cookie).completed;
  assert.equal(result.status, 200);
  const output = events(result.body);
  assert.equal(output.find((event) => event.event === 'error').data.code, 'agent_error');
  assert.deepEqual(output.at(-1), { event: 'done', data: {} });
  assert.deepEqual(f.diagnostics, [{
    event: 'guide_stream_error', code: 'agent_error', type: 'AccessDeniedException', elapsed_ms: 4321,
  }]);
  const token = output.find((event) => event.event === 'session').data.conversation_id;
  assertRedacted(f.diagnostics, [cookie, token, command.input.runtimeUserId, command.input.runtimeSessionId]);
});

test('unsafe error names are discarded rather than truncated or copied into diagnostic fields', async (t) => {
  for (const name of ['Error', 'ThrottlingException', `Error ${SECRET}`, RUNTIME_ARN, '오류', 'A'.repeat(65), 'Error\nInjectedLog']) {
    await t.test(name.length > 64 ? 'oversized name' : name.includes('\n') ? 'newline name' : 'error name', async (child) => {
      const f = await fixture(child, {
        invokeEvents: async function* () {
          yield { type: 'token', text: PRIVATE_ANSWER };
          throw Object.assign(new Error(`${SECRET} ${PRIVATE_PROMPT}`), { name });
        },
      });
      const result = await f.post(await f.cookie()).completed;
      assert.equal(result.status, 200);
      assert.equal(events(result.body).filter((event) => event.event === 'error').length, 1);
      const type = ['Error', 'ThrottlingException'].includes(name) ? name : 'UnknownError';
      assert.equal(f.diagnostics.length, 1);
      assert.equal(f.diagnostics[0].type, type);
      assertRedacted(f.diagnostics);
    });
  }
});

test('actual runtime error events use a fixed diagnostic type and never echo upstream details', async (t) => {
  const f = await fixture(t, {
    invokeEvents: () => source([
      { type: 'error', code: 'agent_error', message: `${PRIVATE_PROMPT} ${SECRET}`, name: RUNTIME_ARN },
      { type: 'done' },
    ]),
  });
  const result = await f.post(await f.cookie()).completed;
  assert.deepEqual(events(result.body).at(-1), { event: 'done', data: {} });
  assert.deepEqual(f.diagnostics, [{ event: 'guide_stream_error', code: 'agent_error', type: 'RuntimeError', elapsed_ms: 0 }]);
  assertRedacted(f.diagnostics);
});

test('throwing and rejecting diagnostic hooks cannot change HTTP rejection or SSE finalization', async (t) => {
  for (const logger of [
    () => { throw new Error('logger failed'); },
    async () => { throw new Error('async logger failed'); },
  ]) {
    await t.test('logger failure', async (child) => {
      const f = await fixture(child, {
        onDiagnostic: logger,
        invokeEvents: async function* () { throw Object.assign(new Error(SECRET), { name: 'AccessDeniedException' }); },
      });
      const cookie = await f.cookie();
      assert.equal((await f.post(cookie, { message: PRIVATE_PROMPT, conversation_id: 'invalid' }).completed).status, 403);
      const runtime = await f.post(cookie).completed;
      assert.equal(runtime.status, 200);
      assert.equal(events(runtime.body).filter((event) => event.event === 'error').length, 1);
      assert.deepEqual(events(runtime.body).at(-1), { event: 'done', data: {} });
      const body = JSON.stringify({ message: 'x'.repeat(17_000) });
      assert.equal((await f.post(cookie, undefined, { body, headers: { 'Content-Length': Buffer.byteLength(body) } }).completed).status, 413);
      assert.equal(f.diagnostics.length, 3);
      assertRedacted(f.diagnostics, [cookie]);
    });
  }
});

test('response disconnect is diagnosed as cancellation without confusing normal completion', async (t) => {
  const called = deferred();
  const diagnosed = deferred();
  let now = NOW;
  let signal;
  const f = await fixture(t, {
    clock: () => now,
    onDiagnostic: (entry) => diagnosed.resolve(entry),
    invokeEvents: async (input) => {
      signal = input.signal;
      called.resolve();
      return new Promise(() => {});
    },
  });
  const active = f.post(await f.cookie());
  const res = await active.opened;
  await called.promise;
  now += 123;
  res.destroy();
  assert.deepEqual(await diagnosed.promise, {
    event: 'guide_cancelled', code: 'client_disconnected', type: 'AbortError', elapsed_ms: 123,
  });
  assert.equal(signal.aborted, true);
  assert.equal(f.diagnostics.length, 1);
  assertRedacted(f.diagnostics);
});

test('deadline failures retain error delivery and elapsed time rather than being reported as client cancellation', async (t) => {
  let now = NOW;
  const f = await fixture(t, {
    clock: () => now, deadlineMs: 30, heartbeatMs: 10,
    invokeEvents: async () => { now += 30; return new Promise(() => {}); },
  });
  const result = await f.post(await f.cookie()).completed;
  assert.equal(events(result.body).find((event) => event.event === 'error').data.code, 'guide_timeout');
  assert.deepEqual(events(result.body).at(-1), { event: 'done', data: {} });
  assert.deepEqual(f.diagnostics, [{ event: 'guide_stream_error', code: 'guide_timeout', type: 'GuideError', elapsed_ms: 30 }]);
});

test('only actual allowlisted runtime tools gain status metadata, with known prefixes removed', async (t) => {
  const tools = ['find_places', 'place_detail', 'route', 'weather', 'sun_times', 'layer', 'festivals', 'plan_day'];
  const f = await fixture(t, {
    invokeEvents: () => source([
      { type: 'status', stage: 'thinking', tool: 'find_places', message: PRIVATE_PROMPT },
      ...tools.flatMap((tool) => [tool, `ohmyjejutools_${tool}`, `jejuatlastools_${tool}`]).map((tool) => ({
        type: 'status', stage: 'tool', tool, label: SECRET, message: PRIVATE_PROMPT, arguments: { private: RUNTIME_ARN },
      })),
      ...[RUNTIME_ARN, `ohmyjejutools_find_places ${SECRET}`, '__proto__', { name: 'weather', args: PRIVATE_PROMPT }].map((tool) => ({
        type: 'status', stage: 'tool', tool, label: SECRET, arguments: PRIVATE_PROMPT,
      })),
      { type: 'status', stage: PRIVATE_PROMPT, tool: 'weather', label: SECRET },
      { type: 'map', ...map }, { type: 'done' },
    ]),
  });
  const result = await f.post(await f.cookie()).completed;
  const statuses = events(result.body).filter((event) => event.event === 'status').map((event) => event.data);
  const announced = statuses.filter((status) => status.tool);
  assert.deepEqual(announced.map((status) => status.tool), tools.flatMap((tool) => [tool, tool, tool]));
  assert.ok(announced.every((status) => status.stage === 'tool' && /[가-힣]/.test(status.label) && /[가-힣]/.test(status.message)));
  assert.ok(statuses.some((status) => status.stage === 'thinking' && !status.tool));
  assert.ok(statuses.every((status) => ['thinking', 'tool'].includes(status.stage)));
  assert.ok(statuses.every((status) => Object.keys(status).every((key) => ['message', 'stage', 'tool', 'label'].includes(key))));
  for (const privateValue of [PRIVATE_PROMPT, SECRET, RUNTIME_ARN]) assert.equal(JSON.stringify(statuses).includes(privateValue), false);
  assert.deepEqual(f.diagnostics, [], 'normal cleanup is not an error or cancellation');
});

test('an initial thinking status precedes SDK waiting without inventing any tool history', async (t) => {
  const called = deferred();
  const release = deferred();
  const f = await fixture(t, {
    invokeEvents: async () => {
      called.resolve();
      await release.promise;
      return source([{ type: 'map', ...map }, { type: 'done' }]);
    },
  });
  const active = f.post(await f.cookie());
  const res = await active.opened;
  await called.promise;
  while (!active.text().includes('"stage":"thinking"')) await once(res, 'data');
  release.resolve();
  const result = await active.completed;
  const output = events(result.body);
  const statuses = output.filter((event) => event.event === 'status');
  assert.ok(statuses.length >= 1);
  assert.ok(statuses.every((event) => event.data.stage === 'thinking' && event.data.tool === undefined));
  assert.ok(output.findIndex((event) => event.event === 'status') < output.findIndex((event) => event.event === 'map'));
  assert.deepEqual(f.diagnostics, []);
});

test('standalone production wires structured stderr diagnostics for a rejected HTTP guide request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-diagnostic-entry-'));
  await writeFile(join(root, 'index.html'), '<title>production diagnostics test</title>');
  const catalogPath = join(root, 'fixture.sqlite');
  const fixtureScript = fileURLToPath(new URL('./fixtures/catalog-fixture.py', import.meta.url));
  const builder = spawn('python3', [fixtureScript, catalogPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let buildErrors = '';
  builder.stderr.on('data', (chunk) => { buildErrors += chunk; });
  assert.equal((await once(builder, 'exit'))[0], 0, buildErrors);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/server.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH, NODE_ENV: 'production', STATIC_ROOT: root, HOST: '127.0.0.1', PORT: '0',
      CATALOG_LOCAL_PATH: catalogPath, ATLAS_SESSION_SECRET: SECRET, PUBLIC_ORIGIN: ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const listening = deferred();
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.event === 'listening') listening.resolve(event);
      } catch { /* wait for a complete structured line */ }
    }
  });
  const exited = once(child, 'exit');
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const address = await Promise.race([
    listening.promise,
    exited.then(() => { throw new Error('Standalone server exited before listening'); }),
  ]);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/guide`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: PRIVATE_PROMPT }),
  });
  assert.equal(response.status, 401);
  await response.arrayBuffer();
  child.kill('SIGTERM');
  await closed;
  const diagnostics = stderr.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.event === 'guide_rejected' ? [entry] : [];
    } catch { return []; }
  });
  assert.deepEqual(diagnostics, [{ event: 'guide_rejected', code: 'session_required', status: 401 }]);
  assertRedacted(diagnostics);
  for (const privateValue of [PRIVATE_PROMPT, SECRET, RUNTIME_ARN]) assert.equal((stderr + stdout).includes(privateValue), false);
});
