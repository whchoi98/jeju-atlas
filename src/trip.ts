import type { CatalogPlace, LatLng, PlaceDetail } from '../shared/api-types';
import type { RouteMode, RouteSuccess } from '../shared/routing-types';
import { categoryName, dateLabel, distanceLabel, distanceMeters, html, isJejuPoint } from './api';
import { icon } from './icons';
import { SavedDataStore, savedKey, savedLimits, savedStatusMessage, snapshot, validateSavedData } from './saved-data';
import type { PlaceSnapshot, SavedData, TripStop } from './saved-data';
import { SavedDataUI } from './saved-data-ui';
import { getLocale, placeName, t } from './i18n';
import { RoutingController, routeGPX, routingCopy, routingMarkup } from './routing';
import { EndpointSearch, endpointCopy } from './endpoint-search';
import './routing.css';
import './endpoint-search.css';
export { snapshot } from './saved-data';
export type { PlaceSnapshot, TripStop } from './saved-data';

type TripPlace = CatalogPlace | PlaceDetail | PlaceSnapshot;
const modeKey = 'jeju-atlas.trip-mode.v1';
const mode = (value: unknown): value is RouteMode => value === 'walk' || value === 'car';
function savedMode(): RouteMode {
  try { const value = localStorage.getItem(modeKey); return mode(value) ? value : 'car'; }
  catch { return 'car'; }
}
const copy = {
  ko: {
    title: '마음에 담은 제주', intro: '방문 순서와 체류 시간, 이동 경로를 함께 계획하세요.',
    count: '곳', nearest: '직선 기준 정렬', share: '코스 공유', data: '자료 관리',
    orderNote: '가까운 순서는 직선 거리로 정렬합니다. 실제 이동 거리와 시간은 도보·차량 경로에서 확인하세요.',
    empty: '지도에서 장소를 선택하고 ‘내 여행에 담기’를 눌러 보세요.',
    stay: '계획 체류', minutes: '분', favorites: '즐겨찾기', noFavorites: '저장한 즐겨찾기가 없어요.',
    point: '사용자 지정 위치', center: '지도 중심', current: '현재 위치', savedAt: '저장 정보 기준',
    limit: '한 코스에는 최대 12곳까지 담을 수 있어요.', already: '이미 내 여행에 담긴 장소예요.',
    invalidShare: '공유 코스 주소가 올바르지 않아 불러오지 않았어요.',
    longShare: '출처 정보가 많아 공유 주소가 길어졌어요. 장소 수를 줄여 주세요.',
    shared: '공유 주소의 코스', ordered: '첫 장소를 고정하고 직선으로 가까운 다음 장소부터 정렬했어요.',
    origin: '출발지로 지정했어요.', destination: '도착지로 지정했어요.',
    location_denied: '위치 권한이 거절됐어요. 권한을 허용하거나 지도 중심을 선택해 주세요.',
    location_outside_jeju: '현재 위치가 제주 서비스 범위를 벗어났어요. 지도에서 제주 안의 출발지를 선택해 주세요.',
    location_unavailable: '위치를 확인하지 못했어요. 지도 중심이나 지도에서 고른 장소를 출발지로 선택해 주세요.',
    pointNote: '사용자가 지정한 좌표이며 실제 장소의 이름·주소·운영 정보로 검증되지 않았습니다.',
  },
  en: {
    title: 'Your Jeju trip', intro: 'Plan your stop order, stays and travel routes together.',
    count: 'places', nearest: 'Sort by straight-line proximity', share: 'Share trip', data: 'Manage data',
    orderNote: 'Nearby ordering uses straight-line distances. Walking and driving results show actual route distances and estimates.',
    empty: 'Choose a place on the map, then add it to your trip.',
    stay: 'Planned stay', minutes: 'min', favorites: 'Favorites', noFavorites: 'No favorite places saved yet.',
    point: 'User-selected point', center: 'Map center', current: 'Current location', savedAt: 'Saved information date',
    limit: 'A trip can contain up to 12 places.', already: 'This place is already in your trip.',
    invalidShare: 'This shared trip could not be loaded because its address is invalid.',
    longShare: 'The shared address is too long. Try sharing fewer places.',
    shared: 'Shared trip', ordered: 'Kept the first stop and ordered the rest by straight-line proximity.',
    origin: 'Set as the start point.', destination: 'Set as the finish point.',
    location_denied: 'Location permission was denied. Allow access or choose the map center.',
    location_outside_jeju: 'Your position is outside the Jeju service area. Choose a start point in Jeju on the map.',
    location_unavailable: 'Your position is unavailable. Use the map center or a place selected on the map.',
    pointNote: 'These are user-selected coordinates, not a verified venue name, address or operating information.',
  },
} as const;

