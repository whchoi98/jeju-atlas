import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGuide } from '../src/guide-request.ts';
import { getConfig } from '../src/api.ts';

test('one user submission carries the same UUID request_id through the only authentication retry', async () => {
  const requestId = 'd4f62d8a-81b6-4fa3-85fe-d59d9cef0d08';
  const calls = [];
  await requestGuide({ message: '한라산 근처 맛집?', requestId, signal: new AbortController().signal }, {
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return calls.length === 1
        ? new Response(JSON.stringify({ error: { code: 'invalid_conversation' } }), { status: 403 })
        : new Response('event: done\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(body => body.request_id === requestId));
  assert.equal(calls[0].message, calls[1].message);
  assert.ok(calls.every(body => new TextEncoder().encode(JSON.stringify(body)).length <= 16384));
});

test('malformed request identifiers fail before sending a model request', async () => {
  let calls = 0;
  await assert.rejects(requestGuide({ message: '검증', requestId: 'not-a-uuid', signal: new AbortController().signal }, {
    fetchImpl: async () => { calls++; return new Response(''); },
  }));
  assert.equal(calls, 0);
});

test('config can be refreshed by age after a service pause without reloading the application', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ version: 'test', features: { guide: calls > 1 }, guide: { daily_limit: 30 } }));
  };
  try {
    assert.equal((await getConfig(true)).features.guide, false);
    assert.equal((await getConfig(false, 0)).features.guide, true);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('an authentication refresh cannot reuse an older in-flight config proof or be replaced by its late response', async () => {
  const original = globalThis.fetch;
  let finishOld;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finishOld = resolve; });
    return new Response(JSON.stringify({ version: 'fresh', features: { guide: true }, guide: { daily_limit: 30, csrf_token: 'fresh-proof' } }));
  };
  try {
    const old = getConfig(true);
    const fresh = getConfig(true);
    assert.equal(calls, 2, 'Force refresh must start after the authentication rejection');
    assert.equal((await fresh).guide.csrf_token, 'fresh-proof');
    finishOld(new Response(JSON.stringify({ version: 'old', features: { guide: false }, guide: { daily_limit: 30, csrf_token: 'old-proof' } })));
    await old;
    assert.equal((await getConfig()).guide.csrf_token, 'fresh-proof');
  } finally {
    finishOld?.(new Response(JSON.stringify({ version: 'old', features: { guide: false }, guide: { daily_limit: 30 } })));
    globalThis.fetch = original;
  }
});
