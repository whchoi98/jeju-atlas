import { createServer } from 'node:http';
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function createAppServer({ root, release = 'local', api }) {
  const staticRoot = realpathSync(root);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const reply = (status, text, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text),
      });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    let pathname;
    try {
      // Do not use URL.pathname here: URL normalizes dot segments before checks.
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      return reply(400, 'Invalid path\n');
    }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
      return reply(400, 'Invalid path\n');
    }
    if (pathname.split('/').some((segment) => segment.startsWith('.'))) {
      return reply(403, 'Forbidden\n');
    }
    if (Number(req.headers['content-length']) > 16 * 1024) {
      res.setHeader('Connection', 'close');
      req.resume();
      return reply(413, 'Request body too large\n');
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!api) return reply(404, JSON.stringify({ error: { code: 'not_found', message: 'API unavailable' } }), 'application/json; charset=utf-8');
      try {
        return await api(req, res, new URL(req.url, 'http://localhost'));
      } catch {
        if (!res.headersSent) {
          return reply(503, JSON.stringify({ error: { code: 'service_unavailable', message: '서비스를 일시적으로 이용할 수 없습니다.' } }), 'application/json; charset=utf-8');
        }
        res.destroy();
        return;
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return reply(405, 'Method not allowed\n');
    }
    if (pathname === '/healthz') {
      return reply(200, JSON.stringify({ status: 'ok', service: 'jeju-3d', release }), 'application/json; charset=utf-8');
    }
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    let filename;
    let info;
    try {
      filename = await realpath(resolve(staticRoot, relativePath));
      if (!filename.startsWith(staticRoot + sep)) return reply(403, 'Forbidden\n');
      info = await stat(filename);
      if (!info.isFile()) return reply(404, 'Not found\n');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EINVAL'].includes(error.code)) return reply(404, 'Not found\n');
      console.error(JSON.stringify({ event: 'static-read-error', code: error.code || 'UNKNOWN' }));
      return reply(500, 'Server error\n');
    }

    const type = contentTypes[extname(filename).toLowerCase()] || 'application/octet-stream';
    const cache = pathname === '/sw.js'
      ? 'no-cache'
      : extname(filename) === '.html'
      ? 'public, max-age=0, must-revalidate'
      : pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': cache,
      'Last-Modified': info.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(filename);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = process.env.STATIC_ROOT || join(here, '..', 'dist');
  const release = process.env.RELEASE || 'local';
  let catalog;
  let api;
  // Keep static-only imports/tests independent of SQLite and AWS packages.
  if (process.env.CATALOG_BUCKET || process.env.CATALOG_LOCAL_PATH || process.env.GUIDE_RUNTIME_ARN) {
    try {
      const { createApiHandler } = await import('./api.mjs');
      if (process.env.CATALOG_BUCKET || process.env.CATALOG_LOCAL_PATH) {
        const { Catalog } = await import('./catalog.mjs');
        catalog = new Catalog({
          bucket: process.env.CATALOG_BUCKET, key: process.env.CATALOG_KEY || 'catalog/catalog.sqlite',
          cacheDir: process.env.CATALOG_CACHE_DIR || '/tmp/atlas-catalog',
          localPath: process.env.CATALOG_LOCAL_PATH, mediaOrigin: process.env.MEDIA_ORIGIN,
        });
        await catalog.init();
      }
      api = createApiHandler({ catalog, release, env: process.env });
    } catch {
      catalog?.close();
      console.error(JSON.stringify({ event: 'startup-error', code: 'API_INITIALIZATION_FAILED' }));
      process.exit(1);
    }
  }
  const server = createAppServer({ root, release, api });
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(JSON.stringify({ event: 'listening', port: server.address().port, release })));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 65_000;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      console.log(JSON.stringify({ event: 'shutdown', signal }));
      api?.close();
      server.close(() => {
        catalog?.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 25_000).unref();
    });
  }
}
