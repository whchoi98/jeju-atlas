import type { CatalogPlace, FieldEvidenceMap, PlaceDetail, SourceRecord } from '../shared/api-types';
import { isJejuPoint, sourceName } from './api.ts';
import { cleanFieldEvidence } from './field-evidence.ts';

export interface PlaceSnapshot {
  id: string;
  name: string;
  name_en?: string | null;
  field_evidence?: FieldEvidenceMap;
  registration_note?: string | null;
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
export type SavedData = { version: 1; favorites: PlaceSnapshot[]; stops: TripStop[] };
export type SaveFailure = 'quota' | 'unavailable' | 'invalid' | 'conflict';
export type SaveResult = { ok: true } | { ok: false; reason: SaveFailure };
export type ImportPreview = { data: SavedData; exportedAt: string | null };
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Lock = <T>(operation: () => T | Promise<T>) => Promise<T>;
type Stored = SavedData & { _revision?: string; _ancestors?: string[] };

export const savedKey = 'jeju-atlas.saved.v1';
export const backupKey = `${savedKey}.backup`;
export const savedLimits = { stops: 12, favorites: 100, bytes: 700000 };
const empty = (): SavedData => ({ version: 1, favorites: [], stops: [] });
const clone = <T>(data: T): T => structuredClone(data);
const size = (text: string) => new TextEncoder().encode(text).length;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('자료 형식이 올바르지 않습니다.');
  return value as Record<string, unknown>;
};
function text(value: unknown, limit: number, strict = false): string {
  if (value == null) return '';
  if (typeof value !== 'string' || (strict && (value.length > limit || /[\u0000-\u001f]/.test(value)))) {
    throw new Error('문자열의 길이 또는 형식이 올바르지 않습니다.');
  }
  return value.replace(/[\u0000-\u001f]/g, '').slice(0, limit);
}
function sourceURL(value: unknown, strict: boolean): string | null {
  if (value == null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 3000) throw new Error();
    const url = new URL(value, typeof location === 'undefined' ? undefined : location.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    if (strict) throw new Error('출처 주소는 인증 정보가 없는 http 또는 https 주소여야 합니다.');
    return null;
  }
}
function cleanSnapshot(value: unknown, strict: boolean): PlaceSnapshot {
  const item = record(value);
  if (!isJejuPoint(item.lng, item.lat)) throw new Error('제주 탐색 범위를 벗어난 좌표입니다.');
  const id = text(item.id, 240, strict);
  const name = text(item.name, 140, strict);
  if (!id || !name.trim() || /[<>{}\\]/.test(id)) throw new Error('장소 이름 또는 식별자가 올바르지 않습니다.');
  if (item.geometry != null) {
    const geometry = record(item.geometry);
    if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2
      || geometry.coordinates[0] !== item.lng || geometry.coordinates[1] !== item.lat) throw new Error('장소와 저장된 좌표가 일치하지 않습니다.');
  }
  if (item.sources != null && (!Array.isArray(item.sources) || (strict && item.sources.length > 16))) throw new Error('출처 목록이 올바르지 않습니다.');
  const sources = ((item.sources ?? []) as unknown[]).slice(0, 16).map((value): SourceRecord => {
    const source = record(value);
    const name = text(source.source, 100, strict);
    if (!name) throw new Error('출처 이름이 없습니다.');
    return {
      source: name, url: sourceURL(source.url, strict),
      observed_at: text(source.observed_at, 50, strict) || null,
      license: text(source.license, 150, strict) || null,
      note: text(source.note, 400, strict) || null,
    };
  });
  const source = text(item.source, 120, strict) || 'unknown';
  return {
    id, name, ...(item.name_en ? { name_en: text(item.name_en, 140, strict) } : {}),
    ...(item.field_evidence ? { field_evidence: cleanFieldEvidence(item.field_evidence) } : {}),
    ...(item.registration_note ? { registration_note: text(item.registration_note, 900, strict) } : {}),
    lat: item.lat as number, lng: item.lng as number,
    category: text(item.category, 80, strict) || 'other', source,
    source_label: text(item.source_label, 160, strict) || sourceName(source),
    base_note: text(item.base_note, 700, strict) || null,
    address: text(item.address, 400, strict) || null,
    summary: text(item.summary, 1200, strict),
    updated_at: text(item.updated_at, 50, strict) || null,
    geometry: { type: 'Point', coordinates: [item.lng as number, item.lat as number] }, sources,
  };
}
export function snapshot(place: CatalogPlace | PlaceDetail | PlaceSnapshot): PlaceSnapshot {
  return cleanSnapshot(place, false);
}
export function validateSavedData(value: unknown): SavedData {
  const raw = record(value);
  if (raw.version !== 1 || (raw.format != null && raw.format !== 'jeju-atlas.saved')) throw new Error('지원하지 않는 여행 자료 버전입니다.');
  const list = (value: unknown, limit: number, stops: boolean): (PlaceSnapshot | TripStop)[] => {
    if (!Array.isArray(value) || value.length > limit) throw new Error(`자료는 최대 ${limit}곳까지 가져올 수 있습니다.`);
    const ids = new Set<string>();
    return value.map((item) => {
      const place = cleanSnapshot(item, true);
      if (ids.has(place.id)) throw new Error('같은 목록에 중복된 장소가 있습니다.');
      ids.add(place.id);
      if (!stops) return place;
      const stay = record(item).stay_min ?? 60;
      if (typeof stay !== 'number' || !Number.isInteger(stay) || stay < 0 || stay > 720) throw new Error('계획 체류 시간은 0~720분의 정수여야 합니다.');
      return { ...place, stay_min: stay };
    });
  };
  return {
    version: 1,
    favorites: list(raw.favorites, savedLimits.favorites, false) as PlaceSnapshot[],
    stops: list(raw.stops, savedLimits.stops, true) as TripStop[],
  };
}
export function previewImport(raw: string): ImportPreview {
  if (typeof raw !== 'string' || size(raw) > savedLimits.bytes) throw new Error('자료 파일은 700 KB 이하여야 합니다.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('JSON 여행 자료를 읽지 못했습니다. 파일을 다시 확인해 주세요.'); }
  const data = validateSavedData(value);
  return { data, exportedAt: text(record(value).exported_at, 50, true) || null };
}
export function mergeSavedData(current: SavedData, incoming: SavedData): SavedData {
  const combine = <T extends PlaceSnapshot>(old: T[], added: T[]): T[] => {
    const ids = new Set(old.map(item => item.id));
    return [...old, ...added.filter(item => !ids.has(item.id))];
  };
  return validateSavedData({
    version: 1, favorites: combine(current.favorites, incoming.favorites), stops: combine(current.stops, incoming.stops),
  });
}
function unpack(raw: string | null): { data: SavedData; stored: Stored } {
  if (raw == null) return { data: empty(), stored: empty() };
  const preview = previewImport(raw);
  return { data: preview.data, stored: JSON.parse(raw) as Stored };
}
function failure(error: unknown): SaveFailure {
  return error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'unavailable';
}

/**
 * The old v1 key remains readable. Writes lock across same-origin tabs, reread
 * the latest snapshot and apply an operation by ID instead of a stale whole form.
 * Reviewed replacements additionally compare the exact revision being reviewed.
 */
export class SavedDataStore {
  private current = empty();
  private raw: string | null = null;
  private storage: StorageAccess | null;
  private lock: Lock;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private dirty = false;
  private ownRevision: string | null = null;
  status: 'saved' | SaveFailure = 'saved';
  pending = 0;

  constructor(options: { storage?: StorageAccess | null; withLock?: Lock } = {}) {
    try { this.storage = options.storage === undefined ? localStorage : options.storage; }
    catch { this.storage = null; }
    this.lock = options.withLock ?? (async (operation) => {
      if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(savedKey, operation);
      return operation();
    });
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.raw = this.storage.getItem(savedKey);
      try { this.current = unpack(this.raw).data; } catch { this.status = 'invalid'; }
    } catch { this.status = 'unavailable'; }
  }

  get data(): SavedData { return clone(this.current); }
  get revision(): string | null { return this.raw; }
  get hasUnsavedChanges(): boolean { return this.dirty || this.pending > 0; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void { this.listeners.forEach(listener => listener()); }
  export(): string {
    return JSON.stringify({ format: 'jeju-atlas.saved', ...this.current, exported_at: new Date().toISOString() });
  }
  latest(): { data: SavedData; revision: string | null } {
    if (!this.storage) return { data: this.data, revision: this.raw };
    const raw = this.storage.getItem(savedKey);
    return { data: unpack(raw).data, revision: raw };
  }
  backup(): SavedData | null {
    try { const raw = this.storage?.getItem(backupKey); return raw ? unpack(raw).data : null; } catch { return null; }
  }
  sync(): void {
    try {
      if (!this.storage) throw new Error();
      const raw = this.storage.getItem(savedKey);
      if (raw === this.raw) return;
      const incoming = unpack(raw);
      const divergent = raw !== null && this.ownRevision && incoming.stored._revision !== this.ownRevision
        && !incoming.stored._ancestors?.includes(this.ownRevision);
      if (this.dirty || divergent) {
        this.dirty = true;
        this.status = 'conflict';
      } else {
        this.current = incoming.data;
        this.raw = raw;
        this.ownRevision = null;
        this.status = 'saved';
      }
    } catch { this.status = 'invalid'; }
    this.emit();
  }
  discardDraft(): void {
    this.dirty = false;
    this.ownRevision = null;
    try {
      if (!this.storage) throw new Error();
      this.raw = this.storage.getItem(savedKey);
      try { this.current = unpack(this.raw).data; this.status = 'saved'; }
      catch { this.current = empty(); this.status = 'invalid'; }
    } catch { this.current = empty(); this.status = 'unavailable'; }
    this.emit();
  }
  private run(operation: () => SaveResult): Promise<SaveResult> {
    this.pending++;
    const next = this.queue.then(() => this.lock(operation)).catch((error): SaveResult => {
      this.status = failure(error);
      return { ok: false, reason: this.status };
    }).finally(() => { this.pending--; this.emit(); });
    this.queue = next;
    return next;
  }
  update(change: (data: SavedData) => void): Promise<SaveResult> {
    return this.run(() => this.write(change));
  }
  replace(data: SavedData, reviewedRevision: string | null): Promise<SaveResult> {
    return this.run(() => this.write(target => Object.assign(target, clone(data)), reviewedRevision, true));
  }
  retry(): Promise<SaveResult> {
    return this.run(() => this.write(() => {}, this.raw));
  }
  private write(change: (data: SavedData) => void, expected?: string | null, replacement = false): SaveResult {
    let latest = this.raw;
    let previous: Stored = empty();
    let next = clone(this.current);
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      latest = this.storage.getItem(savedKey);
      if ((expected !== undefined && latest !== expected) || (this.dirty && latest !== this.raw && !replacement)) {
        this.status = 'conflict';
        return { ok: false, reason: 'conflict' };
      }
      try {
        const parsed = unpack(latest);
        const divergent = latest !== this.raw && latest !== null && this.ownRevision
          && parsed.stored._revision !== this.ownRevision && !parsed.stored._ancestors?.includes(this.ownRevision);
        if (divergent && !replacement) {
          change(next);
          this.current = validateSavedData(next);
          this.dirty = true;
          this.status = 'conflict';
          return { ok: false, reason: 'conflict' };
        }
        previous = parsed.stored;
        if (!this.dirty || replacement) next = parsed.data;
      } catch {
        if (!replacement) {
          change(next);
          this.current = validateSavedData(next);
          this.dirty = true;
          this.status = 'invalid';
          return { ok: false, reason: 'invalid' };
        }
      }
    } catch (error) {
      change(next);
      this.current = validateSavedData(next);
      this.dirty = true;
      this.status = failure(error);
      return { ok: false, reason: this.status };
    }
    try {
      change(next);
      next = validateSavedData(next);
    } catch {
      this.status = 'invalid';
      return { ok: false, reason: 'invalid' };
    }
    this.current = next;
    this.dirty = true;
    try {
      const revision = crypto.randomUUID();
      const stored: Stored = {
        ...next, _revision: revision,
        _ancestors: [previous._revision, ...(previous._ancestors ?? [])].filter((id): id is string => typeof id === 'string').slice(0, 12),
      };
      const serialized = JSON.stringify(stored);
      if (size(serialized) > savedLimits.bytes - 1024) { this.status = 'invalid'; return { ok: false, reason: 'invalid' }; }
      // Keep the last readable saved document; never back up corrupt input over it.
      if (latest !== null) {
        let valid = false;
        try { unpack(latest); valid = true; } catch { /* explicit replacement of corrupt input */ }
        if (valid) this.storage!.setItem(backupKey, latest);
      }
      this.storage!.setItem(savedKey, serialized);
      if (this.storage!.getItem(savedKey) !== serialized) { this.status = 'conflict'; return { ok: false, reason: 'conflict' }; }
      this.raw = serialized;
      this.ownRevision = revision;
      this.dirty = false;
      this.status = 'saved';
      return { ok: true };
    } catch (error) {
      this.status = failure(error);
      return { ok: false, reason: this.status };
    }
  }
  clear(reviewedRevision: string | null): Promise<SaveResult> {
    return this.run(() => {
      try {
        if (!this.storage) throw new Error('Storage unavailable');
        if (this.storage.getItem(savedKey) !== reviewedRevision) { this.status = 'conflict'; return { ok: false, reason: 'conflict' }; }
        this.storage.removeItem(backupKey);
        this.storage.removeItem(savedKey);
        if (this.storage.getItem(savedKey) !== null || this.storage.getItem(backupKey) !== null) throw new Error();
        this.current = empty();
        this.raw = null;
        this.ownRevision = null;
        this.dirty = false;
        this.status = 'saved';
        return { ok: true };
      } catch (error) { this.status = failure(error); return { ok: false, reason: this.status }; }
    });
  }
}

export function savedStatusMessage(status: SavedDataStore['status']): string {
  const messages: Record<SavedDataStore['status'], string> = {
    saved: '이 브라우저에 좌표와 출처를 함께 저장했습니다.',
    quota: '저장 공간이 부족해 현재 편집본을 저장하지 못했어요. 자료 관리에서 파일로 내보내 주세요.',
    unavailable: '브라우저 저장을 사용할 수 없어요. 현재 편집본을 파일로 내보내 보관해 주세요.',
    invalid: '저장 자료의 형식 또는 한도를 확인해 주세요. 기존 저장본은 자동으로 덮어쓰지 않습니다.',
    conflict: '다른 탭의 저장본과 현재 편집본이 달라요. 자료 관리에서 편집본을 내보내고 병합 여부를 확인하세요.',
  };
  return messages[status];
}
