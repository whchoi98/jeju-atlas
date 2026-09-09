import type { GuideMap, GuidePlaceInfo } from '../shared/api-types';
import { ApiError, dateLabel, getConfig, html, isJejuPoint, publicMessage, safeURL, sourceName, withAbort } from './api';
import { buildGuideMessage } from './guide-context';
import { facilityText, hasFacilityRecord, hoursText } from './guide-facts';
import { splitGuideFrames } from './guide-stream';
import { icon } from './icons';
import './guide.css';

type ChatMessage = { role: 'user' | 'assistant'; text: string; state?: 'writing' | 'done' | 'interrupted' };

export function validateGuideMap(value: unknown): GuideMap | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<GuideMap>;
  if (!Array.isArray(raw.markers)) return null;
  const markers = raw.markers.filter((point) =>
    point && typeof point.id === 'string' && point.id.length <= 240 && typeof point.name === 'string'
    && point.name.length <= 160 && isJejuPoint(point.lng, point.lat)).slice(0, 40).map((point) => ({
    id: point.id, name: point.name, lng: point.lng, lat: point.lat,
    category: typeof point.category === 'string' ? point.category.slice(0, 80) : 'other',
    summary: typeof point.summary === 'string' ? point.summary.slice(0, 1000) : '',
    source: typeof point.source === 'string' ? point.source.slice(0, 160) : null,
    observed_at: typeof point.observed_at === 'string' ? point.observed_at.slice(0, 60) : null,
  }));
  const center = raw.center && isJejuPoint(raw.center.lng, raw.center.lat) ? { lng: raw.center.lng, lat: raw.center.lat } : null;
  const ids = new Set(markers.map((marker) => marker.id));
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
  const placeInfo = Array.isArray(raw.place_info) ? raw.place_info.filter((place) => place && ids.has(place.id)
    && typeof place.name === 'string').slice(0, 12).map((place): GuidePlaceInfo => ({
    id: place.id, name: place.name.slice(0, 160),
    facilities: place.facilities && typeof place.facilities === 'object' && !Array.isArray(place.facilities)
      ? Object.fromEntries(Object.entries(place.facilities).filter(([, value]) => typeof value === 'string')
        .slice(0, 8).map(([key, value]) => [key.slice(0, 60), value.slice(0, 400)])) : {},
    hours_week: Array.isArray(place.hours_week) ? place.hours_week.filter((hour) => hour
      && Number.isInteger(hour.day) && hour.day >= 0 && hour.day <= 6 && time.test(hour.open) && time.test(hour.close)).slice(0, 14) : [],
    hours_source: typeof place.hours_source === 'string' ? place.hours_source.slice(0, 160) : null,
    enriched_at: typeof place.enriched_at === 'string' ? place.enriched_at.slice(0, 60) : null,
    base_note: typeof place.base_note === 'string' ? place.base_note.slice(0, 500) : null,
    business_status: typeof place.business_status === 'string' ? place.business_status.slice(0, 80) : null,
    sources: Array.isArray(place.sources) ? place.sources.filter((source) => source && typeof source.source === 'string').slice(0, 8)
      .map((source) => ({
        source: source.source.slice(0, 160), url: safeURL(source.url),
        observed_at: typeof source.observed_at === 'string' ? source.observed_at.slice(0, 60) : null,
        license: typeof source.license === 'string' ? source.license.slice(0, 60) : null,
      })) : [],
  })) : [];
  return {
    answer: typeof raw.answer === 'string' ? raw.answer.slice(0, 15000) : '',
    center, zoom: typeof raw.zoom === 'number' && Number.isFinite(raw.zoom) ? Math.max(8, Math.min(17, raw.zoom)) : 11,
    markers, place_info: placeInfo, route: Array.isArray(raw.route) ? raw.route.filter((p) => p && isJejuPoint(p.lng, p.lat)).slice(0, 512) : [],
    route_meta: raw.route_meta && typeof raw.route_meta.provider === 'string' && ['car', 'walk', 'transit', 'straight'].includes(raw.route_meta.mode)
      ? raw.route_meta : null,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((value) => typeof value === 'string').map((value) => value.slice(0, 300)).slice(0, 8) : [],
  };
}

