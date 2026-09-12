import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdmission, createMemoryAdmissionStore } from '../server/admission.mjs';

const NOW = Date.parse('2026-09-12T10:00:00Z');
const turn = (actorId = 'same-browser', extra = {}) => ({
  actorId, requestId: randomUUID(), conversationId: randomUUID(), requestHash: 'a'.repeat(64), ...extra,
});
const code = (expected, status) => error => error.code === expected && (!status || error.status === status);
function fixture(options = {}) {
  const store = createMemoryAdmissionStore();
  const writes = [];
  const commit = store.commit.bind(store);
  store.commit = async (changes, ...args) => {
    writes.push(changes.map(({ after }) => after.id));
    return commit(changes, ...args);
  };
  let now = NOW;
  const make = extra => createAdmission({ store, clock: () => now, limitsEnabled: false, ...options, ...extra });
  return { store, writes, make, a: make(), b: make(), advance(ms) { now += ms; } };
}
async function complete(admission, input) {
  const lease = await admission.acquire(input);
  await admission.start(lease);
  await admission.finish(lease, { outcome: 'completed' });
  return lease;
}

test('limits off admits forty sequential turns in one hour without fleet, actor or quota writes', async () => {
  const f = fixture();
  const conversationId = randomUUID();
  for (let i = 0; i < 40; i++) {
    await complete(i % 2 ? f.a : f.b, turn('same-browser', { conversationId }));
  }
  assert.equal(await f.store.read('day#2026-09-12'), null);
  assert.equal(await f.store.read('actor#same-browser'), null);
  assert.equal(await f.store.read('admission#guide'), null);
  assert.ok(f.writes.flat().every(id => /^(request|conversation)#/.test(id)));
});

test('limits off ignores exhausted old hourly and daily counters without modifying them', async () => {
  const f = fixture();
  const actor = { id: 'actor#same-browser', v: 1, until: 0, owner: null,
    starts: Array(5).fill(NOW), day: '2026-09-12', dayCount: 30, expiresAt: NOW / 1000 + 259200 };
  const daily = { id: 'day#2026-09-12', v: 1, requests: 30, expiresAt: NOW / 1000 + 259200 };
  await f.store.commit([actor, daily].map(after => ({ before: null, after })));
  await complete(f.a, turn());
  assert.deepEqual(await f.store.read(actor.id), actor);
  assert.deepEqual(await f.store.read(daily.id), daily);
});

test('independent actors have no replacement concurrency ceiling across two instances', async () => {
  const f = fixture();
  const leases = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    (i % 2 ? f.a : f.b).acquire(turn(`actor-${i}`))));
  await Promise.all(leases.map((lease, i) => (i % 2 ? f.b : f.a).start(lease)));
  assert.equal(leases.length, 16);
  assert.equal(await f.store.read('admission#guide'), null);
  assert.ok(f.writes.every(ids => ids.length === 2));
});

test('one browser can start eight independent conversations at once', async () => {
  const f = fixture();
  const leases = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? f.a : f.b).acquire(turn())));
  await Promise.all(leases.map(lease => f.b.start(lease)));
  assert.equal(new Set(leases.map(lease => lease.conversationId)).size, 8);
  assert.equal(await f.store.read('actor#same-browser'), null);
});

