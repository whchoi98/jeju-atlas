import type { CatalogPlace, PlaceDetail, SourceRecord } from '../shared/api-types';
import { categoryName, dateLabel, distanceLabel, distanceMeters, html, isJejuPoint, safeURL, sourceName } from './api';
import { icon } from './icons';

export interface PlaceSnapshot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  source: string;
  source_label: string;
  base_note: string | null;
  address: string | null;
  summary: string;
  updated_at: string | null;
  geometry: { type: 'Point'; coordinates: [number, number] };
  sources: SourceRecord[];
}
export type TripStop = PlaceSnapshot & { stay_min: number };
type SavedState = { version: 1; favorites: PlaceSnapshot[]; stops: TripStop[] };
const storageKey = 'jeju-atlas.saved.v1';
const maxStops = 12;
const maxFavorites = 100;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, limit) : '';

function sanitizeSnapshot(value: unknown): PlaceSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (!isJejuPoint(item.lng, item.lat)) return null;
  const id = text(item.id, 240);
  const name = text(item.name, 140);
  if (!id || !name || /[<>{}\\]/.test(id)) return null;
  const sources = Array.isArray(item.sources) ? item.sources.slice(0, 16).flatMap((value): SourceRecord[] => {
    if (!value || typeof value !== 'object' || typeof value.source !== 'string') return [];
    return [{
      source: text(value.source, 100), url: safeURL(value.url), observed_at: text(value.observed_at, 50) || null,
      license: text(value.license, 150) || null, note: text(value.note, 400) || null,
    }];
  }) : [];
  return {
    id, name, lat: item.lat as number, lng: item.lng as number,
    category: text(item.category, 80) || 'other', source: text(item.source, 120) || 'unknown',
    source_label: text(item.source_label, 160) || sourceName(text(item.source, 120)),
    base_note: text(item.base_note, 700) || null, address: text(item.address, 400) || null,
    summary: text(item.summary, 1200), updated_at: text(item.updated_at, 50) || null,
    geometry: { type: 'Point', coordinates: [item.lng as number, item.lat as number] }, sources,
  };
}

export function snapshot(place: CatalogPlace | PlaceDetail | PlaceSnapshot): PlaceSnapshot {
  const result = sanitizeSnapshot(place);
  if (!result) throw new Error('Invalid place snapshot');
  return result;
}

