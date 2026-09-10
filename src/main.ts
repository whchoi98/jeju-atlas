import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { brandMark, icon } from './icons';
import { categories, formatCoordinates, places, tourStops, type Place } from './places';
import type { AtlasMap, ViewState } from './map';
import { AtlasExperience } from './explore';
import { getLocale, initializeI18n, placeName, t } from './i18n';
import { html } from './api';
import {
  DEFAULT_TOUR, createTourTrack, loadOlleRoute, loadTourManifest, routeBounds, routeDistance, tourLabel, tourText,
  type OlleRoute, type TourChoice, type TourManifest,
} from './tours';

const app = document.querySelector<HTMLDivElement>('#app')!;
let atlas: AtlasMap | undefined;
let mapModule: typeof import('./map') | undefined;
let selected = places[0];
let activeCategory = 'all';
let search = '';
let drawerOpen = false;
let mapReady = false;
let pendingFly: Place | undefined;
let tourIndex = -1;
let tourTimer: ReturnType<typeof setTimeout> | undefined;
let tourAnimation: number | undefined;
let selectedTour = DEFAULT_TOUR;
let tourManifest: TourManifest | undefined;
let manifestFailed = false;
let activeTrail: OlleRoute | undefined;
let trailController: AbortController | undefined;
let trailLoading = false;
let trailFailed = false;
let trailProgress = 0;
let trailPart = 0;
let tourInfoKey = '';
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let lastState: ViewState | undefined;
let initializationId = 0;
let experience: AtlasExperience | undefined;

