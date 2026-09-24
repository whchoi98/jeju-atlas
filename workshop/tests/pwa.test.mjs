import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildSite } from '../scripts/build.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-workshop-pwa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const directory = await temporaryDirectory(t);
  const source = join(directory, 'source');
  const coursePath = join(source, 'course.json');
  const outputDir = join(directory, 'site');
  const course = {
    title: '워크숍 PWA 테스트', subtitle: '오프라인 교재', language: 'ko', includePromptCards: true,
    chapters: [
      { id: '00', slug: '00-start', title: '시작', day: 1, minutes: 10 },
      { id: '01', slug: '01-finish', title: '마무리', day: 1, minutes: 10 },
    ],
    references: [{ slug: 'commands', title: '명령어' }],
  };
  const files = {
    'course.json': JSON.stringify(course),
    'chapters/00-start.md': '# 시작\n\n첫 번째 장입니다.\n',
    'chapters/01-finish.md': '# 마무리\n\n두 번째 장입니다.\n',
    'reference/commands.md': '# 명령어\n\n참고 자료입니다.\n',
    'prompts/00-start.md': '첫 번째 프롬프트 카드\n',
    'prompts/01-finish.md': '두 번째 프롬프트 카드\n',
  };
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), contents);
  }
  const result = await buildSite({ coursePath, outputDir });
  return { source, coursePath, outputDir, course, result };
}

async function outputFiles(directory) {
  const files = new Map();
  async function collect(prefix = '') {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await collect(`${name}/`);
      else files.set(name, await readFile(join(directory, name)));
    }
  }
  await collect();
  return files;
}

// Execute the emitted worker, with real Request/Response objects and only the
// browser's network, CacheStorage and lifecycle boundaries replaced.
function workerHarness(source, files, {
  scope = 'https://atlas.example/workshop/', store = new Map(), failPath,
} = {}) {
  const events = new Map();
  const requests = [];
  let offline = false;
  let skipped = 0;
  let claimed = 0;
  const base = new URL(scope);
  const urlOf = (input) => typeof input === 'string' ? input : input.url;
  const fetch = async (input) => {
    const url = new URL(urlOf(input), scope);
    requests.push(url.href);
    if (offline) throw new TypeError('Offline');
    const path = url.pathname.slice(base.pathname.length);
    if (path === failPath) return new Response('Unavailable', { status: 503 });
    const content = url.origin === base.origin && url.pathname.startsWith(base.pathname) ? files.get(path) : null;
    const response = new Response(content ?? 'Not found', { status: content ? 200 : 404 });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  const caches = {
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name);
      return {
        async match(input) { return entries.get(urlOf(input))?.clone(); },
        async put(input, response) { entries.set(urlOf(input), response.clone()); },
        async addAll(inputs) {
          const responses = await Promise.all(inputs.map(fetch));
          if (responses.some((response) => !response.ok)) throw new TypeError('Precache failed');
          inputs.forEach((input, index) => entries.set(urlOf(input), responses[index]));
        },
      };
    },
  };
  const self = {
    location: new URL('sw.js', scope),
    registration: { scope },
    addEventListener(type, callback) { events.set(type, callback); },
    async skipWaiting() { skipped++; },
    clients: {
      async claim() { claimed++; },
      async get(id) { return clients.get(id); },
    },
  };
  const clients = new Map();
  vm.runInNewContext(source, { self, caches, fetch, URL, Request, Response, Headers, setTimeout, clearTimeout });
  async function dispatch(type, data = {}) {
    const promises = [];
    let response;
    const event = {
      ...data,
      waitUntil(promise) { promises.push(promise); },
      respondWith(promise) { response = Promise.resolve(promise); },
    };
    events.get(type)?.(event);
    const result = response && await response;
    await Promise.all(promises);
    return { intercepted: Boolean(response), response: result };
  }
  return {
    store, requests, dispatch, clients,
    get skipped() { return skipped; },
    get claimed() { return claimed; },
    setOffline(value) { offline = value; },
    async request(path, { mode = 'navigate', method = 'GET', headers } = {}) {
      const request = new Request(new URL(path, scope), { method, headers });
      Object.defineProperty(request, 'mode', { value: mode });
      return dispatch('fetch', { request });
    },
  };
}

async function builtWorker(t, options) {
  const input = await fixture(t);
  const files = await outputFiles(input.outputDir);
  assert.ok(files.has('sw.js'), 'The build must emit a service worker at the workshop root');
  return { ...input, files, worker: workerHarness(files.get('sw.js').toString(), files, options) };
}

