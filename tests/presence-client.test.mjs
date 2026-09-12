import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../src/i18n.ts';

let initialize;
try { ({ initializePresence: initialize } = await import('../src/presence.ts')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const start = Date.parse('2026-09-12T00:00:00Z');
const config = (token = 'signed-proof') => ({ enabled: true, csrf_token: token, heartbeat_ms: 30_000, window_ms: 90_000 });
const result = (now = start, active = 3, total = 17) => ({
  active_visitors: active, total_visitors: total, as_of: new Date(now).toISOString(),
  window_seconds: 90, counting_since: '2026-09-12T00:00:00.000Z',
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { online = true, hidden = false, getConfig, fetch, requestTimeoutMs } = {}) {
  assert.equal(typeof initialize, 'function', 'presence needs a disposable footer client');
  let now = start;
  let timerId = 0;
  const configRefreshes = [];
  const timers = new Map();
  const sent = [];
  const view = new EventTarget();
  view.navigator = { onLine: online };
  view.setTimeout = (callback, milliseconds = 0) => {
    const id = ++timerId;
    timers.set(id, { at: now + milliseconds, callback });
    return id;
  };
  view.clearTimeout = id => timers.delete(id);
  const document = new EventTarget();
  document.hidden = hidden;
  document.defaultView = view;
  const attributes = new Map();
  const classes = new Set();
  const root = {
    ownerDocument: document, hidden: true, textContent: '', title: '', lang: '', dataset: {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
  };
  const dispose = initialize(root, {
    clock: () => now, requestTimeoutMs,
    getConfig: async refresh => {
      configRefreshes.push(refresh);
      return getConfig ? getConfig(configRefreshes.length, refresh) : config();
    },
    fetch: async (url, init) => {
      sent.push({ url, init });
      return fetch ? fetch(url, init, sent.length) : json(result(now));
    },
  });
  t.after(dispose);
  return {
    root, view, document, sent, dispose, timers, classes, configRefreshes,
    get configCalls() { return configRefreshes.length; },
    get now() { return now; },
    async advance(milliseconds = 0) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

test('visible clients heartbeat every 30s using one cached config, no-store, CSRF and an empty body', async t => {
  const f = fixture(t);
  await f.advance();
  assert.deepEqual(f.configRefreshes, [false]);
  assert.equal(f.root.hidden, false);
  assert.equal(f.root.textContent, '접속 3 · 누적 17');
  assert.match(f.root.title, /90초/);
  assert.match(f.root.title, /같은 브라우저 세션/);
  assert.match(f.root.title, /새로고침|여러 탭/);
  assert.equal(f.root.getAttribute('data-i18n-ignore'), '');
  assert.equal(f.root.getAttribute('role'), 'status');
  await f.advance(29_999);
  assert.equal(f.sent.length, 1);
  await f.advance(1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.configCalls, 1);
  assert.deepEqual(f.configRefreshes, [false]);
  for (const { url, init } of f.sent) {
    assert.equal(url, '/api/presence/heartbeat');
    assert.equal(init.method, 'POST');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['X-Atlas-CSRF'], 'signed-proof');
    assert.deepEqual(JSON.parse(init.body), {});
  }
});

test('startup joins the pending app config and uses its session proof without forcing a second config request', async t => {
  let resolveAppConfig;
  const pendingAppConfig = new Promise(resolve => { resolveAppConfig = resolve; });
  let forced = 0;
  const f = fixture(t, { getConfig: async (_call, refresh = false) => {
    if (refresh) { forced++; return config('different-session-proof'); }
    return pendingAppConfig;
  } });
  await f.advance();
  assert.deepEqual(f.configRefreshes, [false]);
  assert.equal(f.sent.length, 0);
  resolveAppConfig(config('shared-session-proof'));
  await flush();
  assert.equal(forced, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].init.headers['X-Atlas-CSRF'], 'shared-session-proof');
});

test('disabled or absent config hides the footer and does not start a polling loop', async t => {
  for (const value of [undefined, { ...config(), enabled: false }]) {
    const f = fixture(t, { getConfig: async () => value });
    await f.advance();
    await f.advance(180_000);
    f.view.dispatchEvent(new Event('online'));
    f.view.dispatchEvent(new Event('pageshow'));
    await f.advance();
    assert.equal(f.root.hidden, true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.configCalls, 1);
  }
});

test('initially hidden or offline pages make no config or heartbeat requests until usable', async t => {
  const f = fixture(t, { online: false, hidden: true });
  await f.advance(90_000);
  assert.equal(f.configCalls, 0);
  assert.equal(f.sent.length, 0);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await f.advance();
  assert.equal(f.configCalls, 0);
  f.view.navigator.onLine = true;
  f.view.dispatchEvent(new Event('online'));
  await f.advance();
  assert.equal(f.configCalls, 1);
  assert.equal(f.sent.length, 1);
});

test('hidden, offline and pagehide states pause polling; restored pages refresh without deleting a session', async t => {
  const f = fixture(t);
  await f.advance();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await f.advance(90_000);
  assert.equal(f.sent.length, 1);
  assert.match(f.root.textContent, /마지막 확인/);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await f.advance();
  assert.equal(f.sent.length, 2);
  f.view.dispatchEvent(new Event('pagehide'));
  f.view.dispatchEvent(new Event('online'));
  await f.advance(90_000);
  assert.equal(f.sent.length, 2);
  f.view.navigator.onLine = false;
  f.view.dispatchEvent(new Event('pageshow'));
  await f.advance();
  assert.equal(f.sent.length, 2);
  f.view.navigator.onLine = true;
  f.view.dispatchEvent(new Event('online'));
  await f.advance();
  assert.equal(f.sent.length, 3);
  assert.ok(f.sent.every(item => item.init.method === 'POST'));
  assert.equal(f.configCalls, 1);
});

test('bursts of resume events coalesce and cannot bypass the refresh interval', async t => {
  const f = fixture(t);
  await f.advance();
  for (let i = 0; i < 30; i++) {
    f.view.dispatchEvent(new Event('pageshow'));
    f.view.dispatchEvent(new Event('online'));
    f.document.dispatchEvent(new Event('visibilitychange'));
  }
  await f.advance(4999);
  assert.equal(f.sent.length, 1);
  await f.advance(1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.configCalls, 1);
});

test('a stale proof gets one config refresh and one retry; another rejection does not create an auth storm', async t => {
  for (const succeeds of [true, false]) {
    const f = fixture(t, {
      getConfig: async (_call, refresh) => config(refresh ? 'new-proof' : 'old-proof'),
      fetch: async (_url, _init, call) => call === 1 || !succeeds
        ? json({ error: { code: 'csrf_invalid' } }, 403) : json(result()),
    });
    await f.advance();
    assert.equal(f.configCalls, 2);
    assert.deepEqual(f.configRefreshes, [false, true]);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent.map(item => item.init.headers['X-Atlas-CSRF']), ['old-proof', 'new-proof']);
    if (succeeds) assert.equal(f.root.textContent, '접속 3 · 누적 17');
    else {
      assert.match(f.root.textContent, /확인 불가/);
      for (let i = 0; i < 20; i++) f.view.dispatchEvent(new Event('online'));
      await f.advance(29_999);
      assert.equal(f.sent.length, 2);
      assert.equal(f.configCalls, 2);
    }
  }
});

test('late config and stale-proof responses after hiding or disposal cannot initiate more requests', async t => {
  let resolveConfig;
  const f = fixture(t, { getConfig: () => new Promise(resolve => { resolveConfig = resolve; }) });
  await f.advance();
  f.document.hidden = true;
  f.document.dispatchEvent(new Event('visibilitychange'));
  resolveConfig(config());
  await flush();
  assert.equal(f.sent.length, 0);
  let resolveResponse;
  const g = fixture(t, { fetch: () => new Promise(resolve => { resolveResponse = resolve; }) });
  await g.advance();
  g.dispose();
  assert.equal(g.sent[0].init.signal.aborted, true);
  resolveResponse(json({ error: { code: 'session_required' } }, 401));
  await flush();
  g.view.dispatchEvent(new Event('pageshow'));
  await g.advance(120_000);
  assert.equal(g.sent.length, 1);
  assert.equal(g.configCalls, 1);
  assert.equal(g.root.hidden, true);
});

test('network errors preserve clearly labeled last confirmed counts and never invent a current zero', async t => {
  const f = fixture(t, { fetch: async (_url, _init, call) => {
    if (call === 1) return json(result());
    throw new Error('do not expose backend diagnostics');
  } });
  await f.advance();
  await f.advance(30_000);
  assert.match(f.root.textContent, /마지막 확인/);
  assert.match(f.root.textContent, /접속 3 · 누적 17/);
  assert.equal(f.root.dataset.presenceState, 'stale');
  assert.doesNotMatch(f.root.textContent, /접속 0|diagnostics/);
  const g = fixture(t, { fetch: async () => { throw new Error('offline'); } });
  await g.advance();
  assert.match(g.root.textContent, /확인 불가/);
  assert.doesNotMatch(g.root.textContent, /\b0\b/);
});

test('reconnecting does not label an old result current before the next heartbeat succeeds', async t => {
  const f = fixture(t);
  await f.advance();
  f.view.navigator.onLine = false;
  f.view.dispatchEvent(new Event('offline'));
  f.view.navigator.onLine = true;
  f.view.dispatchEvent(new Event('online'));
  assert.match(f.root.textContent, /마지막 확인/);
  await f.advance(5000);
  assert.equal(f.root.textContent, '접속 3 · 누적 17');
});

test('invalid aggregates, missing proof and a hanging request fail visibly without polling storms', async t => {
  for (const invalid of [
    { ...result(), active_visitors: -1 }, { ...result(), total_visitors: 1 },
    { ...result(), active_visitors: '3' }, { ...result(), as_of: 'invalid' },
  ]) {
    const f = fixture(t, { fetch: async () => json(invalid) });
    await f.advance();
    assert.match(f.root.textContent, /확인 불가/);
    assert.equal(f.sent.length, 1);
  }
  const missing = fixture(t, { getConfig: async () => ({ ...config(), csrf_token: undefined }) });
  await missing.advance();
  assert.equal(missing.sent.length, 0);
  assert.match(missing.root.textContent, /확인 불가/);
  const hanging = fixture(t, { requestTimeoutMs: 1000, fetch: () => new Promise(() => {}) });
  await hanging.advance();
  await hanging.advance(1000);
  assert.equal(hanging.sent[0].init.signal.aborted, true);
  assert.match(hanging.root.textContent, /확인 불가/);
  assert.equal(hanging.sent.length, 1);
});

test('language changes repaint locally, including stale labels, without another network request', async t => {
  const f = fixture(t);
  t.after(() => setLocale('ko', null));
  await f.advance();
  setLocale('en', null);
  f.view.dispatchEvent(new Event('atlas:locale-change'));
  assert.equal(f.root.textContent, 'Online 3 · Total 17');
  assert.match(f.root.title, /90 seconds|90-second/);
  assert.match(f.root.title, /browser sessions/);
  assert.match(f.root.title, /same browser session/);
  f.view.navigator.onLine = false;
  f.view.dispatchEvent(new Event('offline'));
  assert.match(f.root.textContent, /Last confirmed/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.configCalls, 1);
});
