import { DiscoveryError } from './discovery.mjs';
import { catalogPlaceInfo } from './guide-facts.mjs';
import { normalizeGuideLocation } from './guide-locations.mjs';
import { inJeju } from './weather.mjs';

const SOURCE = 'Kakao Local';
const MAX_ITEMS = 3;
const MAX_BYTES = 16 * 1024;
const TTL = 15 * 60_000;
const CENTER = { lat: 33.4, lng: 126.55 };
const reference = /\n\s*\n(?:사용자가 가리킨 탐색 맥락:|Browsing context explicitly referenced by the user:|\[서비스 카탈로그 조회 자료\]|\[Service catalog reference data\])/i;
const categories = [
  ['맛집', /맛집|음식점|식당|밥집|\brestaurants?\b|\bfood\b|\bdining\b/giu],
  ['카페', /카페|커피|\bcaf[eé]s?\b|\bcoffee\b/giu],
  ['숙소', /숙소|숙박|호텔|펜션|\bhotels?\b|\baccommodations?\b|\blodging\b/giu],
  ['주차장', /주차장|\bparking\b/giu],
];
const selectedReference = /선택(?:한)?\s*(?:장소|곳)|이\s*(?:장소|곳)|여기|selected\s+(?:place|location)|this\s+place|around\s+here/i;
const nearby = /근처|주변|인근|주위|\bnear(?:by)?\b|\baround\b|\bclose to\b/i;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '');
const clean = (value, size) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, size).trim() : '';
const nativeId = value => typeof value === 'string' && /^kakao:[1-9]\d{0,19}$/.test(value);
const naturalAnchorCategories = new Set(['해변', '오름', '올레길']);
// An anchor preference only: this never rewrites IDs, coordinates or enrichment.
const landmarkAnchorCategories = new Map([['협재해수욕장', '해변']]);

function categoryFor(question) {
  const found = [];
  for (const [category, pattern] of categories) {
    for (const match of question.matchAll(pattern)) {
      const after = question.slice(match.index + match[0].length);
      const before = question.slice(Math.max(0, match.index - 12), match.index);
      if (/^\s*(?:는|은|을|를)?\s*(?:말고|빼고|제외|아니라)/.test(after) || /\b(?:not|without)\s*$/i.test(before)) continue;
      found.push({ category, index: match.index });
    }
  }
  return found.sort((a, b) => a.index - b.index)[0]?.category;
}

function keyword(question) {
  let value = question;
  for (const [, pattern] of categories) value = value.replace(pattern, ' ');
  return clean(value
    .replace(/제주(?:도)?|(?:추천|알려|찾아|찾고|찾아봐|소개)(?:해|할|줘|줄|주세요|해줘|해주세요|해\s*주세요)?|주세요|해\s*주세요|(?:아이|가족)와?\s*함께/g, ' ')
    .replace(/\b(?:recommend|recommendations?|find|suggest|suggestions?|please|in|on|jeju|island|some|a|the|me)\b/gi, ' ')
    .replace(/(?:^|\s)[을를은는좀](?=\s|$)/g, ' ')
    .replace(/[?!.,“”"'()]/g, ' ').replace(/\s+/g, ' '), 200);
}

function anchorName(question) {
  const found = (name, start) => ({
    name,
    // Remove only the anchor occurrence. A requested category can legitimately
    // have the same text elsewhere, especially before "near" in English.
    target: `${question.slice(0, start)} ${question.slice(start + name.length)}`,
  });
  const korean = /([가-힣A-Za-z0-9·]+)(?:\s*의)?\s*(?:근처|주변|인근|주위)/u.exec(question);
  if (korean) return found(korean[1].replace(/의$/, ''), korean.index);
  const english = /\b(?:near|around|close to)\s+(.{1,100}?)(?=[?!.,]|$)/i.exec(question);
  if (english) return found(english[1].replace(/\s+please$/i, '').trim(),
    english.index + english[0].length - english[1].length);
  return { name: '', target: question };
}

function naturalAnchor(name, candidates) {
  // Shared English aliases alone cannot establish the same physical landmark.
  const names = new Set(candidates.map(row => row.name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()));
  if (names.size !== 1) return null;
  const declaredCategory = landmarkAnchorCategories.get([...names][0]);
  const specificCategories = new Set(candidates.map(row => row.category).filter(category => category !== '관광지'));
  const category = declaredCategory ?? (specificCategories.size === 1 ? [...specificCategories][0] : null);
  if (!naturalAnchorCategories.has(category)
    || candidates.some(row => row.category !== category && row.category !== '관광지')) return null;
  const radians = Math.PI / 180;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      const haversine = Math.sin((b.lat - a.lat) * radians / 2) ** 2
        + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lng - a.lng) * radians / 2) ** 2;
      const distance = 12_742_000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
      if (distance > 200) return null;
    }
  }
  const canonical = declaredCategory ? candidates.filter(row => row.category === declaredCategory) : [];
  if (canonical.length === 1) return canonical[0];
  const literal = candidates.filter(row => row.name === name);
  return literal.length === 1 ? literal[0] : null;
}

