const KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const PAGE_SIZE = 15;
const MAX_PAGES = 3;
const MAX_BODY_BYTES = 128 * 1024;
const CATEGORIES = new Map([
  ['맛집', ['FD6']], ['카페', ['CE7']], ['주차장', ['PK6']],
  ['관광지', ['AT4', 'CT1']], ['오름', ['AT4']], ['해변', ['AT4']],
  ['올레길', ['AT4']], ['박물관', ['CT1']], ['시장', ['MT1', 'AT4']],
]);
const ERRORS = new Map([
  ['kakao_unavailable', [503, 'Kakao Local is unavailable.']],
  ['kakao_invalid_response', [502, 'Kakao Local returned an invalid response.']],
  ['kakao_busy', [429, 'Kakao Local lookup is busy.']],
]);

/** Accepts only a known code; upstream diagnostics and causes never become public errors. */
export class KakaoError extends Error {
  constructor(code = 'kakao_unavailable') {
    const safeCode = ERRORS.has(code) ? code : 'kakao_unavailable';
    const [status, message] = ERRORS.get(safeCode);
    super(message);
    this.name = 'KakaoError';
    this.status = status;
    this.code = safeCode;
  }
}

const invalid = () => new KakaoError('kakao_invalid_response');
const aborted = () => new DOMException('Kakao Local lookup was aborted.', 'AbortError');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeName = (value) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '');
const inJeju = (lat, lng) => typeof lat === 'number' && Number.isFinite(lat) && lat >= 33.1 && lat <= 33.6
  && typeof lng === 'number' && Number.isFinite(lng) && lng >= 126.15 && lng <= 126.98;

function providerError(error, signal, code = 'kakao_unavailable') {
  if (signal.aborted) return signal.reason;
  if (error?.name === 'AbortError') return aborted();
  return error instanceof KakaoError ? new KakaoError(error.code) : new KakaoError(code);
}

function text(value, maxLength, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0008\u000e-\u001f\u007f]/u.test(value)) {
    throw invalid();
  }
  const trimmed = value.trim();
  if (!trimmed && !optional) throw invalid();
  return trimmed || null;
}

function coordinate(value, limit) {
  if (typeof value !== 'string' || value.length > 32 || !/^-?\d+(?:\.\d+)?$/u.test(value)) throw invalid();
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw invalid();
  return number;
}

function document(raw) {
  if (!object(raw) || typeof raw.id !== 'string' || !/^[1-9]\d{0,19}$/u.test(raw.id)) throw invalid();
  // Exact strings also exclude ports, userinfo, escapes, dot segments, queries and fragments.
  const url = `https://place.map.kakao.com/${raw.id}`;
  if (raw.place_url !== url && raw.place_url !== `http://place.map.kakao.com/${raw.id}`) throw invalid();
  const group = raw.category_group_code;
  if (typeof group !== 'string' || !/^(?:[A-Z]{2}\d)?$/u.test(group)) throw invalid();
  let providerDistance = null;
  if (raw.distance != null && raw.distance !== '') {
    if (typeof raw.distance !== 'string' || raw.distance.length > 32 || !/^\d+(?:\.\d+)?$/u.test(raw.distance)) {
      throw invalid();
    }
    providerDistance = Number(raw.distance);
    if (!Number.isFinite(providerDistance)) throw invalid();
  }
  // Stable field order allows identical IDs to coalesce without hiding conflicting records.
  return {
    id: raw.id, name: text(raw.place_name, 500), category: text(raw.category_name, 500),
    group, groupName: text(raw.category_group_name, 100, true),
    address: text(raw.address_name, 1000, true),
    road_address: text(raw.road_address_name, 1000, true),
    phone: text(raw.phone, 100, true), url,
    lng: coordinate(raw.x, 180), lat: coordinate(raw.y, 90), providerDistance,
  };
}

