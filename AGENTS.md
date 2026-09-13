# Repository guidance

Jeju Atlas is a TypeScript/Vite map and PWA with a Node.js API, separate Python
Guide/Tools runtimes, a Valhalla routing container, and an AgentCore workshop.
Start with [README.md](README.md), [onboarding](docs/onboarding.md), and the
[implementation index](docs/reference/INDEX.md).

## Code map

| Area | Entry points |
|---|---|
| Browser UI | `index.html`, `src/main.ts`, `src/map.ts` |
| API and static server | `server/server.mjs`, `server/api.mjs` |
| Shared contracts | `shared/api-types.ts`, `shared/routing-types.ts`, `shared/kakao-discovery-types.ts` |
| Catalog and provider data | `server/catalog.mjs`, `server/official-details.mjs`, `server/discovery.mjs` |
| AI | `server/guide.mjs`, `agent/guide/main.py`, `agent/tools/main.py` |
| Road routing | `server/routing.mjs`, `routing/entrypoint.py`, `routing/runtime.py` |
| Build and infrastructure | `package.json`, `scripts/`, `Dockerfile*`, `infra/` |
| Workshop | `workshop/course.json`, `workshop/scripts/`, [workshop guidance](workshop/AGENTS.md) |

## Development and checks

Run commands from the repository root. Use Node 24.18.1 or newer **within the
Node 24 line**; `.nvmrc` pins the development version. `scripts/check.mjs`
rejects other Node major versions. Python helpers have separate dependencies
from npm; the full check needs `boto3` and `requests` in the selected Python
environment, and `cfn-lint` on the PATH.

| Command | Purpose |
|---|---|
| `npm ci` | Install the locked JavaScript dependencies |
| `npm run build` | Type-check, build the app, package the public workshop, and build the app service worker |
| `node --env-file=.env server/server.mjs` | Run the API and built static files with local settings |
| `npm run dev` | Run Vite; `/api` proxies to the separately started API on port 8097 |
| `npm run check` | Node tests, Python deployment tests, CloudFormation lint, npm audit, production build |
| `npm run workshop:check` | Workshop checks, separate from the root check |

Follow onboarding to create a fresh sample catalog and `.env`. Build before
starting the API because its static root defaults to `dist/`. Keep
`PUBLIC_ORIGIN` equal to the browser's origin: normally port 5173 with Vite,
or port 8097 when browsing the API server directly.

For a focused Node test, use `node --test tests/<name>.test.mjs`. Python deployment
tests use `python3 -m unittest discover -s tests -p '*_test.py'`; Agent tests
have their own suite under `tests/agent/`. `ATLAS_PYTHON` selects Python for the
root check, workshop check, and public-workshop build; it does not replace every
`python3` command in the repository. Keep the environment's executables consistent.

Run checks appropriate to the change. Documentation changes need valid local
links and executable examples. UI changes also need the relevant browser
checks. Record actual results; local checks do not establish AWS deployment,
provider availability, or successful live model calls.

## Implementation invariants

- Keep browser/API contracts in `shared/` aligned with both callers and handlers.
  Place objects use `{lat, lng}`; GeoJSON geometry uses `[lng, lat]`.
- Preserve MapLibre's explicit worker import and `setWorkerUrl` in `src/map.ts`;
  the worker must resolve after Vite hashes the build output.
- Initialize signed sessions through `/api/config`. Preserve CSRF handling,
  request deduplication, and conversation coordination. Disabling AI usage caps
  does not remove these controls.
- Kakao selection tokens are transient and bound to the session. Never persist
  them in bookmarks, trips, or public map data.
- Catalog snapshots are read-only SQLite. Keep the committed sample seed,
  production catalog, and field-level official evidence distinct. Retain source,
  observation time, photo credit, and license; do not fill missing facts by guess.
- Web walking/driving results come from Valhalla. Guide tool fallback routes have
  a different contract; do not present them as the same road calculation or as
  live traffic estimates.
- Saved trips/favorites and browsing history have separate storage and deletion
  scopes. Preserve those boundaries and cross-tab behavior.
- The root app and `/workshop/` have separate PWA caches and update lifecycles.
  Preserve the root service worker's workshop exclusion.
- Agent `uv.lock` files govern local dependency environments. Deployment bundles
  overlay source onto pinned ZIPs in `agent/dependency-artifacts.json`; a lockfile
  change alone does not refresh deployed dependencies.
- Keep provider keys and signing material server-side. `.env`, `.local/`,
  databases, and data archives stay outside Git; preserve tracked examples.

## Documentation and operations

Keep the existing Korean `README.md` and English `README.en.md` aligned. Link new
guides from `docs/README.md` and the relevant reference index. Add changes under
`CHANGELOG.md` → `Unreleased`; preserve dated release and verification records.
The existing design history lives in `docs/superpowers/specs/` and
`docs/superpowers/plans/`.

Production scripts target the owner's account, region, and existing resources.
Use [deployment](docs/runbooks/deploy.md) and [rollback](docs/runbooks/rollback.md)
procedures for authorized operations, and the workshop flow for participant
accounts. Retain deployed resource identifiers such as `jeju-3d` when changing
local directory names. See [CONTRIBUTING.md](CONTRIBUTING.md) for review guidance.
