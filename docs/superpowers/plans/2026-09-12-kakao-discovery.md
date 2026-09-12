# Kakao Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $subagent-driven-development or $executing-plans to implement this plan task-by-task. The user approved the recommended composition and deployment; no additional approval gate is needed.

**Goal:** Use live Kakao results for commercial place discovery while retaining nature/trail information, field-specific public enrichment, and existing saved journeys.

**Architecture:** Extend the existing bounded Kakao service with one-page category/keyword searches. Session-bound signed selection tokens carry only current search results between ECS tasks; a detail adapter can attach an unambiguous nearby catalog reference without changing the Kakao identity or overwriting old records. The client routes commercial categories and unrestricted keyword searches to Kakao while preserving public nature filters and an explicit original-catalog option.

**Tech Stack:** Node 24, TypeScript, MapLibre, existing SQLite/S3 catalog, existing ECS/CloudFront infrastructure and SSM Kakao credential.

**Spec:** `docs/kakao-catalog-transition-review-2026-09-12.md`

## Global Constraints

- Existing 6,724 records and their IDs remain intact. No bulk harvesting or permanent Kakao catalog is created.
- Provider calls share the current 1,000/day budget, 20 requests per actor/minute, two active workers per task, bounded bodies, cancellation, and deadlines.
- Each new search fetches one page of 15 results; at most three pages/45 accessible results. Show the provider count and truncation honestly.
- No key, session-bound selection token, or API result is added to the PWA cache or exported as a catalog.
- Only a deliberate trip/favorite action stores its minimal existing snapshot; tokens and live detail records are excluded. Reopening refreshes the exact Kakao ID or displays an explicitly dated saved fallback.
- No changes to `agentcore-cli`, shared networking/NAT, DNS, existing routing data, or model budgets.

## Task 1: Bounded provider search

**Files:** `server/kakao.mjs`, `tests/kakao-discovery.test.mjs`.

**Interfaces:** Extend `createKakaoService` with `search(request, {signal})`. Request is `KakaoDiscoveryRequest`. Return `{items,total,pageable,page,page_size:15,end,truncated,queried_at}`; items use the existing normalized provider document shape `{id,name,category,group,groupName,address,road_address,phone,url,lng,lat,providerDistance}`.

- [x] Test category/keyword URLs, Jeju bounds, category group enforcement, page limits, malformed/overlapping IDs, cancellation, secret echoes, and shared concurrency with `lookup`.
- [x] Implement fixed-host GET category search for empty keywords and keyword search otherwise. Use `FD6`, `CE7`, `AD5`, `PK6`; keyword-only requests may return other native groups.
- [x] Use one shared bounded execution helper for lookup/search; preserve all previous lookup tests.
- [x] Run `node --test tests/kakao.test.mjs tests/kakao-recall.test.mjs tests/kakao-discovery.test.mjs`.

## Task 2: Session selection and public enrichment

**Files:** `server/discovery.mjs`, `server/api.mjs`, `server/catalog.mjs`, `tests/discovery.test.mjs`, `tests/discovery-api.test.mjs`.

**Interfaces:** POST `/api/kakao/search` returns `KakaoDiscoveryResult`; POST `/api/kakao/detail` accepts `{token}` and returns `PlaceDetail`; POST `/api/kakao/reopen` accepts `KakaoReopenRequest` and refreshes the exact provider ID. `/api/config.discovery` advertises availability and paging limits. An explicit `exclude_commercial=true` catalog search option serves the unfiltered public/nature landing list.

- [x] Test invalid/expired/cross-actor tokens and forbidden origins/proofs before provider calls.
- [x] Sign validated search selections with a separate HMAC domain and a 15-minute lifetime; never retain a server-side result database.
- [x] Match enrichment only by a unique full name/category within 200m, or an unqualified canonical name plus provider `본점` within 100m. Incomplete or ambiguous candidate sets attach no enrichment.
- [x] Keep provider identity/address/contact authoritative to its own source. Copy only source-backed public extras and retain per-field provenance, licenses and freshness.
- [x] Test exact-ID reopen, missing/changed providers, read-only catalog behavior, no-store HTTP responses, and quota failures.
- [x] Run `node --test tests/discovery*.test.mjs tests/catalog.test.mjs tests/kakao-api.test.mjs`.

## Task 3: Discovery UI and saved-place compatibility

**Files:** `src/kakao-discovery.ts`, `src/catalog-ui.ts`, `src/kakao-details.ts`, `src/explore.css`, `src/locales/en.ts`, `tests/kakao-discovery-client.test.mjs`, `tests/browser-kakao-discovery.mjs`.

**Interfaces:** Consume the shared discovery types and routes from Task 2. `KakaoDetails.showResolved(place, lookup)` paints a validated current result without a name lookup. Add source selection `auto|catalog|kakao` inside the existing optional filters.

- [x] Prefer Kakao for `맛집`, `카페`, `숙소`, `주차장`; preserve public nature filters and explicit original-catalog access.
- [x] Display source-specific counters and 15-item/45-result paging instead of the global 6,724 count for native results.
- [x] Publish markers from the current native result page without a second provider query. Scope changes and explicit area searches refresh them.
- [x] Keep short-lived selections only in bounded view memory. Open native cards by token, refresh saved native IDs by hint, and preserve every legacy lookup path.
- [x] Verify Korean/English, mobile scrolling/paging, native direct links, source failures, public enrichment, old/new favorites, and trip snapshots without tokens.
- [x] Run the targeted browser test plus existing Kakao, mobile catalog, layout and saved-data tests.

## Task 4: Review and deployment

**Files:** relevant README/workshop chapters and release record; existing deployment scripts.

- [x] Review the implementation and tests against the approved composition, including any AgentCore discovery consistency gaps.
- [x] Run the full release checks, tracked-source secret scan and immutable image build/push.
- [x] Inspect the actual CloudFormation change set; apply only project-owned application changes and necessary narrowly scoped integration changes.
- [x] Wait for healthy ECS stabilization, invalidate the application/PWA/workshop shell, and verify actual Kakao categories on the public site.
- [x] Record live verification, current image/task revision, limitations and commit the completed work.
