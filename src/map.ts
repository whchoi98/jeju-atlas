import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { places, type Place } from './places';
import { icon } from './icons';
import { getLocale, placeName, t } from './i18n';
import { createTourTrack, routeBounds, type OlleRoute, type TourFrame } from './tours';
import { CameraPlayback } from './scenes';
import { routeCoordinates } from './elevation-profile';

// v6 ships a separate module worker. Its default sibling URL is invalid after
// Vite hashes the main chunk; bundle the worker and its imports explicitly.
// Without this, imagery renders but DEM decoding and the map's load event stall.
maplibregl.setWorkerUrl(mapWorkerUrl);

export type Basemap = 'satellite' | 'relief';
export interface ViewState {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  is3D: boolean;
  basemap: Basemap;
  exaggeration: number;
  selectedId: string;
}

interface MapCallbacks {
  onReady: () => void;
  onMove: (state: ViewState) => void;
  onSelect: (place: Place) => void;
  onInteraction: () => void;
  onError: (message: string, fatal: boolean) => void;
  onRecovered: () => void;
}

// Published maps share one CloudFront tile cache. Local development and a
// standalone localhost preview keep working without a CloudFront router.
const localPreview = import.meta.env.DEV
  || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const terrainBase = localPreview
  ? 'https://s3.amazonaws.com/elevation-tiles-prod'
  : window.location.origin;
const terrainTiles = `${terrainBase}/terrarium/{z}/{x}/{y}.png`;
const terrainAttribution = 'Elevation: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen / AWS · USGS · NOAA</a>';
const satelliteAttribution = 'Tiles © Esri — Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
// Keep navigation around Jeju while allowing enough north/south water for a
// portrait viewport. Tighter latitude bounds force MapLibre to zoom past the
// overview on tall screens, clipping both ends of the island.
const bounds: [[number, number], [number, number]] = [[125.7, 32.25], [127.4, 34.55]];
const smallScreen = () => window.matchMedia('(max-width: 760px)').matches;
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function defaultZoom(): number {
  const width = smallScreen() ? window.innerWidth : window.innerWidth - 340;
  return Math.max(8, Math.min(9.7, 9.3 + Math.log2(width / 1000)));
}

export function defaultView(): ViewState {
  return {
    center: [126.56, 33.38],
    zoom: defaultZoom(),
    pitch: 55,
    bearing: -15,
    is3D: true,
    basemap: 'satellite',
    exaggeration: 1.5,
    selectedId: 'hallasan',
  };
}

function numeric(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? Math.min(max, Math.max(min, result)) : fallback;
}

export function readView(): ViewState {
  const state = defaultView();
  const params = new URLSearchParams(window.location.hash.slice(1));
  const camera = params.get('map')?.split('/');
  if (camera?.length === 5) {
    state.zoom = numeric(camera[0], state.zoom, 8, 17);
    state.center = [
      numeric(camera[2], state.center[0], bounds[0][0], bounds[1][0]),
      numeric(camera[1], state.center[1], bounds[0][1], bounds[1][1]),
    ];
    state.pitch = numeric(camera[3], state.pitch, 0, 70);
    state.bearing = numeric(camera[4], state.bearing, -180, 180);
  }
  state.is3D = params.get('mode') !== '2d';
  if (!state.is3D) state.pitch = 0;
  state.basemap = params.get('base') === 'relief' ? 'relief' : 'satellite';
  state.exaggeration = numeric(params.get('ex') ?? undefined, 1.5, 1, 2);
  state.selectedId = places.find((place) => place.id === params.get('place'))?.id ?? 'hallasan';
  return state;
}

export function cameraURL(state: ViewState): string {
  const url = new URL(window.location.href);
  for (const key of ['atlas_place', 'atlas_name', 'atlas_category', 'atlas_lat', 'atlas_lng']) url.searchParams.delete(key);
  const params = new URLSearchParams({
    map: [state.zoom.toFixed(3), state.center[1].toFixed(6), state.center[0].toFixed(6), state.pitch.toFixed(1), state.bearing.toFixed(1)].join('/'),
    mode: state.is3D ? '3d' : '2d',
    base: state.basemap,
    ex: state.exaggeration.toFixed(1),
    place: state.selectedId,
  });
  url.hash = params.toString().replaceAll('%2F', '/');
  return url.toString();
}

