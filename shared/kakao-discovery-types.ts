import type { CatalogPlace, LatLng } from './api-types';

export type KakaoDiscoveryCategory = '맛집' | '카페' | '숙소' | '주차장';
export type KakaoDiscoveryScope = 'all' | 'view' | 'nearby';

export type KakaoDiscoveryRequest = {
  query: string;
  category: KakaoDiscoveryCategory | '';
  scope: KakaoDiscoveryScope;
  center: LatLng;
  bounds?: [number, number, number, number];
  radius_m?: number;
  page: number;
};

export type KakaoDiscoveryPlace = CatalogPlace & {
  provider_id: string;
  provider_category: string;
  category_code: string;
  queried_at: string;
  /** Short-lived, session-bound proof. Never save it in a trip or bookmark. */
  selection_token: string;
};

export type KakaoDiscoveryResult = {
  available: true;
  source: 'Kakao Local';
  query: string;
  category: KakaoDiscoveryCategory | '';
  scope: KakaoDiscoveryScope;
  items: KakaoDiscoveryPlace[];
  total: number;
  pageable: number;
  page: number;
  page_size: 15;
  has_more: boolean;
  truncated: boolean;
  queried_at: string;
};

export type KakaoDiscoveryConfig = {
  enabled: boolean;
  csrf_token?: string;
  categories: KakaoDiscoveryCategory[];
  page_size: 15;
  max_results: 45;
};

export type KakaoReopenRequest = {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
};
