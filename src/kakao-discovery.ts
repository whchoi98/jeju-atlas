import type { CatalogPlace, FieldEvidenceMap, OfficialPlaceDetail, PlaceDetail, PlacePhoto, SourceRecord } from '../shared/api-types.ts';
import type { KakaoDiscoveryCategory, KakaoDiscoveryConfig, KakaoDiscoveryPlace, KakaoDiscoveryRequest, KakaoDiscoveryResult, KakaoReopenRequest } from '../shared/kakao-discovery-types.ts';
import { catalogBounds, getConfig, isJejuPoint, withAbort } from './api.ts';
import { validateKakaoLookup } from './kakao-details.ts';

export type DiscoverySource = 'auto' | 'catalog' | 'kakao';
export const discoveryCategories: readonly KakaoDiscoveryCategory[] = ['맛집', '카페', '숙소', '주차장'];
const categoryCodes = { 맛집: 'FD6', 카페: 'CE7', 숙소: 'AD5', 주차장: 'PK6' };
export const isDiscoveryCategory = (value: string): value is KakaoDiscoveryCategory => (discoveryCategories as readonly string[]).includes(value);
export const isKakaoId = (value: string): boolean => /^kakao:[1-9]\d{0,29}$/.test(value);
export const discoverySource = (source: DiscoverySource, query: string, category: string, enabled: boolean): 'catalog' | 'kakao' =>
  enabled && source !== 'catalog' && (source === 'kakao' || isDiscoveryCategory(category) || (!category && Boolean(query.trim()))) ? 'kakao' : 'catalog';

type ClientOptions = { signal?: AbortSignal; fetchImpl?: typeof fetch; loadConfig?: (refresh?: boolean) => Promise<unknown> };
export class KakaoDiscoveryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = 'KakaoDiscoveryError';
    this.code = code;
    this.status = status;
  }
}
const invalid = () => new KakaoDiscoveryError('invalid_response');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function record(value: unknown): Record<string, unknown> { if (!object(value)) throw invalid(); return value; }
function text(value: unknown, max: number, required = false, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())
    || /\p{Surrogate}/u.test(value) || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw invalid();
  return value;
}
const nullableText = (value: unknown, max: number, multiline = false) => value === null ? null : text(value, max, false, multiline);
function number(value: unknown, max = 10_000_000, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) throw invalid();
  return value;
}
function date(value: unknown, time = false): string {
  const input = text(value, 40, true);
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(input)
    || (time && input.length === 10) || !Number.isFinite(Date.parse(input))) throw invalid();
  const day = new Date(`${input.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== input.slice(0, 10)) throw invalid();
  return input;
}
const nullableDate = (value: unknown) => value === null ? null : date(value);
function url(value: unknown): string {
  const raw = text(value, 4000, true);
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || [...parsed.searchParams.keys()].some(key => /^(?:service[_-]?key|api[_-]?key|access[_-]?token|csrf[_-]?token|selection[_-]?token|authorization|token)$/i.test(key))) throw invalid();
    return raw;
  } catch { throw invalid(); }
}
const nullableURL = (value: unknown) => value === null ? null : url(value);
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw invalid(); return value; }
function evidence(value: unknown): FieldEvidenceMap | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value));
  if (entries.length > 128) throw invalid();
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/.test(key) || ['constructor', 'prototype'].includes(key)) throw invalid();
    const item = record(raw), state = item.state;
    if (state !== 'unknown' && state !== 'unverified' && state !== 'source_reported' && state !== 'parsed' && state !== 'reviewed') throw invalid();
    return [key, { state, source: nullableText(item.source, 140), observed_at: nullableDate(item.observed_at), evidence_url: nullableURL(item.evidence_url) }];
  }));
}
function basePlace(value: unknown, withEvidence = true): CatalogPlace {
  const item = record(value);
  const id = text(item.id, 36, true);
  if (!isKakaoId(id) || item.source !== 'Kakao Local' || !isJejuPoint(item.lng, item.lat)
    || item.url !== `https://place.map.kakao.com/${id.slice(6)}`) throw invalid();
  const base: CatalogPlace = {
    id, name: text(item.name, 500, true), name_en: nullableText(item.name_en, 500),
    category: text(item.category, 500, true), lat: item.lat as number, lng: item.lng as number,
    address: nullableText(item.address, 1000), summary: text(item.summary, 20_000, false, true),
    tags: array(item.tags, 40).map(value => text(value, 120)),
    source: 'Kakao Local', source_label: text(item.source_label, 200, true),
    base_note: nullableText(item.base_note, 4000, true), updated_at: nullableDate(item.updated_at),
    region: nullableText(item.region, 200), avg_stay_min: item.avg_stay_min === null ? null : number(item.avg_stay_min, 1440),
    url: item.url as string, phone: nullableText(item.phone, 200), hours: nullableText(item.hours, 8000, true),
    distance_m: item.distance_m === null ? null : number(item.distance_m, 200_000),
  };
  if (withEvidence && item.field_evidence !== undefined) {
    try { base.field_evidence = evidence(item.field_evidence); }
    catch { /* Optional proof cannot suppress a valid native identity/contact. */ }
  }
  return base;
}
const token = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,16000}$/.test(value)) throw invalid();
  return value;
};
function discoveryPlace(value: unknown): KakaoDiscoveryPlace {
  const item = record(value), base = basePlace(item);
  if (item.provider_id !== base.id.slice(6) || typeof item.category_code !== 'string'
    || !/^(?:[A-Z]{2}\d)?$/.test(item.category_code)) throw invalid();
  return { ...base, provider_id: item.provider_id as string, provider_category: text(item.provider_category, 500, true),
    category_code: item.category_code, queried_at: date(item.queried_at, true), selection_token: token(item.selection_token) };
}

