import { createHash } from 'node:crypto';

const SNAP_LIMIT_M = 200;
const MAX_STEPS = 2048;
const MAX_DISTANCE_M = 2_000_000;
const MAX_DURATION_S = 30 * 86400;
const LANGUAGES = { ko: 'ko-KR', en: 'en-US' };
const ELEVATION_SOURCE = Object.freeze({
  name: 'Mapzen / Skadi DEM · source 2016-04-23 · sampled by Valhalla',
  url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const inJeju = (lng, lat) => number(lng, 126.15, 126.98) && number(lat, 33.1, 33.6);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const invalidResponse = () => new Error('Invalid routing response');
const abortError = () => new DOMException('Routing request cancelled', 'AbortError');
const requireResponse = condition => { if (!condition) throw invalidResponse(); };

export class RoutingError extends Error {
  constructor(status, code) {
    super(status === 400 ? '이동 수단과 제주 좌표를 확인해 주세요.'
      : status === 429 ? '경로 요청이 많습니다. 잠시 후 다시 시도해 주세요.'
      : '경로 서비스를 일시적으로 이용할 수 없습니다.');
    this.name = 'RoutingError';
    this.status = status;
    this.code = code;
  }
}

function routeInput(value) {
  if (!keysOnly(value, ['mode', 'locale', 'stops'])
    || !['walk', 'car'].includes(value.mode) || !['ko', 'en'].includes(value.locale)
    || !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 12
    || value.stops.some(stop => !keysOnly(stop, ['lng', 'lat']) || !inJeju(stop.lng, stop.lat))) {
    throw new RoutingError(400, 'invalid_request');
  }
  return { mode: value.mode, locale: value.locale, stops: value.stops.map(({ lng, lat }) => ({ lng, lat })) };
}
function elevationInput(value) {
  if (!keysOnly(value, ['coordinates']) || !Array.isArray(value.coordinates)
    || value.coordinates.length < 2 || value.coordinates.length > 256
    || value.coordinates.some(point => !Array.isArray(point) || point.length !== 2 || !inJeju(point[0], point[1]))) {
    throw new RoutingError(400, 'invalid_request');
  }
  return { coordinates: value.coordinates.map(([lng, lat]) => [lng, lat]) };
}
function engineOrigin(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.port !== '8002' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new TypeError('Routing URL must be the loopback HTTP origin on port 8002');
  }
}
function sourceDate(value) {
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
    || !Number.isFinite(Date.parse(value))) return null;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return day.toISOString().slice(0, 10) === value.slice(0, 10) ? value : null;
}
function metres(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const term = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, term)));
}
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const rounded = value => Math.round(value * 1000) / 1000;

