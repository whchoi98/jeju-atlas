import { savedLimits, snapshot, validateSavedData } from './saved-data.ts';
import type { PlaceSnapshot } from './saved-data.ts';

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
type Lock = <T>(operation: () => T | Promise<T>) => Promise<T>;
type QueryEntry = { query: string; at: number; revision: string };
type PlaceEntry = { place: PlaceSnapshot; at: number; revision: string };
type HistoryData = {
  version: 1; queries: QueryEntry[]; places: PlaceEntry[]; pinnedIds: string[];
  cleared: { queries: string; places: string };
};
type ReadResult = { data: HistoryData; valid: boolean; canonical: boolean };

export interface BrowsingHistoryOptions {
  storage?: StorageAccess | null;
  clock?: () => number;
  events?: EventTarget | null;
  withLock?: Lock;
}

export const browsingHistoryKey = 'jeju-atlas.browsing.v1';
export const browsingHistoryLimits = {
  queries: 12, places: 20, pins: 5, maxAgeMs: 30 * 86_400_000, bytes: savedLimits.bytes,
} as const;
const empty = (): HistoryData => ({
  version: 1, queries: [], places: [], pinnedIds: [], cleared: { queries: '', places: '' },
});
const clone = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const revision = () => crypto.randomUUID();
const storedRevision = (value: unknown): string =>
  typeof value === 'string' && /^[a-f0-9-]{1,36}$/.test(value) ? value : '';
const fold = (value: string) => value.normalize('NFKC').toLowerCase();
const validId = (value: unknown): value is string => typeof value === 'string'
  && Boolean(value.trim()) && value.length <= 240 && !/[<>{}\\\u0000-\u001f\u007f]/.test(value);
const queryText = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 200) return null;
  return value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim() || null;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function historyPlace(value: unknown): PlaceSnapshot | null {
  try {
    const place = snapshot(value as PlaceSnapshot);
    // Map/current-location endpoints are route inputs, not automatic visit history.
    if (place.id.startsWith('point:') || ['user_point', 'unknown'].includes(place.source)) return null;
    return validateSavedData({ version: 1, favorites: [place], stops: [] }).favorites[0];
  } catch { return null; }
}

function trim(data: HistoryData, now: number): HistoryData {
  const recent = (at: number) => Number.isSafeInteger(at) && at >= 0 && at <= now
    && at > now - browsingHistoryLimits.maxAgeMs;
  const unique = <T>(items: T[], key: (item: T) => string) => {
    const found = new Set<string>();
    return items.filter(item => { const id = key(item); if (found.has(id)) return false; found.add(id); return true; });
  };
  const result: HistoryData = {
    version: 1,
    queries: unique(data.queries.filter(item => recent(item.at)).sort((a, b) => b.at - a.at), item => fold(item.query))
      .slice(0, browsingHistoryLimits.queries),
    places: unique(data.places.filter(item => recent(item.at)).sort((a, b) => b.at - a.at), item => item.place.id)
      .slice(0, browsingHistoryLimits.places),
    // Pins reference durable favorites, so they do not expire with recent visits.
    pinnedIds: [...new Set(data.pinnedIds.filter(validId))].slice(0, browsingHistoryLimits.pins),
    cleared: { ...data.cleared },
  };
  while (new TextEncoder().encode(JSON.stringify(result)).length > browsingHistoryLimits.bytes && result.places.length) result.places.pop();
  return result;
}

function decode(raw: string | null, now: number): HistoryData {
  if (raw === null) return empty();
  if (new TextEncoder().encode(raw).length > browsingHistoryLimits.bytes) throw new Error('History exceeds its byte bound');
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !Array.isArray(value.queries)
    || !Array.isArray(value.places) || !Array.isArray(value.pinnedIds)) throw new Error('Invalid browsing history');
  const queries: QueryEntry[] = [];
  const places: PlaceEntry[] = [];
  for (const item of value.queries.slice(0, 100)) {
    if (!record(item) || typeof item.at !== 'number') continue;
    const query = queryText(item.query);
    if (query) queries.push({ query, at: item.at, revision: storedRevision(item.revision) });
  }
  for (const item of value.places.slice(0, 100)) {
    if (!record(item) || typeof item.at !== 'number') continue;
    const place = historyPlace(item.place);
    if (place) places.push({ place, at: item.at, revision: storedRevision(item.revision) });
  }
  const cleared = record(value.cleared) ? value.cleared : {};
  return trim({
    version: 1, queries, places, pinnedIds: value.pinnedIds.filter(validId),
    cleared: { queries: storedRevision(cleared.queries), places: storedRevision(cleared.places) },
  }, now);
}

