import { randomBytes } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createSessions } from './sessions.mjs';
import { AdmissionError, createAdmission } from './admission.mjs';
import { createWeatherService, inJeju } from './weather.mjs';
import {
  GuideError, createGuideHandler, createAgentInvoker, createDynamoQuotaConsumer, emitGuideDiagnostic,
} from './guide.mjs';

const compress = promisify(gzip);
const BODY_LIMIT = 16 * 1024;
const PUBLIC_CACHE = 'public, max-age=60';
const CATALOG_BUILD_MAX_AGE_MS = 14 * 86_400_000;

function catalogBuildTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || /\s/.test(value)
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    return NaN;
  }
  // Date.parse can normalize impossible days; verify the calendar date too.
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalidQuery = () => new ApiError(400, 'invalid_query', '검색 조건이나 제주 좌표를 확인해 주세요.');

function acceptsGzip(header = '') {
  const encodings = String(header).toLowerCase().split(',').map((part) => {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    return { name, quality: q ? Number(q.slice(2)) : 1 };
  });
  const selected = encodings.find((entry) => entry.name === 'gzip') || encodings.find((entry) => entry.name === '*');
  return selected?.quality > 0;
}

async function sendJson(req, res, status, data, { publicCache = false, gzip: allowGzip = false } = {}) {
  if (res.destroyed || res.writableEnded) return;
  let body = Buffer.from(JSON.stringify(data));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': publicCache ? PUBLIC_CACHE : 'no-store',
  };
  if (publicCache) res.removeHeader('Set-Cookie');
  if (allowGzip) {
    headers.Vary = 'Accept-Encoding';
    if (body.length >= 1024 && acceptsGzip(req.headers['accept-encoding'])) {
      body = await compress(body);
      headers['Content-Encoding'] = 'gzip';
    }
  }
  if (res.destroyed || res.writableEnded) return;
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readJson(req, res) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'unsupported_media_type', 'JSON 형식으로 질문을 보내 주세요.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new ApiError(415, 'unsupported_encoding', '지원하지 않는 요청 형식입니다.');
  }
  const tooLarge = () => new ApiError(413, 'body_too_large', '요청 크기는 16KB 이하여야 합니다.');
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    res.setHeader('Connection', 'close');
    req.resume();
    throw tooLarge();
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onAbort = () => fail(new ApiError(400, 'invalid_body', '요청을 읽을 수 없습니다.'));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        res.setHeader('Connection', 'close');
        fail(tooLarge());
        req.resume();
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, 'invalid_body', '올바른 JSON 요청을 보내 주세요.'));
      }
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    if (req.aborted) onAbort();
  });
}

function queryParams(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw invalidQuery();
  }
  return url.searchParams;
}
function numberParam(params, name, min, max, { integer = false, fallback } = {}) {
  if (!params.has(name)) return fallback;
  const raw = params.get(name);
  if (!raw || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw invalidQuery();
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalidQuery();
  return value;
}
function stringParam(params, name, max) {
  if (!params.has(name)) return undefined;
  const value = params.get(name);
  if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalidQuery();
  return value.trim();
}
function coordinates(params, required = false) {
  if (!params.has('lat') && !params.has('lng') && !required) return {};
  if (!params.has('lat') || !params.has('lng')) throw invalidQuery();
  return {
    lat: numberParam(params, 'lat', 33.1, 33.6),
    lng: numberParam(params, 'lng', 126.15, 126.98),
  };
}
function searchOptions(url) {
  const params = queryParams(url, ['q', 'category', 'lat', 'lng', 'radius_m', 'limit', 'offset']);
  const options = {
    q: stringParam(params, 'q', 200) ?? '',
    limit: numberParam(params, 'limit', 1, 100, { integer: true, fallback: 40 }),
    offset: numberParam(params, 'offset', 0, 20_000, { integer: true, fallback: 0 }),
    ...coordinates(params),
  };
  const category = stringParam(params, 'category', 80);
  if (category) options.category = category;
  if (params.has('radius_m')) {
    if (options.lat === undefined) throw invalidQuery();
    options.radius_m = numberParam(params, 'radius_m', 100, 50_000);
  }
  return options;
}
function pointOptions(url) {
  const params = queryParams(url, ['bbox', 'category']);
  const options = {};
  if (params.has('bbox')) {
    const pieces = params.get('bbox').split(',');
    if (pieces.length !== 4 || pieces.some((piece) => !/^-?\d+(?:\.\d+)?$/.test(piece))) throw invalidQuery();
    const [west, south, east, north] = pieces.map(Number);
    if (!inJeju(south, west) || !inJeju(north, east) || west >= east || south >= north) throw invalidQuery();
    options.bbox = [west, south, east, north];
  }
  const category = stringParam(params, 'category', 80);
  if (category) options.category = category;
  return options;
}

function configuredOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin or an explicit loopback origin');
  }
}