function page(raw, pageNumber, previous) {
  if (!object(raw) || !object(raw.meta) || !Array.isArray(raw.documents) || raw.documents.length > PAGE_SIZE) {
    throw invalid();
  }
  const { total_count: total, pageable_count: pageable, is_end: end } = raw.meta;
  if (!count(total) || !count(pageable) || pageable > total || typeof end !== 'boolean'
    || (previous && (previous.total !== total || previous.pageable !== pageable))) throw invalid();
  const offset = (pageNumber - 1) * PAGE_SIZE;
  const expected = Math.min(PAGE_SIZE, pageable - offset);
  if (raw.documents.length !== expected || end !== (offset + raw.documents.length === pageable)) throw invalid();
  return { total, pageable, end, documents: raw.documents.map(document) };
}

function distanceMeters(origin, candidate) {
  const radians = Math.PI / 180;
  const latDelta = (candidate.lat - origin.lat) * radians;
  const lngDelta = (candidate.lng - origin.lng) * radians;
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(origin.lat * radians) * Math.cos(candidate.lat * radians) * Math.sin(lngDelta / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/**
 * Read only a bounded stream, never response.json(). Caller settlement races the deadline;
 * cleanup stays attached to the worker so an ignored cancellation cannot free its slot.
 */
async function readResponse(response, controller) {
  const { signal } = controller;
  let reader;
  let finished = false;
  let cancellation;
  const cancel = () => {
    if (!cancellation) {
      try {
        cancellation = Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {});
      } catch {
        cancellation = Promise.resolve();
      }
    }
    return cancellation;
  };
  const onAbort = () => { void cancel(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    if (typeof response?.ok !== 'boolean') throw invalid();
    if (!response.ok) throw new KakaoError();
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300
      || typeof response.headers?.get !== 'function' || typeof response.body?.getReader !== 'function') throw invalid();
    const contentType = response.headers.get('content-type');
    if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) throw invalid();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d{1,12}$/u.test(length) || Number(length) > MAX_BODY_BYTES)) throw invalid();
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw providerError(error, signal);
      }
      signal.throwIfAborted();
      if (!object(chunk) || typeof chunk.done !== 'boolean') throw invalid();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) throw invalid();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw invalid();
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch (error) {
    const safeError = providerError(error, signal, 'kakao_invalid_response');
    // Publish errors before waiting for a possibly non-cooperating stream cancellation.
    controller.abort(safeError);
    throw safeError;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!finished || cancellation) await cancel();
    try { reader?.releaseLock(); } catch { /* Cancellation may still own the reader. */ }
  }
}

