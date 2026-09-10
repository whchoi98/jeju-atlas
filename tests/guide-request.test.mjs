import test from 'node:test';
import assert from 'node:assert/strict';

let requestGuide;
try { ({ requestGuide } = await import('../src/guide-request.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const rejected = (status, code) => new Response(JSON.stringify({ error: { code } }), {
  status, headers: { 'Content-Type': 'application/json' },
});
const streamed = (body = 'event: done\ndata: {}\n\n') => new Response(body, {
  status: 200, headers: { 'Content-Type': 'text/event-stream' },
});
const question = '한라산 근처 맛집?';

test('403 invalid_conversation retries exactly the same question once without the expired token', async () => {
  assert.equal(typeof requestGuide, 'function');
  const calls = [];
  const recoveries = [];
  let refreshes = 0;
  const controller = new AbortController();
  const response = await requestGuide({
    message: question, conversationId: 'expired-signed-token', signal: controller.signal,
    onRecovery: (code) => recoveries.push(code),
  }, {
    fetchImpl: async (_url, init) => {
      calls.push({ payload: JSON.parse(init.body), credentials: init.credentials, signal: init.signal });
      return calls.length === 1 ? rejected(403, 'invalid_conversation') : streamed();
    },
    refreshSession: async () => { refreshes++; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.payload), [
    { message: question, conversation_id: 'expired-signed-token' }, { message: question },
  ]);
  assert.ok(calls.every((call) => call.credentials === 'same-origin' && call.signal === controller.signal));
  assert.deepEqual(recoveries, ['invalid_conversation']);
  assert.equal(refreshes, 0);
});

test('401 session_required refreshes the cookie and proof once and discards the old actor-bound conversation', async () => {
  assert.equal(typeof requestGuide, 'function');
  const requests = [];
  const proofs = [];
  let refreshes = 0;
  await requestGuide({ message: question, conversationId: 'old-actor-token', csrfToken: 'old-actor-proof', signal: new AbortController().signal }, {
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      proofs.push(new Headers(init.headers).get('X-Atlas-CSRF'));
      return requests.length === 1 ? rejected(401, 'session_required') : streamed();
    },
    refreshSession: async () => { refreshes++; return 'new-actor-proof'; },
  });
  assert.equal(refreshes, 1);
  assert.deepEqual(requests, [{ message: question, conversation_id: 'old-actor-token' }, { message: question }]);
  assert.deepEqual(proofs, ['old-actor-proof', 'new-actor-proof']);
});

test('the recoverable statuses share one retry budget', async () => {
  assert.equal(typeof requestGuide, 'function');
  let calls = 0;
  let refreshes = 0;
  await assert.rejects(requestGuide({ message: question, signal: new AbortController().signal }, {
    fetchImpl: async () => ++calls === 1 ? rejected(403, 'invalid_conversation') : rejected(401, 'session_required'),
    refreshSession: async () => { refreshes++; },
  }), (error) => error.status === 401 && error.code === 'session_required');
  assert.equal(calls, 2);
  assert.equal(refreshes, 0);
});

test('a configured CSRF proof is sent only as a header and absent proofs are omitted', async () => {
  for (const csrfToken of [undefined, '', 'signed-app-proof']) {
    let captured;
    await requestGuide({ message: question, csrfToken, signal: new AbortController().signal }, {
      fetchImpl: async (_url, init) => { captured = init; return streamed(); },
    });
    assert.equal(new Headers(captured.headers).get('X-Atlas-CSRF'), csrfToken || null);
    assert.deepEqual(JSON.parse(captured.body), { message: question });
  }
});

test('a rejected stale or forged CSRF proof is replaced before the single retry', async () => {
  for (const oldProof of ['stale-proof', 'forged-proof']) {
    const calls = [];
    let refreshes = 0;
    await requestGuide({
      message: question, conversationId: 'old-conversation', csrfToken: oldProof,
      signal: new AbortController().signal,
    }, {
      fetchImpl: async (_url, init) => {
        calls.push({ body: JSON.parse(init.body), proof: new Headers(init.headers).get('X-Atlas-CSRF') });
        return calls.length === 1 ? rejected(403, 'csrf_invalid') : streamed();
      },
      refreshSession: async () => { refreshes++; return 'fresh-bound-proof'; },
    });
    assert.equal(refreshes, 1);
    assert.deepEqual(calls.map((call) => call.proof), [oldProof, 'fresh-bound-proof']);
    assert.ok(calls.every((call) => call.body.message === question));
    assert.equal(calls[1].body.conversation_id, undefined);
  }
});

test('CSRF recovery and conversation/session recovery cannot accumulate retries', async () => {
  for (const responses of [
    [[403, 'csrf_invalid'], [403, 'invalid_conversation']],
    [[403, 'invalid_conversation'], [403, 'csrf_invalid']],
    [[401, 'session_required'], [403, 'csrf_invalid']],
    [[403, 'csrf_invalid'], [401, 'session_required']],
  ]) {
    let calls = 0;
    let refreshes = 0;
    await assert.rejects(requestGuide({
      message: question, csrfToken: 'old-proof', signal: new AbortController().signal,
    }, {
      fetchImpl: async () => { const value = responses[Math.min(calls++, 1)]; return rejected(...value); },
      refreshSession: async () => { refreshes++; return 'new-proof'; },
    }));
    assert.equal(calls, 2);
    assert.equal(refreshes, responses[0][1] === 'invalid_conversation' ? 0 : 1);
  }
});

test('the default recovery refresh uses the new private config proof', async (t) => {
  let configs = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/config');
    configs++;
    return new Response(JSON.stringify({
      version: 'test', features: { guide: true }, guide: { daily_limit: 30, csrf_token: 'config-fresh-proof' },
    }), { headers: { 'Content-Type': 'application/json' } });
  });
  const proofs = [];
  await requestGuide({ message: question, csrfToken: 'old-proof', signal: new AbortController().signal }, {
    fetchImpl: async (_url, init) => {
      proofs.push(new Headers(init.headers).get('X-Atlas-CSRF'));
      return proofs.length === 1 ? rejected(403, 'csrf_invalid') : streamed();
    },
  });
  assert.equal(configs, 1);
  assert.deepEqual(proofs, ['old-proof', 'config-fresh-proof']);
});

