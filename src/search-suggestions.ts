import type { CatalogPlace, PlaceDetail } from '../shared/api-types';
import { categoryName, html } from './api.ts';
import { categorySymbol, icon } from './icons.ts';
import { getLocale, placeName } from './i18n.ts';
import { snapshot } from './saved-data.ts';
import type { PlaceSnapshot } from './saved-data.ts';
import type { BrowsingHistory } from './browsing-history.ts';

export type SuggestionPlace = CatalogPlace | PlaceDetail | PlaceSnapshot;
export type SearchSuggestion = { kind: 'query'; key: string; query: string }
  | { kind: 'place'; key: string; place: PlaceSnapshot; origin: 'favorite' | 'result' };
export interface SearchSuggestionsOptions {
  history: BrowsingHistory;
  getFavorites: () => readonly PlaceSnapshot[];
  onSearch: (query: string, fromHistory?: boolean) => void | Promise<void>;
  onPlace: (place: PlaceSnapshot) => void | Promise<void>;
}
const fold = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const terms = (query: string) => query.trim().split(/\s+/u).filter(Boolean).map(fold);
const copy = {
  ko: { list: '검색 후보', query: '최근 검색', favorite: '즐겨찾기', result: '현재 결과', failed: '선택을 열지 못했어요. 다시 시도해 주세요.' },
  en: { list: 'Search suggestions', query: 'Recent search', favorite: 'Favorite', result: 'Current result', failed: 'This selection could not open. Try again.' },
};
let sequence = 0;

export function filterPlaces(places: readonly PlaceSnapshot[], query: string, category = ''): PlaceSnapshot[] {
  const words = terms(query);
  return places.filter(place => (!category || place.category === category) && words.every(word =>
    fold([place.name, place.name_en, place.address, place.category, categoryName(place.category)].filter(Boolean).join(' ')).includes(word)));
}

export function buildSuggestions(
  query: string, queries: readonly string[], favorites: readonly PlaceSnapshot[], results: readonly PlaceSnapshot[],
): SearchSuggestion[] {
  const words = terms(query);
  const seenQueries = new Set<string>();
  const options: SearchSuggestion[] = queries.filter(value => {
    const key = fold(value);
    if (!key || seenQueries.has(key) || !words.every(word => key.includes(word))) return false;
    seenQueries.add(key);
    return true;
  }).slice(0, 3).map(value => ({ kind: 'query', key: `query:${fold(value)}`, query: value }));
  const seenPlaces = new Set<string>();
  // A current provider result takes precedence over an older favorite snapshot.
  for (const [origin, places] of [['result', words.length ? results : []], ['favorite', favorites]] as const) {
    for (const place of filterPlaces(places, query)) {
      if (seenPlaces.has(place.id)) continue;
      seenPlaces.add(place.id);
      options.push({ kind: 'place', key: `place:${place.id}`, origin, place });
      if (options.length === 8) return options;
    }
  }
  return options;
}

function snapshots(places: readonly SuggestionPlace[]): PlaceSnapshot[] {
  const result: PlaceSnapshot[] = [];
  for (const place of places.slice(0, 100)) {
    try { result.push(snapshot(place)); } catch { /* Invalid rows never become selectable options. */ }
  }
  return result;
}

/** Local suggestions only. Parent callbacks commit searches and successful visits. */
export class SearchSuggestions {
  private input: HTMLInputElement;
  private host: HTMLElement;
  private settings: SearchSuggestionsOptions;
  private results: PlaceSnapshot[] = [];
  private items: SearchSuggestion[] = [];
  private active = -1;
  private opened = false;
  private wantsOpen = false;
  private composing = false;
  private selecting = false;
  private disposed = false;
  private generation = 0;
  private listId = `atlas-suggestion-list-${++sequence}`;
  private original = new Map<string, string | null>();
  private unsubscribe: () => void;
  private listeners: [EventTarget, string, EventListener][] = [];

  constructor(input: HTMLInputElement, host: HTMLElement, options: SearchSuggestionsOptions) {
    this.input = input;
    this.host = host;
    this.settings = options;
    host.classList.add('atlas-suggestions');
    host.setAttribute('data-i18n-ignore', '');
    host.hidden = true;
    for (const name of ['role', 'aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) {
      this.original.set(name, input.getAttribute(name));
    }
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-controls', this.listId);
    input.setAttribute('aria-expanded', 'false');
    const listen = (target: EventTarget, name: string, callback: EventListener) => {
      target.addEventListener(name, callback);
      this.listeners.push([target, name, callback]);
    };
    listen(input, 'input', () => { this.active = -1; this.open(); });
    listen(input, 'focus', () => { if (!this.selecting) this.open(); });
    listen(input, 'compositionstart', () => { this.composing = true; });
    listen(input, 'compositionend', () => { this.composing = false; this.open(); });
    listen(input, 'keydown', event => this.keydown(event as KeyboardEvent));
    listen(host, 'mousedown', event => {
      // Keep combobox focus until the option's click runs. This does not cancel
      // touch scrolling: compatibility mouse events follow a completed tap.
      if ((event.target as Element).closest('[data-suggestion-index]')) event.preventDefault();
    });
    listen(host, 'click', event => {
      const button = (event.target as Element).closest<HTMLElement>('[data-suggestion-index]');
      if (button && host.contains(button)) this.choose(Number(button.dataset.suggestionIndex));
    });
    const outside = (event: Event) => {
      if (event.target !== input && !host.contains(event.target as Node)) this.close();
    };
    listen(input.ownerDocument, 'pointerdown', outside);
    const blur = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (next === input || host.contains(next)) return;
      queueMicrotask(() => {
        const active = input.ownerDocument.activeElement;
        if (!this.disposed && active !== input && !host.contains(active)) this.close();
      });
    };
    listen(input, 'blur', blur);
    listen(host, 'focusout', blur);
    const view = input.ownerDocument.defaultView;
    if (view) {
      listen(view, 'atlas:locale-change', () => { if (this.wantsOpen) this.open(); });
      listen(view, 'atlas:saved-change', () => { if (this.wantsOpen) this.open(); });
    }
    this.unsubscribe = options.history.subscribe(() => { if (this.wantsOpen) this.open(); });
  }