/**
 * Apply only unsaved local changes to the latest storage. Copying the whole old
 * view would resurrect records another tab removed. A changed shared clear
 * generation invalidates older pending edits. Failed deletions target only the
 * record revisions observed by that tab, preserving later uses even within the
 * same clock tick. Metadata stays bounded and contains no deleted query text.
 */
function reconcile(latest: HistoryData, base: HistoryData, draft: HistoryData): HistoryData {
  const merge = <T>(incoming: T[], before: T[], local: T[], key: (entry: T) => string): T[] => {
    const old = new Map(before.map(entry => [key(entry), entry]));
    const shared = new Map(incoming.map(entry => [key(entry), entry]));
    const current = new Set(local.map(key));
    let next = incoming.filter(entry => !old.has(key(entry)) || current.has(key(entry))
      || !equal(entry, old.get(key(entry))));
    for (const entry of [...local].reverse()) {
      const id = key(entry);
      // A newer shared removal or replacement wins over an older failed edit.
      if (old.has(id) && (!shared.has(id) || !equal(shared.get(id), old.get(id)))) continue;
      if (!old.has(id) && shared.has(id)) continue;
      if (!old.has(id) || !equal(old.get(id), entry)) {
        next = [entry, ...next.filter(other => key(other) !== key(entry))];
      }
    }
    return clone(next);
  };
  const queriesReset = latest.cleared.queries !== base.cleared.queries;
  const placesReset = latest.cleared.places !== base.cleared.places;
  return {
    version: 1,
    queries: queriesReset ? clone(latest.queries) : merge(latest.queries, base.queries, draft.queries, item => fold(item.query)),
    places: placesReset ? clone(latest.places) : merge(latest.places, base.places, draft.places, item => item.place.id),
    pinnedIds: merge(latest.pinnedIds, base.pinnedIds, draft.pinnedIds, id => id),
    cleared: {
      queries: queriesReset ? latest.cleared.queries : draft.cleared.queries,
      places: placesReset ? latest.cleared.places : draft.cleared.places,
    },
  };
}

/** Browser-only history. Mutations resolve to acceptance, not persistence. */
export class BrowsingHistory {
  private current = empty();
  private base = empty();
  private saved = false;
  private storage: StorageAccess | null;
  private events: EventTarget | null;
  private clock: () => number;
  private lock: Lock;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private disposed = false;
  private cleanupPending = false;
  private onStorage = (event: Event) => {
    const update = event as StorageEvent;
    if (update.key !== browsingHistoryKey && update.key !== null) return;
    if (update.storageArea && update.storageArea !== this.storage) return;
    this.refresh(update.key === null || update.newValue === null);
  };
  private onFocus = () => this.sync();

