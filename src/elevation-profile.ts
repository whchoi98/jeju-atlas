import { ApiError, getConfig, html, isJejuPoint, withAbort } from './api.ts';
import { createTourTrack } from './tours.ts';
import { getLocale } from './i18n.ts';
import { metricDistance, type Position } from './measurement.ts';
import type { RouteElevationResult } from '../shared/routing-types.ts';

export type ProfileSamples = { coordinates: Position[]; distances_m: number[]; length_m: number };
export type ElevationData = Extract<RouteElevationResult, { available: true }>;
type ElevationConfig = { routing?: { csrf_token?: string } };
const words = (ko: string, en: string) => getLocale() === 'en' ? en : ko;

export function routeCoordinates(value: unknown, maxPoints = 100_000): Position[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maxPoints
    || value.some(point => !Array.isArray(point) || point.length !== 2 || !isJejuPoint(point[0], point[1]))) {
    throw new ApiError('invalid_coordinates', 400);
  }
  return value.map(point => [point[0], point[1]]);
}

export function sampleProfile(coordinates: Position[], count = 128): ProfileSamples {
  if (!Number.isInteger(count) || count < 2 || count > 256) throw new Error('Invalid profile sample count');
  const line = routeCoordinates(coordinates);
  const track = createTourTrack([line]);
  const distances_m = Array.from({ length: count }, (_, index) => track.length * index / (count - 1));
  return { coordinates: distances_m.map(distance => track.at(distance).center), distances_m, length_m: track.length };
}

export function summarizeElevation(elevations: (number | null)[]) {
  const values = elevations.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const complete = values.length === elevations.length && values.length > 0;
  let ascent = 0, descent = 0;
  for (let index = 1; index < elevations.length; index++) {
    const previous = elevations[index - 1], current = elevations[index];
    if (previous == null || current == null || !Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const change = current - previous;
    if (change > 0) ascent += change;
    else descent -= change;
  }
  return {
    total: elevations.length, known: values.length,
    min_m: values.length ? Math.min(...values) : null,
    max_m: values.length ? Math.max(...values) : null,
    ascent_m: complete ? ascent : null, descent_m: complete ? descent : null,
  };
}

export function profileChart(elevations: (number | null)[], distances: number[], width = 600, height = 120) {
  const summary = summarizeElevation(elevations);
  const min = summary.min_m ?? 0, span = Math.max(1, (summary.max_m ?? 0) - min);
  const length = Math.max(1, distances.at(-1) ?? 0);
  const points = elevations.map((value, index) => ({
    x: (distances[index] ?? 0) / length * width,
    y: value == null || !Number.isFinite(value) ? null : height - 8 - (value - min) / span * (height - 16),
  }));
  const paths: string[] = [];
  let path = '';
  for (const point of points) {
    if (point.y == null) { if (path) paths.push(path); path = ''; continue; }
    path += `${path ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)} `;
  }
  if (path) paths.push(path);
  return { paths, points };
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 65536;
  if (Number(response.headers.get('content-length')) > limit || !response.body) throw new ApiError('invalid_elevation', 502);
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new ApiError('invalid_elevation', 502);
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}

function elevationResult(value: unknown, count: number): ElevationData {
  const result = value as Partial<ElevationData> | null;
  if (!result || result.available !== true || !Array.isArray(result.elevations_m) || result.elevations_m.length !== count
    || result.elevations_m.some(height => height !== null && (typeof height !== 'number' || !Number.isFinite(height) || height < -500 || height > 9000))
    || !result.source || typeof result.source.name !== 'string' || !result.source.name.trim() || result.source.name.length > 200
    || typeof result.source.url !== 'string' || result.source.url.length > 2048) throw new ApiError('invalid_elevation', 502);
  let url: URL;
  try { url = new URL(result.source.url); } catch { throw new ApiError('invalid_elevation', 502); }
  if (url.protocol !== 'https:' || url.username || url.password
    || [...url.searchParams.keys()].some(key => /key|token|secret|authorization/i.test(key))) throw new ApiError('invalid_elevation', 502);
  return { available: true, elevations_m: [...result.elevations_m], source: { name: result.source.name, url: url.href } };
}

/** This endpoint never invokes the guide. Only one exact auth rejection can retry. */
export async function fetchElevation(
  coordinates: Position[], signal: AbortSignal,
  dependencies: { fetchImpl?: typeof fetch; config?: (refresh: boolean) => Promise<ElevationConfig> } = {},
): Promise<ElevationData> {
  const submitted = routeCoordinates(coordinates, 256);
  const body = JSON.stringify({ coordinates: submitted });
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const readConfig = dependencies.config ?? (async (refresh: boolean) => await getConfig(refresh) as unknown as ElevationConfig);
  const request = dependencies.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    combined.throwIfAborted();
    const config = await withAbort(readConfig(attempt !== 0), combined);
    combined.throwIfAborted();
    const proof = config.routing?.csrf_token;
    if (typeof proof !== 'string' || !proof || proof.length > 4096) throw new ApiError('elevation_unavailable', 503);
    const response = await withAbort(request('/api/elevation', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: combined,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Atlas-CSRF': proof }, body,
    }), combined);
    const data = await boundedJSON(response, combined);
    combined.throwIfAborted();
    if (response.ok) return elevationResult(data, submitted.length);
    const error = data as { code?: unknown; error?: { code?: unknown } } | null;
    const rawCode = error?.code ?? error?.error?.code;
    const code = typeof rawCode === 'string' ? rawCode : 'elevation_unavailable';
    const recoverable = (response.status === 401 && code === 'session_required')
      || (response.status === 403 && code === 'csrf_invalid');
    if (attempt || !recoverable) throw new ApiError(code, response.status);
  }
  throw new ApiError('elevation_unavailable', 503);
}

