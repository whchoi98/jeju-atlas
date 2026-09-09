import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { places, type Place } from './places';
import { icon } from './icons';

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
  private onContextLost: (event: Event) => void;
  private onContextRestored: () => void;

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
    this.map.addControl(new maplibregl.AttributionControl({
      compact: false,
      customAttribution: terrainAttribution,
    }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    this.map.getCanvas().setAttribute('aria-label', '제주 입체 지형 지도. 방향키로 이동, 더하기와 빼기로 확대와 축소할 수 있습니다.');
    this.map.getCanvas().setAttribute('aria-describedby', 'map-keyboard-help');

    this.onContextLost = (event) => {
      event.preventDefault();
      callbacks.onError('그래픽 연결이 끊겼습니다. 지도를 다시 불러와 주세요.', true);
    };
    this.onContextRestored = () => {
      this.map.triggerRepaint();
      callbacks.onRecovered();
    };
    this.map.getCanvas().addEventListener('webglcontextlost', this.onContextLost);
    this.map.getCanvas().addEventListener('webglcontextrestored', this.onContextRestored);

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
      if (this.ready && this.failedSources.size === 0) callbacks.onRecovered();
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
        if (this.ready && this.failedSources.size === 0 && this.map.areTilesLoaded()) callbacks.onRecovered();
      }
    });
    for (const eventName of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) {
      this.map.on(eventName, (event) => {
        if (event.originalEvent) callbacks.onInteraction();
      });
    }
    this.map.getCanvas().addEventListener('keydown', () => callbacks.onInteraction());
  }

  private addMarkers(): void {
    for (const place of places) {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `place-marker place-marker--${place.category}`;
      element.setAttribute('aria-label', `${place.name} 자세히 보기`);
      element.setAttribute('title', place.name);
      element.innerHTML = `<span class="marker-dot">${icon(place.category)}</span><span class="marker-label">${place.name}${place.id === 'hallasan' ? '<span class="marker-subtitle">HALLASAN</span>' : ''}</span>`;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onInteraction();
        this.callbacks.onSelect(place);
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

  flyTo(place: Place, tour = false): void {
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
    this.state.is3D = enabled;
    this.map.setTerrain(enabled ? { source: 'terrain-dem', exaggeration: this.state.exaggeration } : null);
    this.map.easeTo({
      pitch: enabled ? 55 : 0,
      duration: reducedMotion() ? 0 : 900,
    });
    this.emitMove();
  }

  setExaggeration(value: number): void {
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
    this.map.zoomTo(this.map.getZoom() + amount, { duration: reducedMotion() ? 0 : 350 });
  }

  north(): void {
    this.map.rotateTo(0, { duration: reducedMotion() ? 0 : 600 });
  }

  stop(): void {
    this.map.stop();
  }

  destroy(): void {
    this.disposed = true;
    clearTimeout(this.loadTimer);
    this.map.getCanvas().removeEventListener('webglcontextlost', this.onContextLost);
    this.map.getCanvas().removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const marker of this.markers.values()) marker.remove();
    this.map.remove();
    if (window.__JEJU_MAP__ === this.map) delete window.__JEJU_MAP__;
  }
}
