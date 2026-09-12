import type { PresenceConfig, PresenceResult } from '../shared/presence-types.ts';
import { getLocale } from './i18n.ts';

export interface PresenceOptions {
  getConfig: (refresh?: boolean) => Promise<PresenceConfig | undefined>;
  fetch?: typeof fetch;
  clock?: () => number;
  requestTimeoutMs?: number;
}

const heartbeatMs = 30_000;
const refreshGapMs = 5000;
const unavailable = () => new Error('presence_unavailable');
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validDate = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value));

function parseConfig(value: PresenceConfig | undefined): PresenceConfig | undefined {
  if (value === undefined || value?.enabled === false) return undefined;
  if (!value || value.enabled !== true || !validCount(value.heartbeat_ms)
    || value.heartbeat_ms < 5000 || !validCount(value.window_ms) || value.window_ms > 300_000
    || value.window_ms < value.heartbeat_ms * 2 || value.window_ms % 1000
    || typeof value.csrf_token !== 'string' || !value.csrf_token.trim()
    || value.csrf_token.length > 4096 || /[\r\n]/.test(value.csrf_token)) throw unavailable();
  return {
    enabled: true, csrf_token: value.csrf_token,
    heartbeat_ms: value.heartbeat_ms, window_ms: value.window_ms,
  };
}

function parseResult(value: unknown): PresenceResult {
  if (!value || typeof value !== 'object') throw unavailable();
  const result = value as Partial<PresenceResult>;
  if (!validCount(result.active_visitors) || !validCount(result.total_visitors)
    || result.active_visitors > result.total_visitors || !validDate(result.as_of)
    || !validCount(result.window_seconds) || result.window_seconds < 1 || result.window_seconds > 300
    || (result.counting_since !== null && !validDate(result.counting_since))) throw unavailable();
  return {
    active_visitors: result.active_visitors, total_visitors: result.total_visitors,
    as_of: result.as_of, window_seconds: result.window_seconds, counting_since: result.counting_since,
  };
}

function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/**
 * Mount into the footer's existing span; import presence.css in the entrypoint.
 * getConfig(false) shares the app's initial config request and session cookie.
 * getConfig(true) is used once per stale-proof recovery; no actor ID is retained.
 */
