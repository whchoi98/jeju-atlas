import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { inJeju } from './weather.mjs';

const MESSAGES = {
  guide_unavailable: '여행 가이드를 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  guide_busy: '여행 가이드가 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.',
  guide_timeout: '응답 시간이 길어 중단했습니다. 질문을 나누어 다시 시도해 주세요.',
  agent_error: '여행 가이드 응답 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  invalid_response: '여행 가이드의 응답을 확인할 수 없습니다. 다시 질문해 주세요.',
  daily_limit: '오늘의 여행 가이드 이용 한도에 도달했습니다. 내일 다시 이용해 주세요.',
  hourly_limit: '한 시간 동안의 이용 한도에 도달했습니다. 잠시 후 다시 이용해 주세요.',
  quota_unavailable: '이용 한도를 확인할 수 없어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요.',
  invalid_conversation: '대화가 만료되었거나 확인되지 않습니다. 새 대화를 시작해 주세요.',
  invalid_message: '질문은 1자 이상 2,000자 이하로 입력해 주세요.',
};

export class GuideError extends Error {
  constructor(status, code) {
    super(MESSAGES[code] || MESSAGES.agent_error);
    this.name = 'GuideError';
    this.status = status;
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'agent_error';
  }
}

function abortable(value, signal) {
  const promise = Promise.resolve(value);
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((result) => { cleanup(); resolve(result); }, (error) => { cleanup(); reject(error); });
  });
}

function closeBody(body) {
  try {
    if (typeof body?.destroy === 'function') body.destroy();
    else if (typeof body?.cancel === 'function') Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    // A stream may already have been closed by the SDK's AbortSignal.
  }
}

function jsonObject(text) {
  try {
    let data = JSON.parse(text);
    if (typeof data === 'string') data = JSON.parse(data);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Only a safe, fixed message is ever returned to the browser.
  }
  throw new GuideError(502, 'invalid_response');
}

async function* byteChunks(body) {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    yield typeof body === 'string' ? Buffer.from(body) : body;
  } else if (body?.[Symbol.asyncIterator] || body?.[Symbol.iterator]) {
    yield* body;
  } else {
    throw new GuideError(502, 'invalid_response');
  }
}

/**
 * Decode the actual runtime wire format, including split UTF-8 characters and
 * JSON encoded as a JSON string. The non-SSE runtime response is one whole map.
 */
export async function* decodeAgentResponse({ response, contentType }, { signal } = {}) {
  const sse = typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const close = () => closeBody(response);
  signal?.addEventListener('abort', close, { once: true });
  let buffer = '';
  let dataLines = [];
  let frameSize = 0;
  let totalBytes = 0;
  function parseFrame() {
    const text = dataLines.join('\n');
    dataLines = [];
    frameSize = 0;
    return text.trim() === '[DONE]' ? { type: 'done' } : jsonObject(text);
  }
  function* lines(final = false) {
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (dataLines.length) yield parseFrame();
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        dataLines.push(data);
        frameSize += data.length + 1;
        if (frameSize > 256 * 1024) {
          throw new GuideError(502, 'invalid_response');
        }
      }
    }
    if (buffer.length > 256 * 1024) throw new GuideError(502, 'invalid_response');
    if (final) {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
      buffer = '';
      if (dataLines.length) yield parseFrame();
    }
  }
  try {
    signal?.throwIfAborted();
    for await (const raw of byteChunks(response)) {
      signal?.throwIfAborted();
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
      if (!(chunk instanceof Uint8Array)) throw new GuideError(502, 'invalid_response');
      totalBytes += chunk.byteLength;
      if (totalBytes > 1024 * 1024) throw new GuideError(502, 'invalid_response');
      buffer += decoder.decode(chunk, { stream: true });
      if (sse) yield* lines();
    }
    buffer += decoder.decode();
    if (sse) {
      yield* lines(true);
    } else {
      const map = jsonObject(buffer.trim());
      if (typeof map.answer !== 'string') throw new GuideError(502, 'invalid_response');
      yield { ...map, type: 'map' };
      yield { type: 'done' };
    }
  } finally {
    signal?.removeEventListener('abort', close);
    close();
  }
}

