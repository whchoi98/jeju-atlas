import type { RouteMode, RouteRequest, RouteResult, RouteSource } from '../shared/routing-types';
import { getConfig, isJejuPoint, withAbort } from './api.ts';

type ConfigLoader = (refresh?: boolean) => Promise<unknown>;
export type RouteClientOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  loadConfig?: ConfigLoader;
};
export class RouteClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = 'RouteClientError';
    this.code = code;
    this.status = status;
  }
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 30_000;
const unavailableCodes = new Set(['no_route', 'endpoint_unreachable', 'ferry_required', 'routing_unavailable']);
const refreshes = new WeakMap<ConfigLoader, Promise<unknown>>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const invalid = () => new RouteClientError('invalid_response');

function source(value: unknown): RouteSource {
  if (!object(value) || value.provider !== 'valhalla' || value.data !== 'OpenStreetMap'
    || !text(value.attribution, 1000) || !value.attribution.trim() || !text(value.url, 2048)) throw invalid();
  let url: URL;
  try { url = new URL(value.url); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  if (value.data_updated_at !== null && (!text(value.data_updated_at, 50)
    || !Number.isFinite(Date.parse(value.data_updated_at)))) throw invalid();
  return {
    provider: 'valhalla', data: 'OpenStreetMap', attribution: value.attribution, url: url.href,
    data_updated_at: value.data_updated_at as string | null,
  };
}
function coordinates(value: unknown): [number, number][] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_POINTS) throw invalid();
  return value.map(point => {
    if (!Array.isArray(point) || point.length !== 2 || !isJejuPoint(point[0], point[1])) throw invalid();
    return [point[0], point[1]];
  });
}
function routeResult(value: unknown, request: RouteRequest): RouteResult {
  if (!object(value) || value.mode !== request.mode) throw invalid();
  const origin = source(value.source);
  if (value.available === false) {
    if (typeof value.code !== 'string' || !unavailableCodes.has(value.code)) throw invalid();
    return { available: false, mode: request.mode, source: origin, code: value.code } as RouteResult;
  }
  if (value.available !== true || value.traffic !== 'not_live' || !number(value.distance_m)
    || !number(value.duration_s) || !Array.isArray(value.legs) || value.legs.length !== request.stops.length - 1
    || !Array.isArray(value.snapped) || ![0, request.stops.length].includes(value.snapped.length)
    || !Array.isArray(value.warnings) || value.warnings.length > 64
    || !value.warnings.every(warning => text(warning, 1000))) throw invalid();
  const path = coordinates(value.coordinates);
  let pointCount = path.length;
  let stepCount = 0;
  const legs = value.legs.map(leg => {
    if (!object(leg) || !number(leg.distance_m) || !number(leg.duration_s) || !Array.isArray(leg.steps)) throw invalid();
    const path = coordinates(leg.coordinates);
    pointCount += path.length;
    stepCount += leg.steps.length;
    if (pointCount > 2 * MAX_POINTS + 12 || stepCount > 5000) throw invalid();
    const steps = leg.steps.map(step => {
      if (!object(step) || !text(step.instruction, 2000) || !number(step.distance_m) || !number(step.duration_s)
        || !Number.isInteger(step.start_index) || !Number.isInteger(step.end_index)
        || (step.start_index as number) < 0 || (step.end_index as number) < (step.start_index as number)
        || (step.end_index as number) >= path.length) throw invalid();
      return {
        instruction: step.instruction, distance_m: step.distance_m, duration_s: step.duration_s,
        start_index: step.start_index as number, end_index: step.end_index as number,
      };
    });
    return { distance_m: leg.distance_m, duration_s: leg.duration_s, coordinates: path, steps };
  });
  const snapped = value.snapped.map(point => {
    if (!object(point) || !isJejuPoint(point.lng, point.lat) || !number(point.distance_m)) throw invalid();
    return { lng: point.lng as number, lat: point.lat as number, distance_m: point.distance_m };
  });
  return {
    available: true, mode: request.mode, source: origin, distance_m: value.distance_m,
    duration_s: value.duration_s, legs, coordinates: path, snapped,
    warnings: value.warnings as string[], traffic: 'not_live',
  };
}
function requestBody(value: RouteRequest): RouteRequest {
  if (!object(value) || !['walk', 'car'].includes(value.mode) || !['ko', 'en'].includes(value.locale)
    || !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 12
    || value.stops.some(point => !object(point) || !isJejuPoint(point.lng, point.lat))) {
    throw new RouteClientError('invalid_request', 400);
  }
  return { mode: value.mode, locale: value.locale, stops: value.stops.map(({ lng, lat }) => ({ lng, lat })) };
}
function proof(value: unknown, mode: RouteMode): string {
  if (!object(value) || !object(value.features) || value.features.routing !== true
    || !object(value.routing) || value.routing.enabled !== true
    || !Array.isArray(value.routing.modes) || !value.routing.modes.includes(mode)) {
    throw new RouteClientError('routing_unavailable', 503);
  }
  const token = value.routing.csrf_token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new RouteClientError('session_required', 401);
  return token;
}
function refreshConfig(load: ConfigLoader): Promise<unknown> {
  let pending = refreshes.get(load);
  if (!pending) {
    pending = Promise.resolve().then(() => load(true)).finally(() => {
      if (refreshes.get(load) === pending) refreshes.delete(load);
    });
    refreshes.set(load, pending);
  }
  return pending;
}
async function responseJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw invalid();
  const body = await withAbort(response.text(), signal);
  if (new TextEncoder().encode(body).length > MAX_BYTES) throw invalid();
  try { return JSON.parse(body); } catch { throw invalid(); }
}

/** Cookie and CSRF session proof stay out of the URL/body; no AI endpoint is used. */
export async function requestRoute(input: RouteRequest, {
  signal, fetchImpl = fetch, loadConfig = getConfig,
}: RouteClientOptions = {}): Promise<RouteResult> {
  const body = requestBody(input);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Route timeout', 'TimeoutError')), 20_000);
  const active = controller.signal;
  try {
    active.throwIfAborted();
    let csrf = proof(await withAbort(loadConfig(false), active), body.mode);
    for (let attempt = 0; attempt < 2; attempt++) {
      active.throwIfAborted();
      const response = await withAbort(fetchImpl('/api/routes', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Atlas-CSRF': csrf },
        body: JSON.stringify(body), signal: active,
      }), active);
      const data = await responseJSON(response, active);
      active.throwIfAborted();
      if (response.ok) return routeResult(data, body);
      const rawCode = object(data) && object(data.error) ? data.error.code : object(data) ? data.code : null;
      const code = typeof rawCode === 'string' && /^[a-z_]{1,64}$/.test(rawCode) ? rawCode : 'routing_unavailable';
      if (attempt === 0 && ((response.status === 401 && code === 'session_required')
        || (response.status === 403 && code === 'csrf_invalid'))) {
        csrf = proof(await withAbort(refreshConfig(loadConfig), active), body.mode);
        continue;
      }
      throw new RouteClientError(code, response.status);
    }
    throw new RouteClientError('routing_unavailable', 503);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (active.aborted) throw new RouteClientError('timeout');
    if (error instanceof RouteClientError) throw error;
    throw new RouteClientError('network');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
