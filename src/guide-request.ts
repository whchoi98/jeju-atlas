import { ApiError, getConfig, withAbort } from './api.ts';

export type GuideRecovery = 'invalid_conversation' | 'session_required' | 'csrf_invalid';

interface GuideRequest {
  message: string;
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
    }
  }
  throw new ApiError('unavailable', 503);
}