export class TripPlanner {
  private state: SavedState = { version: 1, favorites: [], stops: [] };
  private root: HTMLElement;
  private notify: (message: string) => void;
  private onChange: (stops: TripStop[]) => void;
  private onSelect: (place: PlaceSnapshot) => void;
  private shareCamera: () => string;
  private copy: (url: string) => Promise<void>;
  private storageAvailable = true;
  private lastSharedFragment = '';

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
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored && stored.length <= 700000) {
        const parsed = JSON.parse(stored);
        if (parsed?.version === 1) {
          this.state.favorites = this.cleanList(parsed.favorites, maxFavorites);
          this.state.stops = this.cleanList(parsed.stops, maxStops).map((place) => {
            const raw = parsed.stops.find((stop: { id?: string }) => stop?.id === place.id);
            return { ...place, stay_min: this.stay(raw?.stay_min) };
          });
        }
      }
    } catch {
      this.storageAvailable = false;
      this.notify('브라우저 저장 공간을 읽지 못했어요. 현재 화면에서는 코스를 편집할 수 있어요.');
    }
    this.root.addEventListener('click', (event) => this.handleClick(event));
    this.root.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.dataset.stay) return;
      const stop = this.state.stops.find((item) => item.id === input.dataset.stay);
      if (stop) {
        stop.stay_min = this.stay(Number(input.value));
        this.save();
      }
    });
    this.restoreShared();
    this.render();
    this.onChange(this.stops);
  }

  private cleanList(value: unknown, limit: number): PlaceSnapshot[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.slice(0, limit).flatMap((value) => {
      const place = sanitizeSnapshot(value);
      if (!place || seen.has(place.id)) return [];
      seen.add(place.id);
      return [place];
    });
  }

  private stay(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(720, Math.round(value))) : 60;
  }

  get stops(): TripStop[] { return this.state.stops.map((item) => ({ ...item })); }
  isFavorite(id: string): boolean { return this.state.favorites.some((place) => place.id === id); }
  hasStop(id: string): boolean { return this.state.stops.some((place) => place.id === id); }

  toggleFavorite(place: CatalogPlace | PlaceDetail | PlaceSnapshot): void {
    const index = this.state.favorites.findIndex((item) => item.id === place.id);
    if (index >= 0) this.state.favorites.splice(index, 1);
    else {
      if (this.state.favorites.length >= maxFavorites) { this.notify('즐겨찾기는 최대 100곳까지 저장할 수 있어요.'); return; }
      this.state.favorites.push(snapshot(place));
    }
    this.save();
    this.notify(index >= 0 ? '즐겨찾기에서 뺐어요.' : '즐겨찾기에 저장했어요.');
  }

  add(place: CatalogPlace | PlaceDetail | PlaceSnapshot): void {
    if (this.hasStop(place.id)) { this.notify('이미 내 여행에 담긴 장소예요.'); return; }
    if (this.state.stops.length >= maxStops) { this.notify('한 코스에는 최대 12곳까지 담을 수 있어요.'); return; }
    this.state.stops.push({ ...snapshot(place), stay_min: 60 });
    this.save();
    this.notify(`${place.name}, 내 여행에 담았어요.`);
  }

  private save(): void {
    try {
      const serialized = JSON.stringify(this.state);
      if (serialized.length > 700000) throw new Error('Saved trip storage limit');
      localStorage.setItem(storageKey, serialized);
      this.storageAvailable = true;
    } catch {
      this.storageAvailable = false;
      this.notify('브라우저에 저장하지 못했어요. 코스 주소를 복사해 보관해 주세요.');
    }
    this.render();
    this.onChange(this.stops);
    window.dispatchEvent(new CustomEvent('atlas:saved-change'));
  }

  restoreShared(): boolean {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('trip');
    if (!fragment || fragment === this.lastSharedFragment) return false;
    this.lastSharedFragment = fragment;
    try {
      if (fragment.length > 20000 || !/^[A-Za-z0-9_-]+$/.test(fragment)) throw new Error('Invalid trip');
      const bytes = Uint8Array.from(atob(fragment.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (payload?.v !== 1 || !Array.isArray(payload.stops) || !payload.stops.length || payload.stops.length > maxStops) throw new Error('Invalid trip');
      const restored = this.cleanList(payload.stops, maxStops);
      if (restored.length !== payload.stops.length) throw new Error('Invalid stops');
      this.state.stops = restored.map((place, index) => ({ ...place, stay_min: this.stay(payload.stops[index].stay_min) }));
      this.save();
      this.notify(`공유 코스 ${restored.length}곳을 불러왔어요.`);
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
  }

  private nearestNext(): void {
    if (this.state.stops.length < 3) return;
    const remaining = [...this.state.stops];
    const ordered = [remaining.shift()!];
    while (remaining.length) {
      const last = ordered[ordered.length - 1];
      let nearest = 0;
      for (let i = 1; i < remaining.length; i++) {
        if (distanceMeters(last, remaining[i]) < distanceMeters(last, remaining[nearest])) nearest = i;
      }
      ordered.push(remaining.splice(nearest, 1)[0]);
    }
    this.state.stops = ordered;
    this.save();
    this.notify('첫 장소를 고정하고, 다음에 가까운 장소부터 정렬했어요.');
  }

  private handleClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (action === 'share') { void this.share(); return; }
    if (action === 'nearest') { this.nearestNext(); return; }
    if (!id) return;
    const index = this.state.stops.findIndex((place) => place.id === id);
    const place = this.state.stops[index] ?? this.state.favorites.find((item) => item.id === id);
    if (!place) return;
    if (action === 'select') { this.onSelect(place); return; }
    if (action === 'add') { this.add(place); return; }
    if (action === 'favorite') { this.toggleFavorite(place); return; }
    if (action === 'remove' && index >= 0) this.state.stops.splice(index, 1);
    if (action === 'up' && index > 0) [this.state.stops[index - 1], this.state.stops[index]] = [this.state.stops[index], this.state.stops[index - 1]];
    if (action === 'down' && index >= 0 && index < this.state.stops.length - 1) [this.state.stops[index + 1], this.state.stops[index]] = [this.state.stops[index], this.state.stops[index + 1]];
    this.save();
    this.root.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"][data-action="${action}"]`)?.focus();
  }

  render(): void {
    const distance = this.state.stops.reduce((sum, stop, index, stops) => index ? sum + distanceMeters(stops[index - 1], stop) : sum, 0);
    const stay = this.state.stops.reduce((sum, stop) => sum + stop.stay_min, 0);
    this.root.innerHTML = `
      <div class="panel-intro"><span class="eyebrow">YOUR ISLAND ITINERARY</span><h2>마음에 담은 제주</h2><p>장소를 모으고, 나만의 순서로 이어 보세요.</p></div>
      <div class="trip-summary"><strong>${this.state.stops.length}<span> / 12곳</span></strong><span>직선 합계 ${distanceLabel(distance)}<br>계획 체류 ${stay}분 · 이동시간 별도</span></div>
      <div class="trip-toolbar"><button id="trip-nearest" data-action="nearest" ${this.state.stops.length < 3 ? 'disabled' : ''}>${icon('route')}가까운 순서</button><button id="trip-share" data-action="share" ${!this.state.stops.length ? 'disabled' : ''}>${icon('share')}코스 공유</button></div>
      <p class="micro-note">첫 장소 기준으로 가까운 다음 장소를 선택합니다. 지도 선과 거리는 직선 기준이며 도로 길 안내를 제공하지 않습니다.</p>
      <ol id="trip-stops" class="trip-stops">${this.state.stops.map((stop, index) => `
        <li data-trip-id="${html(stop.id)}"><span class="trip-number">${index + 1}</span><div class="trip-stop-main"><button class="trip-place-name" data-action="select" data-id="${html(stop.id)}">${html(stop.name)}</button><span class="micro-note">${html(categoryName(stop.category))} · ${html(stop.source_label)}</span><label class="trip-stay">계획 체류 <input type="number" min="0" max="720" step="5" value="${stop.stay_min}" data-stay="${html(stop.id)}" aria-label="${html(stop.name)} 체류 시간"> 분</label></div><div class="trip-reorder"><button data-action="up" data-id="${html(stop.id)}" aria-label="${html(stop.name)} 위로" ${index === 0 ? 'disabled' : ''}>↑</button><button data-action="down" data-id="${html(stop.id)}" aria-label="${html(stop.name)} 아래로" ${index === this.state.stops.length - 1 ? 'disabled' : ''}>↓</button><button data-action="remove" data-id="${html(stop.id)}" aria-label="${html(stop.name)} 코스에서 제거">${icon('close')}</button></div></li>`).join('')}</ol>
      ${!this.state.stops.length ? '<div class="feature-empty">지도에서 장소를 선택하고<br>‘내 여행에 담기’를 눌러 보세요.</div>' : ''}
      <p class="saved-notice">${this.storageAvailable ? '이 브라우저에 장소 좌표와 출처를 함께 저장합니다.' : '현재 브라우저 저장 불가 · 코스 주소로 보관해 주세요.'}</p>
      <div class="panel-section-heading"><h3>즐겨찾기</h3><span>${this.state.favorites.length}곳</span></div>
      <div id="favorite-list">${this.state.favorites.map((place) => `<div class="favorite-row"><div><button data-action="select" data-id="${html(place.id)}">${html(place.name)}</button><span>${html(place.source_label)} · 저장 정보 기준 ${html(dateLabel(place.updated_at))}</span></div><button data-action="add" data-id="${html(place.id)}" aria-label="${html(place.name)} 코스에 추가">${icon('plus')}</button><button data-action="favorite" data-id="${html(place.id)}" aria-label="${html(place.name)} 즐겨찾기 해제">${icon('close')}</button></div>`).join('') || '<p class="feature-empty">저장한 즐겨찾기가 없어요.</p>'}</div>
    `;
  }
}
