import { createHash } from 'node:crypto';

// This function is serialized into sw.js. Keep it self-contained: its source
// also participates in the revision, so a worker fix creates a new cache.
function workshopWorker(configuration) {
  'use strict';
  const { revision, files } = configuration;
  const scope = new URL(self.registration.scope);
  const cachePrefix = `jeju-atlas-workshop-${encodeURIComponent(scope.pathname)}-`;
  const cacheName = `${cachePrefix}${revision}`;
  const urls = files.map((file) => new URL(file, scope).href);
  const precache = new Set(urls);
  const inScope = (url) => url.origin === scope.origin && url.pathname.startsWith(scope.pathname);

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(cacheName);
        await cache.addAll(urls.map((url) => new Request(url, {
          cache: 'reload', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        })));
      } catch (error) {
        // An incomplete new edition must never replace the working edition.
        await caches.delete(cacheName);
        throw error;
      }
      // Updates stay waiting until a reader explicitly chooses to apply one.
    })());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
        .map((name) => caches.delete(name)));
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (event) => {
    if (event.data?.type !== 'WORKSHOP_SKIP_WAITING' || !event.source?.id) return;
    event.waitUntil((async () => {
      const client = await self.clients.get(event.source.id);
      if (client?.type === 'window' && inScope(new URL(client.url))) await self.skipWaiting();
    })().catch(() => { /* A closed or out-of-scope window cannot activate an update. */ }));
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || request.headers.has('range')) return;
    const url = new URL(request.url);
    if (!inScope(url)) return;
    url.search = '';
    url.hash = '';
    if (url.pathname === scope.pathname) url.pathname += 'index.html';
    // Exact generated paths enforce boundaries, including encoded separators.
    // APIs, downloads, maps, external hosts and unknown pages fall through.
    if (!precache.has(url.href)) return;
    event.respondWith((async () => {
      try {
        const cache = await caches.open(cacheName);
        const saved = await cache.match(url.href);
        if (saved) return saved;
      } catch (_) { /* A browser may evict or deny CacheStorage. */ }
      try {
        return await fetch(request);
      } catch (_) {
        return new Response('이 문서는 아직 오프라인으로 저장되지 않았습니다. 연결 후 다시 열어 주세요.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    })());
  });
}

function isPrecacheAsset(path) {
  if (path === 'manifest.webmanifest') return true;
  if (/(?:^|\/)(?:api|apis|downloads|terrain|tiles|maps?)(?:\/|$)/i.test(path)) return false;
  if (path.split('/').some((part) => !/^[\w.-]+$/.test(part) || part.startsWith('.'))) return false;
  return /^assets\/.+\.(?:css|js|svg|png|ico|woff2?|txt)$/.test(path)
    || /^prompts\/[a-z0-9-]+\.md$/.test(path);
}

export function createPwaAssets({ course, pages, assets }) {
  const manifest = {
    // Without id, the browser uses the resolved start_url. An explicit "./"
    // id resolves against the origin and would collide with the root map app.
    name: `Jeju Atlas 워크숍 · ${course.title}`,
    short_name: 'Atlas 워크숍',
    description: course.subtitle,
    lang: course.language,
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#f2f3f3',
    theme_color: '#232f3e',
    icons: [192, 512].map((size) => ({
      src: `./assets/icons/atlas-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any maskable',
    })),
  };
  for (const icon of manifest.icons) {
    if (!assets.has(icon.src.slice(2))) throw new Error(`Missing workshop PWA icon: ${icon.src}`);
  }
  const additions = new Map([['manifest.webmanifest', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]);
  // Use the build's in-memory outputs, never a separate chapter list or a walk
  // of a publication directory that might also contain ZIPs or private files.
  const contents = new Map([...pages, ...assets, ...additions]);
  const files = [...contents.keys()].filter((path) => pages.has(path) || isPrecacheAsset(path)).sort();
  const workerSource = workshopWorker.toString();
  const hash = createHash('sha256').update(workerSource);
  for (const path of files) hash.update(path).update('\0').update(contents.get(path)).update('\0');
  const revision = hash.digest('hex').slice(0, 20);
  additions.set('sw.js', Buffer.from(
    `// Generated workshop reader cache. Rebuild with workshop/scripts/build.mjs.\n(${workerSource})(${JSON.stringify({ revision, files })});\n`,
  ));
  return additions;
}
