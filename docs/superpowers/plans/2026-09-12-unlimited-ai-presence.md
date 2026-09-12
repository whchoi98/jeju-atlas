# Unlimited AI and Visitor Presence Implementation Plan

> **For agentic workers:** Use the independent worker scopes below and integrate in order. Checkboxes require current evidence.

**Goal:** Lift the app's AI usage caps and display current and cumulative browser connections.

**Architecture:** Keep the existing signed session and request ledger. In unlimited mode coordinate per conversation instead of using a global capacity pool. Store presence and cumulative first visits in a separate shared DynamoDB table.

**Tech Stack:** TypeScript UI, Node 24 BFF, DynamoDB, CloudFormation, ECS Fargate, CloudFront, existing AgentCore.

**Spec:** `docs/superpowers/specs/2026-09-12-unlimited-ai-presence.md`

## Global Constraints

- The overall Kakao-map-inspired feature expansion remains active after this release.
- `GUIDE_LIMITS_ENABLED=false` disables app usage caps; the default remains true.
- Request deduplication, same-conversation coordination, 90-second request deadlines and outcome-unknown safeguards remain.
- Presence heartbeat: 30 seconds; current activity window: 90 seconds.
- Browser sessions are deduplicated; counts must never be labeled as unique people.
- Do not change `agentcore-cli`, network resources or selected models.
- No API keys or session proof values in source, logs, snapshots or counters.

## Task 1: Unlimited request coordination

**Files:** `server/admission.mjs`, `server/guide.mjs`, `src/guide.ts`, `src/locales/en.ts`, admission/guide tests.

**Interface:** `createAdmission({limitsEnabled = true, ...})` and `createGuideHandler({limitsEnabled = true, ...})`.
The existing `acquire/start/finish` lifecycle stays intact.

- [x] Test more than 30 sequential requests, more than 5 hourly requests and at least 6 concurrent independent sessions with limits disabled.
- [x] Test same-browser independent conversations, same-conversation rejection, repeated request IDs, unknown outcomes and stale lease owners across shared stores.
- [x] Implement unlimited coordination without an unbounded global pool and without automatically retrying a started model request.
- [x] Preserve the default limited tests and show a localized limits-off message.

Run:

```bash
/tmp/jeju-node24/bin/node --test tests/admission*.test.mjs tests/guide*.test.mjs
```

## Task 2: Shared current and cumulative presence

**Files:** `server/presence.mjs`, `src/presence.ts`, `src/presence.css`, `shared/presence-types.ts`, presence tests.

**Interface:**

```ts
type PresenceConfig = {
  enabled: boolean; csrf_token?: string; heartbeat_ms: number; window_ms: number;
};
type PresenceResult = {
  active_visitors: number; total_visitors: number; as_of: string;
  window_seconds: number; counting_since: string | null;
};
// Service: heartbeat(actorId, {signal}), snapshot({signal}), close(), enabled.
// UI: initializePresence(root, {getConfig, fetch?}) returns a disposer.
```

- [x] Implement `scope` / `visitor` table keys with online, first-seen and total records.
- [x] Use an atomic first-seen registration and cumulative increment; query active records by cutoff instead of relying on deletion timing.
- [x] Test multi-tab and multi-instance deduplication, expiry, persistence, retries and failures with a shared store and SDK command contract.
- [x] Implement compact bilingual display, offline/unavailable states and one controlled CSRF refresh.

Run:

```bash
/tmp/jeju-node24/bin/node --test tests/presence*.test.mjs
```

## Task 3: API, infrastructure and footer integration

**Files:** `server/api.mjs`, `shared/api-types.ts`, `src/pwa.ts`, `src/explore.css`,
`src/api.ts`, `src/session-config.ts`,
`infra/application.yaml`, `infra/production.json`, `scripts/deploy.py`, `scripts/verify.py`,
`tests/presence-api.test.mjs`, `tests/deploy_test.py`, presence infrastructure tests.

- [x] Pass `GUIDE_LIMITS_ENABLED` into both coordination layers and expose null cap values with `limits_enabled=false`.
- [x] Implement proof-protected `POST /api/presence/heartbeat` and read-only aggregate `GET /api/presence`, both no-store.
- [x] Reject caller-selected identities, unsupported bodies and invalid proofs before a presence write.
- [x] Create `jeju-3d-presence`, scoped runtime IAM permissions and `PRESENCE_TABLE`.
- [x] Set production `GuideLimitsEnabled` to `"false"` and validate the explicit string setting.
- [x] Mount the presence indicator without increasing footer height; preserve existing offline messages and controls.
- [x] Serialize initial config fetches across same-origin windows, and test cookie-less windows with cache disabled and reordered responses.
- [x] Verify resource boundaries and document the workshop configuration and cleanup impact.

## Task 4: Verify, deploy, and resume the full map goal

- [x] Run production checks and browser checks for simultaneous requests, KO/EN counters, refresh/multi-tab deduplication and small-screen cards.
- [x] Build/publish the image and review a change set containing only the intended app/presence changes.
- [x] Apply the new code with the existing cap mode enabled and wait for legacy processes to stop.
- [x] Apply only `GuideLimitsEnabled=false` using the same image; wait for final service stability and old target draining, then invalidate the shell.
- [x] Verify live aggregate counts and independent AI responses without altering existing requests or resetting totals.
- [x] Record release evidence and finish this deployment; leave the full map feature expansion goal active.

Commands:

```bash
PATH="/tmp/jeju-node24/bin:$PATH" python3 scripts/deploy.py build-push
python3 scripts/deploy.py plan-app
python3 scripts/deploy.py apply-app
python3 scripts/deploy.py invalidate
python3 scripts/verify.py
```
