import type { RouteMode, RouteRequest, RouteResult, RouteSuccess } from '../shared/routing-types';
import type { Locale } from './i18n.ts';
import { getLocale, placeName } from './i18n.ts';
import { html } from './api.ts';
import { requestRoute, RouteClientError } from './route-client.ts';

export type RoutingStop = { lng: number; lat: number; stay_min?: number };
export type RouteState =
  | { status: 'idle' | 'loading' }
  | { status: 'success'; result: RouteSuccess }
  | { status: 'unavailable'; result: Extract<RouteResult, { available: false }> }
  | { status: 'error'; code: string };

const idle = (): Record<RouteMode, RouteState> => ({ walk: { status: 'idle' }, car: { status: 'idle' } });
export class RoutingController {
  private generation = 0;
  private controller: AbortController | null = null;
  private points: RouteRequest['stops'] = [];
  private locale: Locale = 'ko';
  private active: RouteSuccess | null = null;
  private request: (body: RouteRequest, signal: AbortSignal) => Promise<RouteResult>;
  private onChange: () => void;
  private onRoute: (route: RouteSuccess | null) => void;
  mode: RouteMode;
  states: Record<RouteMode, RouteState> = idle();

  constructor(options: {
    mode?: RouteMode; onChange: () => void; onRoute: (route: RouteSuccess | null) => void;
    request?: (body: RouteRequest, signal: AbortSignal) => Promise<RouteResult>;
  }) {
    this.mode = options.mode ?? 'car';
    this.onChange = options.onChange;
    this.onRoute = options.onRoute;
    this.request = options.request ?? ((body, signal) => requestRoute(body, { signal }));
  }
  get route(): RouteSuccess | null { return this.active; }

  private clear(): void {
    this.generation++;
    this.active = null;
    this.onRoute(null);
    this.controller?.abort();
    this.controller = null;
  }
  invalidate(): void {
    this.clear();
    this.points = [];
    this.states = idle();
    this.onChange();
  }
  setInput(stops: readonly RoutingStop[], locale: Locale): void {
    this.clear();
    this.points = stops.map(({ lng, lat }) => ({ lng, lat }));
    this.locale = locale;
    this.states = idle();
    this.start();
  }
  setMode(mode: RouteMode): void {
    if (!['walk', 'car'].includes(mode) || this.mode === mode) return;
    this.clear();
    this.mode = mode;
    this.publish();
    this.start();
  }
  retry(): void {
    this.clear();
    this.states[this.mode] = { status: 'idle' };
    this.start();
  }
  private publish(): void {
    const state = this.states[this.mode];
    this.active = state.status === 'success' ? state.result : null;
    if (this.active) this.onRoute(this.active);
  }
  private start(): void {
    if (this.points.length < 2 || this.points.length > 12) { this.onChange(); return; }
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    for (const mode of ['walk', 'car'] as const) {
      if (!['idle', 'loading'].includes(this.states[mode].status)) continue;
      this.states[mode] = { status: 'loading' };
      const body: RouteRequest = { mode, locale: this.locale, stops: this.points.map(point => ({ ...point })) };
      void this.request(body, controller.signal).then(result => {
        if (controller.signal.aborted || generation !== this.generation) return;
        if (result.mode !== mode) throw new RouteClientError('invalid_response');
        this.states[mode] = result.available ? { status: 'success', result } : { status: 'unavailable', result };
        if (mode === this.mode) this.publish();
        this.onChange();
      }).catch(error => {
        if (controller.signal.aborted || generation !== this.generation) return;
        this.states[mode] = { status: 'error', code: error instanceof RouteClientError ? error.code : 'network' };
        this.onChange();
      });
    }
    this.onChange();
  }
}

export const routingCopy = {
  ko: {
    title: '어떻게 이동할까요?', compare: '이동 수단 비교', walk: '도보', car: '차량', loading: '계산 중',
    idle: '장소 2곳부터 계산', distance: '경로 거리', travel: '예상 이동', stay: '계획 체류', total: '전체 계획 시간',
    unavailable: '경로 없음', failed: '계산 실패', busy: '계산 혼잡', endpoint: '위치 확인', ferry: '배편 필요',
    retry: '다시 계산', steps: '구간별 길 안내', noSteps: '이 구간의 상세 방향 안내는 없어요.',
    gpx: 'GPX 내보내기', fit: '경로 전체 보기', preview: '경로 3D 보기', traffic: '실시간 교통을 반영하지 않은 예상 시간입니다.',
    data: 'OSM 데이터 기준', unknownDate: '기준 날짜 미확인', snap: '요청 위치와 경로 끝점의 직선 차이',
    unknownSnap: '요청 위치와 경로 사이의 직선 차이는 확인되지 않았습니다.', origin: '출발', destination: '도착',
    center: '지도 중심에서 출발', current: '현재 위치에서 출발', locating: '현재 위치 확인 중',
    modeSaved: '이동 수단을 저장했어요.', modeUnsaved: '이동 수단은 이 화면에만 적용됐어요.',
  },
  en: {
    title: 'How will you travel?', compare: 'Compare travel modes', walk: 'Walk', car: 'Drive', loading: 'Calculating',
    idle: 'Add at least 2 stops', distance: 'Route distance', travel: 'Est. travel', stay: 'Planned stays', total: 'Total planned time',
    unavailable: 'No route', failed: 'Calculation failed', busy: 'Busy', endpoint: 'Check point', ferry: 'Ferry required',
    retry: 'Try again', steps: 'Directions by leg', noSteps: 'Detailed directions are unavailable for this leg.',
    gpx: 'Export GPX', fit: 'Show whole route', preview: 'Preview route in 3D', traffic: 'Estimated times do not include current traffic.',
    data: 'OSM data date', unknownDate: 'Data date unconfirmed', snap: 'Straight-line gaps from requested points to the route',
    unknownSnap: 'Gaps from the requested points to the route are unconfirmed.', origin: 'Start', destination: 'Finish',
    center: 'Start at map center', current: 'Start at my location', locating: 'Locating your position',
    modeSaved: 'Travel mode saved.', modeUnsaved: 'Travel mode applies only to this screen.',
  },
} as const;