// Canonical Valhalla JSON uses polyline6, not OSRM's GeoJSON shape format.
// Limit every component as well as the number of vertices; never truncate a route.
function decodeShape(shape, limit) {
  requireResponse(typeof shape === 'string' && shape.length > 0);
  let cursor = 0, lat = 0, lng = 0;
  const delta = () => {
    let value = 0, shift = 0;
    while (true) {
      requireResponse(cursor < shape.length && shift <= 30);
      const part = shape.charCodeAt(cursor++) - 63;
      requireResponse(part >= 0 && part <= 63);
      value += (part & 31) * 2 ** shift;
      requireResponse(Number.isSafeInteger(value) && value <= 0xffffffff);
      if (part < 32) return value % 2 ? -(Math.floor(value / 2) + 1) : value / 2;
      shift += 5;
    }
  };
  const points = [];
  while (cursor < shape.length) {
    requireResponse(points.length < limit);
    lat += delta(); lng += delta();
    const point = [lng / 1e6, lat / 1e6];
    requireResponse(inJeju(point[0], point[1]));
    points.push(point);
  }
  requireResponse(points.length >= 2);
  return points;
}
function summary(value) {
  requireResponse(object(value) && number(value.length, 0, MAX_DISTANCE_M / 1000)
    && number(value.time, 0, MAX_DURATION_S));
  return { distance_m: rounded(value.length * 1000), duration_s: value.time };
}
function hasFerry(trip) {
  return trip.summary?.has_ferry === true || trip.legs.some(leg => leg?.summary?.has_ferry === true
    || (Array.isArray(leg?.maneuvers) && leg.maneuvers.some(step => step?.ferry === true
      || step?.type === 28 || step?.type === 29 || step?.travel_type === 'ferry')));
}
function normalizeRoute(data, request, source, maxCoordinates) {
  const unavailable = code => ({ available: false, mode: request.mode, source, code });
  const trip = data?.trip;
  requireResponse(object(trip) && trip.status === 0 && trip.units === 'kilometers'
    && trip.language === LANGUAGES[request.locale] && Array.isArray(trip.legs)
    && trip.legs.length === request.stops.length - 1);
  if (hasFerry(trip)) return unavailable('ferry_required');
  const totals = summary(trip.summary);
  let vertexCount = 0, stepCount = 0;
  const legs = trip.legs.map(leg => {
    requireResponse(object(leg));
    const metrics = summary(leg.summary);
    const coordinates = decodeShape(leg.shape, maxCoordinates - vertexCount);
    vertexCount += coordinates.length;
    requireResponse(Array.isArray(leg.maneuvers) && leg.maneuvers.length > 0);
    stepCount += leg.maneuvers.length;
    requireResponse(stepCount <= MAX_STEPS);
    const steps = leg.maneuvers.map(step => {
      requireResponse(object(step) && typeof step.instruction === 'string'
        && step.instruction.length > 0 && step.instruction.length <= 2000
        && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(step.instruction)
        && number(step.length, 0, MAX_DISTANCE_M / 1000) && number(step.time, 0, MAX_DURATION_S)
        && Number.isInteger(step.begin_shape_index) && Number.isInteger(step.end_shape_index)
        && step.begin_shape_index >= 0 && step.end_shape_index >= step.begin_shape_index
        && step.end_shape_index < coordinates.length
        && (step.travel_mode === undefined || step.travel_mode === (request.mode === 'car' ? 'drive' : 'pedestrian')));
      return {
        instruction: step.instruction, distance_m: rounded(step.length * 1000), duration_s: step.time,
        start_index: step.begin_shape_index, end_index: step.end_shape_index,
      };
    });
    // A reported road length cannot be shorter than its own endpoint chord
    // beyond metre-level serialization/rounding differences.
    requireResponse(metrics.distance_m + 25 >= metres(coordinates[0], coordinates.at(-1)));
    return { ...metrics, coordinates, steps };
  });
  const sumDistance = legs.reduce((total, leg) => total + leg.distance_m, 0);
  const sumTime = legs.reduce((total, leg) => total + leg.duration_s, 0);
  requireResponse(Math.abs(sumDistance - totals.distance_m) <= legs.length + 1
    && Math.abs(sumTime - totals.duration_s) <= legs.length + 1);
  const coordinates = [...legs[0].coordinates];
  for (let index = 1; index < legs.length; index++) {
    requireResponse(samePoint(coordinates.at(-1), legs[index].coordinates[0]));
    coordinates.push(...legs[index].coordinates.slice(1));
  }
  const endpoints = [legs[0].coordinates[0], ...legs.map(leg => leg.coordinates.at(-1))];
  const snapped = endpoints.map(([lng, lat], index) => ({
    lng, lat, distance_m: metres([request.stops[index].lng, request.stops[index].lat], [lng, lat]),
  }));
  if (snapped.some(point => point.distance_m > SNAP_LIMIT_M)) return unavailable('endpoint_unreachable');
  return {
    available: true, mode: request.mode, source, ...totals, legs, coordinates,
    snapped: snapped.map(point => ({ ...point, distance_m: rounded(point.distance_m) })),
    warnings: [request.locale === 'ko'
      ? 'OSM 도로·보행로 기반 예상치이며 실시간 교통을 반영하지 않습니다.'
      : 'Estimates use OSM roads and paths, without live traffic.'],
    traffic: 'not_live',
  };
}
function normalizeElevation(data, count) {
  // Valhalla 3.8.3 height_serializer.cc emits `height`; accept the plural
  // envelope too, without coercing strings, sentinels or missing cells to zero.
  const heights = data?.height ?? data?.heights;
  requireResponse(Array.isArray(heights) && heights.length <= count);
  return {
    available: true, source: ELEVATION_SOURCE,
    elevations_m: Array.from({ length: count }, (_, index) =>
      number(heights[index], -500, 9000) ? heights[index] : null),
  };
}
function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}
async function readResponse(response, signal, maxBytes) {
  if (!response?.body || Number(response.headers?.get('content-length')) > maxBytes) {
    void response?.body?.cancel().catch(() => {});
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      requireResponse(bytes <= maxBytes);
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, bytes);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Only the local, fixed-action engine boundary is injectable. This service has
 * no AWS/model dependency, no coordinate logging and no filesystem cache.
 * Limits are shared by route/height calls within this ECS task.
 */
export function createRoutingService({
  url, fetch: fetchImpl = globalThis.fetch, clock = Date.now, dataUpdatedAt,
  timeoutMs = 8000, maxConcurrent = 2, maxResponseBytes = 2 * 1024 * 1024,
  maxCoordinates = 20_000, maxCacheEntries = 64, maxCacheBytes = 4 * 1024 * 1024,
  cacheTtlMs = 60_000,
} = {}) {
  const origin = engineOrigin(url);
  for (const [value, max] of [
    [timeoutMs, 15_000], [maxConcurrent, 8], [maxResponseBytes, 8 * 1024 * 1024],
    [maxCoordinates, 100_000], [maxCacheEntries, 256], [maxCacheBytes, 16 * 1024 * 1024],
    [cacheTtlMs, 300_000],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid routing limit');
  }
  const source = Object.freeze({
    provider: 'valhalla', data: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors · ODbL · Valhalla',
    url: 'https://www.openstreetmap.org/copyright', data_updated_at: sourceDate(dataUpdatedAt),
  });
  const active = new Set(), cache = new Map();
  let closed = false, cacheBytes = 0;
  const forget = key => {
    const entry = cache.get(key);
    if (entry) { cacheBytes -= entry.bytes; cache.delete(key); }
  };
  const put = (key, result) => {
    const body = JSON.stringify(result), bytes = Buffer.byteLength(body);
    requireResponse(bytes <= maxResponseBytes);
    if (bytes > maxCacheBytes || !result.available) return;
    forget(key);
    while (cache.size >= maxCacheEntries || cacheBytes + bytes > maxCacheBytes) forget(cache.keys().next().value);
    cache.set(key, { body, bytes, expires: clock() + cacheTtlMs });
    cacheBytes += bytes;
  };
  const unavailable = (action, request, code) => action === 'route'
    ? { available: false, mode: request.mode, source, code: code || 'routing_unavailable' }
    : { available: false, source: ELEVATION_SOURCE, code: 'elevation_unavailable' };
  async function execute(action, request, signal) {
    if (signal?.aborted) throw abortError();
    if (!origin || closed) return unavailable(action, request);
    // Exact positions/mode/locale are hashed only for bounded in-memory lookup.
    // Do not round endpoints or share an in-flight operation's cancellation.
    const key = createHash('sha256').update(`${action}:${JSON.stringify(request)}`).digest('hex');
    const saved = cache.get(key);
    if (saved && clock() < saved.expires) {
      cache.delete(key); cache.set(key, saved);
      return JSON.parse(saved.body);
    }
    forget(key);
    if (active.size >= maxConcurrent) throw new RoutingError(429, 'routing_busy');
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const costing = request.mode === 'car' ? 'auto' : 'pedestrian';
      const body = action === 'height'
        ? { shape: request.coordinates.map(([lon, lat]) => ({ lon, lat })) }
        : {
          locations: request.stops.map(({ lng: lon, lat }) => ({
            lat, lon, type: 'break', search_cutoff: SNAP_LIMIT_M, search_filter: { exclude_ferry: true },
          })),
          costing, costing_options: { [costing]: { use_ferry: 0 } },
          units: 'kilometers', language: LANGUAGES[request.locale], directions_type: 'instructions', format: 'json',
        };
      const pending = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return fetchImpl(`${origin}/${action}`, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
      });
      // A late transport response must release its unread body after cancellation.
      void pending.then(response => {
        if (controller.signal.aborted) void response?.body?.cancel().catch(() => {});
      }, () => {});
      const response = await abortable(pending, controller.signal);
      const data = await readResponse(response, controller.signal, maxResponseBytes);
      controller.signal.throwIfAborted();
      if (!response.ok) {
        const code = response.status === 400 && action === 'route'
          ? data?.error_code === 171 ? 'endpoint_unreachable'
            : [170, 442].includes(data?.error_code) ? 'no_route' : undefined
          : undefined;
        return unavailable(action, request, code);
      }
      const result = action === 'height' ? normalizeElevation(data, request.coordinates.length)
        : normalizeRoute(data, request, source, maxCoordinates);
      controller.signal.throwIfAborted();
      put(key, result);
      return result;
    } catch {
      if (signal?.aborted) throw abortError();
      return unavailable(action, request);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
    }
  }
  return {
    enabled: Boolean(origin), source,
    route: async (request, signal) => execute('route', routeInput(request), signal),
    elevation: async (request, signal) => execute('height', elevationInput(request), signal),
    close() {
      closed = true;
      for (const controller of active) controller.abort();
      cache.clear(); cacheBytes = 0;
    },
  };
}
