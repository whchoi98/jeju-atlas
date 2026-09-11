import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { pointDistance, type TourPosition } from './tours.ts';
import { getLocale } from './i18n.ts';
import { icon } from './icons.ts';

export type Position = TourPosition;
const empty = () => ({ type: 'FeatureCollection' as const, features: [] });
const text = (ko: string, en: string) => getLocale() === 'en' ? en : ko;
export function metricDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

/** Measurement coordinates are view points, never routing destinations. */
export class MeasurementModel {
  private points: Position[] = [];
  get coordinates(): Position[] { return this.points.map(point => [...point]); }
  get result(): { segments_m: number[]; distance_m: number } {
    const segments_m = this.points.slice(1).map((point, index) => pointDistance(this.points[index], point));
    return { segments_m, distance_m: segments_m.reduce((sum, length) => sum + length, 0) };
  }
  add(point: Position): boolean {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
      || point[0] < 125.7 || point[0] > 127.4 || point[1] < 32.25 || point[1] > 34.55 || this.points.length >= 32) return false;
    const last = this.points.at(-1);
    if (last && pointDistance(last, point) < 0.1) return false;
    this.points.push([...point]);
    return true;
  }
  undo(): void { this.points.pop(); }
  clear(): void { this.points = []; }
}

export class DistanceMeasurement {
  readonly model = new MeasurementModel();
  private root: HTMLElement;
  private options: { onStart: () => void; notify: (message: string) => void };
  private map: MapLibreMap | undefined;
  private ready = false;
  private active = false;
  private visible = false;
  private doubleClickWasEnabled = false;
  private cursorBefore = '';
  private descriptionBefore = '';
  private clickOrigin: [number, number] | null = null;
  private onPointerDown = (event: PointerEvent) => { this.clickOrigin = [event.clientX, event.clientY]; };
  private onClick = (event: MouseEvent) => {
    if (!this.active || !this.map) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail > 1) return;
    if (this.clickOrigin && Math.hypot(event.clientX - this.clickOrigin[0], event.clientY - this.clickOrigin[1]) > 6) return;
    const rect = this.map.getCanvas().getBoundingClientRect();
    const point = this.map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    this.add([point.lng, point.lat]);
  };
  private onDoubleClick = (event: MouseEvent) => {
    if (this.active) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private onKey = (event: KeyboardEvent) => {
    if (!this.active || !this.map) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.addCenter();
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.model.undo(); this.draw(); this.render();
    }
  };
  get isActive(): boolean { return this.active; }

  constructor(root: HTMLElement, options: { onStart: () => void; notify: (message: string) => void }) {
    this.root = root; this.options = options;
    root.setAttribute('data-i18n-ignore', '');
    root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLElement>('[data-measure]')?.dataset.measure;
      if (action === 'toggle') this.active ? this.stop() : this.start();
      if (action === 'center') this.addCenter();
      if (action === 'undo') { this.model.undo(); this.draw(); this.render(); }
      if (action === 'clear') { this.model.clear(); this.draw(); this.render(); }
    });
    this.render();
  }

  attach(map: MapLibreMap): void {
    this.stop();
    this.detachListeners();
    this.map = map;
    this.ready = true;
    map.addSource('measurement-line', { type: 'geojson', data: empty() });
    map.addSource('measurement-points', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'measurement-line', type: 'line', source: 'measurement-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ff9900', 'line-width': 3, 'line-dasharray': [2, 1.5] },
    });
    map.addLayer({
      id: 'measurement-points', type: 'circle', source: 'measurement-points',
      paint: { 'circle-color': '#ff9900', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
    });
    map.getCanvas().addEventListener('click', this.onClick, true);
    map.getCanvas().addEventListener('pointerdown', this.onPointerDown, true);
    map.getCanvas().addEventListener('dblclick', this.onDoubleClick, true);
    map.getCanvas().addEventListener('keydown', this.onKey, true);
    this.draw();
    this.render();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.stop();
    this.root.hidden = !visible;
    this.draw();
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (!ready) this.stop();
    else this.render();
  }

  start(): void {
    if (!this.map || !this.ready || this.active) return;
    this.options.onStart();
    this.active = true;
    this.doubleClickWasEnabled = this.map.doubleClickZoom.isEnabled();
    this.map.doubleClickZoom.disable();
    this.cursorBefore = this.map.getCanvas().style.cursor;
    this.descriptionBefore = this.map.getCanvas().getAttribute('aria-describedby') ?? '';
    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.getCanvas().setAttribute('aria-describedby', `${this.descriptionBefore} measurement-hint`.trim());
    this.map.getContainer().closest('.map-shell')?.classList.add('is-measuring');
    this.render();
  }

  stop(): void {
    if (this.active && this.map) {
      if (this.doubleClickWasEnabled) this.map.doubleClickZoom.enable();
      this.map.getCanvas().style.cursor = this.cursorBefore;
      this.map.getCanvas().setAttribute('aria-describedby', this.descriptionBefore);
      this.map.getContainer().closest('.map-shell')?.classList.remove('is-measuring');
    }
    this.active = false;
    this.render();
  }

  private addCenter(): void {
    if (!this.map || !this.active) return;
    const center = this.map.getCenter();
    this.add([center.lng, center.lat]);
  }

  private add(point: Position): void {
    if (!this.model.add(point)) {
      if (this.model.coordinates.length >= 32) this.options.notify(text('측정은 최대 32개 점까지 가능합니다.', 'A measurement can contain up to 32 points.'));
      return;
    }
    this.draw();
    this.render();
  }

  private draw(): void {
    if (!this.map) return;
    const points = this.visible ? this.model.coordinates : [];
    (this.map.getSource('measurement-line') as GeoJSONSource | undefined)?.setData(points.length >= 2
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } } : empty());
    (this.map.getSource('measurement-points') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection', features: points.map((point, index) => ({
        type: 'Feature', properties: { order: index + 1 }, geometry: { type: 'Point', coordinates: point },
      })),
    });
  }

  render(): void {
    const focused = this.root.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.id : '';
    const points = this.model.coordinates;
    const result = this.model.result;
    this.root.innerHTML = `
      <p class="terrain-note">${text('점을 찍어 구간별 직선 거리를 재세요. 도보·차량의 도로 거리가 아닙니다.', 'Place points to measure straight-line segments. These are not walking or driving road distances.')}</p>
      <div class="terrain-actions"><button id="measurement-toggle" data-measure="toggle" aria-pressed="${this.active}" ${this.map && this.ready ? '' : 'disabled'}>${icon(this.active ? 'stop' : 'plus')}${text(this.active ? '측정 멈춤' : '측정 시작', this.active ? 'Stop measuring' : 'Start measuring')}</button><button id="measurement-center" data-measure="center" ${this.active ? '' : 'disabled'}>${icon('compass')}${text('지도 중심 추가', 'Add map center')}</button></div>
      <p id="measurement-hint" class="terrain-note">${this.active ? text('지도를 클릭하거나 중심으로 이동한 뒤 Enter를 누르세요. Backspace로 마지막 점을 취소합니다.', 'Click the map, or move to the center and press Enter. Backspace removes the last point.') : text('측정 시작을 누르면 지도에 점을 추가할 수 있어요.', 'Start measuring to add points on the map.')}</p>
      <div class="measurement-summary" role="status"><strong id="measurement-total">${metricDistance(result.distance_m)}</strong><span id="measurement-count">${points.length} / 32 ${text('점', 'points')} · ${text('직선 합계', 'Straight-line total')}</span></div>
      <div class="terrain-actions"><button id="measurement-undo" data-measure="undo" ${points.length ? '' : 'disabled'}>${text('마지막 점 취소', 'Undo last point')}</button><button id="measurement-clear" data-measure="clear" ${points.length ? '' : 'disabled'}>${text('초기화', 'Clear')}</button></div>
      <ol id="measurement-segments" class="measurement-segments" aria-label="${text('구간별 직선 거리', 'Straight-line segment distances')}">${result.segments_m.map((length, index) => `<li><span>${index + 1} → ${index + 2}</span><strong>${metricDistance(length)}</strong></li>`).join('')}</ol>`;
    if (focused) {
      const target = this.root.querySelector<HTMLElement>(`#${CSS.escape(focused)}:not(:disabled)`)
        ?? this.root.querySelector<HTMLElement>('#measurement-toggle');
      target?.focus({ preventScroll: true });
    }
  }

  private detachListeners(): void {
    this.map?.getCanvas().removeEventListener('click', this.onClick, true);
    this.map?.getCanvas().removeEventListener('pointerdown', this.onPointerDown, true);
    this.map?.getCanvas().removeEventListener('dblclick', this.onDoubleClick, true);
    this.map?.getCanvas().removeEventListener('keydown', this.onKey, true);
  }
  destroy(): void { this.ready = false; this.stop(); this.detachListeners(); this.map = undefined; }
}
