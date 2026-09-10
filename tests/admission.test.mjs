import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let module;
try { module = await import('../server/admission.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const NOW = Date.parse('2026-09-10T14:59:30Z');
const hash = 'a'.repeat(64);
const turn = (actorId = 'actor-a', extra = {}) => ({
  actorId, requestId: randomUUID(), requestHash: hash, conversationId: randomUUID(), ...extra,
});
function setup(options = {}) {
  assert.equal(typeof module?.createAdmission, 'function', 'distributed admission must exist');
  const store = module.createMemoryAdmissionStore();
  let now = NOW;
  const make = () => module.createAdmission({ store, clock: () => now, ...options });
  return { store, a: make(), b: make(), make, advance: (ms) => { now += ms; } };
}

test('two admission instances enforce global two and actor one with atomic denied requests', async () => {
  const f = setup();
  const requests = [turn('a'), turn('b'), turn('c'), turn('d')];
  const results = await Promise.allSettled(requests.map((input, i) => (i % 2 ? f.a : f.b).acquire(input)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'guide_busy'));
  assert.equal((await f.store.read('day#2026-09-10')).requests, 2);
  const admitted = results.find((result) => result.status === 'fulfilled').value;
  await assert.rejects(f.b.acquire(turn(admitted.actorId)), (error) => error.code === 'guide_busy');
  assert.equal((await f.store.read('day#2026-09-10')).requests, 2);
});

test('same request is charged once and can authorize only one runtime submission', async () => {
  const f = setup();
  const request = turn();
  const results = await Promise.allSettled([f.a.acquire(request), f.b.acquire(request)]);
  const lease = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'request_in_progress');
  const starts = await Promise.allSettled([f.a.start(lease), f.b.start(lease)]);
  assert.equal(starts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.read('day#2026-09-10')).requests, 1);
  await f.a.finish(lease, { outcome: 'completed' });
  await assert.rejects(f.make().acquire(request), (error) => error.code === 'request_completed');
  await assert.rejects(f.b.acquire({ ...request, requestHash: 'b'.repeat(64) }), (error) => error.code === 'request_conflict');
  await assert.rejects(f.b.acquire({ ...request, actorId: 'different-actor' }), (error) => error.code === 'request_conflict');
  assert.equal((await f.store.read('day#2026-09-10')).requests, 1);
});

test('unknown outcomes retain capacity and stale owners cannot release a replacement lease', async () => {
  const f = setup();
  const input = turn();
  const first = await f.a.acquire(input);
  await f.a.start(first);
  await f.a.finish(first, { outcome: 'unknown' });
  await assert.rejects(f.b.acquire(turn()), (error) => error.code === 'guide_busy');
  f.advance(120_001);
  await assert.rejects(f.b.acquire(input), (error) => error.code === 'request_unknown');
  const replacement = await f.b.acquire(turn());
  await f.a.finish(first, { outcome: 'completed' });
  await assert.rejects(f.a.acquire(turn()), (error) => error.code === 'guide_busy');
  await f.b.start(replacement);
});

test('rolling hourly allowances survive instances and KST midnight without resetting concurrency', async () => {
  const f = setup();
  for (let i = 0; i < 5; i++) {
    const lease = await (i % 2 ? f.a : f.b).acquire(turn());
    await f.a.start(lease);
    await f.a.finish(lease, { outcome: 'completed' });
  }
  f.advance(60_000);
  await assert.rejects(f.make().acquire(turn()), (error) => error.code === 'hourly_limit');
  assert.equal(await f.store.read('day#2026-09-11'), null);
  f.advance(3_600_000);
  const lease = await f.make().acquire(turn());
  assert.equal((await f.store.read('day#2026-09-11')).requests, 1);
  await assert.rejects(f.a.acquire(turn()), (error) => error.code === 'guide_busy');
  await f.b.finish(lease, { outcome: 'failed' });
});

