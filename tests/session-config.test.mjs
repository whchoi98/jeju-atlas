import test from 'node:test';
import assert from 'node:assert/strict';
import { withSessionConfig } from '../src/session-config.ts';

function locks() {
  let tail = Promise.resolve();
  return {
    request(name, options, work) {
      assert.equal(name, 'jeju-atlas:session-config');
      assert.equal(options.mode, 'exclusive');
      let release;
      const prior = tail;
      tail = new Promise(resolve => { release = resolve; });
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener('abort', abort, { once: true });
        prior.then(async () => {
          if (options.signal.aborted) { release(); return; }
          options.signal.removeEventListener('abort', abort);
          try { resolve(await work()); } catch (error) { reject(error); } finally { release(); }
        });
      });
    },
  };
}

test('parallel first config fetches wait for the shared cookie before the next fetch begins', async () => {
  const manager = locks();
  let cookie, issued = 0, active = 0, maximum = 0;
  const load = async signal => {
    assert.equal(signal.aborted, false);
    active++;
    maximum = Math.max(maximum, active);
    if (!cookie) {
      await new Promise(resolve => setTimeout(resolve, 10));
      cookie = `fixture-session-${++issued}`;
    }
    active--;
    return cookie;
  };
  const results = await Promise.all([0, 1, 2].map(() => withSessionConfig(load, { locks: manager })));
  assert.equal(maximum, 1);
  assert.equal(issued, 1);
  assert.deepEqual(results, Array(3).fill('fixture-session-1'));
});

test('a queued config timeout never starts an uncoordinated fallback fetch', async () => {
  const manager = locks();
  let release, called = 0;
  const first = withSessionConfig(() => new Promise(resolve => { release = resolve; }), { locks: manager });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(withSessionConfig(async () => { called++; }, { locks: manager, timeoutMs: 5 }), { name: 'TimeoutError' });
  assert.equal(called, 0);
  release('done');
  assert.equal(await first, 'done');
});

test('config errors release the lock and are not silently retried', async () => {
  const manager = locks();
  let failedCalls = 0;
  await assert.rejects(withSessionConfig(async () => { failedCalls++; throw new Error('fixture-failure'); }, { locks: manager }), /fixture-failure/);
  assert.equal(await withSessionConfig(async () => 'next', { locks: manager }), 'next');
  assert.equal(failedCalls, 1);
});

test('non-browser and legacy transports retain a single config fetch without browser storage access', async () => {
  let calls = 0;
  assert.equal(await withSessionConfig(async () => { calls++; return 'config'; }, { locks: null }), 'config');
  assert.equal(calls, 1);
});
