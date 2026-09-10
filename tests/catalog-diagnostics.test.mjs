import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '../server/api.mjs';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const DAY = 86_400_000;
const fresh = (overrides = {}) => ({
  status: 'ready', stale: false, built_at: '2026-09-09T12:00:00Z', ...overrides,
});

function fixture(t, { catalog, onDiagnostic, clock = () => NOW } = {}) {
  const diagnostics = [];
  const api = createApiHandler({
    env: { NODE_ENV: 'test' },
    secret: 'catalog-diagnostic-tests-use-a-local-secret-32bytes',
    catalog, clock,
    onDiagnostic: entry => {
      diagnostics.push(entry);
      return onDiagnostic?.(entry);
    },
  });
  t.after(() => api.close());
  return { api, diagnostics };
}

test('catalog heartbeat emits numeric freshness after init and once every sixty seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let status = fresh();
  const f = fixture(t, { catalog: { status: () => status } });
  assert.deepEqual(f.diagnostics, []);
  await f.api.init();
  assert.deepEqual(f.diagnostics, [{ event: 'catalog_status', stale: 0 }]);
  status = fresh({ stale: true });
  t.mock.timers.tick(59_999);
  assert.equal(f.diagnostics.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 1 });
  status = fresh({ status: 'unavailable' });
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 1 });
  status = fresh();
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 0 });
  assert.equal(f.diagnostics.length, 4);
});

test('catalog heartbeat treats missing or unreadable state as unavailable without leaking diagnostics', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let fail = false;
  const f = fixture(t, {
    catalog: { status: () => {
      if (fail) throw new Error('private catalog storage detail');
      return fresh();
    } },
  });
  await f.api.init();
  fail = true;
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 1 });
  assert.equal(JSON.stringify(f.diagnostics).includes('private'), false);
  const missing = fixture(t);
  await missing.api.init();
  assert.deepEqual(missing.diagnostics, [{ event: 'catalog_status', stale: 1 }]);
});

test('repeated initialization creates one heartbeat and closing cancels it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, { catalog: { status: () => fresh() } });
  await Promise.all([f.api.init(), f.api.init()]);
  assert.equal(f.diagnostics.length, 1);
  t.mock.timers.tick(60_000);
  assert.equal(f.diagnostics.length, 2);
  f.api.close();
  t.mock.timers.tick(180_000);
  assert.equal(f.diagnostics.length, 2);
  await assert.rejects(f.api.init());
});

test('catalog logging failures do not affect readiness or require DynamoDB', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, {
    catalog: { status: () => fresh() },
    onDiagnostic: async () => { throw new Error('logger failure'); },
  });
  await f.api.init();
  assert.equal(await f.api.ready(), true);
  t.mock.timers.tick(60_000);
  assert.equal(await f.api.ready(), true);
  assert.equal(f.diagnostics.length, 2);
  f.api.beginDrain();
  assert.equal(await f.api.ready(), false);
});

test('C7: build age expires after fourteen days even when refreshes and readiness remain healthy', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = NOW;
  const status = fresh({
    built_at: new Date(NOW - 14 * DAY).toISOString(),
    refreshed_at: new Date(NOW).toISOString(),
  });
  const f = fixture(t, { catalog: { status: () => status }, clock: () => now });
  await f.api.init();
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 0 });
  now++;
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.diagnostics.at(-1), { event: 'catalog_status', stale: 1 });
  assert.equal(await f.api.ready(), true, 'build-age alarms must not remove serving catalog tasks');
  assert.equal(status.stale, false, 'do not rewrite the catalog refresh state');
  assert.equal(status.refreshed_at, new Date(NOW).toISOString());
});

test('unknown, malformed and future build timestamps are never reported as fresh', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const built_at of [
    undefined, null, '', 1, true, {}, 'not-a-timestamp', '2026-09-09',
    '2026-09-09T12:00:00', '2026-09-09T24:00:00Z', '2026-09-09T12:60:00Z',
    '2026-09-09T12:00:60Z', '2026-09-09T12:00:00+24:00',
    '2026-09-09T12:00:00Z\n', new Date(NOW + 1).toISOString(),
    new Date(NOW - 14 * DAY - 1).toISOString(),
  ]) {
    const f = fixture(t, { catalog: { status: () => fresh({ built_at }) } });
    await f.api.init();
    assert.deepEqual(f.diagnostics, [{ event: 'catalog_status', stale: 1 }], String(built_at));
    assert.equal(await f.api.ready(), true);
    f.api.close();
  }
});

test('build timestamps respect explicit offsets, valid leap days and real calendar dates', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const [built_at, now, stale] of [
    ['2026-09-10T21:00:00+09:00', NOW, 0],
    ['2026-09-10T21:00:00.001+09:00', NOW, 1],
    ['2026-09-09T12:00:00.123456+00:00', NOW, 0],
    ['2028-02-29T12:00:00Z', Date.parse('2028-03-01T12:00:00Z'), 0],
    ['2026-02-29T12:00:00Z', Date.parse('2026-03-03T12:00:00Z'), 1],
    ['2026-02-30T12:00:00Z', Date.parse('2026-03-03T12:00:00Z'), 1],
    ['2026-04-31T12:00:00Z', Date.parse('2026-05-02T12:00:00Z'), 1],
  ]) {
    const f = fixture(t, { catalog: { status: () => fresh({ built_at }) }, clock: () => now });
    await f.api.init();
    assert.deepEqual(f.diagnostics, [{ event: 'catalog_status', stale }], built_at);
    f.api.close();
  }
});
