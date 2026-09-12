import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmission, createMemoryAdmissionStore, AdmissionError } from '../server/admission.mjs';
import { createAgentInvoker, createGuideHandler, GuideError } from '../server/guide.mjs';
import { createSessions } from '../server/sessions.mjs';
import { requestGuide } from '../src/guide-request.ts';
import { admissionDynamo } from './fixtures/admission-dynamo.mjs';

const NOW = Date.parse('2026-09-12T10:00:00Z');
const SECRET = 'unlimited-guide-shared-test-secret-at-least-32-bytes';
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const question = extra => ({ message: '안녕하세요', request_id: randomUUID(), ...extra });
const frames = body => body.split('\n\n').flatMap(block => {
  const event = block.match(/^event: (.+)$/m)?.[1];
  const data = block.match(/^data: (.+)$/m)?.[1];
  return event && data ? [{ event, data: JSON.parse(data) }] : [];
});
const completedEvents = async function* () {
  yield { type: 'map', answer: '테스트 답변', markers: [], route: [], warnings: [] };
  yield { type: 'done' };
};
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'expected requests to reach the runtime');
}

// Exercise the real guide/sessions/admission/SDK adapters without coupling to
// the API wiring being changed concurrently. Only the runtime and Dynamo wire
// are doubles; each handler has a separately constructed Dynamo store.
async function fixture(t, { invokeEvents = completedEvents, store, admission: useAdmission = true, ...options } = {}) {
  let now = NOW;
  const clock = () => now;
  const database = admissionDynamo();
  const sessions = createSessions({ secret: SECRET, clock });
  const invocations = [];
  const guides = [];
  const servers = [];
  const quotas = [];
  t.after(async () => {
    guides.forEach(guide => guide.close());
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  });
  for (let i = 0; i < 2; i++) {
    const admission = useAdmission ? createAdmission({
      limitsEnabled: false, clock, ...(store ? { store } : { table: 'test-admission', client: database.client() }),
    }) : undefined;
    const guide = createGuideHandler({
      sessions, admission, limitsEnabled: false, clock, requestHashKey: SECRET,
      maxActors: 1, deadlineMs: 5000,
      consumeQuota: async () => { quotas.push('legacy quota called'); return false; },
      invokeEvents: input => { invocations.push(input); return invokeEvents(input); },
      ...options,
    });
    guides.push(guide);
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/config') {
          sessions.issueCookie(res);
          res.setHeader('Content-Type', 'application/json');
          res.end('{}');
          return;
        }
        const actor = sessions.readCookie(req.headers.cookie);
        if (!actor) throw new GuideError(401, 'invalid_request');
        let body = '';
        for await (const chunk of req) body += chunk;
        await guide.handle(req, res, JSON.parse(body), actor.actorId);
      } catch (error) {
        const failure = error instanceof AdmissionError ? new GuideError(error.status, error.code) : error;
        res.writeHead(failure.status || 500, { 'Content-Type': 'application/json',
          ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) });
        res.end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
      }
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const url = index => `http://127.0.0.1:${servers[index].address().port}`;
  const cookie = async () => (await fetch(`${url(0)}/config`)).headers.get('set-cookie').split(';')[0];
  const post = (index, cookie, body) => fetch(`${url(index)}/guide`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { database, sessions, cookie, post, invocations, quotas, guides, url,
    advance(ms) { now += ms; } };
}

test('two handlers and Dynamo stores allow forty same-browser turns in one hour with limits off', async t => {
  const f = await fixture(t);
  const cookie = await f.cookie();
  let conversation_id;
  for (let i = 0; i < 40; i++) {
    const response = await f.post(i % 2, cookie, question(conversation_id ? { conversation_id } : {}));
    assert.equal(response.status, 200);
    const output = frames(await response.text());
    assert.equal(output.some(frame => frame.event === 'error'), false);
    assert.equal(output.at(-1).event, 'done');
    conversation_id = output.find(frame => frame.event === 'session').data.conversation_id;
  }
  assert.equal(f.invocations.length, 40);
  assert.equal(new Set(f.invocations.map(input => input.conversationId)).size, 1);
  assert.equal(f.quotas.length, 0);
  assert.ok([...f.database.rows.keys()].every(id => /^(request|conversation)#/.test(id)));
});

test('six actors and six conversations from the same actor all reach the runtime simultaneously', async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    invokeEvents: async function* () { await release.promise; yield* completedEvents(); },
  });
  const cookies = await Promise.all(Array.from({ length: 6 }, () => f.cookie()));
  const pending = await Promise.all([...cookies, ...Array(5).fill(cookies[0])]
    .map((cookie, i) => f.post(i % 2, cookie, question())));
  assert.ok(pending.every(response => response.status === 200));
  await until(() => f.invocations.length === 11);
  assert.equal(new Set(f.invocations.map(input => input.actorId)).size, 6);
  assert.equal(new Set(f.invocations.map(input => input.conversationId)).size, 11);
  release.resolve();
  await Promise.all(pending.map(async response => assert.doesNotMatch(await response.text(), /event: error/)));
  assert.equal(f.quotas.length, 0);
});

