// Generated workshop reader cache. Rebuild with workshop/scripts/build.mjs.
(function workshopWorker(configuration) {
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
})({"revision":"c547691a498ff6f8f7b4","files":["assets/architecture.svg","assets/fonts/NanumSquareB.woff","assets/fonts/NanumSquareR.woff","assets/fonts/OFL-NanumSquare.txt","assets/icons/atlas-192.png","assets/icons/atlas-512.png","assets/mark.svg","assets/reader-pwa.js","assets/reader.css","assets/reader.js","assets/theme.js","chapters/00-orientation.html","chapters/01-setup.html","chapters/02-aws-environment.html","chapters/03-codex.html","chapters/04-agentcore-cli.html","chapters/05-foundation-and-data.html","chapters/06-atlas-agentcore.html","chapters/07-routing.html","chapters/08-web.html","chapters/09-https-edge.html","chapters/10-enrichment.html","chapters/11-operations.html","chapters/12-validation.html","chapters/13-cleanup.html","index.html","manifest.webmanifest","prompts/00-orientation.md","prompts/01-setup.md","prompts/02-aws-environment.md","prompts/03-codex.md","prompts/04-agentcore-cli.md","prompts/05-foundation-and-data.md","prompts/06-atlas-agentcore.md","prompts/07-routing.md","prompts/08-web.md","prompts/09-https-edge.md","prompts/10-enrichment.md","prompts/11-operations.md","prompts/12-validation.md","prompts/13-cleanup.md","reference/ai-cli-environments.html","reference/catalog-bootstrap.html","reference/facilitator.html","reference/official-guide-review.html","reference/offline-start.html","reference/resources.html"]});
