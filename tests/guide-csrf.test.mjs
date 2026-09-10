import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApiHandler } from '../server/api.mjs';
import { createAppServer } from '../server/server.mjs';

async function fixture(t) {
  let now = Date.parse('2026-09-10T00:00:00Z');
  let models = 0;
  let quotas = 0;
  const api = createApiHandler({
    env: { NODE_ENV: 'production' },
    secret: 'csrf-test-secret-at-least-thirty-two-bytes',
    publicOrigin: 'https://atlas.example.test',
    clock: () => now,
    consumeQuota: async () => { quotas++; return true; },
    invokeEvents: async function* () {
      models++;
      yield { type: 'token', text: '카탈로그에 등록된 장소를 확인했습니다.' };
      yield { type: 'done' };
    },
  });
  const server = createAppServer({ root: 'public', api });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: body ? 'POST' : 'GET', headers }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return {
    call, counts: () => ({ models, quotas }), advance: (ms) => { now += ms; },
    config: async (cookie) => {
      const response = await call('/api/config', cookie ? { Cookie: cookie } : {});
      return { response, cookie: response.headers['set-cookie']?.[0].split(';')[0] ?? cookie,
        token: JSON.parse(response.text).guide.csrf_token };
    },
    post: (cookie, token, origin) => call('/api/guide', {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { 'X-Atlas-CSRF': token } : {}),
      ...(origin !== undefined ? { Origin: origin } : {}),
    }, { message: '성산일출봉 근처 맛집을 알려주세요.' }),
  };
}

test('private config issues a stable CSRF proof bound to its signed session', async (t) => {
  const f = await fixture(t);
  const first = await f.config();
  assert.match(first.token ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.response.headers['cache-control'], 'no-store');
  const repeated = await f.config(first.cookie);
  assert.equal(repeated.token, first.token);
  const other = await f.config();
  assert.notEqual(other.token, first.token);
  assert.deepEqual(f.counts(), { models: 0, quotas: 0 });
});

test('verified app proofs allow session-bound requests when browser Origin is absent, null, or different', async (t) => {
  const f = await fixture(t);
  const session = await f.config();
  for (const origin of [undefined, 'null', 'https://preview.example.test']) {
    const result = await f.post(session.cookie, session.token, origin);
    assert.equal(result.status, 200);
    assert.match(result.text, /event: done/);
  }
  assert.deepEqual(f.counts(), { models: 3, quotas: 3 });
});

test('foreign requests without proof and forged or cross-session proofs never call the model', async (t) => {
  const f = await fixture(t);
  const own = await f.config();
  const other = await f.config();
  for (const [cookie, token] of [
    [own.cookie, undefined], [own.cookie, 'forged'], [own.cookie, `${own.token}x`],
    [other.cookie, own.token], [undefined, own.token], ['atlas_sid=forged', own.token],
  ]) {
    const result = await f.post(cookie, token, 'https://foreign.example.test');
    assert.equal(result.status, 403);
    assert.equal(JSON.parse(result.text).error.code, token ? 'csrf_invalid' : 'origin_forbidden');
  }
  assert.deepEqual(f.counts(), { models: 0, quotas: 0 });
});

test('an expired signed cookie also expires its request proof', async (t) => {
  const f = await fixture(t);
  const session = await f.config();
  f.advance(30 * 86400000);
  assert.equal((await f.post(session.cookie, session.token, 'null')).status, 403);
  assert.deepEqual(f.counts(), { models: 0, quotas: 0 });
});

test('canonical-Origin clients keep the original session gate and do not need the new header', async (t) => {
  const f = await fixture(t);
  const session = await f.config();
  assert.equal((await f.post(session.cookie, undefined, 'https://atlas.example.test')).status, 200);
  assert.equal((await f.post(undefined, undefined, 'https://atlas.example.test')).status, 401);
  assert.deepEqual(f.counts(), { models: 1, quotas: 1 });
});
