import type { CatalogPlace } from '../shared/api-types';
import type { PlaceSnapshot } from './saved-data';
import { isJejuPoint } from './api.ts';

const native = /^kakao:[1-9]\d{0,19}$/;
const canonical = /^(?:poi_\d{1,8}|osm:(?:node|way|relation)\/\d{1,20})$/;
const clean = (value: string | null, maximum: number) => value !== null && value.trim()
  && value.length <= maximum && !/[\u0000-\u001f\u007f]|\p{Surrogate}/u.test(value);

export function placeLink(place: Pick<CatalogPlace, 'id' | 'name' | 'category' | 'lat' | 'lng'>, currentURL: string): string {
  if (!native.test(place.id) && !canonical.test(place.id)) throw new Error('place_link_unavailable');
  const base = new URL(currentURL);
  const url = new URL(base.pathname, base.origin);
  url.searchParams.set('atlas_place', place.id);
  if (native.test(place.id)) {
    if (!clean(place.name, 140) || !clean(place.category, 80) || !isJejuPoint(place.lng, place.lat)) throw new Error('place_link_unavailable');
    url.searchParams.set('atlas_name', place.name);
    url.searchParams.set('atlas_category', place.category);
    url.searchParams.set('atlas_lat', String(place.lat));
    url.searchParams.set('atlas_lng', String(place.lng));
  }
  return url.href;
}

export function sharedPlace(currentURL: string): { id: string; hint?: PlaceSnapshot } | null {
  const url = new URL(currentURL);
  const keys = ['atlas_place', 'atlas_name', 'atlas_category', 'atlas_lat', 'atlas_lng'];
  if (!url.searchParams.has('atlas_place')) return null;
  if (keys.some(key => url.searchParams.getAll(key).length > 1)) throw new Error('invalid_place_link');
  const id = url.searchParams.get('atlas_place')!;
  if (canonical.test(id)) return { id };
  if (!native.test(id)) throw new Error('invalid_place_link');
  const name = url.searchParams.get('atlas_name'), category = url.searchParams.get('atlas_category');
  const latText = url.searchParams.get('atlas_lat'), lngText = url.searchParams.get('atlas_lng');
  const lat = Number(latText), lng = Number(lngText);
  if (!clean(name, 140) || !clean(category, 80) || !latText?.trim() || !lngText?.trim() || !isJejuPoint(lng, lat)) {
    throw new Error('invalid_place_link');
  }
  return {
    id, hint: {
      id, name: name!, category: category!, lat, lng, source: 'shared_hint',
      source_label: '공유 링크 · 확인 전', summary: '', updated_at: null, address: null,
      base_note: '공유 주소의 조회 힌트입니다. 같은 카카오 장소 ID를 확인한 뒤 표시합니다.',
      geometry: { type: 'Point', coordinates: [lng, lat] }, sources: [],
    },
  };
}