app.innerHTML = `
  <a href="#map" class="skip-link">지도로 바로 가기</a>
  <header class="app-header">
    <a class="brand" href="/" aria-label="제주 아틀라스 홈" id="brand-home">
      ${brandMark}
      <span class="brand-wordmark"><strong>제주 아틀라스</strong><span>JEJU ATLAS</span></span>
    </a>
    <div class="header-divider" aria-hidden="true"></div>
    <p class="header-tagline">제주를, 입체적으로.</p>
    <div class="header-actions">
      <span class="terrain-tag"><span></span> 실제 지형 · 위성 영상</span>
      <button class="button button--quiet about-button" id="about-button" aria-label="지도 이용 안내">${icon('info')}<span>이용 안내</span></button>
      <button class="button language-toggle" id="language-toggle" type="button" data-i18n-ignore>English</button>
      <button class="button button--share" id="share-button" aria-label="이 뷰 공유" data-map-action disabled>${icon('share')}<span>이 뷰 공유</span></button>
    </div>
  </header>
  <main class="atlas-layout">
    <aside class="sidebar" id="place-drawer" aria-label="제주 장소 탐색">
      <button class="drawer-handle" id="drawer-toggle" aria-expanded="false" aria-controls="sidebar-content">
        <span class="drawer-grip" aria-hidden="true"></span>
        <span class="drawer-mobile-title">${icon('pin')} <strong>제주의 장소 탐색</strong> <span class="drawer-count">12곳</span></span>
        ${icon('chevronDown', 'drawer-chevron')}
      </button>
      <div class="sidebar-content" id="sidebar-content">
        <div class="sidebar-intro">
          <div class="eyebrow"><span class="eyebrow-line"></span> AN ISLAND, IN PERSPECTIVE</div>
          <h1>바다 위에 솟은<br>제주의 모든 <em>높이.</em></h1>
          <p>익숙한 제주를 새로운 시선으로.<br>마음이 닿는 곳으로 날아가 보세요.</p>
        </div>
        <div class="explorer">
          <label class="search-field">
            ${icon('search')}
            <span class="sr-only">제주 장소 검색</span>
            <input type="search" id="place-search" placeholder="어떤 제주가 궁금한가요?" autocomplete="off" spellcheck="false">
            <kbd aria-hidden="true">/</kbd>
          </label>
          <div class="category-chips" aria-label="장소 분류">
            <button class="category-chip is-active" data-category="all" aria-pressed="true">전체</button>
            <button class="category-chip" data-category="mountain" aria-pressed="false">${icon('mountain')}산·오름</button>
            <button class="category-chip" data-category="coast" aria-pressed="false">${icon('coast')}해안</button>
            <button class="category-chip" data-category="island" aria-pressed="false">${icon('island')}섬</button>
          </div>
          <div class="places-heading"><h2>제주의 발견</h2><span id="place-count">12개의 장소</span></div>
          <div class="place-list" id="place-list" aria-label="탐색할 장소"></div>
        </div>
        <div class="sidebar-footer">
          <span class="footer-mapmark">${icon('globe')}</span>
          <div>작은 섬, 깊이 있는 탐험<span>EXPLORE JEJU, IN A NEW DIMENSION</span></div>
        </div>
      </div>
    </aside>
    <section class="map-shell" aria-label="제주 지도 탐험">
      <div id="map" role="region" aria-label="제주 3D 지도" tabindex="-1"></div>
      <div class="map-vignette" aria-hidden="true"></div>
      <div class="map-topline">
        <div class="view-badge"><span class="view-status-dot"></span><strong id="view-mode-label">3D 지형</strong><span class="view-badge-separator"></span><span id="view-base-label">위성 영상</span></div>
        <div class="tour-controls" data-i18n-ignore>
          <label for="tour-theme" class="sr-only" id="tour-theme-label">둘러보기 테마</label>
          <select id="tour-theme" aria-describedby="tour-coverage"><option value="jeju-loop">제주 한 바퀴</option></select>
          <button class="button tour-button" id="tour-button" data-map-action disabled>${icon('play')}<span>둘러보기 시작</span></button>
          <span class="sr-only" id="tour-coverage"></span>
        </div>
      </div>
      <div class="tour-panel" id="tour-panel" data-i18n-ignore hidden>
        <div class="tour-info" id="tour-info"></div>
        <div class="tour-progress" id="tour-progress" hidden>
          <div class="tour-progress-heading"><span class="tour-running-dot"></span><span id="tour-title">제주 한 바퀴</span><strong id="tour-count">1 / 5</strong><button id="tour-stop" aria-label="둘러보기 멈춤">${icon('close')}</button></div>
          <div class="tour-stops" id="tour-stops"></div>
        </div>
      </div>
      <div class="map-tools" aria-label="지도 조작">
        <div class="navigation-tools control-surface">
          <button class="map-icon-button north-button" id="north-button" data-map-action disabled aria-label="북쪽을 위로 정렬" title="북쪽을 위로"><span class="north-letter">N</span>${icon('compass', 'compass-needle')}</button>
          <span class="control-rule"></span>
          <button class="map-icon-button" id="zoom-in" data-map-action disabled aria-label="지도 확대" title="확대">${icon('plus')}</button>
          <button class="map-icon-button" id="zoom-out" data-map-action disabled aria-label="지도 축소" title="축소">${icon('minus')}</button>
          <span class="control-rule"></span>
          <button class="map-icon-button" id="reset-view" data-map-action disabled aria-label="제주 전체 보기" title="제주 전체 보기">${icon('expand')}</button>
        </div>
        <div class="dimension-toggle control-surface" aria-label="지도 차원">
          <button id="mode-3d" class="is-active" data-map-action disabled aria-pressed="true">3D</button>
          <button id="mode-2d" data-map-action disabled aria-pressed="false">2D</button>
        </div>
        <button class="layer-trigger control-surface" id="layer-trigger" aria-label="지도와 고도 설정" aria-expanded="false" aria-controls="layer-panel">${icon('layers')}<span>지도 설정</span></button>
      </div>
      <div class="layer-panel control-surface" id="layer-panel">
        <div class="panel-heading"><h2>${icon('layers')} 지도 설정</h2><button class="mobile-panel-close" id="layer-close" aria-label="지도 설정 닫기">${icon('close')}</button></div>
        <div class="basemap-options" aria-label="배경 지도">
          <button class="basemap-option is-active" id="basemap-satellite" data-map-action disabled aria-pressed="true"><span class="basemap-preview basemap-preview--satellite"><span class="basemap-check">${icon('check')}</span></span><span>위성 영상</span></button>
          <button class="basemap-option" id="basemap-relief" data-map-action disabled aria-pressed="false"><span class="basemap-preview basemap-preview--relief"><span class="basemap-check">${icon('check')}</span></span><span>지형 지도</span></button>
        </div>
        <div class="elevation-heading"><label for="elevation-range">고도 배율</label><output id="elevation-value" for="elevation-range">1.5×</output></div>
        <input class="elevation-range" id="elevation-range" data-map-action disabled type="range" min="1" max="2" step="0.1" value="1.5" aria-valuetext="실제 고도의 1.5배">
        <div class="range-labels"><button id="actual-scale" data-map-action disabled>1× 실제 높이</button><span>2×</span></div>
        <p class="elevation-note" id="elevation-note">지형의 높낮이를 더 선명하게</p>
      </div>
      <div class="map-loading" id="map-loading" role="status" aria-live="polite">
        <div class="loading-contours" aria-hidden="true"><span></span><span></span><span></span>${icon('mountain')}</div>
        <strong>제주의 높이를 펼치는 중</strong><p>위성 영상과 실제 지형을 불러오고 있어요.</p>
      </div>
      <div class="map-notice" id="map-notice" role="alert" hidden>
        ${icon('warning')}
        <div><strong id="notice-title">지도를 확인해 주세요</strong><p id="notice-message"></p><div class="notice-actions"><button class="button button--primary" id="retry-map">${icon('reset')}다시 불러오기</button><button class="button button--quiet" id="fallback-map">지형 지도 보기</button></div></div>
      </div>
      <div class="map-bottom-content">
        <div class="map-caption"><span class="caption-rule"></span><span>JEJU ISLAND</span><span class="caption-coordinates">33° N · 126° E</span></div>
        <article class="selected-place" id="selected-place" aria-label="선택한 장소"></article>
        <div class="map-bottom-meta">
          <p class="gesture-hint">${icon('mouse')}<span>드래그로 이동<span class="hint-dot">·</span>우클릭 드래그로 회전</span></p>
          <span class="camera-coordinates" id="camera-coordinates">33.3800° N &nbsp;126.5400° E</span>
          <span class="exaggeration-indicator" id="exaggeration-indicator">고도 배율 1.5×</span>
        </div>
      </div>
      <div class="elevation-legend" id="elevation-legend" hidden><span>해발 고도</span><div></div><span>0 m</span><span>1,950 m</span></div>
      <p class="sr-only" id="map-keyboard-help">지도를 선택하고 방향키로 이동하세요. +, - 키로 확대와 축소하고 Shift와 방향키로 회전과 기울기를 조절할 수 있습니다. Escape 키는 자동 둘러보기를 중지합니다.</p>
    </section>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
  <div class="sr-only" id="selection-announcement" aria-live="polite" aria-atomic="true"></div>
  <dialog class="about-dialog" id="about-dialog" aria-labelledby="about-title">
    <div class="dialog-heading">${brandMark}<button class="dialog-close" id="about-close" aria-label="이용 안내 닫기">${icon('close')}</button></div>
    <span class="eyebrow">A DIFFERENT PERSPECTIVE</span><h2 id="about-title">제주를 만나는<br>또 하나의 시선.</h2>
    <p>제주 아틀라스는 실제 고도 데이터와 위성 영상으로 제주의 지형을 둘러보는 지도입니다.</p>
    <dl class="help-list">
      <div><dt>${icon('mouse')} 지도 움직이기</dt><dd>드래그로 이동 · 스크롤로 확대<br>우클릭 드래그로 회전 · 두 손가락으로 기울이기</dd></div>
      <div><dt>${icon('mountain')} 높이 살펴보기</dt><dd>3D와 2D를 전환하고 고도 배율을 조절해 보세요. 1×가 실제 비율입니다.</dd></div>
      <div><dt>${icon('play')} 가볍게 둘러보기</dt><dd>‘제주 한 바퀴’는 다섯 장소로 시점을 이동합니다. 지도를 직접 움직이거나 Esc를 누르면 멈춥니다.</dd></div>
    </dl>
    <p class="data-note">위성 영상은 실시간 영상이 아닙니다. 지형 데이터의 해상도에 따라 작은 바위와 건물은 표시되지 않습니다. 장소 좌표는 탐색용 중심점이며 길 안내를 제공하지 않습니다.</p>
    <div class="data-sources"><strong>지도 데이터</strong><span>위성 영상 · Esri World Imagery</span><span>고도 타일 · Mapzen / AWS Terrain Tiles</span><span>육지 고도 · USGS (SRTM / GMTED2010)</span><span>전 지구 지형 · NOAA (ETOPO1)</span><a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">고도 데이터 전체 출처 보기 ↗</a><span>지도 엔진 · MapLibre GL JS</span><span id="emoji-attribution">UI 이모지 · <a href="https://github.com/twitter/twemoji/tree/v14.0.2" target="_blank" rel="noopener noreferrer">Twemoji © Twitter, Inc and other contributors</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></span><a href="/emoji/LICENSE-GRAPHICS.txt" target="_blank" rel="noopener">이모지 이용허락 전문 ↗</a></div>
    <details class="device-privacy" id="privacy-help"><summary>자료 보관과 AI 이용</summary><p>코스와 즐겨찾기는 이 브라우저에 저장됩니다. 코스 공유 주소의 # 뒤에는 장소 이름·좌표·순서·체류 시간·출처가 담기며, 주소를 받은 사람이 볼 수 있습니다.</p><p>AI 질문과 필요한 탐색 맥락은 서버를 거쳐 AWS의 기존 AI 런타임에 전달됩니다. 서버는 이용 한도를 관리합니다.</p><p>기기 자료 삭제는 브라우저의 코스·즐겨찾기·이전 정상 저장본에만 적용됩니다. 이미 공유한 주소와 서버에 전송된 자료, 이용 한도용 세션 쿠키는 삭제하지 않습니다.</p><p>새 대화는 현재 화면의 대화를 비우고 새 연결을 시작합니다. 서버 자료를 삭제하는 기능이 아닙니다.</p><button id="about-data" class="button">이 기기의 여행 자료 관리</button></details>
    <button class="button button--primary dialog-start" id="about-start">제주 탐험하기 ${icon('arrow')}</button>
  </dialog>
  <dialog class="share-dialog" id="share-dialog" aria-labelledby="share-title">
    <div class="dialog-heading"><h2 id="share-title">이 뷰 공유하기</h2><button class="dialog-close" id="share-close" aria-label="공유 창 닫기">${icon('close')}</button></div>
    <p>자동 복사가 허용되지 않았어요. 아래 주소를 선택해 복사해 주세요.</p><label for="share-url">현재 지도 주소</label><input id="share-url" type="text" readonly><button class="button button--primary" id="share-select">주소 전체 선택</button>
  </dialog>
`;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function categoryIcon(place: Place): string {
  return `<span class="place-art place-art--${place.category} place-art--${place.id}" aria-hidden="true"><span class="art-contour art-contour--one"></span><span class="art-contour art-contour--two"></span><span class="art-contour art-contour--three"></span>${icon(place.category)}</span>`;
}

