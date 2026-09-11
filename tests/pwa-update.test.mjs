import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function worker(tabs) {
  // Read just the exported renderer without executing the disk-writing CLI.
  const source = await readFile(new URL('../scripts/build-pwa.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function workerSource/, 'PWA build must expose its worker for behavioral verification');
  const { workerSource } = await import('../scripts/build-pwa.mjs');
  const listeners = {};
  let activated = 0;
  const deleted = [];
  const messages = [];
  const clients = tabs.map((tab, index) => ({
    id: String(index), url: tab?.url || 'https://atlas.test/',
    postMessage(data) {
      const busy = tab && typeof tab === 'object' ? tab.busy : tab;
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
    caches: { keys: async () => ['jeju-atlas-shell-old', 'jeju-atlas-workshop-reader', 'unrelated'], delete: async key => deleted.push(key), open: async () => ({ addAll: async () => {}, match: async () => ({}) }) },
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

test('workshop readers do not block the app update or receive its reload messages', async () => {
  const harness = await worker([false,
    { busy: null, url: 'https://atlas.test/workshop/' },
    { busy: null, url: 'https://atlas.test/workshop/chapters/00-overview.html' },
  ]);
  await harness.apply();
  assert.equal(harness.activated(), 1);
  assert.ok(harness.messages.length > 0);
  assert.ok(harness.messages.every(item => item.client === '0'));
});

test('activating the map app preserves the workshop offline cache', async () => {
  const harness = await worker([false]);
  let pending;
  harness.listeners.activate({ waitUntil(promise) { pending = promise; } });
  await pending;
  assert.deepEqual(harness.deleted, ['jeju-atlas-shell-old']);
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

test('workshop navigations and assets pass through the map service worker', async () => {
  const harness = await worker([false]);
  for (const [path, mode] of [
    ['/workshop', 'navigate'],
    ['/workshop/', 'navigate'],
    ['/workshop/chapters/00-overview.html', 'navigate'],
    ['/workshop/sw.js', 'same-origin'],
    ['/workshop/assets/reader.js', 'cors'],
    ['/workshop/downloads/jeju-atlas-workshop-handbook.zip', 'navigate'],
  ]) {
    let intercepted = false;
    harness.listeners.fetch({ request: { url: `https://atlas.test${path}`, method: 'GET', mode }, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
});

test('workshop output never enters the map app precache or changes its revision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-pwa-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'workshop/assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<title>Atlas</title>');
  await writeFile(join(root, 'workshop/index.html'), '<title>Workshop v1</title>');
  await writeFile(join(root, 'workshop/assets/reader.js'), '/* reader */');
  const { buildPWA } = await import('../scripts/build-pwa.mjs');
  await buildPWA(root);
  const first = await readFile(join(root, 'sw.js'), 'utf8');
  assert.doesNotMatch(first, /"\/workshop\/(?:index\.html|assets\/reader\.js)"/);
  await writeFile(join(root, 'workshop/index.html'), '<title>Workshop v2</title>');
  await buildPWA(root);
  assert.equal(await readFile(join(root, 'sw.js'), 'utf8'), first);
});
