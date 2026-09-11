import type { CatalogPlace, GuideMap } from '../shared/api-types';
import type { RouteSuccess } from '../shared/routing-types';
import type { AtlasMap } from './map';
import type { PlaceSnapshot, TripStop } from './trip';
import { TripPlanner } from './trip';
import { CatalogMap } from './catalog-map';
import { CatalogUI } from './catalog-ui';
import { GuidePanel } from './guide';
import { categoryName, distanceLabel, html, isJejuPoint } from './api';
import { initializePWA } from './pwa';
import { categorySymbol, icon } from './icons';
import { getLocale, placeName } from './i18n';
import './explore.css';
import './mobility.css';

interface ExperienceOptions {
  atlas: () => AtlasMap | undefined;
  closeDrawer: () => void;
  openDrawer: () => void;
  stopTour: () => void;
  notify: (message: string) => void;
  cameraURL: () => string;
  copyURL: (url: string, message: string) => Promise<void>;
}

export class AtlasExperience {
  readonly planner: TripPlanner;
  readonly catalog: CatalogUI;
  readonly guide: GuidePanel;
  private layers: CatalogMap | undefined;
  private options: ExperienceOptions;
  private tripStops: TripStop[] = [];
  private activeRoute: RouteSuccess | null = null;
  private recommendation: GuideMap | undefined;
  private selectedCatalog: CatalogPlace | PlaceSnapshot | undefined;
  private isCatalogSelection = false;
  private activeTab = 'explore';
  private panelResizeFrame: number | undefined;

