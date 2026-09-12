import { categoryName, html } from './api.ts';
import { categorySymbol, icon } from './icons.ts';
import { getLocale, placeName } from './i18n.ts';
import { snapshot } from './saved-data.ts';
import type { PlaceSnapshot } from './saved-data.ts';
import type { BrowsingHistory } from './browsing-history.ts';
import { filterPlaces } from './search-suggestions.ts';

type PlaceAction = (place: PlaceSnapshot) => void | Promise<void>;
type Tab = 'favorites' | 'recent' | 'queries';
export interface PlaceLibraryOptions {
  history: BrowsingHistory;
  getFavorites: () => readonly PlaceSnapshot[];
  onSelect: PlaceAction;
  onAdd: PlaceAction;
  onOrigin: PlaceAction;
  onDestination: PlaceAction;
  onFavorite: (place: PlaceSnapshot) => Promise<void>;
  /** Reopen a stored query globally; the parent resets search scope/filters. */
  onSearch?: (query: string) => void | Promise<void>;
}
const copy = {
  ko: {
    tabs: '저장한 장소와 탐색 기록', favorites: '즐겨찾기', recent: '최근 본 장소', queries: '최근 검색',
    filter: '즐겨찾기에서 검색', category: '즐겨찾기 분류', all: '모든 분류', reset: '필터 지우기',
    frequent: '자주 쓰는 장소', pin: '자주 쓰는 장소에 고정', unpin: '자주 쓰는 장소 고정 해제',
    pinLimit: '자주 쓰는 장소는 최대 5곳까지 고정할 수 있어요.',
    clearPlaces: '최근 본 장소 모두 지우기', clearQueries: '최근 검색 모두 지우기',
    removePlace: '최근 본 기록 지우기', removeQuery: '이 검색 기록 지우기',
    open: '장소 열기', searchAgain: '다시 검색', add: '코스', origin: '출발', destination: '도착',
    favorite: '저장', unfavorite: '해제', favoriteLabel: '즐겨찾기에 저장', unfavoriteLabel: '즐겨찾기 해제',
    noFavorites: '즐겨찾기가 없어요. 장소 상세에서 즐겨찾기로 저장해 보세요.',
    noRecent: '최근 본 장소가 없어요. 탐색에서 장소를 열면 여기에 표시돼요.',
    noQueries: '최근 검색이 없어요. 검색을 실행하면 여기에 표시돼요.',
    noMatches: '이 조건에 맞는 즐겨찾기가 없어요.', noAddress: '주소 정보 없음',
    historyNote: '최근 검색·열람 기록은 이 브라우저에 최대 30일간 보관해요.',
    memoryNote: '최근 기록과 고정 설정을 저장하지 못했어요. 현재 창에서만 유지됩니다.',
    failed: '동작을 완료하지 못했어요. 다시 시도해 주세요.', savedUnavailable: '즐겨찾기를 불러오지 못했어요.',
    places: '곳', searches: '개',
  },
  en: {
    tabs: 'Saved places and browsing history', favorites: 'Favorites', recent: 'Recently viewed', queries: 'Recent searches',
    filter: 'Search favorites', category: 'Favorite category', all: 'All categories', reset: 'Clear filters',
    frequent: 'Frequent places', pin: 'Pin as a frequent place', unpin: 'Unpin frequent place',
    pinLimit: 'You can pin up to 5 frequent places.',
    clearPlaces: 'Clear recently viewed places', clearQueries: 'Clear recent searches',
    removePlace: 'Remove from recently viewed', removeQuery: 'Remove this search',
    open: 'Open place', searchAgain: 'Search again', add: 'Trip', origin: 'Start', destination: 'Finish',
    favorite: 'Save', unfavorite: 'Remove', favoriteLabel: 'Save to favorites', unfavoriteLabel: 'Remove favorite',
    noFavorites: 'No favorites yet. Save a favorite from a place’s details.',
    noRecent: 'No recently viewed places. Open a place in Explore to see it here.',
    noQueries: 'No recent searches. Run a search to see it here.',
    noMatches: 'No favorites match these filters.', noAddress: 'Address unavailable',
    historyNote: 'Recent searches and viewed places stay in this browser for up to 30 days.',
    memoryNote: 'Recent history and pins could not be saved. They are kept only in this tab.',
    failed: 'This action could not finish. Try again.', savedUnavailable: 'Favorites could not load.',
    places: 'places', searches: 'searches',
  },
};
let sequence = 0;

