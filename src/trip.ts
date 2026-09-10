import type { CatalogPlace, PlaceDetail } from '../shared/api-types';
import { categoryName, dateLabel, distanceLabel, distanceMeters, html } from './api';
import { icon } from './icons';
import { SavedDataStore, savedKey, savedLimits, savedStatusMessage, snapshot, validateSavedData } from './saved-data';
import type { PlaceSnapshot, SavedData, TripStop } from './saved-data';
import { SavedDataUI } from './saved-data-ui';
import { placeName } from './i18n';
export { snapshot } from './saved-data';
export type { PlaceSnapshot, TripStop } from './saved-data';

export class TripPlanner {
  private store: SavedDataStore;
  private management: SavedDataUI;
  private root: HTMLElement;
  private notify: (message: string) => void;
  private onChange: (stops: TripStop[]) => void;
  private onSelect: (place: PlaceSnapshot) => void;
  private shareCamera: () => string;
  private copy: (url: string) => Promise<void>;
  private lastSharedFragment = '';
  private get state(): SavedData { return this.store.data; }
  get hasUnsavedChanges(): boolean { return this.store.hasUnsavedChanges || this.management.hasPendingReview; }
  get isSaved(): boolean { return this.store.status === 'saved' && !this.store.hasUnsavedChanges; }
  openDataManagement(): void { this.management.open(); }

