import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LatLng } from '../shared/api-types';
import { isJejuPoint } from './api';
import { getLocale } from './i18n';
import { icon } from './icons';
import { currentJejuLocation, type LocatedPoint } from './map-location';
import './map-actions.css';

type Action = 'origin' | 'destination' | 'nearby' | 'copy';
interface Options {
  searchArea: () => void;
  action: (action: Action, point: LatLng) => void;
  notify: (message: string) => void;
  locate?: () => Promise<LocatedPoint>;
  stopPlayback?: () => void;
}
const words = (ko: string, en: string) => getLocale() === 'en' ? en : ko;

/** Map gestures remain owned by MapLibre. A stationary press opens explicit actions. */
export class MapActions {
  private bar = document.createElement('div');
  private menu = document.createElement('div');
  private dot = document.createElement('div');
  private point: LatLng | null = null;
  private location: LocatedPoint | null = null;
  private dirty = false;
  private detailOpen = false;
  private disposed = false;
  private locating = false;
  private locationGeneration = 0;
  private lastContextRelease = -Infinity;
  private press: { id: number; x: number; y: number; right: boolean; moved: boolean } | null = null;
  private pointers = new Set<number>();
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private consumed: { x: number; y: number; until: number } | null = null;
  private userMoved = false;
  private viewRevision = 0;
  private canvas: HTMLCanvasElement;
  private shell: HTMLElement;
  private cleanups: (() => void)[] = [];

