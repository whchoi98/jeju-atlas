import { getLocale } from './i18n.ts';

export const DEFAULT_TOUR = 'jeju-loop';
export type TourLocale = 'ko' | 'en';
export type TourPosition = [number, number];
export type TourChoice = {
  id: string; course: string; name_ko: string; name_en: string;
  available: boolean; file?: string; reason?: string;
};
export type TourManifest = {
  version: 1; fetched_at: string; relations_examined: number; routes: TourChoice[];
};
export type OlleRoute = {
  type: 'Feature';
  properties: {
    id: string; course: string; name_ko: string; name_en: string;
    relation_id: number; source_url: string; license: 'ODbL-1.0'; license_url: string;
    fetched_at: string; source_updated_at: string | null;
    incomplete: boolean; simplification_m: number;
  };
  geometry: { type: 'MultiLineString'; coordinates: TourPosition[][] };
};
export type TourFrame = { center: TourPosition; bearing: number; part: number; gapBefore: boolean; distance_m: number };

const words = {
  ko: {
    theme: '둘러보기 테마', loop: '제주 한 바퀴', olle: '제주 올레길',
    start: '둘러보기 시작', stop: '둘러보기 멈춤', loading: '실제 경로를 불러오는 중…',
    missing: '경로 자료 미확보', failed: '경로 자료를 불러오지 못했어요. 다시 선택해 주세요.',
    mapped: '표시 경로', source: '경로 출처', fetched: '자료 조회', updated: 'OSM 수정',
    parts: '구간', gaps: '분리된 원자료 구간은 연결하지 않았습니다.',
    incomplete: 'OSM 참고 경로로, 현재 공식 코스 전체와의 일치는 미확인입니다.',
    caution: '탐색용 경로입니다. 실제 걷기는 최신 공식 안내와 현장 표지를 확인하세요.',
    official: '공식 코스 안내', stopped: '둘러보기를 멈췄어요. 자유롭게 탐험해 보세요.',
    complete: '둘러보기를 마쳤어요. 경로를 자유롭게 살펴보세요.',
    jump: '다음 확인 구간으로 이동', coverage: '공개 경로가 확인된 코스만 재생할 수 있어요.',
    beyond: '추자도 등 북쪽 구간은 장소 카탈로그 검색 범위 밖입니다.',
    overview: '경로 전체 보기', loopHint: '다섯 대표 명소로 이동합니다. 도보 경로가 아닙니다.',
    details: '경로 자료 · 출처', retry: '다시 불러오기', course: '코스',
  },
  en: {
    theme: 'Tour theme', loop: 'Around Jeju', olle: 'Jeju Olle trails',
    start: 'Start tour', stop: 'Stop tour', loading: 'Loading mapped trail geometry…',
    missing: 'Geometry unavailable', failed: 'Could not load the route. Select it again to retry.',
    mapped: 'Mapped length', source: 'Route source', fetched: 'Retrieved', updated: 'OSM edit',
    parts: 'parts', gaps: 'Separate source parts have not been connected.',
    incomplete: 'OSM reference geometry; agreement with the complete current official course is unverified.',
    caution: 'For exploration. Check current official guidance and trail signs before walking.',
    official: 'Official trail guide', stopped: 'Tour stopped. Explore freely.',
    complete: 'Tour complete. Explore the mapped route freely.',
    jump: 'Moving to the next mapped part', coverage: 'Only courses with available mapped geometry can play.',
    beyond: 'Northern sections such as Chuja are outside the place-catalog search area.',
    overview: 'Show whole route', loopHint: 'Visits five landmarks. This is not a walking route.',
    details: 'Route data & sources', retry: 'Retry loading', course: 'Course',
  },
} as const;