  constructor(options: ExperienceOptions) {
    this.options = options;
    document.body.classList.add('has-catalog');
    document.body.dataset.activePanel = this.activeTab;
    const sidebar = document.querySelector<HTMLElement>('#sidebar-content')!;
    const legacy = sidebar.querySelector<HTMLElement>('.explorer')!;
    const intro = sidebar.querySelector<HTMLElement>('.sidebar-intro')!;
    intro.innerHTML = `<div class="eyebrow"><span class="eyebrow-line"></span> AN ISLAND, IN PERSPECTIVE</div><h1><span>제주를 펼치고,</span> <span>나만의</span> <em>여행으로.</em></h1>`;
    const tabs = document.createElement('div');
    tabs.className = 'sidebar-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '제주 탐색 도구');
    tabs.innerHTML = `<button id="tab-explore" role="tab" aria-selected="true" aria-controls="explore-panel" data-panel="explore">${icon('search')}탐색</button><button id="tab-trip" role="tab" aria-selected="false" aria-controls="trip-panel" data-panel="trip" tabindex="-1">${icon('route')}내 여행<span id="trip-tab-count">0</span></button><button id="tab-guide" role="tab" aria-selected="false" aria-controls="guide-panel" data-panel="guide" tabindex="-1">${icon('globe')}AI 가이드</button>`;
    const browse = document.createElement('section');
    browse.id = 'explore-panel';
    browse.className = 'experience-panel explore-panel';
    browse.setAttribute('role', 'tabpanel');
    browse.setAttribute('aria-labelledby', 'tab-explore');
    const catalogRoot = document.createElement('div');
    catalogRoot.id = 'catalog-explorer';
    const quick = document.createElement('details');
    quick.id = 'terrain-quickplaces';
    quick.className = 'terrain-quickplaces';
    quick.innerHTML = `<summary>${icon('mountain')}지형 명소 빠르게 보기 <span>12곳</span>${icon('chevronDown')}</summary>`;
    quick.append(legacy);
    browse.append(catalogRoot, quick);
    const trip = document.createElement('section');
    trip.id = 'trip-panel'; trip.className = 'experience-panel trip-panel'; trip.hidden = true;
    trip.setAttribute('role', 'tabpanel'); trip.setAttribute('aria-labelledby', 'tab-trip');
    const guide = document.createElement('section');
    guide.id = 'guide-panel'; guide.className = 'experience-panel guide-panel'; guide.hidden = true;
    guide.setAttribute('role', 'tabpanel'); guide.setAttribute('aria-labelledby', 'tab-guide');
    intro.after(tabs, browse, trip, guide);
    const footer = sidebar.querySelector<HTMLElement>('.sidebar-footer')!;
    footer.classList.add('experience-footer');
    initializePWA(footer, options.notify, { isBusy: () => Boolean(this.planner?.hasUnsavedChanges || this.guide?.hasUnsavedWork) });
    const detail = document.createElement('section');
    detail.id = 'catalog-detail'; detail.className = 'catalog-detail'; detail.hidden = true;
    detail.setAttribute('role', 'region'); detail.setAttribute('aria-label', '카탈로그 장소 상세');
    document.querySelector('.map-shell')!.append(detail);
    const routeInfo = document.createElement('div');
    routeInfo.id = 'trip-map-caption'; routeInfo.className = 'trip-map-caption'; routeInfo.hidden = true;
    document.querySelector('.map-shell')!.append(routeInfo);
    const guideCaption = document.createElement('div');
    guideCaption.id = 'guide-map-caption'; guideCaption.className = 'guide-map-caption'; guideCaption.hidden = true;
    document.querySelector('.map-shell')!.append(guideCaption);

    this.planner = new TripPlanner(trip, {
      notify: options.notify,
      onChange: (stops) => this.setTrip(stops),
      onRoute: (route) => this.setTripRoute(route),
      onSelect: (place) => {
        if (place.id.startsWith('point:')) this.selectCatalog(place);
        else void this.catalog.openPlace(place.id, place);
      },
      shareCamera: options.cameraURL,
      copy: (url) => options.copyURL(url, '장소 순서와 체류 시간이 담긴 코스 주소를 복사했어요.'),
      getMapCenter: () => {
        const center = options.atlas()?.map.getCenter();
        return center && isJejuPoint(center.lng, center.lat) ? { lng: center.lng, lat: center.lat } : null;
      },
      requestCurrentLocation: () => new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject(new Error('location_unavailable')); return; }
        navigator.geolocation.getCurrentPosition(
          position => {
            const { longitude: lng, latitude: lat } = position.coords;
            if (!isJejuPoint(lng, lat)) { reject(new Error('location_outside_jeju')); return; }
            resolve({ lng, lat });
          },
          error => reject(new Error(error.code === 1 ? 'location_denied' : 'location_unavailable')),
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 },
        );
      }),
    });
    this.catalog = new CatalogUI(catalogRoot, detail, {
      center: () => {
        const center = options.atlas()?.map.getCenter();
        return center ? { lng: center.lng, lat: center.lat } : { lng: 126.56, lat: 33.38 };
      },
      bounds: () => {
        const bounds = options.atlas()?.map.getBounds();
        return bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] : [125.8, 32.9, 127.1, 34.1];
      },
      onPoints: (points) => this.layers?.setPoints(points),
      onSelect: (place) => this.selectCatalog(place),
      onVisibility: (visible) => this.layers?.setVisible(visible),
      planner: this.planner, notify: options.notify, openDrawer: options.openDrawer,
      onReset: () => { options.stopTour(); options.atlas()?.reset(); },
      onTrip: () => { this.showTab('trip'); options.openDrawer(); },
      on3D: (place) => this.selectCatalog(place, true),
    });
    this.guide = new GuidePanel(guide, {
      notify: options.notify,
      onSelect: (id) => { void this.catalog.openPlace(id); },
      onApply: (map) => {
        if (!this.layers) { options.notify('지도가 준비되면 다시 표시해 주세요.'); return; }
        options.stopTour();
        this.recommendation = map;
        this.layers.setGuide(map);
        this.catalog.closeDetail();
        options.closeDrawer();
        guideCaption.hidden = false;
        guideCaption.textContent = map.route_meta?.mode === 'straight'
          ? `AI 추천 · 직선 참고 연결 · ${map.markers.length}곳`
          : `AI 추천 ${map.markers.length}곳 · 경로 정보는 제공 출처를 확인하세요`;
      },
      context: () => {
        const center = options.atlas()?.map.getCenter();
        if (getLocale() === 'en') return `${this.selectedCatalog ? `Selected place ${placeName(this.selectedCatalog)}. ` : ''}${center ? `Map center ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}. ` : ''}${this.tripStops.length ? `My trip ${this.tripStops.map(stop => placeName(stop)).join(', ')}.` : ''}`;
        return `${this.selectedCatalog ? `선택 장소 ${this.selectedCatalog.name}. ` : ''}${center ? `지도 중심 ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}. ` : ''}${this.tripStops.length ? `내 코스 ${this.tripStops.map((stop) => stop.name).join(', ')}.` : ''}`;
      },
    });
    tabs.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((button) => {
      button.addEventListener('click', () => this.showTab(button.dataset.panel!));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const order = ['explore', 'trip', 'guide'];
        const index = order.indexOf(button.dataset.panel!);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        this.showTab(order[next]);
        document.querySelector<HTMLButtonElement>(`#tab-${order[next]}`)!.focus();
      });
    });
    window.addEventListener('atlas:saved-change', () => {
      if (this.isCatalogSelection && this.selectedCatalog) this.renderSelection(this.selectedCatalog);
    });
    window.addEventListener('hashchange', () => {
      if (this.planner.restoreShared()) this.showTab('trip');
    });
    document.getElementById('reset-view')?.addEventListener('click', () => this.catalog.resetFilters(false));
    document.getElementById('brand-home')?.addEventListener('click', () => this.catalog.resetFilters(false));
    window.addEventListener('atlas:fit-route', () => this.fitTripRoute());
    window.addEventListener('beforeunload', event => {
      if (this.planner.hasUnsavedChanges || this.guide.hasUnsavedWork) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  manageData(): void {
    this.showTab('trip');
    this.options.openDrawer();
    this.planner.openDataManagement();
  }
  refreshLocale(): boolean {
    this.renderTripRoute();
    if (!this.isCatalogSelection || !this.selectedCatalog) return false;
    this.renderSelection(this.selectedCatalog);
    this.layers?.setSelection({ ...this.selectedCatalog, name: placeName(this.selectedCatalog) });
    return true;
  }

  showTab(tab: string): void {
    if (!['explore', 'trip', 'guide'].includes(tab)) return;
    const guideTransition = (this.activeTab === 'guide') !== (tab === 'guide');
    this.activeTab = tab;
    document.body.dataset.activePanel = tab;
    for (const id of ['explore', 'trip', 'guide']) {
      const selected = id === tab;
      document.getElementById(`${id}-panel`)!.hidden = !selected;
      const button = document.getElementById(`tab-${id}`)!;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    this.catalog.closeDetail(false);
    if (!guideTransition || matchMedia('(max-width: 760px)').matches) return;
    if (this.panelResizeFrame !== undefined) cancelAnimationFrame(this.panelResizeFrame);
    // Let the map's container observer resize first; repair only a stale canvas.
    this.panelResizeFrame = requestAnimationFrame(() => {
      this.panelResizeFrame = requestAnimationFrame(() => {
        this.panelResizeFrame = undefined;
        const map = this.options.atlas()?.map;
        if (!map) return;
        const container = map.getContainer();
        const canvas = map.getCanvas();
        if (container.clientWidth > 0 && container.clientHeight > 0
          && (canvas.clientWidth !== container.clientWidth || canvas.clientHeight !== container.clientHeight)) {
          map.resize();
        }
      });
    });
  }

  onMapReady(atlas: AtlasMap): void {
    this.layers = new CatalogMap(atlas.map, (id) => {
      const saved = this.tripStops.find((stop) => stop.id === id);
      if (saved && id.startsWith('point:')) { this.selectCatalog(saved); return; }
      const recommended = this.recommendation?.markers.find((marker) => marker.id === id);
      if (recommended && !saved && !this.catalog.pointData.features.some((point) => point.properties.id === id)) {
        const fallback: PlaceSnapshot = {
          ...recommended, source: recommended.source ?? 'unknown', source_label: recommended.source ?? 'AI 추천 · 원문 출처 정보 없음',
          base_note: 'AI 추천 위치입니다. 카탈로그 상세 정보와 공식 자료를 추가로 확인해 주세요.',
          address: null, updated_at: recommended.observed_at, geometry: { type: 'Point', coordinates: [recommended.lng, recommended.lat] },
          sources: [],
        };
        void this.catalog.openPlace(id, fallback);
      } else void this.catalog.openPlace(id, saved);
    });
    this.layers.setTrip(this.tripStops.map(stop => ({ ...stop, name: placeName(stop) })), this.activeRoute);
    window.dispatchEvent(new CustomEvent('atlas:route-change', { detail: { route: this.activeRoute } }));
    if (this.recommendation) this.layers.setGuide(this.recommendation);
    this.catalog.onMapReady();
    atlas.setRepresentativeSelectHandler((place) => {
      if (place.catalogId) void this.catalog.openPlace(place.catalogId);
      else {
        this.showTab('explore');
        this.catalog.browseNearby({ lng: place.coordinates[0], lat: place.coordinates[1] });
      }
    });
    atlas.map.on('moveend', () => this.catalog.onMapMove());
    if (this.isCatalogSelection && this.selectedCatalog) {
      this.layers.setSelection(this.selectedCatalog);
      this.renderSelection(this.selectedCatalog);
    }
  }

  legacySelected(): void {
    this.isCatalogSelection = false;
    this.selectedCatalog = undefined;
    this.layers?.setSelection(null);
    this.catalog.closeDetail();
  }

  searchFocus(): void {
    this.showTab('explore');
    this.options.openDrawer();
    document.getElementById('catalog-search')?.focus();
  }

  private selectCatalog(place: CatalogPlace | PlaceSnapshot, force3D = false): void {
    this.options.stopTour();
    this.isCatalogSelection = true;
    this.selectedCatalog = place;
    this.layers?.setSelection(place);
    const atlas = this.options.atlas();
    if (atlas) {
      atlas.stopRoutePreview();
      if (force3D) {
        atlas.set3D(true);
        atlas.setExaggeration(1);
      }
      atlas.setSelected('');
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      atlas.map.flyTo({
        center: [place.lng, place.lat], zoom: force3D ? 14.4 : Math.max(12.5, Math.min(15, atlas.map.getZoom())),
        pitch: atlas.getState().is3D ? force3D ? 60 : 52 : 0, duration: reduced ? 0 : 1500,
        padding: { top: 40, bottom: matchMedia('(max-width: 760px)').matches ? 170 : 130, left: 0, right: 0 },
      });
    }
    this.options.closeDrawer();
    this.renderSelection(place);
  }

  private renderSelection(place: CatalogPlace | PlaceSnapshot): void {
    const target = document.getElementById('selected-place')!;
    target.innerHTML = `<div class="selected-place-emblem">${icon(categorySymbol(place.category).icon)}</div><div class="selected-place-info"><div class="selected-eyebrow"><span>${html(categoryName(place.category))}</span><span>·</span><span>기본: ${html(place.source_label)}</span></div><div class="selected-title"><h2 data-i18n-ignore>${html(placeName(place))}</h2></div><p>${html(place.address || '주소 정보 없음')}</p></div><button class="catalog-selection-detail" id="selected-catalog-detail">상세 보기 ${icon('chevron')}</button><button class="fly-button" id="selected-add-trip" aria-label="${html(placeName(place))} 내 여행에 담기">${icon(this.planner.hasStop(place.id) ? 'check' : 'plus')}<span>내 여행</span></button>`;
    target.querySelector('#selected-catalog-detail')!.addEventListener('click', () => void this.catalog.openPlace(place.id, 'geometry' in place ? place : undefined));
    target.querySelector('#selected-add-trip')!.addEventListener('click', () => this.planner.add(this.catalog.selection?.id === place.id ? this.catalog.selection : place));
  }

  private setTrip(stops: TripStop[]): void {
    this.tripStops = stops;
    this.renderTripRoute();
    const badge = document.getElementById('trip-tab-count');
    if (badge) badge.textContent = String(stops.length);
    if (this.activeTab === 'trip') document.getElementById('trip-panel')?.setAttribute('aria-label', `내 여행 ${stops.length}곳`);
  }

  private setTripRoute(route: RouteSuccess | null): void {
    this.options.atlas()?.stopRoutePreview();
    this.activeRoute = route;
    this.renderTripRoute();
    window.dispatchEvent(new CustomEvent('atlas:route-change', { detail: { route } }));
  }

  private renderTripRoute(): void {
    this.layers?.setTrip(this.tripStops.map(stop => ({ ...stop, name: placeName(stop) })), this.activeRoute);
    const caption = document.getElementById('trip-map-caption');
    if (!caption) return;
    caption.hidden = !this.tripStops.length;
    caption.setAttribute('data-i18n-ignore', '');
    const english = getLocale() === 'en';
    const route = this.activeRoute;
    const mode = route?.mode === 'walk' ? english ? 'Walk' : '도보' : english ? 'Drive' : '차량';
    caption.dataset.mode = route?.mode ?? '';
    caption.innerHTML = `${icon('route')}${english ? `My trip · ${this.tripStops.length} stops` : `내 여행 ${this.tripStops.length}곳`}${route
      ? ` · ${mode} ${html(distanceLabel(route.distance_m))} · ${Math.ceil(route.duration_s / 60)}${english ? ' min' : '분'}`
      : ''}`;
  }

  private fitTripRoute(): void {
    const atlas = this.options.atlas();
    const points = this.activeRoute?.coordinates;
    if (!atlas || !points?.length) return;
    this.options.stopTour();
    atlas.stopRoutePreview();
    this.catalog.closeDetail(false);
    this.options.closeDrawer();
    let west = points[0][0], east = west, south = points[0][1], north = south;
    for (const [lng, lat] of points) {
      west = Math.min(west, lng); east = Math.max(east, lng);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    atlas.map.fitBounds([[west, south], [east, north]], {
      padding: { top: 85, right: 65, bottom: 185, left: 45 },
      maxZoom: 15, pitch: atlas.getState().is3D ? 40 : 0,
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900,
    });
  }
}