function renderPlaces(): void {
  const focusedPlaceId = document.activeElement instanceof HTMLButtonElement
    ? document.activeElement.dataset.place
    : undefined;
  const normalized = search.trim().toLocaleLowerCase();
  const filtered = places.filter((place) =>
    (activeCategory === 'all' || place.category === activeCategory)
    && `${place.name} ${place.english} ${place.location} ${categories[place.category]}`.toLocaleLowerCase().includes(normalized));
  element('place-count').textContent = `${filtered.length}개의 장소`;
  element('place-list').innerHTML = filtered.length ? filtered.map((place) => `
    <button class="place-card${selected.id === place.id ? ' is-selected' : ''}" data-place="${place.id}" aria-pressed="${selected.id === place.id}">
      ${categoryIcon(place)}
      <span class="place-card-content"><span class="place-card-title"><strong data-i18n-ignore>${placeName(place)}</strong>${place.id === 'hallasan' ? '<span class="featured-tag">대표 지형</span>' : ''}</span><span class="place-card-description">${t(place.description)}</span><span class="place-card-meta"><span>${categories[place.category]}</span><span class="meta-dot">·</span><span>${t(place.location)}</span></span><span class="place-card-coordinates">${formatCoordinates(place.coordinates)}</span></span>
      ${icon('chevron', 'place-card-chevron')}
    </button>`).join('') : `<div class="empty-search">${icon('search')}<strong>찾는 장소가 없어요</strong><p>다른 이름을 입력하거나<br>분류를 ‘전체’로 바꿔 보세요.</p><button id="clear-search">검색 초기화</button></div>`;
  element('clear-search')?.addEventListener('click', () => {
    search = '';
    element<HTMLInputElement>('place-search').value = '';
    setCategory('all');
    element<HTMLInputElement>('place-search').focus();
  });
  element('place-list').querySelectorAll<HTMLButtonElement>('[data-place]').forEach((button) => {
    button.addEventListener('click', () => {
      const place = places.find((item) => item.id === button.dataset.place)!;
      stopTour();
      selectPlace(place, true);
    });
  });
  if (focusedPlaceId) {
    element('place-list').querySelector<HTMLButtonElement>(`[data-place="${focusedPlaceId}"]`)?.focus({ preventScroll: true });
  }
}

