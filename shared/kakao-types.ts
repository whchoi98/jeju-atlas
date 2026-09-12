/** Supplementary lookup; never replaces the catalog identity or map position. */
export type KakaoPlace = {
  id: string;
  name: string;
  category: string;
  address: string | null;
  road_address: string | null;
  phone: string | null;
  url: string;
};

export type KakaoLookup = {
  available: true;
  status: 'matched' | 'not_found' | 'ambiguous' | 'unsupported';
  canonical_id: string;
  queried_at: string;
  source: 'Kakao Local';
  place: KakaoPlace | null;
  reason?: 'no_results' | 'name_mismatch' | 'category_mismatch' | 'distance_mismatch'
    | 'multiple_candidates' | 'incomplete_results';
  match?: { method: 'name_category_distance'; distance_m: number };
};