/** invokeEvents({ message, actorId, conversationId, signal }) -> async events. */
export function createAgentInvoker({ runtimeArn, region = 'ap-northeast-2', client } = {}) {
  let sdk;
  let ownedClient;
  async function* invokeEvents({ message, actorId, conversationId, signal }) {
    if (!runtimeArn) throw new GuideError(503, 'guide_unavailable');
    sdk ??= import('@aws-sdk/client-bedrock-agentcore');
    const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = await sdk;
    const transport = client || (ownedClient ??= new BedrockAgentCoreClient({ region, maxAttempts: 1 }));
    signal?.throwIfAborted();
    let result;
    try {
      result = await transport.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn, qualifier: 'DEFAULT',
        runtimeSessionId: conversationId, runtimeUserId: actorId,
        contentType: 'application/json', accept: 'text/event-stream',
        payload: Buffer.from(JSON.stringify({
          prompt: message, user_id: actorId, conversation_id: conversationId, locale: 'ko', stream: true,
        })),
      }), { abortSignal: signal });
      signal?.throwIfAborted();
      if (result.statusCode !== undefined
        && (!Number.isInteger(result.statusCode) || result.statusCode < 200 || result.statusCode >= 300)) {
        throw new GuideError(502, 'agent_error');
      }
      yield* decodeAgentResponse(result, { signal });
    } finally {
      closeBody(result?.response);
    }
  }
  invokeEvents.close = () => ownedClient?.destroy();
  return invokeEvents;
}

/** One conditional UpdateItem, without reads or refunds, for the shared KST day. */
export function createDynamoQuotaConsumer({
  table, dailyLimit = 30, region = 'ap-northeast-2', clock = Date.now, client,
} = {}) {
  let sdk;
  let ownedClient;
  async function consumeQuota({ signal } = {}) {
    if (!table) throw new GuideError(503, 'quota_unavailable');
    try {
      sdk ??= import('@aws-sdk/client-dynamodb');
      const { DynamoDBClient, UpdateItemCommand } = await sdk;
      const transport = client || (ownedClient ??= new DynamoDBClient({ region, maxAttempts: 1 }));
      const now = clock();
      const day = new Date(now + 9 * 60 * 60_000).toISOString().slice(0, 10);
      await transport.send(new UpdateItemCommand({
        TableName: table, Key: { id: { S: `day#${day}` } },
        UpdateExpression: 'SET #expires = :expires ADD #requests :one',
        ConditionExpression: 'attribute_not_exists(#requests) OR #requests < :limit',
        ExpressionAttributeNames: { '#requests': 'requests', '#expires': 'expiresAt' },
        ExpressionAttributeValues: {
          ':one': { N: '1' }, ':limit': { N: String(dailyLimit) },
          ':expires': { N: String(Math.floor(now / 1000) + 3 * 86400) },
        },
      }), { abortSignal: signal });
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') throw new GuideError(429, 'daily_limit');
      throw new GuideError(503, 'quota_unavailable');
    }
  }
  consumeQuota.close = () => ownedClient?.destroy();
  return consumeQuota;
}

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const point = (value) => record(value) && inJeju(value.lat, value.lng) ? { lat: value.lat, lng: value.lng } : null;
const timestamp = (value) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Project the untrusted MapResponseV2 onto shared/api-types.ts's GuideMap. */
export function normalizeGuideMap(input, { catalog } = {}) {
  if (!record(input) || typeof input.answer !== 'string' || !input.answer.trim()) {
    throw new GuideError(502, 'invalid_response');
  }
  const warnings = [];
  const warn = (message) => { if (!warnings.includes(message) && warnings.length < 32) warnings.push(message); };
  const center = point(input.center);
  if (input.center != null && !center) warn('제주 범위를 벗어난 지도 중심을 제외했습니다.');
  const markers = [];
  const ids = new Set();
  const rawMarkers = Array.isArray(input.markers) ? input.markers : [];
  for (const marker of rawMarkers.slice(0, 1000)) {
    if (markers.length >= 12) break;
    if (!record(marker) || typeof marker.id !== 'string' || !marker.id || marker.id.length > 256 || ids.has(marker.id)) continue;
    let known;
    try {
      const candidate = catalog?.detail(marker.id);
      if (candidate?.id === marker.id) known = candidate;
    } catch {
      // An unavailable catalog cannot attest to a model-supplied marker.
    }
    const coordinates = point(known || marker);
    const name = text(known?.name ?? marker.name, 160).trim();
    const category = text(known?.category ?? marker.category, 80).trim();
    if (!coordinates || !name || !category) {
      warn('이름이나 제주 좌표를 확인할 수 없는 장소를 제외했습니다.');
      continue;
    }
    markers.push({
      id: marker.id, name, category, ...coordinates,
      summary: text(known?.summary ?? marker.summary, 1200),
      source: known ? text(known.source, 120) || null : null,
      observed_at: known ? timestamp(known.updated_at) : null,
    });
    ids.add(marker.id);
    if (!known) warn('카탈로그에서 확인되지 않은 장소가 포함되어 있습니다. 방문 전에 확인해 주세요.');
    if (known?.base_note || /curated|seed/i.test(known?.source || '')) {
      warn('큐레이션 시드의 기본 정보는 공식 대조 검증을 거치지 않았습니다.');
    }
  }
  if (rawMarkers.length > 12) warn('장소는 최대 12개까지 표시합니다.');
  let route = [];
  if (Array.isArray(input.route) && input.route.length) {
    // Dropping an interior point and joining its neighbors invents a shortcut.
    if (input.route.length > 512 || input.route.some((item) => !point(item))) {
      warn('범위 밖 좌표가 있거나 너무 긴 경로는 지도에서 제외했습니다.');
    } else {
      route = input.route.map(point);
    }
  }
  let routeMeta = null;
  const meta = input.route_meta;
  if (record(meta) && ['car', 'walk', 'transit', 'straight'].includes(meta.mode)
    && nonnegative(meta.distance_m) && (meta.duration_s == null || nonnegative(meta.duration_s))
    && typeof meta.provider === 'string' && meta.provider.trim()) {
    routeMeta = {
      mode: meta.mode, distance_m: meta.distance_m, duration_s: meta.duration_s ?? null,
      provider: text(meta.provider, 160),
    };
  }
  if (route.length && !routeMeta) warn('이 연결선은 도로 이동 경로로 확인되지 않았습니다.');
  if (Array.isArray(input.warnings)) {
    for (const message of input.warnings.slice(0, 32)) if (typeof message === 'string') warn(message.slice(0, 300));
  }
  return {
    answer: input.answer.slice(0, 6000), center,
    zoom: Number.isFinite(input.zoom) ? Math.min(20, Math.max(1, input.zoom)) : 10,
    markers, route, route_meta: routeMeta, warnings,
  };
}

