import type { LatLng } from '../shared/api-types';
import type { PlaceSnapshot } from './saved-data';
import { isJejuPoint } from './api.ts';

export type LocatedPoint = LatLng & { accuracy_m: number | null };

export function currentJejuLocation(
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.geolocation,
): Promise<LocatedPoint> {
  return new Promise((resolve, reject) => {
    if (!geolocation) { reject(new Error('location_unavailable')); return; }
    geolocation.getCurrentPosition(position => {
      const { longitude: lng, latitude: lat, accuracy } = position.coords;
      if (!isJejuPoint(lng, lat)) { reject(new Error('location_outside_jeju')); return; }
      resolve({ lng, lat, accuracy_m: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null });
    }, error => reject(new Error(error.code === 1 ? 'location_denied' : 'location_unavailable')),
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 30_000 });
  });
}

export function selectedMapPoint(point: LatLng): PlaceSnapshot {
  if (!isJejuPoint(point.lng, point.lat)) throw new Error('location_outside_jeju');
  return {
    id: `point:${crypto.randomUUID()}`, name: '선택한 지도 지점', name_en: 'Selected map point',
    ...point, category: 'other', source: 'user_point', source_label: '사용자 선택 위치',
    base_note: '지도에서 직접 선택한 좌표입니다. 실제 출입구나 이용 정보를 확인한 장소가 아닙니다.',
    address: null, summary: '지도에서 선택한 위치', updated_at: null,
    geometry: { type: 'Point', coordinates: [point.lng, point.lat] }, sources: [],
  };
}
