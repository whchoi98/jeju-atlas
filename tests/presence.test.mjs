import test from 'node:test';
import assert from 'node:assert/strict';

let presence;
try { presence = await import('../server/presence.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const start = Date.parse('2026-09-12T00:00:00Z');
const unavailable = error => error.status === 503 && error.code === 'presence_unavailable';
function memory() {
  assert.equal(typeof presence?.createMemoryPresenceStore, 'function', 'presence needs a shareable atomic test store');
  return presence.createMemoryPresenceStore();
}
function service(options = {}) {
  assert.equal(typeof presence?.createPresenceService, 'function', 'presence needs a service factory');
  return presence.createPresenceService({ cacheMs: 0, ...options });
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('disabled presence never substitutes a zero count for unavailable storage', async () => {
  const disabled = service();
  assert.equal(disabled.enabled, false);
  await assert.rejects(disabled.snapshot(), unavailable);
  await assert.rejects(disabled.heartbeat('browser-a'), unavailable);
  disabled.close();
});

test('multiple tabs, simultaneous first joins and service restarts share one cumulative ledger', async () => {
  const store = memory();
  const options = { store, clock: () => start };
  const a = service(options);
  const b = service(options);
  assert.deepEqual(await a.snapshot(), {
    active_visitors: 0, total_visitors: 0, as_of: '2026-09-12T00:00:00.000Z',
    window_seconds: 90, counting_since: null,
  });
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).heartbeat('browser-a')));
  assert.deepEqual(await b.snapshot(), {
    active_visitors: 1, total_visitors: 1, as_of: '2026-09-12T00:00:00.000Z',
    window_seconds: 90, counting_since: '2026-09-12T00:00:00.000Z',
  });
  await Promise.all(['browser-b', 'browser-c', 'browser-d', 'browser-b'].map((actor, i) => (i % 2 ? a : b).heartbeat(actor)));
  a.close();
  const restarted = service(options);
  const result = await restarted.heartbeat('browser-a');
  assert.equal(result.total_visitors, 4);
  assert.equal(result.active_visitors, 4);
  assert.equal((await b.snapshot()).total_visitors, 4, 'closing one service must not close the shared store');
  assert.deepEqual(Object.keys(result).sort(), ['active_visitors', 'as_of', 'counting_since', 'total_visitors', 'window_seconds']);
  assert.doesNotMatch(JSON.stringify(result), /browser-|visitor_id|actor|scope/);
  b.close();
  restarted.close();
});

test('activity expires exactly at 90 seconds without TTL deletion; returning sessions retain their first count', async () => {
  let now = start;
  const store = memory();
  const a = service({ store, clock: () => now });
  const b = service({ store, clock: () => now });
  await a.heartbeat('browser-a');
  now += 60_000;
  await b.heartbeat('browser-b');
  now += 29_999;
  assert.equal((await b.snapshot()).active_visitors, 2);
  now++;
  assert.equal((await b.snapshot()).active_visitors, 1);
  now += 60_000;
  assert.deepEqual(await b.snapshot(), {
    active_visitors: 0, total_visitors: 2, as_of: '2026-09-12T00:02:30.000Z',
    window_seconds: 90, counting_since: '2026-09-12T00:00:00.000Z',
  });
  const returned = await a.heartbeat('browser-a');
  assert.equal(returned.active_visitors, 1);
  assert.equal(returned.total_visitors, 2);
  a.close();
  b.close();
});

test('a delayed heartbeat cannot move a newer heartbeat backwards', async () => {
  let now = start;
  let release;
  const backing = memory();
  const slow = service({ clock: () => now, store: {
    ...backing,
    async touch(...args) { await new Promise(resolve => { release = resolve; }); return backing.touch(...args); },
  } });
  const fast = service({ store: backing, clock: () => now });
  const pending = slow.heartbeat('same-browser');
  while (!release) await flush();
  now += 30_000;
  await fast.heartbeat('same-browser');
  release();
  await pending;
  now = start + 90_000;
  assert.equal((await fast.snapshot()).active_visitors, 1);
  now = start + 120_000;
  assert.equal((await fast.snapshot()).active_visitors, 0);
  assert.equal((await fast.snapshot()).total_visitors, 1);
  slow.close();
  fast.close();
});

