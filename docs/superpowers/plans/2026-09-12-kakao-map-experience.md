# Kakao-inspired Jeju Map Experience Implementation Plan

**Goal:** Connect search, saved places, directions and map actions into a useful, verified Jeju trip workflow.
**Spec:** `docs/superpowers/specs/2026-09-12-kakao-map-experience.md`
**Architecture:** Reuse the catalog/Kakao APIs, TripPlanner/SavedDataStore and MapLibre layers. Add small UI controllers for browsing history, saved-place library, endpoint search and map actions.
**Tech Stack:** TypeScript, existing CSS tokens and NanumSquare, MapLibre, Node BFF, existing AWS deployment.

## Constraints

- Keep AI usage caps disabled and current/cumulative presence working.
- Keep source distinctions, provider quotas, token-free saved snapshots and exact-ID reopening.
- Do not automatically request location or persist GPS readings as browsing history.
- Preserve real routing, existing stops/favorites and the 12-stop bound.
- Keep new history separate from durable saved trip data; controls clear only what they name.
- Use existing AWS colors/icons/fonts; no new package or external image collection.

## Task 1 — History, suggestions and saved library

Owner files: `src/browsing-history.ts`, `src/search-suggestions.ts`, `src/place-library.ts`,
`src/navigation-ui.css`, focused history/UI tests.

Interfaces:

```ts
// BrowsingHistory: queries:string[], places:PlaceSnapshot[], pinnedIds:string[]
// rememberQuery(query), rememberPlace(place), removeQuery(query), removePlace(id)
// clearQueries(), clearPlaces(), togglePin(id), subscribe(callback), persisted:boolean
// SearchSuggestions(input, host, {history,getFavorites,onSearch,onPlace})
// .setResults(places), .close()
// PlaceLibrary(root,{history,getFavorites,onSelect,onAdd,onOrigin,onDestination,onFavorite})
// .render()
```

- [x] Validate and bound browser history (12 queries, 20 places, 30 days, 5 pinned favorites).
- [x] Show recent and result-based suggestions, supporting arrows/Enter/Escape without extra provider calls.
- [x] Build saved/recent/search panes, favorite filtering, pinning and clear/remove controls.
- [x] Test stale/invalid storage, token exclusion, duplicate records, deletion and unavailable storage.

## Task 2 — Place search and route endpoints

Owner files: `src/trip.ts`, `src/endpoint-search.ts`, `src/endpoint-search.css`,
`src/place-search.ts`, focused route/search tests.

Interfaces:

```ts
// lookupPlaces(query, center, signal, source?) -> Promise<CatalogPlace[]>
// TripPlanner keeps setOrigin, setDestination, add, toggleFavorite public.
// Add readonly favorites getter and optional getRecentPlaces callback.
```

- [x] Add explicit endpoint search using the current Kakao source when available, with a clearly selected catalog alternative.
- [x] Handle destination-first selection without inventing an origin; expose pending input as unsaved work.
- [x] Preserve user input/focus across route updates and source changes.
- [x] Reverse the route order with stop metadata intact and recalculate the real route.
- [x] Test same places, stale results, source failure, pending destination, reorder and token-free snapshots.

## Task 3 — Integration and map actions

Owner files: `src/explore.ts`, `src/catalog-ui.ts`, `src/catalog-map.ts`,
`src/map-actions.ts`, `src/map-actions.css`, shared location helper, relevant browser tests.

- [x] Add the saved tab and retain correct keyboard tab order and responsive layout.
- [x] Connect search suggestions/history and successful detail visits.
- [x] Expose manual search of the current viewport; keep results steady during ordinary map movement until requested.
- [x] Add current-location and map-point action controls with explicit permissions and error handling.
- [x] Preserve drag, rotation, pinch and measurement by distinguishing a click/hold from a gesture.
- [x] Add list-to-map highlight, address copying and useful share links.

## Task 4 — Observed recommendation misses

- [x] Read the existing agent investigation and reproduce causes against current data.
- [x] Fix confirmed Seongsan/family search problems without fabricated places or amenities.
- [x] Verify real complete answers with source-bearing candidates.

## Task 5 — Review, deployment and full completion audit

- [x] Test integrated search → saved → route → map flows in Korean and English.
- [x] Test permission denial/outside Jeju, touch and keyboard navigation, source errors, offline saved data and mobile cards.
- [x] Review independent component changes and resolve material findings.
- [x] Update workshop and release documentation; run required build/tests.
- [x] Build/publish, inspect the app change set, deploy and verify the public site.
- [x] Audit each spec requirement against actual source and runtime evidence before completing the overall goal.

Final evidence: `docs/kakao-map-experience-release-2026-09-12.md`.
Public name search additionally exposed distance ordering ahead of exact matches.
Changed keyword searches outside explicit nearby scope to Kakao relevance order;
the real Hanlim Park now appears first and both route modes were verified.
Final deployment: `release-20260912T105132Z` / `jeju-3d:25`, 99 production checks passed.
