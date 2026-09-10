import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_AGE_MS = 14 * 86_400_000;
const MEDIA_ORIGIN = 'https://jeju-atlas.whchoi.net';
const LICENSES = new Set(['KOGL-1', 'KOGL-3', 'CC-BY-SA-2.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0', 'PD']);
const PROVIDER_DOMAINS = {
  tourapi: ['visitkorea.or.kr', 'knto.or.kr', 'data.go.kr'],
  visitjeju: ['visitjeju.net'],
};
const PRIVATE_QUERY_KEYS = new Set(['servicekey', 'apikey', 'key', 'accesstoken', 'token', 'secret', 'clientsecret', 'password', 'auth', 'authtoken', 'authkey', 'authorization', 'authentication', 'credential', 'credentials', 'signature', 'awsaccesskeyid', 'secretaccesskey', 'xamzcredential', 'xamzsignature', 'xamzsecuritytoken']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validationDiagnostics = new WeakMap();
function invalid(code = 'invalid_snapshot', field = 'snapshot', location = {}) {
  const error = new Error('Invalid official details snapshot');
  error.name = 'OfficialDetailsValidationError';
  const diagnostic = Object.freeze({ code, field, ...location });
  validationDiagnostics.set(error, diagnostic);
  Object.defineProperty(error, 'diagnostic', { value: diagnostic, enumerable: true });
  return error;
}

/** Safe for publisher stderr/status: never include payload values, IDs or URLs. */
export function officialDetailsDiagnostic(error) {
  const diagnostic = validationDiagnostics.get(error);
  if (diagnostic) return { ...diagnostic };
  try {
    if (error?.name === 'SyntaxError') return { code: 'invalid_json', field: 'snapshot' };
  } catch { /* Ignore untrusted error accessors. */ }
  return { code: 'details_unavailable', field: 'snapshot' };
}
function atLocation(error, location) {
  const { code, field, ...previous } = validationDiagnostics.get(error) || { code: 'invalid_snapshot', field: 'record' };
  return invalid(code, field, { ...previous, ...location });
}

function identifier(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && /^[A-Za-z0-9][A-Za-z0-9_:./-]*$/.test(value)
    && !['constructor', 'prototype'].includes(value)
    && !value.split('/').some(part => part.startsWith('.'));
}
function text(value, max, nullable = true, field = 'field') {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw invalid('missing_field', field);
  }
  if (typeof value !== 'string') throw invalid('invalid_text', field);
  if (value.length > max) throw invalid('field_too_long', field, { limit: max });
  if (!value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw invalid('invalid_text', field);
  const result = value.trim();
  if (!result && !nullable) throw invalid('missing_field', field);
  return result || null;
}
function timestamp(value, field) {
  const result = text(value, 40, false, field);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(result)) throw invalid('invalid_timestamp', field);
  const date = new Date(`${result.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== result.slice(0, 10)
    || !Number.isFinite(Date.parse(result))) throw invalid('invalid_timestamp', field);
  return result;
}
export function hasCredentialQuery(url) {
  return [...url.searchParams.keys()].some(key => PRIVATE_QUERY_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')));
}
function publicURL(value, mediaOrigin) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  const relative = value.startsWith('/media/');
  if (!relative && !/^https?:\/\//i.test(value)) return null;
  try {
    if (relative) {
      if (!mediaOrigin) return null;
      const decoded = decodeURIComponent(value.split(/[?#]/)[0]);
      if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0')
        || decoded.split('/').some(part => part.startsWith('.'))) return null;
    }
    const url = relative ? new URL(value, mediaOrigin) : new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host.includes('.')
      || isIP(host.replace(/^\[|\]$/g, '')) || /(?:^|\.)(localhost|local|internal|lan|test|invalid)$/.test(host)
      || host.endsWith('.home.arpa') || url.href.length > 2048) return null;
    if (relative && (url.origin !== mediaOrigin || !url.pathname.startsWith('/media/'))) return null;
    if (mediaOrigin && host === new URL(mediaOrigin).hostname) {
      const path = decodeURIComponent(url.pathname);
      if (url.origin !== mediaOrigin || !path.startsWith('/media/') || /[%\\\x00-\x1f]/.test(path)
        || path.split('/').some(part => part.startsWith('.'))) return null;
    }
    if (hasCredentialQuery(url)) return null;
    return url.href;
  } catch { return null; }
}
function sourceURL(value, provider) {
  const url = publicURL(value);
  if (!url) throw invalid('unsafe_url', 'source_url');
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  if (!PROVIDER_DOMAINS[provider].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw invalid('provider_domain_mismatch', 'source_url');
  }
  return url;
}

function photos(value, mediaOrigin) {
  const result = [];
  if (!Array.isArray(value)) throw invalid();
  for (const photo of value.slice(0, 128)) {
    try {
      if (!object(photo) || !LICENSES.has(photo.license)) continue;
      const origin_url = publicURL(photo.origin_url);
      const url = publicURL(photo.url ?? photo.origin_url, mediaOrigin);
      const credit = text(photo.credit, 300, false);
      const source = text(photo.source, 120, false);
      if (!origin_url || !url) continue;
      const normalized = {
        url, thumb_url: photo.license === 'KOGL-3' ? null : publicURL(photo.thumb_url, mediaOrigin),
        origin_url, credit, license: photo.license, source,
      };
      const existing = result.findIndex(item => item.url === url || item.origin_url === origin_url);
      if (existing >= 0) {
        if (photo.license === 'KOGL-3') result[existing] = normalized;
      } else if (result.length < 8) result.push(normalized);
    } catch { /* A bad photo never grants rights or suppresses useful text. */ }
  }
  return result;
}
function officialRecord(value, mediaOrigin) {
  if (!object(value)) throw invalid('invalid_record', 'record');
  if (!Object.hasOwn(PROVIDER_DOMAINS, value.provider)) throw invalid('unknown_provider', 'provider');
  if (!['ko', 'en'].includes(value.locale)) throw invalid('invalid_locale', 'locale');
  if (!identifier(value.provider_id, 160)) throw invalid('invalid_identifier', 'provider_id');
  if (!Array.isArray(value.facts)) throw invalid('expected_array', 'facts');
  if (!Array.isArray(value.photos)) throw invalid('expected_array', 'photos');
  if (!object(value.match)) throw invalid('invalid_record', 'match');
  if (value.match.distance_m !== null && (!Number.isFinite(value.match.distance_m) || value.match.distance_m < 0)) {
    throw invalid('invalid_number', 'match.distance_m');
  }
  const source_url = sourceURL(value.source_url, value.provider);
  const fetched_at = timestamp(value.fetched_at, 'fetched_at');
  const latitude = value.latitude ?? null;
  const longitude = value.longitude ?? null;
  if ((latitude !== null || longitude !== null)
    && !(typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= 33.1 && latitude <= 33.6
      && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= 126.15 && longitude <= 126.98)) {
    throw invalid('invalid_coordinates', 'coordinates');
  }
  const facts = value.facts.slice(0, 40).map((fact, index) => {
    const field = `facts[${index}]`;
    if (!object(fact)) throw invalid('invalid_record', field);
    if (!identifier(fact.key, 80)) throw invalid('invalid_identifier', `${field}.key`);
    return {
      key: fact.key, label_ko: text(fact.label_ko, 120, false, `${field}.label_ko`),
      label_en: text(fact.label_en, 120, false, `${field}.label_en`),
      value: text(fact.value, 1000, false, `${field}.value`),
    };
  });
  return {
    provider: value.provider, provider_id: value.provider_id, locale: value.locale,
    source_url, fetched_at,
    title: text(value.title, 256, true, 'title'), address: text(value.address, 1000, true, 'address'),
    phone: text(value.phone, 120, true, 'phone'),
    website: publicURL(value.website), latitude, longitude, overview: text(value.overview, 8000, true, 'overview'),
    facts, photos: photos(value.photos, mediaOrigin),
    match: { method: text(value.match.method, 80, false, 'match.method'), distance_m: value.match.distance_m },
  };
}

/** A matched provider row is source-reported data, never a reviewed catalog base. */
export function normalizeOfficialDetails(value, { mediaOrigin = MEDIA_ORIGIN, now = Date.now() } = {}) {
  if (!Array.isArray(value)) throw invalid('expected_array', 'records');
  const result = [];
  const seen = new Set();
  for (const [index, item] of value.slice(0, 16).entries()) {
    let row;
    try { row = officialRecord(item, mediaOrigin); }
    catch (error) { throw atLocation(error, { record_index: index }); }
    const age = now - Date.parse(row.fetched_at);
    // Retrieval age is not a claim that the provider's content was reviewed.
    row.age_days = Number.isFinite(age) && age >= 0 ? Math.floor(age / 86400_000) : null;
    row.stale = row.age_days === null || age > MAX_RECORD_AGE_MS;
    const key = `${row.provider}:${row.provider_id}:${row.locale}`;
    if (!seen.has(key)) { seen.add(key); result.push(row); }
    if (result.length === 4) break;
  }
  return result;
}
/** The loader and publisher use this identical whole-snapshot normalization. */
export function normalizeOfficialSnapshot(value, { mediaOrigin = MEDIA_ORIGIN, now = Date.now() } = {}) {
  if (!object(value)) throw invalid('invalid_snapshot', 'snapshot');
  if (value.version !== 1) throw invalid('unsupported_version', 'version');
  if (!object(value.records)) throw invalid('invalid_record', 'records');
  const generated_at = timestamp(value.generated_at, 'generated_at');
  const entries = Object.entries(value.records);
  if (entries.length > 20_000) throw invalid('too_many_places', 'records', { limit: 20_000 });
  const records = Object.create(null);
  for (const [index, [id, rows]] of entries.entries()) {
    if (!identifier(id)) throw invalid('invalid_identifier', 'records', { place_index: index });
    try { records[id] = normalizeOfficialDetails(rows, { mediaOrigin, now }); }
    catch (error) { throw atLocation(error, { place_index: index }); }
  }
  const result = { version: 1, generated_at, records };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw invalid('snapshot_too_large', 'snapshot', { limit_bytes: MAX_BYTES });
  return result;
}
function closeBody(body) {
  try { body?.destroy?.(); } catch { /* Already closed. */ }
}
function abortable(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readJSON(body, { expected, signal } = {}) {
  const chunks = [];
  let size = 0;
  const abort = () => closeBody(body);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of body) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_BYTES) throw invalid();
      chunks.push(chunk);
    }
    if (!size || (expected !== undefined && size !== expected)) throw invalid();
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw invalid('invalid_json', 'snapshot');
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    closeBody(body);
  }
}

/** Optional, read-only S3 snapshot with an atomic private /tmp last-good cache. */
export class OfficialDetailsLoader {
  constructor({
    bucket, key = 'place-details/latest.json', localPath, cacheDir = '/tmp/atlas-details',
    mediaOrigin = MEDIA_ORIGIN, s3Client, clock = Date.now, refreshMs = 600_000,
    timeoutMs = 5000, region = process.env.AWS_REGION || 'ap-northeast-2',
  } = {}) {
    const origin = publicURL(mediaOrigin);
    if (!origin || new URL(origin).protocol !== 'https:') throw new Error('Invalid details media origin');
    if (!Number.isFinite(refreshMs) || refreshMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw invalid();
    this._bucket = bucket;
    this._key = key;
    this._localPath = localPath ? resolve(localPath) : null;
    this._cacheDir = resolve(cacheDir);
    this._cachePath = join(this._cacheDir, `details-${createHash('sha256').update(JSON.stringify([bucket ?? '', key])).digest('hex').slice(0, 24)}.json`);
    this._mediaOrigin = new URL(origin).origin;
    this._client = s3Client;
    this._ownedClient = false;
    this._clock = clock;
    this._refreshMs = refreshMs;
    this._timeoutMs = timeoutMs;
    this._region = region;
    this._snapshot = null;
    this._etag = null;
    this._initialized = false;
    this._closed = false;
    this._pending = null;
    this._lastCheck = -Infinity;
    this._refreshedAt = null;
    this._stale = true;
    this._lastError = null;
    this._controller = null;
  }
  async _readFile(path, signal) {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_BYTES) throw invalid();
    return normalizeOfficialSnapshot(await readJSON(createReadStream(path), { expected: info.size, signal }), {
      mediaOrigin: this._mediaOrigin, now: this._clock(),
    });
  }
  init() {
    if (this._closed) return Promise.resolve(this.status());
    if (this._pending) return this._pending;
    if (this._initialized) return this.refreshIfNeeded();
    this._pending = (async () => {
      this._initialized = true;
      if (!this._localPath) {
        try { this._snapshot = await this._readFile(this._cachePath); } catch { /* No usable cache yet. */ }
      }
      return this._refresh();
    })().finally(() => { this._pending = null; });
    return this._pending;
  }
  refreshIfNeeded() {
    if (this._closed) return Promise.resolve(this.status());
    if (!this._initialized) return this.init();
    if (this._pending) return this._pending;
    if (this._clock() - this._lastCheck < this._refreshMs) return Promise.resolve(this.status());
    this._pending = this._refresh().finally(() => { this._pending = null; });
    return this._pending;
  }
  async _refresh() {
    if (this._closed) return this.status();
    const controller = new AbortController();
    this._controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this._timeoutMs)]);
    try {
      const work = this._localPath ? this._readFile(this._localPath, signal) : this._download(signal);
      const candidate = await abortable(work, signal);
      signal.throwIfAborted();
      if (this._closed) throw invalid();
      if (candidate) this._snapshot = candidate;
      this._stale = false;
      this._lastError = null;
      this._refreshedAt = new Date(this._clock()).toISOString();
    } catch (error) {
      this._stale = true;
      this._lastError = officialDetailsDiagnostic(error);
    } finally {
      this._lastCheck = this._clock();
      if (this._controller === controller) this._controller = null;
    }
    return this.status();
  }
  async _download(signal) {
    if (!this._bucket || !this._key) throw invalid();
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    signal.throwIfAborted();
    if (!this._client) {
      this._client = new S3Client({ region: this._region, maxAttempts: 1 });
      this._ownedClient = true;
    }
    let body;
    let part;
    try {
      let response;
      try {
        const sending = this._client.send(new GetObjectCommand({
          Bucket: this._bucket, Key: this._key, ...(this._etag ? { IfNoneMatch: this._etag } : {}),
        }), { abortSignal: signal });
        Promise.resolve(sending).then(result => { if (signal.aborted) closeBody(result?.Body); }, () => {}).catch(() => {});
        response = await abortable(sending, signal);
      } catch (error) {
        if ((error?.name === 'NotModified' || error?.$metadata?.httpStatusCode === 304) && this._snapshot && this._etag) return null;
        throw error;
      }
      body = response.Body;
      if (response.$metadata?.httpStatusCode === 304 && this._snapshot && this._etag) return null;
      const expected = response.ContentLength;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_BYTES)) throw invalid();
      if (!body?.[Symbol.asyncIterator]) throw invalid();
      const candidate = normalizeOfficialSnapshot(await readJSON(body, { expected, signal }), {
        mediaOrigin: this._mediaOrigin, now: this._clock(),
      });
      signal.throwIfAborted();
      const json = JSON.stringify(candidate);
      if (Buffer.byteLength(json) > MAX_BYTES) throw invalid();
      await mkdir(this._cacheDir, { recursive: true, mode: 0o700 });
      part = `${this._cachePath}.${randomUUID()}.part`;
      await writeFile(part, json, { flag: 'wx', mode: 0o600, signal });
      signal.throwIfAborted();
      if (this._closed) throw invalid();
      await rename(part, this._cachePath);
      signal.throwIfAborted();
      if (this._closed) throw invalid();
      this._etag = typeof response.ETag === 'string' && response.ETag.length <= 256 && !/[\x00-\x20\x7f]/.test(response.ETag)
        ? response.ETag : null;
      return candidate;
    } finally {
      closeBody(body);
      if (part) await rm(part, { force: true }).catch(() => {});
    }
  }
  get(id) {
    if (this._closed || !identifier(id) || !this._snapshot) return [];
    return normalizeOfficialDetails(this._snapshot.records[id] ?? [], { mediaOrigin: this._mediaOrigin, now: this._clock() });
  }
  status() {
    const data = this._closed ? null : this._snapshot;
    const rows = data ? Object.values(data.records) : [];
    const recordCount = rows.reduce((count, items) => count + items.length, 0);
    const now = this._clock();
    // A 304 or a metadata-only publication renews transport metadata, not the
    // actual provider observations. Recompute age even between refreshes.
    const overdue = rows.some(items => items.some(row => {
      const fetchedAt = Date.parse(row.fetched_at);
      const age = now - fetchedAt;
      return !Number.isFinite(now) || !Number.isFinite(fetchedAt) || age < 0 || age > MAX_RECORD_AGE_MS;
    }));
    return {
      status: data ? 'ready' : 'unavailable',
      stale: this._stale || !data || recordCount === 0 || overdue,
      generated_at: data?.generated_at ?? null, refreshed_at: this._refreshedAt,
      place_count: rows.filter(items => items.length).length,
      record_count: recordCount,
      last_error: this._lastError ? { ...this._lastError } : null,
    };
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this._controller?.abort();
    if (this._ownedClient) this._client?.destroy();
  }
}
