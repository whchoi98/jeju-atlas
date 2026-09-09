import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const rootPath = root.pathname;
const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:html|js|css|svg|png|webmanifest|pbf)$/.test(entry.name) && entry.name !== 'sw.js') files.push(path);
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
const source = `
// Built from the exact app shell. Never cache API replies, terrain or external media.
const CACHE = ${JSON.stringify('jeju-atlas-shell-' + revision)};
const ASSETS = ${JSON.stringify(urls)};
const ASSET_PATHS = new Set(ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  // Let existing tabs finish with their own version before activating an update.
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
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch {}
      const cache = await caches.open(CACHE);
      return await cache.match('/index.html') || await cache.match('/') || Response.error();
    })());
  } else if (ASSET_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(request);
    })());
  }
});
`;
await writeFile(new URL('sw.js', root), source.trimStart());
console.log(`PWA shell ${revision}: ${urls.length} local assets; APIs and map tiles excluded.`);
