import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function workerSource(revision, urls) {
  return `
// Built from the exact app shell. Never cache API replies, terrain or external media.
const CACHE = ${JSON.stringify('jeju-atlas-shell-' + revision)};
const ASSETS = ${JSON.stringify(urls)};
const ASSET_PATHS = new Set(ASSETS);
let review = null;
let applying = false;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  // Let existing tabs finish with their own version before activating an update.
});

async function applyUpdate(requester) {
  if (!requester || applying) {
    requester?.postMessage({ type: 'ATLAS_UPDATE_BLOCKED' });
    return;
  }
  applying = true;
  const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const id = crypto.randomUUID();
  let finish;
  const replies = new Map();
  const ready = new Promise(resolve => { finish = resolve; });
  review = { id, replies, clients: new Set(tabs.map(tab => tab.id)), finish };
  const timer = setTimeout(() => finish(false), 1800);
  for (const tab of tabs) tab.postMessage({ type: 'ATLAS_UPDATE_CHECK', id });
  if (!tabs.length) finish(true);
  const safe = await ready;
  clearTimeout(timer);
  if (safe) {
    for (const tab of tabs) tab.postMessage({ type: 'ATLAS_UPDATE_COMMIT', id });
    await self.skipWaiting();
  } else {
    for (const tab of tabs) tab.postMessage({ type: 'ATLAS_UPDATE_RELEASE', id });
    requester.postMessage({ type: 'ATLAS_UPDATE_BLOCKED' });
  }
  review = null;
  applying = false;
}

self.addEventListener('message', event => {
  const data = event.data;
  if (data?.type === 'ATLAS_APPLY_UPDATE') {
    event.waitUntil(applyUpdate(event.source));
  } else if (data?.type === 'ATLAS_UPDATE_STATE' && review && data.id === review.id
      && review.clients.has(event.source?.id) && typeof data.busy === 'boolean') {
    review.replies.set(event.source.id, data.busy);
    if (review.replies.size === review.clients.size) review.finish([...review.replies.values()].every(busy => !busy));
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('jeju-atlas-shell-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin
      || url.pathname.startsWith('/api/') || url.pathname.startsWith('/terrarium/')
      || url.pathname === '/sw.js' || url.pathname === '/healthz') return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      // A controlled page uses one complete shell revision until the reviewed
      // update takes over. New HTML must not mix with an old offline asset set.
      const cache = await caches.open(CACHE);
      return await cache.match('/index.html') || await cache.match('/') || fetch(request);
    })());
  } else if (ASSET_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(request);
    })());
  }
});
`.trimStart();
}

export async function buildPWA(rootPath = resolve('dist')) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:html|js|css|svg|png|webmanifest|pbf|woff2?)$/.test(entry.name) && entry.name !== 'sw.js') files.push(path);
    }
  }
  await visit(rootPath);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(rootPath, file));
    hash.update(await readFile(file));
  }
  const revision = hash.digest('hex').slice(0, 16);
  const urls = ['/', ...files.map((file) => '/' + relative(rootPath, file).split('/').map(encodeURIComponent).join('/'))];
  await writeFile(join(rootPath, 'sw.js'), workerSource(revision, urls));
  console.log(`PWA shell ${revision}: ${urls.length} local assets; APIs and map tiles excluded.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPWA(resolve(process.env.STATIC_ROOT || 'dist'));
}
