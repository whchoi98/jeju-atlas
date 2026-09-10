import type { AppConfig, GuideMap, GuidePlaceInfo } from '../shared/api-types';
import { ApiError, dateLabel, getConfig, html, isJejuPoint, publicMessage, safeURL, sourceName, withAbort } from './api';
import { facilityText, hasFacilityRecord, hoursText } from './guide-facts';
import { splitGuideFrames } from './guide-stream';
import { requestGuide } from './guide-request';
import { renderGuideMarkdown } from './guide-markdown';
import { buildGuideMessage } from './guide-context';
import { guideEmoji } from './guide-emoji';
import { getLocale, t } from './i18n';
import { cleanFieldEvidence, evidenceHTML } from './field-evidence';
import { icon } from './icons';
import './guide.css';

type ChatMessage = { role: 'user' | 'assistant'; text: string; emoji?: string; state?: 'writing' | 'done' | 'interrupted' };
type ToolUse = { name: string | null; label: string };
const foodWords = /맛집|식당|음식|먹|카페|커피|food|restaurant|eat|cafe|café|coffee/i;
const familyWords = /아이|어린|가족|유모차|child|kid|family|stroller/i;

function questionEmoji(question: string): string {
  if (foodWords.test(question)) return '🍽️';
  if (familyWords.test(question)) return '👨‍👩‍👧';
  if (/비\s*오는|우천|실내|우산|rain|indoor|umbrella/i.test(question)) return '☔';
  if (/오름|숲|자연|산책|해변|산|바다|nature|walk|beach|mountain|forest|sea/i.test(question)) return '🌿';
  return '🧭';
}

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
    field_evidence: cleanFieldEvidence(place.field_evidence),
    registration_note: typeof place.registration_note === 'string' ? place.registration_note.slice(0, 900) : null,
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
  private lastQuestion = '';
  private tools: ToolUse[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private turn = 0;
  private rendered = new WeakMap<ChatMessage, { text: string; html?: string; state: 'loading' | 'ready' | 'fallback' }>();

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
      <div class="panel-intro"><span class="eyebrow">A LOCAL PERSPECTIVE</span><h2>${guideEmoji('🧭')} 어떤 제주를 찾으세요?</h2><p>지역을 지정하지 않으면 제주 전체에서 찾아요.</p></div>
      <div class="guide-service-controls"><span id="guide-availability" role="status">연결 확인 중</span><button id="guide-refresh" type="button" aria-label="AI 가이드 연결 상태 다시 확인">${icon('reset')}</button><button id="guide-new-chat" type="button" title="현재 화면의 대화를 비우고 새 대화를 시작합니다. 서버 자료와 이용 한도는 유지됩니다.">새 대화</button></div>
      <div class="guide-body">
        <div id="guide-thinking" class="guide-thinking" role="status" hidden>${guideEmoji('🤖')}<strong id="guide-thinking-text">생각 중</strong><span class="guide-thinking-dots" aria-hidden="true">···</span></div>
        <section id="guide-tools" class="guide-tools" aria-label="실행된 도구" hidden><span class="guide-tools-heading">사용 도구</span><div id="guide-tool-list" role="list"></div></section>
        <div id="guide-messages" class="guide-messages" role="log" aria-label="AI 가이드 대화" aria-live="polite"></div>
        <div id="guide-recommendation" class="guide-recommendation" hidden></div>
      </div>
      <div id="guide-footer" class="guide-footer">
        <p id="guide-status" class="guide-status" role="status">질문을 보내면 가이드가 시작됩니다.</p>
        <form id="guide-form" class="guide-form"><label class="sr-only" for="guide-input">AI 가이드에게 질문</label><textarea id="guide-input" rows="2" maxlength="2000" placeholder="가고 싶은 곳, 여행 취향을 알려 주세요."></textarea><div><span id="guide-limit">하루 최대 30회 · AI 답변은 출처를 함께 확인하세요.</span><button type="button" id="guide-cancel" hidden>기다리기 중지</button><button type="submit" id="guide-send" aria-label="가이드 질문 보내기">${icon('arrow')}</button></div></form>
        <div class="guide-followup-heading">이어서 물어보세요 <span>선택하면 입력창에 담겨요</span></div>
        <div id="guide-followups" class="guide-quick-prompts guide-followups" aria-label="다음 질문 제안"></div>
      </div>
    `;
    root.querySelector<HTMLFormElement>('#guide-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = root.querySelector<HTMLTextAreaElement>('#guide-input')!;
      const message = input.value.trim();
      if (!message || this.running || document.documentElement.dataset.shellUpdating === 'true') return;
      input.value = '';
      void this.send(message);
    });
    root.querySelector('#guide-cancel')!.addEventListener('click', () => this.cancel());
    root.querySelector('#guide-new-chat')!.addEventListener('click', () => this.resetConversation());
    root.querySelector('#guide-refresh')!.addEventListener('click', () => { void this.refreshAvailability(true); });
    root.querySelector('#guide-followups')!.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-prompt]');
      if (!button) return;
      const input = root.querySelector<HTMLTextAreaElement>('#guide-input')!;
      input.value = button.dataset.prompt!;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      this.renderFollowups();
    });
    root.querySelector('#guide-input')!.addEventListener('input', () => this.renderFollowups());
    root.querySelector<HTMLTextAreaElement>('#guide-input')!.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        root.querySelector<HTMLFormElement>('#guide-form')!.requestSubmit();
      }
    });
    void this.refreshAvailability(false);
    window.addEventListener('atlas:locale-change', () => {
      this.renderFollowups();
      this.renderTools();
    });
    this.renderFollowups();
  }

  get hasUnsavedWork(): boolean {
    return this.running || Boolean(this.root.querySelector<HTMLTextAreaElement>('#guide-input')?.value.trim());
  }
  private applyConfig(config: AppConfig): void {
    this.dailyLimit = config.guide.daily_limit;
    this.root.querySelector('#guide-limit')!.textContent = `하루 최대 ${this.dailyLimit}회 · AI 답변은 출처를 함께 확인하세요.`;
    this.root.querySelector('#guide-availability')!.textContent = config.features.guide ? 'AI 가이드 활성' : 'AI 가이드 일시 중지';
  }
  private async refreshAvailability(force: boolean): Promise<void> {
    const button = this.root.querySelector<HTMLButtonElement>('#guide-refresh')!;
    button.disabled = true;
    try {
      const config = await getConfig(force);
      this.applyConfig(config);
      if (!this.running && !config.features.guide) this.status('AI 가이드가 일시 중지되어 있어요. 연결을 다시 확인하거나 잠시 후 질문해 주세요.');
    } catch {
      this.root.querySelector('#guide-availability')!.textContent = '연결 확인 필요';
      if (!this.running) this.status('가이드 연결은 질문을 보낼 때 다시 확인합니다.');
    } finally { button.disabled = false; }
  }
  resetConversation(): void {
    this.controller?.abort(new DOMException('New conversation', 'AbortError'));
    this.turn++;
    this.controller = undefined;
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.conversationId = undefined;
    this.messages = [];
    this.recommendation = null;
    this.lastQuestion = '';
    this.tools = [];
    this.rendered = new WeakMap();
    const input = this.root.querySelector<HTMLTextAreaElement>('#guide-input')!;
    input.value = '';
    this.setRunning(false);
    this.renderMessages();
    this.renderRecommendation();
    this.status('새 대화를 시작합니다. 이 화면의 대화를 비웠으며 서버 자료와 이용 한도는 유지됩니다.');
    input.focus();
  }

  private status(message: string): void {
    const translated = t(message);
    this.root.querySelector('#guide-status')!.textContent = getLocale() === 'en' && /[가-힣]/.test(translated)
      ? t('제주 정보를 확인하고 있어요.') : translated;
  }

  private renderMessages(): void {
    const log = this.root.querySelector<HTMLElement>('#guide-messages')!;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    log.innerHTML = this.messages.map((message) => {
      const text = message.text || t('제주 정보를 확인하고 있어요…');
      let content = `<p>${html(text)}</p>`;
      if (message.role === 'assistant') {
        let cached = this.rendered.get(message);
        if (message.text && (!cached || cached.text !== text)) {
          cached = { text, state: 'loading' };
          this.rendered.set(message, cached);
          const pending = cached;
          const apply = (markup: string, state: 'ready' | 'fallback') => {
            if (this.rendered.get(message) !== pending || message.text !== text || !this.messages.includes(message)) return;
            pending.html = markup;
            pending.state = state;
            this.renderMessages();
          };
          // Ignore stale async renders. A lazy parser must never replace the
          // completed answer with an older streaming prefix.
          void renderGuideMarkdown(text).then(
            (markup) => apply(markup, 'ready'),
            () => apply(`<p>${html(text)}</p>`, 'fallback'),
          );
        }
        content = `<div class="guide-markdown" data-markdown-state="${cached?.state ?? 'plain'}">${cached?.html ?? `<p>${html(text)}</p>`}</div>`;
      }
      return `<article class="chat-message chat-message--${message.role}"><span>${message.role === 'user' ? t('나') : `${guideEmoji(message.emoji ?? '🧭')} ${t('제주 가이드')}`}</span>${content}${message.state === 'interrupted' ? `<small>${t('답변이 중단되었습니다.')}</small>` : ''}</article>`;
    }).join('');
    if (nearBottom || this.running) log.scrollTop = log.scrollHeight;
  }

  private scheduleMessages(): void {
    // Reference chat implementation also coalesces whole-answer parsing to
    // roughly five frames/second rather than reparsing every token.
    if (this.renderTimer !== undefined) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.renderMessages();
    }, 200);
  }

  private renderFollowups(): void {
    const typed = this.root.querySelector<HTMLTextAreaElement>('#guide-input')!.value.trim();
    const question = typed || this.lastQuestion;
    const names = !typed ? this.recommendation?.markers.slice(0, 2).map((place) => place.name).join(' · ') : '';
    const selected = !question ? this.context().match(/(?:선택 장소|Selected place) (.+?)\. (?:지도 중심|내 코스|Map center|My trip)/)?.[1] : '';
    const subject = (typed || names || question || selected || '').replace(/\s+/g, ' ').replace(/[?!.。]+$/, '').slice(0, 180);
    const prompt = (detail: string) => `${subject ? `${subject}. ` : ''}${t(detail)}`.slice(0, 2000);
    let suggestions: { label: string; emoji: string; prompt: string }[];
    if (foodWords.test(question)) {
      suggestions = [
        { label: '주차 확인', emoji: '🧭', prompt: prompt('추천 장소의 주차 정보가 확인되는지 알려 주세요.') },
        { label: '이용시간', emoji: '🍽️', prompt: prompt('확인된 이용시간과 출처를 알려 주세요.') },
        { label: '근처 산책', emoji: '🌿', prompt: prompt('함께 들를 가까운 산책 장소를 추천해 주세요.') },
      ];
    } else if (familyWords.test(question)) {
      suggestions = [
        { label: '유모차 안내', emoji: '👨‍👩‍👧', prompt: prompt('유모차와 어린이 관련 편의 정보가 확인되는지 알려 주세요.') },
        { label: '실내 대안', emoji: '☔', prompt: prompt('비가 오면 대신 갈 수 있는 실내 장소를 추천해 주세요.') },
        { label: '식사 장소', emoji: '🍽️', prompt: prompt('아이와 함께 갈 가까운 식당을 찾아 주세요.') },
      ];
    } else if (question || selected) {
      suggestions = [
        { label: '주변 맛집', emoji: '🍽️', prompt: prompt('함께 들를 가까운 맛집을 찾아 주세요.') },
        { label: '편의 정보', emoji: '🧭', prompt: prompt('주차·화장실 등 확인된 편의 정보를 알려 주세요.') },
        { label: '비 오는 날', emoji: '☔', prompt: prompt('비 오는 날의 실내 대안을 추천해 주세요.') },
      ];
    } else {
      suggestions = [
        { label: '맛집 찾기', emoji: '🍽️', prompt: '제주에서 맛집을 추천하고 확인된 이용 정보를 알려 주세요.' },
        { label: '자연 산책', emoji: '🌿', prompt: '제주 동쪽에서 자연을 즐기는 반나절 코스를 추천해 주세요.' },
        { label: '아이와 함께', emoji: '👨‍👩‍👧', prompt: '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.' },
      ];
    }
    this.root.querySelector('#guide-followups')!.innerHTML = suggestions.map((suggestion) =>
      `<button type="button" data-prompt="${html(t(suggestion.prompt))}" title="${html(t(suggestion.prompt))}">${guideEmoji(suggestion.emoji)}${html(t(suggestion.label))}</button>`).join('');
  }

  private recordTool(value: Record<string, unknown>): void {
    if (value.stage !== 'tool') return;
    const raw = typeof value.tool === 'string' ? value.tool : '';
    const name = /^[A-Za-z0-9_.:-]{1,120}$/.test(raw) && !/arn:|secret|token/i.test(raw) ? raw : null;
    const label = publicMessage(value.label ?? value.message, '도구 실행');
    const index = this.tools.findIndex((tool) => name ? tool.name === name : !tool.name && tool.label === label);
    if (index >= 0) this.tools.splice(index, 1);
    this.tools.push({ name, label });
    this.tools = this.tools.slice(-8);
    this.renderTools();
  }

  private renderTools(): void {
    this.root.querySelector<HTMLElement>('#guide-tools')!.hidden = !this.tools.length;
    this.root.querySelector('#guide-tool-list')!.innerHTML = this.tools.map((tool, index) => {
      const translated = t(tool.label);
      const label = getLocale() === 'en' && /[가-힣]/.test(translated) ? t('도구 실행') : translated;
      return `<div class="guide-tool-chip${this.running && index === this.tools.length - 1 ? ' is-current' : ''}" role="listitem" data-tool="${html(tool.name ?? '')}"><span>${html(label)}</span>${tool.name ? `<code>${html(tool.name)}</code>` : ''}</div>`;
    }).join('');
  }

  private setRunning(value: boolean): void {
    this.running = value;
    this.root.querySelector<HTMLButtonElement>('#guide-send')!.disabled = value;
    this.root.querySelector<HTMLElement>('#guide-cancel')!.hidden = !value;
    this.root.querySelector<HTMLElement>('#guide-thinking')!.hidden = !value;
    if (value) this.root.querySelector('#guide-thinking-text')!.textContent = '생각 중';
    this.renderTools();
    this.root.querySelector('#guide-messages')!.setAttribute('aria-busy', String(value));
  }

  cancel(): void {
    if (!this.running) return;
    this.controller?.abort();
    this.status('기다리기를 중지했어요. 이미 시작한 요청은 일일 횟수에 포함될 수 있어요.');
  }

  private errorMessage(code: string, status = 0): string {
    return t(this.errorCopy(code, status));
  }

  private errorCopy(code: string, status = 0): string {
    const normalized = code.toLowerCase();
    if (/concurr|busy/.test(normalized)) return '다른 요청을 처리하고 있어요. 잠시 후 다시 질문해 주세요.';
    if (/hourly/.test(normalized)) return '한 시간 이용 한도에 도달했어요. 잠시 후 다시 질문해 주세요.';
    if (normalized === 'quota_unavailable') return '이용 한도를 확인하지 못해 요청을 시작하지 않았어요. 잠시 후 다시 보내 주세요.';
    if (/daily|quota/.test(normalized)) return `오늘의 이용 한도에 도달했어요. 하루 최대 ${this.dailyLimit}회까지 이용할 수 있어요.`;
    if (status === 429 || /limit/.test(normalized)) return '요청이 많아 잠시 쉬고 있어요. 잠시 후 다시 질문해 주세요.';
    if (/timeout/.test(normalized)) return '답변 시간이 길어 연결을 마쳤어요. 질문을 조금 줄여 다시 보내 주세요.';
    if (normalized === 'invalid_conversation') return '대화를 새로 연결하지 못했어요. 잠시 후 같은 질문을 다시 보내 주세요.';
    if (normalized === 'session_required') return '세션 연결을 확인하지 못했어요. 페이지를 다시 열어 주세요.';
    if (normalized === 'csrf_invalid') return '요청 연결을 확인하지 못했어요. 페이지를 다시 열고 질문해 주세요.';
    if (normalized === 'origin_forbidden' || status === 403) return '현재 페이지에서 요청이 허용되지 않았어요. 제주 아틀라스 페이지를 다시 열어 주세요.';
    if (status === 401) return '접속 상태를 확인하지 못했어요. 페이지를 다시 열어 주세요.';
    if (normalized === 'invalid_stream' || normalized === 'invalid_response') return '답변 형식을 확인하지 못했어요. 잠시 후 다시 질문해 주세요.';
    if (normalized === 'interrupted') return '답변을 받는 중 연결이 끊겼어요. 잠시 후 다시 보내 주세요.';
    if (normalized === 'guide_unavailable' || normalized === 'unavailable') return 'AI 가이드 서버가 답변을 제공하지 못했어요. 잠시 후 다시 보내 주세요.';
    return '가이드에 연결하지 못했어요. 잠시 후 다시 질문해 주세요.';
  }

  private renderRecommendation(): void {
    const panel = this.root.querySelector<HTMLElement>('#guide-recommendation')!;
    const recommendation = this.recommendation;
    panel.hidden = !recommendation || !recommendation.markers.length;
    this.renderFollowups();
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
      const values = facilities.length ? `<dl>${facilities.map(([key, value]) => `<dt>${html(t(labels[key] ?? key))}</dt><dd>${html(t(facilityText(value)))}${evidenceHTML(place.field_evidence, `facilities.${key}`)}</dd>`).join('')}</dl>` : '<p>주차·화장실·유모차 이용 정보는 카탈로그에서 확인되지 않았습니다.</p>';
      return `<details class="guide-place-facts"${index === 0 ? ' open' : ''}><summary><span data-i18n-ignore>${html(place.name)}</span><small>${recorded ? `편의 ${recorded}항목 기록` : '편의 정보 미확인'}${place.hours_week.length ? ' · 이용시간 자료 있음' : ''}</small></summary><div>${values}<p>${html(t(hoursText(place.hours_week, place.hours_source)))}${place.hours_week.length ? ` · 출처 ${html(sourceName(place.hours_source))}` : ''}</p>${evidenceHTML(place.field_evidence, 'hours_week')}${sources.length ? `<p>보강 자료 출처: ${sources.map(html).join(' · ')}</p>` : ''}${place.enriched_at ? `<p>보강일: ${html(dateLabel(place.enriched_at))}</p>` : ''}${place.base_note ? `<p>${html(place.base_note)}</p>` : ''}${place.registration_note ? `<p class="guide-registration-note">${html(t(place.registration_note))}</p>` : ''}${this.onSelect ? `<button data-guide-place="${html(place.id)}">${icon('pin')}장소 상세 보기 ${icon('chevron')}</button>` : ''}</div></details>`;
    }).join('')}</section>`;
  }

  async send(message: string): Promise<void> {
    if (this.running || !message.trim() || document.documentElement.dataset.shellUpdating === 'true') return;
    const turn = ++this.turn;
    message = message.trim().slice(0, 2000);
    const locale = getLocale();
    const requestMessage = buildGuideMessage(message, this.context(), locale);
    this.lastQuestion = message;
    this.tools = [];
    this.setRunning(true);
    this.messages = [...this.messages.slice(-18), { role: 'user', text: message }];
    const answer: ChatMessage = { role: 'assistant', text: '', emoji: questionEmoji(message), state: 'writing' };
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
      const requestId = crypto.randomUUID();
      let config = await withAbort(getConfig(), controller.signal);
      // A paused configuration must not pin this tab to an old feature flag.
      if (!config.features.guide) config = await withAbort(getConfig(true), controller.signal);
      this.applyConfig(config);
      if (!config.features.guide) throw new ApiError('unavailable', 503);
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await requestGuide({
        message: requestMessage,
        conversationId: this.conversationId,
        csrfToken: config.guide.csrf_token,
        requestId,
        locale,
        signal: controller.signal,
        onRecovery: () => {
          this.conversationId = undefined;
          this.status('대화를 새로 연결하고 같은 질문을 다시 보내고 있어요.');
        },
      });
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ApiError('invalid_stream', 502);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const dispatch = (block: string) => {
        if (turn !== this.turn || controller.signal.aborted) return;
        const lines = block.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(data); } catch { throw new ApiError('invalid_stream', 502); }
        if (event === 'session' && typeof value.conversation_id === 'string' && value.conversation_id.length < 2000) this.conversationId = value.conversation_id;
        if (event === 'status') {
          this.status(publicMessage(value.message, '제주 정보를 확인하고 있어요.'));
          this.recordTool(value);
        }
        if (event === 'text' && typeof value.delta === 'string' && value.delta) {
          if (!answer.text) this.root.querySelector('#guide-thinking-text')!.textContent = '답변 작성 중';
          answer.text = `${answer.text}${value.delta}`.slice(0, 30000);
          this.scheduleMessages();
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
          if (!answer.text) answer.text = t('표시할 답변이 없어요. 원하는 지역이나 활동을 더 구체적으로 알려 주세요.');
          answer.state = 'done';
          this.status('답변을 받았어요. 장소별 출처와 이용 정보를 확인해 주세요.');
        }
        if (event === 'error') {
          serverError = true;
          const code = String(value.code ?? 'unavailable');
          if (/session|conversation/i.test(code)) this.conversationId = undefined;
          const reason = this.errorMessage(code);
          this.status(reason);
          answer.state = 'interrupted';
          if (!answer.text) answer.text = reason;
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
      if (turn !== this.turn) return;
      answer.state = 'interrupted';
      if (controller.signal.aborted && controller.signal.reason?.name === 'AbortError') {
        const reason = t('기다리기를 중지했어요. 이미 시작한 요청은 일일 횟수에 포함될 수 있어요.');
        this.status(reason);
        if (!answer.text) answer.text = reason;
      } else {
        const code = error instanceof ApiError ? error.code : controller.signal.aborted ? 'timeout' : 'unavailable';
        const status = error instanceof ApiError ? error.status : 0;
        if ((status === 403 && code === 'invalid_conversation') || (status === 401 && code === 'session_required')) this.conversationId = undefined;
        const reason = this.errorMessage(code, status);
        this.status(reason);
        if (!answer.text) answer.text = reason;
      }
    } finally {
      clearTimeout(timer);
      if (turn === this.turn) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
        this.controller = undefined;
        this.renderMessages();
        this.setRunning(false);
        this.renderFollowups();
      }
    }
  }
}
