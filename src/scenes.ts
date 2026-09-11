import type { AtlasMap, ViewState } from './map.ts';
import { places, type Place } from './places.ts';
import { getLocale, placeName } from './i18n.ts';
import { html } from './api.ts';
import { icon } from './icons.ts';
import { DistanceMeasurement, type Position } from './measurement.ts';
import { ElevationProfile, routeCoordinates } from './elevation-profile.ts';
import type { RouteSuccess } from '../shared/routing-types.ts';

type FrameClock = {
  now: () => number; requestFrame: (callback: FrameRequestCallback) => number; cancelFrame: (handle: number) => void;
};
/** Shared by orbit and route preview; a replaced callback cannot regain camera control. */
export class CameraPlayback {
  private clock: FrameClock;
  private frame: number | undefined;
  private generation = 0;
  private active = false;
  constructor(clock: FrameClock = {
    now: () => performance.now(), requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => cancelAnimationFrame(handle),
  }) { this.clock = clock; }
  get running(): boolean { return this.active; }
  start(duration: number, paint: (progress: number) => void, complete?: () => void): void {
    this.stop();
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid playback duration');
    const generation = ++this.generation, started = this.clock.now();
    let lastPaint = -Infinity;
    this.active = true;
    const tick = (now: number) => {
      if (!this.active || generation !== this.generation) return;
      const progress = Math.max(0, Math.min(1, (now - started) / duration));
      if (now - lastPaint >= 50 || progress === 1) { paint(progress); lastPaint = now; }
      if (!this.active || generation !== this.generation) return;
      if (progress === 1) { this.frame = undefined; this.active = false; complete?.(); }
      else this.frame = this.clock.requestFrame(tick);
    };
    tick(started);
  }
  stop(): void {
    this.active = false; this.generation++;
    if (this.frame !== undefined) this.clock.cancelFrame(this.frame);
    this.frame = undefined;
  }
}

const words = (ko: string, en: string) => getLocale() === 'en' ? en : ko;
type SceneTab = 'places' | 'route' | 'measure';
interface SceneOptions {
  atlas: () => AtlasMap | undefined;
  onSelect: (place: Place) => void;
  onDetails: (place: Place) => void;
  stopOtherPlayback: () => void;
  closeDrawer: () => void;
  notify: (message: string) => void;
}

export class TerrainScenes {
  private shell: HTMLElement;
  private options: SceneOptions;
  readonly measurement: DistanceMeasurement;
  private profile: ElevationProfile;
  private selected = places[0];
  private tab: SceneTab = 'places';
  private open = false;
  private ready = false;
  private route: Position[] | null = null;
  private routeMode: 'walk' | 'car' = 'walk';
  private panel: HTMLElement;
  private launcher: HTMLButtonElement;
  private placePanel: HTMLElement;
  private routePanel: HTMLElement;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private wideLayout = matchMedia('(min-width: 1181px)');
  private placeLauncher = () => {
    const target = this.shell.querySelector(this.wideLayout.matches ? '#layer-panel' : '.map-tools');
    if (this.wideLayout.matches) target?.prepend(this.launcher);
    else target?.append(this.launcher);
  };
  private overlays: MutationObserver;
  private onLocale = () => { this.render(); this.measurement.render(); this.profile.render(); };
  private onMotion = () => { if (this.reduced.matches) this.stop(); this.render(); };
  private onActivity = (event: Event) => {
    if ((event as CustomEvent<{ running?: boolean }>).detail?.running && this.measurement.isActive) this.measurement.stop();
    this.renderActivity();
  };
  private onRoute = (event: Event) => {
    const candidate = (event as CustomEvent<{ route?: RouteSuccess | null }>).detail?.route;
    this.options.stopOtherPlayback();
    this.stop();
    try {
      this.route = candidate?.available && ['walk', 'car'].includes(String(candidate.mode))
        ? routeCoordinates(candidate.coordinates) : null;
      this.routeMode = candidate?.mode === 'car' ? 'car' : 'walk';
    } catch { this.route = null; }
    this.profile.setRoute(this.route);
    this.render();
  };
  private onPreview = (event: Event) => {
    try {
      const coordinates = routeCoordinates((event as CustomEvent<{ coordinates?: unknown }>).detail?.coordinates);
      this.show('route');
      this.options.stopOtherPlayback();
      this.measurement.stop();
      this.options.atlas()?.previewRoute(coordinates);
      this.renderActivity();
    } catch { this.options.notify(words('표시할 실제 경로가 없습니다.', 'No valid route is available to preview.')); }
  };

