import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN = 16_000;
const DEFAULT_TTL = 15 * 60_000;
const SOURCE = 'Kakao Local';
const CATEGORY = new Map([['FD6', '맛집'], ['CE7', '카페'], ['AD5', '숙소'], ['PK6', '주차장']]);
const PUBLIC_STATES = new Set(['source_reported', 'parsed', 'reviewed']);
const ERRORS = new Map([
  ['kakao_selection_invalid', [400, '카카오 검색 결과를 다시 선택해 주세요.']],
  ['kakao_selection_expired', [400, '카카오 검색 결과가 만료되었습니다. 최신 정보를 다시 확인해 주세요.']],
  ['kakao_place_unavailable', [404, '저장한 카카오 장소의 현재 정보를 확인하지 못했습니다.']],
  ['kakao_invalid_response', [502, '카카오 장소 정보를 확인할 수 없습니다.']],
]);

export class DiscoveryError extends Error {
  constructor(code = 'kakao_selection_invalid') {
    const safeCode = ERRORS.has(code) ? code : 'kakao_selection_invalid';
    const [status, message] = ERRORS.get(safeCode);
    super(message);
    this.status = status;
    this.code = safeCode;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '');
const inJeju = (lat, lng) => typeof lat === 'number' && Number.isFinite(lat) && lat >= 33.1 && lat <= 33.6
  && typeof lng === 'number' && Number.isFinite(lng) && lng >= 126.15 && lng <= 126.98;
const invalidProvider = () => new DiscoveryError('kakao_invalid_response');

function text(value, limit, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]|\p{Surrogate}/u.test(value)) {
    throw invalidProvider();
  }
  const clean = value.trim();
  if (!clean && !nullable) throw invalidProvider();
  return clean || null;
}

function providerRecord(raw) {
  if (!object(raw) || typeof raw.id !== 'string' || !/^[1-9]\d{0,19}$/.test(raw.id)
    || raw.url !== `https://place.map.kakao.com/${raw.id}` || !inJeju(raw.lat, raw.lng)
    || typeof raw.group !== 'string' || !/^(?:[A-Z]{2}\d)?$/.test(raw.group)) throw invalidProvider();
  return {
    id: raw.id, name: text(raw.name, 500), category: text(raw.category, 500), group: raw.group,
    groupName: text(raw.groupName, 100, true), address: text(raw.address, 1000, true),
    road_address: text(raw.road_address, 1000, true), phone: text(raw.phone, 100, true),
    url: raw.url, lat: raw.lat, lng: raw.lng,
  };
}

