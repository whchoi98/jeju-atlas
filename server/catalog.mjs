import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const JEJU = { south: 33.1, north: 33.6, west: 126.15, east: 126.98 };
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_POINTS = 20000;
const ATTRIBUTION = '장소 데이터 © OpenStreetMap contributors (ODbL) · 큐레이션 데이터 오마이제주';
const BASE_NOTE = '큐레이션 원자료의 기본 좌표·주소·소개는 공식 자료와 독립적으로 대조 검증되지 않았습니다. 보강 정보의 출처는 별도로 표시합니다.';
const REGISTRATION_NOTE = '연결된 인허가 자료의 상태이며, 장소 전체의 운영 여부나 현재 시각의 영업 여부를 확정하지 않습니다.';
// A recognized photo's own license, credit and original URL are sufficient here.
// Generic provenance labels such as "curated" are not commercial photo licenses.
const COMMERCIAL_PHOTO_LICENSES = new Set([
  'KOGL-1', 'KOGL-3', 'CC-BY-SA-2.0', 'CC-BY-SA-3.0',
  'CC-BY-SA-4.0', 'CC-BY-4.0', 'CC0', 'PD',
]);
const NO_DERIVATIVES = new Set(['KOGL-3']);
const BASE_EVIDENCE_FIELDS = [
  'name', 'name_en', 'category', 'lat', 'lng', 'address', 'summary', 'tags',
  'url', 'phone', 'hours', 'region', 'avg_stay_min',
];
const FACILITY_FIELDS = [
  'parking', 'credit_card', 'pet', 'kid_friendly', 'wheelchair',
  'restroom', 'wifi', 'outdoor_seating', 'reservation',
];
const PLACE_COLUMNS = [
  'rid', 'id', 'name', 'name_en', 'category', 'lat', 'lng', 'address', 'summary',
  'tags', 'source', 'url', 'phone', 'hours', 'updated_at', 'region', 'avg_stay_min',
  'name_norm', 'tags_text',
];
const EXTRA_COLUMNS = [
  'id', 'photos', 'hours_week', 'hours_source', 'facilities', 'overview', 'menu',
  'business_status', 'tips', 'sources', 'fetched_at',
];

function fail(message, statusCode = 400, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    statusCode,
    code: statusCode === 400 ? 'CATALOG_BAD_QUERY' : 'CATALOG_UNAVAILABLE',
  });
}