export function routeMessage(code: string, locale: Locale = getLocale()): string {
  const ko: Record<string, string> = {
    no_route: '연결되는 경로를 찾지 못했어요. 출발·도착 위치를 바꿔 보세요.',
    endpoint_unreachable: '200m 안에서 연결되는 길을 찾지 못했어요. 장소의 중심점은 입구가 아닐 수 있으니 입구나 주차장을 지도에서 선택해 주세요.',
    ferry_required: '배편이 필요한 구간은 도보·차량 경로로 제공하지 않아요.',
    routing_unavailable: '지금은 경로 서비스를 이용할 수 없어요. 잠시 후 다시 계산해 주세요.',
    timeout: '경로 계산이 지연되고 있어요. 다시 계산해 주세요.',
    rate_limited: '경로 요청이 많아요. 잠시 후 다시 시도해 주세요.',
    routing_rate_limited: '경로 요청이 많아요. 잠시 후 다시 시도해 주세요.',
    routing_busy: '경로 엔진이 다른 요청을 계산 중이에요. 잠시 후 다시 계산해 주세요.',
    session_required: '접속 정보를 확인하지 못했어요. 페이지를 새로고침해 주세요.',
    csrf_invalid: '접속 정보를 확인하지 못했어요. 페이지를 새로고침해 주세요.',
    invalid_request: '제주 안의 출발·도착 위치를 2~12곳 선택해 주세요.',
  };
  const en: Record<string, string> = {
    no_route: 'No connected route was found. Try different start or finish points.',
    endpoint_unreachable: 'No path connects within 200 m. A place center may not be its entrance; choose an entrance or parking area on the map.',
    ferry_required: 'A ferry is required. This is not offered as a walking or driving route.',
    routing_unavailable: 'Routing is unavailable right now. Please try again shortly.',
    timeout: 'The route calculation timed out. Please try again.',
    rate_limited: 'There are too many route requests. Please try again shortly.',
    routing_rate_limited: 'There are too many route requests. Please try again shortly.',
    routing_busy: 'The routing engine is busy with other requests. Please try again shortly.',
    session_required: 'Your session could not be verified. Please reload the page.',
    csrf_invalid: 'Your session could not be verified. Please reload the page.',
    invalid_request: 'Choose between 2 and 12 start, via or finish points within Jeju.',
  };
  return (locale === 'en' ? en : ko)[code] ?? (locale === 'en'
    ? 'The route could not be verified. Please try again.' : '경로를 확인하지 못했어요. 다시 계산해 주세요.');
}
export function routeDuration(seconds: number, locale: Locale = getLocale()): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds > 0 && seconds < 60) return locale === 'en' ? '<1 min' : '1분 미만';
  const minutes = Math.ceil(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return locale === 'en' ? (hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`)
    : (hours ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${rest}분`);
}
export function routeDistance(meters: number, locale: Locale = getLocale()): string {
  if (!Number.isFinite(meters) || meters < 0) return '—';
  return meters < 1000 ? `${Math.round(meters)} m` : `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(meters / 1000)} km`;
}
export function routePlanSeconds(route: RouteSuccess, stops: readonly RoutingStop[]): number {
  return route.duration_s + stops.reduce((sum, stop) => sum + (stop.stay_min ?? 0) * 60, 0);
}
export function routeGPX(route: RouteSuccess, name = 'Jeju Atlas', locale: Locale = getLocale()): string {
  const copy = routingCopy[locale];
  const description = `${copy[route.mode]}. ${copy.traffic} ${route.source.attribution}. ${copy.data}: ${route.source.data_updated_at ?? copy.unknownDate}`;
  const xml = (value: string) => html(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Jeju Atlas" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xml(name)}</name><desc>${xml(description)}</desc><link href="${xml(route.source.url)}"><text>${xml(route.source.attribution)}</text></link></metadata>
<trk><name>${xml(name)}</name><type>${route.mode === 'walk' ? 'walking' : 'driving'}</type><trkseg>
${route.coordinates.map(([lng, lat]) => `<trkpt lat="${lat}" lon="${lng}"></trkpt>`).join('\n')}
</trkseg></trk></gpx>`;
}

export function routingMarkup(controller: RoutingController, stops: readonly (RoutingStop & { name: string; name_en?: string | null })[], locale: Locale): string {
  const copy = routingCopy[locale];
  const selected = controller.states[controller.mode];
  const route = controller.route;
  const stateLabel = (state: RouteState) => {
    if (state.status === 'loading') return copy.loading;
    if (state.status === 'idle') return copy.idle;
    if (state.status === 'success') return routeDuration(state.result.duration_s, locale);
    if (state.status === 'error') return ['routing_busy', 'routing_rate_limited', 'rate_limited'].includes(state.code) ? copy.busy : copy.failed;
    if (state.status === 'unavailable') return state.result.code === 'no_route' ? copy.unavailable
      : state.result.code === 'endpoint_unreachable' ? copy.endpoint
        : state.result.code === 'ferry_required' ? copy.ferry : copy.failed;
    return copy.idle;
  };
  const modes = (['walk', 'car'] as const).map(mode => {
    const state = controller.states[mode];
    return `<label class="route-mode${controller.mode === mode ? ' is-selected' : ''}">
      <input id="trip-route-${mode}" type="radio" name="trip-route-mode" value="${mode}" ${controller.mode === mode ? 'checked' : ''}>
      <span class="route-mode-name">${copy[mode]}</span>
      <strong>${state.status === 'success' ? routeDistance(state.result.distance_m, locale) : '—'}</strong>
      <span class="route-mode-time" data-route-state="${state.status}">${stateLabel(state)}</span>
    </label>`;
  }).join('');
  const error = selected.status === 'error' ? selected.code : selected.status === 'unavailable' ? selected.result.code : null;
  const stay = stops.reduce((sum, stop) => sum + (stop.stay_min ?? 0) * 60, 0);
  return `<section class="trip-routing" data-i18n-ignore aria-labelledby="trip-routing-title">
    <h3 id="trip-routing-title">${copy.title}</h3>
    <div class="route-comparison" role="radiogroup" aria-label="${copy.compare}">${modes}</div>
    <div class="route-feedback" role="status" aria-live="polite">${error ? html(routeMessage(error, locale))
      : selected.status === 'loading' || (!route && stops.length >= 2 && selected.status === 'idle') ? copy.loading : !route ? copy.idle : ''}</div>
    ${error ? `<button class="route-retry" data-action="route-retry">${copy.retry}</button>` : ''}
    <dl class="route-plan-summary">
      <div><dt>${copy.travel}</dt><dd>${route ? routeDuration(route.duration_s, locale) : '—'}</dd></div>
      <div><dt>${copy.stay}</dt><dd>${routeDuration(stay, locale)}</dd></div>
      <div class="route-plan-total"><dt>${copy.total}</dt><dd>${route ? routeDuration(routePlanSeconds(route, stops), locale) : '—'}</dd></div>
    </dl>
    ${route ? `<div class="route-actions"><button data-action="route-fit">${copy.fit}</button><button data-action="route-preview">${copy.preview}</button><button data-action="route-gpx">${copy.gpx}</button></div>
      <p class="route-source">${html(copy.traffic)}<br><a href="${html(route.source.url)}" target="_blank" rel="noopener noreferrer">${html(route.source.attribution)}</a><br>${copy.data}: ${html(route.source.data_updated_at ?? copy.unknownDate)}</p>
      <p class="route-snap">${route.snapped.length === stops.length && route.snapped.every(point => Number.isFinite(point.distance_m))
        ? `${copy.snap}: ${route.snapped.map((point, index) => `${index + 1} · ${routeDistance(point.distance_m, locale)}`).join(' / ')}`
        : copy.unknownSnap}</p>
      ${route.warnings.length ? `<ul class="route-warnings">${route.warnings.map(warning => `<li>${html(warning)}</li>`).join('')}</ul>` : ''}
      <h4>${copy.steps}</h4><ol class="route-legs">${route.legs.map((leg, index) => `<li><details data-route-leg="${index}">
        <summary><span>${index + 1} → ${index + 2} · ${html(stops[index] ? placeName(stops[index]) : '')} → ${html(stops[index + 1] ? placeName(stops[index + 1]) : '')}</span><strong>${routeDistance(leg.distance_m, locale)} · ${routeDuration(leg.duration_s, locale)}</strong></summary>
        ${leg.steps.length ? `<ol>${leg.steps.map(step => `<li><span>${html(step.instruction)}</span><small>${routeDistance(step.distance_m, locale)} · ${routeDuration(step.duration_s, locale)}</small></li>`).join('')}</ol>` : `<p>${copy.noSteps}</p>`}
      </details></li>`).join('')}</ol>` : ''}
  </section>`;
}