export class TripPlanner {
  private store: SavedDataStore;
  private management: SavedDataUI;
  private root: HTMLElement;
  private heading: HTMLElement;
  private content: HTMLElement;
  private endpointSearch: EndpointSearch;
  private notify: (message: string) => void;
  private onChange: (stops: TripStop[]) => void;
  private onSelect: (place: PlaceSnapshot) => void;
  private shareCamera: () => string;
  private copy: (url: string) => Promise<void>;
  private lastSharedFragment = '';
  private routing: RoutingController;
  private routeInputKey = '';
  private getMapCenter?: () => LatLng | null;
  private requestCurrentLocation?: () => Promise<LatLng>;
  private locationGeneration = 0;
  private locating = false;
  private pendingSharedMode: { key: string; mode: RouteMode } | null = null;
  private pendingDestination: TripStop | null = null;
  private get state(): SavedData { return this.store.data; }
  get route(): RouteSuccess | null { return this.routing.route; }
  get hasUnsavedChanges(): boolean { return Boolean(this.pendingDestination) || this.store.hasUnsavedChanges || this.management.hasPendingReview; }
  get isSaved(): boolean { return !this.pendingDestination && this.store.status === 'saved' && !this.store.hasUnsavedChanges; }
  openDataManagement(): void { this.management.open(); }