function renderSelected(): void {
  element('selected-place').innerHTML = `
    <div class="selected-place-emblem">${icon(selected.category)}</div>
    <div class="selected-place-info"><div class="selected-eyebrow"><span>${categories[selected.category]}</span><span>·</span><span>${t(selected.location)}</span></div><div class="selected-title"><h2 data-i18n-ignore>${placeName(selected)}</h2><span data-i18n-ignore>${getLocale() === 'en' ? selected.name : selected.english}</span></div><p>${t(selected.description)}</p><span class="selected-coordinates">${formatCoordinates(selected.coordinates)}</span></div>
    <button class="fly-button" id="fly-to-place" ${mapReady ? '' : 'disabled'} aria-label="${placeName(selected)} 가까이 보기">${icon('pin')}<span>가까이 보기</span>${icon('arrow')}</button>
  `;
  element('fly-to-place').addEventListener('click', () => {
    stopTour();
    atlas?.flyTo(selected);
  });
}

function selectPlace(place: Place, fly: boolean, touring = false): void {
  experience?.legacySelected();
  selected = place;
  atlas?.setSelected(place.id);
  renderPlaces();
  renderSelected();
  element('selection-announcement').textContent = getLocale() === 'en' ? `Selected ${placeName(place)}. ${t(place.description)}` : `${place.name} 선택. ${place.description}`;
  if (fly) {
    if (mapReady) atlas?.flyTo(place, touring);
    else pendingFly = place;
  }
  if (window.matchMedia('(max-width: 760px)').matches && fly) {
    const restoreFocus = element('place-drawer').contains(document.activeElement);
    setDrawer(false);
    if (restoreFocus) element('drawer-toggle').focus({ preventScroll: true });
  }
}

function setCategory(category: string): void {
  activeCategory = category;
  document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  atlas?.setCategory(category);
  renderPlaces();
}

function setDrawer(open: boolean): void {
  drawerOpen = open;
  element('place-drawer').classList.toggle('is-open', open);
  element('drawer-toggle').setAttribute('aria-expanded', String(open));
  const isMobile = window.matchMedia('(max-width: 760px)').matches;
  element('sidebar-content').inert = isMobile && !open;
  document.querySelector('.map-shell')?.classList.toggle('is-drawer-open', isMobile && open);
}