for (const backend of ['memory', 'DynamoDB']) {
  test(`snapshot retains a visitor renewed by another service during its read (${backend})`, async t => {
    let now = start;
    let resumeRead;
    let queries = 0;
    const clock = () => now;
    const pauseFirstRead = async work => {
      queries++;
      if (queries === 1) await new Promise(resolve => { resumeRead = resolve; });
      return work();
    };
    let writer;
    let reader;
    if (backend === 'memory') {
      const store = memory();
      writer = service({ store, clock });
      reader = service({ clock, cacheMs: 5000, store: {
        ...store, countActive: (...args) => pauseFirstRead(() => store.countActive(...args)),
      } });
    } else {
      const client = dynamoFixture();
      writer = service({ table: 'presence', client, clock });
      reader = service({ table: 'presence', clock, cacheMs: 5000, client: {
        send: (command, options) => command.constructor.name === 'QueryCommand'
          ? pauseFirstRead(() => client.send(command, options)) : client.send(command, options),
      } });
    }
    t.after(() => { reader.close(); writer.close(); resumeRead?.(); });
    await writer.heartbeat('shared-browser');
    now += 30_000;
    const pending = reader.snapshot();
    while (!resumeRead) await flush();
    // This service renews the same row after the reader captured its as_of.
    now++;
    await writer.heartbeat('shared-browser');
    resumeRead();
    const snapshot = await pending;
    now++;
    const cached = await reader.snapshot();
    assert.deepEqual(
      [snapshot, cached].map(value => [value.active_visitors, value.total_visitors]),
      [[1, 1], [1, 1]],
    );
    assert.equal(snapshot.as_of, '2026-09-12T00:00:30.000Z');
    assert.deepEqual(cached, snapshot);
    assert.equal(queries, 1, 'the cached result must also retain the renewed visitor');
    now = start + 120_001;
    const expired = await reader.snapshot();
    assert.equal(expired.active_visitors, 0, 'the lower cutoff still expires the renewed row at 90 seconds');
    assert.equal(expired.total_visitors, 1);
  });
}

test('the store receives only a stable domain-separated hash, never the signed actor value', async () => {
  const backing = memory();
  const visitors = [];
  const store = {
    ...backing,
    async remember(visitor, ...args) { visitors.push(visitor); return backing.remember(visitor, ...args); },
    async touch(visitor, ...args) { visitors.push(visitor); return backing.touch(visitor, ...args); },
  };
  const a = service({ store, clock: () => start });
  const b = service({ store, clock: () => start });
  await a.heartbeat('sensitive-cookie-session');
  await b.heartbeat('sensitive-cookie-session');
  assert.equal(new Set(visitors).size, 1);
  assert.match(visitors[0], /^[a-f0-9]{64}$/);
  assert.notEqual(visitors[0], 'sensitive-cookie-session');
  for (const actor of ['', ' ', null, {}, 'a'.repeat(513)]) {
    await assert.rejects(a.heartbeat(actor), error => error.status === 400);
  }
  assert.equal(visitors.length, 4);
  a.close();
  b.close();
});

test('a committed marker followed by a transport failure is not counted again on retry', async () => {
  const backing = memory();
  let lost = false;
  const instance = service({ clock: () => start, store: {
    ...backing,
    async remember(...args) {
      const created = await backing.remember(...args);
      if (!lost) { lost = true; throw new Error('private backend diagnostics'); }
      return created;
    },
  } });
  await assert.rejects(instance.heartbeat('browser-a'), error => unavailable(error) && !error.message.includes('private'));
  const retried = await instance.heartbeat('browser-a');
  assert.equal(retried.total_visitors, 1);
  assert.equal(retried.active_visitors, 1);
  instance.close();
});

test('aggregate reads coalesce and expire; errors cannot renew stale data or manufacture zeros', async () => {
  let now = start;
  let queries = 0;
  let fail = false;
  const backing = memory();
  const instance = service({ clock: () => now, cacheMs: 5000, store: {
    ...backing,
    async countActive(...args) {
      queries++;
      await flush();
      if (fail) throw new Error('unreachable');
      return backing.countActive(...args);
    },
  } });
  await Promise.all(Array.from({ length: 10 }, () => instance.snapshot()));
  assert.equal(queries, 1);
  const cached = await instance.snapshot();
  cached.total_visitors = 999;
  assert.equal((await instance.snapshot()).total_visitors, 0, 'callers cannot mutate the shared cache');
  const joined = await instance.heartbeat('browser-a');
  assert.equal(joined.total_visitors, 1, 'a first join invalidates a cached empty snapshot');
  assert.equal(queries, 2);
  now += 4000;
  assert.equal((await instance.snapshot()).as_of, '2026-09-12T00:00:00.000Z');
  now += 1001;
  fail = true;
  await assert.rejects(instance.snapshot(), unavailable);
  instance.close();
});

test('a timed-out aggregate cannot populate the cache when its store response eventually arrives', async () => {
  const backing = memory();
  let release;
  let readSignal;
  let reads = 0;
  const instance = service({ clock: () => start, cacheMs: 5000, timeoutMs: 20, store: {
    ...backing,
    async readTotal({ signal }) {
      reads++;
      readSignal = signal;
      if (reads === 1) return new Promise(resolve => { release = resolve; });
      return backing.readTotal();
    },
  } });
  const pending = instance.snapshot();
  while (!release) await flush();
  await assert.rejects(pending, unavailable);
  // The shared read has its own deadline: one subscriber leaving must not
  // cancel work still needed by another subscriber.
  if (!readSignal.aborted) await new Promise(resolve => readSignal.addEventListener('abort', resolve, { once: true }));
  release(null);
  await flush();
  assert.equal((await instance.snapshot()).total_visitors, 0);
  assert.equal(reads, 2, 'the next caller must perform a new read after a deadline');
  instance.close();
});