export class GuidePanel {
  private controller: AbortController | undefined;
  private conversationId: string | undefined;
  private messages: ChatMessage[] = [];
  private recommendation: GuideMap | null = null;
  private root: HTMLElement;
  private running = false;
  private dailyLimit = 30;
  private onApply: (map: GuideMap) => void;
  private notify: (message: string) => void;
  private context: () => string;
  private onSelect: ((id: string) => void) | undefined;

  constructor(root: HTMLElement, options: {
    onApply: (map: GuideMap) => void; notify: (message: string) => void; context: () => string;
    onSelect?: (id: string) => void;
  }) {
    this.root = root;
    this.onApply = options.onApply;
    this.notify = options.notify;
    this.context = options.context;
    this.onSelect = options.onSelect;
    root.innerHTML = `
      <div class="panel-intro"><span class="eyebrow">A LOCAL PERSPECTIVE</span><h2>어떤 제주를 찾으세요?</h2><p>지역을 지정하지 않으면 제주 전체에서 찾아요.</p></div>
      <div class="guide-quick-prompts"><button data-prompt="제주 동쪽에서 자연을 즐기는 반나절 코스를 추천해 주세요.">동쪽 반나절</button><button data-prompt="제주에서 비 오는 날 둘러보기 좋은 실내 장소를 알려 주세요.">비 오는 날</button><button data-prompt="아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.">아이와 함께</button></div>
      <div id="guide-messages" class="guide-messages" role="log" aria-label="AI 가이드 대화" aria-live="polite"></div>
      <div id="guide-recommendation" class="guide-recommendation" hidden></div>
      <p id="guide-status" class="guide-status" role="status">질문을 보내면 가이드가 시작됩니다.</p>
      <form id="guide-form" class="guide-form"><label class="sr-only" for="guide-input">AI 가이드에게 질문</label><textarea id="guide-input" rows="3" maxlength="2000" placeholder="가고 싶은 곳, 여행 취향을 알려 주세요."></textarea><div><span id="guide-limit">하루 최대 30회 · AI 답변은 출처를 함께 확인하세요.</span><button type="button" id="guide-cancel" hidden>기다리기 중지</button><button type="submit" id="guide-send" aria-label="가이드 질문 보내기">${icon('arrow')}</button></div></form>
    `;
    root.querySelector<HTMLFormElement>('#guide-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = root.querySelector<HTMLTextAreaElement>('#guide-input')!;
      const message = input.value.trim();
      if (!message || this.running) return;
      input.value = '';
      void this.send(message);
    });
    root.querySelector('#guide-cancel')!.addEventListener('click', () => this.cancel());
    root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((button) => {
      button.addEventListener('click', () => { if (!this.running) void this.send(button.dataset.prompt!); });
    });
    root.querySelector<HTMLTextAreaElement>('#guide-input')!.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        root.querySelector<HTMLFormElement>('#guide-form')!.requestSubmit();
      }
    });
    void getConfig().then((config) => {
      this.dailyLimit = config.guide.daily_limit;
      root.querySelector('#guide-limit')!.textContent = `하루 최대 ${this.dailyLimit}회 · AI 답변은 출처를 함께 확인하세요.`;
      if (!config.features.guide) this.status('AI 가이드를 현재 사용할 수 없어요. 잠시 후 다시 시도해 주세요.');
    }).catch(() => this.status('가이드 연결은 질문을 보낼 때 다시 확인합니다.'));
  }

  private status(message: string): void {
    this.root.querySelector('#guide-status')!.textContent = message;
  }

  private renderMessages(): void {
    const log = this.root.querySelector<HTMLElement>('#guide-messages')!;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    log.innerHTML = this.messages.map((message) => `<article class="chat-message chat-message--${message.role}"><span>${message.role === 'user' ? '나' : '제주 가이드'}</span><p>${html(message.text || '제주 정보를 확인하고 있어요…')}</p>${message.state === 'interrupted' ? '<small>답변이 중단되었습니다.</small>' : ''}</article>`).join('');
    if (nearBottom || this.running) log.scrollTop = log.scrollHeight;
  }

  private setRunning(value: boolean): void {
    this.running = value;
    this.root.querySelector<HTMLButtonElement>('#guide-send')!.disabled = value;
    this.root.querySelector<HTMLElement>('#guide-cancel')!.hidden = !value;
    this.root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach((button) => { button.disabled = value; });
    this.root.querySelector('#guide-messages')!.setAttribute('aria-busy', String(value));
  }

  cancel(): void {
    if (!this.running) return;
    this.controller?.abort();
    this.status('기다리기를 중지했어요. 이미 시작한 요청은 일일 횟수에 포함될 수 있어요.');
  }

  private errorMessage(code: string, status = 0): string {
    const normalized = code.toLowerCase();
    if (/concurr|busy/.test(normalized)) return '다른 요청을 처리하고 있어요. 잠시 후 다시 질문해 주세요.';
    if (/hourly/.test(normalized)) return '한 시간 이용 한도에 도달했어요. 잠시 후 다시 질문해 주세요.';
    if (/daily|quota/.test(normalized)) return `오늘의 이용 한도에 도달했어요. 하루 최대 ${this.dailyLimit}회까지 이용할 수 있어요.`;
    if (status === 429 || /limit/.test(normalized)) return '요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 질문해 주세요.';
    if (/timeout/.test(normalized)) return '답변 시간이 길어 연결을 마쳤어요. 질문을 조금 줄여 다시 보내 주세요.';
    if (status === 401 || status === 403 || /session|conversation/.test(normalized)) return '대화 연결을 새로 시작해 주세요. 다음 질문부터 새 대화로 이어집니다.';
    return '가이드에 연결하지 못했어요. 잠시 후 다시 질문해 주세요.';
  }

  private renderRecommendation(): void {
    const panel = this.root.querySelector<HTMLElement>('#guide-recommendation')!;
    const recommendation = this.recommendation;
    panel.hidden = !recommendation || !recommendation.markers.length;
    if (!recommendation) return;
    panel.innerHTML = `<strong>지도에 펼칠 추천 ${recommendation.markers.length}곳</strong><p>${recommendation.markers.slice(0, 4).map((marker) => html(marker.name)).join(' · ')}</p><button id="guide-apply-map" class="button button--primary">추천 장소 지도에 표시 ${icon('arrow')}</button>${this.renderPlaceInfo(recommendation.place_info ?? [])}<p class="micro-note">${[...new Set(recommendation.markers.map((marker) => sourceName(marker.source)))].map(html).join(' · ')}</p>${recommendation.warnings.map((warning) => `<p class="micro-note">${html(warning)}</p>`).join('')}`;
    panel.querySelector('#guide-apply-map')?.addEventListener('click', () => {
      this.onApply(recommendation);
      this.notify('추천 장소를 지도에 표시했어요.');
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-guide-place]').forEach((button) => {
      button.addEventListener('click', () => this.onSelect?.(button.dataset.guidePlace!));
    });
    panel.scrollTop = 0;
  }

  private renderPlaceInfo(places: GuidePlaceInfo[]): string {
    if (!places.length) return '';
    const labels: Record<string, string> = {
      parking: '주차', stroller: '유모차', wheelchair: '접근성 관련 표기', baby_stroller: '유모차',
      toilets: '화장실', restroom: '화장실', pets: '반려동물', baby_room: '수유실',
      kid_friendly: '어린이 관련 표기', wifi: '와이파이', card: '카드 결제', credit_card: '카드 결제',
      pet: '반려동물', outdoor_seating: '야외 좌석', reservation: '예약',
    };
    return `<section class="guide-place-info" aria-label="추천 장소 편의 정보"><h3>카탈로그 편의 정보</h3><p>등록된 자료 기준이며, 빈 항목은 미확인입니다.</p>${places.map((place, index) => {
      const facilities = Object.entries(place.facilities);
      const recorded = facilities.filter(([, value]) => hasFacilityRecord(value)).length;
      const sources = [...new Set(place.sources.map((source) =>
        `${sourceName(source.source)}${source.observed_at ? ` (${dateLabel(source.observed_at)})` : ''}`))];
      return `<details class="guide-place-facts"${index === 0 ? ' open' : ''}><summary><span>${html(place.name)}</span><small>${recorded ? `편의 ${recorded}항목 기록` : '편의 정보 미확인'}${place.hours_week.length ? ' · 이용시간 자료 있음' : ''}</small></summary><div>${facilities.length ? `<dl>${facilities.map(([key, value]) => `<dt>${html(labels[key] ?? key)}</dt><dd>${html(facilityText(value))}</dd>`).join('')}</dl>` : '<p>주차·화장실·유모차 이용 정보는 카탈로그에서 확인되지 않았습니다.</p>'}<p>${html(hoursText(place.hours_week, place.hours_source))}${place.hours_week.length ? ` · 출처 ${html(sourceName(place.hours_source))}` : ''}</p>${sources.length ? `<p>보강 자료 출처: ${sources.map(html).join(' · ')}</p>` : ''}${place.enriched_at ? `<p>보강일: ${html(dateLabel(place.enriched_at))}</p>` : ''}${place.base_note ? `<p>${html(place.base_note)}</p>` : ''}${this.onSelect ? `<button data-guide-place="${html(place.id)}">${icon('pin')}장소 상세 보기 ${icon('chevron')}</button>` : ''}</div></details>`;
    }).join('')}</section>`;
  }

  async send(message: string): Promise<void> {
    if (this.running || !message.trim()) return;
    message = message.trim().slice(0, 1800);
    this.setRunning(true);
    this.messages = [...this.messages.slice(-18), { role: 'user', text: message }];
    const answer: ChatMessage = { role: 'assistant', text: '', state: 'writing' };
    this.messages.push(answer);
    this.recommendation = null;
    this.renderRecommendation();
    this.renderMessages();
    this.status('가이드와 연결하고 있어요.');
    const controller = new AbortController();
    this.controller = controller;
    let finished = false;
    let serverError = false;
    const timer = setTimeout(() => controller.abort(new DOMException('Guide timeout', 'TimeoutError')), 100000);
    try {
      const config = await withAbort(getConfig(), controller.signal);
      if (!config.features.guide) throw new ApiError('unavailable', 503);
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetch('/api/guide', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: buildGuideMessage(message, this.context()), ...(this.conversationId ? { conversation_id: this.conversationId } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(String(body.code ?? body.error?.code ?? 'unavailable'), response.status);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ApiError('invalid_stream', 502);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const dispatch = (block: string) => {
        const lines = block.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(data); } catch { throw new ApiError('invalid_stream', 502); }
        if (event === 'session' && typeof value.conversation_id === 'string' && value.conversation_id.length < 2000) this.conversationId = value.conversation_id;
        if (event === 'status') this.status(publicMessage(value.message, '제주 정보를 확인하고 있어요.'));
        if (event === 'text' && typeof value.delta === 'string') {
          answer.text = `${answer.text}${value.delta}`.slice(0, 30000);
          this.renderMessages();
        }
        if (event === 'map') {
          this.recommendation = validateGuideMap(value);
          this.renderRecommendation();
        }
        if (event === 'done') {
          finished = true;
          // The server also terminates failed streams with a done frame.
          // Preserve the preceding error instead of reporting a completed answer.
          if (serverError) return;
          if (!answer.text && this.recommendation?.answer) answer.text = this.recommendation.answer;
          if (!answer.text) answer.text = '표시할 답변이 없어요. 원하는 지역이나 활동을 더 구체적으로 알려 주세요.';
          answer.state = 'done';
          this.status('답변을 받았어요. 장소별 출처와 이용 정보를 확인해 주세요.');
        }
        if (event === 'error') {
          serverError = true;
          const code = String(value.code ?? 'unavailable');
          if (/session|conversation/i.test(code)) this.conversationId = undefined;
          this.status(this.errorMessage(code));
          answer.state = 'interrupted';
          if (!answer.text) answer.text = '완성된 답변을 받지 못했어요.';
          this.recommendation = null;
          this.renderRecommendation();
        }
      };
      while (!finished && !serverError) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = splitGuideFrames(buffer);
        if (!parsed) throw new ApiError('invalid_stream', 502);
        buffer = parsed.rest;
        for (const block of parsed.frames) dispatch(block);
      }
      if (finished || serverError) await reader.cancel().catch(() => {});
      if (!finished && !serverError) throw new ApiError('interrupted', 502);
    } catch (error) {
      answer.state = 'interrupted';
      if (controller.signal.aborted && controller.signal.reason?.name === 'AbortError') {
        this.status('기다리기를 중지했어요. 이미 시작한 요청은 일일 횟수에 포함될 수 있어요.');
      } else {
        const code = error instanceof ApiError ? error.code : controller.signal.aborted ? 'timeout' : 'unavailable';
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 401 || status === 403) this.conversationId = undefined;
        this.status(this.errorMessage(code, status));
      }
      if (!answer.text) answer.text = '완성된 답변을 받지 못했어요.';
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
      // The facts panel reduces the log's height after the final text token.
      // Keep following the current answer through that last layout change.
      this.renderMessages();
      this.setRunning(false);
    }
  }
}