  constructor(private map: MapLibreMap, private options: Options) {
    this.canvas = map.getCanvas();
    this.shell = map.getContainer().closest<HTMLElement>('.map-shell') ?? map.getContainer();
    this.bar.className = 'map-action-bar';
    this.bar.dataset.i18nIgnore = '';
    this.bar.innerHTML = `<button id="map-search-area" type="button" hidden>${icon('search')}<span></span></button><button id="map-current-location" type="button">${icon('compass')}<span></span></button>`;
    this.menu.className = 'map-point-menu';
    this.menu.id = 'map-point-menu';
    this.menu.hidden = true;
    this.menu.dataset.i18nIgnore = '';
    this.menu.setAttribute('role', 'menu');
    this.menu.innerHTML = `<div class="map-point-menu-heading"><strong></strong><span id="map-point-coordinates"></span></div>
      <button type="button" role="menuitem" data-map-point-action="origin">${icon('pin')}<span></span></button>
      <button type="button" role="menuitem" data-map-point-action="destination">${icon('route')}<span></span></button>
      <button type="button" role="menuitem" data-map-point-action="nearby">${icon('compass')}<span></span></button>
      <button type="button" role="menuitem" data-map-point-action="copy">${icon('share')}<span></span></button>`;
    this.dot.className = 'map-current-point';
    this.dot.hidden = true;
    this.dot.setAttribute('role', 'img');
    this.dot.dataset.i18nIgnore = '';
    this.shell.append(this.bar, this.menu);
    map.getContainer().append(this.dot);
    this.bar.querySelector('#map-search-area')!.addEventListener('click', () => {
      this.closeMenu(); options.searchArea();
    });
    this.bar.querySelector('#map-current-location')!.addEventListener('click', () => { void this.locate(); });
    this.menu.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-map-point-action]')?.dataset.mapPointAction as Action;
      if (!this.point || !['origin', 'destination', 'nearby', 'copy'].includes(action)) return;
      const point = { ...this.point };
      this.closeMenu(action === 'copy');
      options.action(action, point);
    });
    this.menu.addEventListener('keydown', event => {
      const buttons = [...this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeMenu(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
      buttons[next]?.focus();
    });
    this.menu.addEventListener('focusout', event => {
      if (!this.menu.contains(event.relatedTarget as Node)) this.closeMenu();
    });
    this.listen(this.canvas, 'pointerdown', this.pointerDown as EventListener, { passive: true });
    this.listen(this.canvas, 'pointermove', this.pointerMove as EventListener, { passive: true });
    this.listen(window, 'pointerup', this.pointerUp as EventListener, { capture: true, passive: true });
    this.listen(window, 'pointercancel', this.pointerCancel, { capture: true, passive: true });
    this.listen(this.canvas, 'contextmenu', this.contextMenu as EventListener);
    this.listen(this.canvas, 'click', this.consumeClick as EventListener, { capture: true });
    this.listen(this.canvas, 'mousedown', this.consumeClick as EventListener, { capture: true });
    this.listen(this.canvas, 'wheel', () => this.userMovement(), { passive: true });
    this.listen(this.canvas, 'keydown', this.keyDown as EventListener);
    this.listen(document, 'pointerdown', event => {
      if (!this.menu.contains(event.target as Node)) this.closeMenu();
    }, { capture: true, passive: true });
    this.listen(window, 'atlas:locale-change', () => this.translate());
    this.listen(window, 'blur', this.pointerCancel);
    map.on('movestart', this.moving);
    map.on('move', this.positionDot);
    map.on('moveend', this.moved);
    map.on('dragstart', this.transformStarted);
    map.on('rotatestart', this.transformStarted);
    map.on('remove', this.destroy);
    this.translate();
  }

  private listen(target: EventTarget, event: string, listener: EventListener, options?: AddEventListenerOptions): void {
    target.addEventListener(event, listener, options);
    this.cleanups.push(() => target.removeEventListener(event, listener, options));
  }
  private measuring(): boolean { return this.shell.classList.contains('is-measuring'); }
  private clearPress(): void { clearTimeout(this.pressTimer); this.pressTimer = undefined; }
  private pointerDown = (event: PointerEvent): void => {
    this.pointers.add(event.pointerId);
    this.clearPress();
    if (this.pointers.size !== 1 || this.measuring()) { this.press = null; return; }
    const right = event.button === 2 || event.pointerType === 'mouse' && event.button === 0 && event.ctrlKey;
    if (!right && event.pointerType !== 'touch') return;
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY, right, moved: false };
    if (event.pointerType === 'touch') this.pressTimer = setTimeout(() => {
      const press = this.press;
      if (!press || press.moved || this.pointers.size !== 1 || this.measuring()) return;
      this.openAt(press.x, press.y);
      this.consumed = { x: press.x, y: press.y, until: performance.now() + 900 };
    }, 600);
  };
  private pointerMove = (event: PointerEvent): void => {
    if (event.buttons || event.pointerType === 'touch' && this.pointers.has(event.pointerId)) this.userMovement();
    const press = this.press;
    if (!press || press.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
      press.moved = true; this.clearPress(); this.consumed = null; this.closeMenu();
    }
  };
  private pointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.clearPress();
    const press = this.press;
    if (press?.id === event.pointerId) {
      this.lastContextRelease = performance.now();
      if (press.right) {
        if (!press.moved && event.target === this.canvas
          && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 3
          && !this.measuring()) this.openAt(event.clientX, event.clientY);
      }
      this.press = null;
    }
  };
  private pointerCancel = (): void => {
    this.clearPress(); this.pointers.clear(); this.press = null; this.consumed = null;
  };
  private contextMenu = (event: MouseEvent): void => {
    if (this.measuring()) return;
    event.preventDefault();
    if (this.press || performance.now() - this.lastContextRelease < 500 || !this.menu.hidden) return;
    if (event.button === 2) return; // Pointer-up decides whether this was a click or rotation.
    this.openAt(event.clientX || undefined, event.clientY || undefined);
  };
  private consumeClick = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.consumed || performance.now() > this.consumed.until
      || Math.hypot(event.clientX - this.consumed.x, event.clientY - this.consumed.y) > 20) return;
    // Touch release synthesizes mousedown before click; suppress its focus
    // change too, otherwise the opened menu closes before the user can act.
    if (event.type === 'click') this.consumed = null;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); this.openAt();
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(event.key)) this.userMovement();
  };
  private userMovement(): void {
    this.userMoved = true;
    this.viewRevision++;
    if (this.locating) {
      this.locationGeneration++; this.locating = false;
      this.bar.querySelector<HTMLButtonElement>('#map-current-location')!.disabled = false;
      this.translate();
    }
  }
  private transformStarted = (event: { originalEvent?: unknown }): void => {
    if (!event.originalEvent && !this.pointers.size && !this.userMoved) return;
    this.userMovement();
    if (this.press) this.press.moved = true;
    this.clearPress();
  };
  private moving = (): void => { this.closeMenu(); this.clearPress(); };
  private moved = (event: { originalEvent?: unknown }): void => {
    if (this.userMoved || event.originalEvent) {
      this.dirty = true;
      this.translate();
    }
    this.userMoved = false;
    this.positionDot();
  };
  private openAt(clientX?: number, clientY?: number): void {
    if (this.disposed || this.measuring()) return;
    this.options.stopPlayback?.();
    const bounds = this.canvas.getBoundingClientRect();
    const x = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const y = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    const location = this.map.unproject([x, y]);
    if (!isJejuPoint(location.lng, location.lat)) {
      this.options.notify(words('제주 지도 안에서 위치를 선택해 주세요.', 'Choose a point within Jeju.'));
      return;
    }
    this.point = { lng: location.lng, lat: location.lat };
    this.menu.querySelector('#map-point-coordinates')!.textContent = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
    this.menu.hidden = false;
    this.menu.style.left = `${Math.max(8, Math.min(this.shell.clientWidth - this.menu.offsetWidth - 8, x + 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(this.shell.clientHeight - this.menu.offsetHeight - 8, y + 8))}px`;
    this.menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]').forEach((button, index) => { button.tabIndex = index === 0 ? 0 : -1; });
    this.menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }
  closeMenu(restoreFocus = false): void {
    const focused = this.menu.contains(document.activeElement);
    this.menu.hidden = true; this.point = null;
    if (restoreFocus && focused) this.canvas.focus({ preventScroll: true });
  }
  setDetailOpen(open: boolean): void { this.detailOpen = open; this.bar.hidden = open; if (open) this.closeMenu(); }
  searchStamp(): string {
    const bounds = this.map.getBounds();
    return [this.viewRevision, bounds.getWest().toFixed(5), bounds.getSouth().toFixed(5),
      bounds.getEast().toFixed(5), bounds.getNorth().toFixed(5)].join(':');
  }
  markSearched(stamp?: string): void {
    if (stamp !== this.searchStamp()) return;
    this.dirty = false; this.translate();
  }
  private async locate(): Promise<void> {
    if (this.locating) return;
    this.options.stopPlayback?.();
    const generation = ++this.locationGeneration;
    this.locating = true;
    this.location = null; this.dot.hidden = true;
    this.bar.querySelector<HTMLButtonElement>('#map-current-location')!.disabled = true;
    this.translate();
    try {
      const point = await (this.options.locate ?? currentJejuLocation)();
      if (this.disposed || generation !== this.locationGeneration) return;
      this.location = point;
      this.viewRevision++;
      this.dirty = true;
      this.map.flyTo({ center: [point.lng, point.lat], zoom: Math.max(14, this.map.getZoom()),
        duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900 });
      this.positionDot();
      this.options.notify(words('확인된 내 위치로 지도를 이동했어요.', 'The map now shows your reported location.'));
    } catch (error) {
      if (this.disposed || generation !== this.locationGeneration) return;
      const code = (error as Error)?.message;
      this.options.notify(code === 'location_denied'
        ? words('위치 권한이 꺼져 있어요. 브라우저 설정에서 허용하거나 지도에서 위치를 선택해 주세요.', 'Location access is off. Allow it in browser settings or choose a point on the map.')
        : code === 'location_outside_jeju'
          ? words('현재 위치가 제주 범위 밖이에요. 지도에서 제주 안의 출발지를 선택해 주세요.', 'Your location is outside Jeju. Choose a starting point within Jeju.')
          : words('현재 위치를 확인하지 못했어요. 지도에서 직접 선택할 수 있어요.', 'Your location could not be found. You can choose a point on the map.'));
    } finally {
      if (!this.disposed && generation === this.locationGeneration) {
        this.locating = false;
        this.bar.querySelector<HTMLButtonElement>('#map-current-location')!.disabled = false;
        this.translate();
      }
    }
  }
  private positionDot = (): void => {
    if (!this.location) return;
    const point = this.map.project([this.location.lng, this.location.lat]);
    this.dot.hidden = point.x < 0 || point.y < 0 || point.x > this.canvas.clientWidth || point.y > this.canvas.clientHeight;
    this.dot.style.left = `${point.x}px`; this.dot.style.top = `${point.y}px`;
  };
  private translate(): void {
    const area = this.bar.querySelector<HTMLButtonElement>('#map-search-area')!;
    area.hidden = !this.dirty;
    area.querySelector('span')!.textContent = words('이 지역에서 검색', 'Search this area');
    const locate = this.bar.querySelector<HTMLButtonElement>('#map-current-location')!;
    locate.querySelector('span')!.textContent = this.locating ? words('위치 확인 중', 'Locating…') : words('내 위치', 'My location');
    this.bar.hidden = this.detailOpen;
    this.menu.setAttribute('aria-label', words('선택한 지도 지점의 동작', 'Actions for the selected map point'));
    this.menu.querySelector('strong')!.textContent = words('선택한 지도 지점', 'Selected map point');
    for (const [action, ko, en] of [
      ['origin', '여기서 출발', 'Start here'], ['destination', '여기로 도착', 'Go here'],
      ['nearby', '이 주변 탐색', 'Explore nearby'], ['copy', '좌표 복사', 'Copy coordinates'],
    ]) this.menu.querySelector(`[data-map-point-action="${action}"] span`)!.textContent = words(ko, en);
    const label = words('확인된 내 위치', 'Reported device location');
    this.dot.setAttribute('aria-label', label);
    this.dot.title = this.location?.accuracy_m == null ? label
      : `${label} · ${words('정확도', 'Accuracy')} ±${Math.round(this.location.accuracy_m)} m`;
  }
  destroy = (): void => {
    if (this.disposed) return;
    this.disposed = true; this.locationGeneration++; this.clearPress();
    for (const remove of this.cleanups) remove();
    this.map.off('movestart', this.moving); this.map.off('move', this.positionDot); this.map.off('moveend', this.moved);
    this.map.off('dragstart', this.transformStarted); this.map.off('rotatestart', this.transformStarted);
    this.map.off('remove', this.destroy);
    this.bar.remove(); this.menu.remove(); this.dot.remove();
  };
}