function toast(message: string): void {
  const target = element('toast');
  clearTimeout(toastTimer);
  target.textContent = message;
  target.hidden = false;
  toastTimer = setTimeout(() => { target.hidden = true; }, 4000);
}

function updateView(state: ViewState): void {
  lastState = state;
  element('camera-coordinates').textContent = formatCoordinates(state.center);
  const compass = document.querySelector<SVGElement>('.compass-needle');
  if (compass) compass.style.transform = `rotate(${-state.bearing}deg)`;
  element('view-mode-label').textContent = state.is3D ? '3D 지형' : '2D 지도';
  element('view-base-label').textContent = state.basemap === 'satellite' ? '위성 영상' : '고도 색상';
  element('exaggeration-indicator').textContent = state.is3D ? `고도 배율 ${state.exaggeration.toFixed(1)}×` : '2D · 평면 보기';
  for (const [id, active] of [
    ['mode-3d', state.is3D],
    ['mode-2d', !state.is3D],
    ['basemap-satellite', state.basemap === 'satellite'],
    ['basemap-relief', state.basemap === 'relief'],
  ] as const) {
    element(id).classList.toggle('is-active', active);
    element(id).setAttribute('aria-pressed', String(active));
  }
  const slider = element<HTMLInputElement>('elevation-range');
  slider.value = state.exaggeration.toFixed(1);
  slider.disabled = !mapReady || !state.is3D;
  slider.setAttribute('aria-valuetext', `실제 고도의 ${state.exaggeration.toFixed(1)}배`);
  slider.style.setProperty('--range-progress', `${(state.exaggeration - 1) * 100}%`);
  element('elevation-value').textContent = `${state.exaggeration.toFixed(1)}×`;
  element<HTMLButtonElement>('actual-scale').disabled = !mapReady || !state.is3D;
  element('actual-scale').classList.toggle('is-active', state.exaggeration === 1);
  element('elevation-note').textContent = !state.is3D ? '3D에서 고도 배율을 조절할 수 있어요' : state.exaggeration === 1 ? '실제 고도 비율로 보고 있어요' : '지형의 높낮이를 더 선명하게';
  element('elevation-legend').hidden = state.basemap !== 'relief';
}

function setMapReady(ready: boolean): void {
  mapReady = ready;
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-map-action]').forEach((control) => { control.disabled = !ready; });
  renderSelected();
  if (lastState) updateView(lastState);
  renderTour();
}

function showMapError(message: string, fatal: boolean): void {
  element('notice-message').textContent = message;
  element('notice-title').textContent = fatal ? '지도를 표시할 수 없어요' : '일부 지도가 아직 도착하지 않았어요';
  element('map-notice').hidden = false;
  element('map-notice').classList.toggle('is-fatal', fatal);
  element('map-loading').hidden = true;
  element<HTMLButtonElement>('fallback-map').hidden = fatal || !mapReady;
  if (fatal) {
    setMapReady(false);
    stopTour();
  }
}

async function initializeMap(stateOverride?: ViewState): Promise<void> {
  const currentId = ++initializationId;
  setMapReady(false);
  stopTour();
  element('map-loading').hidden = false;
  element('map-notice').hidden = true;
  try {
    mapModule ??= await import('./map');
    if (currentId !== initializationId) return;
    const state = stateOverride ?? mapModule.readView();
    lastState = state;
    selected = places.find((place) => place.id === state.selectedId) ?? places[0];
    renderPlaces();
    renderSelected();
    updateView(state);
    atlas?.destroy();
    atlas = undefined;
    element('map').replaceChildren();
    atlas = new mapModule.AtlasMap(element('map'), state, {
      onReady: () => {
        if (currentId !== initializationId) return;
        setMapReady(true);
        element('map-loading').hidden = true;
        atlas?.setCategory(activeCategory);
        if (atlas) experience?.onMapReady(atlas);
        if (activeTrail) {
          atlas?.setTourRoute(activeTrail);
          atlas?.fitTourRoute(activeTrail);
        }
        if (pendingFly) {
          atlas?.flyTo(pendingFly);
          pendingFly = undefined;
        }
      },
      onMove: updateView,
      onSelect: (place) => {
        stopTour();
        selectPlace(place, true);
      },
      onInteraction: () => stopTour(true),
      onError: showMapError,
      onRecovered: () => {
        if (currentId !== initializationId) return;
        if (!mapReady) setMapReady(true);
        element('map-notice').hidden = true;
      },
    });
  } catch (error) {
    console.error('[Jeju Atlas] Map initialization failed:', error);
    showMapError('3D 지도를 시작하지 못했습니다. 인터넷 연결과 브라우저의 그래픽 가속 설정을 확인하고 다시 시도해 주세요.', true);
  }
}

function selectedTourChoice(): TourChoice | null {
  return tourManifest?.routes.find(choice => choice.id === selectedTour) ?? null;
}