export class ElevationProfile {
  private root: HTMLElement;
  private onCursor: (point: Position | null) => void;
  private coordinates: Position[] | null = null;
  private samples: ProfileSamples | null = null;
  private data: ElevationData | null = null;
  private controller: AbortController | undefined;
  private state: 'empty' | 'idle' | 'loading' | 'ready' | 'error' = 'empty';
  private cursor = 0;
  private visible = true;
  constructor(root: HTMLElement, onCursor: (point: Position | null) => void) {
    this.root = root; this.onCursor = onCursor;
    root.setAttribute('data-i18n-ignore', '');
    root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-profile]')?.dataset.profile;
      if (action === 'load') void this.load();
      if (action === 'cancel') { this.controller?.abort(); this.controller = undefined; this.state = 'idle'; this.render(); }
    });
    root.addEventListener('input', event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'profile-cursor') return;
      this.cursor = Number(event.target.value);
      this.paintCursor();
    });
    this.render();
  }

  setRoute(coordinates: Position[] | null): void {
    this.controller?.abort();
    this.controller = undefined;
    this.coordinates = coordinates;
    this.samples = null; this.data = null; this.cursor = 0;
    this.state = coordinates ? 'idle' : 'empty';
    this.onCursor(null);
    this.render();
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.onCursor(null);
    else if (this.data) this.paintCursor();
  }
  cancel(): void {
    if (this.state !== 'loading') return;
    this.controller?.abort(); this.controller = undefined;
    this.state = this.coordinates ? 'idle' : 'empty'; this.render();
  }

  private async load(): Promise<void> {
    if (!this.coordinates) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.state = 'loading'; this.render();
    try {
      const samples = sampleProfile(this.coordinates, matchMedia('(max-width: 760px)').matches ? 96 : 128);
      const result = await fetchElevation(samples.coordinates, controller.signal);
      if (this.controller !== controller || controller.signal.aborted) return;
      this.samples = samples; this.data = result; this.cursor = 0; this.state = 'ready';
      this.render(); this.paintCursor();
    } catch {
      if (this.controller !== controller || controller.signal.aborted) return;
      this.state = 'error'; this.render();
    } finally { if (this.controller === controller) this.controller = undefined; }
  }

  render(): void {
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : '';
    this.root.dataset.state = this.state;
    this.root.setAttribute('aria-busy', String(this.state === 'loading'));
    const heading = `<h3>${words('실제 고도 단면', 'Terrain elevation profile')}</h3>`;
    if (this.state === 'empty') this.root.innerHTML = `${heading}<p class="terrain-note">${words('내 여행에서 도보 또는 차량 경로를 계산하면 고도를 확인할 수 있어요.', 'Calculate a walking or driving route in My trip to explore its elevations.')}</p>`;
    else if (this.state === 'loading') this.root.innerHTML = `${heading}<p role="status">${words('실제 DEM 고도를 확인하는 중…', 'Reading real DEM elevations…')}</p><button id="profile-cancel" data-profile="cancel">${words('취소', 'Cancel')}</button>`;
    else if (this.state === 'idle' || this.state === 'error') this.root.innerHTML = `${heading}<p class="terrain-note" ${this.state === 'error' ? 'role="status"' : ''}>${words(this.state === 'error' ? '고도를 불러오지 못했어요. 경로는 그대로 사용할 수 있습니다.' : '경로를 따라 실제 높이를 조회합니다. 지도 고도 배율과는 무관합니다.', this.state === 'error' ? 'Elevations are unavailable. Your route is still usable.' : 'Read actual heights along the route, independent of the map elevation scale.')}</p><button id="profile-load" data-profile="load">${words(this.state === 'error' ? '고도 다시 불러오기' : '고도 단면 보기', this.state === 'error' ? 'Retry elevations' : 'Show elevation profile')}</button>`;
    else if (this.samples && this.data) {
      const values = this.data.elevations_m, summary = summarizeElevation(values);
      const chart = profileChart(values, this.samples.distances_m);
      const height = (value: number | null) => value == null ? words('미확인', 'Unknown') : `${Math.round(value)} m`;
      this.root.innerHTML = `${heading}
        <p id="profile-coverage" class="terrain-note" role="status">${words('고도 확인', 'Heights available')} ${summary.known} / ${summary.total} (${Math.round(summary.known / summary.total * 100)}%)</p>
        <svg id="elevation-chart" viewBox="0 0 600 120" role="img" aria-labelledby="profile-chart-title"><title id="profile-chart-title">${words('경로의 고도 단면. 빈 구간은 높이 미확인입니다.', 'Route elevation profile. Gaps indicate unknown heights.')}</title><path d="M0,119H600" class="profile-axis"/>${chart.paths.map(path => `<path d="${path}" class="profile-line"/>`).join('')}<line id="profile-chart-cursor" y1="0" y2="120" x1="0" x2="0"/></svg>
        <div class="profile-axis-labels"><span>0 m</span><span>${metricDistance(this.samples.length_m)}</span></div>
        <label for="profile-cursor" class="sr-only">${words('단면 위치 선택', 'Choose a position on the profile')}</label><input id="profile-cursor" type="range" min="0" max="${values.length - 1}" step="1" value="${this.cursor}"><output id="profile-position" for="profile-cursor"></output>
        <dl class="profile-stats"><div><dt>${words('최저 / 최고', 'Min / max')}</dt><dd>${height(summary.min_m)} / ${height(summary.max_m)}</dd></div><div><dt>${words('오르막 / 내리막', 'Ascent / descent')}</dt><dd>${height(summary.ascent_m)} / ${height(summary.descent_m)}</dd></div></dl>
        <p class="terrain-note">${words(summary.known === summary.total ? '표본 고도 기준의 추정치입니다. 작은 굴곡은 지형 해상도에 따라 달라집니다.' : '빠진 고도를 연결하거나 0m로 바꾸지 않습니다. 전체 오르막·내리막은 미확인입니다.', summary.known === summary.total ? 'Estimates from sampled elevations. Small changes depend on DEM resolution.' : 'Missing heights are not joined or replaced with zero. Total ascent and descent are unknown.')}</p>
        <a class="profile-source" href="${html(this.data.source.url)}" target="_blank" rel="noopener noreferrer">${html(this.data.source.name)} ↗</a>`;
      this.paintCursor();
    }
    if (focused) (this.root.querySelector<HTMLElement>(`#${CSS.escape(focused)}`)
      ?? this.root.querySelector<HTMLElement>('button,input'))?.focus({ preventScroll: true });
  }

  private paintCursor(): void {
    if (!this.samples || !this.data) return;
    const index = Math.max(0, Math.min(this.data.elevations_m.length - 1, this.cursor));
    const value = this.data.elevations_m[index];
    const label = `${metricDistance(this.samples.distances_m[index])} · ${value == null ? words('높이 미확인', 'Height unknown') : `${Math.round(value)} m`}`;
    const output = this.root.querySelector<HTMLOutputElement>('#profile-position');
    if (output) output.value = label;
    this.root.querySelector('#profile-cursor')?.setAttribute('aria-valuetext', label);
    const cursor = this.root.querySelector('#profile-chart-cursor');
    const x = String(this.samples.distances_m[index] / this.samples.length_m * 600);
    cursor?.setAttribute('x1', x); cursor?.setAttribute('x2', x);
    if (this.visible) this.onCursor(this.samples.coordinates[index]);
  }
  destroy(): void { this.cancel(); this.onCursor(null); }
}