test('one canceled snapshot subscriber does not abort another subscriber sharing the query', async () => {
  const backing = memory();
  let release;
  let queries = 0;
  const instance = service({ timeoutMs: 1000, store: {
    ...backing,
    async countActive() { queries++; return new Promise(resolve => { release = resolve; }); },
  } });
  const controller = new AbortController();
  const leaving = instance.snapshot({ signal: controller.signal });
  const staying = instance.snapshot();
  while (!release) await flush();
  controller.abort();
  await assert.rejects(leaving, error => error.name === 'AbortError');
  release(0);
  assert.equal((await staying).active_visitors, 0);
  assert.equal(queries, 1);
  instance.close();
});

test('failed writes, malformed aggregates, deadlines, admission bounds and shutdown fail explicitly', async () => {
  for (const method of ['remember', 'touch', 'readTotal', 'countActive']) {
    const backing = memory();
    const instance = service({ store: { ...backing, async [method]() { throw new Error('private ARN'); } } });
    await assert.rejects(instance.heartbeat('browser-a'), error => unavailable(error) && !error.message.includes('ARN'));
    instance.close();
  }
  for (const total of [-1, NaN, '12', Number.MAX_SAFE_INTEGER + 1]) {
    const instance = service({ store: { ...memory(), async readTotal() { return { total_visitors: total, counting_since: null }; } } });
    await assert.rejects(instance.snapshot(), unavailable);
    instance.close();
  }
  let calls = 0;
  const instance = service({ timeoutMs: 25, maxPending: 1, store: {
    ...memory(), async countActive() { calls++; return new Promise(() => {}); },
  } });
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(instance.snapshot({ signal: canceled.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
  const pending = instance.snapshot();
  await flush();
  await assert.rejects(instance.snapshot(), unavailable);
  await assert.rejects(pending, unavailable);
  const closing = instance.snapshot();
  instance.close();
  await assert.rejects(closing, unavailable);
  await assert.rejects(instance.heartbeat('browser-a'), unavailable);
});

/** Stateful Dynamo boundary double: exercises the emitted transaction and lease inputs. */
function dynamoFixture({ loseWrite = false, conflicts = 0 } = {}) {
  const rows = new Map();
  const commands = [];
  let writes = 0;
  const key = item => `${item.scope.S}/${item.visitor.S}`;
  return {
    rows, commands,
    get writes() { return writes; },
    async send(command, { abortSignal } = {}) {
      abortSignal?.throwIfAborted();
      const input = command.input;
      const name = command.constructor.name;
      commands.push({ name, input });
      if (name === 'GetItemCommand') return { Item: structuredClone(rows.get(key(input.Key))) };
      if (name === 'TransactWriteItemsCommand') {
        writes++;
        const [marker, counter] = input.TransactItems;
        assert.ok(marker.Put.ConditionExpression.includes('attribute_not_exists'));
        assert.equal(marker.Put.ExpressionAttributeNames['#visitor'], 'visitor');
        assert.equal(counter.Update.Key.scope.S, 'meta');
        assert.equal(counter.Update.Key.visitor.S, 'total');
        assert.ok(input.ClientRequestToken);
        if (rows.has(key(marker.Put.Item)) || writes <= conflicts) {
          throw Object.assign(new Error('conflict'), { name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: rows.has(key(marker.Put.Item)) ? 'ConditionalCheckFailed' : 'TransactionConflict' }] });
        }
        const old = rows.get('meta/total');
        if (!old && !counter.Update.ConditionExpression.includes('attribute_not_exists')) throw new Error('unsafe bootstrap');
        if (old && counter.Update.ConditionExpression.includes('attribute_not_exists')) {
          throw Object.assign(new Error('bootstrap raced'), { name: 'TransactionCanceledException' });
        }
        const values = counter.Update.ExpressionAttributeValues;
        rows.set(key(marker.Put.Item), structuredClone(marker.Put.Item));
        rows.set('meta/total', {
          scope: { S: 'meta' }, visitor: { S: 'total' },
          total_visitors: { N: String(Number(old?.total_visitors.N ?? 0) + Number(values[':one'].N)) },
          ...(old?.counting_since ? { counting_since: old.counting_since }
            : values[':since'] ? { counting_since: values[':since'] } : {}),
        });
        if (loseWrite) { loseWrite = false; throw Object.assign(new Error('response lost after commit'), { name: 'InternalServerError' }); }
        return {};
      }
      if (name === 'UpdateItemCommand') {
        const old = rows.get(key(input.Key));
        const values = input.ExpressionAttributeValues;
        assert.match(input.ConditionExpression, /#last_seen < :now/);
        if (old && Number(old.last_seen.N) >= Number(values[':now'].N)) {
          throw Object.assign(new Error('newer heartbeat'), { name: 'ConditionalCheckFailedException' });
        }
        rows.set(key(input.Key), { ...input.Key, last_seen: values[':now'], expires_at: values[':expires'] });
        return { Attributes: structuredClone(old) };
      }
      if (name === 'QueryCommand') {
        const values = input.ExpressionAttributeValues;
        const upperBound = input.FilterExpression.includes('#last_seen <= :now');
        assert.equal(Object.hasOwn(values, ':now'), upperBound, 'Query must not contain an unused upper-bound value');
        const online = [...rows.values()].filter(row => row.scope.S === 'online');
        return { Count: online.filter(row => Number(row.last_seen.N) > Number(values[':cutoff'].N)
          && (!upperBound || Number(row.last_seen.N) <= Number(values[':now'].N))).length };
      }
      throw new Error(`Unexpected Dynamo operation: ${name}`);
    },
  };
}

test('Dynamo stores permanent hashed markers with an atomic total and expiring monotonic online rows', async () => {
  const client = dynamoFixture({ loseWrite: true, conflicts: 1 });
  const options = { table: 'presence', client, clock: () => start, retryDelayMs: 0 };
  const a = service(options);
  const b = service(options);
  await a.heartbeat('private-signed-session');
  await b.heartbeat('private-signed-session');
  const counts = await b.heartbeat('second-signed-session');
  assert.equal(counts.total_visitors, 2);
  assert.equal(counts.active_visitors, 2);
  assert.equal(client.rows.size, 5);
  for (const row of client.rows.values()) {
    if (row.scope.S === 'online') assert.equal(Number(row.expires_at.N), start / 1000 + 90);
    else assert.equal(row.expires_at, undefined, 'first-visit markers and the total must survive TTL');
    if (row.scope.S !== 'meta') assert.match(row.visitor.S, /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(JSON.stringify([...client.rows.values()]), /private-signed-session|second-signed-session|user.agent|conversation|latitude|longitude|ip_address/);
  for (const { name, input } of client.commands) {
    assert.equal(input.TableName ?? input.TransactItems[0].Put.TableName, 'presence');
    if (name === 'GetItemCommand' || name === 'QueryCommand') assert.equal(input.ConsistentRead, true);
    if (name === 'QueryCommand') {
      assert.equal(input.Select, 'COUNT');
      assert.equal(input.ExpressionAttributeValues[':online'].S, 'online');
      assert.match(input.FilterExpression, /#last_seen > :cutoff/);
    }
  }
  a.close();
  b.close();
});

test('Dynamo conflict retries are bounded and unknown historical start times stay unknown', async () => {
  const broken = dynamoFixture({ conflicts: 100 });
  const a = service({ table: 'presence', client: broken, maxAttempts: 3, retryDelayMs: 0 });
  await assert.rejects(a.heartbeat('browser-a'), unavailable);
  assert.equal(broken.writes, 3);
  assert.equal(broken.rows.size, 0);
  a.close();
  const existing = dynamoFixture();
  existing.rows.set('meta/total', {
    scope: { S: 'meta' }, visitor: { S: 'total' }, total_visitors: { N: '12' },
  });
  const b = service({ table: 'presence', client: existing, clock: () => start });
  const result = await b.heartbeat('new-browser');
  assert.equal(result.total_visitors, 13);
  assert.equal(result.counting_since, null);
  b.close();
});

test('Query pagination continues through empty filtered pages and fails rather than return a truncated count', async () => {
  const cursor = { scope: { S: 'online' }, visitor: { S: 'last-on-page' } };
  let pages = 0;
  let endless = false;
  const client = {
    async send(command) {
      if (command.constructor.name === 'GetItemCommand') return { Item: { total_visitors: { N: '8' } } };
      assert.equal(command.constructor.name, 'QueryCommand', 'presence must never scan the table');
      assert.equal(command.input.Limit, 100);
      pages++;
      if (endless || pages % 2 === 1) return { Count: 0, LastEvaluatedKey: cursor };
      assert.deepEqual(command.input.ExclusiveStartKey, cursor);
      return { Count: 3 };
    },
  };
  const a = service({ table: 'presence', client, queryPageSize: 100, maxQueryPages: 2 });
  assert.equal((await a.snapshot()).active_visitors, 3);
  assert.equal(pages, 2);
  endless = true;
  await assert.rejects(a.snapshot(), unavailable);
  assert.equal(pages, 4);
  a.close();
});
