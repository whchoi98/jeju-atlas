import type { CatalogPlace, CatalogStatus, PlaceDetail, SourceRecord, WeatherResult } from '../shared/api-types';
import type { CatalogPoints } from './catalog-map';
import type { PlaceSnapshot, TripPlanner } from './trip';
import { aborted, apiJSON, catalogBounds, categoryName, dateLabel, distanceLabel, distanceMeters, html, isJejuPoint, link, safeURL, sourceName } from './api';
import { categorySymbol, icon } from './icons';
import { hoursText } from './guide-facts';
import { getLocale, placeName, t } from './i18n';
import { evidenceHTML } from './field-evidence';

interface CatalogOptions {
  center: () => { lng: number; lat: number };
  bounds: () => [number, number, number, number];
  onPoints: (points: CatalogPoints) => void;
  onSelect: (place: CatalogPlace | PlaceSnapshot) => void;
  onVisibility: (visible: boolean) => void;
  planner: TripPlanner;
  notify: (message: string) => void;
  openDrawer: () => void;
  onReset?: () => void;
}

const noData = '정보 없음';
const numberLabel = (value: number | null, unit: string) => value == null || !Number.isFinite(value) ? noData : `${Math.round(value * 10) / 10}${unit}`;
const categoryColor = (category: string) => ['food', 'restaurant', 'cafe', '맛집', '카페', '시장'].includes(category) ? 'food'
  : ['stay', 'hotel', 'accommodation', 'lodging', '숙소', '박물관'].includes(category) ? 'stay'
    : ['nature', 'mountain', 'park', '오름', '올레길'].includes(category) ? 'nature' : 'place';

export class CatalogUI {
  private root: HTMLElement;
  private detailRoot: HTMLElement;
  private options: CatalogOptions;
  private status: CatalogStatus | null = null;
  private mode: 'all' | 'view' | 'nearby' = 'all';
  private query = '';
  private category = '';
  private radius = 5000;
  private offset = 0;
  private items: CatalogPlace[] = [];
  private points: CatalogPoints = { type: 'FeatureCollection', features: [] };
  private viewportPoints: CatalogPoints = { type: 'FeatureCollection', features: [] };
  private mapEnabled = false;
  private nearbyOrigin: { lng: number; lat: number } | undefined;
  private searchController: AbortController | undefined;
  private pointsController: AbortController | undefined;
  private detailController: AbortController | undefined;
  private weatherController: AbortController | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private moveTimer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;
  private detailId = '';
  private currentDetail: PlaceDetail | null = null;
  private previousFocus: HTMLElement | null = null;
  private mapReady = false;
  private savedFallback: PlaceSnapshot | undefined;