test('same conversation is specifically busy across handlers; duplicate IDs and actor forgery do not invoke again', async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    invokeEvents: async function* () { await release.promise; yield* completedEvents(); },
  });
  const cookie = await f.cookie();
  const actor = f.sessions.readCookie(cookie).actorId;
  const conversation_id = f.sessions.createConversation(actor).token;
  const body = question({ conversation_id });
  const first = await f.post(0, cookie, body);
  assert.equal(first.status, 200);
  await until(() => f.invocations.length === 1);
  const busy = await f.post(1, cookie, question({ conversation_id }));
  assert.equal(busy.status, 409);
  assert.equal(busy.headers.get('retry-after'), '120');
  const busyError = (await busy.json()).error;
  assert.equal(busyError.code, 'conversation_busy');
  assert.match(busyError.message, /대화/);
  const duplicate = await f.post(1, cookie, body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'request_in_progress');
  const foreign = await f.post(1, await f.cookie(), question({ conversation_id }));
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, 'invalid_conversation');
  release.resolve();
  await first.text();
  const replay = await f.post(1, cookie, body);
  assert.equal((await replay.json()).error.code, 'request_completed');
  assert.equal(f.invocations.length, 1);
});

test('unknown runtime outcomes block retries of that ID and that conversation, but allow another conversation', async t => {
  let attempts = 0;
  const f = await fixture(t, {
    invokeEvents: async function* () {
      if (++attempts === 1) throw new Error('runtime response lost');
      yield* completedEvents();
    },
  });
  const cookie = await f.cookie();
  const conversation_id = f.sessions.createConversation(f.sessions.readCookie(cookie).actorId).token;
  const body = question({ conversation_id });
  const first = await f.post(0, cookie, body);
  assert.match(await first.text(), /event: error/);
  const duplicate = await f.post(1, cookie, body);
  assert.equal((await duplicate.json()).error.code, 'request_unknown');
  const busy = await f.post(1, cookie, question({ conversation_id }));
  assert.equal((await busy.json()).error.code, 'conversation_busy');
  const independent = await f.post(1, cookie, question());
  assert.doesNotMatch(await independent.text(), /event: error/);
  assert.equal(f.invocations.length, 2);
  f.advance(120_001);
  const stillUnknown = await f.post(0, cookie, body);
  assert.equal((await stillUnknown.json()).error.code, 'request_unknown');
  const next = await f.post(1, cookie, question({ conversation_id }));
  assert.doesNotMatch(await next.text(), /event: error/);
  assert.equal(f.invocations.length, 3);
});

test('storage failure with limits off never falls back to local admission or invokes the model', async t => {
  const store = createMemoryAdmissionStore();
  store.read = async () => { throw new Error('private storage detail'); };
  const f = await fixture(t, { store });
  const response = await f.post(0, await f.cookie(), question());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'quota_unavailable');
  assert.equal(f.invocations.length, 0);
  assert.equal(f.quotas.length, 0);
});

test('disabling limits requires admission instead of silently using a legacy quota hook', async t => {
  const f = await fixture(t, { admission: false });
  const response = await f.post(0, await f.cookie(), question());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'quota_unavailable');
  assert.equal(f.invocations.length, 0);
  assert.equal(f.quotas.length, 0);
});

test('lost start acknowledgement is reported safely and a retry never makes a model call', async t => {
  const store = createMemoryAdmissionStore();
  const commit = store.commit.bind(store);
  let loseAck = true;
  store.commit = async changes => {
    await commit(changes);
    if (loseAck && changes.some(({ after }) => after.state === 'started')) {
      loseAck = false;
      throw new Error('start acknowledgement lost');
    }
  };
  const f = await fixture(t, { store });
  const cookie = await f.cookie();
  const body = question();
  const first = await f.post(0, cookie, body);
  const error = frames(await first.text()).find(frame => frame.event === 'error').data;
  assert.equal(error.code, 'quota_unavailable');
  const retry = await f.post(1, cookie, body);
  assert.equal((await retry.json()).error.code, 'request_unknown');
  assert.equal(f.invocations.length, 0);
});