function renderTourChoices(): void {
  const selector = element<HTMLSelectElement>('tour-theme');
  selector.replaceChildren(new Option(tourText('loop'), DEFAULT_TOUR));
  if (tourManifest) {
    const group = document.createElement('optgroup');
    group.label = tourText('olle');
    for (const choice of tourManifest.routes) {
      const option = new Option(`${tourLabel(choice)}${choice.available ? '' : ` · ${tourText('missing')}`}`, choice.id);
      option.disabled = !choice.available;
      group.append(option);
    }
    selector.append(group);
  } else {
    const pending = new Option(tourText(manifestFailed ? 'missing' : 'loading'), '');
    pending.disabled = true;
    selector.append(pending);
  }
  selector.value = selectedTour;
  element('tour-theme-label').textContent = tourText('theme');
  selector.title = tourText('theme');
  element('tour-coverage').textContent = tourText('coverage');
}

function renderTourInfo(): void {
  const key = [getLocale(), selectedTour, activeTrail?.properties.id, trailLoading, trailFailed, manifestFailed, mapReady].join('|');
  if (key === tourInfoKey) return;
  tourInfoKey = key;
  const info = element('tour-info');
  const expanded = info.querySelector('details')?.open ?? false;
  if (trailLoading) {
    info.innerHTML = `<p role="status">${html(tourText('loading'))}</p>`;
  } else if (trailFailed || manifestFailed) {
    info.innerHTML = `<p role="status">${html(tourText('failed'))}</p><button id="tour-retry" class="tour-inline-button">${html(tourText('retry'))}</button>`;
    element('tour-retry').addEventListener('click', () => {
      if (manifestFailed) void initializeTours();
      else void changeTourTheme(selectedTour);
    });
  } else if (activeTrail) {
    const p = activeTrail.properties;
    const parts = activeTrail.geometry.coordinates;
    info.innerHTML = `
      <div class="tour-route-heading"><strong>${html(tourLabel(p))}</strong><button id="tour-overview" class="tour-inline-button" ${mapReady ? '' : 'disabled'}>${html(tourText('overview'))}</button></div>
      <p class="tour-route-distance">${html(tourText('mapped'))} ≈ ${(routeDistance(parts) / 1000).toFixed(1)} km · ${parts.length} ${html(tourText('parts'))}</p>
      <p class="tour-route-note">${html(tourText('incomplete'))}</p>
      <details ${expanded ? 'open' : ''}><summary>${html(tourText('details'))}</summary>
        <p>${html(tourText('source'))}: <a href="${html(p.source_url)}" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors · #${p.relation_id}</a> · <a href="${html(p.license_url)}" target="_blank" rel="noopener noreferrer">ODbL</a></p>
        <p>${html(tourText('fetched'))}: ${html(p.fetched_at.slice(0, 10))}${p.source_updated_at ? `<br>${html(tourText('updated'))}: ${html(p.source_updated_at.slice(0, 10))}` : ''}</p>
        ${parts.length > 1 ? `<p>${html(tourText('gaps'))}</p>` : ''}
        ${routeBounds(parts)[1][1] > 33.6 ? `<p>${html(tourText('beyond'))}</p>` : ''}
        <p>${html(tourText('caution'))}</p>
        <p>${html(tourText('coverage'))}</p>
        <a href="https://www.jejuolle.org/trail/kor/" target="_blank" rel="noopener noreferrer">${html(tourText('official'))} ↗</a>
      </details>`;
    element('tour-overview').addEventListener('click', () => {
      stopTour();
      if (activeTrail) atlas?.fitTourRoute(activeTrail);
    });
  } else info.innerHTML = selectedTour === DEFAULT_TOUR ? `<p>${html(tourText('loopHint'))}</p>` : '';
}

function renderTour(): void {
  const running = tourIndex >= 0;
  const button = element<HTMLButtonElement>('tour-button');
  button.innerHTML = `${icon(running ? 'stop' : 'play')}<span>${html(tourText(running ? 'stop' : 'start'))}</span>`;
  button.disabled = !mapReady || trailLoading;
  button.setAttribute('aria-label', `${tourLabel(selectedTourChoice())} · ${tourText(running ? 'stop' : 'start')}`);
  button.title = `${tourText(running ? 'stop' : 'start')}${running ? ' · Esc' : ''}`;
  element('tour-button').classList.toggle('is-running', running);
  element('tour-button').setAttribute('aria-pressed', String(running));
  element('tour-stop').setAttribute('aria-label', tourText('stop'));
  element('tour-title').textContent = tourLabel(selectedTourChoice());
  element('tour-panel').hidden = !running && !activeTrail && !trailLoading && !trailFailed && !manifestFailed;
  element('tour-progress').hidden = !running;
  renderTourInfo();
  if (running) {
    element('tour-stops').classList.toggle('is-trail', !!activeTrail);
    if (activeTrail) {
      element('tour-count').textContent = `${Math.floor(trailProgress * 100)}%`;
      element('tour-stops').innerHTML = `<progress max="1" value="${trailProgress}" aria-label="${html(tourText('mapped'))}"></progress><span>${trailPart + 1} / ${activeTrail.geometry.coordinates.length} ${html(tourText('parts'))} · Esc</span>`;
    } else {
      element('tour-count').textContent = `${tourIndex + 1} / ${tourStops.length}`;
      element('tour-stops').innerHTML = tourStops.map((id, index) =>
        `<span class="${index === tourIndex ? 'is-current' : index < tourIndex ? 'is-visited' : ''}"><i>${index < tourIndex ? icon('check') : index + 1}</i>${html(placeName(places.find((place) => place.id === id)!))}</span>`).join('');
    }
  }
}

