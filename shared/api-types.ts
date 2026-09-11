import type { RoutingConfig } from './routing-types';

export type LatLng = { lat: number; lng: number };
export type FieldEvidence = {
  state: 'unknown' | 'unverified' | 'source_reported' | 'parsed' | 'reviewed';
  source: string | null;
  observed_at: string | null;
  evidence_url: string | null;
};
export type FieldEvidenceMap = Record<string, FieldEvidence>;
export type SourceRecord = {
  source: string;
  url: string | null;
  observed_at: string | null;
  license: string | null;
  note?: string | null;
};
export type CatalogPlace = LatLng & {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  address: string | null;
  summary: string;
  tags: string[];
  source: string;
  source_label: string;
  base_note: string | null;
  updated_at: string | null;
  region: string | null;
  avg_stay_min: number | null;
  url: string | null;
  phone: string | null;
  hours: string | null;
  distance_m: number | null;
  field_evidence?: FieldEvidenceMap;
};
export type PlacePhoto = {
  url: string;
  thumb_url: string | null;
  origin_url: string | null;
  credit: string;
  license: string;
  source: string;
};
export type HoursRow = { day: number; open: string; close: string };
export type OfficialPlaceDetail = {
  provider: 'tourapi' | 'visitjeju';
  provider_id: string;
  locale: 'ko' | 'en';
  source_url: string;
  fetched_at: string;
  title: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  overview: string | null;
  facts: { key: string; label_ko: string; label_en: string; value: string }[];
  photos: PlacePhoto[];
  match: { method: string; distance_m: number | null };
  age_days?: number | null;
  stale?: boolean;
};
export type PlaceDetail = CatalogPlace & {
  photos: PlacePhoto[];
  hours_week: HoursRow[];
  hours_source: string | null;
  facilities: Record<string, string>;
  overview: string | null;
  menu: { name: string; price_krw: number | null; source: string | null }[];
  business_status: string | null;
  registration_note?: string | null;
  tips: unknown;
  sources: SourceRecord[];
  enriched_at: string | null;
  official_details?: OfficialPlaceDetail[];
};
export type CatalogStatus = {
  status: 'ready' | 'unavailable';
  total: number;
  by_source: Record<string, number>;
  categories: { id: string; count: number }[];
  built_at: string | null;
  refreshed_at: string | null;
  stale: boolean;
  attribution: string;
  photos_count: number;
  hours_week_count: number;
};
export type SearchResult = { items: CatalogPlace[]; total: number; has_more: boolean };
export type WeatherResult = {
  available: boolean;
  lat: number;
  lng: number;
  source: string;
  fetched_at: string;
  current: {
    time: string;
    temperature_c: number | null;
    wind_kmh: number | null;
    precipitation_mm: number | null;
    weather_code: number | null;
    summary: string;
  } | null;
  daily: {
    date: string;
    min_c: number | null;
    max_c: number | null;
    precipitation_probability: number | null;
    weather_code: number | null;
  }[];
  message?: string;
};
export type GuidePlaceInfo = {
  id: string;
  name: string;
  facilities: Record<string, string>;
  hours_week: HoursRow[];
  hours_source: string | null;
  enriched_at: string | null;
  sources: SourceRecord[];
  base_note: string | null;
  business_status: string | null;
  field_evidence?: FieldEvidenceMap;
  registration_note?: string | null;
  official_details?: OfficialPlaceDetail[];
};
export type GuideMap = {
  answer: string;
  center: LatLng | null;
  zoom: number;
  markers: (LatLng & {
    id: string;
    name: string;
    category: string;
    summary: string;
    source: string | null;
    observed_at: string | null;
  })[];
  place_info?: GuidePlaceInfo[];
  route: LatLng[];
  route_meta: {
    mode: 'car' | 'walk' | 'transit' | 'straight';
    distance_m: number;
    duration_s: number | null;
    provider: string;
  } | null;
  warnings: string[];
};
export type AppConfig = {
  version: string;
  features: { catalog: boolean; guide: boolean; planner: boolean; pwa: boolean; routing: boolean };
  guide: { daily_limit: number; csrf_token?: string };
  routing: RoutingConfig;
  kakao?: { enabled: boolean; csrf_token?: string };
};