test('build emits a relative install manifest, valid icons and all 26 real course pages', async (t) => {
  const outputDir = join(await temporaryDirectory(t), 'site');
  const result = await buildSite({ outputDir });
  assert.equal(result.pages.length, 26);
  assert.ok(result.pages.includes('chapters/14-project-completion.html'));
  assert.ok(result.pages.includes('reference/hud-setup.html'));
  assert.ok(result.pages.includes('reference/codex-bedrock.html'));
  assert.ok(result.pages.includes('reference/preconfiguration.html'));
  assert.ok(result.pages.includes('reference/keys-and-integrations.html'));
  assert.ok(result.assets.includes('manifest.webmanifest'), 'Include the install manifest in build outputs');
  assert.ok(result.assets.includes('sw.js'), 'Include the generated worker in build outputs');
  const manifest = JSON.parse(await readFile(join(outputDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.id, undefined, 'Use the scoped start_url identity; relative id resolves against the origin');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.name, /워크숍/);
  assert.equal(manifest.theme_color, '#232f3e');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((entry) => entry.sizes === `${size}x${size}`);
    assert.ok(icon, `An installable ${size}px icon is required`);
    assert.equal(icon.type, 'image/png');
    const url = new URL(icon.src, 'https://atlas.example/nested/workshop/manifest.webmanifest');
    assert.equal(url.origin, 'https://atlas.example');
    assert.ok(url.pathname.startsWith('/nested/workshop/'));
    const data = await readFile(join(outputDir, url.pathname.slice('/nested/workshop/'.length)));
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
  }
  const files = await outputFiles(outputDir);
  const worker = workerHarness(files.get('sw.js').toString(), files);
  await worker.dispatch('install');
  const cached = [...worker.store.values()][0];
  for (const page of result.pages) {
    assert.ok(cached.has(`https://atlas.example/workshop/${page}`), `Precache generated page ${page}`);
  }
  assert.ok(cached.has('https://atlas.example/workshop/prompts/14-project-completion.md'));
});

test('precache comes from generated outputs, works under nested prefixes and includes prompt cards/fonts', async (t) => {
  const { files } = await builtWorker(t);
  for (const prefix of ['/workshop/', '/courses/team-7/workshop/']) {
    const scope = `https://atlas.example${prefix}`;
    const worker = workerHarness(files.get('sw.js').toString(), files, { scope });
    await worker.dispatch('install');
    assert.equal(worker.skipped, 0, 'An update must wait for an explicit reader action');
    assert.equal(worker.store.size, 1);
    const [name, cached] = [...worker.store][0];
    assert.ok(name.startsWith('jeju-atlas-workshop-'));
    const expected = [...files.keys()].filter((file) => !['sw.js', '.workshop-site.json'].includes(file)).sort();
    assert.deepEqual([...cached.keys()].map((url) => url.slice(scope.length)).sort(), expected);
    assert.ok(cached.has(`${scope}prompts/01-finish.md`));
    assert.ok(cached.has(`${scope}assets/fonts/NanumSquareR.woff`));
    assert.ok(cached.has(`${scope}assets/fonts/NanumSquareB.woff`));
    await worker.dispatch('activate');
    assert.equal(worker.claimed, 1);
  }
});

test('offline navigation returns the requested chapter/reference and canonicalizes only the root directory', async (t) => {
  const { files, worker } = await builtWorker(t);
  await worker.dispatch('install');
  worker.setOffline(true);
  for (const [path, expected] of [
    ['./', 'index.html'],
    ['./?source=installed', 'index.html'],
    ['chapters/00-start.html', 'chapters/00-start.html'],
    ['chapters/01-finish.html?from=previous#heading', 'chapters/01-finish.html'],
    ['reference/commands.html', 'reference/commands.html'],
    ['prompts/01-finish.md', 'prompts/01-finish.md'],
    ['assets/reader.css?v=1', 'assets/reader.css'],
  ]) {
    const response = await worker.request(path);
    assert.equal(response.intercepted, true, path);
    assert.equal(response.response.status, 200);
    assert.equal(await response.response.text(), files.get(expected).toString(), path);
  }
});

test('worker bypasses APIs, downloads, terrain, external requests, other prefixes and unknown pages', async (t) => {
  const { worker } = await builtWorker(t);
  await worker.dispatch('install');
  const requestsBefore = worker.requests.length;
  const outside = [
    '/api/catalog', 'api/catalog', 'api/chapter.html', '/terrain/tile.png', 'assets/terrain/tile.png',
    'assets/map/tile.png', '/map/tiles/1.png', 'downloads/handbook.zip', 'handbook.zip', 'sw.js',
    'chapters/missing.html', 'chapters/01-finish.html/extra', '/workshop-other/chapters/01-finish.html',
    '/workshop', '/index.html', '/manifest.webmanifest', '../chapters/01-finish.html',
    'https://external.example/workshop/chapters/01-finish.html',
    '/workshop%2fchapters/01-finish.html', 'chapters%2f01-finish.html', 'chapters%5c01-finish.html',
    'chapters/%252e%252e/api/catalog',
  ];
  for (const path of outside) {
    assert.equal((await worker.request(path)).intercepted, false, path);
  }
  assert.equal((await worker.request('index.html', { method: 'POST' })).intercepted, false);
  assert.equal((await worker.request('assets/reader.js', { headers: { Range: 'bytes=0-10' } })).intercepted, false);
  assert.equal(worker.requests.length, requestsBefore, 'Bypassed requests must be left to the browser');
});