async function initializeTours(): Promise<void> {
  manifestFailed = false;
  renderTourChoices();
  renderTour();
  try {
    tourManifest = await loadTourManifest(AbortSignal.timeout(12000));
  } catch {
    manifestFailed = true;
  }
  renderTourChoices();
  renderTour();
}

async function changeTourTheme(id: string, play = false): Promise<void> {
  stopTour();
  const choice = tourManifest?.routes.find(route => route.id === id);
  selectedTour = choice?.available ? choice.id : DEFAULT_TOUR;
  element<HTMLSelectElement>('tour-theme').value = selectedTour;
  activeTrail = undefined;
  trailFailed = false;
  atlas?.setTourRoute(null);
  if (selectedTour === DEFAULT_TOUR || !choice) { renderTour(); return; }
  const controller = new AbortController();
  trailController = controller;
  trailLoading = true;
  renderTour();
  try {
    const route = await loadOlleRoute(choice, AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
    if (controller.signal.aborted || selectedTour !== id) return;
    activeTrail = route;
    if (mapReady) {
      atlas?.setTourRoute(route);
      atlas?.fitTourRoute(route);
    }
  } catch {
    if (!controller.signal.aborted) trailFailed = true;
  } finally {
    if (trailController === controller) {
      trailController = undefined;
      trailLoading = false;
      renderTour();
      if (play && activeTrail && !controller.signal.aborted) startTour();
    }
  }
}

function advanceTour(): void {
  if (tourIndex < 0) return;
  if (tourIndex >= tourStops.length) {
    stopTour();
    toast('제주 한 바퀴를 마쳤어요. 마음에 든 장소를 더 둘러보세요.');
    return;
  }
  const place = places.find((item) => item.id === tourStops[tourIndex])!;
  selectPlace(place, true, true);
  renderTour();
  tourTimer = setTimeout(() => {
    tourIndex += 1;
    advanceTour();
  }, mapModule?.reducedMotion() ? 5000 : 8000);
}

function stopTour(announce = false): void {
  const interrupted = tourIndex >= 0 || trailLoading;
  clearTimeout(tourTimer);
  if (tourAnimation !== undefined) cancelAnimationFrame(tourAnimation);
  tourAnimation = undefined;
  trailController?.abort();
  trailController = undefined;
  trailLoading = false;
  tourIndex = -1;
  if (interrupted) atlas?.stop();
  renderTour();
  if (announce && interrupted) toast(tourText('stopped'));
}

function startTrailTour(route: OlleRoute): void {
  const track = createTourTrack(route.geometry.coordinates);
  const started = performance.now();
  let lastPaint = -Infinity, lastProgress = -Infinity;
  trailProgress = 0;
  trailPart = 0;
  atlas?.stop();
  atlas?.setTourRoute(route);
  setDrawer(false);
  const tick = (now: number): void => {
    if (tourIndex < 0 || activeTrail !== route) return;
    trailProgress = Math.min(1, (now - started) / 90000);
    // Respect reduced motion with separate still views rather than motion.
    if (now - lastPaint >= (mapModule?.reducedMotion() ? 1500 : 45) || trailProgress === 1) {
      const frame = track.at(track.length * trailProgress);
      atlas?.followTour(frame);
      trailPart = frame.part;
      lastPaint = now;
    }
    if (now - lastProgress >= 750 || trailProgress === 1) {
      renderTour();
      lastProgress = now;
    }
    if (trailProgress === 1) {
      stopTour();
      toast(tourText('complete'));
    } else tourAnimation = requestAnimationFrame(tick);
  };
  tick(started);
}

function startTour(): void {
  if (!mapReady || trailLoading) return;
  if (selectedTour !== DEFAULT_TOUR) {
    if (!activeTrail) { void changeTourTheme(selectedTour, true); return; }
    tourIndex = 0;
    startTrailTour(activeTrail);
    return;
  }
  activeCategory = 'all';
  search = '';
  element<HTMLInputElement>('place-search').value = '';
  setCategory('all');
  tourIndex = 0;
  advanceTour();
}

async function shareView(): Promise<void> {
  if (!atlas || !mapModule) return;
  const url = mapModule.cameraURL(atlas.getState());
  await copyURL(url, '지금 보고 있는 제주의 주소를 복사했어요.');
}

async function copyURL(url: string, message: string): Promise<void> {
  try {
    history.replaceState(null, '', url);
  } catch {
    // Sharing also works in embedded pages that disallow history updates.
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url);
    toast(message);
  } catch {
    element<HTMLInputElement>('share-url').value = url;
    element<HTMLDialogElement>('share-dialog').showModal();
    element<HTMLInputElement>('share-url').select();
  }
}