  constructor(root: HTMLElement, options: {
    notify: (message: string) => void; onChange: (stops: TripStop[]) => void;
    onSelect: (place: PlaceSnapshot) => void; shareCamera: () => string; copy: (url: string) => Promise<void>;
    onRoute?: (route: RouteSuccess | null) => void;
    getMapCenter?: () => LatLng | null;
    requestCurrentLocation?: () => Promise<LatLng>;
    getRecentPlaces?: () => readonly PlaceSnapshot[];
  }) {
    this.root = root;
    this.notify = message => options.notify(t(message));
    this.onChange = options.onChange;
    this.onSelect = options.onSelect;
    this.shareCamera = options.shareCamera;
    this.copy = options.copy;
    this.getMapCenter = options.getMapCenter;
    this.requestCurrentLocation = options.requestCurrentLocation;
    this.store = new SavedDataStore();
    this.routing = new RoutingController({
      mode: savedMode(), onRoute: options.onRoute ?? (() => {}), onChange: () => this.render(),
    });
    this.management = new SavedDataUI(this.store, this.notify, () => {
      this.detachSharedFragment();
      const pending = this.pendingSharedMode;
      this.pendingSharedMode = null;
      if (pending?.key === this.stopKey(this.stops)) this.selectMode(pending.mode);
    });
    // Route responses repaint only the surrounding plan. Keep the search DOM
    // alive while either routing mode completes or the saved plan changes.
    root.innerHTML = '<div data-trip-heading></div><section id="trip-endpoint-search"></section><div data-trip-content></div>';
    this.heading = root.querySelector<HTMLElement>('[data-trip-heading]')!;
    this.content = root.querySelector<HTMLElement>('[data-trip-content]')!;
    this.endpointSearch = new EndpointSearch(root.querySelector<HTMLElement>('#trip-endpoint-search')!, {
      getCenter: this.getMapCenter, getFavorites: () => this.favorites,
      getRecentPlaces: options.getRecentPlaces,
      onPick: (kind, place) => this.setEndpoint(place, kind === 'origin', true),
      onReverse: () => this.reverseOrder(), onClearDraft: () => this.clearPendingDestination(),
    });
    const dialog = document.getElementById('saved-data-dialog');
    dialog?.addEventListener('close', () => { this.pendingSharedMode = null; });
    dialog?.addEventListener('click', event => {
      const id = (event.target as HTMLElement).closest('button')?.id;
      if (id && ['saved-back', 'saved-data-close', 'saved-delete', 'saved-discard', 'saved-backup', 'saved-review-draft'].includes(id)) {
        this.pendingSharedMode = null;
      }
    });
    this.store.subscribe(() => {
      this.syncRouting();
      this.render();
      this.onChange(this.stops);
      window.dispatchEvent(new CustomEvent('atlas:saved-change'));
    });
    window.addEventListener('storage', event => {
      if (event.key === savedKey || event.key === null) this.store.sync();
      if (event.key === modeKey || event.key === null) {
        this.routing.setMode(savedMode());
        this.render();
      }
    });
    window.addEventListener('atlas:locale-change', () => { this.syncRouting(); this.render(); });
    this.root.addEventListener('click', (event) => { void this.handleClick(event); });
    this.root.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.name === 'trip-route-mode' && mode(input.value)) { this.selectMode(input.value); return; }
      if (!input.dataset.stay) return;
      const id = input.dataset.stay;
      const minutes = this.stay(Number(input.value));
      void this.change(data => {
        const stop = data.stops.find(item => item.id === id);
        if (stop) stop.stay_min = minutes;
      });
    });
    this.restoreShared();
    this.syncRouting();
    this.render();
    this.onChange(this.stops);
  }

  private stay(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(720, Math.round(value))) : 60;
  }

  private stopKey(stops: readonly TripStop[]): string {
    return JSON.stringify(stops.map(({ id, lat, lng, stay_min }) => [id, lat, lng, stay_min]));
  }

  private syncRouting(): void {
    const stops = this.stops;
    // Names and dwell times are plan metadata, not route/DEM inputs.
    const key = JSON.stringify([getLocale(), stops.map(({ lng, lat }) => [lng, lat])]);
    if (key === this.routeInputKey) return;
    this.routeInputKey = key;
    this.routing.setInput(stops, getLocale());
  }

  private selectMode(value: RouteMode): void {
    this.detachSharedFragment();
    this.routing.setMode(value);
    try { localStorage.setItem(modeKey, value); }
    catch { this.notify(routingCopy[getLocale()].modeUnsaved); }
    this.render();
  }

  async setOrigin(place: TripPlace): Promise<void> { await this.setEndpoint(place, true); }
  async setDestination(place: TripPlace): Promise<void> { await this.setEndpoint(place, false); }

  private endpointStops(stops: TripStop[], next: PlaceSnapshot, first: boolean, replace: boolean, pending: TripStop | null): TripStop[] {
    const existing = stops.find(stop => stop.id === next.id);
    const boundary = first ? stops[0] : stops.length > 1 ? stops.at(-1) : undefined;
    const opposite = first ? stops.length > 1 ? stops.at(-1) : undefined : stops[0];
    if ((first && pending?.id === next.id) || (replace && opposite?.id === next.id)
      || (!first && stops.length === 1 && existing)) throw new Error('same_endpoint');
    const point = next.id.startsWith('point:') && next.source === 'user_point';
    const replacePoint = first && point && !existing && stops[0]?.source === 'user_point';
    const removedBoundary = replace ? boundary?.id : replacePoint ? stops[0]?.id : undefined;
    const result = stops.filter(stop => stop.id !== next.id && stop.id !== removedBoundary
      && (!first || stop.id !== pending?.id));
    const chosen = {
      ...next,
      sources: next.sources.length ? next.sources : existing?.sources ?? [],
      stay_min: existing?.stay_min ?? (point ? 0 : 60),
    };
    if (first) result.unshift(chosen);
    else result.push(chosen);
    if (first && pending) result.push(stops.find(stop => stop.id === pending.id) ?? pending);
    if (result.length > savedLimits.stops) throw new Error('endpoint_limit');
    return result;
  }

  private async setEndpoint(place: TripPlace, first: boolean, replace = false): Promise<boolean> {
    let next: PlaceSnapshot;
    try { next = snapshot(place); }
    catch { this.notify(copy[getLocale()].location_outside_jeju); return false; }
    if (!first && !this.state.stops.length) {
      this.detachSharedFragment();
      this.pendingSharedMode = null;
      this.locationGeneration++;
      this.locating = false;
      this.pendingDestination = { ...next, stay_min: next.source === 'user_point' ? 0 : 60 };
      this.routeInputKey = '';
      this.routing.invalidate();
      this.render();
      this.notify(endpointCopy[getLocale()].pending);
      return true;
    }
    try { this.endpointStops(this.state.stops, next, first, replace, this.pendingDestination); }
    catch (error) {
      this.notify((error as Error).message === 'endpoint_limit' ? copy[getLocale()].limit : endpointCopy[getLocale()].samePlace);
      return false;
    }
    return this.change(data => {
      // Recheck against the latest saved revision under SavedDataStore's lock.
      // Consume the pending finish only when this mutation actually runs.
      data.stops = this.endpointStops(data.stops, next, first, replace, this.pendingDestination);
      if (first) this.pendingDestination = null;
    }, copy[getLocale()][first ? 'origin' : 'destination'], true);
  }

  private clearPendingDestination(): void {
    this.pendingDestination = null;
    this.locationGeneration++;
    this.locating = false;
    this.syncRouting();
    this.render();
  }

  async reverseOrder(): Promise<void> {
    if (this.pendingDestination || this.state.stops.length < 2) return;
    await this.change(data => { data.stops.reverse(); }, endpointCopy[getLocale()].reversed, true);
  }

  private async chooseOrigin(current: boolean): Promise<void> {
    if (current ? !this.requestCurrentLocation : !this.getMapCenter) return;
    const generation = ++this.locationGeneration;
    this.locating = current;
    this.routeInputKey = '';
    this.routing.invalidate();
    this.render();
    try {
      const point = current ? await this.requestCurrentLocation!() : this.getMapCenter!();
      if (generation !== this.locationGeneration) return;
      if (!point) throw { code: 'location_unavailable' };
      if (!isJejuPoint(point.lng, point.lat)) throw { code: 'location_outside_jeju' };
      const labels = copy[getLocale()];
      await this.setOrigin({
        id: `point:${crypto.randomUUID()}`, name: current ? copy.ko.current : copy.ko.center,
        name_en: current ? copy.en.current : copy.en.center,
        lat: point.lat, lng: point.lng, category: 'other', source: 'user_point', source_label: labels.point,
        base_note: labels.pointNote, address: null, summary: labels.pointNote, updated_at: null,
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] }, sources: [],
      });
    } catch (error) {
      if (generation !== this.locationGeneration) return;
      const failure = error as { code?: unknown; message?: unknown; name?: string };
      const known = ['location_denied', 'location_outside_jeju', 'location_unavailable'];
      const code = known.includes(failure?.code as string) ? failure.code
        : known.includes(failure?.message as string) ? failure.message : failure?.code;
      const reason = code === 'location_denied' || code === 1 || (error as Error)?.name === 'NotAllowedError'
        ? 'location_denied' : code === 'location_outside_jeju' ? 'location_outside_jeju' : 'location_unavailable';
      this.notify(copy[getLocale()][reason]);
    } finally {
      if (generation === this.locationGeneration) {
        this.locating = false;
        this.syncRouting();
        this.render();
      }
    }
  }

  get stops(): TripStop[] { return this.state.stops.map((item) => ({ ...item })); }
  get favorites(): readonly PlaceSnapshot[] { return this.state.favorites; }
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
    if (this.pendingDestination && !this.state.stops.length) { await this.setOrigin(place); return; }
    if (this.hasStop(place.id)) { this.notify(copy[getLocale()].already); return; }
    if (this.state.stops.length >= savedLimits.stops) { this.notify(copy[getLocale()].limit); return; }
    await this.change(data => {
      if (!data.stops.some(item => item.id === place.id)) data.stops.push({ ...snapshot(place), stay_min: 60 });
    }, t(`${placeName(place)}, 내 여행에 저장했어요.`), true);
  }

  private async change(change: (data: SavedData) => void, message?: string, routeInput = false): Promise<boolean> {
    this.detachSharedFragment();
    this.pendingSharedMode = null;
    if (routeInput) {
      this.locationGeneration++;
      this.locating = false;
      this.routeInputKey = '';
      this.routing.invalidate();
    }
    const result = await this.store.update(change);
    if (!result.ok) this.notify(t(savedStatusMessage(result.reason)));
    else if (message) this.notify(message);
    return result.ok;
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
      const sharedMode = payload.mode === undefined ? 'car' : payload.mode;
      if (!mode(sharedMode)) throw new Error('Invalid mode');
      const incoming = validateSavedData({ version: 1, favorites: this.state.favorites, stops: payload.stops });
      const same = this.stopKey(this.stops) === this.stopKey(incoming.stops);
      if (same) { this.selectMode(sharedMode); this.detachSharedFragment(); }
      else if (!this.state.stops.length && this.store.status === 'saved') {
        this.selectMode(sharedMode);
        void this.change(data => { data.stops = incoming.stops; }, t(`공유 코스 ${incoming.stops.length}곳을 저장했어요.`), true);
      } else {
        this.detachSharedFragment();
        this.pendingSharedMode = { key: this.stopKey(incoming.stops), mode: sharedMode };
        queueMicrotask(() => this.management.reviewImport(incoming, `${copy[getLocale()].shared} · ${routingCopy[getLocale()][sharedMode]}`));
      }
      return true;
    } catch {
      this.notify(copy[getLocale()].invalidShare);
      return false;
    }
  }

  private async share(): Promise<void> {
    if (!this.state.stops.length) return;
    const payload = {
      v: 1,
      mode: this.routing.mode,
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
    if (encoded.length > 20000) { this.notify(copy[getLocale()].longShare); return; }
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
    }, copy[getLocale()].ordered, true);
  }

  private async handleClick(event: MouseEvent): Promise<void> {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button) return;
    const id = button.dataset.id;
    const action = button.dataset.action;
    if (action === 'data') { this.management.open(); return; }
    if (action === 'share') { void this.share(); return; }
    if (action === 'nearest') { await this.nearestNext(); return; }
    if (action === 'route-retry') { this.routing.retry(); return; }
    if (action === 'route-map-origin') { await this.chooseOrigin(false); return; }
    if (action === 'route-current-origin') { await this.chooseOrigin(true); return; }
    if (action === 'route-gpx' && this.route) {
      const url = URL.createObjectURL(new Blob([routeGPX(this.route, this.stops.map(placeName).join(' → '), getLocale())],
        { type: 'application/gpx+xml;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `jeju-atlas-${this.route.mode}.gpx`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if ((action === 'route-fit' || action === 'route-preview') && this.route) {
      window.dispatchEvent(new CustomEvent(action === 'route-fit' ? 'atlas:fit-route' : 'atlas:preview-route',
        { detail: { coordinates: this.route.coordinates } }));
      return;
    }
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
    }, undefined, true);
    const target = this.root.querySelector<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"][data-action="${action}"]:not(:disabled)`)
      ?? this.root.querySelector<HTMLButtonElement>('.trip-place-name, #trip-data');
    target?.focus({ preventScroll: true });
  }

  render(): void {
    const locale = getLocale();
    const labels = copy[locale];
    const routes = routingCopy[locale];
    const state = this.state;
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.id;
    const stayId = focused?.dataset.stay;
    const opened = [...this.root.querySelectorAll<HTMLDetailsElement>('details[data-route-leg][open]')].map(item => item.dataset.routeLeg);
    const distance = state.stops.reduce((sum, stop, index, stops) => index ? sum + distanceMeters(stops[index - 1], stop) : sum, 0);
    const stay = state.stops.reduce((sum, stop) => sum + stop.stay_min, 0);
    const sourceLabel = (place: PlaceSnapshot) => place.source === 'user_point' ? labels.point : t(place.source_label);
    this.heading.innerHTML = `
      <div class="panel-intro" data-i18n-ignore><span class="eyebrow">YOUR ISLAND ITINERARY</span><h2>${labels.title}</h2><p>${labels.intro}</p></div>
      <div class="trip-summary"><strong>${state.stops.length}<span> / 12 ${labels.count}</span></strong><span>${locale === 'en' ? 'Straight-line total' : '직선 합계'} ${distanceLabel(distance)}<br>${labels.stay} ${stay}${locale === 'en' ? ' min' : '분'}</span></div>
    `;
    this.endpointSearch.update({
      origin: state.stops[0] ?? null,
      destination: this.pendingDestination ?? (state.stops.length > 1 ? state.stops.at(-1)! : null),
      pendingDestination: Boolean(this.pendingDestination),
      canReverse: !this.pendingDestination && state.stops.length > 1,
    });
    this.content.innerHTML = `
      ${this.getMapCenter || this.requestCurrentLocation ? `<div class="route-origin-actions" data-i18n-ignore aria-busy="${this.locating}">
        ${this.getMapCenter ? `<button data-action="route-map-origin">${icon('pin')}${routes.center}</button>` : ''}
        ${this.requestCurrentLocation ? `<button data-action="route-current-origin" ${this.locating ? 'disabled' : ''}>${icon('compass')}${this.locating ? routes.locating : routes.current}</button>` : ''}
      </div>` : ''}
      ${routingMarkup(this.routing, state.stops, locale)}
      <div class="trip-toolbar" data-i18n-ignore><button id="trip-nearest" data-action="nearest" ${state.stops.length < 3 ? 'disabled' : ''}>${icon('route')}${labels.nearest}</button><button id="trip-share" data-action="share" ${!state.stops.length ? 'disabled' : ''}>${icon('share')}${labels.share}</button><button id="trip-data" data-action="data">${icon('layers')}${labels.data}</button></div>
      <p class="micro-note" data-i18n-ignore>${labels.orderNote}</p>
      <ol id="trip-stops" class="trip-stops">${state.stops.map((stop, index) => `
        <li data-trip-id="${html(stop.id)}"><span class="trip-number">${index + 1}</span><div class="trip-stop-main">
        ${index === 0 || index === state.stops.length - 1 ? `<span class="trip-point-role" data-i18n-ignore>${index === 0 ? routes.origin : routes.destination}</span>` : ''}
        <button class="trip-place-name" data-i18n-ignore data-action="select" data-id="${html(stop.id)}">${html(placeName(stop))}</button><span class="micro-note">${html(categoryName(stop.category))} · ${html(sourceLabel(stop))}</span><label class="trip-stay">${labels.stay} <input type="number" min="0" max="720" step="5" value="${stop.stay_min}" data-stay="${html(stop.id)}" aria-label="${html(t(`${placeName(stop)} 체류 시간`))}"> ${labels.minutes}</label></div><div class="trip-reorder"><button data-action="up" data-id="${html(stop.id)}" aria-label="${html(t(`${placeName(stop)} 위로`))}" ${index === 0 ? 'disabled' : ''}>↑</button><button data-action="down" data-id="${html(stop.id)}" aria-label="${html(t(`${placeName(stop)} 아래로`))}" ${index === state.stops.length - 1 ? 'disabled' : ''}>↓</button><button data-action="remove" data-id="${html(stop.id)}" aria-label="${html(t(`${placeName(stop)} 코스에서 제거`))}">${icon('close')}</button></div></li>`).join('')}</ol>
      ${!state.stops.length && !this.pendingDestination ? `<div class="feature-empty" data-i18n-ignore>${labels.empty}</div>` : ''}
      <p id="trip-save-status" class="saved-notice${this.store.status !== 'saved' || this.pendingDestination ? ' is-unsaved' : ''}" role="status">${html(this.pendingDestination ? endpointCopy[locale].pending : t(savedStatusMessage(this.store.status)))}</p>
      <div class="panel-section-heading" data-i18n-ignore><h3>${labels.favorites}</h3><span>${state.favorites.length} ${labels.count}</span></div>
      <div id="favorite-list">${state.favorites.map((place) => `<div class="favorite-row"><div><button data-i18n-ignore data-action="select" data-id="${html(place.id)}">${html(placeName(place))}</button><span>${html(sourceLabel(place))} · ${labels.savedAt} ${html(t(dateLabel(place.updated_at)))}</span></div><button data-action="add" data-id="${html(place.id)}" aria-label="${html(t(`${placeName(place)} 코스에 추가`))}">${icon('plus')}</button><button data-action="favorite" data-id="${html(place.id)}" aria-label="${html(t(`${placeName(place)} 즐겨찾기 해제`))}">${icon('close')}</button></div>`).join('') || `<p class="feature-empty" data-i18n-ignore>${labels.noFavorites}</p>`}</div>
    `;
    for (const index of opened) this.root.querySelector<HTMLDetailsElement>(`details[data-route-leg="${index}"]`)?.setAttribute('open', '');
    if (!focused?.isConnected) {
      if (stayId) this.root.querySelector<HTMLInputElement>(`input[data-stay="${CSS.escape(stayId)}"]`)?.focus({ preventScroll: true });
      else if (focusId) this.root.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`)?.focus({ preventScroll: true });
    }
  }
}