  constructor(options: BrowsingHistoryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; }
    catch { this.storage = null; }
    this.storage ??= null;
    this.events = options.events === undefined ? typeof window === 'undefined' ? null : window : options.events;
    this.lock = options.withLock ?? (async work => {
      if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(browsingHistoryKey, work);
      return work();
    });
    const loaded = this.read();
    this.current = clone(loaded.data);
    this.base = clone(loaded.data);
    this.saved = loaded.valid && loaded.canonical;
    this.events?.addEventListener('storage', this.onStorage);
    this.events?.addEventListener('focus', this.onFocus);
    if (loaded.valid && !loaded.canonical) this.cleanup();
  }

  get queries(): string[] { return trim(this.current, this.clock()).queries.map(item => item.query); }
  get places(): PlaceSnapshot[] { return clone(trim(this.current, this.clock()).places.map(item => item.place)); }
  get pinnedIds(): string[] { return [...this.current.pinnedIds]; }
  get persisted(): boolean { return this.saved; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot break persistence. */ } }
  }
  private read(): ReadResult {
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      const raw = this.storage.getItem(browsingHistoryKey);
      const data = decode(raw, this.clock());
      return { data, valid: true, canonical: raw === null || raw === JSON.stringify(data) };
    } catch { return { data: empty(), valid: false, canonical: false }; }
  }
  private cleanup(): void {
    if (this.cleanupPending || this.disposed) return;
    this.cleanupPending = true;
    void this.mutate(() => true).finally(() => { this.cleanupPending = false; });
  }
  private refresh(reset = false): void {
    if (this.disposed) return;
    const latest = this.read();
    if (latest.valid) {
      if (reset) {
        this.current = clone(latest.data);
      } else this.current = trim(reconcile(latest.data, this.base, this.current), this.clock());
      this.base = clone(latest.data);
      this.saved = latest.canonical && equal(this.current, latest.data);
      if (!latest.canonical) this.cleanup();
    } else this.saved = false;
    this.emit();
  }
  sync(): void { this.refresh(); }

  private mutate(change: (data: HistoryData) => boolean): Promise<boolean> {
    const next = this.queue.then(async () => {
      if (this.disposed) return false;
      let applied = false;
      let accepted = false;
      const write = (allowStorage = true) => {
        applied = true;
        const latest = allowStorage ? this.read() : { data: empty(), valid: false, canonical: false };
        const data = latest.valid
          ? reconcile(latest.data, this.base, this.current) : clone(this.current);
        accepted = change(data);
        this.current = trim(data, this.clock());
        if (latest.valid) this.base = clone(latest.data);
        this.saved = latest.valid && latest.canonical && equal(this.current, latest.data);
        if (!accepted || !latest.valid || !this.storage) return accepted;
        const serialized = JSON.stringify(this.current);
        try {
          this.storage.setItem(browsingHistoryKey, serialized);
          this.saved = this.storage.getItem(browsingHistoryKey) === serialized;
          if (this.saved) {
            this.base = clone(this.current);
          }
        } catch { this.saved = false; }
        return accepted;
      };
      try { return await this.lock(() => write()); }
      catch {
        this.saved = false;
        // A denied browser lock still leaves the explicit action usable here.
        return applied ? accepted : write(false);
      }
    }).finally(() => this.emit());
    this.queue = next.catch(() => {});
    return next;
  }

  rememberQuery(value: string): Promise<boolean> {
    const query = queryText(value);
    if (!query) return Promise.resolve(false);
    const at = this.clock();
    return this.mutate(data => {
      data.queries = [{ query, at, revision: revision() }, ...data.queries.filter(item => fold(item.query) !== fold(query))];
      return true;
    });
  }
  rememberPlace(value: unknown): Promise<boolean> {
    const place = historyPlace(value);
    if (!place) return Promise.resolve(false);
    const at = this.clock();
    return this.mutate(data => {
      data.places = [{ place, at, revision: revision() }, ...data.places.filter(item => item.place.id !== place.id)];
      return true;
    });
  }
  removeQuery(value: string): Promise<boolean> {
    const query = queryText(value);
    if (!query) return Promise.resolve(false);
    return this.mutate(data => { data.queries = data.queries.filter(item => fold(item.query) !== fold(query)); return true; });
  }
  removePlace(id: string): Promise<boolean> {
    if (!validId(id)) return Promise.resolve(false);
    return this.mutate(data => { data.places = data.places.filter(item => item.place.id !== id); return true; });
  }
  clearQueries(): Promise<boolean> {
    return this.mutate(data => { data.queries = []; data.cleared.queries = revision(); return true; });
  }
  clearPlaces(): Promise<boolean> {
    return this.mutate(data => { data.places = []; data.cleared.places = revision(); return true; });
  }
  togglePin(id: string, force?: boolean): Promise<boolean> {
    if (!validId(id)) return Promise.resolve(false);
    return this.mutate(data => {
      const pinned = data.pinnedIds.includes(id);
      const next = force ?? !pinned;
      if (next && !pinned && data.pinnedIds.length >= browsingHistoryLimits.pins) return false;
      data.pinnedIds = next ? pinned ? data.pinnedIds : [...data.pinnedIds, id]
        : data.pinnedIds.filter(value => value !== id);
      return true;
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.events?.removeEventListener('storage', this.onStorage);
    this.events?.removeEventListener('focus', this.onFocus);
    this.listeners.clear();
  }
}