export function initializePresence(root: HTMLElement, options: PresenceOptions): () => void {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error('Presence requires a browser document');
  const clock = options.clock ?? Date.now;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.requestTimeoutMs ?? 8000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError('Invalid presence timeout');
  let configuration: PresenceConfig | undefined;
  let last: PresenceResult | undefined;
  let disabled = false;
  let disposed = false;
  let pageHidden = false;
  let failed = false;
  let request: AbortController | undefined;
  let resumeNeeded = false;
  let timer: number | undefined;
  let timerAt = Infinity;
  let lastAttempt = -Infinity;
  let retryNotBefore = -Infinity;
  const usable = () => !disposed && !pageHidden && !document.hidden && view.navigator.onLine !== false;
  let paused = !usable();
  root.classList.add('presence-status');
  root.setAttribute('data-i18n-ignore', '');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-atomic', 'true');
  root.hidden = true;

  function paint(): void {
    if (disposed || disabled) { root.hidden = true; return; }
    if (!configuration && !last && !failed) { root.hidden = true; return; }
    const english = getLocale() === 'en';
    const locale = english ? 'en-GB' : 'ko-KR';
    const seconds = last?.window_seconds ?? (configuration?.window_ms ?? 90_000) / 1000;
    const stale = Boolean(last && (failed || paused || Math.abs(clock() - Date.parse(last.as_of)) > seconds * 1000));
    let text: string;
    if (last) {
      const number = new Intl.NumberFormat(locale);
      const counts = english
        ? `Online ${number.format(last.active_visitors)} · Total ${number.format(last.total_visitors)}`
        : `접속 ${number.format(last.active_visitors)} · 누적 ${number.format(last.total_visitors)}`;
      text = stale ? `${english ? 'Last confirmed' : '마지막 확인'} · ${counts}` : counts;
    } else text = failed || paused
      ? english ? 'Visitor counts unavailable' : '접속 집계 확인 불가'
      : english ? 'Checking visitor counts…' : '접속 집계 확인 중…';
    let description = english
      ? `Online: browser sessions seen in the last ${seconds} seconds. Total: each browser session is counted once since this feature started. Reloads and tabs sharing the same browser session are deduplicated. Counts represent browser sessions, not unique people.`
      : `접속: 최근 ${seconds}초 동안 접속한 브라우저 세션 수입니다. 누적: 이 기능의 집계 시작 후 처음 접속한 브라우저 세션을 한 번만 셉니다. 같은 브라우저 세션의 새로고침과 여러 탭은 중복 집계하지 않습니다. 실제 사람 수와는 다를 수 있습니다.`;
    if (last) {
      const date = (value: string) => new Intl.DateTimeFormat(locale, {
        dateStyle: 'short', timeStyle: 'medium',
      }).format(new Date(value));
      description += english ? ` Last confirmed: ${date(last.as_of)}.` : ` 마지막 확인: ${date(last.as_of)}.`;
      if (last.counting_since) description += english
        ? ` Counting since: ${date(last.counting_since)}.` : ` 집계 시작: ${date(last.counting_since)}.`;
    }
    root.hidden = false;
    root.lang = english ? 'en' : 'ko';
    root.dataset.presenceState = last ? stale ? 'stale' : 'live' : failed || paused ? 'unavailable' : 'loading';
    // Avoid repeatedly announcing unchanged counts in the live region.
    if (root.textContent !== text) root.textContent = text;
    root.title = description;
    root.setAttribute('aria-description', description);
  }
  function clearTimer(): void {
    if (timer !== undefined) view!.clearTimeout(timer);
    timer = undefined;
    timerAt = Infinity;
  }
  function schedule(at: number): void {
    if (disabled || !usable()) return;
    const due = Math.max(clock(), at);
    if (timer !== undefined && timerAt <= due) return;
    clearTimer();
    timerAt = due;
    timer = view!.setTimeout(() => {
      timer = undefined;
      timerAt = Infinity;
      void poll();
    }, Math.max(0, due - clock()));
  }
  async function loadConfig(refresh: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const value = await interrupted(Promise.resolve().then(() => {
      signal.throwIfAborted();
      return options.getConfig(refresh);
    }), signal);
    signal.throwIfAborted();
    configuration = parseConfig(value);
    disabled = !configuration;
    paint();
  }
  async function poll(): Promise<void> {
    if (disabled || request || !usable()) return;
    paused = false;
    lastAttempt = clock();
    const controller = new AbortController();
    request = controller;
    const signal = controller.signal;
    const deadline = view!.setTimeout(() => controller.abort(unavailable()), timeoutMs);
    try {
      if (!configuration) await loadConfig(false, signal);
      if (disabled) return;
      paint();
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        if (!usable()) throw new DOMException('Presence paused', 'AbortError');
        const response = await interrupted(fetchImpl('/api/presence/heartbeat', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            'X-Atlas-CSRF': configuration!.csrf_token!,
          },
          body: '{}',
        }), signal);
        const body: unknown = await interrupted(response.json(), signal);
        signal.throwIfAborted();
        if (response.ok) {
          last = parseResult(body);
          failed = false;
          retryNotBefore = -Infinity;
          paint();
          return;
        }
        const error = body && typeof body === 'object' ? body as { error?: { code?: unknown }; code?: unknown } : undefined;
        const code = error?.error?.code ?? error?.code;
        const staleProof = (response.status === 401 && code === 'session_required')
          || (response.status === 403 && code === 'csrf_invalid');
        if (attempt || !staleProof) throw unavailable();
        // Force config only for this stale-proof recovery. Event bursts cannot
        // bypass the one-retry limit or the failure cooldown.
        configuration = undefined;
        await loadConfig(true, signal);
        if (disabled) return;
      }
    } catch {
      if (disposed) return;
      const pausedAbort = signal.aborted && signal.reason?.name === 'AbortError';
      if (usable() && !pausedAbort) {
        failed = true;
        retryNotBefore = clock() + (configuration?.heartbeat_ms ?? heartbeatMs);
      }
      paint();
    } finally {
      view!.clearTimeout(deadline);
      if (request === controller) request = undefined;
      if (!disabled && usable()) {
        const cadence = configuration?.heartbeat_ms ?? heartbeatMs;
        schedule(Math.max(lastAttempt + (resumeNeeded ? refreshGapMs : cadence), retryNotBefore));
      }
      resumeNeeded = false;
    }
  }
  function pause(): void {
    paused = true;
    // Returning online does not re-confirm the old result; only a successful
    // heartbeat clears this label.
    if (last) failed = true;
    clearTimer();
    request?.abort(new DOMException('Presence paused', 'AbortError'));
    paint();
  }
  function resume(): void {
    if (!usable()) { pause(); return; }
    const wasPaused = paused;
    paused = false;
    paint();
    if (request) { if (wasPaused) resumeNeeded = true; return; }
    schedule(Math.max(lastAttempt + refreshGapMs, retryNotBefore));
  }
  const visibility = () => document.hidden ? pause() : resume();
  const pagehide = () => { pageHidden = true; pause(); };
  const pageshow = () => { pageHidden = false; resume(); };
  const listeners: [EventTarget, string, EventListener][] = [
    [view, 'online', resume], [view, 'offline', pause],
    [view, 'pagehide', pagehide], [view, 'pageshow', pageshow],
    [document, 'visibilitychange', visibility], [view, 'atlas:locale-change', paint],
  ];
  for (const [target, event, listener] of listeners) target.addEventListener(event, listener);
  if (usable()) schedule(clock());
  return () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    request?.abort(new DOMException('Presence disposed', 'AbortError'));
    for (const [target, event, listener] of listeners) target.removeEventListener(event, listener);
    root.hidden = true;
    // Closing one tab never removes activity belonging to another tab.
  };
}