function createStyle(state: ViewState): StyleSpecification {
  const dem = {
    type: 'raster-dem' as const,
    tiles: [terrainTiles],
    tileSize: 256,
    maxzoom: 15,
    encoding: 'terrarium' as const,
    attribution: terrainAttribution,
  };

  return {
    version: 8,
    sources: {
      satellite: {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: satelliteAttribution,
      },
      'terrain-dem': { ...dem },
      // Separate from the terrain source, as recommended by MapLibre.
      'hillshade-dem': { ...dem },
    },
    layers: [
      {
        id: 'ocean',
        type: 'background',
        paint: { 'background-color': '#b1cfce' },
      },
      {
        id: 'satellite',
        type: 'raster',
        source: 'satellite',
        layout: { visibility: state.basemap === 'satellite' ? 'visible' : 'none' },
        paint: {
          'raster-saturation': -0.23,
          'raster-brightness-min': 0.07,
          'raster-brightness-max': 0.94,
          'raster-fade-duration': reducedMotion() ? 0 : 250,
        },
      },
      {
        id: 'elevation-colors',
        type: 'color-relief',
        source: 'hillshade-dem',
        layout: { visibility: state.basemap === 'relief' ? 'visible' : 'none' },
        paint: {
          'color-relief-color': [
            'interpolate', ['linear'], ['elevation'],
            -100, '#accdce',
            0, '#c1d9d7',
            1, '#e7ecdc',
            100, '#d5dfc5',
            350, '#b3cba7',
            650, '#88ad91',
            1000, '#638e7b',
            1350, '#b5b395',
            1650, '#d7c4a3',
            1950, '#f4ece0',
          ],
        },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshade-dem',
        paint: {
          'hillshade-exaggeration': state.basemap === 'relief' ? 0.45 : 0.17,
          'hillshade-shadow-color': '#233e42',
          'hillshade-highlight-color': '#f4f4e6',
          'hillshade-accent-color': '#627972',
        },
      },
    ],
    terrain: state.is3D ? { source: 'terrain-dem', exaggeration: state.exaggeration } : undefined,
    sky: {
      'sky-color': '#e8f0ef',
      'horizon-color': '#d3e5e3',
      'fog-color': '#d6e7e5',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.5,
    },
  };
}

export class AtlasMap {
  readonly map: MapLibreMap;
  private state: ViewState;
  private markers = new Map<string, maplibregl.Marker>();
  private callbacks: MapCallbacks;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private failedSources = new Set<string>();
  private ready = false;
  private disposed = false;
  private selection = 'hallasan';
  private representativeSelect: ((place: Place) => void) | undefined;
  private onContextLost: (event: Event) => void;
  private onContextRestored: () => void;
  private contextLost = false;
  private contextRestoring = false;
  private tourPart = -1;
  private orbitPlayback = new CameraPlayback();
  private routePlayback = new CameraPlayback();
  private previewProgress = 0;
  private motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  private onVisibility = () => { if (document.hidden) this.stop(); };
  private onMotionPreference = () => { if (this.motionPreference.matches) this.stop(); };
  private onRouteChange = () => this.stop();
  // Stop an existing flight before the first pointer starts a new gesture.
  // Subsequent fingers, wheel ticks and gesture-start events must not call
  // Map.stop(): it also resets MapLibre's active input handlers.
  private onDirectInput = (event: Event) => {
    const preserveGesture = event.type !== 'pointerdown' || (event as PointerEvent).isPrimary === false;
    this.stop({ preserveGesture });
    this.callbacks.onInteraction();
  };
  private onLocale = () => {
    for (const place of places) {
      const element = this.markers.get(place.id)?.getElement();
      if (!element) continue;
      element.setAttribute('title', placeName(place));
      element.setAttribute('aria-label', t(`${placeName(place)} 자세히 보기`));
      const label = element.querySelector<HTMLElement>('.marker-label');
      if (label) {
        label.setAttribute('data-i18n-ignore', '');
        label.innerHTML = `${placeName(place)}${place.id === 'hallasan' && getLocale() === 'ko' ? '<span class="marker-subtitle">HALLASAN</span>' : ''}`;
      }
    }
  };

