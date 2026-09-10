import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function worker(tabs) {
  // Read just the exported renderer without executing the disk-writing CLI.
  const source = await readFile(new URL('../scripts/build-pwa.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function workerSource/, 'PWA build must expose its worker for behavioral verification');
  const { workerSource } = await import('../scripts/build-pwa.mjs');
  const listeners = {};
  let activated = 0;
  const deleted = [];
  const messages = [];
  const clients = tabs.map((busy, index) => ({
    id: String(index), url: 'https://atlas.test/',
    postMessage(data) {
      messages.push({ client: String(index), ...data });
      if (data.type === 'ATLAS_UPDATE_CHECK' && busy !== null) {
        queueMicrotask(() => listeners.message({ data: { type: 'ATLAS_UPDATE_STATE', id: data.id, busy }, source: this }));
      }
    },
  }));
  const self = {
    location: new URL('https://atlas.test/sw.js'),
    clients: { matchAll: async () => clients, claim: async () => {} },
    skipWaiting: async () => { activated++; },
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };
  vm.runInNewContext(workerSource('test-revision', ['/', '/index.html', '/assets/app-test.js']), {
    self, URL, crypto, setTimeout, clearTimeout, Map, Set, Promise,
    caches: { keys: async () => ['jeju-atlas-shell-old', 'unrelated'], delete: async key => deleted.push(key), open: async () => ({ addAll: async () => {} }) },
  });
  return {
    clients, listeners, messages, deleted, activated: () => activated,
    async apply() {
      let pending;
      listeners.message({ data: { type: 'ATLAS_APPLY_UPDATE' }, source: clients[0], waitUntil(promise) { pending = promise; } });
      await pending;
    },
  };
}

test('a waiting worker checks every tab and never activates when any draft/stream is busy', async () => {
  const harness = await worker([false, true]);
  await harness.apply();
  assert.equal(harness.activated(), 0);
  assert.equal(harness.messages.filter(item => item.type === 'ATLAS_UPDATE_CHECK').length, 2);
  assert.ok(harness.messages.some(item => item.type === 'ATLAS_UPDATE_BLOCKED'));
  assert.ok(harness.messages.some(item => item.type === 'ATLAS_UPDATE_RELEASE'));
});

test('an update activates once after every existing tab reports that its work is safe', async () => {
  const harness = await worker([false, false]);
  await harness.apply();
  assert.equal(harness.activated(), 1);
  assert.equal(harness.messages.filter(item => item.type === 'ATLAS_UPDATE_COMMIT').length, 2);
});

test('old or suspended tabs which do not answer block an update instead of losing their work', async () => {
  const harness = await worker([false, null]);
  await harness.apply();
  assert.equal(harness.activated(), 0);
  assert.ok(harness.messages.some(item => item.type === 'ATLAS_UPDATE_BLOCKED'));
});

test('API requests, terrain, external media and non-GET requests never enter the shell cache', async () => {
  const harness = await worker([false]);
  for (const [url, method] of [
    ['https://atlas.test/api/catalog/search', 'GET'],
    ['https://atlas.test/terrarium/10/1/2.png', 'GET'],
    ['https://photos.test/photo.jpg', 'GET'],
    ['https://atlas.test/index.html', 'POST'],
  ]) {
    let intercepted = false;
    harness.listeners.fetch({ request: { url, method, mode: 'cors' }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});