test('same conversation races admit one request and return conversation_busy without reserving losers', async () => {
  const f = fixture();
  const conversationId = randomUUID();
  const inputs = Array.from({ length: 12 }, () => turn('same-browser', { conversationId }));
  const results = await Promise.allSettled(inputs.map((input, i) => (i % 2 ? f.a : f.b).acquire(input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    assert.equal(result.reason.code, 'conversation_busy');
    assert.equal(result.reason.status, 409);
    assert.equal(result.reason.retryAfter, 120);
    assert.equal(await f.store.read(`request#${inputs[i].requestId}`), null);
  }
  const lease = results.find(result => result.status === 'fulfilled').value;
  await f.b.start(lease);
  await f.a.finish(lease, { outcome: 'completed' });
  await complete(f.make(), turn('same-browser', { conversationId }));
});

test('conversation UUID casing cannot create a parallel conversation lease', async () => {
  const f = fixture();
  const input = turn();
  await f.a.acquire(input);
  await assert.rejects(f.b.acquire(turn(input.actorId, { conversationId: input.conversationId.toUpperCase() })),
    code('conversation_busy', 409));
});

test('duplicate request IDs and starts remain atomic and payload or actor changes are conflicts', async () => {
  const f = fixture();
  const input = turn();
  const acquired = await Promise.allSettled([f.a.acquire(input), f.b.acquire(input)]);
  assert.equal(acquired.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(acquired.find(result => result.status === 'rejected').reason.code, 'request_in_progress');
  const lease = acquired.find(result => result.status === 'fulfilled').value;
  const starts = await Promise.allSettled([f.a.start(lease), f.b.start(lease)]);
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  await f.b.finish(lease, { outcome: 'completed' });
  await assert.rejects(f.make().acquire(input), code('request_completed', 409));
  await assert.rejects(f.a.acquire({ ...input, requestHash: 'b'.repeat(64) }), code('request_conflict', 409));
  await assert.rejects(f.a.acquire({ ...input, actorId: 'other' }), code('request_conflict', 409));
});

test('conversation leases remain bound to their actor, including after completion', async () => {
  const f = fixture();
  const input = turn();
  const lease = await f.a.acquire(input);
  for (const finished of [false, true]) {
    if (finished) await f.a.finish(lease, { outcome: 'failed' });
    await assert.rejects(f.b.acquire(turn('other-actor', { conversationId: input.conversationId })),
      code('invalid_conversation', 403));
  }
});

test('unknown outcomes hold only their conversation and never authorize another invocation of that ID', async () => {
  const f = fixture();
  const input = turn();
  const lease = await f.a.acquire(input);
  await f.a.start(lease);
  await f.a.finish(lease, { outcome: 'unknown' });
  await assert.rejects(f.b.acquire(input), code('request_unknown', 409));
  await assert.rejects(f.b.acquire(turn(input.actorId, { conversationId: input.conversationId })), code('conversation_busy', 409));
  await complete(f.b, turn(input.actorId));
  f.advance(120_001);
  await assert.rejects(f.make().acquire(input), code('request_unknown', 409));
  const replacement = await f.b.acquire(turn(input.actorId, { conversationId: input.conversationId }));
  await f.a.finish(lease, { outcome: 'completed' });
  await f.b.start(replacement);
  await assert.rejects(f.a.acquire(turn(input.actorId, { conversationId: input.conversationId })), code('conversation_busy', 409));
});

test('expired reserved and started owners cannot start or release the replacement conversation lease', async () => {
  for (const started of [false, true]) {
    const f = fixture();
    const input = turn();
    const old = await f.a.acquire(input);
    if (started) await f.a.start(old);
    f.advance(120_001);
    const replacement = await f.b.acquire(turn(input.actorId, { conversationId: input.conversationId }));
    const before = await f.store.read(replacement.conversationKey);
    assert.equal(before.owner, replacement.owner);
    await assert.rejects(f.a.start(old));
    await f.a.finish(old, { outcome: 'failed' });
    assert.deepEqual(await f.store.read(replacement.conversationKey), before);
    await f.b.start(replacement);
  }
});

test('lost acquire and start acknowledgements never permit a repeated request or start', async () => {
  for (const phase of ['acquire', 'start']) {
    const f = fixture();
    const input = turn();
    let lease;
    if (phase === 'start') lease = await f.a.acquire(input);
    const commit = f.store.commit.bind(f.store);
    let loseAck = true;
    f.store.commit = async (...args) => {
      await commit(...args);
      if (loseAck) { loseAck = false; throw new Error('acknowledgement lost'); }
    };
    await assert.rejects(phase === 'start' ? f.a.start(lease) : f.a.acquire(input), code('quota_unavailable', 503));
    await assert.rejects(f.b.acquire(input), code('request_in_progress', 409));
    if (lease) await assert.rejects(f.b.start(lease), code('request_in_progress', 409));
  }
});

test('storage failures, corrupt leases and aborted requests still fail closed with limits off', async () => {
  const f = fixture();
  f.store.read = async () => { throw new Error('private store failure'); };
  assert.equal(await f.a.ready(), false);
  await assert.rejects(f.b.acquire(turn()), code('quota_unavailable', 503));
  const corrupt = fixture();
  const input = turn();
  await corrupt.store.commit([{ before: null, after: {
    id: `conversation#${input.conversationId}`, actorId: input.actorId, until: 'unknown', owner: randomUUID(), v: 1,
  } }]);
  await assert.rejects(corrupt.a.acquire(input), code('quota_unavailable', 503));
  const aborted = fixture();
  await assert.rejects(aborted.a.acquire(turn('a', { signal: AbortSignal.abort() })));
  assert.equal(aborted.writes.length, 0);
});

test('an active old lease without conversation metadata blocks conservatively, then stops imposing an actor cap', async () => {
  const f = fixture();
  const legacyActor = { id: 'actor#same-browser', v: 1, owner: randomUUID(), until: NOW + 120_000,
    starts: [NOW], day: '2026-09-12', dayCount: 1, expiresAt: NOW / 1000 + 259200 };
  await f.store.commit([{ before: null, after: legacyActor }]);
  await assert.rejects(f.a.acquire(turn()), code('conversation_busy', 409));
  await complete(f.a, turn('different-actor'));
  f.advance(120_001);
  const leases = await Promise.all(Array.from({ length: 6 }, () => f.b.acquire(turn())));
  await Promise.all(leases.map(lease => f.a.start(lease)));
  assert.deepEqual(await f.store.read(legacyActor.id), legacyActor);
});

test('new limited leases identify their conversation without blocking other unlimited conversations', async () => {
  const f = fixture();
  const limited = f.make({ limitsEnabled: true });
  const input = turn();
  const lease = await limited.acquire(input);
  await limited.start(lease);
  await assert.rejects(f.a.acquire(turn(input.actorId, { conversationId: input.conversationId })), code('conversation_busy', 409));
  const others = await Promise.all(Array.from({ length: 6 }, () => f.b.acquire(turn(input.actorId))));
  await Promise.all(others.map(other => f.a.start(other)));
  await limited.finish(lease, { outcome: 'completed' });
  await complete(f.b, turn(input.actorId, { conversationId: input.conversationId }));
});

test('limited and unlimited starts cannot both invoke a conversation during a mode transition', async () => {
  const f = fixture();
  const limited = f.make({ limitsEnabled: true });
  const input = turn();
  const offLease = await f.a.acquire(input);
  await assert.rejects(limited.acquire(turn(input.actorId, { conversationId: input.conversationId })), code('conversation_busy', 409));
  await f.b.start(offLease);
});

test('a stale limited reservation loses the conversation race at start without releasing the unlimited owner', async () => {
  const f = fixture();
  const limited = f.make({ limitsEnabled: true });
  const input = turn();
  const key = `conversation#${input.conversationId}`;
  const read = f.store.read.bind(f.store);
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  let snapshots = 0;
  f.store.read = async (...args) => {
    const row = await read(...args);
    if (args[0] === key && snapshots < 2) {
      if (++snapshots === 2) release();
      await bothRead;
    }
    return row;
  };
  // Both acquire paths saw an absent conversation. The limited path retains
  // its legacy reservation transaction, so its start must fence that snapshot.
  const [old, current] = await Promise.all([
    limited.acquire(input),
    f.a.acquire(turn(input.actorId, { conversationId: input.conversationId })),
  ]);
  const starts = await Promise.allSettled([limited.start(old), f.b.start(current)]);
  assert.equal(starts[0].status, 'rejected');
  assert.equal(starts[0].reason.code, 'conversation_busy');
  assert.equal(starts[1].status, 'fulfilled');
  await limited.finish(old, { outcome: 'failed' });
  assert.equal((await f.store.read(key)).owner, current.owner);
  await assert.rejects(f.a.acquire(turn(input.actorId, { conversationId: input.conversationId })), code('conversation_busy', 409));
});

test('a delayed unlimited acquire rechecks the lease after a limited start wins its compare-and-swap', async () => {
  const f = fixture();
  const limited = f.make({ limitsEnabled: true });
  const input = turn();
  const commit = f.store.commit.bind(f.store);
  let limitedLease;
  let intercepted = false;
  f.store.commit = async (...args) => {
    if (!intercepted && args[0].some(({ after }) => after.conversationKey)) {
      intercepted = true;
      limitedLease = await limited.acquire(turn(input.actorId, { conversationId: input.conversationId }));
      await limited.start(limitedLease);
    }
    return commit(...args);
  };
  await assert.rejects(f.a.acquire(input), code('conversation_busy', 409));
  assert.equal(await f.store.read(`request#${input.requestId}`), null);
  assert.equal((await f.store.read(`conversation#${input.conversationId}`)).owner, limitedLease.owner);
});

test('only an explicit boolean false disables limits; unused caps need no replacement values', async () => {
  assert.throws(() => createAdmission({ store: createMemoryAdmissionStore(), limitsEnabled: 'false' }));
  const f = fixture({ dailyLimit: null, hourlyLimit: null, actorDailyLimit: null, globalConcurrency: null });
  await complete(f.a, turn());
  assert.throws(() => createAdmission({ store: createMemoryAdmissionStore(), dailyLimit: 31 }));
});
