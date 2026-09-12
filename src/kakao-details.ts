import type { KakaoLookup, KakaoPlace } from '../shared/kakao-types.ts';
import { dateLabel, getConfig, html, withAbort } from './api.ts';
import { t } from './i18n.ts';

type View = {
  id: string;
  name: string;
  state: 'hidden' | 'loading' | 'ready' | 'unavailable';
  result: KakaoLookup | null;
};
const MAX_BYTES = 32_768;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number, required = false): value is string =>
  typeof value === 'string' && value.length <= limit && (!required || Boolean(value.trim()))
  && !/[\u0000-\u001f\u007f]|\p{Surrogate}/u.test(value);
const nullableText = (value: unknown, limit: number): value is string | null =>
  value === null || text(value, limit);
const invalid = () => new Error('Kakao information unavailable');
const copy = (value: string) => html(t(value));
const reasonMessages: Record<NonNullable<KakaoLookup['reason']>, string> = {
  no_results: '이 이름과 위치로는 카카오 검색 결과가 없어요. 다른 이름으로 등록되어 있을 수 있어요.',
  name_mismatch: '등록된 이름이나 지점명이 달라 자동 연결을 확정하지 못했어요.',
  category_mismatch: '등록된 장소 분류가 달라 자동 연결을 확정하지 못했어요.',
  distance_mismatch: '등록된 위치가 달라 자동 연결을 확정하지 못했어요.',
  multiple_candidates: '같은 이름의 장소가 여러 곳 있어 한 곳으로 연결하지 못했어요.',
  incomplete_results: '검색 결과가 많거나 일부만 확인되어 자동 연결을 확정하지 못했어요.',
};

function timestamp(value: unknown): value is string {
  if (!text(value, 40) || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number.isFinite(Date.parse(value));
}

function lookupResult(value: unknown, id: string): KakaoLookup {
  if (!object(value) || value.available !== true || value.canonical_id !== id
    || value.source !== 'Kakao Local' || !timestamp(value.queried_at)) throw invalid();
  const status = value.status;
  if (status !== 'matched' && status !== 'not_found' && status !== 'ambiguous' && status !== 'unsupported') throw invalid();
  let reason: KakaoLookup['reason'];
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || !Object.hasOwn(reasonMessages, value.reason)) throw invalid();
    reason = value.reason as NonNullable<KakaoLookup['reason']>;
  }
  let place: KakaoPlace | null = null;
  if (status === 'matched') {
    const item = value.place;
    if (!object(item) || typeof item.id !== 'string' || !/^[1-9]\d{0,29}$/.test(item.id)
      || !text(item.name, 500, true) || !text(item.category, 500)
      || !nullableText(item.address, 1000) || !nullableText(item.road_address, 1000)
      || !nullableText(item.phone, 200) || item.url !== `https://place.map.kakao.com/${item.id}`) throw invalid();
    place = {
      id: item.id, name: item.name.trim(), category: item.category.trim(),
      address: item.address?.trim() || null, road_address: item.road_address?.trim() || null,
      phone: item.phone?.trim() || null, url: item.url as string,
    };
  } else if (value.place !== null) throw invalid();
  let match: KakaoLookup['match'];
  if (value.match !== undefined) {
    const item = value.match;
    if (!object(item) || item.method !== 'name_category_distance' || typeof item.distance_m !== 'number'
      || !Number.isFinite(item.distance_m) || item.distance_m < 0 || item.distance_m > 100_000) throw invalid();
    match = { method: item.method, distance_m: item.distance_m };
  }
  // Keep only validated fields, and only for the current open detail.
  return { available: true, status, canonical_id: id, queried_at: value.queried_at, source: 'Kakao Local', place, ...(reason ? { reason } : {}), ...(match ? { match } : {}) };
}

async function responseJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw invalid();
  const body = await withAbort(response.text(), signal);
  if (new TextEncoder().encode(body).length > MAX_BYTES) throw invalid();
  return JSON.parse(body);
}

function phoneLink(value: string): string {
  const candidate = value.match(/\+?\d[\d().\s-]{5,30}\d/)?.[0].replace(/[^\d+]/g, '');
  return candidate && /^\+?\d{7,15}$/.test(candidate)
    ? `<a href="tel:${candidate}" data-kakao-focus="phone">${html(value)}</a>` : html(value);
}

/** One view's supplementary information; the mount may be replaced during a request. */
export class KakaoDetails {
  private root: () => HTMLElement | null;
  private view: View | null = null;
  private controller: AbortController | undefined;

  constructor(root: () => HTMLElement | null) {
    this.root = root;
  }

  show(place: { id: string; name: string }): void {
    if (!text(place.id, 200, true) || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(place.id)
      || !text(place.name, 500, true)) {
      this.clear();
      return;
    }
    if (this.view?.id === place.id) {
      this.view.name = place.name;
      this.render();
      return;
    }
    this.clear();
    this.view = { id: place.id, name: place.name, state: 'hidden', result: null };
    void this.load();
  }

  clear(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.view = null;
    this.render();
  }

  retry(): void {
    if (this.view?.state === 'unavailable') void this.load(true);
  }