test('legacy daily usage is preserved and the thirtieth admission is the final one', async () => {
  const f = setup();
  await f.store.commit([{ before: null, after: { id: 'day#2026-09-10', v: 0, requests: 29, expiresAt: Math.floor(NOW / 1000) + 259200 } }]);
  const results = await Promise.allSettled([f.a.acquire(turn('a')), f.b.acquire(turn('b'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'daily_limit');
  assert.equal((await f.store.read('day#2026-09-10')).requests, 30);
});

test('lost transaction acknowledgement fails closed and a repeated request cannot start another call', async () => {
  const f = setup();
  const input = turn();
  const commit = f.store.commit.bind(f.store);
  let loseAck = true;
  f.store.commit = async (...args) => {
    await commit(...args);
    if (loseAck) { loseAck = false; throw new Error('simulated acknowledgement loss'); }
  };
  await assert.rejects(f.a.acquire(input), (error) => error.code === 'quota_unavailable');
  await assert.rejects(f.b.acquire(input), (error) => error.code === 'request_in_progress');
  assert.equal((await f.store.read('day#2026-09-10')).requests, 1);
  f.store.read = async () => { throw new Error('private storage failure'); };
  assert.equal(await f.a.ready(), false);
  await assert.rejects(f.b.acquire(turn()), (error) => error.code === 'quota_unavailable' && !error.message.includes('private'));
});

test('Dynamo adapter uses consistent reads and only conditional transactional Update members', async () => {
  assert.equal(typeof module?.createAdmission, 'function');
  const commands = [];
  const admission = module.createAdmission({
    table: 'test-quota', clock: () => NOW,
    client: { async send(command) { commands.push(command); return {}; } },
  });
  await admission.acquire(turn());
  assert.ok(commands.filter((command) => command.constructor.name === 'GetItemCommand').every((command) => command.input.ConsistentRead === true));
  const transaction = commands.find((command) => command.constructor.name === 'TransactWriteItemsCommand').input;
  assert.equal(transaction.TransactItems.length, 4);
  assert.match(transaction.ClientRequestToken, /^[a-f0-9-]{36}$/);
  for (const item of transaction.TransactItems) {
    assert.deepEqual(Object.keys(item), ['Update']);
    assert.equal(item.Update.TableName, 'test-quota');
    assert.match(item.Update.ConditionExpression, /attribute_not_exists/);
  }
  const daily = transaction.TransactItems.find((item) => item.Update.Key.id.S === 'day#2026-09-10').Update;
  assert.equal(daily.ExpressionAttributeValues[':requests'].N, '1');
  assert.ok(Object.values(daily.ExpressionAttributeNames).includes('requests'));
});

test('Dynamo compare-and-swap honors a legacy counter increment made without a version update', async () => {
  const rows = new Map([['day#2026-09-10', { id: { S: 'day#2026-09-10' }, requests: { N: '29' } }]]);
  let intercepted = false;
  const client = {
    async send(command) {
      const input = command.input;
      if (command.constructor.name === 'GetItemCommand') return { Item: structuredClone(rows.get(input.Key.id.S)) };
      assert.equal(command.constructor.name, 'TransactWriteItemsCommand');
      if (!intercepted) {
        intercepted = true;
        rows.get('day#2026-09-10').requests.N = '30';
      }
      const updates = input.TransactItems.map(item => item.Update);
      const failures = updates.map(update => {
        const current = rows.get(update.Key.id.S);
        const values = update.ExpressionAttributeValues;
        const creating = update.ConditionExpression.startsWith('attribute_not_exists(#id)');
        let valid = creating ? current === undefined : current !== undefined && Number(current.v?.N ?? 0) === Number(values[':old'].N);
        if (values[':previousRequests']) {
          assert.match(update.ConditionExpression, /#requests = :previousRequests/);
          valid &&= current?.requests?.N === values[':previousRequests'].N;
        }
        return { Code: valid ? 'None' : 'ConditionalCheckFailed' };
      });
      if (failures.some(reason => reason.Code !== 'None')) {
        throw Object.assign(new Error('conditional transaction rejected'), { name: 'TransactionCanceledException', CancellationReasons: failures });
      }
      for (const update of updates) {
        const values = update.ExpressionAttributeValues;
        rows.set(update.Key.id.S, {
          id: update.Key.id, v: values[':v'], data: values[':data'], expiresAt: values[':ttl'],
          ...(values[':requests'] ? { requests: values[':requests'] } : {}),
        });
      }
      return {};
    },
  };
  const admission = module.createAdmission({ table: 'test', client, clock: () => NOW });
  await assert.rejects(admission.acquire(turn()), error => error.code === 'daily_limit');
  assert.equal(rows.size, 1, 'a cancelled transaction must not create actor or lease records');
  assert.equal(rows.get('day#2026-09-10').requests.N, '30');
});
