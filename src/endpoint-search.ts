import type { CatalogPlace, LatLng } from '../shared/api-types';
import type { PlaceSnapshot } from './saved-data.ts';
import { snapshot } from './saved-data.ts';
import { catalogBounds } from './api.ts';
import { getLocale, placeName, t } from './i18n.ts';
import { lookupPlaces, type PlaceSearchSource } from './place-search.ts';

export type EndpointKind = 'origin' | 'destination';
export type EndpointPlan = {
  origin: PlaceSnapshot | null;
  destination: PlaceSnapshot | null;
  pendingDestination: boolean;
  canReverse: boolean;
};
export const endpointCopy = {
  ko: {
    title: '출발·도착 찾기', origin: '출발', destination: '도착', source: '검색 출처',
    help: '검색 출처·편집 안내',
    auto: '자동 · 카카오 우선', catalog: '저장된 카탈로그', search: '검색', placeholder: '장소 이름 검색',
    sourceHint: '자동은 카카오 검색이 켜져 있으면 조회하고, 꺼져 있으면 카탈로그를 검색합니다. 검색 실패 시 출처를 자동으로 바꾸지 않습니다.',
    editHint: '여기서 고르면 해당 출발·도착만 바꾸고 중간 경유지는 유지합니다.',
    notSelected: '아직 선택하지 않았어요.', ready: '이름을 입력한 뒤 검색을 눌러 주세요.',
    searching: '장소를 찾고 있어요.', empty: '검색 결과가 없어요. 이름이나 검색 출처를 바꿔 보세요.',
    match: '개 결과', matches: '개 결과', kakao: '카카오 조회', noAddress: '주소 정보 없음', unknownSource: '출처 미확인',
    searchFailed: '검색을 불러오지 못했어요. 다시 검색하거나 출처를 ‘저장된 카탈로그’로 바꿔 직접 검색해 주세요.',
    catalogFailed: '카탈로그를 불러오지 못했어요. 연결을 확인한 뒤 다시 검색해 주세요.',
    invalidQuery: '장소 이름을 1~160자로 입력해 주세요.', invalidCenter: '제주 안의 지도 중심에서 검색해 주세요.',
    selectFailed: '장소 선택이나 저장을 마치지 못했어요. 코스와 저장 상태를 확인해 주세요.',
    shortcuts: '즐겨찾기·최근 장소에서 선택', noShortcuts: '저장한 즐겨찾기나 최근 장소가 없어요.',
    savedNote: '저장 당시의 좌표·출처로 지정합니다.', reverse: '전체 순서 뒤집기',
    reversed: '출발·경유·도착의 전체 순서를 뒤집었어요.',
    pending: '도착지를 임시로 골랐어요. 출발지를 선택하면 코스에 반영합니다.',
    discard: '임시 도착지 취소', samePlace: '출발과 도착은 서로 다른 장소를 선택해 주세요.',
  },
  en: {
    title: 'Find start and finish', origin: 'Start', destination: 'Finish', source: 'Search source',
    help: 'Search sources and editing',
    auto: 'Auto · Kakao first', catalog: 'Saved catalog', search: 'Search', placeholder: 'Search a place name',
    sourceHint: 'Auto uses Kakao when enabled, otherwise the catalog. A failed search never switches sources automatically.',
    editHint: 'Choosing here replaces only that endpoint and keeps intermediate stops.',
    notSelected: 'No place selected.', ready: 'Enter a name, then choose Search.',
    searching: 'Searching places…', empty: 'No places returned. Try another name or search source.',
    match: 'result', matches: 'results', kakao: 'Kakao lookup', noAddress: 'Address unavailable', unknownSource: 'Source unconfirmed',
    searchFailed: 'Search is unavailable. Try again, or select Saved catalog and submit a separate search.',
    catalogFailed: 'The catalog is unavailable. Check your connection and search again.',
    invalidQuery: 'Enter a place name of 1–160 characters.', invalidCenter: 'Search with the map centered inside Jeju.',
    selectFailed: 'The selection or save could not finish. Check the trip and its save status.',
    shortcuts: 'Choose from favorites or recent places', noShortcuts: 'No favorites or recent places saved.',
    savedNote: 'Uses the coordinates and sources saved with the place.', reverse: 'Reverse all stops',
    reversed: 'Reversed the complete start, via and finish order.',
    pending: 'Finish selected as a draft. Choose a start to apply it to the trip.',
    discard: 'Discard draft finish', samePlace: 'Choose different places for the start and finish.',
  },
} as const;

