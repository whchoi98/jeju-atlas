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