function exactAnchor(name, catalog) {
  if (!name || !catalog?.search || !catalog?.detail) return null;
  try {
    const result = catalog.search({ q: name, limit: 50 });
    if (!Array.isArray(result?.items) || result.items.length > 50 || result.has_more
      || (Number.isSafeInteger(result.total) && result.total > result.items.length)) return null;
    const found = new Map();
    for (const row of result.items.slice(0, 50)) {
      if (!row || typeof row.id !== 'string'
        || ![row.name, row.name_en].some(label => label && normalize(label) === normalize(name))) continue;
      if (typeof row.name !== 'string' || !inJeju(row.lat, row.lng)) return null;
      const detail = catalog.detail(row.id);
      if (detail?.id !== row.id || detail.name !== row.name || detail.lat !== row.lat
        || detail.lng !== row.lng || detail.category !== row.category) return null;
      found.set(row.id, { id: row.id, name: row.name, category: row.category, lat: row.lat, lng: row.lng });
    }
    const candidates = [...found.values()];
    const chosen = candidates.length === 1 ? candidates[0] : naturalAnchor(name, candidates);
    return chosen ? { id: chosen.id, name: chosen.name, lat: chosen.lat, lng: chosen.lng } : null;
  } catch { return null; }
}

function nativePlace(place, clock) {
  const age = clock() - Date.parse(place?.updated_at);
  if (!nativeId(place?.id) || place.source !== SOURCE || !inJeju(place.lat, place.lng)
    || !clean(place.name, 160) || place.name.length > 160 || !clean(place.category, 80)
    || place.url !== `https://place.map.kakao.com/${place.id.slice(6)}` || !Number.isFinite(age) || age < 0) {
    throw new DiscoveryError('kakao_invalid_response');
  }
  if (age >= TTL) throw new DiscoveryError('kakao_selection_expired');
  // The public detail adapter may include its fresh browser proof. That proof
  // never belongs in Guide state, model context, derived output or Memory.
  const { selection_token: _token, ...safe } = place;
  return safe;
}

function compact(place) {
  const details = catalogPlaceInfo(place);
  if (details) {
    details.field_evidence = Object.fromEntries(Object.entries(details.field_evidence ?? {}).slice(0, 12));
    details.sources = details.sources.slice(0, 4);
    if (Buffer.byteLength(JSON.stringify(details)) > 4000) delete details.official_details;
    if (Buffer.byteLength(JSON.stringify(details)) > 4000) delete details.field_evidence;
  }
  return {
    id: place.id, name: place.name, category: clean(place.category, 80), lat: place.lat, lng: place.lng,
    source: SOURCE, observed_at: place.updated_at, address: clean(place.address, 320),
    phone: clean(place.phone, 100), url: place.url,
    ...(details ? { details } : {}),
  };
}

const messages = {
  ko: {
    ready: '이번 카카오 조회의 후보만 사용하세요. 이용시간·편의·현재 영업 여부는 각 필드의 근거가 있을 때만 설명하세요.',
    empty: '이번 카카오 조회에서 후보를 찾지 못했습니다. 기존 상업 카탈로그를 최신 조회 결과로 대신 제시하지 마세요.',
    unavailable: '현재 카카오 정보를 확인하지 못했습니다. 최신 상업 장소를 확인했다고 말하거나 기존 카탈로그로 대신 추천하지 마세요.',
    anchor_required: '정확한 기준 장소를 확인하지 못했습니다. 기준 장소의 이름이나 선택을 요청하고 제주 전체 검색으로 바꾸지 마세요.',
  },
  en: {
    ready: 'Use only these Kakao candidates. Describe hours, facilities and operating status only with evidence for that field.',
    empty: 'This Kakao search found no candidates. Do not replace them with old commercial catalog records.',
    unavailable: 'Current Kakao information could not be checked. Do not claim fresh commercial results or substitute old catalog recommendations.',
    anchor_required: 'The exact search anchor could not be established. Ask for a specific place or selection; do not search the whole island instead.',
  },
};