test('origin, quota, server and non-exact authentication errors never retry', async () => {
  assert.equal(typeof requestGuide, 'function');
  for (const [status, code] of [
    [403, 'origin_forbidden'], [403, 'forbidden'], [403, 'INVALID_CONVERSATION'],
    [403, 'session_required'], [401, 'invalid_conversation'], [429, 'daily_limit'],
    [500, 'invalid_conversation'], [503, 'guide_unavailable'],
    [401, 'csrf_invalid'], [403, 'CSRF_INVALID'], [429, 'csrf_invalid'], [503, 'csrf_invalid'],
  ]) {
    let calls = 0;
    let refreshes = 0;
    await assert.rejects(requestGuide({ message: question, signal: new AbortController().signal }, {
      fetchImpl: async () => { calls++; return rejected(status, code); },
      refreshSession: async () => { refreshes++; },
    }), (error) => error.status === status && error.code === code);
    assert.equal(calls, 1, `${status} ${code}`);
    assert.equal(refreshes, 0, `${status} ${code}`);
  }
});

test('network failures and successful HTTP streams containing SSE errors never replay a billable request', async () => {
  assert.equal(typeof requestGuide, 'function');
  let calls = 0;
  await assert.rejects(requestGuide({ message: question, signal: new AbortController().signal }, {
    fetchImpl: async () => { calls++; throw new TypeError('network failure'); },
  }), TypeError);
  assert.equal(calls, 1);
  for (const code of ['invalid_conversation', 'csrf_invalid']) {
    calls = 0;
    const response = await requestGuide({ message: question, csrfToken: 'proof', signal: new AbortController().signal }, {
      fetchImpl: async () => { calls++; return streamed(`event: error\ndata: ${JSON.stringify({ code })}\n\n`); },
    });
    assert.match(await response.text(), /event: error/);
    assert.equal(calls, 1);
  }
});

test('cancelling a CSRF refresh prevents a second POST even if refresh later succeeds', async () => {
  const controller = new AbortController();
  let calls = 0;
  let refreshStarted;
  let finish;
  const refreshing = new Promise((resolve) => { refreshStarted = resolve; });
  const request = requestGuide({ message: question, csrfToken: 'old', signal: controller.signal }, {
    fetchImpl: async () => { calls++; return rejected(403, 'csrf_invalid'); },
    refreshSession: () => { refreshStarted(); return new Promise((resolve) => { finish = resolve; }); },
  });
  await refreshing;
  controller.abort();
  await assert.rejects(request, (error) => error.name === 'AbortError');
  finish('new-proof');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('cancelling during cookie refresh prevents the second POST', async () => {
  assert.equal(typeof requestGuide, 'function');
  const controller = new AbortController();
  let calls = 0;
  let started;
  const refreshing = new Promise((resolve) => { started = resolve; });
  const request = requestGuide({ message: question, signal: controller.signal }, {
    fetchImpl: async () => { calls++; return rejected(401, 'session_required'); },
    refreshSession: () => { started(); return new Promise(() => {}); },
  });
  await refreshing;
  controller.abort();
  await assert.rejects(request, (error) => error.name === 'AbortError');
  assert.equal(calls, 1);
});
