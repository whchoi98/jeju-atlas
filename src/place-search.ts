import type { CatalogPlace, LatLng } from '../shared/api-types';
import { apiJSON, getConfig, isJejuPoint, withAbort } from './api.ts';
import { discoveryConfig, nativeCatalogPlace, searchKakao } from './kakao-discovery.ts';
import { snapshot } from './saved-data.ts';

export type PlaceSearchSource = 'auto' | 'catalog';

export class PlaceSearchError extends Error {
  readonly code: 'invalid_query' | 'invalid_center' | 'invalid_source' | 'invalid_response';
  constructor(code: PlaceSearchError['code']) {
    super(code);
    this.name = 'PlaceSearchError';
    this.code = code;
  }
}

/**
 * One explicitly submitted lookup. Auto uses Kakao when enabled, otherwise the
 * catalog. A failed config/provider request is propagated, never substituted.
 * Only validated public fields leave this function; selection proofs do not.
 */
export async function lookupPlaces(
  query: string, center: LatLng, signal: AbortSignal, source: PlaceSearchSource = 'auto',
): Promise<CatalogPlace[]> {
  signal.throwIfAborted();
  if (typeof query !== 'string' || query.length > 160 || /[\x00-\x1f\x7f]|\p{Surrogate}/u.test(query)) {
    throw new PlaceSearchError('invalid_query');
  }
  const text = query.trim().replace(/\s+/g, ' ');
  if (!text) throw new PlaceSearchError('invalid_query');
  if (!center || !isJejuPoint(center.lng, center.lat)) throw new PlaceSearchError('invalid_center');
  if (source !== 'auto' && source !== 'catalog') throw new PlaceSearchError('invalid_source');
  if (source === 'auto') {
    const config = await withAbort(getConfig(), signal);
    signal.throwIfAborted();
    if (discoveryConfig(config)) {
      const result = await searchKakao({ query: text, category: '', scope: 'all', center, page: 1 }, { signal });
      signal.throwIfAborted();
      return result.items.map(item => {
        const place = nativeCatalogPlace(item);
        return { ...place, sources: [{ source: place.source, url: place.url, observed_at: place.updated_at, license: null }] };
      });
    }
  }
  const params = new URLSearchParams({ q: text, limit: '15', lat: String(center.lat), lng: String(center.lng) });
  const result = await withAbort(apiJSON<unknown>(`/api/catalog/search?${params}`, signal), signal);
  signal.throwIfAborted();
  if (!result || typeof result !== 'object' || !('items' in result) || !Array.isArray(result.items)
    || result.items.length > 15) throw new PlaceSearchError('invalid_response');
  const ids = new Set<string>();
  return result.items.flatMap((item): CatalogPlace[] => {
    try {
      const place = snapshot(item);
      if (ids.has(place.id)) return [];
      ids.add(place.id);
      return [{
        ...place, name_en: place.name_en ?? null, tags: [], region: null, avg_stay_min: null,
        url: place.sources[0]?.url ?? null, phone: null, hours: null, distance_m: null,
      }];
    } catch {
      throw new PlaceSearchError('invalid_response');
    }
  });
}