  constructor(shell: HTMLElement, options: SceneOptions) {
    this.shell = shell; this.options = options;
    this.launcher = document.createElement('button');
    this.launcher.id = 'terrain-tools-toggle';
    this.launcher.className = 'terrain-tools-toggle control-surface';
    this.launcher.setAttribute('data-i18n-ignore', '');
    this.launcher.setAttribute('aria-controls', 'terrain-tools-panel');
    this.launcher.addEventListener('click', () => this.open ? this.hide() : this.show());
    this.placeLauncher();
    this.wideLayout.addEventListener('change', this.placeLauncher);
    this.panel = document.createElement('section');
    this.panel.id = 'terrain-tools-panel';
    this.panel.className = 'terrain-tools-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('data-i18n-ignore', '');
    this.panel.setAttribute('aria-labelledby', 'terrain-tools-title');
    this.panel.innerHTML = `<div class="terrain-panel-heading"><div><h2 id="terrain-tools-title"></h2><span id="terrain-scale"></span></div><button id="terrain-tools-close">${icon('close')}</button></div>
      <div class="terrain-tabs" role="tablist"><button id="terrain-tab-places" role="tab" data-terrain-tab="places" aria-controls="terrain-places-panel"></button><button id="terrain-tab-route" role="tab" data-terrain-tab="route" aria-controls="terrain-route-panel"></button><button id="terrain-tab-measure" role="tab" data-terrain-tab="measure" aria-controls="terrain-measure-panel"></button></div>
      <div class="terrain-panel-content"><section id="terrain-places-panel" role="tabpanel" aria-labelledby="terrain-tab-places"></section><section id="terrain-route-panel" role="tabpanel" aria-labelledby="terrain-tab-route" hidden><div id="terrain-route-actions"></div><section id="terrain-profile"></section></section><section id="terrain-measure-panel" role="tabpanel" aria-labelledby="terrain-tab-measure" hidden></section></div>`;
    shell.append(this.panel);
    this.overlays = new MutationObserver(() => {
      if (this.open && shell.classList.contains('is-detail-open')) this.hide(false);
    });
    this.overlays.observe(shell, { attributes: true, attributeFilter: ['class'] });
    this.placePanel = this.panel.querySelector('#terrain-places-panel')!;
    this.routePanel = this.panel.querySelector('#terrain-route-actions')!;
    this.profile = new ElevationProfile(this.panel.querySelector('#terrain-profile')!, point => options.atlas()?.setProfilePoint(point));
    this.measurement = new DistanceMeasurement(this.panel.querySelector('#terrain-measure-panel')!, {
      onStart: () => { options.stopOtherPlayback(); options.atlas()?.stop(); }, notify: options.notify,
    });
    this.panel.addEventListener('click', event => this.click(event));
    this.panel.querySelector('.terrain-tabs')!.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      event.preventDefault();
      const tabs: SceneTab[] = ['places', 'route', 'measure'], current = tabs.indexOf(this.tab);
      const index = key === 'Home' ? 0 : key === 'End' ? 2 : (current + (key === 'ArrowRight' ? 1 : 2)) % 3;
      this.show(tabs[index]); this.panel.querySelector<HTMLElement>(`#terrain-tab-${this.tab}`)?.focus();
    });
    window.addEventListener('atlas:locale-change', this.onLocale);
    window.addEventListener('atlas:route-change', this.onRoute);
    window.addEventListener('atlas:preview-route', this.onPreview);
    window.addEventListener('atlas:camera-activity', this.onActivity);
    this.reduced.addEventListener('change', this.onMotion);
    this.render();
  }

  attach(atlas: AtlasMap): void {
    this.ready = true;
    this.measurement.attach(atlas.map);
    this.profile.setVisible(this.open && this.tab === 'route');
    this.render();
  }
  detachMap(): void { this.measurement.destroy(); this.profile.setVisible(false); this.ready = false; }
  get isOpen(): boolean { return this.open; }
  setReady(ready: boolean): void {
    this.ready = ready;
    this.measurement.setReady(ready);
    if (!ready) this.hide(false);
    else this.render();
  }
  updateView(state: Pick<ViewState, 'is3D' | 'exaggeration'>): void {
    const target = this.panel.querySelector('#terrain-scale');
    const label = state.is3D
      ? `${words('표시 고도 배율', 'Display elevation scale')} ${state.exaggeration.toFixed(1)}×`
      : words('2D 보기 · 단면은 실제 고도', '2D view · Profile uses actual heights');
    if (target && target.textContent !== label) target.textContent = label;
  }
  setSelected(place: Place): void { this.selected = place; if (this.open) this.render(); }
  inspect(id: string): boolean {
    const place = places.find(place => place.id === id || place.catalogId === id);
    if (!place) return false;
    this.selected = place;
    this.show('places');
    this.options.stopOtherPlayback();
    this.measurement.stop();
    this.options.onSelect(place);
    this.options.atlas()?.inspectScene(place);
    this.render();
    return true;
  }
  show(tab: SceneTab = this.tab): void {
    const opening = !this.open;
    if (opening || this.tab !== tab) this.options.stopOtherPlayback();
    this.open = true; this.tab = tab;
    this.options.closeDrawer();
    this.panel.hidden = false;
    this.shell.classList.add('is-terrain-tools-open');
    this.measurement.setVisible(tab === 'measure');
    this.profile.setVisible(tab === 'route');
    this.render();
    if (opening) this.panel.querySelector<HTMLElement>(`#terrain-tab-${tab}`)?.focus({ preventScroll: true });
  }
  hide(restoreFocus = true): void {
    this.stop();
    this.open = false; this.panel.hidden = true;
    this.shell.classList.remove('is-terrain-tools-open');
    this.measurement.setVisible(false); this.profile.setVisible(false);
    this.render();
    if (restoreFocus) this.launcher.focus({ preventScroll: true });
  }
  stop(): void { this.options.atlas()?.stop(); this.measurement.stop(); this.profile.cancel(); }

  private click(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    if (target.id === 'terrain-tools-close') { this.hide(); return; }
    if (target.dataset.terrainTab) { this.show(target.dataset.terrainTab as SceneTab); return; }
    if (target.dataset.sceneId) { this.inspect(target.dataset.sceneId); return; }
    const atlas = this.options.atlas();
    if (!atlas || !this.ready) return;
    if (target.dataset.profile === 'load') { this.options.stopOtherPlayback(); atlas.stop(); }
    if (target.id === 'scene-details') { this.stop(); this.hide(false); this.options.onDetails(this.selected); return; }
    if (target.id === 'scene-orbit') {
      const running = atlas.isOrbiting;
      this.options.stopOtherPlayback(); this.measurement.stop();
      if (running) atlas.stop();
      else { this.options.onSelect(this.selected); atlas.startOrbit(this.selected); }
    }
    if (target.id === 'scene-oblique') { this.options.stopOtherPlayback(); this.options.onSelect(this.selected); atlas.inspectScene(this.selected); }
    if (target.id === 'scene-above') { this.options.stopOtherPlayback(); this.options.onSelect(this.selected); atlas.inspectScene(this.selected, true); }
    if (target.id === 'scene-actual') atlas.setExaggeration(1);
    if (target.id === 'scene-overview') { this.options.stopOtherPlayback(); atlas.reset(); }
    if (target.id === 'route-preview-start' && this.route) {
      if (atlas.isPreviewingRoute) atlas.stopRoutePreview();
      else { this.options.stopOtherPlayback(); this.measurement.stop(); atlas.previewRoute(this.route); }
    }
    if (target.id === 'route-preview-overview' && this.route) { this.options.stopOtherPlayback(); atlas.showRouteOverview(this.route); }
    this.renderActivity();
  }

  private render(): void {
    const focused = this.panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : '';
    this.launcher.innerHTML = `${icon('mountain')}<span>${words('3D 탐색·측정', '3D & measure')}</span>`;
    this.launcher.disabled = !this.ready;
    this.launcher.setAttribute('aria-expanded', String(this.open));
    this.launcher.setAttribute('aria-label', words('3D 명소와 고도·거리 측정 도구', '3D landmarks, elevation and distance tools'));
    this.panel.querySelector('#terrain-tools-title')!.textContent = words('제주, 더 가까이', 'A closer look at Jeju');
    this.updateView(this.options.atlas()?.getState() ?? { is3D: true, exaggeration: 1.5 });
    this.panel.querySelector('#terrain-tools-close')!.setAttribute('aria-label', words('3D 탐색 도구 닫기', 'Close terrain tools'));
    this.panel.querySelector('.terrain-tabs')!.setAttribute('aria-label', words('지도 탐색 도구', 'Map exploration tools'));
    for (const [id, label] of [['places', words('3D 명소', '3D places')], ['route', words('경로·고도', 'Route & height')], ['measure', words('거리 재기', 'Measure')]]) {
      const button = this.panel.querySelector<HTMLButtonElement>(`#terrain-tab-${id}`)!;
      button.textContent = label; button.tabIndex = this.tab === id ? 0 : -1;
      button.setAttribute('aria-selected', String(this.tab === id));
      this.panel.querySelector<HTMLElement>(`#terrain-${id}-panel`)!.hidden = this.tab !== id;
    }
    this.placePanel.innerHTML = `<p class="terrain-note">${words('실제 DEM과 위성 영상으로 보는 지형입니다. 사진측량 건물 모델이나 실시간 영상이 아닙니다.', 'Terrain from real DEM and satellite imagery. It is not a photogrammetric building model or live video.')}</p>
      <div class="scene-grid" aria-label="${words('주요 지형 명소 12곳', '12 terrain landmarks')}">${places.map(place => `<button id="scene-${place.id}" data-scene-id="${place.id}" aria-pressed="${this.selected.id === place.id}" ${this.ready ? '' : 'disabled'}>${icon(place.category)}<span>${html(placeName(place))}</span></button>`).join('')}</div>
      <div class="scene-selection"><span class="terrain-eyebrow">${words('선택한 지형', 'Selected terrain')}</span><h3 id="scene-name">${html(placeName(this.selected))}</h3><p>${this.selected.coordinates[1].toFixed(4)}° N · ${this.selected.coordinates[0].toFixed(4)}° E</p></div>
      <div class="terrain-actions"><button id="scene-orbit" ${!this.ready || this.reduced.matches ? 'disabled' : ''}></button><button id="scene-above" ${this.ready ? '' : 'disabled'}>${icon('expand')}${words('위에서', 'From above')}</button><button id="scene-oblique" ${this.ready ? '' : 'disabled'}>${icon('mountain')}${words('입체 관찰', 'Oblique view')}</button></div>
      <div class="terrain-actions"><button id="scene-actual" ${this.ready ? '' : 'disabled'}>1× ${words('실제 고도', 'Actual scale')}</button><button id="scene-overview" ${this.ready ? '' : 'disabled'}>${words('제주 전체', 'Whole island')}</button><button id="scene-details" ${this.selected.catalogId && this.ready ? '' : 'disabled'}>${words('사진·장소 정보', 'Photos & details')}</button></div>
      <p id="scene-motion-note" class="terrain-note">${this.reduced.matches ? words('동작 줄이기가 켜져 있어 자동 회전은 꺼집니다. 고정 시점을 사용하세요.', 'Reduced motion is enabled. Use the fixed viewpoints instead of automatic rotation.') : words('회전은 한 바퀴 후 멈춥니다. 지도 조작이나 Esc로 바로 멈출 수 있어요.', 'Rotation stops after one turn. Interact with the map or press Esc to stop sooner.')}</p>`;
    this.routePanel.innerHTML = `<h3>${words('실제 경로 3D 미리보기', 'Preview the actual route in 3D')}</h3><p class="terrain-note">${this.route ? words(`${this.routeMode === 'walk' ? '도보' : '차량'} 경로의 실제 선을 따라 시점이 이동합니다. 재생 시간은 이동 예상 시간이 아닙니다.`, `The camera follows the actual ${this.routeMode === 'walk' ? 'walking' : 'driving'} route. Playback duration is not travel time.`) : words('내 여행에서 두 장소 이상의 경로를 먼저 계산하세요.', 'Calculate a route between at least two places in My trip first.')}</p>
      <div class="terrain-actions"><button id="route-preview-start" ${this.route && this.ready && !this.reduced.matches ? '' : 'disabled'}></button><button id="route-preview-overview" ${this.route && this.ready ? '' : 'disabled'}>${words('경로 전체 보기', 'Whole route')}</button></div><p id="route-preview-progress" class="terrain-note" role="status"></p>${this.reduced.matches ? `<p class="terrain-note">${words('동작 줄이기 설정으로 자동 미리보기를 멈췄습니다.', 'Automatic preview is stopped by your reduced-motion setting.')}</p>` : ''}`;
    this.renderActivity();
    if (focused) this.panel.querySelector<HTMLElement>(`#${CSS.escape(focused)}`)?.focus({ preventScroll: true });
  }
  private renderActivity(): void {
    const atlas = this.options.atlas();
    const orbit = this.panel.querySelector('#scene-orbit');
    if (orbit) { orbit.innerHTML = `${icon(atlas?.isOrbiting ? 'stop' : 'play')}${words(atlas?.isOrbiting ? '회전 멈춤' : '한 바퀴 회전', atlas?.isOrbiting ? 'Stop rotation' : 'Rotate once')}`; orbit.setAttribute('aria-pressed', String(!!atlas?.isOrbiting)); }
    const preview = this.panel.querySelector('#route-preview-start');
    if (preview) { preview.innerHTML = `${icon(atlas?.isPreviewingRoute ? 'stop' : 'play')}${words(atlas?.isPreviewingRoute ? '미리보기 멈춤' : '3D 미리보기', atlas?.isPreviewingRoute ? 'Stop preview' : '3D preview')}`; preview.setAttribute('aria-pressed', String(!!atlas?.isPreviewingRoute)); }
    const progress = this.panel.querySelector('#route-preview-progress');
    if (progress) progress.textContent = atlas?.isPreviewingRoute ? `${words('탐색 진행', 'Preview progress')} ${Math.round(atlas.routePreviewProgress * 100)}% · Esc` : '';
  }
  destroy(): void {
    this.stop(); this.measurement.destroy(); this.profile.destroy();
    window.removeEventListener('atlas:locale-change', this.onLocale);
    window.removeEventListener('atlas:route-change', this.onRoute);
    window.removeEventListener('atlas:preview-route', this.onPreview);
    window.removeEventListener('atlas:camera-activity', this.onActivity);
    this.overlays.disconnect();
    this.reduced.removeEventListener('change', this.onMotion);
    this.wideLayout.removeEventListener('change', this.placeLauncher);
    this.launcher.remove(); this.panel.remove();
  }
}