  private async load(refresh = false): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(new DOMException('Kakao request timeout', 'TimeoutError')), 20_000);
    view.result = null;
    if (view.state !== 'hidden') view.state = 'loading';
    this.render();
    try {
      // Config is shared with other features: cancel this waiter, not their request.
      let config: unknown = await withAbort(getConfig(refresh), signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        const kakao = object(config) && object(config.kakao) ? config.kakao : null;
        if (kakao?.enabled !== true) {
          view.state = 'hidden';
          return;
        }
        view.state = 'loading';
        this.render();
        const proof = kakao.csrf_token;
        if (typeof proof !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(proof)) throw invalid();
        const response = await withAbort(fetch(`/api/kakao/place?id=${encodeURIComponent(view.id)}`, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json', 'X-Atlas-CSRF': proof }, signal,
        }), signal);
        signal.throwIfAborted();
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          if (attempt === 0 && (response.status === 401 || response.status === 403)) {
            config = await withAbort(getConfig(true), signal);
            continue;
          }
          throw invalid();
        }
        const data = await responseJSON(response, signal);
        signal.throwIfAborted();
        view.result = lookupResult(data, view.id);
        view.state = 'ready';
        return;
      }
    } catch {
      if (this.view === view && this.controller === controller) view.state = 'unavailable';
    } finally {
      clearTimeout(timeout);
      if (this.view === view && this.controller === controller) {
        this.controller = undefined;
        this.render();
      }
    }
  }

  private resultHTML(view: View, result: KakaoLookup): string {
    const place = result.place;
    let content: string;
    if (place) {
      const address = place.road_address || place.address;
      content = `<h4 class="kakao-details-name">${html(place.name)}</h4>
        ${place.category ? `<p class="kakao-details-category">${html(place.category)}</p>` : ''}
        ${address || place.phone ? `<dl class="kakao-details-contacts">
          ${address ? `<div><dt>${copy('주소')}</dt><dd>${html(address)}</dd></div>` : ''}
          ${place.phone ? `<div><dt>${copy('전화')}</dt><dd>${phoneLink(place.phone)}</dd></div>` : ''}
        </dl>` : ''}
        <p class="kakao-details-note">${copy('카카오 등록 정보로, 별도 검토되지 않았습니다.')}</p>
        <p class="kakao-details-note">${copy('추가 방문 정보는 카카오맵에서 확인해 주세요.')}</p>
        <a class="kakao-details-action" data-kakao-focus="place" href="${html(place.url)}" target="_blank" rel="noopener noreferrer">${copy('카카오맵에서 자세히 보기')} <span aria-hidden="true">↗</span></a>`;
    } else {
      const message = result.status === 'unsupported' ? '이 장소는 카카오 방문 정보를 제공하기 어려워요.'
        : result.reason ? reasonMessages[result.reason] : '자동 연결을 확정하지 못했어요.';
      const search = result.status === 'not_found' || result.status === 'ambiguous';
      const query = encodeURIComponent(`제주 ${view.name}`);
      content = `<p class="kakao-details-message">${copy(message)}</p>
        ${search ? `<a class="kakao-details-action" data-kakao-focus="search" href="https://map.kakao.com/link/search/${html(query)}" target="_blank" rel="noopener noreferrer">${copy('카카오맵에서 장소 찾기')} <span aria-hidden="true">↗</span></a>
          <p class="kakao-details-note">${copy('장소 이름으로 검색합니다. 같은 장소인지 확인해 주세요.')}</p>` : ''}`;
    }
    return `${content}<p class="kakao-details-time">${copy('조회 시각')} <time datetime="${html(result.queried_at)}">${html(dateLabel(result.queried_at, true))} KST</time></p>`;
  }

  private render(): void {
    const root = this.root();
    if (!root) return;
    const active = root.ownerDocument.activeElement;
    const focusInside = Boolean(active && root.contains(active));
    const focusKey = focusInside ? active?.getAttribute('data-kakao-focus') : null;
    const view = this.view;
    root.hidden = !view || view.state === 'hidden';
    root.setAttribute('aria-busy', String(view?.state === 'loading'));
    if (root.hidden || !view) {
      root.innerHTML = '';
      if (focusInside) root.closest('.catalog-detail')?.querySelector<HTMLElement>('.detail-heading h2')?.focus({ preventScroll: true });
      return;
    }
    const content = view.state === 'ready' && view.result ? this.resultHTML(view, view.result)
      : view.state === 'loading' ? `<p class="kakao-details-message" role="status">${copy('카카오 방문 정보를 불러오는 중…')}</p>`
        : `<p class="kakao-details-message" role="status">${copy('카카오 방문 정보를 불러오지 못했어요. 기본 장소 정보는 계속 볼 수 있어요.')}</p>
          <button type="button" class="kakao-details-action" data-detail-action="kakao-retry" data-kakao-focus="retry" aria-label="${copy('카카오 정보 다시 시도')}">${copy('다시 시도')}</button>`;
    root.innerHTML = `<div class="kakao-details-heading"><h3 id="kakao-details-title">${copy('카카오 방문 정보')}</h3><span lang="en">Kakao Local</span></div>${content}`;
    if (focusInside) {
      const target = [...root.querySelectorAll<HTMLElement>('[data-kakao-focus]')].find(node => node.dataset.kakaoFocus === focusKey);
      (target ?? root).focus({ preventScroll: true });
    }
  }
}
