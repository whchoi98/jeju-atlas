import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const POOL = 'admission#guide';
const RETENTION_MS = 3 * 86400_000;
const dayOf = (now) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

export class AdmissionError extends Error {
  constructor(status, code, retryAfter = 0) {
    super(code);
    this.name = 'AdmissionError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
class Conflict extends Error {}
const unavailable = () => new AdmissionError(503, 'quota_unavailable');
const version = (row) => row?.v ?? 0;
function change(before, value) {
  return { before, after: { ...value, v: version(before) + 1 } };
}
function matches(current, before) {
  return before === null ? current === undefined || current === null
    : current != null && version(current) === version(before) && current.requests === before.requests;
}

/** Local/test implementation of the same atomic compare-and-swap store contract. */
export function createMemoryAdmissionStore() {
  const rows = new Map();
  return {
    async read(id) { return structuredClone(rows.get(id) ?? null); },
    async commit(changes, { signal } = {}) {
      signal?.throwIfAborted();
      if (changes.some(({ before, after }) => !matches(rows.get(after.id), before))) throw new Conflict();
      // No await between validation and publication: a transaction is all or nothing.
      for (const { after } of changes) rows.set(after.id, structuredClone(after));
    },
    close() {},
  };
}

function dynamoStore({ table, client, region }) {
  let sdk;
  let ownedClient;
  async function send(name, input, signal) {
    if (!table) throw unavailable();
    sdk ??= import('@aws-sdk/client-dynamodb');
    const module = await sdk;
    const transport = client || (ownedClient ??= new module.DynamoDBClient({ region, maxAttempts: 1 }));
    const timeout = AbortSignal.timeout(5000);
    return transport.send(new module[name](input), { abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  }
  return {
    async read(id, { signal } = {}) {
      const response = await send('GetItemCommand', {
        TableName: table, Key: { id: { S: id } }, ConsistentRead: true,
      }, signal);
      if (!response.Item) return null;
      const item = response.Item;
      const data = item.data?.S ? JSON.parse(item.data.S) : {};
      const row = { ...data, id, v: Number(item.v?.N ?? 0), expiresAt: Number(item.expiresAt?.N ?? 0) };
      if (item.requests) row.requests = Number(item.requests.N);
      if (!Number.isSafeInteger(row.v) || row.v < 0 || !Number.isFinite(row.expiresAt)
        || (row.requests !== undefined && (!Number.isSafeInteger(row.requests) || row.requests < 0))) throw unavailable();
      return row;
    },
    async commit(changes, { signal } = {}) {
      const TransactItems = changes.map(({ before, after }) => {
        const { id, v, expiresAt, requests, ...data } = after;
        const json = JSON.stringify(data);
        if (Buffer.byteLength(json) > 240 * 1024) throw unavailable();
        const names = { '#id': 'id', '#v': 'v', '#data': 'data', '#ttl': 'expiresAt' };
        const values = { ':v': { N: String(v) }, ':data': { S: json }, ':ttl': { N: String(expiresAt) } };
        let condition = 'attribute_not_exists(#id)';
        if (before !== null) {
          values[':old'] = { N: String(version(before)) };
          condition = 'attribute_exists(#id) AND (#v = :old OR attribute_not_exists(#v))';
        }
        let update = 'SET #v = :v, #data = :data, #ttl = :ttl';
        if (requests !== undefined) {
          names['#requests'] = 'requests';
          values[':requests'] = { N: String(requests) };
          update += ', #requests = :requests';
          // Legacy writers do not update v. Compare their counter too, so a
          // rolling deployment cannot erase an admission made by old code.
          if (before?.requests !== undefined) {
            values[':previousRequests'] = { N: String(before.requests) };
            condition += ' AND #requests = :previousRequests';
          } else condition += ' AND attribute_not_exists(#requests)';
        }
        return { Update: {
          TableName: table, Key: { id: { S: id } }, UpdateExpression: update,
          ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        } };
      });
      try {
        await send('TransactWriteItemsCommand', { TransactItems, ClientRequestToken: randomUUID() }, signal);
      } catch (error) {
        if (error?.name === 'TransactionConflictException'
          || error?.CancellationReasons?.some((reason) => ['ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code))) {
          throw new Conflict();
        }
        throw error;
      }
    },
    close() { ownedClient?.destroy(); },
  };
}

/**
 * Fleet-wide admission. No prompt, answer, cookie or conversation token is
 * retained. Request IDs remain deduplicated for the ledger's three-day TTL.
 * Unknown outcomes never authorize a second invocation of the same ID.
 * Duplicates return 409; this store does not cache/replay AI answers. TTL is
 * only eventual record cleanup: until timestamps, not TTL deletion, release
 * expired capacity. Every guide-serving task must use this admission path;
 * legacy tasks share the daily counter but do not participate in leases.
 */
export function createAdmission({
  table, client, store: suppliedStore, region = 'ap-northeast-2', clock = Date.now,
  dailyLimit = 30, hourlyLimit = 5, actorDailyLimit = dailyLimit,
  globalConcurrency = 2, leaseMs = 120_000,
} = {}) {
  for (const [value, max] of [[dailyLimit, 30], [hourlyLimit, 5], [actorDailyLimit, 30], [globalConcurrency, 2]]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid admission limit');
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 120_000 || leaseMs > 300_000) throw new Error('Invalid admission lease duration');
  const store = suppliedStore || dynamoStore({ table, client, region });
  let closed = false;
  async function operation(work) {
    if (closed) throw unavailable();
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return await work(); }
      catch (error) {
        if (error instanceof AdmissionError) throw error;
        if (!(error instanceof Conflict)) throw unavailable();
        await yieldToLoop();
      }
    }
    throw new AdmissionError(429, 'guide_busy', 1);
  }
  function duplicate(row, requestHash, actorId, now) {
    if (row.requestHash !== requestHash || row.actorId !== actorId) throw new AdmissionError(409, 'request_conflict');
    if (row.state === 'completed') throw new AdmissionError(409, 'request_completed');
    if (['failed', 'unknown'].includes(row.state) || row.until <= now) throw new AdmissionError(409, 'request_unknown');
    throw new AdmissionError(409, 'request_in_progress', Math.max(1, Math.ceil((row.until - now) / 1000)));
  }
  function keys(input) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.actorId ?? '') || !UUID.test(input.requestId ?? '')
      || !UUID.test(input.conversationId ?? '') || !/^[a-f0-9]{64}$/.test(input.requestHash ?? '')) {
      throw new AdmissionError(400, 'invalid_request');
    }
    return { actorKey: `actor#${input.actorId}`, requestKey: `request#${input.requestId.toLowerCase()}` };
  }
  return {
    async ready() {
      if (closed) return false;
      try { await store.read(POOL); return true; } catch { return false; }
    },
    acquire(input) {
      const { actorKey, requestKey } = keys(input);
      return operation(async () => {
        input.signal?.throwIfAborted();
        const now = clock();
        const previous = await store.read(requestKey, { signal: input.signal });
        if (previous) duplicate(previous, input.requestHash, input.actorId, now);
        const day = dayOf(now);
        const dailyKey = `day#${day}`;
        const [pool, actor, daily] = await Promise.all([POOL, actorKey, dailyKey].map((id) => store.read(id, { signal: input.signal })));
        if ((pool && (!Array.isArray(pool.slots) || pool.slots.some(slot => !UUID.test(slot?.owner ?? '')
          || !Number.isSafeInteger(slot.until) || typeof slot.actorId !== 'string')))
          || (actor && (!Array.isArray(actor.starts) || actor.starts.some(time => !Number.isSafeInteger(time))
            || !Number.isSafeInteger(actor.dayCount) || actor.dayCount < 0 || !Number.isSafeInteger(actor.until)))
          || (daily && (!Number.isSafeInteger(daily.requests) || daily.requests < 0))) throw unavailable();
        const slots = (pool?.slots ?? []).filter((slot) => slot.until > now);
        if (slots.length >= globalConcurrency || slots.some((slot) => slot.actorId === input.actorId) || (actor?.until ?? 0) > now) {
          throw new AdmissionError(429, 'guide_busy', 5);
        }
        const starts = (actor?.starts ?? []).filter((time) => time > now - 3600_000);
        if (starts.length >= hourlyLimit) throw new AdmissionError(429, 'hourly_limit', Math.ceil((starts[0] + 3600_000 - now) / 1000));
        if ((daily?.requests ?? 0) >= dailyLimit || (actor?.day === day && actor.dayCount >= actorDailyLimit)) {
          throw new AdmissionError(429, 'daily_limit');
        }
        const owner = randomUUID();
        const until = now + leaseMs;
        const expiresAt = Math.floor((now + RETENTION_MS) / 1000);
        const lease = { owner, until, actorKey, requestKey, actorId: input.actorId, requestId: input.requestId.toLowerCase(), conversationId: input.conversationId };
        await store.commit([
          change(daily, { id: dailyKey, requests: (daily?.requests ?? 0) + 1, expiresAt }),
          change(actor, { id: actorKey, starts: [...starts, now], day, dayCount: (actor?.day === day ? actor.dayCount : 0) + 1, owner, until, expiresAt }),
          change(pool, { id: POOL, slots: [...slots, { owner, until, actorId: input.actorId }], expiresAt }),
          change(null, { id: requestKey, state: 'reserved', actorId: input.actorId, owner, until, requestHash: input.requestHash, conversationId: input.conversationId, expiresAt }),
        ], { signal: input.signal });
        return lease;
      });
    },
    start(lease, { signal } = {}) {
      return operation(async () => {
        const [request, actor, pool] = await Promise.all([lease.requestKey, lease.actorKey, POOL].map((id) => store.read(id, { signal })));
        if (!request || request.owner !== lease.owner || request.state !== 'reserved'
          || request.until <= clock() || actor?.owner !== lease.owner || !pool?.slots.some((slot) => slot.owner === lease.owner)) {
          throw new AdmissionError(409, 'request_in_progress');
        }
        await store.commit([
          change(request, { ...request, state: 'started' }),
          change(actor, actor), change(pool, pool),
        ], { signal });
        signal?.throwIfAborted();
        if (clock() >= lease.until) throw new AdmissionError(409, 'request_unknown');
      });
    },
    finish(lease, { outcome } = {}) {
      if (!['completed', 'failed', 'unknown'].includes(outcome)) throw new AdmissionError(400, 'invalid_request');
      return operation(async () => {
        const [request, actor, pool] = await Promise.all([lease.requestKey, lease.actorKey, POOL].map((id) => store.read(id)));
        if (!request || request.owner !== lease.owner || ['completed', 'failed', 'unknown'].includes(request.state)) return;
        const changes = [change(request, { ...request, state: outcome })];
        if (outcome !== 'unknown') {
          if (actor?.owner === lease.owner) changes.push(change(actor, { ...actor, owner: null, until: 0 }));
          if (pool?.slots.some((slot) => slot.owner === lease.owner)) {
            changes.push(change(pool, { ...pool, slots: pool.slots.filter((slot) => slot.owner !== lease.owner) }));
          }
        }
        await store.commit(changes);
      });
    },
    close() { closed = true; if (!suppliedStore) store.close(); },
  };
}