export function tourText(key: keyof typeof words.ko, locale: TourLocale = getLocale()): string {
  return words[locale][key];
}
export function tourLabel(choice: Pick<TourChoice, 'name_ko' | 'name_en'> | null, locale: TourLocale = getLocale()): string {
  return choice ? choice[locale === 'en' ? 'name_en' : 'name_ko'] : words[locale].loop;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const date = (value: unknown): value is string => text(value, 40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const position = (value: unknown): value is TourPosition => Array.isArray(value) && value.length === 2
  && value.every(v => typeof v === 'number' && Number.isFinite(v))
  && value[0] >= 125.7 && value[0] <= 127.4 && value[1] >= 32.25 && value[1] <= 34.55;
const same = (a: TourPosition, b: TourPosition) => a[0] === b[0] && a[1] === b[1];

export function validateTourManifest(value: unknown): TourManifest {
  if (!record(value) || value.version !== 1 || !date(value.fetched_at)
    || !Number.isSafeInteger(value.relations_examined) || Number(value.relations_examined) < 0
    || !Array.isArray(value.routes) || value.routes.length > 100) throw new Error('Invalid tour manifest');
  const ids = new Set<string>();
  const routes = value.routes.map((entry): TourChoice => {
    if (!record(entry) || !text(entry.id, 80) || !/^olle-[a-zA-Z0-9-]+$/.test(entry.id) || ids.has(entry.id)
      || !text(entry.course, 30) || !text(entry.name_ko) || !text(entry.name_en) || typeof entry.available !== 'boolean') {
      throw new Error('Invalid tour choice');
    }
    ids.add(entry.id);
    if (entry.available && (typeof entry.file !== 'string'
      || !/^\/data\/olle-\d+\.geojson$/.test(entry.file)
      || entry.file !== `/data/${entry.id}.geojson`)) throw new Error('Invalid local geometry path');
    return {
      id: entry.id, course: entry.course, name_ko: entry.name_ko, name_en: entry.name_en,
      available: entry.available, ...(entry.available ? { file: entry.file as string } : { reason: 'missing_geometry' }),
    };
  });
  return { version: 1, fetched_at: value.fetched_at, relations_examined: Number(value.relations_examined), routes };
}

export function validateOlleRoute(value: unknown): OlleRoute {
  if (!record(value) || value.type !== 'Feature' || !record(value.properties) || !record(value.geometry)
    || value.geometry.type !== 'MultiLineString' || !Array.isArray(value.geometry.coordinates)
    || !value.geometry.coordinates.length || value.geometry.coordinates.length > 512) throw new Error('Invalid trail geometry');
  const p = value.properties;
  if (!Number.isSafeInteger(p.relation_id) || Number(p.relation_id) < 1 || p.id !== `olle-${p.relation_id}`
    || p.source_url !== `https://www.openstreetmap.org/relation/${p.relation_id}`
    || p.license !== 'ODbL-1.0' || p.license_url !== 'https://opendatacommons.org/licenses/odbl/1-0/'
    || !text(p.course, 30) || !text(p.name_ko) || !text(p.name_en)
    || !date(p.fetched_at) || !(p.source_updated_at === null || date(p.source_updated_at))
    || typeof p.incomplete !== 'boolean' || typeof p.simplification_m !== 'number'
    || !Number.isFinite(p.simplification_m) || p.simplification_m < 0 || p.simplification_m > 20) {
    throw new Error('Invalid trail provenance');
  }
  let count = 0;
  const coordinates = value.geometry.coordinates.map((part): TourPosition[] => {
    if (!Array.isArray(part) || part.length < 2 || part.some(point => !position(point))) throw new Error('Invalid trail part');
    count += part.length;
    if (count > 50_000) throw new Error('Trail geometry too large');
    const line = part.map(point => [point[0], point[1]] as TourPosition);
    if (routeDistance([line]) <= 0) throw new Error('Empty trail part');
    return line;
  });
  return {
    type: 'Feature',
    properties: {
      id: p.id as string, course: p.course, name_ko: p.name_ko, name_en: p.name_en,
      relation_id: Number(p.relation_id), source_url: p.source_url as string, license: 'ODbL-1.0', license_url: p.license_url,
      fetched_at: p.fetched_at, source_updated_at: p.source_updated_at as string | null,
      incomplete: p.incomplete, simplification_m: p.simplification_m,
    },
    geometry: { type: 'MultiLineString', coordinates },
  };
}

export function pointDistance(a: TourPosition, b: TourPosition): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * radians / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function routeDistance(parts: TourPosition[][]): number {
  return parts.reduce((sum, line) => sum + line.reduce((distance, point, i) =>
    distance + (i ? pointDistance(line[i - 1], point) : 0), 0), 0);
}

/** Samples the original polyline at distance, including bends but excluding gaps. */
export function createTourTrack(parts: TourPosition[][]): { length: number; at: (distance: number) => TourFrame } {
  const edges: { a: TourPosition; b: TourPosition; start: number; end: number; part: number }[] = [];
  let length = 0;
  parts.forEach((part, partIndex) => {
    for (let i = 1; i < part.length; i++) {
      const span = pointDistance(part[i - 1], part[i]);
      if (span > 0) {
        edges.push({ a: part[i - 1], b: part[i], start: length, end: length + span, part: partIndex });
        length += span;
      }
    }
  });
  if (!edges.length) throw new Error('Empty route');
  return {
    length,
    at: (distance) => {
      if (!Number.isFinite(distance)) throw new Error('Invalid tour distance');
      const at = Math.max(0, Math.min(length, distance));
      let low = 0, high = edges.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (edges[middle].end < at) low = middle + 1;
        else high = middle;
      }
      const edge = edges[low];
      const ratio = (at - edge.start) / (edge.end - edge.start);
      const center: TourPosition = ratio <= 0 ? [...edge.a] : ratio >= 1 ? [...edge.b]
        : [edge.a[0] + (edge.b[0] - edge.a[0]) * ratio, edge.a[1] + (edge.b[1] - edge.a[1]) * ratio];
      return {
        center, part: edge.part, distance_m: at,
        bearing: Math.atan2((edge.b[0] - edge.a[0]) * Math.cos(center[1] * Math.PI / 180), edge.b[1] - edge.a[1]) * 180 / Math.PI,
        gapBefore: low > 0 && edges[low - 1].part !== edge.part && !same(edges[low - 1].b, edge.a),
      };
    },
  };
}

function deviationSquared(point: TourPosition, a: TourPosition, b: TourPosition): number {
  const scale = 111195.08;
  const xScale = scale * Math.cos((a[1] + b[1]) * Math.PI / 360);
  const x = (point[0] - a[0]) * xScale, y = (point[1] - a[1]) * scale;
  const dx = (b[0] - a[0]) * xScale, dy = (b[1] - a[1]) * scale;
  const factor = dx || dy ? Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy))) : 0;
  return (x - factor * dx) ** 2 + (y - factor * dy) ** 2;
}