test('cache revisions reflect actual chapter/card changes and activation cleans only this deployment', async (t) => {
  const input = await builtWorker(t);
  const { worker, files } = input;
  await worker.dispatch('install');
  const oldName = [...worker.store.keys()][0];
  await buildSite(input);
  assert.equal(await readFile(join(input.outputDir, 'sw.js'), 'utf8'), files.get('sw.js').toString());
  await writeFile(join(input.source, 'prompts/01-finish.md'), '수정된 프롬프트 카드\n');
  await buildSite(input);
  const changed = await outputFiles(input.outputDir);
  assert.notEqual(changed.get('sw.js').toString(), files.get('sw.js').toString());
  const next = workerHarness(changed.get('sw.js').toString(), changed, { store: worker.store });
  const nested = workerHarness(files.get('sw.js').toString(), files, {
    store: worker.store, scope: 'https://atlas.example/another/workshop/',
  });
  await nested.dispatch('install');
  const nestedName = [...worker.store.keys()].find((name) => name !== oldName);
  worker.store.set('jeju-atlas-shell-existing', new Map());
  worker.store.set('another-app-cache', new Map());
  await next.dispatch('install');
  await next.dispatch('activate');
  assert.equal(worker.store.has(oldName), false);
  assert.equal(worker.store.has(nestedName), true);
  assert.equal(worker.store.has('jeju-atlas-shell-existing'), true);
  assert.equal(worker.store.has('another-app-cache'), true);
});

test('failed precache rejects installation and leaves the previous version usable', async (t) => {
  const input = await builtWorker(t);
  const { worker } = input;
  await worker.dispatch('install');
  const prior = [...worker.store.keys()][0];
  await writeFile(join(input.source, 'chapters/01-finish.md'), '# 마무리\n\n수정된 본문\n');
  await buildSite(input);
  const files = await outputFiles(input.outputDir);
  const failed = workerHarness(files.get('sw.js').toString(), files, {
    store: worker.store, failPath: 'assets/reader.css',
  });
  await assert.rejects(failed.dispatch('install'), /Precache failed/);
  assert.deepEqual([...worker.store.keys()], [prior]);
  assert.equal(failed.skipped, 0);
  worker.setOffline(true);
  assert.equal((await worker.request('chapters/01-finish.html')).response.status, 200);
});

test('only a workshop window can explicitly activate a waiting update', async (t) => {
  const { worker } = await builtWorker(t);
  const action = { type: 'WORKSHOP_SKIP_WAITING' };
  for (const [url, type] of [
    ['https://atlas.example/', 'window'],
    ['https://atlas.example/workshop-other/index.html', 'window'],
    ['https://other.example/workshop/index.html', 'window'],
    ['https://atlas.example/workshop/chapters/00-start.html', 'worker'],
  ]) {
    const source = { id: url, url, type };
    worker.clients.set(source.id, source);
    await worker.dispatch('message', { data: action, source });
  }
  await worker.dispatch('message', { data: action });
  const source = { id: 'reader', url: 'https://atlas.example/workshop/chapters/01-finish.html', type: 'window' };
  worker.clients.set(source.id, source);
  await worker.dispatch('message', { data: { type: 'SKIP_WAITING' }, source });
  assert.equal(worker.skipped, 0);
  await worker.dispatch('message', { data: action, source });
  assert.equal(worker.skipped, 1);
});

test('rebuilding removes obsolete owned prompts/PWA files and preserves unknown output files', async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.outputDir, 'keep.txt'), 'Keep unrelated files');
  await writeFile(join(input.outputDir, 'manifest.webmanifest'), 'obsolete manifest');
  await writeFile(join(input.outputDir, 'sw.js'), 'obsolete worker');
  input.course.includePromptCards = false;
  await writeFile(input.coursePath, JSON.stringify(input.course));
  await buildSite(input);
  const files = await outputFiles(input.outputDir);
  assert.equal(files.get('keep.txt').toString(), 'Keep unrelated files');
  assert.equal([...files.keys()].some((name) => name.startsWith('prompts/')), false);
  assert.equal(JSON.parse(files.get('manifest.webmanifest')).scope, './');
  assert.notEqual(files.get('sw.js').toString(), 'obsolete worker');
  const worker = workerHarness(files.get('sw.js').toString(), files);
  await worker.dispatch('install');
  assert.equal(worker.requests.some((url) => url.endsWith('/keep.txt') || url.includes('/prompts/')), false);
});
