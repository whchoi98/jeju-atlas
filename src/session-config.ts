/** Config establishes the HttpOnly session; first-window fetches must not race. */
function browserLocks(): LockManager | undefined {
  try { return typeof window === 'undefined' ? undefined : window.navigator?.locks; }
  catch { return undefined; }
}

export function hasSessionCoordination(): boolean {
  return typeof browserLocks()?.request === 'function';
}

export async function withSessionConfig<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  { locks = browserLocks(), timeoutMs = 25_000 }: {
    locks?: LockManager | null;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  if (!locks) return load();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError('Invalid config timeout');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Session connection timed out', 'TimeoutError')), timeoutMs);
  try {
    return await locks.request('jeju-atlas:session-config', {
      mode: 'exclusive', signal: controller.signal,
    }, () => load(controller.signal));
  } finally {
    clearTimeout(timeout);
  }
}