/** A view over TripPlanner favorites and a separate local browsing-history store. */
export class PlaceLibrary {
  private root: HTMLElement;
  private settings: PlaceLibraryOptions;
  private tab: Tab = 'favorites';
  private query = '';
  private category = '';
  private rows = new Map<string, PlaceSnapshot>();
  private favorites: PlaceSnapshot[] = [];
  private pending = new Set<string>();
  private message: 'pinLimit' | 'failed' | '' = '';
  private favoritesUnavailable = false;
  private disposed = false;
  private prefix = `atlas-place-library-${++sequence}`;
  private unsubscribe: () => void;
  private listeners: [EventTarget, string, EventListener][] = [];

  constructor(root: HTMLElement, options: PlaceLibraryOptions) {
    this.root = root;
    this.settings = options;
    root.classList.add('atlas-library');
    root.setAttribute('data-i18n-ignore', '');
    root.innerHTML = `<div class="atlas-library-pins" data-library-pins hidden></div>
      <div class="atlas-library-tabs" role="tablist">${(['favorites', 'recent', 'queries'] as const).map(tab =>
        `<button type="button" role="tab" id="${this.prefix}-${tab}" data-library-tab="${tab}" aria-controls="${this.prefix}-panel"></button>`).join('')}</div>
      <div class="atlas-library-filters" data-library-filters>
        <input type="search" data-library-filter data-library-focus="filter">
        <select data-library-category data-library-focus="category"></select>
      </div>
      <div class="atlas-library-tools"><span data-library-count></span>
        <button type="button" data-library-reset hidden></button>
        <button type="button" data-library-clear="places" hidden></button>
        <button type="button" data-library-clear="queries" hidden></button>
      </div>
      <p class="atlas-nav-notice" data-library-status role="status" hidden></p>
      <div class="atlas-library-list" data-library-panel id="${this.prefix}-panel" role="tabpanel" tabindex="-1"></div>
      <p class="atlas-library-note" data-library-storage></p>`;
    const listen = (target: EventTarget, event: string, callback: EventListener) => {
      target.addEventListener(event, callback);
      this.listeners.push([target, event, callback]);
    };
    listen(root, 'click', event => { void this.click(event); });
    listen(root, 'keydown', event => this.keydown(event as KeyboardEvent));
    listen(this.element<HTMLInputElement>('[data-library-filter]'), 'input', event => {
      this.query = (event.target as HTMLInputElement).value;
      this.render();
    });
    listen(this.element<HTMLSelectElement>('[data-library-category]'), 'change', event => {
      this.category = (event.target as HTMLSelectElement).value;
      this.render();
    });
    const view = root.ownerDocument.defaultView;
    if (view) {
      listen(view, 'atlas:locale-change', () => this.render());
      listen(view, 'atlas:saved-change', () => this.render());
    }
    this.unsubscribe = options.history.subscribe(() => this.render());
    this.render();
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }
  private readFavorites(): PlaceSnapshot[] {
    this.favoritesUnavailable = false;
    try {
      const ids = new Set<string>();
      const places: PlaceSnapshot[] = [];
      for (const value of this.settings.getFavorites().slice(0, 100)) {
        try {
          const place = snapshot(value);
          if (!ids.has(place.id)) { ids.add(place.id); places.push(place); }
        } catch { /* Invalid data never becomes an actionable saved place. */ }
      }
      return places;
    } catch { this.favoritesUnavailable = true; return []; }
  }
  render(): void {
    if (this.disposed) return;
    const labels = copy[getLocale()];
    const previousFocus = this.root.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = previousFocus && this.root.contains(previousFocus) ? previousFocus.dataset.libraryFocus : undefined;
    this.root.lang = getLocale();
    this.favorites = this.readFavorites();
    const favorites = new Set(this.favorites.map(place => place.id));
    const pinned = this.settings.history.pinnedIds;
    const chips = pinned.flatMap(id => this.favorites.find(place => place.id === id) ?? []);
    const pinRoot = this.element('[data-library-pins]');
    pinRoot.hidden = chips.length === 0;
    pinRoot.innerHTML = `<span class="atlas-library-pins-label">${html(labels.frequent)}</span><div>${chips.map(place =>
      `<button type="button" data-library-pinned="${html(place.id)}" data-library-focus="chip:${html(place.id)}" title="${html(placeName(place))}">${icon('pin')}<span>${html(placeName(place))}</span></button>`).join('')}</div>`;
    this.element('[role="tablist"]').setAttribute('aria-label', labels.tabs);
    for (const tab of ['favorites', 'recent', 'queries'] as const) {
      const button = this.element<HTMLButtonElement>(`[data-library-tab="${tab}"]`);
      button.textContent = labels[tab];
      button.setAttribute('aria-selected', String(tab === this.tab));
      button.tabIndex = tab === this.tab ? 0 : -1;
    }
    const categories = [...new Set(this.favorites.map(place => place.category))];
    if (this.category && !categories.includes(this.category)) this.category = '';
    const input = this.element<HTMLInputElement>('[data-library-filter]');
    input.placeholder = labels.filter;
    input.setAttribute('aria-label', labels.filter);
    if (input.value !== this.query) input.value = this.query;
    const select = this.element<HTMLSelectElement>('[data-library-category]');
    select.setAttribute('aria-label', labels.category);
    select.innerHTML = `<option value="">${html(labels.all)}</option>${categories.map(category => `<option value="${html(category)}">${html(categoryName(category))}</option>`).join('')}`;
    select.value = this.category;
    this.element('[data-library-filters]').hidden = this.tab !== 'favorites';
    const reset = this.element<HTMLButtonElement>('[data-library-reset]');
    reset.hidden = this.tab !== 'favorites' || (!this.query && !this.category);
    reset.textContent = labels.reset;
    const queries = this.settings.history.queries;
    const places = this.tab === 'favorites' ? filterPlaces(this.favorites, this.query, this.category) : this.settings.history.places;
    this.rows = new Map(places.map(place => [place.id, place]));
    const placeClear = this.element<HTMLButtonElement>('[data-library-clear="places"]');
    placeClear.hidden = this.tab !== 'recent' || places.length === 0;
    placeClear.textContent = labels.clearPlaces;
    placeClear.disabled = this.pending.has('clear:places');
    const queryClear = this.element<HTMLButtonElement>('[data-library-clear="queries"]');
    queryClear.hidden = this.tab !== 'queries' || queries.length === 0;
    queryClear.textContent = labels.clearQueries;
    queryClear.disabled = this.pending.has('clear:queries');
    this.element('[data-library-count]').textContent = this.tab === 'queries'
      ? `${queries.length} ${labels.searches}` : `${places.length} ${labels.places}`;
    const list = this.element('[data-library-panel]');
    list.setAttribute('aria-labelledby', `${this.prefix}-${this.tab}`);
    if (this.tab === 'queries') {
      list.innerHTML = queries.length ? queries.map(query => `<div class="atlas-library-query" data-library-query="${html(query)}">
        ${this.settings.onSearch ? `<button type="button" data-library-query-open data-library-focus="query:${html(query)}" aria-label="${html(`${labels.searchAgain}: ${query}`)}">${icon('search')}<span>${html(query)}</span></button>` : `<span>${html(query)}</span>`}
        <button type="button" data-library-query-remove data-library-focus="remove-query:${html(query)}" aria-label="${html(`${labels.removeQuery}: ${query}`)}" title="${html(labels.removeQuery)}">${icon('close')}</button></div>`).join('')
        : `<p class="atlas-library-empty">${html(labels.noQueries)}</p>`;
    } else {
      list.innerHTML = places.length ? places.map(place => {
        const id = html(place.id);
        const name = placeName(place);
        const saved = favorites.has(place.id);
        const action = (name: string, label: string, symbol: Parameters<typeof icon>[0], accessible = label) =>
          `<button type="button" data-library-action="${name}" data-library-focus="${name}:${id}" aria-label="${html(`${accessible}: ${placeName(place)}`)}"${name === 'favorite' ? ` aria-pressed="${saved}"` : ''}${this.pending.has(`${name}:${place.id}`) ? ' disabled' : ''}>${icon(symbol)}<span>${html(label)}</span></button>`;
        return `<article class="atlas-library-card" data-library-id="${id}">
          <div class="atlas-library-card-heading"><span class="atlas-nav-symbol" aria-hidden="true">${icon(categorySymbol(place.category).icon)}</span>
            <button type="button" class="atlas-library-place-name" data-library-action="select" data-library-focus="select:${id}" title="${html(name)}">${html(name)}</button>
            ${this.tab === 'favorites' ? `<button type="button" class="atlas-library-icon-button" data-library-action="pin" data-library-focus="pin:${id}" aria-pressed="${pinned.includes(place.id)}" aria-label="${html(`${pinned.includes(place.id) ? labels.unpin : labels.pin}: ${name}`)}" title="${html(pinned.includes(place.id) ? labels.unpin : labels.pin)}"${this.pending.has(`pin:${place.id}`) ? ' disabled' : ''}>${icon('pin')}</button>`
              : `<button type="button" class="atlas-library-icon-button" data-library-action="remove" data-library-focus="remove:${id}" aria-label="${html(`${labels.removePlace}: ${name}`)}" title="${html(labels.removePlace)}">${icon('close')}</button>`}
          </div><p class="atlas-library-address" title="${html(place.address ?? labels.noAddress)}">${html(place.address ?? labels.noAddress)}</p>
          <p class="atlas-library-source"><span>${html(categoryName(place.category))}</span><span>${html(place.source_label || place.source)}</span></p>
          <div class="atlas-library-actions">${action('add', labels.add, 'plus')}${action('origin', labels.origin, 'pin')}${action('destination', labels.destination, 'route')}${action('favorite', saved ? labels.unfavorite : labels.favorite, saved ? 'check' : 'plus', saved ? labels.unfavoriteLabel : labels.favoriteLabel)}</div>
        </article>`;
      }).join('') : `<p class="atlas-library-empty">${html(this.favoritesUnavailable ? labels.savedUnavailable : this.tab === 'recent' ? labels.noRecent
        : this.query || this.category ? labels.noMatches : labels.noFavorites)}</p>`;
    }
    const status = this.element('[data-library-status]');
    status.hidden = !this.message && !this.favoritesUnavailable;
    status.textContent = this.message ? labels[this.message] : this.favoritesUnavailable ? labels.savedUnavailable : '';
    const storage = this.element('[data-library-storage]');
    storage.textContent = this.settings.history.persisted ? labels.historyNote : labels.memoryNote;
    storage.dataset.unsaved = String(!this.settings.history.persisted);
    if (focusKey && previousFocus && !previousFocus.isConnected) {
      const replacement = [...this.root.querySelectorAll<HTMLElement>('[data-library-focus]')].find(element => element.dataset.libraryFocus === focusKey);
      (replacement ?? this.element(`[data-library-tab="${this.tab}"]`)).focus({ preventScroll: true });
    }
  }
  private async run(key: string, action: () => void | Promise<unknown>): Promise<void> {
    if (this.disposed || this.pending.has(key)) return;
    this.pending.add(key);
    this.message = '';
    this.render();
    try { await action(); } catch { this.message = 'failed'; }
    finally { this.pending.delete(key); this.render(); }
  }
  private async click(event: Event): Promise<void> {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || !this.root.contains(button) || button.disabled) return;
    const tab = button.dataset.libraryTab as Tab | undefined;
    if (tab) { this.tab = tab; this.message = ''; this.render(); return; }
    if (button.hasAttribute('data-library-reset')) { this.query = ''; this.category = ''; this.render(); return; }
    if (button.dataset.libraryClear === 'queries') {
      await this.run('clear:queries', () => this.settings.history.clearQueries()); return;
    }
    if (button.dataset.libraryClear === 'places') {
      await this.run('clear:places', () => this.settings.history.clearPlaces()); return;
    }
    const query = button.closest<HTMLElement>('[data-library-query]')?.dataset.libraryQuery;
    if (query !== undefined) {
      if (button.hasAttribute('data-library-query-remove')) await this.run(`remove-query:${query}`, () => this.settings.history.removeQuery(query));
      else if (button.hasAttribute('data-library-query-open') && this.settings.onSearch) await this.run(`query:${query}`, () => this.settings.onSearch!(query));
      return;
    }
    const pinned = button.dataset.libraryPinned;
    if (pinned) {
      const place = this.favorites.find(item => item.id === pinned);
      if (place) await this.run(`select:${pinned}`, () => this.settings.onSelect(structuredClone(place)));
      return;
    }
    const id = button.closest<HTMLElement>('[data-library-id]')?.dataset.libraryId;
    const place = id ? this.rows.get(id) : undefined;
    const action = button.dataset.libraryAction;
    if (!place || !action) return;
    await this.run(`${action}:${place.id}`, async () => {
      if (action === 'pin') {
        const valid = new Set(this.readFavorites().map(item => item.id));
        if (this.favoritesUnavailable || !valid.has(place.id)) return;
        // Orphaned IDs carry no favorite copy and must not consume a visible pin slot.
        for (const id of this.settings.history.pinnedIds) if (!valid.has(id)) await this.settings.history.togglePin(id, false);
        if (!await this.settings.history.togglePin(place.id)) this.message = 'pinLimit';
      } else if (action === 'remove') await this.settings.history.removePlace(place.id);
      else if (action === 'favorite') {
        await this.settings.onFavorite(structuredClone(place));
        const favorites = this.readFavorites();
        if (!this.favoritesUnavailable && !favorites.some(item => item.id === place.id)) await this.settings.history.togglePin(place.id, false);
      } else {
        const callback = action === 'select' ? this.settings.onSelect : action === 'add' ? this.settings.onAdd
          : action === 'origin' ? this.settings.onOrigin : action === 'destination' ? this.settings.onDestination : undefined;
        if (callback) await callback(structuredClone(place));
      }
    });
  }
  private keydown(event: KeyboardEvent): void {
    const button = (event.target as Element).closest<HTMLElement>('[data-library-tab]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const tabs: Tab[] = ['favorites', 'recent', 'queries'];
    const current = tabs.indexOf(button.dataset.libraryTab as Tab);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    this.tab = tabs[index];
    this.render();
    this.element(`[data-library-tab="${this.tab}"]`).focus();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const [target, event, listener] of this.listeners) target.removeEventListener(event, listener);
    this.root.replaceChildren();
  }
}