/** Explicit allowlist: never pass selection proofs into map callbacks or storage. */
export function nativeCatalogPlace(item: CatalogPlace): CatalogPlace { return basePlace(item); }
export function selectionIsFresh(item: KakaoDiscoveryPlace): boolean {
  const age = Date.now() - Date.parse(item.queried_at);
  return Number.isFinite(age) && age >= -60_000 && age < 15 * 60_000;
}

/** At most one page plus the open detail; no prior-page or persistent cache. */
export class KakaoSelections {
  private entries = new Map<string, KakaoDiscoveryPlace>();
  private page = new Set<string>();
  private active: string | null = null;
  get(id: string): KakaoDiscoveryPlace | undefined { return this.entries.get(id); }
  replacePage(items: readonly KakaoDiscoveryPlace[]): void {
    if (items.length > 15) throw invalid();
    const active = this.active ? this.entries.get(this.active) : undefined;
    this.page = new Set(items.map(item => item.id));
    this.entries = new Map(items.map(item => [item.id, item]));
    if (active && !this.entries.has(active.id)) this.entries.set(active.id, active);
  }
  activate(id: string | null): void {
    if (this.active && this.active !== id && !this.page.has(this.active)) this.entries.delete(this.active);
    this.active = id;
  }
  remember(detail: PlaceDetail): void {
    const queriedAt = detail.kakao_lookup?.queried_at || detail.updated_at;
    if (!detail.selection_token || !queriedAt || (this.active !== detail.id && !this.page.has(detail.id))) return;
    this.entries.set(detail.id, {
      ...nativeCatalogPlace(detail), provider_id: detail.id.slice(6),
      provider_category: detail.kakao_lookup?.place?.category || detail.category,
      category_code: isDiscoveryCategory(detail.category) ? categoryCodes[detail.category] : this.entries.get(detail.id)?.category_code || '',
      queried_at: queriedAt, selection_token: detail.selection_token,
    });
  }
}

