import type { AppConfig } from '../shared/api-types';

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

export async function apiJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timeout', 'TimeoutError')), 20000);
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new ApiError(String(body.code ?? body.error?.code ?? 'unavailable'), response.status);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

let configRequest: Promise<AppConfig> | undefined;
export function getConfig(): Promise<AppConfig> {
  configRequest ??= apiJSON<AppConfig>('/api/config').catch((error) => {
    configRequest = undefined;
    throw error;
  });
  return configRequest;
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

export const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

export function safeURL(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 3000) return null;
  try {
    const url = new URL(value, window.location.origin);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function link(value: unknown, label: string): string {
  const url = safeURL(value);
  return url ? `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(label)} ↗</a>` : html(label);
}

export function sourceName(source: string | null | undefined): string {
  const names: Record<string, string> = {
    osm: 'OpenStreetMap', openstreetmap: 'OpenStreetMap', curated: '큐레이션 시드',
    seed: '큐레이션 시드', sample: '큐레이션 시드', tourapi: '한국관광공사 TourAPI', visitjeju: '비짓제주',
    localdata: '지방행정 인허가', wikimedia: 'Wikimedia Commons', unknown: '정보 없음',
    osm_opening_hours: 'OpenStreetMap 영업시간', tourapi_usetime: 'TourAPI 이용시간',
  };
  return source ? names[source.toLowerCase()] ?? source : '정보 없음';
}

export function dateLabel(value: string | null | undefined, time = false): string {
  if (!value) return '정보 없음';
  const input = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const naiveKoreanDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input);
  if (!naiveKoreanDateTime && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) return '정보 없음';
  const date = new Date(naiveKoreanDateTime ? `${input.replace(' ', 'T')}+09:00` : input);
  if (!Number.isFinite(date.getTime())) return '정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(date);
}

export function categoryName(category: string): string {
  return ({
    attraction: '명소', nature: '자연', mountain: '산·오름', coast: '해안', island: '섬',
    beach: '해변', food: '음식점', restaurant: '음식점', cafe: '카페', stay: '숙소',
    lodging: '숙소', accommodation: '숙소', hotel: '숙소', shopping: '쇼핑', culture: '문화',
    museum: '박물관', park: '공원', activity: '액티비티', parking: '주차', transport: '교통',
    tourism: '관광', experience: '체험', other: '기타',
  } as Record<string, string>)[category] ?? category;
}

// Catalog/weather/guide endpoints share this supported service rectangle.
export const catalogBounds = { west: 126.15, south: 33.1, east: 126.98, north: 33.6 } as const;

export function isJejuPoint(lng: unknown, lat: unknown): boolean {
  return typeof lng === 'number' && typeof lat === 'number'
    && Number.isFinite(lng) && Number.isFinite(lat)
    && lng >= catalogBounds.west && lng <= catalogBounds.east
    && lat >= catalogBounds.south && lat <= catalogBounds.north;
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function distanceLabel(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters)) return '거리 정보 없음';
  return meters < 1000 ? `약 ${Math.round(meters / 10) * 10} m` : `약 ${(meters / 1000).toFixed(1)} km`;
}

export function publicMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 240);
  return /arn:aws|AKIA[A-Z0-9]|secret|traceback|access.?key|session.?token/i.test(text) ? fallback : text || fallback;
}

export const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