  constructor(root: HTMLElement, options: {
    notify: (message: string) => void; onChange: (stops: TripStop[]) => void;
    onSelect: (place: PlaceSnapshot) => void; shareCamera: () => string; copy: (url: string) => Promise<void>;
  }) {
    this.root = root;
    this.notify = options.notify;
    this.onChange = options.onChange;
    this.onSelect = options.onSelect;
    this.shareCamera = options.shareCamera;
    this.copy = options.copy;
    this.store = new SavedDataStore();
    this.management = new SavedDataUI(this.store, this.notify, () => this.detachSharedFragment());
    this.store.subscribe(() => {
      this.render();
      this.onChange(this.stops);
      window.dispatchEvent(new CustomEvent('atlas:saved-change'));
    });
    window.addEventListener('storage', event => {
      if (event.key === savedKey || event.key === null) this.store.sync();
    });
    window.addEventListener('atlas:locale-change', () => this.render());
    this.root.addEventListener('click', (event) => { void this.handleClick(event); });
    this.root.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.dataset.stay) return;
      const id = input.dataset.stay;
      const minutes = this.stay(Number(input.value));
      void this.change(data => {
        const stop = data.stops.find(item => item.id === id);
        if (stop) stop.stay_min = minutes;
      });
    });
    this.restoreShared();
    this.render();
    this.onChange(this.stops);
  }

  private stay(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(720, Math.round(value))) : 60;
  }

  get stops(): TripStop[] { return this.state.stops.map((item) => ({ ...item })); }
  isFavorite(id: string): boolean { return this.state.favorites.some((place) => place.id === id); }
  hasStop(id: string): boolean { return this.state.stops.some((place) => place.id === id); }

  async toggleFavorite(place: CatalogPlace | PlaceDetail | PlaceSnapshot): Promise<void> {
    const remove = this.isFavorite(place.id);
    if (!remove && this.state.favorites.length >= savedLimits.favorites) { this.notify('즐겨찾기는 최대 100곳까지 저장할 수 있어요.'); return; }
    await this.change(data => {
      const index = data.favorites.findIndex(item => item.id === place.id);
      if (remove && index >= 0) data.favorites.splice(index, 1);
      if (!remove && index < 0) data.favorites.push(snapshot(place));
    }, remove ? '즐겨찾기에서 뺐어요.' : '즐겨찾기에 저장했어요.');
  }

  async add(place: CatalogPlace | PlaceDetail | PlaceSnapshot): Promise<void> {
    if (this.hasStop(place.id)) { this.notify('이미 내 여행에 담긴 장소예요.'); return; }
    if (this.state.stops.length >= savedLimits.stops) { this.notify('한 코스에는 최대 12곳까지 담을 수 있어요.'); return; }
    await this.change(data => {
      if (!data.stops.some(item => item.id === place.id)) data.stops.push({ ...snapshot(place), stay_min: 60 });
    }, `${placeName(place)}, 내 여행에 저장했어요.`);
  }

  private async change(change: (data: SavedData) => void, message?: string): Promise<void> {
    this.detachSharedFragment();
    const result = await this.store.update(change);
    if (!result.ok) this.notify(savedStatusMessage(result.reason));
    else if (message) this.notify(message);
  }

  private detachSharedFragment(): void {
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    if (!params.has('trip')) return;
    params.delete('trip');
    url.hash = params.toString().replaceAll('%2F', '/');
    try { history.replaceState(null, '', url); } catch { /* shared-frame history can be restricted */ }
  }

  restoreShared(): boolean {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('trip');
    if (!fragment || fragment === this.lastSharedFragment) return false;
    this.lastSharedFragment = fragment;
    try {
      if (fragment.length > 20000 || !/^[A-Za-z0-9_-]+$/.test(fragment)) throw new Error('Invalid trip');
      const bytes = Uint8Array.from(atob(fragment.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (payload?.v !== 1 || !Array.isArray(payload.stops) || !payload.stops.length) throw new Error('Invalid trip');
      const incoming = validateSavedData({ version: 1, favorites: this.state.favorites, stops: payload.stops });
      const same = JSON.stringify(this.state.stops.map(({ id, stay_min }) => [id, stay_min]))
        === JSON.stringify(incoming.stops.map(({ id, stay_min }) => [id, stay_min]));
      if (same) this.detachSharedFragment();
      else if (!this.state.stops.length && this.store.status === 'saved') {
        void this.change(data => { data.stops = incoming.stops; }, `공유 코스 ${incoming.stops.length}곳을 저장했어요.`);
      } else {
        this.detachSharedFragment();
        queueMicrotask(() => this.management.reviewImport(incoming, '공유 주소의 코스'));
      }
      return true;
    } catch {
      this.notify('공유 코스 주소가 올바르지 않아 불러오지 않았어요.');
      return false;
    }
  }

  private async share(): Promise<void> {
    if (!this.state.stops.length) return;
    const payload = {
      v: 1,
      stops: this.state.stops.map((place) => ({
        id: place.id, name: place.name, lng: place.lng, lat: place.lat, category: place.category,
        ...(place.name_en ? { name_en: place.name_en } : {}),
        source: place.source, source_label: place.source_label, base_note: place.base_note?.slice(0, 250) ?? null,
        updated_at: place.updated_at, stay_min: place.stay_min,
        sources: place.sources.slice(0, 3).map(({ source, url, observed_at, license }) => ({ source, url, observed_at, license })),
      })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    if (encoded.length > 20000) { this.notify('출처 정보가 많아 공유 주소가 길어졌어요. 장소 수를 줄여 주세요.'); return; }
    const url = new URL(this.shareCamera());
    const params = new URLSearchParams(url.hash.slice(1));
    params.set('trip', encoded);
    url.hash = params.toString().replaceAll('%2F', '/');
    await this.copy(url.toString());
    this.detachSharedFragment();
  }

  private async nearestNext(): Promise<void> {
    if (this.state.stops.length < 3) return;
    await this.change(data => {
      const remaining = [...data.stops];
      const ordered = remaining.length ? [remaining.shift()!] : [];
      while (remaining.length) {
        const last = ordered[ordered.length - 1];
        let nearest = 0;
        for (let i = 1; i < remaining.length; i++) {
          if (distanceMeters(last, remaining[i]) < distanceMeters(last, remaining[nearest])) nearest = i;
        }
        ordered.push(remaining.splice(nearest, 1)[0]);
      }
      data.stops = ordered;
    }, '첫 장소를 고정하고, 다음에 가까운 장소부터 정렬해 저장했어요.');
  }

  private async handleClick(event: MouseEvent): Promise<void> {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (action === 'data') { this.management.open(); return; }
    if (action === 'share') { void this.share(); return; }
    if (action === 'nearest') { await this.nearestNext(); return; }
    if (!id) return;
    const index = this.state.stops.findIndex((place) => place.id === id);
    const place = this.state.stops[index] ?? this.state.favorites.find((item) => item.id === id);
    if (!place) return;
    if (action === 'select') { this.onSelect(place); return; }
    if (action === 'add') { await this.add(place); return; }
    if (action === 'favorite') { await this.toggleFavorite(place); return; }
    await this.change(data => {
      const current = data.stops.findIndex(place => place.id === id);
      if (action === 'remove' && current >= 0) data.stops.splice(current, 1);
      if (action === 'up' && current > 0) [data.stops[current - 1], data.stops[current]] = [data.stops[current], data.stops[current - 1]];
      if (action === 'down' && current >= 0 && current < data.stops.length - 1) [data.stops[current + 1], data.stops[current]] = [data.stops[current], data.stops[current + 1]];
    });
    const target = this.root.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"][data-action="${action}"]:not(:disabled)`)
      ?? this.root.querySelector<HTMLButtonElement>('.trip-place-name, #trip-data');
    target?.focus({ preventScroll: true });
  }

  render(): void {
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.id;
    const stayId = focused?.dataset.stay;
    const distance = this.state.stops.reduce((sum, stop, index, stops) => index ? sum + distanceMeters(stops[index - 1], stop) : sum, 0);
    const stay = this.state.stops.reduce((sum, stop) => sum + stop.stay_min, 0);
    this.root.innerHTML = `
      <div class="panel-intro"><span class="eyebrow">YOUR ISLAND ITINERARY</span><h2>마음에 담은 제주</h2><p>장소를 모으고, 나만의 순서로 이어 보세요.</p></div>
      <div class="trip-summary"><strong>${this.state.stops.length}<span> / 12곳</span></strong><span>직선 합계 ${distanceLabel(distance)}<br>계획 체류 ${stay}분 · 이동시간 별도</span></div>
      <div class="trip-toolbar"><button id="trip-nearest" data-action="nearest" ${this.state.stops.length < 3 ? 'disabled' : ''}>${icon('route')}가까운 순서</button><button id="trip-share" data-action="share" ${!this.state.stops.length ? 'disabled' : ''}>${icon('share')}코스 공유</button><button id="trip-data" data-action="data">${icon('layers')}자료 관리</button></div>
      <p class="micro-note">첫 장소 기준으로 가까운 다음 장소를 선택합니다. 지도 선과 거리는 직선 기준이며 도로 길 안내를 제공하지 않습니다.</p>
      <ol id="trip-stops" class="trip-stops">${this.state.stops.map((stop, index) => `
        <li data-trip-id="${html(stop.id)}"><span class="trip-number">${index + 1}</span><div class="trip-stop-main"><button class="trip-place-name" data-i18n-ignore data-action="select" data-id="${html(stop.id)}">${html(placeName(stop))}</button><span class="micro-note">${html(categoryName(stop.category))} · ${html(stop.source_label)}</span><label class="trip-stay">계획 체류 <input type="number" min="0" max="720" step="5" value="${stop.stay_min}" data-stay="${html(stop.id)}" aria-label="${html(placeName(stop))} 체류 시간"> 분</label></div><div class="trip-reorder"><button data-action="up" data-id="${html(stop.id)}" aria-label="${html(placeName(stop))} 위로" ${index === 0 ? 'disabled' : ''}>↑</button><button data-action="down" data-id="${html(stop.id)}" aria-label="${html(placeName(stop))} 아래로" ${index === this.state.stops.length - 1 ? 'disabled' : ''}>↓</button><button data-action="remove" data-id="${html(stop.id)}" aria-label="${html(placeName(stop))} 코스에서 제거">${icon('close')}</button></div></li>`).join('')}</ol>
      ${!this.state.stops.length ? '<div class="feature-empty">지도에서 장소를 선택하고<br>‘내 여행에 담기’를 눌러 보세요.</div>' : ''}
      <p id="trip-save-status" class="saved-notice${this.store.status !== 'saved' ? ' is-unsaved' : ''}" role="status">${html(savedStatusMessage(this.store.status))}</p>
      <div class="panel-section-heading"><h3>즐겨찾기</h3><span>${this.state.favorites.length}곳</span></div>
      <div id="favorite-list">${this.state.favorites.map((place) => `<div class="favorite-row"><div><button data-i18n-ignore data-action="select" data-id="${html(place.id)}">${html(placeName(place))}</button><span>${html(place.source_label)} · 저장 정보 기준 ${html(dateLabel(place.updated_at))}</span></div><button data-action="add" data-id="${html(place.id)}" aria-label="${html(placeName(place))} 코스에 추가">${icon('plus')}</button><button data-action="favorite" data-id="${html(place.id)}" aria-label="${html(placeName(place))} 즐겨찾기 해제">${icon('close')}</button></div>`).join('') || '<p class="feature-empty">저장한 즐겨찾기가 없어요.</p>'}</div>
    `;
    if (stayId) this.root.querySelector<HTMLInputElement>(`input[data-stay="${CSS.escape(stayId)}"]`)?.focus({ preventScroll: true });
    else if (focusId) this.root.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`)?.focus({ preventScroll: true });
  }
}