function validateTurn(body) {
  if (!record(body) || Object.keys(body).some((key) => !['message', 'conversation_id'].includes(key))
    || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000
    || (Object.hasOwn(body, 'conversation_id')
      && (typeof body.conversation_id !== 'string' || !body.conversation_id || body.conversation_id.length > 1024))) {
    throw new GuideError(400, 'invalid_message');
  }
}

function safeError(error) {
  if (error instanceof GuideError) return error;
  if (['ThrottlingException', 'ServiceQuotaExceededException', 'RetryableConflictException'].includes(error?.name)) {
    return new GuideError(503, 'guide_busy');
  }
  return new GuideError(502, 'agent_error');
}

function eventError(event) {
  if (['turn_timeout', 'guide_timeout'].includes(event.code)) return new GuideError(504, 'guide_timeout');
  if (['agent_busy', 'guide_busy'].includes(event.code)) return new GuideError(503, 'guide_busy');
  if (['invalid_map', 'invalid_response'].includes(event.code)) return new GuideError(502, 'invalid_response');
  return new GuideError(502, 'agent_error');
}

function statusMessage(event) {
  if (event.stage !== 'tool') return '여행 가이드가 답변을 준비하고 있습니다.';
  if (event.tool === 'find_places') return '제주 카탈로그에서 장소를 찾고 있습니다.';
  return '여행에 필요한 정보를 확인하고 있습니다.';
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function writeEvent(res, event, data, signal) {
  if (res.destroyed || res.writableEnded) return;
  signal?.throwIfAborted();
  if (res.write(frame(event, data))) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', drained);
      res.off('close', closed);
      res.off('error', closed);
      signal?.removeEventListener('abort', aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new GuideError(503, 'guide_unavailable')); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    res.once('drain', drained);
    res.once('close', closed);
    res.once('error', closed);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function createGuideHandler({
  sessions, catalog, consumeQuota, invokeEvents, clock = Date.now,
  heartbeatMs = 8000, deadlineMs = 90_000, maxActors = 10_000,
}) {
  const active = new Map();
  const usage = new Map();
  let closed = false;
  function prune(now) {
    for (const [actor, starts] of usage) {
      while (starts.length && starts[0] <= now - 3_600_000) starts.shift();
      if (!starts.length && !active.has(actor)) usage.delete(actor);
    }
  }

  async function handle(req, res, body, actorId) {
    if (res.destroyed || res.writableEnded) return;
    validateTurn(body);
    const conversation = body.conversation_id
      ? sessions.verifyConversation(body.conversation_id, actorId)
      : sessions.createConversation(actorId);
    if (!conversation) throw new GuideError(403, 'invalid_conversation');
    if (closed) throw new GuideError(503, 'guide_unavailable');
    const now = clock();
    prune(now);
    if (active.has(actorId) || active.size >= 2) throw new GuideError(429, 'guide_busy');
    if ((usage.get(actorId)?.length || 0) >= 5) throw new GuideError(429, 'hourly_limit');
    if (!usage.has(actorId) && usage.size >= maxActors) throw new GuideError(503, 'guide_busy');
    const controller = new AbortController();
    const { signal } = controller;
    active.set(actorId, controller);
    const onClose = () => controller.abort(new GuideError(503, 'guide_unavailable'));
    // IncomingMessage 'close' fires when its body completes, not when the
    // browser abandons an already-started response.
    res.once('close', onClose);
    if (res.destroyed) onClose();
    const deadline = setTimeout(() => controller.abort(new GuideError(504, 'guide_timeout')), deadlineMs);
    let heartbeat;
    let iterator;
    let started = false;
    try {
      let permitted;
      try {
        permitted = await abortable(Promise.resolve().then(() => {
          signal.throwIfAborted();
          return consumeQuota({ signal });
        }), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error instanceof GuideError ? error : new GuideError(503, 'quota_unavailable');
      }
      if (permitted === false) throw new GuideError(429, 'daily_limit');
      signal.throwIfAborted();
      const starts = usage.get(actorId) || [];
      starts.push(clock());
      usage.set(actorId, starts);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive',
      });
      res.flushHeaders();
      started = true;
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded && res.writableLength < 64 * 1024) res.write(': heartbeat\n\n');
      }, heartbeatMs);
      heartbeat.unref();
      await writeEvent(res, 'session', { conversation_id: conversation.token }, signal);
      const source = await abortable(Promise.resolve().then(() => {
        signal.throwIfAborted();
        return invokeEvents({ message: body.message, actorId, conversationId: conversation.id, signal });
      }), signal);
      iterator = source?.[Symbol.asyncIterator]?.() || source?.[Symbol.iterator]?.();
      if (!iterator) throw new GuideError(502, 'invalid_response');
      let answer = '';
      let map;
      let count = 0;
      for (;;) {
        const item = await abortable(iterator.next(), signal);
        if (item.done) break;
        if (++count > 16_384) throw new GuideError(502, 'invalid_response');
        const event = item.value;
        if (!record(event)) continue;
        if (event.type === 'done') break;
        if (event.type === 'error') throw eventError(event);
        if (event.type === 'status') {
          await writeEvent(res, 'status', { message: statusMessage(event) }, signal);
        } else if (event.type === 'token') {
          const delta = text(event.text, Math.max(0, 6000 - answer.length));
          if (delta) {
            answer += delta;
            await writeEvent(res, 'text', { delta }, signal);
          }
        } else if (event.type === 'map') {
          map = normalizeGuideMap({
            ...event, answer: typeof event.answer === 'string' && event.answer.trim() ? event.answer : answer,
          }, { catalog });
        }
        // Even an immediately-resolving iterator cannot starve HTTP/timers.
        if (count % 32 === 0) await yieldToLoop(undefined, { signal });
      }
      if (!map) {
        if (!answer.trim()) throw new GuideError(502, 'invalid_response');
        map = normalizeGuideMap({ answer, warnings: ['지도 정보 없이 텍스트 답변만 제공되었습니다.'] });
      }
      await writeEvent(res, 'map', map, signal);
      await writeEvent(res, 'done', {}, signal);
      res.end();
    } catch (error) {
      if (!started) throw error;
      if (!res.destroyed && !res.writableEnded) {
        const failure = safeError(signal.aborted ? signal.reason : error);
        res.end(frame('error', { code: failure.code, message: failure.message }) + frame('done', {}));
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      res.off('close', onClose);
      controller.abort(new GuideError(503, 'guide_unavailable'));
      // Never await an uncooperative generator's return while its next() is
      // pending. The SDK body itself is closed synchronously by the signal.
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* already closed */ }
      active.delete(actorId);
    }
  }

  return {
    handle,
    close() {
      closed = true;
      for (const controller of active.values()) controller.abort(new GuideError(503, 'guide_unavailable'));
      usage.clear();
    },
  };
}
