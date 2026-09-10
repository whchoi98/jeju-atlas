import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppServer } from '../server/server.mjs';
import { createApiHandler } from '../server/api.mjs';
import { createAdmission, createMemoryAdmissionStore } from '../server/admission.mjs';

const SECRET = 'admission-http-shared-secret-at-least-32bytes';
const ORIGIN = 'https://atlas.example.test';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function pair(t, invokeEvents) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-admission-http-'));
  await writeFile(join(root, 'index.html'), '<title>Admission fixture</title>');
  const store = createMemoryAdmissionStore();
  const servers = [];
  for (let i = 0; i < 2; i++) {
    const admission = createAdmission({ store });
    const api = createApiHandler({
      env: { NODE_ENV: 'production' }, secret: SECRET, publicOrigin: ORIGIN,
      admission, invokeEvents,
      catalog: {
        status: () => ({ status: 'ready' }), async refreshIfNeeded() {},
        search: () => ({ items: [], total: 0, has_more: false }),
      },
    });
    const server = createAppServer({ root, api });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, api, url: `http://127.0.0.1:${server.address().port}` });
  }
  t.after(async () => {
    for (const { server, api } of servers) {
      api.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });
  const config = await fetch(`${servers[0].url}/api/config`);
  const cookie = config.headers.get('set-cookie').split(';')[0];
  const post = (index, body) => fetch(`${servers[index].url}/api/guide`, {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { store, servers, post };
}

test('two HTTP servers share admission and duplicate UUIDs never submit the model twice', async t => {
  let calls = 0;
  const started = deferred();
  const release = deferred();
  const f = await pair(t, async function* () {
    calls++;
    started.resolve();
    yield { type: 'status', stage: 'thinking' };
    await release.promise;
    yield { type: 'map', answer: '단일 모델 응답', markers: [], route: [], warnings: [] };
    yield { type: 'done' };
  });
  const body = { message: '안녕하세요', request_id: randomUUID() };
  const first = await f.post(0, body);
  assert.equal(first.status, 200);
  await started.promise;
  const duplicate = await f.post(1, body);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'request_in_progress');
  const changed = await f.post(1, { ...body, message: '다른 질문' });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'request_conflict');
  release.resolve();
  assert.match(await first.text(), /event: done/);
  const completed = await f.post(1, body);
  assert.equal(completed.status, 409);
  assert.equal((await completed.json()).error.code, 'request_completed');
  assert.equal(calls, 1);
});

test('readiness fails during drain while an admitted stream completes without being aborted', async t => {
  const release = deferred();
  let calls = 0;
  let signal;
  const f = await pair(t, async function* (input) {
    calls++;
    signal = input.signal;
    yield { type: 'status', stage: 'thinking' };
    await release.promise;
    yield { type: 'map', answer: '완료', markers: [], route: [], warnings: [] };
    yield { type: 'done' };
  });
  assert.equal((await fetch(`${f.servers[0].url}/readyz`)).status, 200);
  const running = await f.post(0, { message: '안녕하세요', request_id: randomUUID() });
  const output = running.text();
  assert.equal(typeof f.servers[0].server.beginDrain, 'function');
  f.servers[0].server.beginDrain();
  assert.equal((await fetch(`${f.servers[0].url}/readyz`)).status, 503);
  assert.equal((await fetch(`${f.servers[0].url}/healthz`)).status, 200);
  const rejected = await f.post(0, { message: '새 질문', request_id: randomUUID() });
  assert.equal(rejected.status, 503);
  assert.equal(signal.aborted, false);
  release.resolve();
  assert.match(await output, /event: done/);
  assert.equal(calls, 1);
  assert.equal(await f.servers[0].server.drain({ timeoutMs: 1000 }), true);
});

test('a bounded drain eventually aborts an uncooperative stream', async t => {
  const begun = deferred();
  let signal;
  const f = await pair(t, async input => {
    signal = input.signal;
    begun.resolve();
    return new Promise(() => {});
  });
  const response = await f.post(0, { message: '안녕하세요', request_id: randomUUID() });
  const body = response.text().catch(() => '');
  await begun.promise;
  assert.equal(typeof f.servers[0].server.drain, 'function');
  assert.equal(await f.servers[0].server.drain({ timeoutMs: 30 }), false);
  assert.equal(signal.aborted, true);
  await body;
});

test('quota-store failure denies AI but preserves core readiness and browsing', async t => {
  let calls = 0;
  const f = await pair(t, async function* () { calls++; });
  f.store.read = async () => { throw new Error('store unavailable'); };
  assert.equal((await fetch(`${f.servers[0].url}/readyz`)).status, 200);
  assert.equal((await fetch(`${f.servers[0].url}/`)).status, 200);
  assert.equal((await fetch(`${f.servers[0].url}/api/catalog/search`)).status, 200);
  const rejected = await f.post(0, { message: '안녕하세요', request_id: randomUUID() });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'quota_unavailable');
  assert.equal(calls, 0);
});