function closeLayerPanel(): void {
  element('layer-panel').classList.remove('is-open');
  element('layer-trigger').setAttribute('aria-expanded', 'false');
}

element('place-search').addEventListener('input', (event) => {
  search = (event.target as HTMLInputElement).value;
  renderPlaces();
});
document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) => {
  button.addEventListener('click', () => setCategory(button.dataset.category!));
});
element('drawer-toggle').addEventListener('click', () => setDrawer(!drawerOpen));
element('brand-home').addEventListener('click', (event) => {
  event.preventDefault();
  stopTour();
  selectPlace(places[0], false);
  atlas?.reset();
});
element('zoom-in').addEventListener('click', () => { stopTour(); atlas?.zoom(1); });
element('zoom-out').addEventListener('click', () => { stopTour(); atlas?.zoom(-1); });
element('north-button').addEventListener('click', () => { stopTour(); atlas?.north(); });
element('reset-view').addEventListener('click', () => { stopTour(); atlas?.reset(); toast('제주 전체를 바라봅니다.'); });
element('mode-3d').addEventListener('click', () => { stopTour(); atlas?.set3D(true); });
element('mode-2d').addEventListener('click', () => { stopTour(); atlas?.set3D(false); });
element('basemap-satellite').addEventListener('click', () => atlas?.setBasemap('satellite'));
element('basemap-relief').addEventListener('click', () => atlas?.setBasemap('relief'));
element('elevation-range').addEventListener('input', (event) => atlas?.setExaggeration(Number((event.target as HTMLInputElement).value)));
element('actual-scale').addEventListener('click', () => atlas?.setExaggeration(1));
element('layer-trigger').addEventListener('click', () => {
  const open = !element('layer-panel').classList.contains('is-open');
  element('layer-panel').classList.toggle('is-open', open);
  element('layer-trigger').setAttribute('aria-expanded', String(open));
});
element('layer-close').addEventListener('click', closeLayerPanel);
element('tour-button').addEventListener('click', () => tourIndex >= 0 ? stopTour() : startTour());
element('tour-theme').addEventListener('change', (event) => {
  void changeTourTheme((event.target as HTMLSelectElement).value);
});
element('tour-stop').addEventListener('click', () => stopTour());
element('share-button').addEventListener('click', shareView);
element('share-close').addEventListener('click', () => element<HTMLDialogElement>('share-dialog').close());
element('share-select').addEventListener('click', () => {
  element<HTMLInputElement>('share-url').focus();
  element<HTMLInputElement>('share-url').select();
});
element('about-button').addEventListener('click', () => {
  stopTour();
  element<HTMLDialogElement>('about-dialog').showModal();
});
element('about-close').addEventListener('click', () => element<HTMLDialogElement>('about-dialog').close());
element('about-start').addEventListener('click', () => element<HTMLDialogElement>('about-dialog').close());
element('about-data').addEventListener('click', () => {
  element<HTMLDialogElement>('about-dialog').close();
  experience?.manageData();
});
document.querySelectorAll<HTMLDialogElement>('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
});
element('retry-map').addEventListener('click', () => void initializeMap(lastState));
element('fallback-map').addEventListener('click', () => {
  atlas?.setBasemap('relief');
  element('map-notice').hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    stopTour();
    closeLayerPanel();
    if (drawerOpen) setDrawer(false);
  }
  const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement)?.isContentEditable;
  if (event.key === '/' && !editing && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    experience?.searchFocus();
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopTour(); });
window.addEventListener('hashchange', () => {
  stopTour();
  if (mapReady && atlas && mapModule) {
    const state = mapModule.readView();
    atlas.restoreView(state);
    selected = places.find((place) => place.id === state.selectedId) ?? places[0];
    renderPlaces();
  } else void initializeMap();
});
window.matchMedia('(max-width: 760px)').addEventListener('change', () => {
  setDrawer(drawerOpen);
  atlas?.map.resize();
});
window.addEventListener('pagehide', () => {
  stopTour();
  clearTimeout(toastTimer);
});

renderPlaces();
renderSelected();
setDrawer(false);
experience = new AtlasExperience({
  atlas: () => atlas,
  closeDrawer: () => setDrawer(false),
  openDrawer: () => setDrawer(true),
  stopTour: () => stopTour(),
  notify: toast,
  cameraURL: () => atlas && mapModule ? mapModule.cameraURL(atlas.getState()) : window.location.href,
  copyURL,
});
window.addEventListener('atlas:locale-change', () => {
  renderPlaces();
  if (!experience?.refreshLocale()) renderSelected();
  renderTourChoices();
  renderTour();
});
initializeI18n(element<HTMLButtonElement>('language-toggle'), toast);
void initializeTours();
void initializeMap();
