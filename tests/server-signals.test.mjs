import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'https://signal-fixture.example.test';

async function serverProcess(t, drainMs) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-signal-'));
  await writeFile(join(directory, 'index.html'), '<title>Signal test</title>');
  const child = spawn(process.execPath, [
    '--import', join(root, 'tests/fixtures/signal-sdk-preload.mjs'),
    join(root, 'server/server.mjs'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0', STATIC_ROOT: directory,
      RELEASE: 'signal-test', NODE_ENV: 'production',
      CATALOG_BUCKET: '', CATALOG_LOCAL_PATH: '',
      AWS_REGION: 'ap-northeast-2', AWS_EC2_METADATA_DISABLED: 'true',
      AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture',
      PUBLIC_ORIGIN: origin,
      ATLAS_SESSION_SECRET: 'signal-test-secret-at-least-thirty-two-characters',
      GUIDE_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:ap-northeast-2:000000000000:runtime/signal_test',
      GUIDE_QUOTA_TABLE: 'signal-test', DRAIN_TIMEOUT_MS: String(drainMs),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  let errors = '';
  const messages = [];
  const waiters = [];
  const settle = () => {
    for (const waiter of [...waiters]) {
      const value = messages.find(waiter.predicate);
      if (value) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    logs += chunk;
    for (const line of logs.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (!messages.some(item => JSON.stringify(item) === line)) messages.push(event);
      } catch { /* A partial JSON log line is completed by the next chunk. */ }
    }
    settle();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('message', message => { messages.push(message); settle(); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const waitFor = predicate => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`Child event timeout. ${errors}`)), 5000);
    waiters.push({ predicate, resolve: value => { clearTimeout(timer); resolve(value); } });
  });
  const listening = await waitFor(event => event.event === 'listening');
  const base = `http://127.0.0.1:${listening.port}`;
  const config = await fetch(`${base}/api/config`);
  assert.equal(config.status, 200);
  const cookie = config.headers.get('set-cookie').split(';')[0];
  const post = message => fetch(`${base}/api/guide`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, request_id: randomUUID() }),
  });
  return { child, base, post, exited, waitFor, messages };
}

test('the production entry handles SIGTERM and finishes an already admitted SSE response', { timeout: 10000 }, async t => {
  const fixture = await serverProcess(t, 3000);
  const response = await fixture.post('진행 중 답변을 완료해 주세요.');
  assert.equal(response.status, 200);
  const body = response.text();
  await fixture.waitFor(event => event.type === 'model-started');
  assert.equal(fixture.child.kill('SIGTERM'), true);
  await fixture.waitFor(event => event.event === 'shutdown' && event.signal === 'SIGTERM');
  assert.equal((await fetch(`${fixture.base}/readyz`)).status, 503);
  assert.equal((await fixture.post('종료 중 새 질문')).status, 503);
  assert.equal(fixture.child.exitCode, null);
  fixture.child.send({ type: 'release-model' });
  const text = await body;
  assert.match(text, /답변 완료/);
  assert.match(text, /event: done/);
  assert.doesNotMatch(text, /event: error/);
  assert.deepEqual(await fixture.exited, { code: 0, signal: null });
  assert.equal(fixture.messages.filter(event => event.type === 'model-started').length, 1);
});

test('the production SIGTERM deadline terminates an uncooperative stream without reporting success', { timeout: 10000 }, async t => {
  const fixture = await serverProcess(t, 200);
  const response = await fixture.post('끝나지 않는 검사 응답');
  const body = response.text().then(text => ({ text }), error => ({ error: error.name }));
  await fixture.waitFor(event => event.type === 'model-started');
  fixture.child.kill('SIGTERM');
  assert.deepEqual(await fixture.exited, { code: 1, signal: null });
  const result = await body;
  assert.ok(result.error || !result.text.includes('event: done'));
});