test('lost completion acknowledgement cannot trigger a second model invocation', async t => {
  const store = createMemoryAdmissionStore();
  const commit = store.commit.bind(store);
  let loseAck = true;
  store.commit = async changes => {
    await commit(changes);
    if (loseAck && changes.some(({ after }) => after.state === 'completed')) {
      loseAck = false;
      throw new Error('completion acknowledgement lost');
    }
  };
  const f = await fixture(t, { store });
  const cookie = await f.cookie();
  const body = question();
  const first = await f.post(0, cookie, body);
  const error = frames(await first.text()).find(frame => frame.event === 'error').data;
  assert.equal(error.code, 'request_unknown');
  const retry = await f.post(1, cookie, body);
  assert.equal((await retry.json()).error.code, 'request_completed');
  assert.equal(f.invocations.length, 1);
});

test('the browser request client never retries busy or duplicate responses, nor a failed model stream', async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    invokeEvents: async function* () { await release.promise; throw Object.assign(new Error('upstream busy'), { name: 'ThrottlingException' }); },
  });
  const cookie = await f.cookie();
  const conversationId = f.sessions.createConversation(f.sessions.readCookie(cookie).actorId).token;
  const requestId = randomUUID();
  let httpCalls = 0;
  const fetchImpl = (_url, init) => {
    httpCalls++;
    return fetch(`${f.url(httpCalls % 2)}/guide`, { ...init, headers: { ...init.headers, Cookie: cookie } });
  };
  const options = { message: 'Hello', requestId, conversationId, signal: new AbortController().signal };
  const response = await requestGuide(options, { fetchImpl });
  await until(() => f.invocations.length === 1);
  await assert.rejects(requestGuide(options, { fetchImpl }), error => error.code === 'request_in_progress');
  await assert.rejects(requestGuide({ ...options, requestId: randomUUID() }, { fetchImpl }), error => error.code === 'conversation_busy');
  release.resolve();
  assert.match(await response.text(), /"code":"guide_busy"/);
  await assert.rejects(requestGuide(options, { fetchImpl }), error => error.code === 'request_unknown');
  assert.equal(httpCalls, 4);
  assert.equal(f.invocations.length, 1);
});

test('runtime conversation_busy survives the stream and retries cannot invoke the model again', async t => {
  let runtimeCalls = 0;
  const diagnostics = [];
  const invokeEvents = createAgentInvoker({
    runtimeArn: 'arn:aws:bedrock-agentcore:ap-northeast-2:123456789012:runtime/TestRuntime-1234567890',
    client: {
      async send() {
        runtimeCalls++;
        return {
          contentType: 'text/event-stream',
          response: [Buffer.from('data: {"type":"error","code":"conversation_busy","message":"private-runtime-detail"}\n\n')],
        };
      },
    },
  });
  t.after(() => invokeEvents.close());
  const f = await fixture(t, { invokeEvents, onDiagnostic: event => diagnostics.push(event) });
  const cookie = await f.cookie();
  const conversationId = f.sessions.createConversation(f.sessions.readCookie(cookie).actorId).token;
  let httpCalls = 0;
  let recoveries = 0;
  let refreshes = 0;
  const dependencies = {
    fetchImpl: (_url, init) => fetch(`${f.url(httpCalls++ % 2)}/guide`, {
      ...init, headers: { ...init.headers, Cookie: cookie },
    }),
    refreshSession: async () => { refreshes++; return 'unexpected-refresh'; },
  };
  const options = {
    message: 'Hello', conversationId, requestId: randomUUID(),
    signal: new AbortController().signal, onRecovery: () => { recoveries++; },
  };
  const response = await requestGuide(options, dependencies);
  assert.equal(response.status, 200, 'the already-open SSE response carries the runtime error');
  const output = frames(await response.text());
  assert.deepEqual(output.map(frame => frame.event), ['session', 'status', 'error', 'done']);
  assert.equal(output[2].data.code, 'conversation_busy');
  assert.match(output[2].data.message, /이 대화/);
  assert.doesNotMatch(JSON.stringify(output), /private-runtime-detail|agent_error/);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'conversation_busy');
  assert.equal(diagnostics[0].type, 'RuntimeError');
  assert.equal(httpCalls, 1, 'a streamed runtime rejection must not start an automatic POST');
  assert.equal(runtimeCalls, 1);

  // Explicit replays hit both handlers, including after the lease has expired.
  // The failed request ID remains terminal and never submits to the SDK again.
  for (const elapsed of [0, 120_001]) {
    f.advance(elapsed);
    await assert.rejects(requestGuide(options, dependencies),
      error => error.status === 409 && error.code === 'request_unknown');
  }
  assert.equal(httpCalls, 3, 'only the initial send and the two explicit replays reach HTTP');
  assert.equal(f.invocations.length, 1);
  assert.equal(runtimeCalls, 1);
  assert.equal(recoveries, 0);
  assert.equal(refreshes, 0);
});

test('createGuideHandler rejects non-boolean limitsEnabled values', () => {
  assert.throws(() => createGuideHandler({ limitsEnabled: 'false' }));
});
