export interface PresenceConfig {
  enabled: boolean;
  csrf_token?: string;
  heartbeat_ms: number;
  window_ms: number;
}

/** Aggregate browser-session counts only; never includes visitor identifiers. */
export interface PresenceResult {
  active_visitors: number;
  total_visitors: number;
  as_of: string;
  window_seconds: number;
  counting_since: string | null;
}