  setResults(places: readonly SuggestionPlace[]): void {
    if (this.disposed) return;
    this.results = snapshots(places);
    if (this.wantsOpen) this.open();
  }
  private open(): void {
    if (this.disposed) return;
    this.wantsOpen = true;
    this.generation++;
    const selected = this.items[this.active]?.key;
    let favorites: PlaceSnapshot[] = [];
    try { favorites = snapshots(this.settings.getFavorites()); } catch { /* The parent owns saved-data recovery. */ }
    this.items = buildSuggestions(this.input.value, this.settings.history.queries, favorites, this.results);
    this.active = selected ? this.items.findIndex(item => item.key === selected) : -1;
    this.opened = this.items.length > 0;
    this.paint();
  }
  private paint(): void {
    const labels = copy[getLocale()];
    this.host.lang = getLocale();
    this.host.hidden = !this.opened;
    this.input.setAttribute('aria-expanded', String(this.opened));
    if (!this.opened) { this.input.removeAttribute('aria-activedescendant'); this.host.replaceChildren(); return; }
    this.host.innerHTML = `<div class="atlas-suggestions-panel"><div id="${this.listId}" role="listbox" aria-label="${html(labels.list)}">${this.items.map((item, index) => {
      const title = item.kind === 'query' ? item.query : placeName(item.place);
      const detail = item.kind === 'query' ? labels.query
        : `${labels[item.origin]} · ${categoryName(item.place.category)} · ${item.place.source_label || item.place.source}`;
      return `<button type="button" class="atlas-suggestion" role="option" tabindex="-1" id="${this.listId}-${index}" aria-selected="${index === this.active}" data-suggestion-index="${index}">${icon(item.kind === 'query' ? 'search' : categorySymbol(item.place.category).icon)}<span><strong>${html(title)}</strong><small>${html(detail)}</small></span></button>`;
    }).join('')}</div></div>`;
    if (this.active < 0) this.input.removeAttribute('aria-activedescendant');
    else {
      this.input.setAttribute('aria-activedescendant', `${this.listId}-${this.active}`);
      this.host.querySelector<HTMLElement>(`[data-suggestion-index="${this.active}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
  private keydown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (!this.host.hidden) { event.preventDefault(); event.stopPropagation(); this.close(); }
      return;
    }
    if (event.key === 'Tab') { this.close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.opened) this.open();
      if (!this.items.length) return;
      event.preventDefault();
      event.stopPropagation();
      this.active = event.key === 'ArrowDown' ? (this.active + 1) % this.items.length
        : this.active <= 0 ? this.items.length - 1 : this.active - 1;
      this.paint();
      return;
    }
    if (event.key !== 'Enter') return;
    if (this.opened && this.active >= 0) {
      event.preventDefault();
      event.stopPropagation();
      this.choose(this.active);
    } else if (this.input.value.trim()) {
      event.preventDefault();
      event.stopPropagation();
      const query = this.input.value.trim();
      this.dispatch(() => this.settings.onSearch(query, false));
    }
  }
  private choose(index: number): void {
    const selected = this.items[index];
    if (!selected) return;
    if (selected.kind === 'query') {
      this.input.value = selected.query;
      this.dispatch(() => this.settings.onSearch(selected.query, true));
    } else this.dispatch(() => this.settings.onPlace(structuredClone(selected.place)));
  }
  private dispatch(callback: () => void | Promise<void>): void {
    this.close();
    this.selecting = true;
    this.input.focus({ preventScroll: true });
    this.selecting = false;
    const generation = this.generation;
    void Promise.resolve().then(callback).catch(() => {
      if (this.disposed || generation !== this.generation) return;
      this.host.hidden = false;
      this.host.innerHTML = `<div class="atlas-suggestions-panel"><p class="atlas-nav-notice" role="status">${html(copy[getLocale()].failed)}</p></div>`;
    });
  }
  close(): void {
    this.generation++;
    this.opened = false;
    this.wantsOpen = false;
    this.active = -1;
    this.items = [];
    this.host.hidden = true;
    this.host.replaceChildren();
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.unsubscribe();
    for (const [target, event, listener] of this.listeners) target.removeEventListener(event, listener);
    for (const [name, value] of this.original) {
      if (value === null) this.input.removeAttribute(name);
      else this.input.setAttribute(name, value);
    }
  }
}
