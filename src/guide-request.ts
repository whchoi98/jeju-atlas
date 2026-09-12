import { ApiError, getConfig, isJejuPoint, withAbort } from './api.ts';
import type { GuideMap } from '../shared/api-types';
import type { PlaceSnapshot } from './saved-data';

export type GuideRecovery = 'invalid_conversation' | 'session_required' | 'csrf_invalid';

export type NativeGuideSelection = { id: string; name: string; selection_token: string };

/** In-memory hint for a deliberate detail click; no automatic saved-data write. */
export function guideReopenHint(marker?: GuideMap['markers'][number]): PlaceSnapshot | undefined {
  if (!marker || !/^kakao:[1-9]\d{0,19}$/.test(marker.id) || marker.source !== 'Kakao Local'
    || !isJejuPoint(marker.lng, marker.lat)) return undefined;
  return {
    id: marker.id, name: marker.name, category: marker.category, lat: marker.lat, lng: marker.lng,
    source: 'Kakao Local', source_label: '카카오 조회 정보', base_note: null, address: null,
    summary: marker.summary, updated_at: marker.observed_at,
    geometry: { type: 'Point', coordinates: [marker.lng, marker.lat] },
    sources: [{ source: 'Kakao Local', url: `https://place.map.kakao.com/${marker.id.slice(6)}`,
      observed_at: marker.observed_at, license: null }],
  };
}

/** A current detail card is context only when the question actually references it. */
export function guideSelectionToken(message: string, selection?: NativeGuideSelection | null): string | undefined {
  if (!selection || !/^kakao:[1-9]\d{0,19}$/.test(selection.id)
    || !selection.name.trim() || !selection.selection_token || selection.selection_token.length > 16_000) return undefined;
  const normalize = (value: string) => value.normalize('NFKC').replace(/[\p{P}\s]/gu, '').toLowerCase();
  return /선택(?:한)?\s*(?:장소|곳)|이\s*(?:장소|곳)|여기|selected\s+(?:place|location)|this\s+place|around\s+here/i.test(message)
    || normalize(message).includes(normalize(selection.name)) ? selection.selection_token : undefined;
}

interface GuideRequest {
  message: string;
  selectionToken?: string;
  conversationId?: string;
  csrfToken?: string;
  requestId?: string;
  locale?: 'ko' | 'en';
  signal: AbortSignal;
  onRecovery?: (reason: GuideRecovery) => void;
}

interface RequestDependencies {
  fetchImpl?: typeof fetch;
  refreshSession?: (signal: AbortSignal) => Promise<string | undefined | void>;
}

/**
 * One submission, at most one authentication recovery. Unlike the reference
 * project's general transport retry, no network/5xx/SSE retry is permitted:
 * those failures can happen after quota consumption and model invocation.
 */
export async function requestGuide(
  options: GuideRequest,
  dependencies: RequestDependencies = {},
): Promise<Response> {
  if (options.requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.requestId)) {
    throw new ApiError('invalid_request', 400);
  }
  if (options.locale !== undefined && options.locale !== 'ko' && options.locale !== 'en') throw new ApiError('invalid_request', 400);
  if (options.selectionToken !== undefined && (typeof options.selectionToken !== 'string'
    || !options.selectionToken || options.selectionToken.length > 16_000)) throw new ApiError('kakao_selection_invalid', 400);
  const { message, requestId, locale } = options;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const refreshSession = dependencies.refreshSession ?? (async () => {
    const config = await getConfig(true);
    if (!config.features.guide) throw new ApiError('guide_unavailable', 503);
    return config.guide.csrf_token;
  });
  let conversationId = options.conversationId;
  let csrfToken = typeof options.csrfToken === 'string' ? options.csrfToken : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    options.signal.throwIfAborted();
    const response = await fetchImpl('/api/guide', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'text/event-stream',
        ...(csrfToken ? { 'X-Atlas-CSRF': csrfToken } : {}),
      },
      body: JSON.stringify({
        message,
        ...(options.selectionToken ? { selection_token: options.selectionToken } : {}),
        ...(requestId ? { request_id: requestId } : {}),
        ...(locale ? { locale } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => null);
    options.signal.throwIfAborted();
    const rawCode = body?.error?.code ?? body?.code;
    const code = typeof rawCode === 'string' ? rawCode : 'unavailable';
    const recoverable = (response.status === 403 && code === 'invalid_conversation')
      || (response.status === 401 && code === 'session_required')
      || (response.status === 403 && code === 'csrf_invalid');
    if (attempt !== 0 || !recoverable) throw new ApiError(code, response.status);
    // A refreshed session-bound proof may accompany a different actor cookie.
    // Never replay an old actor-bound conversation across that recovery.
    conversationId = undefined;
    options.onRecovery?.(code as GuideRecovery);
    options.signal.throwIfAborted();
    if (code === 'session_required' || code === 'csrf_invalid') {
      const refreshed = await withAbort(refreshSession(options.signal), options.signal);
      csrfToken = typeof refreshed === 'string' && refreshed ? refreshed : undefined;
      // Recovery may have changed the actor. Renew the selection by reopening
      // its detail card rather than replaying a proof across that boundary.
      if (options.selectionToken) throw new ApiError('kakao_selection_expired', 400);
    }
  }
  throw new ApiError('unavailable', 503);
}