type EndpointOptions = {
  getCenter?: () => LatLng | null;
  getFavorites: () => readonly PlaceSnapshot[];
  getRecentPlaces?: () => readonly PlaceSnapshot[];
  onPick: (kind: EndpointKind, place: PlaceSnapshot) => Promise<boolean>;
  onReverse: () => void | Promise<void>;
  onClearDraft: () => void;
  lookup?: typeof lookupPlaces;
};
type SearchField = {
  query: HTMLInputElement;
  results: HTMLElement;
  status: HTMLElement;
  shortcuts: HTMLElement;
  controller: AbortController | null;
  generation: number;
  items: CatalogPlace[];
  saved: PlaceSnapshot[];
  state: 'idle' | 'loading' | 'success' | 'error';
  error: string;
  picking: boolean;
};
let instance = 0;

/** A persistent DOM island: update() never replaces search inputs or results. */
export class EndpointSearch {
  private root: HTMLElement;
  private options: EndpointOptions;
  private lookup: typeof lookupPlaces;
  private fields: Record<EndpointKind, SearchField>;
  private source: PlaceSearchSource = 'auto';
  private plan: EndpointPlan = { origin: null, destination: null, pendingDestination: false, canReverse: false };
  private disposed = false;
  private localeChanged = () => this.paint();