function result({ kind, status, category = '', query = '', places = [], anchor = null, locale = 'ko' }) {
  const payload = {
    version: 1, kind, status, source: SOURCE, category, query,
    items: places.slice(0, MAX_ITEMS).map(compact), anchor,
    queried_at: places[0]?.updated_at ?? null, message: messages[locale === 'en' ? 'en' : 'ko'][status],
  };
  // Keep the full original question separately; shrink only optional reference facts.
  for (const item of [...payload.items].reverse()) {
    if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_BYTES) break;
    delete item.details;
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) throw new DiscoveryError('kakao_invalid_response');
  const ids = new Set(payload.items.map(item => item.id));
  return { payload, places: places.filter(place => ids.has(place.id)) };
}

/** All provider calls stay in the caller's shared Kakao service and admission gates. */
export function createGuideDiscovery({ catalog, kakao, discovery, takeSlot, enabled = true, clock = Date.now }) {
  const available = () => (typeof enabled === 'function' ? enabled() : enabled)
    && typeof kakao?.search === 'function' && typeof takeSlot === 'function';
  return {
    validateSelection(token, actorId) {
      if (token === undefined) return null;
      if (typeof token !== 'string' || !token || token.length > 16_000 || !discovery?.detail) throw new DiscoveryError();
      return nativePlace(discovery.detail(token, actorId), clock);
    },
    async resolve({ message, actorId, selection = null, signal, locale = 'ko' }) {
      signal?.throwIfAborted();
      if (selection) selection = nativePlace(selection, clock);
      const question = normalizeGuideLocation(message.split(reference, 1)[0], catalog);
      const isNearby = nearby.test(question);
      const refersToSelection = selection && (selectedReference.test(question)
        || normalize(question).includes(normalize(selection.name)));
      if (refersToSelection && !isNearby) {
        const place = nativePlace(selection, clock);
        return result({ kind: 'selection', status: 'ready', query: place.name, places: [place], locale });
      }
      let anchor = null;
      const parsedAnchor = isNearby ? anchorName(question) : null;
      if (isNearby) {
        const name = parsedAnchor.name;
        const isSelectionAnchor = refersToSelection && (!name || selectedReference.test(name)
          || normalize(name) === normalize(selection.name));
        anchor = isSelectionAnchor
          ? { id: selection.id, name: selection.name, lat: selection.lat, lng: selection.lng }
          : exactAnchor(name, catalog);
      }
      const category = categoryFor(anchor ? parsedAnchor.target : question);
      if (!category) return null;
      const common = { kind: 'search', category, locale };
      if (isNearby && !anchor) return result({ ...common, status: 'anchor_required' });
      if (!isNearby && /현재\s*지도|지도\s*(?:중심|화면)|current\s+map|map\s+cent(?:er|re)/i.test(question)) {
        return result({ ...common, status: 'anchor_required' });
      }
      const query = anchor ? '' : keyword(question);
      if (!available()) return result({ ...common, query, anchor, status: 'unavailable' });
      try {
        signal?.throwIfAborted();
        await takeSlot(actorId);
        signal?.throwIfAborted();
        const response = await kakao.search({
          query, category, scope: anchor ? 'nearby' : 'all', page: 1,
          center: anchor ? { lat: anchor.lat, lng: anchor.lng } : { ...CENTER },
          ...(anchor ? { radius_m: 5000 } : {}),
        }, { signal });
        signal?.throwIfAborted();
        if (!Array.isArray(response?.items) || response.items.length > 15 || response.page !== 1) throw new DiscoveryError('kakao_invalid_response');
        const places = response.items.slice(0, MAX_ITEMS).map(raw =>
          nativePlace(discovery.detailFor(raw, response.queried_at), clock));
        return result({ ...common, query, anchor, places, status: places.length ? 'ready' : 'empty' });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return result({ ...common, query, anchor, status: 'unavailable' });
      }
    },
  };
}