/**
 * Synchronous factory, no AWS I/O until a guide invocation. Catalog ownership
 * stays with the caller: await catalog.init() before listening and close it on
 * shutdown. The returned (req, res, url) function has a close() lifecycle hook.
 */
export function createApiHandler({
  catalog, release = 'local', env = process.env,
  secret = env.ATLAS_SESSION_SECRET, publicOrigin = env.PUBLIC_ORIGIN,
  dailyLimit = Number(env.GUIDE_DAILY_LIMIT || 30),
  consumeQuota, invokeEvents, fetch: fetchImpl = globalThis.fetch, clock = Date.now,
  heartbeatMs = 8000, deadlineMs = 90_000, maxActors = 10_000,
  weatherOptions = {},
  onDiagnostic = () => {},
  admission: injectedAdmission,
} = {}) {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
    throw new Error('GUIDE_DAILY_LIMIT must be an integer between 1 and 1000');
  }
  const signingSecret = secret ?? (env.NODE_ENV === 'production' ? undefined : randomBytes(32));
  const sessions = createSessions({ secret: signingSecret, clock });
  const allowedOrigin = configuredOrigin(publicOrigin);
  const enabled = Boolean(allowedOrigin && (invokeEvents || env.GUIDE_RUNTIME_ARN)
    && (injectedAdmission || consumeQuota || env.GUIDE_QUOTA_TABLE));
  const admission = injectedAdmission || (env.GUIDE_QUOTA_TABLE && !consumeQuota ? createAdmission({
    table: env.GUIDE_QUOTA_TABLE, region: env.AWS_REGION || 'ap-northeast-2', clock, dailyLimit,
    hourlyLimit: Number(env.GUIDE_HOURLY_LIMIT || 5),
    globalConcurrency: Number(env.GUIDE_GLOBAL_CONCURRENCY || 2),
    leaseMs: Number(env.GUIDE_LEASE_MS || 120_000),
  }) : undefined);
  const agent = invokeEvents || createAgentInvoker({
    runtimeArn: env.GUIDE_RUNTIME_ARN, region: env.AWS_REGION || 'ap-northeast-2',
  });
  const quota = consumeQuota || createDynamoQuotaConsumer({
    table: env.GUIDE_QUOTA_TABLE, dailyLimit, region: env.AWS_REGION || 'ap-northeast-2', clock,
  });
  const guide = createGuideHandler({
    sessions, catalog, consumeQuota: quota, invokeEvents: agent, clock, heartbeatMs, deadlineMs, maxActors, onDiagnostic,
    admission, requestHashKey: signingSecret,
  });
  const weather = createWeatherService({ fetch: fetchImpl, clock, ...weatherOptions });
  let draining = false;
  let initialized = false;
  let catalogHeartbeat;
  const reportCatalogStatus = () => {
    let stale = 1;
    try {
      const status = catalog?.status();
      const builtAt = catalogBuildTimestamp(status?.built_at);
      const now = clock();
      const age = now - builtAt;
      stale = status?.status === 'ready' && status.stale === false
        && Number.isFinite(now) && Number.isFinite(builtAt) && age >= 0 && age <= CATALOG_BUILD_MAX_AGE_MS ? 0 : 1;
    } catch { /* Unreadable state is unavailable; never log storage details. */ }
    emitGuideDiagnostic(onDiagnostic, { event: 'catalog_status', stale });
  };

  async function api(req, res, url = new URL(req.url, 'http://localhost')) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const path = url.pathname;
      const expectedMethod = path === '/api/guide' ? 'POST' : 'GET';
      if (req.method !== expectedMethod) {
        res.setHeader('Allow', expectedMethod);
        throw new ApiError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
      }
      if (path === '/api/config') {
        const session = sessions.readCookie(req.headers.cookie) || sessions.issueCookie(res);
        return await sendJson(req, res, 200, {
          version: release,
          features: { catalog: Boolean(catalog && catalog.status().status === 'ready'), guide: enabled, planner: true, pwa: true },
          guide: {
            daily_limit: dailyLimit,
            ...(enabled ? { csrf_token: sessions.csrfToken(session.actorId) } : {}),
          },
        });
      }
      if (path === '/api/guide') {
        if (draining) throw new GuideError(503, 'guide_unavailable');
        const session = sessions.readCookie(req.headers.cookie);
        const proof = req.headers['x-atlas-csrf'];
        const originMatches = allowedOrigin && req.headers.origin === allowedOrigin;
        const proofMatches = session && sessions.verifyCsrf(proof, session.actorId);
        // The private, same-origin config response hands the app a proof bound
        // to its signed cookie. No wildcard CORS or anonymous-origin bypass.
        if (!allowedOrigin || (!originMatches && !proofMatches)) {
          throw proof !== undefined
            ? new ApiError(403, 'csrf_invalid', '요청 연결 확인이 만료되었습니다. 연결을 갱신해 주세요.')
            : new ApiError(403, 'origin_forbidden', '허용된 페이지에서 다시 요청해 주세요.');
        }
        if (!session) {
          sessions.issueCookie(res);
          throw new ApiError(401, 'session_required', '페이지를 새로고침한 뒤 다시 질문해 주세요.');
        }
        if (!enabled) throw new GuideError(503, 'guide_unavailable');
        const body = await readJson(req, res);
        return await guide.handle(req, res, body, session.actorId);
      }
      if (path === '/api/weather') {
        const params = queryParams(url, ['lat', 'lng']);
        const result = await weather.get(coordinates(params, true));
        return await sendJson(req, res, result.available ? 200 : 503, result);
      }
      if (path.startsWith('/api/catalog/')) {
        let operation;
        if (path === '/api/catalog/status') operation = () => catalog.status();
        else if (path === '/api/catalog/search') {
          const options = searchOptions(url);
          operation = () => catalog.search(options);
        } else if (path === '/api/catalog/points') {
          const options = pointOptions(url);
          operation = () => {
            const result = catalog.points(options);
            // Catalog also validates these; retain a final rendering/size bound.
            if (result.features.length > 20_000) {
              throw new ApiError(503, 'catalog_limit', '지도 범위를 좁혀 장소를 다시 불러와 주세요.');
            }
            return {
              type: 'FeatureCollection',
              features: result.features.filter((feature) => {
                const coords = feature?.geometry?.coordinates;
                return feature?.type === 'Feature' && feature.geometry.type === 'Point'
                  && Array.isArray(coords) && inJeju(coords[1], coords[0]);
              }),
            };
          };
        } else if (path.startsWith('/api/catalog/places/')) {
          let id;
          try { id = decodeURIComponent(path.slice('/api/catalog/places/'.length)); } catch { throw invalidQuery(); }
          if (!id || id.length > 256 || /[\x00-\x1f\x7f\\]/.test(id) || id.split('/').some((part) => part.startsWith('.'))) {
            throw invalidQuery();
          }
          operation = () => catalog.detail(id);
        }
        if (operation) {
          if (!catalog) throw new ApiError(503, 'catalog_unavailable', '장소 카탈로그를 불러올 수 없습니다.');
          try { await catalog.refreshIfNeeded?.(); } catch { /* retain the last verified catalog */ }
          if (path !== '/api/catalog/status' && catalog.status().status !== 'ready') {
            throw new ApiError(503, 'catalog_unavailable', '장소 카탈로그를 불러올 수 없습니다.');
          }
          const result = operation();
          if (!result) throw new ApiError(404, 'place_not_found', '해당 장소를 찾을 수 없습니다.');
          const available = path !== '/api/catalog/status' || result.status === 'ready';
          return await sendJson(req, res, available ? 200 : 503, result, { publicCache: available, gzip: true });
        }
      }
      throw new ApiError(404, 'not_found', '요청한 API를 찾을 수 없습니다.');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const failure = error instanceof AdmissionError ? new GuideError(error.status, error.code)
        : error instanceof ApiError || error instanceof GuideError
        ? error : error instanceof RangeError || (error?.statusCode === 400 && error?.code === 'CATALOG_BAD_QUERY')
          ? invalidQuery() : new ApiError(503, 'service_unavailable', '서비스에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      if (url.pathname === '/api/guide') {
        emitGuideDiagnostic(onDiagnostic, {
          event: 'guide_rejected', code: failure.code, status: failure.status,
          ...(req.guideRequestId ? { request_id: req.guideRequestId } : {}),
        });
      }
      if (failure.status === 429) res.setHeader('Retry-After', failure.code === 'hourly_limit' ? '3600' : '60');
      if (error instanceof AdmissionError && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      await sendJson(req, res, failure.status, { error: { code: failure.code, message: failure.message } });
    }
  }
  // A shared quota outage disables AI admission, not healthy map/catalog tasks.
  api.ready = async () => !draining && (!catalog || catalog.status().status === 'ready');
  api.init = async () => {
    if (!(await api.ready()) || draining) throw new Error('API dependencies unavailable');
    if (initialized) return;
    initialized = true;
    reportCatalogStatus();
    catalogHeartbeat = setInterval(reportCatalogStatus, 60_000);
    catalogHeartbeat.unref?.();
  };
  api.beginDrain = () => { draining = true; guide.beginDrain(); };
  api.drain = () => { api.beginDrain(); return guide.drain(); };
  api.close = () => {
    draining = true;
    clearInterval(catalogHeartbeat);
    guide.close();
    weather.close();
    // Only close transports created by this factory; injected ones belong to their caller.
    if (!invokeEvents) agent.close();
    if (!consumeQuota) quota.close();
    if (!injectedAdmission) admission?.close();
  };
  return api;
}
