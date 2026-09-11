export type RouteMode = 'walk' | 'car';
export type RouteRequest = {
  mode: RouteMode;
  locale: 'ko' | 'en';
  stops: { lng: number; lat: number }[];
};
export type RouteSource = {
  provider: 'valhalla';
  data: 'OpenStreetMap';
  attribution: string;
  url: string;
  data_updated_at: string | null;
};
export type RouteStep = {
  instruction: string;
  distance_m: number;
  duration_s: number;
  /** Indexes into this leg's coordinates, including the end vertex. */
  start_index: number;
  end_index: number;
};
export type RouteLeg = {
  distance_m: number;
  duration_s: number;
  coordinates: [number, number][];
  steps: RouteStep[];
};
export type RouteSuccess = {
  available: true;
  mode: RouteMode;
  source: RouteSource;
  distance_m: number;
  duration_s: number;
  legs: RouteLeg[];
  coordinates: [number, number][];
  snapped: { lng: number; lat: number; distance_m: number }[];
  warnings: string[];
  traffic: 'not_live';
};
export type RouteUnavailable = {
  available: false;
  mode: RouteMode;
  source: RouteSource;
  code: 'no_route' | 'endpoint_unreachable' | 'ferry_required' | 'routing_unavailable';
};
export type RouteResult = RouteSuccess | RouteUnavailable;
export type RoutingConfig = {
  enabled: boolean;
  csrf_token?: string;
  modes: RouteMode[];
  source: RouteSource;
};
export type RouteElevationRequest = { coordinates: [number, number][] };
export type RouteElevationSource = { name: string; url: string };
export type RouteElevationResult = {
  available: true;
  /** One entry per input position, in the same order. Unknown heights stay null. */
  elevations_m: (number | null)[];
  source: RouteElevationSource;
} | {
  available: false;
  code: 'elevation_unavailable';
  source: RouteElevationSource;
};
