import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { requestGuide } from '../src/guide-request.ts';

test('real pre-invocation expiry recovery consumes one quota for the current question', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-recovery-billing-'));
  await writeFile(join(root, 'index.html'), '<title>Recovery fixture</title>');
  const origin = 'https://atlas.example.test';
  let now = Date.parse('2026-09-10T01:00:00Z');
  let quota = 0;
  const invocations = [];
  const api = createApiHandler({
    env: { NODE_ENV: 'test' }, secret: 'recovery-billing-local-test-dummy-secret-32bytes',
    publicOrigin: origin, clock: () => now,
    consumeQuota: async () => { quota++; return true; },
    invokeEvents: async function* (input) {
      invocations.push(input);
      yield { type: 'token', text: '검증된 요청입니다.' };
      yield { type: 'map', version: '2', answer: '검증된 요청입니다.', center: { lat: 33.4, lng: 126.5 }, zoom: 10, markers: [], route: [], route_meta: null, warnings: [] };
      yield { type: 'done' };
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
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let requestOrigin = origin;
  const postStatuses = [];
  const fetchImpl = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (requestOrigin) headers.set('Origin', requestOrigin);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(new URL(path, base), { ...init, headers });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (init.method === 'POST') postStatuses.push(response.status);
    return response;
  };
  await fetchImpl('/api/config');
  const first = await requestGuide({ message: '안녕하세요', signal: new AbortController().signal }, { fetchImpl });
  const text = await first.text();
  const token = JSON.parse(text.split('\n\n').find((event) => event.startsWith('event: session')).split('\ndata: ')[1]).conversation_id;
  assert.equal(quota, 1);
  now += 15 * 60_000;
  const response = await requestGuide({
    message: '후속 안내 부탁해요', conversationId: token, signal: new AbortController().signal,
  }, { fetchImpl });
  const answer = await response.text();
  assert.match(answer, /event: done/);
  assert.doesNotMatch(answer, /event: error/);
  assert.deepEqual(postStatuses, [200, 403, 200]);
  assert.equal(quota, 2, 'The rejected expiry attempt must not consume an extra quota');
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[1].conversationId, invocations[0].conversationId);

  cookie = 'atlas_sid=expired-or-invalid';
  let refreshes = 0;
  const next = await requestGuide({
    message: '다음 안내 부탁해요', conversationId: token, signal: new AbortController().signal,
  }, {
    fetchImpl,
    refreshSession: async () => {
      refreshes++;
      return (await (await fetchImpl('/api/config')).json()).guide.csrf_token;
    },
  });
  assert.doesNotMatch(await next.text(), /event: error/);
  assert.deepEqual(postStatuses.slice(-2), [401, 200]);
  assert.equal(refreshes, 1);
  assert.equal(quota, 3);
  assert.equal(invocations.length, 3);

  requestOrigin = undefined;
  const config = await (await fetchImpl('/api/config')).json();
  assert.ok(config.guide.csrf_token);
  const withoutOrigin = await requestGuide({
    message: '요청 연결 확인', csrfToken: config.guide.csrf_token, signal: new AbortController().signal,
  }, { fetchImpl });
  assert.doesNotMatch(await withoutOrigin.text(), /event: error/);
  assert.equal(quota, 4);
  assert.equal(invocations.length, 4);

  let csrfRefreshes = 0;
  const corrected = await requestGuide({
    message: '확인 정보 갱신', csrfToken: 'stale-proof', conversationId: token,
    signal: new AbortController().signal,
  }, {
    fetchImpl,
    refreshSession: async () => {
      csrfRefreshes++;
      return (await (await fetchImpl('/api/config')).json()).guide.csrf_token;
    },
  });
  assert.doesNotMatch(await corrected.text(), /event: error/);
  assert.deepEqual(postStatuses.slice(-2), [403, 200]);
  assert.equal(csrfRefreshes, 1);
  assert.equal(quota, 5, 'The rejected CSRF attempt must not consume a quota');
  assert.equal(invocations.length, 5);
});