  constructor(container: HTMLElement, state: ViewState, callbacks: MapCallbacks) {
    this.callbacks = callbacks;
    this.state = { ...state };
    this.selection = state.selectedId;
    this.map = new maplibregl.Map({
      container,
      style: createStyle(state),
      center: state.center,
      zoom: state.zoom,
      pitch: state.pitch,
      bearing: state.bearing,
      maxBounds: bounds,
      minZoom: 8,
      maxZoom: 17,
      maxPitch: 70,
      renderWorldCopies: false,
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
      fadeDuration: reducedMotion() ? 0 : 250,
      refreshExpiredTiles: true,
    });

    // Public, production-safe browser verification hook. The parent integration
    // can inspect getTerrain(), areTilesLoaded(), queryTerrainElevation(), etc.
    window.__JEJU_MAP__ = this.map;
    window.addEventListener('atlas:locale-change', this.onLocale);
    window.addEventListener('atlas:route-change', this.onRouteChange);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.motionPreference.addEventListener('change', this.onMotionPreference);
    this.map.addControl(new maplibregl.AttributionControl({
      compact: false,
      customAttribution: terrainAttribution,
    }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    this.map.getCanvas().setAttribute('aria-label', '제주 입체 지형 지도. 방향키로 이동, 더하기와 빼기로 확대와 축소할 수 있습니다.');
    this.map.getCanvas().setAttribute('aria-describedby', 'map-keyboard-help');

    this.onContextLost = (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.stop();
      callbacks.onError('그래픽 연결이 끊겼습니다. 복구를 기다리고 있어요. 계속 표시되지 않으면 다시 불러와 주세요.', true);
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      this.contextRestoring = true;
      this.map.once('render', () => {
        this.contextRestoring = false;
        this.tryRecovered();
      });
      this.map.triggerRepaint();
    };
    this.map.getCanvas().addEventListener('webglcontextlost', this.onContextLost);
    this.map.getCanvas().addEventListener('webglcontextrestored', this.onContextRestored);
    this.map.getCanvas().addEventListener('pointerdown', this.onDirectInput, { capture: true, passive: true });
    this.map.getCanvas().addEventListener('wheel', this.onDirectInput, { capture: true, passive: true });
    this.map.getCanvas().addEventListener('keydown', this.onDirectInput, { capture: true });

    this.loadTimer = setTimeout(() => {
      if (!this.ready) callbacks.onError('지형을 불러오는 데 시간이 걸리고 있습니다. 인터넷 연결을 확인하거나 다시 시도해 주세요.', false);
    }, 18000);

    this.map.on('load', () => {
      if (this.disposed) return;
      this.ready = true;
      clearTimeout(this.loadTimer);
      this.addMarkers();
      callbacks.onReady();
      this.emitMove();
    });

    this.map.on('move', () => this.emitMove());
    this.map.on('moveend', () => {
      this.emitMove();
      this.updateMarkerDensity();
    });
    this.map.on('idle', () => {
      this.tryRecovered();
    });
    this.map.on('error', (event) => {
      const sourceId = 'sourceId' in event && typeof event.sourceId === 'string' ? event.sourceId : undefined;
      if (sourceId) {
        this.failedSources.add(sourceId);
        callbacks.onError(
          sourceId === 'satellite'
            ? '위성 영상을 불러오지 못했습니다. 지형 지도로 전환하거나 다시 시도해 주세요.'
            : '일부 고도 데이터를 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.',
          false,
        );
      } else {
        console.error('[Jeju Atlas] Map error:', event.error?.message ?? event);
        callbacks.onError('지도를 표시하지 못했습니다. 다시 불러오거나 WebGL을 지원하는 브라우저에서 열어 주세요.', !this.ready);
      }
    });
    this.map.on('sourcedata', (event) => {
      if (event.isSourceLoaded && event.sourceId) {
        this.failedSources.delete(event.sourceId);
        this.tryRecovered();
      }
    });
    for (const eventName of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      this.map.on(eventName, (event) => {
        if (event.originalEvent) { this.stop({ preserveGesture: true }); callbacks.onInteraction(); }
      });
    }
  }

  private tryRecovered(): void {
    if (this.disposed || !this.ready || this.contextLost || this.contextRestoring || this.failedSources.size) return;
    const needed = ['hillshade-dem', ...(this.state.is3D ? ['terrain-dem'] : []), ...(this.state.basemap === 'satellite' ? ['satellite'] : [])];
    if (this.map.isStyleLoaded() && this.map.areTilesLoaded()
      && needed.every(source => this.map.getSource(source) && this.map.isSourceLoaded(source))) this.callbacks.onRecovered();
  }

  private addMarkers(): void {
    for (const place of places) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `place-marker place-marker--${place.category}`;
      element.dataset.landmarkId = place.id;
      if (place.catalogId) element.dataset.catalogId = place.catalogId;
      element.setAttribute('aria-label', `${place.name} 자세히 보기`);
      element.setAttribute('title', place.name);
      element.innerHTML = `<span class="marker-dot">${icon(place.category)}</span><span class="marker-label">${place.name}${place.id === 'hallasan' ? '<span class="marker-subtitle">HALLASAN</span>' : ''}</span>`;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onInteraction();
        this.callbacks.onSelect(place);
        this.representativeSelect?.(place);
      });
      const marker = new maplibregl.Marker({
        element,
        anchor: 'bottom',
        offset: [0, 0],
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
        opacityWhenCovered: 0.35,
      }).setLngLat(place.coordinates).addTo(this.map);
      this.markers.set(place.id, marker);
    }
    this.setSelected(this.selection);
    this.onLocale();
    this.updateMarkerDensity();
  }

  private updateMarkerDensity(): void {
    const zoom = this.map.getZoom();
    const primary = ['hallasan', 'seongsan', 'hyeopjae', 'udo', 'sanbangsan', 'hamdeok'];
    for (const [id, marker] of this.markers) {
      marker.getElement().classList.toggle('place-marker--quiet', zoom < 11 && !primary.includes(id) && id !== this.selection);
      marker.getElement().classList.toggle('place-marker--compact', smallScreen() && zoom < 10 && id !== this.selection);
    }
  }

  private emitMove(): void {
    if (this.disposed) return;
    const center = this.map.getCenter();
    this.state.center = [center.lng, center.lat];
    this.state.zoom = this.map.getZoom();
    this.state.pitch = this.map.getPitch();
    this.state.bearing = this.map.getBearing();
    this.callbacks.onMove(this.getState());
  }

  getState(): ViewState {
    return { ...this.state, center: [...this.state.center], selectedId: this.selection };
  }

  setRepresentativeSelectHandler(handler: (place: Place) => void): void {
    this.representativeSelect = handler;
  }

  restoreView(state: ViewState): void {
    this.stop();
    this.setExaggeration(state.exaggeration);
    this.setBasemap(state.basemap);
    this.set3D(state.is3D);
    this.setSelected(state.selectedId);
    this.map.jumpTo({
      center: state.center, zoom: state.zoom, pitch: state.pitch, bearing: state.bearing,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  }

  setSelected(id: string): void {
    this.selection = id;
    this.state.selectedId = id;
    for (const [markerId, marker] of this.markers) {
      const selected = markerId === id;
      marker.getElement().classList.toggle('is-selected', selected);
      marker.getElement().setAttribute('aria-pressed', String(selected));
    }
    this.updateMarkerDensity();
  }

  setCategory(category: string): void {
    for (const place of places) {
      this.markers.get(place.id)?.getElement().classList.toggle('is-filtered', category !== 'all' && category !== place.category);
    }
  }

  setTourRoute(route: OlleRoute | null): void {
    const empty = { type: 'FeatureCollection' as const, features: [] };
    if (!this.map.getSource('olle-tour-route')) {
      if (!route) return;
      this.map.addSource('olle-tour-route', {
        type: 'geojson', data: route,
        attribution: 'Trails © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors · ODbL</a>',
      });
      this.map.addLayer({
        id: 'olle-tour-casing', type: 'line', source: 'olle-tour-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 },
      });
      this.map.addLayer({
        id: 'olle-tour-line', type: 'line', source: 'olle-tour-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0972d3', 'line-width': 4 },
      });
      this.map.addSource('olle-tour-position', { type: 'geojson', data: empty });
      this.map.addLayer({
        id: 'olle-tour-position', type: 'circle', source: 'olle-tour-position',
        paint: { 'circle-radius': 7, 'circle-color': '#ff9900', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
      });
    }
    (this.map.getSource('olle-tour-route') as GeoJSONSource).setData(route ?? empty);
    (this.map.getSource('olle-tour-position') as GeoJSONSource).setData(empty);
    this.tourPart = -1;
  }

  fitTourRoute(route: OlleRoute): void {
    const height = this.map.getContainer().clientHeight;
    this.map.fitBounds(routeBounds(route.geometry.coordinates), {
      padding: { top: Math.min(130, height * 0.23), bottom: Math.min(125, height * 0.2), left: 32, right: 70 },
      maxZoom: 13.5, pitch: this.state.is3D ? 45 : 0, bearing: 0,
      duration: reducedMotion() ? 0 : 1400,
    });
  }

  followTour(frame: TourFrame): void {
    const source = this.map.getSource('olle-tour-position') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: frame.center } });
    const current = this.map.getBearing();
    const delta = ((frame.bearing - current + 540) % 360) - 180;
    const bearing = this.tourPart === frame.part && !reducedMotion() ? current + delta * 0.08 : frame.bearing;
    this.tourPart = frame.part;
    // jumpTo is intentional: every animation tick samples the source polyline.
    // An ease/fly between sparse samples would cut corners or bridge data gaps.
    this.map.jumpTo({
      center: frame.center, zoom: smallScreen() ? 14 : 14.5, bearing,
      pitch: this.state.is3D ? 55 : 0,
      padding: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  }

  flyTo(place: Place, tour = false): void {
    this.stop();
    this.setSelected(place.id);
    const duration = reducedMotion() ? 0 : tour ? 3300 : 2200;
    this.map.flyTo({
      center: place.coordinates,
      zoom: smallScreen() ? place.zoom - 0.7 : place.zoom,
      bearing: place.bearing,
      pitch: this.state.is3D ? 58 : 0,
      duration,
      essential: false,
      padding: { top: 40, bottom: smallScreen() ? 135 : 120, left: 0, right: smallScreen() ? 0 : 70 },
    });
  }

  reset(): void {
    this.stop();
    const view = defaultView();
    this.map.flyTo({
      center: view.center,
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: this.state.is3D ? view.pitch : 0,
      duration: reducedMotion() ? 0 : 1800,
      padding: { top: 0, bottom: smallScreen() ? 95 : 20, left: 0, right: 0 },
    });
  }

  set3D(enabled: boolean): void {
    this.stop();
    this.state.is3D = enabled;
    this.map.setTerrain(enabled ? { source: 'terrain-dem', exaggeration: this.state.exaggeration } : null);
    this.map.easeTo({
      pitch: enabled ? 55 : 0,
      duration: reducedMotion() ? 0 : 900,
    });
    this.emitMove();
  }

  setExaggeration(value: number): void {
    this.stop();
    this.state.exaggeration = Math.min(2, Math.max(1, value));
    if (this.state.is3D) this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.state.exaggeration });
    this.emitMove();
  }

  setBasemap(basemap: Basemap): void {
    this.state.basemap = basemap;
    this.map.setLayoutProperty('satellite', 'visibility', basemap === 'satellite' ? 'visible' : 'none');
    this.map.setLayoutProperty('elevation-colors', 'visibility', basemap === 'relief' ? 'visible' : 'none');
    this.map.setPaintProperty('hillshade', 'hillshade-exaggeration', basemap === 'relief' ? 0.45 : 0.17);
    if (basemap === 'relief') this.failedSources.delete('satellite');
    this.emitMove();
  }

  zoom(amount: number): void {
    this.stop();
    this.map.zoomTo(this.map.getZoom() + amount, { duration: reducedMotion() ? 0 : 350 });
  }

  north(): void {
    this.stop();
    this.map.rotateTo(0, { duration: reducedMotion() ? 0 : 600 });
  }

  get isOrbiting(): boolean { return this.orbitPlayback.running; }
  get isPreviewingRoute(): boolean { return this.routePlayback.running; }
  get routePreviewProgress(): number { return this.previewProgress; }

  private activity(kind: 'orbit' | 'route', running: boolean): void {
    window.dispatchEvent(new CustomEvent('atlas:camera-activity', { detail: { kind, running, progress: this.previewProgress } }));
  }

  private inspectionPadding(): { top: number; bottom: number; left: number; right: number } {
    const container = this.map.getContainer();
    const panel = container.closest('.map-shell')?.querySelector<HTMLElement>('#terrain-tools-panel');
    const shown = panel && !panel.hidden && panel.offsetHeight > 0;
    if (smallScreen()) {
      const occupied = shown ? container.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 20 : 150;
      return { top: 70, bottom: Math.max(100, Math.min(container.clientHeight - 170, occupied)), left: 12, right: 25 };
    }
    return { top: 40, bottom: 115, left: 20, right: shown ? Math.min(panel.offsetWidth + 110, container.clientWidth * 0.46) : 80 };
  }

  inspectScene(place: Place, overhead = false): void {
    if (!this.ready || this.disposed || this.contextLost) return;
    this.stop();
    this.state.is3D = true;
    this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.state.exaggeration });
    this.setSelected(place.id);
    this.map.flyTo({
      center: place.coordinates, zoom: smallScreen() ? place.zoom - 0.7 : place.zoom,
      pitch: overhead ? 0 : 58, bearing: overhead ? 0 : place.bearing,
      duration: reducedMotion() ? 0 : 1400, essential: false,
      padding: this.inspectionPadding(),
    });
    this.emitMove();
  }

  startOrbit(place: Place): void {
    this.callbacks.onInteraction();
    this.stop();
    if (!this.ready || this.disposed || this.contextLost || reducedMotion() || document.hidden) return;
    this.state.is3D = true;
    this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.state.exaggeration });
    this.setSelected(place.id);
    this.map.jumpTo({
      center: place.coordinates, zoom: smallScreen() ? place.zoom - 0.7 : place.zoom,
      pitch: 58, bearing: place.bearing,
      padding: this.inspectionPadding(),
    });
    this.orbitPlayback.start(30000, progress => {
      this.map.jumpTo({ bearing: place.bearing + progress * 360 });
    }, () => this.activity('orbit', false));
    this.activity('orbit', true);
  }

  previewRoute(coordinates: [number, number][]): void {
    const line = routeCoordinates(coordinates);
    const track = createTourTrack([line]);
    this.callbacks.onInteraction();
    this.stop();
    if (!this.ready || this.disposed || this.contextLost || document.hidden) return;
    if (reducedMotion()) { this.showRouteOverview(line); return; }
    this.state.is3D = true;
    this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.state.exaggeration });
    if (!this.map.getSource('terrain-route-preview')) {
      this.map.addSource('terrain-route-preview', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        attribution: 'Routes © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors · ODbL</a>',
      });
      this.map.addLayer({
        id: 'terrain-route-preview', type: 'line', source: 'terrain-route-preview',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0972d3', 'line-width': 5, 'line-opacity': 0.8 },
      });
      this.map.addSource('terrain-route-position', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({
        id: 'terrain-route-position', type: 'circle', source: 'terrain-route-position',
        paint: { 'circle-color': '#ff9900', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
      });
    }
    (this.map.getSource('terrain-route-preview') as GeoJSONSource).setData({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line },
    });
    let bearing: number | undefined, lastStatus = -1;
    const padding = this.inspectionPadding();
    this.routePlayback.start(Math.min(90000, Math.max(15000, track.length * 4)), progress => {
      const frame = track.at(track.length * progress);
      const delta = bearing === undefined ? 0 : ((frame.bearing - bearing + 540) % 360) - 180;
      bearing = bearing === undefined ? frame.bearing : bearing + delta * 0.12;
      this.previewProgress = progress;
      (this.map.getSource('terrain-route-position') as GeoJSONSource).setData({
        type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: frame.center },
      });
      // Every camera frame samples the original line; sparse waypoint flights
      // would otherwise cut corners and leave the real road.
      this.map.jumpTo({
        center: frame.center, zoom: smallScreen() ? 14 : 14.5, pitch: 55, bearing,
        padding,
      });
      if (Math.floor(progress * 100) !== lastStatus) {
        lastStatus = Math.floor(progress * 100);
        this.activity('route', true);
      }
    }, () => this.stopRoutePreview());
    this.activity('route', true);
  }

  stopRoutePreview(): void {
    const active = this.routePlayback.running || this.previewProgress > 0;
    this.routePlayback.stop();
    this.previewProgress = 0;
    for (const name of ['terrain-route-preview', 'terrain-route-position']) {
      (this.map.getSource(name) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    }
    if (active) this.activity('route', false);
  }

  showRouteOverview(coordinates: [number, number][]): void {
    const line = routeCoordinates(coordinates);
    this.stop();
    if (!this.ready || this.disposed || this.contextLost) return;
    this.state.is3D = true;
    this.map.setTerrain({ source: 'terrain-dem', exaggeration: this.state.exaggeration });
    this.map.fitBounds(routeBounds([line]), {
      padding: this.inspectionPadding(),
      maxZoom: 14, pitch: 45, bearing: 0, duration: reducedMotion() ? 0 : 1200,
    });
  }

  setProfilePoint(point: [number, number] | null): void {
    if (!this.ready || this.disposed) return;
    if (!this.map.getSource('terrain-profile-point')) {
      if (!point) return;
      this.map.addSource('terrain-profile-point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({
        id: 'terrain-profile-point', type: 'circle', source: 'terrain-profile-point',
        paint: { 'circle-color': '#232f3e', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
      });
    }
    (this.map.getSource('terrain-profile-point') as GeoJSONSource).setData(point
      ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } }
      : { type: 'FeatureCollection', features: [] });
  }

  stop({ preserveGesture = false }: { preserveGesture?: boolean } = {}): void {
    const orbiting = this.orbitPlayback.running;
    this.orbitPlayback.stop();
    this.stopRoutePreview();
    if (!preserveGesture) this.map.stop();
    if (orbiting) this.activity('orbit', false);
  }

  destroy(): void {
    this.stop();
    this.disposed = true;
    clearTimeout(this.loadTimer);
    window.removeEventListener('atlas:locale-change', this.onLocale);
    window.removeEventListener('atlas:route-change', this.onRouteChange);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.motionPreference.removeEventListener('change', this.onMotionPreference);
    this.map.getCanvas().removeEventListener('webglcontextlost', this.onContextLost);
    this.map.getCanvas().removeEventListener('webglcontextrestored', this.onContextRestored);
    this.map.getCanvas().removeEventListener('pointerdown', this.onDirectInput, true);
    this.map.getCanvas().removeEventListener('wheel', this.onDirectInput, true);
    this.map.getCanvas().removeEventListener('keydown', this.onDirectInput, true);
    for (const marker of this.markers.values()) marker.remove();
    this.map.remove();
    if (window.__JEJU_MAP__ === this.map) delete window.__JEJU_MAP__;
  }
}
