import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '../server/api.mjs';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const base = () => ({ status: 'ready', stale: false, built_at: '2026-09-10T10:00:00Z' });
const details = () => ({ status: 'ready', stale: false, record_count: 1 });

function fixture(t, status) {
  const events = [];
  const api = createApiHandler({
    env: { NODE_ENV: 'test' }, secret: 'official-health-test-secret-at-least-32-bytes',
    catalog: { status }, clock: () => NOW, onDiagnostic: event => events.push(event),
  });
  t.after(() => api.close());
  return { api, events };
}

test('C7: configured official health emits independently at startup and every sixty seconds', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let status = { ...base(), official_details_status: details() };
  const f = fixture(t, () => status);
  await f.api.init();
  assert.deepEqual(f.events, [
    { event: 'catalog_status', stale: 0 }, { event: 'official_details_status', stale: 0 },
  ]);
  status.official_details_status.stale = true;
  t.mock.timers.tick(59_999);
  assert.equal(f.events.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(f.events.slice(-2), [
    { event: 'catalog_status', stale: 0 }, { event: 'official_details_status', stale: 1 },
  ]);
  status = { ...base(), stale: true, official_details_status: details() };
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.events.slice(-2), [
    { event: 'catalog_status', stale: 1 }, { event: 'official_details_status', stale: 0 },
  ]);
  assert.equal(await f.api.ready(), true, 'detail health must not drain the base catalog');
  await f.api.init();
  assert.equal(f.events.length, 6);
  f.api.close();
  t.mock.timers.tick(120_000);
  assert.equal(f.events.length, 6);
});

test('C7: missing optional configuration emits no official heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t, base);
  await f.api.init();
  t.mock.timers.tick(60_000);
  assert.deepEqual(f.events, [
    { event: 'catalog_status', stale: 0 }, { event: 'catalog_status', stale: 0 },
  ]);
});

test('C7: unavailable and invalid official health fail closed without logging storage or records', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const state of [
    null, undefined,
    { ...details(), status: 'unavailable' },
    { ...details(), stale: true },
    { ...details(), stale: 0 },
    { ...details(), record_count: 0 },
    { ...details(), record_count: undefined },
    { ...details(), record_count: NaN },
  ]) {
    const f = fixture(t, () => ({
      ...base(), official_details_status: state,
      private_storage: 'never-log-this', records: ['never-log-this'],
    }));
    await f.api.init();
    assert.deepEqual(f.events, [
      { event: 'catalog_status', stale: 0 }, { event: 'official_details_status', stale: 1 },
    ]);
    assert.equal(JSON.stringify(f.events).includes('never-log-this'), false);
    assert.equal(await f.api.ready(), true);
    f.api.close();
  }
  const f = fixture(t, () => ({
    ...base(),
    get official_details_status() { throw new Error('never-log-this'); },
  }));
  await f.api.init();
  assert.deepEqual(f.events, [
    { event: 'catalog_status', stale: 0 }, { event: 'official_details_status', stale: 1 },
  ]);
});