  constructor(root: HTMLElement, options: EndpointOptions) {
    this.root = root;
    this.options = options;
    this.lookup = options.lookup ?? lookupPlaces;
    root.classList.add('endpoint-search');
    root.setAttribute('data-i18n-ignore', '');
    const prefix = `endpoint-${++instance}`;
    root.innerHTML = `
      <div class="endpoint-heading"><h3 data-endpoint-copy="title"></h3><button type="button" data-endpoint-reverse data-endpoint-copy="reverse" disabled></button></div>
      <label class="endpoint-source"><span data-endpoint-copy="source"></span><select data-endpoint-source><option value="auto" data-endpoint-copy="auto"></option><option value="catalog" data-endpoint-copy="catalog"></option></select></label>
      <div class="endpoint-pending" data-endpoint-pending hidden role="status"><p data-endpoint-copy="pending"></p><button type="button" data-endpoint-discard data-endpoint-copy="discard"></button></div>
      ${(['origin', 'destination'] as const).map(kind => `
        <section class="endpoint-field" data-endpoint-field="${kind}">
          <form data-endpoint-form="${kind}">
            <label for="${prefix}-${kind}" data-endpoint-label="${kind}" data-endpoint-copy="${kind}"></label>
            <p class="endpoint-selected" data-endpoint-selected="${kind}"></p>
            <div class="endpoint-input-row"><input id="${prefix}-${kind}" type="search" data-endpoint-query="${kind}" maxlength="160" autocomplete="off" aria-describedby="${prefix}-${kind}-status"><button type="submit" data-endpoint-copy="search"></button></div>
          </form>
          <p id="${prefix}-${kind}-status" class="endpoint-status" data-endpoint-status="${kind}" role="status"></p>
          <ul class="endpoint-results" data-endpoint-results="${kind}"></ul>
          <details data-endpoint-shortcuts="${kind}"><summary data-endpoint-copy="shortcuts"></summary><p class="endpoint-note" data-endpoint-copy="savedNote"></p><ul class="endpoint-results"></ul><p class="endpoint-note" data-endpoint-empty-shortcuts data-endpoint-copy="noShortcuts"></p></details>
        </section>`).join('')}
      <details class="endpoint-help"><summary data-endpoint-copy="help"></summary>
        <p class="endpoint-note" data-endpoint-copy="sourceHint"></p>
        <p class="endpoint-note" data-endpoint-copy="editHint"></p>
      </details>`;
    const field = (kind: EndpointKind): SearchField => ({
      query: root.querySelector<HTMLInputElement>(`[data-endpoint-query="${kind}"]`)!,
      results: root.querySelector<HTMLElement>(`[data-endpoint-results="${kind}"]`)!,
      status: root.querySelector<HTMLElement>(`[data-endpoint-status="${kind}"]`)!,
      shortcuts: root.querySelector<HTMLElement>(`[data-endpoint-shortcuts="${kind}"]`)!,
      controller: null, generation: 0, items: [], saved: [], state: 'idle', error: '', picking: false,
    });
    this.fields = { origin: field('origin'), destination: field('destination') };
    for (const kind of ['origin', 'destination'] as const) {
      root.querySelector(`[data-endpoint-form="${kind}"]`)!.addEventListener('submit', event => {
        event.preventDefault();
        void this.search(kind);
      });
      this.fields[kind].query.addEventListener('input', () => this.resetSearch(kind));
      this.fields[kind].shortcuts.addEventListener('toggle', () => this.refreshShortcuts(kind));
    }
    root.querySelector<HTMLSelectElement>('[data-endpoint-source]')!.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      if (value !== 'auto' && value !== 'catalog') return;
      this.source = value;
      this.resetSearch('origin');
      this.resetSearch('destination');
    });
    root.querySelector('[data-endpoint-reverse]')!.addEventListener('click', () => { void options.onReverse(); });
    root.querySelector('[data-endpoint-discard]')!.addEventListener('click', () => options.onClearDraft());
    root.ownerDocument.defaultView?.addEventListener('atlas:locale-change', this.localeChanged);
    this.paint();
  }

  update(plan: EndpointPlan): void {
    this.plan = plan;
    this.paintSelection();
  }

  private paintSelection(): void {
    const labels = endpointCopy[getLocale()];
    for (const kind of ['origin', 'destination'] as const) {
      const place = this.plan[kind];
      this.root.querySelector(`[data-endpoint-selected="${kind}"]`)!.textContent = place ? placeName(place) : labels.notSelected;
    }
    this.root.querySelector<HTMLElement>('[data-endpoint-pending]')!.hidden = !this.plan.pendingDestination;
    this.root.querySelector<HTMLButtonElement>('[data-endpoint-reverse]')!.disabled = !this.plan.canReverse;
  }

  private paint(): void {
    const labels = endpointCopy[getLocale()];
    this.root.querySelectorAll<HTMLElement>('[data-endpoint-copy]').forEach(element => {
      element.textContent = labels[element.dataset.endpointCopy as keyof typeof labels];
    });
    this.paintSelection();
    for (const kind of ['origin', 'destination'] as const) {
      const field = this.fields[kind];
      field.query.placeholder = labels.placeholder;
      this.paintStatus(kind);
      field.results.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => this.paintPlace(button, field.items[index]));
      field.shortcuts.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => this.paintPlace(button, field.saved[index]));
    }
  }

  private paintStatus(kind: EndpointKind): void {
    const labels = endpointCopy[getLocale()];
    const field = this.fields[kind];
    field.status.dataset.state = field.state;
    field.results.setAttribute('aria-busy', String(field.state === 'loading'));
    const message = field.state === 'loading' ? labels.searching : field.state === 'idle' ? labels.ready
      : field.state === 'error' ? field.error === 'invalid_query' ? labels.invalidQuery
        : field.error === 'invalid_center' ? labels.invalidCenter : field.error === 'selection_failed' ? labels.selectFailed
        : this.source === 'catalog' ? labels.catalogFailed : labels.searchFailed
      : !field.items.length ? labels.empty
      : `${field.items.length} ${field.items.length === 1 ? labels.match : labels.matches} · ${field.items.every(place => place.source === 'Kakao Local') ? labels.kakao : labels.catalog}`;
    if (field.status.textContent !== message) field.status.textContent = message;
  }

  private resetSearch(kind: EndpointKind): void {
    const field = this.fields[kind];
    field.generation++;
    field.controller?.abort();
    field.controller = null;
    field.items = [];
    field.state = 'idle';
    field.error = '';
    field.results.replaceChildren();
    this.paintStatus(kind);
  }

  private async search(kind: EndpointKind): Promise<void> {
    if (this.disposed) return;
    this.resetSearch(kind);
    const field = this.fields[kind];
    const query = field.query.value.trim();
    if (!query || query.length > 160) { field.state = 'error'; field.error = 'invalid_query'; this.paintStatus(kind); return; }
    const generation = field.generation;
    const controller = new AbortController();
    field.controller = controller;
    field.state = 'loading';
    this.paintStatus(kind);
    try {
      // This is a search bias only; it is never used as an inferred trip origin.
      const center = this.options.getCenter?.() ?? {
        lng: (catalogBounds.west + catalogBounds.east) / 2, lat: (catalogBounds.south + catalogBounds.north) / 2,
      };
      const items = await this.lookup(query, center, controller.signal, this.source);
      if (this.disposed || controller.signal.aborted || generation !== field.generation || field.query.value.trim() !== query) return;
      field.items = items;
      field.state = 'success';
      field.results.replaceChildren(...items.map(place => this.placeRow(kind, place)));
    } catch (error) {
      if (this.disposed || controller.signal.aborted || generation !== field.generation) return;
      field.state = 'error';
      field.error = (error as { code?: string })?.code ?? '';
    } finally {
      if (!this.disposed && generation === field.generation) {
        field.controller = null;
        this.paintStatus(kind);
      }
    }
  }

  private paintPlace(button: HTMLButtonElement, place: CatalogPlace | PlaceSnapshot): void {
    const labels = endpointCopy[getLocale()];
    button.querySelector('strong')!.textContent = placeName(place);
    button.querySelector('[data-place-address]')!.textContent = place.address || labels.noAddress;
    button.querySelector('[data-place-source]')!.textContent = place.source === 'Kakao Local'
      ? 'Kakao Local' : t(place.source_label || place.source || labels.unknownSource);
  }

  private placeRow(kind: EndpointKind, place: CatalogPlace | PlaceSnapshot): HTMLLIElement {
    const row = this.root.ownerDocument.createElement('li');
    const button = this.root.ownerDocument.createElement('button');
    button.type = 'button';
    button.innerHTML = '<strong></strong><span data-place-address></span><span class="endpoint-place-source" data-place-source></span>';
    this.paintPlace(button, place);
    button.addEventListener('click', () => { void this.pick(kind, place); });
    row.append(button);
    return row;
  }

  private async pick(kind: EndpointKind, place: CatalogPlace | PlaceSnapshot): Promise<void> {
    const field = this.fields[kind];
    if (field.picking || this.disposed) return;
    field.picking = true;
    const generation = field.generation;
    try {
      if (!await this.options.onPick(kind, snapshot(place))) throw new Error('selection_failed');
    } catch {
      if (generation === field.generation) { field.state = 'error'; field.error = 'selection_failed'; }
    } finally {
      field.picking = false;
      if (!this.disposed && generation === field.generation) this.paintStatus(kind);
    }
  }

  private refreshShortcuts(kind: EndpointKind): void {
    const field = this.fields[kind];
    const seen = new Set<string>();
    const places: PlaceSnapshot[] = [];
    try {
      for (const item of [...this.options.getFavorites(), ...(this.options.getRecentPlaces?.() ?? [])]) {
        if (places.length >= 12) break;
        try {
          const place = snapshot(item);
          if (seen.has(place.id)) continue;
          seen.add(place.id);
          places.push(place);
        } catch { /* Invalid stored hints cannot become route coordinates. */ }
      }
    } catch { /* A history storage error does not disable name searches. */ }
    if (JSON.stringify(places) !== JSON.stringify(field.saved)) {
      field.saved = places;
      field.shortcuts.querySelector('ul')!.replaceChildren(...places.map(place => this.placeRow(kind, place)));
    }
    field.shortcuts.querySelector<HTMLElement>('[data-endpoint-empty-shortcuts]')!.hidden = places.length > 0;
  }

  dispose(): void {
    this.disposed = true;
    for (const field of Object.values(this.fields)) field.controller?.abort();
    this.root.ownerDocument.defaultView?.removeEventListener('atlas:locale-change', this.localeChanged);
  }
}