function distance(origin, target) {
  const r = Math.PI / 180;
  const a = Math.sin((target.lat - origin.lat) * r / 2) ** 2
    + Math.cos(origin.lat * r) * Math.cos(target.lat * r) * Math.sin((target.lng - origin.lng) * r / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

function categoryFor(place) {
  if (CATEGORY.has(place.group)) return CATEGORY.get(place.group);
  if (place.group === 'AT4') return '관광지';
  return place.groupName || '기타';
}

function compatibleCategory(place, row) {
  const path = place.category.normalize('NFKC').split('>').map(value => value.trim());
  const has = (...names) => names.some(name => path.includes(name));
  if (has('공중화장실', '화장실', '샤워장', '입구', '출구', '매표소')) return false;
  if (row.category !== '주차장' && has('관광지부속시설', '주차장')) return false;
  const commercial = CATEGORY.get(place.group);
  if (commercial) {
    if (commercial === '맛집' && (path[0] !== '음식점' || has('카페'))) return false;
    if (commercial === '카페' && !has('카페')) return false;
    if (commercial === '숙소' && !has('숙박', '호텔', '모텔', '펜션', '민박')) return false;
    if (commercial === '주차장' && !has('주차장')) return false;
    return row.category === commercial || (commercial === '맛집' && row.category === '음식점')
      || (commercial === '숙소' && row.category === '숙박');
  }
  const attraction = ['', 'AT4'].includes(place.group) && path[0] === '여행' && path[1] === '관광,명소';
  const culture = ['', 'CT1'].includes(place.group) && path[0] === '문화,예술' && has('문화시설');
  if (['관광지', '오름', '해변', '올레길'].includes(row.category)) {
    if (row.category === '관광지') return attraction || culture;
    if (!attraction) return false;
    if (row.category === '해변') return has('해수욕장', '해변', '해수욕장,해변', '바닷가');
    if (row.category === '오름') return has('산', '산봉우리', '오름');
    return has('도보여행', '도보코스', '산책로', '걷기코스', '둘레길', '올레길');
  }
  if (row.category === '박물관') return culture && has('박물관', '미술관', '전시관', '기념관');
  if (row.category === '문화시설') return culture;
  if (row.category === '시장') return has('시장', '전통시장');
  return row.category === categoryFor(place);
}

function referenceFor(catalog, place) {
  if (!catalog || typeof catalog.search !== 'function' || typeof catalog.detail !== 'function'
    || place.name.length > 200) return null;
  const fullName = normalize(place.name);
  const queries = [place.name];
  const mainStore = fullName.endsWith('본점');
  if (mainStore) {
    const base = place.name.replace(/\s*[\[(（]?\s*본점\s*[\])）]?\s*$/u, '').trim();
    if (base && base !== place.name) queries.push(base);
  }
  const candidates = new Map();
  try {
    for (const q of queries) {
      const result = catalog.search({ q, lat: place.lat, lng: place.lng, radius_m: 200, limit: 100, offset: 0 });
      if (!object(result) || !Array.isArray(result.items) || !Number.isSafeInteger(result.total)
        || result.total !== result.items.length || result.has_more) return null;
      for (const row of result.items) {
        if (!object(row) || typeof row.id !== 'string' || typeof row.name !== 'string'
          || !inJeju(row.lat, row.lng) || !compatibleCategory(place, row)) continue;
        const names = [row.name, row.name_en].filter(value => typeof value === 'string').map(normalize);
        const exact = names.includes(fullName);
        const alias = mainStore && !normalize(row.name).endsWith('점') && names.includes(fullName.slice(0, -2));
        if (!exact && !alias) continue;
        const meters = distance(place, row);
        if (meters > (exact ? 200 : 100)) continue;
        candidates.set(row.id, { row, distance_m: meters });
      }
    }
    if (candidates.size !== 1) return null;
    const found = [...candidates.values()][0];
    const detail = catalog.detail(found.row.id);
    if (!detail || detail.id !== found.row.id || detail.name !== found.row.name
      || detail.lat !== found.row.lat || detail.lng !== found.row.lng) return null;
    return { detail, distance_m: found.distance_m };
  } catch {
    return null;
  }
}

function hasEvidence(fields, name) {
  return object(fields?.[name]) && PUBLIC_STATES.has(fields[name].state)
    && typeof fields[name].source === 'string' && Boolean(fields[name].source);
}

function attachPublicExtras(base, reference) {
  if (!reference) return base;
  const { detail: original, distance_m } = reference;
  const fields = original.field_evidence || {};
  const extras = structuredClone({
    photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null,
    menu: [], business_status: null, tips: null, sources: [], official_details: [],
    field_evidence: {},
  });
  for (const [index, photo] of (original.photos || []).entries()) {
    if (extras.photos.length >= 40) break;
    if (!hasEvidence(fields, `photos.${index}`)) continue;
    extras.field_evidence[`photos.${extras.photos.length}`] = fields[`photos.${index}`];
    extras.photos.push(photo);
  }
  if (hasEvidence(fields, 'hours_week') && original.hours_source) {
    extras.hours_week = original.hours_week.slice(0, 100);
    extras.hours_source = original.hours_source;
    extras.field_evidence.hours_week = fields.hours_week;
  }
  for (const [name, value] of Object.entries(original.facilities || {})) {
    if (Object.keys(extras.facilities).length >= 100) break;
    if (!/^[a-z][a-z0-9_]*$/i.test(name) || ['constructor', 'prototype'].includes(name)
      || !hasEvidence(fields, `facilities.${name}`)) continue;
    extras.facilities[name] = value;
    extras.field_evidence[`facilities.${name}`] = fields[`facilities.${name}`];
  }
  for (const [index, item] of (original.menu || []).entries()) {
    if (extras.menu.length >= 100) break;
    if (!item.source || !hasEvidence(fields, `menu.${index}.name`)) continue;
    const next = extras.menu.length;
    extras.menu.push({ ...item, price_krw: hasEvidence(fields, `menu.${index}.price_krw`) ? item.price_krw : null });
    for (const key of ['name', 'price_krw']) {
      if (hasEvidence(fields, `menu.${index}.${key}`)) extras.field_evidence[`menu.${next}.${key}`] = fields[`menu.${index}.${key}`];
    }
  }
  for (const key of ['overview', 'business_status', 'tips']) {
    if (hasEvidence(fields, key)) {
      extras[key] = original[key];
      extras.field_evidence[key] = fields[key];
    }
  }
  extras.sources = (original.sources || []).slice(0, 99);
  for (const [index, record] of (original.official_details || []).entries()) {
    if (extras.official_details.length >= 8) break;
    if (typeof record?.title !== 'string' || !record.title.trim()) continue;
    const next = extras.official_details.length;
    extras.official_details.push({
      ...record, photos: (record.photos || []).slice(0, 40), facts: (record.facts || []).slice(0, 100),
    });
    if (fields[`official_details.${index}`]) {
      extras.field_evidence[`official_details.${next}`] = fields[`official_details.${index}`];
    }
  }
  const copied = structuredClone(extras);
  const result = {
    ...base, ...copied,
    sources: [...base.sources, ...copied.sources],
    field_evidence: { ...base.field_evidence, ...copied.field_evidence },
    enriched_at: original.enriched_at ?? null,
    ...(copied.business_status && original.registration_note ? { registration_note: original.registration_note } : {}),
    linked_catalog: { id: original.id, name: original.name, source: original.source, distance_m },
  };
  // An optional oversized enrichment cannot make a valid native contact card unavailable.
  return Object.keys(result.field_evidence).length <= 128
    && Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024 ? result : base;
}

/** Current selections only; signed proofs work across ECS tasks without a result database. */
export function createDiscoveryAdapter({ secret, catalog, clock = Date.now, ttlMs = DEFAULT_TTL } = {}) {
  if ((typeof secret !== 'string' && !Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL) {
    throw new Error('Invalid discovery signing configuration');
  }
  const actor = value => {
    if (typeof value !== 'string' || !value || value.length > 160 || /[\u0000-\u0020\u007f]/.test(value)) {
      throw new DiscoveryError();
    }
    return value;
  };
  const mac = (who, payload) => createHmac('sha256', secret)
    .update('kakao-selection-v1\0').update(actor(who)).update('\0').update(payload).digest();
  function timestamp(value) {
    if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) throw invalidProvider();
    const age = clock() - Date.parse(value);
    if (age < 0 || age >= ttlMs) throw new DiscoveryError('kakao_selection_expired');
    return value;
  }
  function basePlace(raw, queriedAt, center) {
    const place = providerRecord(raw);
    const date = timestamp(queriedAt);
    const base = {
      id: `kakao:${place.id}`, name: place.name, name_en: null, category: categoryFor(place),
      lat: place.lat, lng: place.lng, address: place.road_address || place.address, phone: place.phone,
      summary: '', tags: [], source: SOURCE, source_label: '카카오 조회 정보',
      base_note: '카카오 조회 정보입니다. 사진·이용 정보는 연결된 항목의 출처를 확인하세요.',
      updated_at: date, region: null, avg_stay_min: null, url: place.url, hours: null,
      distance_m: center ? Math.round(distance(center, place)) : null,
    };
    base.field_evidence = Object.fromEntries(['name', 'category', 'lat', 'lng', 'address', 'phone', 'url'].map(name => [
      name, { state: base[name] == null ? 'unknown' : 'source_reported',
        source: base[name] == null ? null : SOURCE, observed_at: base[name] == null ? null : date,
        evidence_url: base[name] == null ? null : place.url },
    ]));
    return base;
  }
  function tokenFor(raw, queriedAt, who) {
    const payload = Buffer.from(JSON.stringify({
      v: 1, iat: clock(), queried_at: timestamp(queriedAt), item: providerRecord(raw),
    })).toString('base64url');
    const token = `${payload}.${mac(who, payload).toString('base64url')}`;
    if (token.length > MAX_TOKEN) throw invalidProvider();
    return token;
  }
  function selected(token, who) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN) throw new DiscoveryError();
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some(value => !/^[A-Za-z0-9_-]+$/.test(value))) throw new DiscoveryError();
    const [payload, signature] = parts;
    const supplied = Buffer.from(signature, 'base64url'), expected = mac(who, payload);
    if (supplied.length !== expected.length || supplied.toString('base64url') !== signature
      || !timingSafeEqual(supplied, expected)) throw new DiscoveryError();
    let data;
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) throw new Error();
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw new DiscoveryError(); }
    if (!object(data) || data.v !== 1 || !Number.isSafeInteger(data.iat)) throw new DiscoveryError();
    const age = clock() - data.iat;
    if (age < 0 || age >= ttlMs) throw new DiscoveryError('kakao_selection_expired');
    return { item: providerRecord(data.item), queried_at: timestamp(data.queried_at) };
  }
  function buildDetail(raw, queriedAt, selectionToken) {
    const place = providerRecord(raw);
    const base = {
      ...basePlace(place, queriedAt),
      photos: [], hours_week: [], hours_source: null, facilities: {}, overview: null,
      menu: [], business_status: null, tips: null, official_details: [], enriched_at: null,
      sources: [{ source: SOURCE, url: place.url, observed_at: queriedAt, license: null, note: '카카오 조회 정보' }],
      kakao_lookup: {
        available: true, status: 'matched', canonical_id: `kakao:${place.id}`,
        queried_at: queriedAt, source: SOURCE,
        place: { id: place.id, name: place.name, category: place.category,
          address: place.address, road_address: place.road_address, phone: place.phone, url: place.url },
      },
      ...(selectionToken ? { selection_token: selectionToken } : {}),
    };
    try { return attachPublicExtras(base, referenceFor(catalog, place)); }
    catch { return base; }
  }
  function detailFor(raw, queriedAt, who) {
    return buildDetail(raw, queriedAt, who ? tokenFor(raw, queriedAt, who) : undefined);
  }
  return {
    toSearch(result, request, who) {
      if (!object(result) || !Array.isArray(result.items) || result.items.length > 15
        || !Number.isSafeInteger(result.total) || result.total < 0
        || !Number.isSafeInteger(result.pageable) || result.pageable < 0 || result.pageable > 45
        || result.pageable > result.total || !Number.isInteger(result.page) || result.page < 1 || result.page > 3
        || result.page_size !== 15 || typeof result.end !== 'boolean' || typeof result.truncated !== 'boolean'
        || !inJeju(request?.center?.lat, request?.center?.lng)) throw invalidProvider();
      return {
        available: true, source: SOURCE, query: request.query, category: request.category, scope: request.scope,
        items: result.items.map(raw => {
          const place = providerRecord(raw);
          return { ...basePlace(place, result.queried_at, request.center),
            provider_id: place.id, provider_category: place.category, category_code: place.group,
            queried_at: result.queried_at, selection_token: tokenFor(place, result.queried_at, who) };
        }),
        total: result.total, pageable: result.pageable, page: result.page, page_size: 15,
        has_more: !result.end && result.page * 15 < result.pageable,
        truncated: result.truncated, queried_at: timestamp(result.queried_at),
      };
    },
    detail(token, who) {
      const current = selected(token, who);
      return buildDetail(current.item, current.queried_at, token);
    },
    detailFor,
  };
}