  constructor(root: HTMLElement, detailRoot: HTMLElement, options: CatalogOptions) {
    this.root = root;
    this.detailRoot = detailRoot;
    this.options = options;
    root.innerHTML = `
      <div class="catalog-status-line"><span id="catalog-total">서비스 카탈로그 연결 중</span><button id="catalog-refresh" aria-label="카탈로그 새로고침">${icon('reset')}</button></div>
      <label class="search-field catalog-search-field">${icon('search')}<span class="sr-only">전체 카탈로그 장소 검색</span><input id="catalog-search" type="search" placeholder="이름, 지역, 찾고 싶은 장소" maxlength="160" autocomplete="off"></label>
      <div id="catalog-category-chips" class="catalog-category-chips" aria-label="지도 장소 분류">${['해변', '오름', '카페', '맛집', '박물관', '주차장'].map((category) => `<button data-map-category="${category}" aria-pressed="false" disabled>${icon(categorySymbol(category).icon)}${category}</button>`).join('')}</div>
      <div class="catalog-filters"><label><span class="sr-only">카탈로그 분류</span><select id="catalog-category"><option value="">카테고리 선택</option></select></label><label class="catalog-map-switch"><input id="catalog-map-toggle" type="checkbox">지도에 표시</label></div>
      <div class="catalog-discovery-note"><span id="catalog-map-hint">대표 명소부터 둘러보세요.</span><button id="catalog-reset">${icon('reset')}필터 초기화</button></div>
      <div class="catalog-scope" aria-label="검색 범위"><button data-scope="all" class="is-active" aria-pressed="true">제주 전체</button><button data-scope="view" aria-pressed="false">현재 지도</button><button data-scope="nearby" aria-pressed="false">중심 주변</button></div>
      <div id="catalog-radius-row" class="catalog-radius-row" hidden><label for="catalog-radius">지도 중심 반경</label><select id="catalog-radius"><option value="2000">2 km</option><option value="5000" selected>5 km</option><option value="10000">10 km</option><option value="20000">20 km</option></select><span>직선 기준</span></div>
      <p id="catalog-scope-note" class="micro-note">서비스 카탈로그 전체에서 검색합니다.</p>
      <div class="catalog-result-heading"><h2>장소 탐색</h2><span id="catalog-result-count" aria-live="polite"></span></div>
      <div id="catalog-list" class="catalog-list" aria-label="카탈로그 검색 결과"></div>
      <div class="catalog-pagination"><button id="catalog-prev" disabled aria-label="이전 40개 장소">← 이전</button><span id="catalog-page">1</span><button id="catalog-next" disabled aria-label="다음 40개 장소">다음 →</button></div>
      <details class="catalog-provenance"><summary>카탈로그 출처 알아보기</summary><div id="catalog-provenance-text">기본 정보와 보강 정보의 출처를 구분해 표시합니다.</div><p>큐레이션 시드의 좌표·주소·소개는 공식 대조 검증으로 간주하지 않습니다. 사진·이용시간 등은 각 항목의 보강 출처를 확인하세요.</p><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors · ODbL ↗</a></details>
    `;
    root.querySelector('#catalog-search')!.addEventListener('input', (event) => {
      this.query = (event.target as HTMLInputElement).value.trim();
      this.offset = 0;
      clearTimeout(this.searchTimer);
      this.searchController?.abort();
      this.pointsController?.abort();
      this.setMapEnabled(Boolean(this.query || this.category || this.mode !== 'all'));
      this.publishPoints({ type: 'FeatureCollection', features: [] }, true);
      this.searchTimer = setTimeout(() => {
        void this.search();
        if (!this.query || this.mode === 'view') void this.loadPoints();
      }, 300);
    });
    root.querySelector('#catalog-category')!.addEventListener('change', (event) => {
      this.chooseCategory((event.target as HTMLSelectElement).value);
    });
    root.querySelectorAll<HTMLButtonElement>('[data-map-category]').forEach((button) => {
      button.addEventListener('click', () => this.chooseCategory(button.dataset.mapCategory!));
    });
    root.querySelector('#catalog-radius')!.addEventListener('change', (event) => {
      this.radius = Number((event.target as HTMLSelectElement).value);
      this.offset = 0;
      void this.search();
    });
    root.querySelector('#catalog-map-toggle')!.addEventListener('change', (event) => {
      this.setMapEnabled((event.target as HTMLInputElement).checked);
      if (this.mapEnabled) void this.loadPoints();
    });
    root.querySelector('#catalog-reset')!.addEventListener('click', () => this.resetFilters());
    root.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((button) => {
      button.addEventListener('click', () => {
        this.pointsController?.abort();
        this.mode = button.dataset.scope as typeof this.mode;
        this.nearbyOrigin = undefined;
        this.offset = 0;
        root.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((item) => {
          item.classList.toggle('is-active', item === button);
          item.setAttribute('aria-pressed', String(item === button));
        });
        root.querySelector<HTMLElement>('#catalog-radius-row')!.hidden = this.mode !== 'nearby';
        root.querySelector('#catalog-scope-note')!.textContent = this.mode === 'view'
          ? '현재 화면 안의 장소 이름을 검색합니다. 지도를 움직이면 갱신돼요.'
          : this.mode === 'nearby' ? '현재 지도 중심에서의 대략적인 직선거리입니다.' : '서비스 카탈로그 전체에서 검색합니다.';
        this.setMapEnabled(Boolean(this.query || this.category || this.mode !== 'all'));
        this.publishPoints({ type: 'FeatureCollection', features: [] }, true);
        void this.search();
        void this.loadPoints();
      });
    });
    root.querySelector('#catalog-prev')!.addEventListener('click', () => { this.offset = Math.max(0, this.offset - 40); void this.search(); });
    root.querySelector('#catalog-next')!.addEventListener('click', () => { this.offset += 40; void this.search(); });
    root.querySelector('#catalog-refresh')!.addEventListener('click', () => { void this.loadStatus(); void this.search(); void this.loadPoints(); });
    root.querySelector('#catalog-list')!.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-catalog-id]');
      if (target) void this.openPlace(target.dataset.catalogId!);
    });
    detailRoot.addEventListener('click', (event) => this.detailClick(event));
    window.addEventListener('atlas:saved-change', () => this.updateSavedButtons());
    window.addEventListener('online', () => {
      void this.loadStatus();
      void this.search();
      if (this.mapReady && this.mapEnabled) void this.loadPoints();
    });
    window.addEventListener('atlas:locale-change', () => {
      if (this.root.querySelector('#catalog-list [data-catalog-id]')) {
        const list = this.root.querySelector<HTMLElement>('#catalog-list')!;
        const scroll = list.scrollTop;
        this.renderList();
        list.scrollTop = scroll;
      }
      if (this.detailRoot.hidden || !this.currentDetail) return;
      const scroll = this.detailRoot.querySelector<HTMLElement>('.detail-content')?.scrollTop ?? 0;
      const weather = this.detailRoot.querySelector('#place-weather');
      const focusedAction = document.activeElement instanceof HTMLElement && this.detailRoot.contains(document.activeElement)
        ? document.activeElement.dataset.detailAction : undefined;
      this.renderDetail(this.currentDetail);
      if (weather) this.detailRoot.querySelector('#place-weather')?.replaceWith(weather);
      const content = this.detailRoot.querySelector<HTMLElement>('.detail-content');
      if (content) content.scrollTop = scroll;
      if (focusedAction) this.detailRoot.querySelector<HTMLElement>(`[data-detail-action="${CSS.escape(focusedAction)}"]`)?.focus({ preventScroll: true });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.detailRoot.hidden && !document.querySelector('dialog[open]')) this.closeDetail();
    });
    void this.loadStatus();
    void this.search();
  }

  get selection(): PlaceDetail | null { return this.currentDetail; }
  get pointData(): CatalogPoints { return this.points; }

  private setMapEnabled(enabled: boolean): void {
    this.mapEnabled = enabled;
    this.root.querySelector<HTMLInputElement>('#catalog-map-toggle')!.checked = enabled;
    this.options.onVisibility(enabled);
    if (!enabled) this.pointsController?.abort();
    this.root.querySelector('#catalog-map-hint')!.textContent = !enabled ? '대표 명소부터 둘러보세요.'
      : this.query || this.mode === 'nearby' ? '현재 목록의 장소를 지도에 표시합니다.'
        : this.category ? `${categoryName(this.category)} 아이콘으로 둘러보세요.` : '현재 지도 범위의 장소를 표시합니다.';
  }

  private publishPoints(data: CatalogPoints, clear = false): void {
    this.points = data;
    if (this.mapReady && (this.mapEnabled || clear)) this.options.onPoints(data);
  }

  private listPoints(): CatalogPoints {
    return {
      type: 'FeatureCollection',
      features: this.items.map((place) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [place.lng, place.lat] },
        properties: { id: place.id, name: place.name, category: place.category, source_label: place.source_label },
      })),
    };
  }

  private chooseCategory(category: string): void {
    this.category = category;
    this.offset = 0;
    this.root.querySelector<HTMLSelectElement>('#catalog-category')!.value = category;
    this.root.querySelectorAll<HTMLButtonElement>('[data-map-category]').forEach((button) => {
      const active = button.dataset.mapCategory === category;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    this.pointsController?.abort();
    this.viewportPoints = { type: 'FeatureCollection', features: [] };
    this.setMapEnabled(Boolean(this.query || category || this.mode !== 'all'));
    this.publishPoints({ type: 'FeatureCollection', features: [] }, true);
    void this.search();
    void this.loadPoints();
  }

  resetFilters(resetCamera = true): void {
    clearTimeout(this.searchTimer);
    clearTimeout(this.moveTimer);
    this.searchController?.abort();
    this.pointsController?.abort();
    this.query = '';
    this.category = '';
    this.mode = 'all';
    this.nearbyOrigin = undefined;
    this.offset = 0;
    this.root.querySelector<HTMLInputElement>('#catalog-search')!.value = '';
    this.root.querySelector<HTMLSelectElement>('#catalog-category')!.value = '';
    this.root.querySelector<HTMLElement>('#catalog-radius-row')!.hidden = true;
    this.root.querySelector('#catalog-scope-note')!.textContent = '서비스 카탈로그 전체에서 검색합니다.';
    this.root.querySelectorAll<HTMLButtonElement>('[data-scope]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.scope === 'all');
      button.setAttribute('aria-pressed', String(button.dataset.scope === 'all'));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-map-category]').forEach((button) => {
      button.classList.remove('is-active'); button.setAttribute('aria-pressed', 'false');
    });
    this.viewportPoints = { type: 'FeatureCollection', features: [] };
    this.setMapEnabled(false);
    this.publishPoints({ type: 'FeatureCollection', features: [] }, true);
    this.closeDetail();
    void this.search();
    if (resetCamera) this.options.onReset?.();
  }

  browseNearby(coordinates?: { lng: number; lat: number }, category = ''): void {
    this.closeDetail();
    this.query = '';
    this.root.querySelector<HTMLInputElement>('#catalog-search')!.value = '';
    this.root.querySelector<HTMLButtonElement>('[data-scope="nearby"]')!.click();
    this.nearbyOrigin = coordinates;
    this.chooseCategory(category);
    this.options.openDrawer();
  }

  onMapReady(): void {
    this.mapReady = true;
    this.options.onVisibility(this.mapEnabled);
    void this.loadPoints();
  }

  onMapMove(): void {
    clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      if (this.mode === 'nearby') {
        this.nearbyOrigin = undefined;
        this.offset = 0;
        void this.search();
      } else if (!this.query || this.mode === 'view') void this.loadPoints();
    }, 600);
  }

  private async loadStatus(): Promise<void> {
    try {
      this.status = await apiJSON<CatalogStatus>('/api/catalog/status');
      const status = this.status;
      this.root.querySelector('#catalog-total')!.textContent = status.status === 'ready'
        ? `${status.total.toLocaleString('ko-KR')}곳의 제주${status.stale ? ' · 최근 저장본' : ''}` : '카탈로그를 준비하고 있어요';
      const select = this.root.querySelector<HTMLSelectElement>('#catalog-category')!;
      select.innerHTML = '<option value="">카테고리 선택</option>' + status.categories.map((category) =>
        `<option value="${html(category.id)}">${html(categoryName(category.id))} · ${category.count.toLocaleString('ko-KR')}</option>`).join('');
      select.value = this.category;
      this.root.querySelectorAll<HTMLButtonElement>('[data-map-category]').forEach((button) => {
        button.disabled = !status.categories.some((category) => category.id === button.dataset.mapCategory);
      });
      this.root.querySelector('#catalog-provenance-text')!.innerHTML = `
        <p>${Object.entries(status.by_source).map(([source, count]) => `${html(sourceName(source))} ${Number(count).toLocaleString('ko-KR')}곳`).join(' · ')}</p>
        <p>기본 정보: 각 장소의 기본 출처<br>보강 정보: 사진·시간·편의·인허가 항목별 출처</p>
        <p>카탈로그 작성 ${html(dateLabel(status.built_at))}<br>서버 확인 ${html(dateLabel(status.refreshed_at, true))}</p>
        ${status.stale ? '<p>원본 갱신이 지연되어 마지막 정상 카탈로그를 보여드려요.</p>' : ''}`;
      document.querySelector('.drawer-count')!.textContent = status.status === 'ready' ? `${status.total.toLocaleString('ko-KR')}곳` : '탐색';
    } catch {
      this.root.querySelector('#catalog-total')!.textContent = '카탈로그 연결을 확인해 주세요';
    }
  }

  private viewItems(): CatalogPlace[] {
    const query = this.query.toLocaleLowerCase();
    return this.viewportPoints.features.filter((feature) => (!query || feature.properties.name.toLocaleLowerCase().includes(query))
      && (!this.category || feature.properties.category === this.category)).map((feature) => ({
      id: feature.properties.id, name: feature.properties.name, name_en: null,
      category: feature.properties.category, lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1],
      source_label: feature.properties.source_label, source: feature.properties.source_label,
      address: null, summary: '', tags: [], base_note: null, updated_at: null, region: null,
      avg_stay_min: null, url: null, phone: null, hours: null,
      distance_m: distanceMeters(this.options.center(), { lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] }),
    }));
  }

  async search(): Promise<void> {
    const restoreRetryFocus = document.activeElement?.id === 'catalog-retry';
    const requestId = ++this.requestId;
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    const list = this.root.querySelector<HTMLElement>('#catalog-list')!;
    list.setAttribute('aria-busy', 'true');
    this.root.querySelector<HTMLButtonElement>('#catalog-next')!.disabled = true;
    this.root.querySelector<HTMLButtonElement>('#catalog-prev')!.disabled = true;
    list.innerHTML = '<div class="feature-empty" role="status">제주의 장소를 찾고 있어요…</div>';
    try {
      let result: { items: CatalogPlace[]; total: number; has_more: boolean };
      if (this.mode === 'view') {
        const items = this.viewItems();
        result = { items: items.slice(this.offset, this.offset + 40), total: items.length, has_more: this.offset + 40 < items.length };
        const ids = new Set(items.map((place) => place.id));
        this.publishPoints({ type: 'FeatureCollection', features: this.viewportPoints.features.filter((feature) => ids.has(feature.properties.id)) });
      } else {
        const params = new URLSearchParams({ q: this.query, category: this.category, limit: '40', offset: String(this.offset) });
        if (this.mode === 'nearby') {
          const center = this.nearbyOrigin ?? this.options.center();
          if (!isJejuPoint(center.lng, center.lat)) {
            list.innerHTML = '<div class="feature-empty">지도 중심이 카탈로그 범위 밖에 있어요.<br>제주 위로 지도를 옮겨 다시 찾아보세요.</div>';
            this.root.querySelector('#catalog-result-count')!.textContent = '';
            return;
          }
          params.set('lat', String(center.lat)); params.set('lng', String(center.lng)); params.set('radius_m', String(this.radius));
        }
        result = await apiJSON(`/api/catalog/search?${params}`, controller.signal);
      }
      if (requestId !== this.requestId || controller.signal.aborted) return;
      this.items = result.items.filter((place) => place && typeof place.id === 'string' && typeof place.name === 'string' && isJejuPoint(place.lng, place.lat)).slice(0, 40);
      if (this.mode !== 'view' && (this.query || this.mode === 'nearby')) this.publishPoints(this.listPoints());
      this.renderList();
      if (restoreRetryFocus) this.root.querySelector<HTMLButtonElement>('[data-catalog-id]')?.focus({ preventScroll: true });
      this.root.querySelector('#catalog-result-count')!.textContent = `${result.total.toLocaleString('ko-KR')}곳`;
      this.root.querySelector('#catalog-page')!.textContent = result.total ? `${Math.floor(this.offset / 40) + 1} / ${Math.ceil(result.total / 40)}` : '0';
      this.root.querySelector<HTMLButtonElement>('#catalog-prev')!.disabled = this.offset === 0;
      this.root.querySelector<HTMLButtonElement>('#catalog-next')!.disabled = !result.has_more;
      list.scrollTop = 0;
    } catch (error) {
      if (aborted(error) || controller.signal.aborted) return;
      list.innerHTML = '<div class="feature-empty"><strong>카탈로그에 연결하지 못했어요</strong><p>저장한 코스와 지형 명소는 계속 살펴볼 수 있어요.</p><button id="catalog-retry">다시 시도</button></div>';
      list.querySelector('#catalog-retry')!.addEventListener('click', () => void this.search());
      if (restoreRetryFocus) list.querySelector<HTMLButtonElement>('#catalog-retry')?.focus({ preventScroll: true });
      this.root.querySelector('#catalog-result-count')!.textContent = '';
    } finally {
      if (requestId === this.requestId) list.setAttribute('aria-busy', 'false');
    }
  }

  private renderList(): void {
    const center = this.options.center();
    this.root.querySelector('#catalog-list')!.innerHTML = this.items.map((place) => `
      <button class="catalog-card ${place.id === this.detailId ? 'is-selected' : ''}" data-catalog-id="${html(place.id)}" aria-pressed="${place.id === this.detailId}">
        <span class="catalog-category-dot catalog-category-dot--${categoryColor(place.category)}">${icon(categorySymbol(place.category).icon)}</span>
        <span><strong data-i18n-ignore>${html(placeName(place))}</strong><span class="catalog-card-meta">${html(categoryName(place.category))} <span>·</span> ${html(distanceLabel(place.distance_m ?? distanceMeters(center, place)))} 직선</span><span class="catalog-card-address">${html(this.mode === 'view' ? '주소는 상세에서 확인' : place.address || '주소 정보 없음')}</span><span class="catalog-base-source">기본: ${html(place.source_label || sourceName(place.source))}</span></span>${icon('chevron')}
      </button>`).join('') || '<div class="feature-empty"><strong>조건에 맞는 장소가 없어요</strong><p>검색어와 분류, 지도 범위를 바꿔 보세요.</p></div>';
  }

  async loadPoints(): Promise<void> {
    if (!this.mapReady || (!this.mapEnabled && this.mode !== 'view')) return;
    if (this.mode === 'nearby' || (this.query && this.mode !== 'view')) {
      if (this.root.querySelector('#catalog-list')!.getAttribute('aria-busy') !== 'true') this.publishPoints(this.listPoints());
      return;
    }
    this.pointsController?.abort();
    const controller = new AbortController();
    this.pointsController = controller;
    const bounds = this.options.bounds();
    const bbox: [number, number, number, number] = [
      Math.max(catalogBounds.west, bounds[0]), Math.max(catalogBounds.south, bounds[1]),
      Math.min(catalogBounds.east, bounds[2]), Math.min(catalogBounds.north, bounds[3]),
    ];
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      this.viewportPoints = { type: 'FeatureCollection', features: [] };
      this.publishPoints(this.viewportPoints);
      if (this.mode === 'view') { this.offset = 0; void this.search(); }
      return;
    }
    const params = new URLSearchParams({ bbox: bbox.map((value) => value.toFixed(6)).join(','), category: this.category });
    try {
      const data = await apiJSON<CatalogPoints>(`/api/catalog/points?${params}`, controller.signal);
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.features)) throw new Error('Invalid points');
      this.viewportPoints = {
        type: 'FeatureCollection', features: data.features.slice(0, 10000).filter((feature) =>
          feature?.geometry?.type === 'Point' && isJejuPoint(feature.geometry.coordinates[0], feature.geometry.coordinates[1])
          && typeof feature.properties?.id === 'string' && typeof feature.properties?.name === 'string'),
      };
      if (this.mode === 'view') { this.offset = 0; void this.search(); }
      else this.publishPoints(this.viewportPoints);
    } catch (error) {
      if (aborted(error) || controller.signal.aborted) return;
      this.root.querySelector('#catalog-scope-note')!.textContent = '지도 장소를 갱신하지 못했어요. 목록 검색과 저장한 코스는 사용할 수 있어요.';
    }
  }

  async openPlace(id: string, saved?: PlaceSnapshot): Promise<void> {
    this.detailController?.abort();
    this.weatherController?.abort();
    this.detailId = id;
    this.savedFallback = saved;
    this.currentDetail = null;
    if (this.detailRoot.hidden) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const summary = saved ?? this.items.find((place) => place.id === id);
    if (summary) this.options.onSelect(summary);
    this.detailRoot.hidden = false;
    this.detailRoot.setAttribute('aria-busy', 'true');
    document.querySelector('.map-shell')?.classList.add('is-detail-open');
    this.detailRoot.innerHTML = `<div class="detail-heading"><div><span class="eyebrow">PLACE NOTES</span><h2 tabindex="-1"${summary ? ' data-i18n-ignore' : ''}>${html(summary ? placeName(summary) : '장소 정보')}</h2></div><button data-detail-action="close" aria-label="장소 상세 닫기">${icon('close')}</button></div><div class="feature-empty" role="status">장소의 출처와 상세 정보를 불러오는 중…</div>`;
    this.detailRoot.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    const controller = new AbortController();
    this.detailController = controller;
    try {
      const detail = await apiJSON<PlaceDetail>(`/api/catalog/places/${encodeURIComponent(id)}`, controller.signal);
      if (controller.signal.aborted || this.detailId !== id) return;
      if (!isJejuPoint(detail.lng, detail.lat)) throw new Error('Invalid location');
      this.currentDetail = detail;
      this.detailRoot.setAttribute('aria-busy', 'false');
      if (!summary) this.options.onSelect(detail);
      this.renderDetail(detail);
      this.renderList();
      void this.loadWeather(detail);
    } catch (error) {
      if (aborted(error) || controller.signal.aborted) return;
      this.currentDetail = null;
      this.detailRoot.setAttribute('aria-busy', 'false');
      if (saved) {
        this.detailRoot.innerHTML = `<div class="detail-heading"><h2 data-i18n-ignore>${html(placeName(saved))}</h2><button data-detail-action="close" aria-label="장소 상세 닫기">${icon('close')}</button></div><div class="detail-content"><p class="detail-base-note">저장한 장소 정보입니다. 현재 상세 정보에 연결하지 못했어요.</p><p>${html(saved.summary || noData)}</p><dl class="detail-basics"><div><dt>주소</dt><dd>${html(saved.address || noData)}</dd></div><div><dt>기본 출처</dt><dd>${html(saved.source_label)}</dd></div><div><dt>정보 기준</dt><dd>${html(dateLabel(saved.updated_at))}</dd></div></dl><p>${html(saved.base_note || '')}</p><button data-detail-action="add" class="button button--primary">내 여행에 담기</button><button data-detail-action="retry" class="button">최신 상세 다시 확인</button></div>`;
      } else {
        const focusInside = this.detailRoot.contains(document.activeElement);
        this.detailRoot.querySelector('.feature-empty')?.replaceChildren();
        const status = this.detailRoot.querySelector<HTMLElement>('.feature-empty')!;
        status.innerHTML = '<p>장소 상세를 불러오지 못했어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.</p><button class="button" data-detail-action="retry">다시 시도</button>';
        if (focusInside) status.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
      }
    }
  }

  closeDetail(restoreFocus = true): void {
    if (this.detailRoot.hidden) return;
    this.detailController?.abort();
    this.weatherController?.abort();
    this.detailRoot.hidden = true;
    this.detailRoot.setAttribute('aria-busy', 'false');
    document.querySelector('.map-shell')?.classList.remove('is-detail-open');
    if (!restoreFocus) return;
    let target = this.previousFocus?.isConnected ? this.previousFocus : this.root.querySelector<HTMLElement>('#catalog-search');
    if (target?.closest('[inert]')) this.options.openDrawer();
    if (!target?.getClientRects().length) target = document.querySelector<HTMLElement>('.sidebar-tabs [aria-selected="true"]');
    target?.focus({ preventScroll: true });
  }

  private sourceList(sources: SourceRecord[]): string {
    return sources.length ? sources.map((source) => `<li>${link(source.url, sourceName(source.source))}<span>관측 ${html(dateLabel(source.observed_at))} · 이용허락 ${html(source.license || noData)}</span>${source.note ? `<span>${html(source.note)}</span>` : ''}</li>`).join('') : `<li>${noData}</li>`;
  }

  private renderDetail(place: PlaceDetail): void {
    const focusInside = this.detailRoot.contains(document.activeElement);
    const curated = /curated|seed|큐레이션/i.test(`${place.source} ${place.source_label}`);
    const note = place.base_note || (curated ? '큐레이션 시드의 좌표·주소·소개는 공식 대조 검증 정보가 아닙니다. 보강된 항목의 출처를 각각 확인해 주세요.' : '기본 정보와 아래 보강 정보의 출처를 함께 확인해 주세요.');
    const days = ['월', '화', '수', '목', '금', '토', '일'];
    const facilities: Record<string, string> = { parking: '주차', wheelchair: '접근성 관련 표기', kid_friendly: '어린이 관련 표기', pet: '반려동물', restroom: '화장실', wifi: '와이파이', outdoor_seating: '야외 좌석', credit_card: '카드 결제', reservation: '예약' };
    const facilityValue: Record<string, string> = { yes: '자료상 있음', no: '자료상 없음', limited: '자료상 제한적', unknown: '미확인' };
    const overviewSources = place.sources.filter((source) => /tourapi|visitjeju|wikimedia/i.test(source.source));
    const businessSources = place.sources.filter((source) => /localdata/i.test(source.source));
    const business = place.business_status === 'open' ? '영업/정상' : place.business_status === 'closed_permanently' ? '폐업' : noData;
    const parsedHours = place.hours_source === 'tourapi_usetime' || place.field_evidence?.hours_week?.state === 'parsed';
    const baseEvidence = `<dl class="base-evidence" aria-label="기본 필드별 근거">${[['name', '이름'], ['lat', '위도'], ['lng', '경도'], ['address', '주소'], ['summary', '기본 소개']].map(([path, label]) => `<div><dt>${label}</dt><dd>${evidenceHTML(place.field_evidence, path)}</dd></div>`).join('')}</dl>`;
    this.detailRoot.innerHTML = `
      <div class="detail-heading"><div><span class="eyebrow">${html(categoryName(place.category))} · PLACE NOTES</span><h2 tabindex="-1" data-i18n-ignore>${html(placeName(place))}</h2>${place.name_en ? `<span class="detail-english" data-i18n-ignore>${html(getLocale() === 'en' ? place.name : place.name_en)}</span>` : ''}</div><button data-detail-action="close" aria-label="장소 상세 닫기">${icon('close')}</button></div>
      <div class="detail-action-bar"><button id="detail-favorite" data-detail-action="favorite" aria-pressed="${this.options.planner.isFavorite(place.id)}">${icon('pin')}즐겨찾기</button><button id="detail-add-trip" data-detail-action="add">${icon('plus')}내 여행에 담기</button><button data-detail-action="map">${icon('expand')}지도 보기</button></div>
      <p id="detail-save-status" class="detail-save-status" role="status" hidden></p>
      <div class="detail-related-actions"><button data-detail-action="nearby">${icon('compass')}주변 장소</button><button data-detail-action="category">${icon(categorySymbol(place.category).icon)}${html(categoryName(place.category))} 더 보기</button></div>
      <div class="detail-content">
        <div class="detail-photos">${place.photos.slice(0, 8).map((photo) => {
          const url = safeURL(photo.url);
          return url ? `<figure><img src="${html(url)}" alt="${html(place.name)} · ${html(photo.source)} 제공 사진" loading="lazy" decoding="async"><figcaption>${html(photo.credit || '사진 크레딧 정보 없음')}<span>${html(photo.license || '이용허락 정보 없음')} · ${html(sourceName(photo.source))}${photo.origin_url ? ` · ${link(photo.origin_url, '원본 출처')}` : ''}</span>${/KOGL[- ]?[34]/i.test(photo.license) ? '<span>변경 금지 사진 · 원본 비율로 표시</span>' : ''}</figcaption></figure>` : '';
        }).join('') || '<div class="detail-no-photo">제공된 사진 없음</div>'}</div>
        <section class="detail-section"><h3>기본 정보 <span>${html(place.source_label || sourceName(place.source))}</span></h3><p class="detail-base-note">${html(note)}</p>${baseEvidence}<p class="detail-overview">${html(place.summary || t('기본 소개 정보 없음'))}</p><dl class="detail-basics"><div><dt>주소</dt><dd>${html(place.address || noData)}</dd></div><div><dt>전화</dt><dd>${place.phone ? html(place.phone) : noData}</dd></div><div><dt>좌표</dt><dd class="mono">${place.lat.toFixed(5)}° N, ${place.lng.toFixed(5)}° E</dd></div><div><dt>장소 링크</dt><dd>${place.url ? link(place.url, /openstreetmap\.org/i.test(place.url) ? 'OpenStreetMap 원문' : '장소 링크') : noData}</dd></div><div><dt>기본 정보 갱신</dt><dd>${html(dateLabel(place.updated_at))}</dd></div></dl><p class="micro-note">장소 이름·주소·소개는 제공된 원문이 표시될 수 있습니다.</p></section>
        <section class="detail-section"><h3>보강 소개</h3><p class="detail-overview">${html(place.overview || t(noData))}</p><p class="micro-note">소개 관련 보강 출처: ${overviewSources.map((source) => html(sourceName(source.source))).join(' · ') || noData}</p></section>
        <section class="detail-section"><h3>요일별 이용시간</h3>${evidenceHTML(place.field_evidence, 'hours_week')}<table class="hours-table"><caption>${parsedHours ? '이용시간 문구에서 변환한 참고 시간 · 휴무일 미확인' : '제공된 요일별 이용시간 · 월요일 기준'}</caption><tbody>${days.map((day, index) => {
          const rows = place.hours_week.filter((row) => row.day === index);
          return `<tr><th scope="row">${day}</th><td>${rows.length ? rows.map((row) => `${html(row.open)} – ${html(row.close)}`).join('<br>') : noData}</td></tr>`;
        }).join('')}</tbody></table>${parsedHours ? '<p class="micro-note">파싱된 시간표이며, 각 요일 운영·휴무일을 독립적으로 확인한 값이 아닙니다.</p>' : ''}<p class="micro-note">${html(t(hoursText(place.hours_week, place.hours_source)))} · 출처: ${html(sourceName(place.hours_source))}</p><p class="detail-hours-raw">${t('기본 시간 안내:')} <span data-i18n-ignore>${html(place.hours || t(noData))}</span></p><p class="micro-note">기본 시간 출처: ${html(place.source_label || sourceName(place.source))} · 방문 전 제공처에 확인해 주세요.</p></section>
        <section class="detail-section"><h3>편의 정보</h3><dl class="facility-grid">${Object.entries(facilities).map(([key, label]) => `<div><dt>${label}</dt><dd>${html(facilityValue[place.facilities[key]] ?? place.facilities[key] ?? noData)}${evidenceHTML(place.field_evidence, `facilities.${key}`)}</dd></div>`).join('')}</dl><p class="micro-note">항목별 상세 근거는 아래 보강 출처에서 확인하세요. 제공되지 않은 항목은 정보 없음으로 표시합니다.</p></section>
        <section class="detail-section"><h3>인허가 정보</h3><p id="business-registration">인허가 상태: ${business}</p>${evidenceHTML(place.field_evidence, 'business_status')}<p class="micro-note">${html(place.registration_note || '해당 인허가 기록의 상태이며 장소 전체의 운영 여부를 확정하지 않습니다. 현재 시각의 영업 여부를 뜻하지 않습니다.')}</p><ul class="detail-sources">${this.sourceList(businessSources)}</ul></section>
        <section class="detail-section"><h3>제공된 메뉴</h3>${place.menu.length ? `<ul class="detail-menu">${place.menu.slice(0, 20).map((item) => `<li><strong>${html(item.name)}</strong><span>${item.price_krw == null ? '가격 정보 없음' : `${item.price_krw.toLocaleString('ko-KR')}원`}</span><small>출처 ${html(sourceName(item.source))}</small></li>`).join('')}</ul>` : '<p class="micro-note">메뉴 정보 없음</p>'}</section>
        <section id="place-weather" class="detail-section" aria-live="polite"><h3>이 장소의 날씨</h3><p class="micro-note">현재 날씨와 3일 예보를 확인하는 중…</p></section>
        <section class="detail-section"><h3>보강 출처와 관측일</h3><p class="micro-note">기본 필드의 검증 여부와 보강 항목의 출처는 별개입니다.</p><ul class="detail-sources">${this.sourceList(place.sources)}</ul><p class="micro-note">보강 갱신 ${html(dateLabel(place.enriched_at))}</p></section>
      </div>`;
    this.updateSavedButtons();
    if (focusInside) this.detailRoot.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }

  private updateSavedButtons(): void {
    if (!this.currentDetail) return;
    const favorite = this.detailRoot.querySelector<HTMLButtonElement>('#detail-favorite');
    const add = this.detailRoot.querySelector<HTMLButtonElement>('#detail-add-trip');
    if (favorite) {
      const saved = this.options.planner.isFavorite(this.currentDetail.id);
      favorite.setAttribute('aria-pressed', String(saved));
      favorite.classList.toggle('is-saved', saved);
      favorite.innerHTML = `${icon(saved ? 'check' : 'pin')}${saved ? this.options.planner.isSaved ? '저장됨' : '임시 보관' : '즐겨찾기'}`;
    }
    if (add) add.innerHTML = `${icon(this.options.planner.hasStop(this.currentDetail.id) ? 'check' : 'plus')}${this.options.planner.hasStop(this.currentDetail.id) ? '코스에 담김' : '내 여행에 담기'}`;
    const notice = this.detailRoot.querySelector<HTMLElement>('#detail-save-status');
    if (notice) {
      notice.hidden = this.options.planner.isSaved;
      notice.textContent = '브라우저에 저장되지 않은 편집본이 있어요. 내 여행의 자료 관리에서 파일로 보관하거나 저장을 다시 시도해 주세요.';
    }
  }

  private detailClick(event: MouseEvent): void {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-detail-action]')?.dataset.detailAction;
    if (!action) return;
    if (action === 'close') { this.closeDetail(); return; }
    if (action === 'retry') { void this.openPlace(this.detailId, this.savedFallback); return; }
    if (action === 'weather') { if (this.currentDetail) void this.loadWeather(this.currentDetail); return; }
    const place = this.currentDetail ?? this.savedFallback;
    if (!place) return;
    if (action === 'favorite') this.options.planner.toggleFavorite(place);
    if (action === 'add') this.options.planner.add(place);
    if (action === 'map') { this.options.onSelect(place); this.closeDetail(); }
    if (action === 'nearby') this.browseNearby({ lng: place.lng, lat: place.lat });
    if (action === 'category') {
      this.closeDetail();
      this.query = '';
      this.root.querySelector<HTMLInputElement>('#catalog-search')!.value = '';
      this.root.querySelector<HTMLButtonElement>('[data-scope="all"]')!.click();
      this.chooseCategory(place.category);
      this.options.openDrawer();
    }
  }

  private async loadWeather(place: PlaceDetail): Promise<void> {
    this.weatherController?.abort();
    const controller = new AbortController();
    this.weatherController = controller;
    const container = this.detailRoot.querySelector<HTMLElement>('#place-weather');
    if (!container) return;
    container.innerHTML = '<h3>이 장소의 날씨</h3><p class="micro-note">현재 날씨와 3일 예보를 확인하는 중…</p>';
    try {
      const weather = await apiJSON<WeatherResult>(`/api/weather?${new URLSearchParams({ lat: String(place.lat), lng: String(place.lng) })}`, controller.signal);
      if (controller.signal.aborted || this.detailId !== place.id) return;
      if (!weather.available || !weather.current) throw new Error('Weather unavailable');
      const current = weather.current;
      container.innerHTML = `<h3>이 장소의 날씨</h3><div class="weather-current"><strong>${numberLabel(current.temperature_c, '°C')}</strong><span>${html(current.summary || noData)}<br>바람 ${numberLabel(current.wind_kmh, ' km/h')} · 강수 ${numberLabel(current.precipitation_mm, ' mm')}</span></div><div class="weather-days">${weather.daily.slice(0, 3).map((day) => `<div><strong>${html(day.date)}</strong><span>${numberLabel(day.min_c, '°')} / ${numberLabel(day.max_c, '°')}</span><small>강수 확률 ${numberLabel(day.precipitation_probability, '%')}</small></div>`).join('') || '<p class="micro-note">3일 예보 정보 없음</p>'}</div><p class="micro-note">출처 ${html(weather.source)}<br>관측 기준 ${html(dateLabel(current.time, true))} KST<br>조회 ${html(dateLabel(weather.fetched_at, true))} KST</p>`;
    } catch (error) {
      if (aborted(error) || controller.signal.aborted) return;
      container.innerHTML = '<h3>이 장소의 날씨</h3><p class="micro-note">날씨 정보를 불러오지 못했어요. 저장한 장소와 코스는 계속 사용할 수 있어요.</p><button class="inline-action" data-detail-action="weather">날씨 다시 확인</button>';
    }
  }
}