export function discoveryConfig(value: unknown): KakaoDiscoveryConfig | null {
  const config = object(value) && object(value.discovery) ? value.discovery : null;
  if (config?.enabled !== true) return null;
  const categories = array(config.categories, 4);
  if (!categories.length || new Set(categories).size !== categories.length || categories.some(value => typeof value !== 'string' || !isDiscoveryCategory(value))
    || config.page_size !== 15 || config.max_results !== 45) throw invalid();
  if (config.csrf_token !== undefined && (typeof config.csrf_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(config.csrf_token))) throw invalid();
  return { enabled: true, categories: categories as KakaoDiscoveryCategory[], page_size: 15, max_results: 45,
    ...(typeof config.csrf_token === 'string' ? { csrf_token: config.csrf_token } : {}) };
}

function searchBody(value: KakaoDiscoveryRequest): KakaoDiscoveryRequest {
  const item = record(value), center = record(item.center);
  const query = text(item.query, 160).trim(), category = item.category, scope = item.scope;
  if (typeof category !== 'string' || (category !== '' && !isDiscoveryCategory(category)) || (!query && !category)
    || !['all', 'view', 'nearby'].includes(String(scope)) || !isJejuPoint(center.lng, center.lat)) throw invalid();
  const page = number(item.page, 3, true);
  if (!page) throw invalid();
  const body: KakaoDiscoveryRequest = { query, category, scope: scope as KakaoDiscoveryRequest['scope'],
    center: { lng: center.lng as number, lat: center.lat as number }, page };
  if (scope === 'view') {
    const bounds = array(item.bounds, 4);
    if (bounds.length !== 4 || !isJejuPoint(bounds[0], bounds[1]) || !isJejuPoint(bounds[2], bounds[3])
      || Number(bounds[0]) >= Number(bounds[2]) || Number(bounds[1]) >= Number(bounds[3])) throw invalid();
    body.bounds = bounds as [number, number, number, number];
  }
  if (scope === 'nearby') {
    body.radius_m = number(item.radius_m, 20_000, true);
    if (body.radius_m < 100) throw invalid();
  }
  return body;
}
function searchResult(value: unknown, request: KakaoDiscoveryRequest): KakaoDiscoveryResult {
  const data = record(value);
  if (data.available !== true || data.source !== 'Kakao Local' || data.query !== request.query || data.category !== request.category
    || data.scope !== request.scope || data.page !== request.page || data.page_size !== 15
    || typeof data.has_more !== 'boolean' || typeof data.truncated !== 'boolean') throw invalid();
  const items = array(data.items, 15).map(discoveryPlace);
  const total = number(data.total, 10_000_000, true), pageable = number(data.pageable, Math.min(total, 45), true);
  if (new Set(items.map(item => item.id)).size !== items.length || items.length > pageable
    || (data.has_more && (request.page >= 3 || !items.length))) throw invalid();
  return { available: true, source: 'Kakao Local', query: request.query, category: request.category, scope: request.scope,
    items, total, pageable, page: request.page, page_size: 15, has_more: data.has_more, truncated: data.truncated,
    queried_at: date(data.queried_at, true) };
}
function photo(value: unknown): PlacePhoto {
  const item = record(value);
  return { url: url(item.url), thumb_url: nullableURL(item.thumb_url), origin_url: nullableURL(item.origin_url),
    credit: text(item.credit, 1000), license: text(item.license, 300), source: text(item.source, 200, true) };
}
function source(value: unknown): SourceRecord {
  const item = record(value);
  return { source: text(item.source, 200, true), url: nullableURL(item.url), observed_at: nullableDate(item.observed_at),
    license: nullableText(item.license, 300), ...(item.note === undefined ? {} : { note: nullableText(item.note, 4000, true) }) };
}
function official(value: unknown): OfficialPlaceDetail {
  const item = record(value), match = record(item.match);
  if ((item.provider !== 'tourapi' && item.provider !== 'visitjeju') || (item.locale !== 'ko' && item.locale !== 'en')
    || (item.latitude !== null && !isJejuPoint(item.longitude, item.latitude))
    || (item.latitude === null && item.longitude !== null)) throw invalid();
  return {
    provider: item.provider, provider_id: text(item.provider_id, 200, true), locale: item.locale, source_url: url(item.source_url),
    fetched_at: date(item.fetched_at, true), title: text(item.title, 500, true), address: nullableText(item.address, 1000),
    phone: nullableText(item.phone, 200), website: nullableURL(item.website),
    latitude: item.latitude as number | null, longitude: item.longitude as number | null,
    overview: nullableText(item.overview, 40_000, true),
    facts: array(item.facts, 100).map(value => { const fact = record(value); return {
      key: text(fact.key, 80, true), label_ko: text(fact.label_ko, 160), label_en: text(fact.label_en, 160), value: text(fact.value, 8000, false, true),
    }; }),
    photos: array(item.photos, 40).map(photo), match: { method: text(match.method, 100), distance_m: match.distance_m === null ? null : number(match.distance_m, 100_000) },
    ...(item.age_days === undefined ? {} : { age_days: item.age_days === null ? null : number(item.age_days, 40_000) }),
    ...(item.stale === undefined ? {} : { stale: (() => { if (typeof item.stale !== 'boolean') throw invalid(); return item.stale; })() }),
  };
}
function detailResult(value: unknown, id: string): PlaceDetail {
  const data = record(value), base = basePlace(data, false);
  if (base.id !== id) throw invalid();
  const lookup = data.kakao_lookup === undefined ? undefined : validateKakaoLookup(data.kakao_lookup, id);
  if (lookup && (lookup.status !== 'matched' || lookup.place?.id !== id.slice(6))) throw invalid();
  // Identity, exact URL, lookup and session proof remain strict, outside optional enrichment recovery.
  const native: PlaceDetail = {
    ...base, photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null, menu: [],
    business_status: null, tips: null, official_details: [], enriched_at: null,
    sources: [{ source: 'Kakao Local', url: base.url, observed_at: lookup?.queried_at ?? base.updated_at, license: null }],
    ...(lookup ? { kakao_lookup: lookup } : {}),
    ...(data.selection_token === undefined ? {} : { selection_token: token(data.selection_token) }),
  };
  try {
    const fields = evidence(data.field_evidence);
    const keptFields = fields && Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'official_details' && !key.startsWith('official_details.')));
    const records: OfficialPlaceDetail[] = [];
    for (const [index, value] of (data.official_details === undefined ? [] : array(data.official_details, 8)).entries()) {
      const item = record(value);
      if (item.title === null || (typeof item.title === 'string' && !item.title.trim())) continue;
      const parsed = official(item);
      const proof = fields?.[`official_details.${index}`];
      if (keptFields && proof) keptFields[`official_details.${records.length}`] = proof;
      records.push(parsed);
    }
    const facilities = Object.entries(record(data.facilities));
    if (facilities.length > 100 || facilities.some(([key]) => !/^[a-z][a-z0-9_]{0,79}$/.test(key) || ['constructor', 'prototype'].includes(key))) throw invalid();
    let linked: PlaceDetail['linked_catalog'];
    if (data.linked_catalog !== undefined) {
      const item = record(data.linked_catalog);
      linked = { id: text(item.id, 200, true), name: text(item.name, 500, true), source: text(item.source, 200, true), distance_m: number(item.distance_m, 200) };
    }
    const time = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
    return {
      ...native, photos: array(data.photos, 40).map(photo),
      hours_week: array(data.hours_week, 100).map(value => {
        const item = record(value), open = text(item.open, 8), close = text(item.close, 8);
        if (!time.test(open) || !time.test(close)) throw invalid();
        return { day: number(item.day, 6, true), open, close };
      }),
      hours_source: nullableText(data.hours_source, 200), facilities: Object.fromEntries(facilities.map(([key, value]) => [key, text(value, 200)])),
      overview: nullableText(data.overview, 40_000, true),
      menu: array(data.menu, 100).map(value => { const item = record(value); return {
        name: text(item.name, 500, true), price_krw: item.price_krw === null ? null : number(item.price_krw, 100_000_000), source: nullableText(item.source, 200),
      }; }),
      business_status: nullableText(data.business_status, 100), sources: array(data.sources, 100).map(source),
      enriched_at: nullableDate(data.enriched_at), official_details: records,
      ...(keptFields ? { field_evidence: keptFields } : {}),
      ...(data.registration_note === undefined ? {} : { registration_note: nullableText(data.registration_note, 4000, true) }),
      ...(linked ? { linked_catalog: linked } : {}),
    };
  } catch {
    // Drop the whole optional block and its proof together; never attribute public fields to Kakao.
    return native;
  }
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  const max = 524_288;
  if (Number(response.headers.get('content-length')) > max || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, body = '';
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) throw invalid();
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function post(path: string, body: object, { signal, fetchImpl = fetch, loadConfig = getConfig }: ClientOptions): Promise<unknown> {
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).length > 16_384) throw new KakaoDiscoveryError('invalid_request', 400);
  const controller = new AbortController(), active = controller.signal;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Discovery timeout', 'TimeoutError')), 20_000);
  try {
    active.throwIfAborted();
    let config = discoveryConfig(await withAbort(loadConfig(false), active));
    for (let attempt = 0; attempt < 2; attempt++) {
      active.throwIfAborted();
      if (!config?.enabled || !config.csrf_token) throw new KakaoDiscoveryError('discovery_unavailable', 503);
      const response = await withAbort(fetchImpl(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Atlas-CSRF': config.csrf_token },
        body: json, signal: active }), active);
      active.throwIfAborted();
      if (attempt === 0 && (response.status === 401 || response.status === 403)) {
        void response.body?.cancel().catch(() => {});
        config = discoveryConfig(await withAbort(loadConfig(true), active));
        continue;
      }
      if (!response.ok) {
        const error = await boundedJSON(response, active).catch(() => null);
        active.throwIfAborted();
        const raw = object(error) && object(error.error) ? error.error.code : object(error) ? error.code : null;
        throw new KakaoDiscoveryError(typeof raw === 'string' && /^[a-z_]{1,80}$/.test(raw) ? raw : 'discovery_unavailable', response.status);
      }
      const value = await boundedJSON(response, active);
      active.throwIfAborted();
      return value;
    }
    throw invalid();
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export async function searchKakao(value: KakaoDiscoveryRequest, options: ClientOptions = {}): Promise<KakaoDiscoveryResult> {
  const body = searchBody(value);
  const data = await post('/api/kakao/search', body, options);
  options.signal?.throwIfAborted();
  return searchResult(data, body);
}
export async function detailKakao(id: string, selection: string, options: ClientOptions = {}): Promise<PlaceDetail> {
  if (!isKakaoId(id)) throw invalid();
  const data = await post('/api/kakao/detail', { token: token(selection) }, options);
  options.signal?.throwIfAborted();
  return detailResult(data, id);
}
export async function reopenKakao(value: KakaoReopenRequest, options: ClientOptions = {}): Promise<PlaceDetail> {
  const item = record(value);
  if (typeof item.id !== 'string' || !isKakaoId(item.id) || !isJejuPoint(item.lng, item.lat)) throw invalid();
  const body: KakaoReopenRequest = { id: item.id, name: text(item.name, 500, true), category: text(item.category, 500, true),
    lng: item.lng as number, lat: item.lat as number };
  const data = await post('/api/kakao/reopen', body, options);
  options.signal?.throwIfAborted();
  return detailResult(data, body.id);
}

export function discoveryBounds(bounds: [number, number, number, number]): [number, number, number, number] | null {
  const clipped: [number, number, number, number] = [Math.max(catalogBounds.west, bounds[0]), Math.max(catalogBounds.south, bounds[1]),
    Math.min(catalogBounds.east, bounds[2]), Math.min(catalogBounds.north, bounds[3])];
  return clipped.every(Number.isFinite) && clipped[0] < clipped[2] && clipped[1] < clipped[3] ? clipped : null;
}