/** RDP keeps existing vertices and each component's endpoints; never joins gaps. */
export function simplifySegments(parts: TourPosition[][], toleranceM = 8): TourPosition[][] {
  if (!Number.isFinite(toleranceM) || toleranceM < 0 || toleranceM > 20) throw new Error('Invalid simplification tolerance');
  return parts.map(line => {
    if (line.length <= 2) return line.map(point => [...point] as TourPosition);
    const keep = new Set([0, line.length - 1]);
    const pending = [[0, line.length - 1]];
    while (pending.length) {
      const [start, end] = pending.pop()!;
      let largest = toleranceM ** 2, index = -1;
      for (let i = start + 1; i < end; i++) {
        const distance = deviationSquared(line[i], line[start], line[end]);
        if (distance > largest) { largest = distance; index = i; }
      }
      if (index >= 0) {
        keep.add(index);
        pending.push([start, index], [index, end]);
      }
    }
    return [...keep].sort((a, b) => a - b).map(index => [...line[index]] as TourPosition);
  });
}

/** Camera positions follow source polylines; crossing a missing part is a jump. */
export function tourFrames(parts: TourPosition[][], maxFrames = 160): TourFrame[] {
  if (!Number.isInteger(maxFrames) || maxFrames < parts.length * 2 || maxFrames > 1024) throw new Error('Invalid frame bound');
  const lengths = parts.map(part => routeDistance([part]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!(total > 0)) throw new Error('Empty route');
  const budget = Math.min(maxFrames, Math.max(parts.length * 2, Math.ceil(total / 500) + parts.length * 2));
  const spare = budget - parts.length * 2;
  const frames: TourFrame[] = [];
  let travelled = 0;
  parts.forEach((part, partIndex) => {
    const length = lengths[partIndex];
    const count = 2 + Math.floor(spare * length / total);
    const cumulative = [0];
    for (let i = 1; i < part.length; i++) cumulative.push(cumulative[i - 1] + pointDistance(part[i - 1], part[i]));
    for (let index = 0; index < count; index++) {
      const at = length * index / (count - 1);
      let edge = 1;
      while (edge < part.length - 1 && cumulative[edge] < at) edge++;
      const a = part[edge - 1], b = part[edge];
      const span = cumulative[edge] - cumulative[edge - 1];
      const ratio = span ? Math.max(0, Math.min(1, (at - cumulative[edge - 1]) / span)) : 0;
      const center: TourPosition = index === 0 ? [...part[0]] : index === count - 1 ? [...part.at(-1)!]
        : [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
      frames.push({
        center, part: partIndex, distance_m: travelled + at,
        bearing: Math.atan2((b[0] - a[0]) * Math.cos(center[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI,
        gapBefore: index === 0 && partIndex > 0 && !same(parts[partIndex - 1].at(-1)!, part[0]),
      });
    }
    travelled += length;
  });
  return frames;
}

export function routeBounds(parts: TourPosition[][]): [[number, number], [number, number]] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const part of parts) for (const [lng, lat] of part) {
    west = Math.min(west, lng); east = Math.max(east, lng);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return [[west, south], [east, north]];
}

async function readLocalJson(path: string, limit: number, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('Route data unavailable');
  const body = await response.arrayBuffer();
  if (body.byteLength > limit) throw new Error('Route data exceeds limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}
export async function loadTourManifest(signal?: AbortSignal): Promise<TourManifest> {
  return validateTourManifest(await readLocalJson('/data/olle-routes.json', 100_000, signal));
}
export async function loadOlleRoute(choice: TourChoice, signal?: AbortSignal): Promise<OlleRoute> {
  if (!choice.available || choice.file !== `/data/${choice.id}.geojson` || !/^olle-\d+$/.test(choice.id)) throw new Error('Unavailable route');
  const route = validateOlleRoute(await readLocalJson(choice.file, 2 * 1024 * 1024, signal));
  if (route.properties.id !== choice.id) throw new Error('Route identity mismatch');
  return route;
}
