import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createApiHandler } from '../server/api.mjs';

const proofSecret = 'presence-api-fixture-secret-32-characters';
const stats = { active_visitors: 2, total_visitors: 7, as_of: '2026-09-12T08:00:00.000Z',
  window_seconds: 90, counting_since: '2026-09-12T07:00:00.000Z' };

async function fixture(t, options = {}) {
  const calls = [];
  const presence = {
    enabled: true,
    async heartbeat(actorId) { calls.push(actorId); return stats; },
    async snapshot() { return stats; },
    close() { throw new Error('An injected presence service belongs to its caller'); },
    ...options.presence,
  };
  const api = createApiHandler({
    secret: proofSecret, publicOrigin: 'https://atlas.example',
    env: { NODE_ENV: 'test', ...options.env }, presence,
  });
  const server = createServer((req, res) => void api(req, res, new URL(req.url, 'https://atlas.example')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const config = await send('/api/config');
  const headers = {
    Cookie: config.headers['set-cookie'][0].split(';')[0],
    'Content-Type': 'application/json',
    'X-Atlas-CSRF': config.body.presence?.csrf_token || 'missing-proof',
  };
  return { send, config: config.body, headers, calls, api };
}

test('the explicitly disabled AI caps are null in config while legacy defaults remain limited', async t => {
  const off = await fixture(t, { env: { GUIDE_LIMITS_ENABLED: 'false' } });
  assert.equal(off.config.guide.limits_enabled, false);
  assert.equal(off.config.guide.daily_limit, null);
  assert.equal(off.config.guide.hourly_limit, null);
  assert.equal(off.config.guide.global_concurrency, null);
  const on = await fixture(t);
  assert.equal(on.config.guide.limits_enabled, true);
  assert.equal(on.config.guide.daily_limit, 30);
});

test('presence heartbeats use the signed browser identity and never expose it in aggregate stats', async t => {
  const f = await fixture(t);
  assert.equal(f.config.presence.enabled, true);
  assert.equal(f.config.presence.heartbeat_ms, 30_000);
  assert.equal(f.config.presence.window_ms, 90_000);
  for (let i = 0; i < 2; i++) {
    const response = await f.send('/api/presence/heartbeat', { method: 'POST', headers: f.headers, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body, stats);
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0], f.calls[1]);
  assert.ok(f.calls[0].length > 10);
  assert.ok(!JSON.stringify(stats).includes(f.calls[0]));
  const summary = await f.send('/api/presence');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body, stats);
  assert.equal(summary.headers['cache-control'], 'no-store');
  assert.equal(f.calls.length, 2, 'Viewing the aggregate must not register another visitor');
});

test('missing proof, forged proof and caller-selected visitor IDs cannot inflate counts', async t => {
  const f = await fixture(t);
  for (const [headers, body, expected] of [
    [{ 'Content-Type': 'application/json' }, '{}', 401],
    [{ ...f.headers, 'X-Atlas-CSRF': 'forged' }, '{}', 403],
    [f.headers, '{"actorId":"chosen-by-caller"}', 400],
    [f.headers, '[]', 400],
  ]) {
    const response = await f.send('/api/presence/heartbeat', { method: 'POST', headers, body });
    assert.equal(response.status, expected);
  }
  assert.equal((await f.send('/api/presence/heartbeat')).status, 405);
  assert.equal((await f.send('/api/presence?visitor=someone')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('presence outages and draining are unavailable, never a fabricated zero', async t => {
  const f = await fixture(t, { presence: { async snapshot() { throw new Error('private-storage-detail'); } } });
  const broken = await f.send('/api/presence');
  assert.equal(broken.status, 503);
  assert.ok(!JSON.stringify(broken.body).includes('private-storage-detail'));
  assert.equal(broken.body.active_visitors, undefined);
  f.api.beginDrain();
  assert.equal((await f.send('/api/presence/heartbeat', { method: 'POST', headers: f.headers, body: '{}' })).status, 503);
  assert.equal(f.calls.length, 0);
});