function unavailable(cause) {
  return fail('Catalog is unavailable; no valid snapshot is loaded', 503, cause);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function json(value, fallback) {
  try {
    return typeof value === 'string' ? JSON.parse(value) ?? fallback : fallback;
  } catch {
    return fallback;
  }
}

function array(value) {
  const decoded = json(value, []);
  return Array.isArray(decoded) ? decoded : [];
}

function numeric(value, name, min, max, integer = false) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) {
    throw fail(`${name} must be a number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw fail(`${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
  }
  return number;
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sourceLabel(source) {
  return source === 'sample' ? '큐레이션 원자료' : source;
}

function safeUrl(value, mediaOrigin) {
  const raw = text(value);
  if (!raw || /[\u0000-\u0020\u007f\\]/u.test(raw)) return null;
  const relative = raw.startsWith('/media/');
  if (relative ? !mediaOrigin : !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = relative ? new URL(raw, mediaOrigin) : new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (relative && (url.origin !== mediaOrigin || !url.pathname.startsWith('/media/'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function evidence(state = 'unknown', source = null, evidenceUrl = null) {
  // Neither built_at nor a row's updated_at is an observation of each field.
  return { state, source, observed_at: null, evidence_url: evidenceUrl };
}

function supplied(value) {
  return value !== null && value !== undefined && value !== ''
    && (!Array.isArray(value) || value.length > 0);
}

function baseEvidence(place) {
  let origin = null;
  if (place.source === 'OpenStreetMap') {
    const ref = /^osm:((?:node|way|relation)\/\d+)$/.exec(place.id)?.[1];
    if (ref) origin = `https://www.openstreetmap.org/${ref}`;
    else if (/^https?:\/\/(?:www\.)?openstreetmap\.org\/(?:node|way|relation)\/\d+\/?$/.test(place.url ?? '')) {
      origin = place.url;
    }
  }
  const state = place.source === 'OpenStreetMap' ? 'source_reported' : 'unverified';
  return Object.fromEntries(BASE_EVIDENCE_FIELDS.map((key) => [
    key, supplied(place[key]) ? evidence(state, place.source, origin) : evidence(),
  ]));
}

function detailEvidence(place, extra) {
  const fields = { ...place.field_evidence };
  // place_extra.sources is record-level provenance. Its order and official
  // provider names cannot identify the owner of a flat facility/overview/status.
  for (const key of ['facilities', 'overview', 'business_status', 'menu', 'tips']) fields[key] = evidence();
  for (const key of new Set([...FACILITY_FIELDS, ...Object.keys(extra.facilities)])) {
    if (/^[a-z][a-z0-9_]*$/i.test(key) && !['constructor', 'prototype'].includes(key)) {
      fields[`facilities.${key}`] = evidence();
    }
  }
  fields.hours_week = extra.hours_week.length && extra.hours_source
    ? evidence(extra.hours_source === 'tourapi_usetime' ? 'parsed' : 'source_reported', extra.hours_source)
    : evidence();
  extra.menu.forEach((item, index) => {
    for (const key of ['name', 'price_krw']) {
      fields[`menu.${index}.${key}`] = item.source && supplied(item[key])
        ? evidence('source_reported', item.source) : evidence();
    }
  });
  extra.photos.forEach((photo, index) => {
    fields[`photos.${index}`] = photo.source
      ? evidence('source_reported', photo.source, photo.origin_url) : evidence();
  });
  return fields;
}

/** @returns {import('../shared/api-types.ts').CatalogPlace} */
function place(row, distance = null) {
  const result = {
    id: row.id, name: row.name, name_en: text(row.name_en), category: row.category,
    lat: row.lat, lng: row.lng, address: text(row.address), summary: text(row.summary) ?? '',
    tags: array(row.tags).filter((tag) => typeof tag === 'string'),
    source: row.source, source_label: sourceLabel(row.source),
    base_note: row.source === 'sample' ? BASE_NOTE : null,
    updated_at: text(row.updated_at), region: text(row.region),
    avg_stay_min: nonnegative(row.avg_stay_min), url: safeUrl(row.url),
    phone: text(row.phone), hours: text(row.hours),
    distance_m: distance === null ? null : Math.round(distance),
  };
  return { ...result, field_evidence: baseEvidence(result) };
}

function photos(raw, mediaOrigin) {
  return array(raw).flatMap((photo) => {
    if (!object(photo) || !COMMERCIAL_PHOTO_LICENSES.has(photo.license) || !text(photo.credit)) return [];
    const origin = safeUrl(photo.origin_url);
    if (!origin) return [];
    const url = safeUrl(photo.url ?? photo.origin_url, mediaOrigin);
    if (!url) return [];
    return [{
      // Preserve the stored original/mirror URL. KOGL 3 never acquires a derivative URL.
      url, thumb_url: NO_DERIVATIVES.has(photo.license) ? null : safeUrl(photo.thumb_url, mediaOrigin),
      origin_url: origin, credit: text(photo.credit),
      license: photo.license, source: text(photo.source) ?? '',
    }];
  });
}

function extraFields(row, mediaOrigin) {
  const extra = row ?? {};
  const facilities = json(extra.facilities, {});
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
  return {
    photos: photos(extra.photos, mediaOrigin),
    hours_week: array(extra.hours_week).filter((hour) => object(hour)
      && Number.isInteger(hour.day) && hour.day >= 0 && hour.day <= 6
      && typeof hour.open === 'string' && time.test(hour.open)
      && typeof hour.close === 'string' && time.test(hour.close))
      .map(({ day, open, close }) => ({ day, open, close })),
    hours_source: text(extra.hours_source),
    facilities: object(facilities)
      ? Object.fromEntries(Object.entries(facilities).filter(([, value]) => typeof value === 'string')) : {},
    overview: text(extra.overview),
    menu: array(extra.menu).filter((item) => object(item) && text(item.name))
      .map((item) => ({ name: text(item.name), price_krw: nonnegative(item.price_krw), source: text(item.source) })),
    // This is a registration state, never a calculation of whether the place is open now.
    business_status: text(extra.business_status), tips: json(extra.tips, null),
    registration_note: text(extra.business_status) ? REGISTRATION_NOTE : null,
    sources: array(extra.sources).filter((source) => object(source) && text(source.source)).map((source) => ({
      source: text(source.source), url: safeUrl(source.url),
      observed_at: text(source.observed_at), license: text(source.license),
      ...(Object.hasOwn(source, 'note') ? { note: text(source.note) } : {}),
    })),
    enriched_at: text(extra.fetched_at),
  };
}

function requireTable(db, schema, table, columns) {
  const entry = schema.get(table);
  if (entry?.type !== 'table' || !/^CREATE\s+TABLE\b/i.test(entry.sql ?? '')) {
    throw new Error(`Missing catalog table: ${table}`);
  }
  // Table names are bound as values; never execute SQL obtained from the snapshot.
  const found = new Set(db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0')
    .all(table).map((column) => column.name));
  if (columns.some((column) => !found.has(column))) throw new Error(`Invalid catalog schema: ${table}`);
}

function openSnapshot(path, mediaOrigin) {
  const info = statSync(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) throw new Error('Invalid catalog file size');
  const db = new DatabaseSync(path, {
    readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const checked = db.prepare('PRAGMA quick_check').all();
    if (checked.length !== 1 || checked[0].quick_check !== 'ok') throw new Error('Catalog quick_check failed');
    const schema = new Map(db.prepare(
      "SELECT name, type, sql FROM sqlite_schema WHERE name IN ('meta', 'places', 'place_extra')",
    ).all().map((entry) => [entry.name, entry]));
    requireTable(db, schema, 'meta', ['key', 'value']);
    requireTable(db, schema, 'places', PLACE_COLUMNS);
    const hasExtra = schema.has('place_extra');
    if (hasExtra) requireTable(db, schema, 'place_extra', EXTRA_COLUMNS);
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all()
      .map((row) => [row.key, row.value]));
    // The producer stores schema_version in meta, not PRAGMA user_version.
    if (meta.schema_version !== '2') throw new Error('Unsupported catalog schema version');
    const total = db.prepare('SELECT count(*) AS count FROM places').get().count;
    if (!total || !Number.isSafeInteger(Number(meta.count)) || Number(meta.count) !== total) {
      throw new Error('Catalog count is empty or inconsistent');
    }
    const valid = db.prepare(`
      SELECT count(*) AS count FROM places
      WHERE typeof(id) = 'text' AND length(trim(id)) > 0
        AND typeof(name) = 'text' AND length(trim(name)) > 0
        AND typeof(source) = 'text' AND length(trim(source)) > 0
        AND typeof(category) = 'text' AND length(trim(category)) > 0
        AND typeof(lat) IN ('real', 'integer') AND lat BETWEEN ? AND ?
        AND typeof(lng) IN ('real', 'integer') AND lng BETWEEN ? AND ?
    `).get(JEJU.south, JEJU.north, JEJU.west, JEJU.east).count;
    if (valid !== total) throw new Error('Catalog contains invalid places or coordinates');
    const bySource = Object.fromEntries(db.prepare('SELECT source, count(*) AS count FROM places GROUP BY source')
      .all().map((row) => [row.source, row.count]));
    const categories = db.prepare('SELECT category AS id, count(*) AS count FROM places GROUP BY category ORDER BY category')
      .all().map((row) => ({ ...row }));
    let attribution = text(meta.attribution) ?? ATTRIBUTION;
    if (bySource.OpenStreetMap && !/OpenStreetMap.*ODbL/.test(attribution)) attribution += ` · ${ATTRIBUTION}`;
    const countMetric = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value) : 0;
    const photosCount = hasExtra ? db.prepare(`
      SELECT e.photos FROM place_extra e JOIN places p ON p.id = e.id WHERE e.photos IS NOT NULL
    `).all().filter((row) => photos(row.photos, mediaOrigin).length > 0).length : 0;
    return {
      db, hasExtra, categoryIds: new Set(categories.map((category) => category.id)),
      stats: {
        total, by_source: bySource, categories, built_at: text(meta.built_at), attribution,
        photos_count: photosCount,
        hours_week_count: hasExtra ? countMetric(meta.hours_week_count) : 0,
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function haversine(lat, lng, row) {
  const radians = Math.PI / 180;
  const a = Math.sin((row.lat - lat) * radians / 2) ** 2
    + Math.cos(lat * radians) * Math.cos(row.lat * radians) * Math.sin((row.lng - lng) * radians / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function bounds(bbox) {
  if (bbox === undefined || bbox === null) return [JEJU.west, JEJU.south, JEJU.east, JEJU.north];
  const values = typeof bbox === 'string' ? bbox.split(',') : bbox;
  if (!Array.isArray(values) || values.length !== 4) throw fail('bbox must be west,south,east,north');
  const [west, south, east, north] = values.map((value, index) => numeric(value, 'bbox',
    index % 2 ? -90 : -180, index % 2 ? 90 : 180));
  if (west > east || south > north) throw fail('bbox bounds must be ordered west,south,east,north');
  if (east < JEJU.west || west > JEJU.east || north < JEJU.south || south > JEJU.north) return null;
  return [Math.max(west, JEJU.west), Math.max(south, JEJU.south), Math.min(east, JEJU.east), Math.min(north, JEJU.north)];
}

/**
 * Read-only catalog. Await init()/refreshIfNeeded(); all query methods are synchronous.
 * Bad queries throw statusCode 400, unavailable snapshots throw 503, missing detail is null.
 * A failed refresh resolves with a stale ready status if a valid snapshot is still available.
 */
export class Catalog {
  constructor({
    bucket, key = 'catalog/catalog.sqlite', cacheDir = '/tmp/atlas-catalog', localPath,
    refreshMs = 600000, mediaOrigin = 'https://ohmyjeju.whchoi.net', s3Client, clock = Date.now,
  } = {}) {
    if (!Number.isFinite(refreshMs) || refreshMs < 0) throw new TypeError('refreshMs must be nonnegative');
    const origin = safeUrl(mediaOrigin);
    if (!origin) throw new TypeError('mediaOrigin must be an HTTP(S) origin');
    if (typeof clock !== 'function') throw new TypeError('clock must return epoch milliseconds');
    this._bucket = bucket;
    this._key = key;
    this._cacheDir = resolve(cacheDir);
    this._localPath = localPath ? resolve(localPath) : null;
    this._refreshMs = refreshMs;
    this._mediaOrigin = new URL(origin).origin;
    this._client = s3Client;
    this._ownsClient = false;
    this._clock = clock;
    this._snapshot = null;
    this._etag = null;
    this._initialized = false;
    this._closed = false;
    this._initPromise = null;
    this._refreshPromise = null;
    this._controller = null;
    this._lastCheck = -Infinity;
    this._refreshedAt = null;
    this._stale = true;
    const identity = createHash('sha256').update(JSON.stringify([bucket ?? '', key])).digest('hex').slice(0, 24);
    this._cachePath = join(this._cacheDir, `catalog-${identity}.sqlite`);
  }

  async init() {
    if (this._closed) throw unavailable();
    if (this._initPromise) return this._initPromise;
    if (this._initialized) return this._snapshot ? this.status() : this.refreshIfNeeded();
    this._initPromise = this._initialize().finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  async _initialize() {
    try {
      if (this._localPath) {
        this._replace(openSnapshot(this._localPath, this._mediaOrigin));
        this._success();
        this._initialized = true;
        return this.status();
      }
      if (!text(this._bucket) || !text(this._key)) throw new Error('A catalog bucket or localPath is required');
      await mkdir(this._cacheDir, { recursive: true, mode: 0o700 });
      if (this._closed) throw unavailable();
      try {
        this._replace(openSnapshot(this._cachePath, this._mediaOrigin));
      } catch {
        // A missing or invalid cache may only be replaced by a validated download.
      }
      this._initialized = true;
      return await this.refreshIfNeeded();
    } catch (error) {
      this._stale = true;
      throw unavailable(error);
    }
  }

  async refreshIfNeeded() {
    if (this._closed) throw unavailable();
    if (!this._initialized) return this.init();
    if (this._localPath) return this.status();
    if (this._refreshPromise) return this._refreshPromise;
    if (Number(this._clock()) - this._lastCheck < this._refreshMs) {
      if (!this._snapshot) throw unavailable();
      return this.status();
    }
    this._refreshPromise = this._refresh().finally(() => { this._refreshPromise = null; });
    return this._refreshPromise;
  }

  async _refresh() {
    try {
      await this._download();
      if (this._closed) throw unavailable();
      this._success();
    } catch (error) {
      this._stale = true;
      if (!this._snapshot) throw unavailable(error);
    } finally {
      this._lastCheck = Number(this._clock());
    }
    return this.status();
  }

  async _download() {
    // Local mode never imports the SDK or touches credential providers.
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    if (this._closed) throw unavailable();
    if (!this._client) {
      this._client = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2', maxAttempts: 2 });
      this._ownsClient = true;
    }
    this._controller = new AbortController();
    const signal = AbortSignal.any([this._controller.signal, AbortSignal.timeout(15000)]);
    const part = `${this._cachePath}.${randomUUID()}.part`;
    let body;
    let candidate;
    try {
      let response;
      try {
        response = await this._client.send(new GetObjectCommand({
          Bucket: this._bucket, Key: this._key,
          ...(this._etag ? { IfNoneMatch: this._etag } : {}),
        }), { abortSignal: signal });
      } catch (error) {
        if ((error.$metadata?.httpStatusCode === 304 || error.name === 'NotModified')
          && this._snapshot && this._etag) return;
        throw error;
      }
      body = response.Body;
      if (response.$metadata?.httpStatusCode === 304 && this._snapshot && this._etag) return;
      const expected = response.ContentLength;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_BYTES)) {
        throw new Error('Catalog download exceeds the size limit or has invalid length');
      }
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Catalog download has no stream');
      let received = 0;
      const cap = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > MAX_BYTES ? new Error('Catalog download exceeds 32 MB') : null, chunk);
        },
      });
      await pipeline(body, cap, createWriteStream(part, { flags: 'wx', mode: 0o600 }), { signal });
      if (!received || (expected !== undefined && received !== expected)) throw new Error('Incomplete catalog download');
      candidate = openSnapshot(part, this._mediaOrigin);
      signal.throwIfAborted();
      if (this._closed) throw unavailable();
      await rename(part, this._cachePath);
      if (this._closed) throw unavailable();
      this._replace(candidate);
      candidate = null;
      // Only remember the ETag after validation and activation, so bad versions are retried.
      this._etag = text(response.ETag);
    } finally {
      candidate?.db.close();
      body?.destroy?.();
      await rm(part, { force: true });
      this._controller = null;
    }
  }

  _replace(snapshot) {
    const previous = this._snapshot;
    this._snapshot = snapshot;
    previous?.db.close();
  }

  _success() {
    this._refreshedAt = new Date(Number(this._clock())).toISOString();
    this._stale = false;
  }

  _ready() {
    if (!this._snapshot || this._closed) throw unavailable();
    return this._snapshot;
  }

  _category(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !this._ready().categoryIds.has(value)) throw fail('Unknown catalog category');
    return value;
  }

  /** @returns {import('../shared/api-types.ts').CatalogStatus} */
  status() {
    const stats = this._snapshot?.stats;
    return {
      status: stats ? 'ready' : 'unavailable',
      total: stats?.total ?? 0, by_source: { ...stats?.by_source },
      categories: stats?.categories.map((category) => ({ ...category })) ?? [],
      built_at: stats?.built_at ?? null, refreshed_at: this._refreshedAt,
      stale: this._stale, attribution: stats?.attribution ?? ATTRIBUTION,
      photos_count: stats?.photos_count ?? 0, hours_week_count: stats?.hours_week_count ?? 0,
    };
  }

  /** @returns {import('../shared/api-types.ts').SearchResult} */
  search(query = {}) {
    const { db } = this._ready();
    if (!object(query)) throw fail('Catalog query must be an object');
    const { q = '', limit = 40, offset = 0 } = query;
    if (typeof q !== 'string' || q.length > 200 || q.includes('\0')) throw fail('q must be a string of at most 200 characters');
    const pageSize = numeric(limit, 'limit', 1, 100, true);
    const start = numeric(offset, 'offset', 0, 20000, true);
    const category = this._category(query.category);
    const hasLat = query.lat !== undefined && query.lat !== null;
    const hasLng = query.lng !== undefined && query.lng !== null;
    const hasRadius = query.radius_m !== undefined && query.radius_m !== null;
    if (hasLat !== hasLng || (hasRadius && !hasLat)) throw fail('lat and lng are required together for distance searches');
    const lat = hasLat ? numeric(query.lat, 'lat', JEJU.south, JEJU.north) : null;
    const lng = hasLng ? numeric(query.lng, 'lng', JEJU.west, JEJU.east) : null;
    const radius = hasRadius ? numeric(query.radius_m, 'radius_m', 100, 50000) : null;
    const clauses = ['1 = 1'];
    const params = [];
    if (category) {
      clauses.push('p.category = ?');
      params.push(category);
    }
    // Literal LIKE also handles short Hangul and FTS punctuation. No dependency on
    // tokenizer availability, external-content FTS integrity, or FTS query syntax.
    for (const token of q.normalize('NFC').toLowerCase().trim().split(/\s+/u).filter(Boolean)) {
      const pattern = `%${token.replace(/[\\%_]/g, '\\$&')}%`;
      const columns = token.length < 3
        ? ['p.name_norm', 'p.tags_text']
        : ['p.name_norm', 'p.tags_text', 'p.name_en', 'p.summary', 'p.address'];
      clauses.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...columns.map(() => pattern));
    }
    const where = clauses.join(' AND ');
    let items;
    let total;
    if (hasLat) {
      // Apply the exact radius and sort every match before pagination. A bounding
      // rectangle or a pre-distance LIMIT would silently omit closer places.
      const matches = db.prepare(`SELECT p.* FROM places p WHERE ${where}`).all(...params)
        .map((row) => ({ row, distance: haversine(lat, lng, row) }))
        .filter(({ distance }) => radius === null || distance <= radius)
        .sort((a, b) => a.distance - b.distance || a.row.id.localeCompare(b.row.id));
      total = matches.length;
      items = matches.slice(start, start + pageSize).map(({ row, distance }) => place(row, distance));
    } else {
      total = db.prepare(`SELECT count(*) AS count FROM places p WHERE ${where}`).get(...params).count;
      items = db.prepare(`SELECT p.* FROM places p WHERE ${where} ORDER BY p.name, p.id LIMIT ? OFFSET ?`)
        .all(...params, pageSize, start).map((row) => place(row));
    }
    return { items, total, has_more: start + items.length < total };
  }

  points(query = {}) {
    const { db } = this._ready();
    if (!object(query)) throw fail('Catalog query must be an object');
    const category = this._category(query.category);
    const box = bounds(query.bbox);
    if (!box) return { type: 'FeatureCollection', features: [] };
    const [west, south, east, north] = box;
    const rows = db.prepare(`
      SELECT id, name, category, source, lat, lng FROM places
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      ${category ? 'AND category = ?' : ''} ORDER BY id LIMIT ?
    `).all(south, north, west, east, ...(category ? [category] : []), MAX_POINTS + 1);
    if (rows.length > MAX_POINTS) throw fail('Catalog map exceeds 20000 points; narrow the bounding box', 503);
    return {
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        properties: { id: row.id, name: row.name, category: row.category, source_label: sourceLabel(row.source) },
        geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
      })),
    };
  }

  /** @returns {import('../shared/api-types.ts').PlaceDetail | null} */
  detail(id) {
    const { db, hasExtra } = this._ready();
    if (typeof id !== 'string' || !id || id.length > 512 || id.includes('\0')) throw fail('Invalid catalog place id');
    const row = db.prepare('SELECT * FROM places WHERE id = ?').get(id);
    if (!row) return null;
    const rawExtra = hasExtra ? db.prepare('SELECT * FROM place_extra WHERE id = ?').get(id) : null;
    const base = place(row);
    const extra = extraFields(rawExtra, this._mediaOrigin);
    return { ...base, ...extra, field_evidence: detailEvidence(base, extra) };
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._controller?.abort();
    this._snapshot?.db.close();
    this._snapshot = null;
    this._stale = true;
    if (this._ownsClient) this._client?.destroy();
  }
}
