import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class PresenceError extends Error {
  constructor(status = 503, code = 'presence_unavailable') {
    super(code);
    this.name = 'PresenceError';
    this.status = status;
    this.code = code;
  }
}
const unavailable = () => new PresenceError();
const key = (scope, visitor) => ({ scope: { S: scope }, visitor: { S: visitor } });
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const validDate = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

function totalRecord(value) {
  if (value === null) return { total_visitors: 0, counting_since: null };
  if (!value || !validCount(value.total_visitors)
    || (value.counting_since !== null && !validDate(value.counting_since))) throw unavailable();
  return { total_visitors: value.total_visitors, counting_since: value.counting_since };
}

function interruptible(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/**
 * Injected store contract: remember(hash, now, options) atomically marks/counts
 * the first visit; touch(hash, now, windowMs, options) extends activity and
 * returns whether it became active; countActive(cutoff, now, options) and
 * readTotal(options) return aggregates. options contains an AbortSignal.
 * Activity has no upper bound: another task may renew last_seen after now.
 * This implementation deliberately retains expired online rows like delayed TTL.
 */
export function createMemoryPresenceStore() {
  const seen = new Set();
  const online = new Map();
  let total = null;
  return {
    async remember(visitor, now, { signal } = {}) {
      signal?.throwIfAborted();
      if (seen.has(visitor)) return false;
      if (total?.total_visitors === Number.MAX_SAFE_INTEGER) throw unavailable();
      // No await between the marker and counter: one atomic first visit.
      seen.add(visitor);
      total = {
        total_visitors: (total?.total_visitors ?? 0) + 1,
        counting_since: total?.counting_since ?? new Date(now).toISOString(),
      };
      return true;
    },
    async touch(visitor, now, windowMs, { signal } = {}) {
      signal?.throwIfAborted();
      const previous = online.get(visitor);
      if (previous && previous.last_seen >= now) return false;
      online.set(visitor, { last_seen: now, expires_at: Math.ceil((now + windowMs) / 1000) });
      return !previous || previous.last_seen <= now - windowMs;
    },
    async countActive(cutoff, _now, { signal } = {}) {
      signal?.throwIfAborted();
      let count = 0;
      for (const row of online.values()) if (row.last_seen > cutoff) count++;
      return count;
    },
    async readTotal({ signal } = {}) {
      signal?.throwIfAborted();
      return total && { ...total };
    },
    close() {},
  };
}

function dynamoStore({ table, region, client, maxAttempts, retryDelayMs, maxQueryPages, queryPageSize }) {
  let sdk;
  let ownedClient;
  async function send(name, input, signal) {
    signal?.throwIfAborted();
    sdk ??= import('@aws-sdk/client-dynamodb');
    const module = await sdk;
    signal?.throwIfAborted();
    const transport = client || (ownedClient ??= new module.DynamoDBClient({ region, maxAttempts: 1 }));
    return transport.send(new module[name](input), { abortSignal: signal });
  }
  async function seen(visitor, signal) {
    const result = await send('GetItemCommand', {
      TableName: table, Key: key('seen', visitor), ConsistentRead: true,
      ProjectionExpression: '#visitor', ExpressionAttributeNames: { '#visitor': 'visitor' },
    }, signal);
    return Boolean(result.Item);
  }
  async function readTotal({ signal } = {}) {
    const result = await send('GetItemCommand', {
      TableName: table, Key: key('meta', 'total'), ConsistentRead: true,
      ProjectionExpression: '#total, #since',
      ExpressionAttributeNames: { '#total': 'total_visitors', '#since': 'counting_since' },
    }, signal);
    if (!result.Item) return null;
    const total = result.Item.total_visitors?.N;
    if (typeof total !== 'string' || !/^\d+$/.test(total)
      || (result.Item.counting_since && typeof result.Item.counting_since.S !== 'string')) throw unavailable();
    return totalRecord({
      total_visitors: Number(total), counting_since: result.Item.counting_since?.S ?? null,
    });
  }
  const retryable = error => ['TransactionCanceledException', 'TransactionConflictException',
    'TransactionInProgressException', 'InternalServerError', 'ServiceUnavailable',
    'ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'ThrottlingException',
    'TimeoutError', 'NetworkingError'].includes(error?.name);
  return {
    async remember(visitor, now, { signal } = {}) {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        signal?.throwIfAborted();
        if (await seen(visitor, signal)) return false;
        const total = await readTotal({ signal });
        const bootstrap = total === null;
        // Only a truly absent counter gets a start timestamp. An existing
        // counter without provenance must continue reporting an unknown start.
        const update = bootstrap ? {
          UpdateExpression: 'SET #total = :one, #since = :since',
          ConditionExpression: 'attribute_not_exists(#visitor)',
          ExpressionAttributeNames: { '#visitor': 'visitor', '#total': 'total_visitors', '#since': 'counting_since' },
          ExpressionAttributeValues: { ':one': { N: '1' }, ':since': { S: new Date(now).toISOString() } },
        } : {
          UpdateExpression: 'ADD #total :one',
          ConditionExpression: '#total >= :zero AND #total < :max',
          ExpressionAttributeNames: { '#total': 'total_visitors' },
          ExpressionAttributeValues: {
            ':one': { N: '1' }, ':zero': { N: '0' }, ':max': { N: String(Number.MAX_SAFE_INTEGER) },
          },
        };
        try {
          await send('TransactWriteItemsCommand', {
            ClientRequestToken: randomUUID(),
            TransactItems: [
              { Put: {
                TableName: table,
                Item: { ...key('seen', visitor), first_seen: { N: String(now) } },
                ConditionExpression: 'attribute_not_exists(#visitor)',
                ExpressionAttributeNames: { '#visitor': 'visitor' },
              } },
              { Update: { TableName: table, Key: key('meta', 'total'), ...update } },
            ],
          }, signal);
          return true;
        } catch (error) {
          signal?.throwIfAborted();
          // A transaction can commit even when its response is lost. The
          // permanent marker also resolves another replica's winning join.
          if (await seen(visitor, signal)) return false;
          if (!retryable(error) || attempt + 1 === maxAttempts) throw error;
          if (retryDelayMs) await delay(retryDelayMs * 2 ** attempt, undefined, { signal });
        }
      }
      throw unavailable();
    },
    async touch(visitor, now, windowMs, { signal } = {}) {
      try {
        const result = await send('UpdateItemCommand', {
          TableName: table, Key: key('online', visitor),
          UpdateExpression: 'SET #last_seen = :now, #expires = :expires',
          ConditionExpression: 'attribute_not_exists(#last_seen) OR #last_seen < :now',
          ExpressionAttributeNames: { '#last_seen': 'last_seen', '#expires': 'expires_at' },
          ExpressionAttributeValues: {
            ':now': { N: String(now) }, ':expires': { N: String(Math.ceil((now + windowMs) / 1000)) },
          },
          ReturnValues: 'ALL_OLD',
        }, signal);
        const previous = result.Attributes?.last_seen?.N;
        if (previous !== undefined && !validCount(Number(previous))) throw unavailable();
        return previous === undefined || Number(previous) <= now - windowMs;
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    async countActive(cutoff, _now, { signal } = {}) {
      let cursor;
      let count = 0;
      for (let page = 0; page < maxQueryPages; page++) {
        const response = await send('QueryCommand', {
          TableName: table, ConsistentRead: true, Select: 'COUNT', Limit: queryPageSize,
          KeyConditionExpression: '#scope = :online',
          FilterExpression: '#last_seen > :cutoff',
          ExpressionAttributeNames: { '#scope': 'scope', '#last_seen': 'last_seen' },
          ExpressionAttributeValues: {
            ':online': { S: 'online' }, ':cutoff': { N: String(cutoff) },
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }, signal);
        if (!validCount(response.Count) || !validCount(count + response.Count)) throw unavailable();
        count += response.Count;
        cursor = response.LastEvaluatedKey;
        if (!cursor || !Object.keys(cursor).length) return count;
      }
      // A filtered page may be empty and still have a cursor. Never turn a
      // pagination/time budget into a plausible but incomplete visitor count.
      throw unavailable();
    },
    readTotal,
    close() { ownedClient?.destroy(); },
  };
}

/**
 * Fleet-wide signed-browser-session counts. Authentication belongs to the API.
 * Injected clients/stores remain caller-owned. No AWS work occurs until called.
 */
export function createPresenceService({
  table, region = 'ap-northeast-2', client, store, clock = Date.now,
  windowMs = 90_000, cacheMs = 5000, timeoutMs = 4000, maxPending = 64,
  maxAttempts = 3, retryDelayMs = 25, maxQueryPages = 20, queryPageSize = 1000,
} = {}) {
  for (const [name, value, minimum, maximum] of [
    ['windowMs', windowMs, 1000, 300_000], ['cacheMs', cacheMs, 0, 10_000],
    ['timeoutMs', timeoutMs, 1, 30_000], ['maxPending', maxPending, 1, 1000],
    ['maxAttempts', maxAttempts, 1, 5], ['retryDelayMs', retryDelayMs, 0, 1000],
    ['maxQueryPages', maxQueryPages, 1, 100], ['queryPageSize', queryPageSize, 1, 1000],
  ]) if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid presence ${name}`);
  if (windowMs % 1000 || cacheMs >= windowMs || typeof clock !== 'function') throw new RangeError('Invalid presence timing');
  const configured = Boolean(store || (typeof table === 'string' && table.trim()));
  const backend = store ?? dynamoStore({ table, region, client, maxAttempts, retryDelayMs, maxQueryPages, queryPageSize });
  const lifetime = new AbortController();
  let closed = false;
  let pending = 0;
  let revision = 0;
  let cached;
  let flight;
  function now() {
    const value = clock();
    if (!validCount(value) || !Number.isFinite(new Date(value).getTime())) throw unavailable();
    return value;
  }
  async function bounded(work, signal) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(unavailable()), timeoutMs);
    const combined = AbortSignal.any([deadline.signal, lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      return await interruptible(Promise.resolve().then(() => {
        combined.throwIfAborted();
        return work(combined);
      }), combined);
    } finally { clearTimeout(timer); }
  }
  async function run(work, signal) {
    signal?.throwIfAborted();
    if (!configured || closed || pending >= maxPending) throw unavailable();
    pending++;
    try { return await bounded(work, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw unavailable();
    } finally { pending--; }
  }
  async function aggregate(signal) {
    for (;;) {
      signal.throwIfAborted();
      const time = now();
      if (cached && time >= cached.time && time < cached.time + cacheMs) return { ...cached.result };
      if (!flight) {
        const current = { revision, promise: null };
        current.promise = bounded(async sharedSignal => {
          const asOf = now();
          const active = await backend.countActive(asOf - windowMs, asOf, { signal: sharedSignal });
          sharedSignal.throwIfAborted();
          // Writers count a session before publishing its online row. Reading
          // the counter after the query avoids a locally inconsistent total.
          const total = totalRecord(await backend.readTotal({ signal: sharedSignal }));
          sharedSignal.throwIfAborted();
          if (!validCount(active) || active > total.total_visitors) throw unavailable();
          const result = {
            active_visitors: active, total_visitors: total.total_visitors,
            as_of: new Date(asOf).toISOString(), window_seconds: windowMs / 1000,
            counting_since: total.counting_since,
          };
          if (current.revision === revision) cached = { time: asOf, result };
          return result;
        }).finally(() => { if (flight === current) flight = undefined; });
        flight = current;
      }
      const current = flight;
      const result = await interruptible(current.promise, signal);
      if (current.revision === revision) return { ...result };
      // A join/reactivation during this read invalidates its older result.
      // All callers still share the next read and their original deadlines.
    }
  }
  return {
    get enabled() { return configured && !closed; },
    async heartbeat(actorId, { signal } = {}) {
      if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 512) {
        throw new PresenceError(400, 'presence_actor_invalid');
      }
      return run(async requestSignal => {
        const visitor = createHash('sha256').update('jeju-atlas:presence:v1\0').update(actorId).digest('hex');
        const time = now();
        const created = await backend.remember(visitor, time, { signal: requestSignal });
        requestSignal.throwIfAborted();
        const activated = await backend.touch(visitor, time, windowMs, { signal: requestSignal });
        requestSignal.throwIfAborted();
        if (created || activated) { revision++; cached = undefined; }
        return aggregate(requestSignal);
      }, signal);
    },
    snapshot({ signal } = {}) { return run(aggregate, signal); },
    close() {
      if (closed) return;
      closed = true;
      cached = undefined;
      lifetime.abort(unavailable());
      if (!store) backend.close();
    },
  };
}