/** Stateless, bounded supplementary lookup; the parent owns persistent quota admission. */
export function createKakaoService({
  key, fetch: fetchImpl = globalThis.fetch, clock = Date.now, consumeBudget,
  timeoutMs = 6500, maxConcurrent = 2,
} = {}) {
  const apiKey = typeof key === 'string' ? key.trim() : '';
  const enabled = Boolean(apiKey);
  const active = new Set();
  let closed = false;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new KakaoError();

  function result(canonical, status, candidate, distance) {
    let queriedAt;
    try { queriedAt = new Date(clock()).toISOString(); } catch { throw new KakaoError(); }
    const dto = {
      available: true, status, canonical_id: canonical.id,
      queried_at: queriedAt, source: 'Kakao Local', place: null,
    };
    if (candidate) {
      const { id, name, category, address, road_address, phone, url } = candidate;
      dto.place = { id, name, category, address, road_address, phone, url };
      dto.match = { method: 'name_category_distance', distance_m: distance };
    }
    // A provider echo of an authorization value must not become user-visible contact data.
    if (JSON.stringify(dto).includes(apiKey)) throw invalid();
    return dto;
  }

  async function run(canonical, groups, radius, controller) {
    const { signal } = controller;
    const seen = new Map();
    let uncertain = false;
    // CATEGORIES permits at most two groups: three pages each, six requests per lookup.
    // Every group shares the caller's controller, deadline and concurrency slot.
    for (const group of groups) {
      let metadata;
      let rows = 0;
      let complete = false;
      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
        signal.throwIfAborted();
        // Deliberately outside provider-error handling: parent quota errors retain their identity.
        await consumeBudget({ signal });
        signal.throwIfAborted();
        const url = new URL(KEYWORD_URL);
        url.search = new URLSearchParams({
          query: canonical.name, x: String(canonical.lng), y: String(canonical.lat),
          radius: String(radius), size: String(PAGE_SIZE), page: String(pageNumber),
          category_group_code: group,
        }).toString();
        let response;
        try {
          response = await fetchImpl(url, {
            method: 'GET', redirect: 'error', signal,
            headers: { Accept: 'application/json', Authorization: `KakaoAK ${apiKey}` },
          });
        } catch (error) {
          throw providerError(error, signal);
        }
        // Even a late response after abort goes through stream cancellation, never parsing.
        const next = page(await readResponse(response, controller), pageNumber, metadata);
        metadata = next;
        let added = 0;
        const pageIds = new Set();
        for (const candidate of next.documents) {
          // An ignored filter cannot establish completeness, even for another allowed group.
          if (candidate.group !== group) throw invalid();
          const existing = seen.get(candidate.id);
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(candidate)) throw invalid();
            // An overlap across pages can replace unseen results, invalidating completeness.
            if (!pageIds.has(candidate.id)) throw invalid();
          } else {
            seen.set(candidate.id, candidate);
            added++;
          }
          pageIds.add(candidate.id);
        }
        if (next.documents.length && added === 0) throw invalid();
        rows += next.documents.length;
        if (next.end) {
          complete = true;
          break;
        }
      }
      // A full provider ceiling remains conservative even if it is marked as the last page.
      // Preserve uncertainty while querying the other groups; none can repair missing results.
      if (!complete || rows >= PAGE_SIZE * MAX_PAGES || metadata.total > metadata.pageable) uncertain = true;
    }
    signal.throwIfAborted();
    if (uncertain) return result(canonical, 'ambiguous');
    const names = new Set([normalizeName(canonical.name)]);
    if (canonical.name_en) names.add(normalizeName(canonical.name_en));
    const eligible = [];
    for (const candidate of seen.values()) {
      if (!groups.includes(candidate.group) || !names.has(normalizeName(candidate.name))
        || !inJeju(candidate.lat, candidate.lng)) continue;
      const distance = distanceMeters(canonical, candidate);
      if (distance <= radius) eligible.push({ candidate, distance });
    }
    if (eligible.length !== 1) return result(canonical, eligible.length ? 'ambiguous' : 'not_found');
    return result(canonical, 'matched', eligible[0].candidate, eligible[0].distance);
  }

  async function lookup(place, { signal: callerSignal } = {}) {
    if (!enabled || closed || typeof consumeBudget !== 'function' || typeof fetchImpl !== 'function'
      || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(apiKey)) throw new KakaoError();
    if (callerSignal?.aborted) throw aborted();
    // Snapshot only canonical fields, before any await; never mutate the catalog object.
    const canonical = {
      id: place?.id, name: place?.name, name_en: place?.name_en,
      category: place?.category, source: place?.source, lat: place?.lat, lng: place?.lng,
    };
    if (typeof canonical.id !== 'string' || !canonical.id || canonical.id.length > 256
      || typeof canonical.name !== 'string' || canonical.name.length > 500 || !normalizeName(canonical.name)
      || (canonical.name_en != null && (typeof canonical.name_en !== 'string' || canonical.name_en.length > 500))
      || !inJeju(canonical.lat, canonical.lng)) throw new KakaoError();
    const groups = CATEGORIES.get(canonical.category);
    if (!groups) return result(canonical, 'unsupported');
    if (active.size >= maxConcurrent) throw new KakaoError('kakao_busy');
    const radius = ['sample', 'curated', 'seed'].includes(canonical.source?.toLowerCase()) ? 2000 : 200;
    const controller = new AbortController();
    active.add(controller);
    const onCancel = () => controller.abort(aborted());
    callerSignal?.addEventListener('abort', onCancel, { once: true });
    let onStop;
    const stopped = new Promise((_, reject) => {
      onStop = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onStop, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new KakaoError()), timeoutMs);
    const work = run(canonical, groups, radius, controller).finally(() => active.delete(controller));
    try {
      return await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCancel);
      controller.signal.removeEventListener('abort', onStop);
      // Do not release here: ignored quota/fetch/cancel promises must keep their bounded slot.
    }
  }

  return {
    enabled,
    lookup,
    close() {
      closed = true;
      for (const controller of active) controller.abort(new KakaoError());
    },
  };
}
