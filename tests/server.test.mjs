import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

// These tests catch unsafe path resolution, broken health checks, invalid asset
// responses and cache policies that would leave CloudFront serving stale HTML.
const moduleUrl = new URL('../server/server.mjs', import.meta.url);
let module;
try {
  module = await import(moduleUrl.href);
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

test('HTTP serving contract', async (t) => {
  assert.equal(typeof module?.createAppServer, 'function', 'HTTP server must be implemented');
  const temp = await mkdtemp(join(tmpdir(), 'jeju-server-test-'));
  const root = join(temp, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>제주 아틀라스</title>');
  await writeFile(join(root, 'assets', 'app-a1b2.js'), 'console.log("jeju");');
  await writeFile(join(root, 'map.css'), 'body{margin:0}');
  await mkdir(join(root, 'workshop/downloads'), { recursive: true });
  await mkdir(join(root, 'workshop/prompts'), { recursive: true });
  await mkdir(join(root, 'workshop/assets'), { recursive: true });
  await writeFile(join(root, 'workshop/index.html'), '<!doctype html><title>배포 워크숍</title>');
  await writeFile(join(root, 'workshop/sw.js'), '/* reader worker */');
  await writeFile(join(root, 'workshop/manifest.webmanifest'), '{"scope":"./"}');
  await writeFile(join(root, 'workshop/assets/reader.js'), '/* reader */');
  await writeFile(join(root, 'workshop/prompts/00-overview.md'), '# 실습 카드');
  await writeFile(join(root, 'workshop/downloads/jeju-atlas-workshop-handbook.zip'), 'PK-test');
  await writeFile(join(root, 'workshop/.workshop-site.json'), '{"generator":"private-build-metadata"}');
  await writeFile(join(temp, 'secret.txt'), 'must-not-leak');
  await symlink(join(temp, 'secret.txt'), join(root, 'linked.txt'));
  const server = module.createAppServer({ root, release: 'test-release' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  function get(path, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  await t.test('health remains uncached and exposes the release', async () => {
    const response = await get('/healthz');
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).status, 'ok');
    assert.equal(JSON.parse(response.body).release, 'test-release');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  await t.test('HTML is served with explicit type and revalidation', async () => {
    const response = await get('/?camera=33');
    assert.equal(response.status, 200);
    assert.match(response.body, /제주 아틀라스/);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });

  await t.test('hashed assets are immutable and HEAD omits the body', async () => {
    const response = await get('/assets/app-a1b2.js');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /javascript/);
    assert.match(response.headers['cache-control'], /immutable/);
    const head = await get('/assets/app-a1b2.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  });

  await t.test('missing assets return 404 rather than HTML', async () => {
    const response = await get('/assets/missing.js');
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body, /<!doctype/);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  await t.test('workshop directory redirects to its own landing page with relative links intact', async () => {
    const redirect = await get('/workshop?from=atlas');
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, '/workshop/?from=atlas');
    const response = await get('/workshop/');
    assert.equal(response.status, 200);
    assert.match(response.body, /배포 워크숍/);
    assert.doesNotMatch(response.body, /제주 아틀라스/);
    assert.equal(response.headers['cache-control'], 'public, max-age=0, must-revalidate');
    assert.equal((await get('/workshop/assets/')).status, 404);
    assert.equal((await get('/workshop-missing/')).status, 404);
  });

  await t.test('workshop worker, manifest and unhashed assets revalidate on every release', async () => {
    const worker = await get('/workshop/sw.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers['content-type'], /javascript/);
    assert.equal(worker.headers['cache-control'], 'no-cache');
    const manifest = await get('/workshop/manifest.webmanifest');
    assert.match(manifest.headers['content-type'], /^application\/manifest\+json/);
    for (const path of ['/workshop/manifest.webmanifest', '/workshop/assets/reader.js']) {
      assert.equal((await get(path)).headers['cache-control'], 'public, max-age=0, must-revalidate');
    }
  });

  await t.test('public handout and prompt cards use usable download types without exposing build state', async () => {
    const archive = await get('/workshop/downloads/jeju-atlas-workshop-handbook.zip', 'HEAD');
    assert.equal(archive.status, 200);
    assert.equal(archive.headers['content-type'], 'application/zip');
    assert.equal(archive.headers['content-disposition'], 'attachment; filename="jeju-atlas-workshop-handbook.zip"');
    const card = await get('/workshop/prompts/00-overview.md');
    assert.match(card.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.match(card.body, /실습 카드/);
    for (const path of ['/workshop/.workshop-site.json', '/workshop/%2elocal/config.json']) {
      assert.equal((await get(path)).status, 403);
    }
  });

  await t.test('encoded traversal, symlinks and malformed paths never leak files', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/linked.txt', '/%00', '/%ZZ', '/.env']) {
      const response = await get(path);
      assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
      assert.doesNotMatch(response.body, /must-not-leak/);
    }
  });

  await t.test('write methods cannot change files', async () => {
    const response = await get('/', 'POST');
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
  });
});
