# Jeju Atlas

[![Node.js](https://img.shields.io/badge/Node.js-24-43853d)](package.json)
[![AWS](https://img.shields.io/badge/AWS-ECS_Fargate-FF9900)](docs/architecture.md)
[![AgentCore](https://img.shields.io/badge/AI-Bedrock_AgentCore-0972D3)](agent/README.md)
[![Workshop](https://img.shields.io/badge/Workshop-120_min-232F3E)](workshop/README.md)

[한국어](README.md) | [English](README.en.md)

A web/PWA application for exploring Jeju terrain, finding places, planning trips and asking an AI travel guide.
MapLibre renders the map, Kakao Local supplies place searches, and Valhalla computes walking and driving routes.

[Live application](https://jeju-atlas.whchoi.net/) | [Workshop](https://jeju-atlas.whchoi.net/workshop/) | [Documentation](docs/README.md) | [Changelog](CHANGELOG.md)

![Live Jeju Atlas 3D terrain view zoomed in on Hallasan](docs/images/app-terrain-en.webp)

*Application screenshots captured from the live English UI on September 13, 2026.*

## Overview

The frontend uses TypeScript and Vite. A Node.js API runs behind CloudFront, WAF and a public ALB on private ARM64 ECS Fargate tasks.
The deployment reuses its existing VPC and NAT gateways. A dedicated AgentCore Guide runs Strands and connects to its own Tools, Gateway and Memory.

The full application verification covered `release-20260912T153512Z`, then task definition `jeju-3d:26`.
Two healthy tasks and 99 operational checks were recorded on September 12, 2026.
These are release observations, not a live status indicator. See the [deployment record](workshop/DEPLOYMENT.md).

On September 16, 2026, tool preconfiguration, PyYAML recovery, the chapter 14 prompt
for a new AWS account, Codex configuration and HUD guides were published in
`jeju-3d:30` by updating the workshop files.
Two tasks, ALB targets, public files and browser behavior
were verified; the application release and routing image were preserved.

On 2026-09-24, the independent EC2 lab setup, explicit working directories, optional
verification and HUD guidance were published in the handbook-only image `jeju-3d:31`.
The matching setup helpers are on GitHub main. Public files, downloads and desktop/mobile
reader behavior were verified.

## Features

- Real elevation and satellite imagery, 2D/3D views, terrain controls and distance measurement.
- Place search by name, category and selected map area, with map/list highlighting.
- Favorites, recent searches and viewed places, and five pinned shortcuts.
- Start/finish search, waypoints, dwell times, itinerary reversal and GPX export.
- Actual Valhalla walking/driving route geometry, distances and estimates.
- Korean/English AI responses, streamed Markdown, tool progress and suggested follow-up questions.
- Available official photos and visitor facts with source and observation dates.
- PWA installation and offline access to the app shell and saved trips; the workshop has its own cache and update lifecycle.
- Current and cumulative browser-session counts.

The initial map displays representative terrain landmarks. Kakao search returns 15 places per page and at most 45 accessible results per query.

## Screenshots

### Place search

Search results for Seongsan Ilchulbong appear alongside the selected place on the map.

![Kakao place search results and satellite imagery around Seongsan Ilchulbong and Udo](docs/images/app-search-en.webp)

### Walking and driving routes

Compare walking and driving distances and estimates for the same endpoints, with the actual road route displayed on the map.

![Walking and driving comparison, travel estimates and the trip route on the map](docs/images/app-routing-en.webp)

### Mobile

The 390px-wide mobile view shows the 3D map and an expanded place-search panel.

| 3D map | Place search |
| :---: | :---: |
| <img src="docs/images/app-mobile-map-en.webp" alt="Mobile 3D map zoomed in on Hallasan" width="320"> | <img src="docs/images/app-mobile-search-en.webp" alt="Seongsan Ilchulbong search results in the mobile place panel" width="320"> |

## Architecture

```text
Browser/PWA -> CloudFront + WAF -> Lambda@Edge -> Public ALB -> Private Fargate
                                                               |-- Valhalla
                                                               |-- S3 / SQLite / DynamoDB
                                                               |-- Kakao Local
                                                               `-- AgentCore Guide (Strands)
                                                                     |-- Bedrock Global CRIS
                                                                     |-- Gateway / Tools
                                                                     `-- Memory
```

CloudFront also serves private static/media S3 origins through OAC and caches terrain tiles.
The browser loads Esri imagery. The ALB checks CloudFront origin-facing network access and an origin verification header.
Fargate has no public IP. AgentCore uses managed PUBLIC networking with IAM authentication.
See [architecture and boundaries](docs/architecture.md).

## Quick start

Use Node 24.18.1 or newer in the Node 24 line, npm and Python. Python 3.10+ is recommended for helpers; workshop Runtime code uses Python 3.12.

```bash
git clone https://github.com/whchoi98/jeju-atlas.git
cd jeju-atlas
npm ci
mkdir -p .local
python3 workshop/scripts/catalog_seed.py --output .local/catalog-standalone.sqlite
npm run build

HOST=127.0.0.1 PORT=8097 NODE_ENV=development \
PUBLIC_ORIGIN=http://localhost:8097 \
CATALOG_LOCAL_PATH="$PWD/.local/catalog-standalone.sqlite" \
node server/server.mjs
```

Open `http://localhost:8097`. Forward the port when using a remote EC2 host.
This starts with 137 committed sample records. The generator refuses to overwrite an existing catalog.
AI, Kakao lookup and road routing require their corresponding backend resources and configuration.
Production catalogs, enrichment responses and routing graphs are not stored in Git.

For Vite development, copy `.env.example` to `.env`, run `node --env-file=.env server/server.mjs` in one terminal and `npm run dev` in another.
The example origin is `http://localhost:5173`.
See [local development](docs/onboarding.md) for the Python check environment, port configuration and catalog verification.

## 100–120-minute AgentCore CLI workshop

After EC2 preparation, participants use **one implementation prompt and one deployment prompt**
to build a Jeju search tool and their own AgentCore Runtime. AgentCore CLI handles creation,
local execution, deployment and invocation; one of Codex, Claude Code or Kiro CLI implements
and debugs the project.

Complete the [preconfiguration](workshop/reference/preconfiguration.md) before class:
Node 24, uv and Python 3.12, Docker, npm `@aws/agentcore` 0.28.1 in the user npm prefix,
the EC2 AWS role, and one authenticated coding CLI. `check_env.sh` checks prerequisites;
`start.sh` prepares the participant workspace and missing core tools. Participants need the
full Git source: the reading-only handbook ZIP has no execution scripts.

Participants enter a **short-term Bedrock API key privately** with `workshop_env.py configure`.
The key and issuing region go in their `.env`; deployment configuration
references an owned SSM parameter ARN. Kakao, Korea Tourism Organization TourAPI and VISIT JEJU
keys are optional inputs **after the first deployment**. AWS deployment still uses the EC2 IAM role.
See [keys and integrations](workshop/reference/keys-and-integrations.md) for publication and renewal.

Recommend `claude --permission-mode auto` for Claude Code, and
`--sandbox workspace-write -a on-request -c 'approvals_reviewer="auto_review"'` for Codex.
Verify the coding CLI's login and supported model before class. Its model is separate from
JejuGuide's pinned Sonnet 4.6 Runtime model. See [assistant environments](workshop/reference/ai-cli-environments.md).

| Track | Scope |
|---|---|
| Before class | EC2 tools, login, CDK bootstrap and permissions, outside course time |
| Core | Chapters 00–04, 100 minutes |
| Buffer | Up to 20 minutes, 120 minutes total |
| Advanced | Chapters 05–14, full application and AWS infrastructure, extra time |
| Deliverable | A participant Runtime using a real model and Jeju search tool |
| Handbook | Markdown, HTML, downloadable ZIP and offline PWA |

Participants receive independent labs and automatically use `team01` and `AtlasCliTeam01`
as common internal identifiers; no team-name selection or replacement is required.
Separate comprehensive verification and HUD installation are optional. Run targeted checks
only when needed. Each terminal block starts with `cd` to the correct working directory.

This is a course plan, not evidence of a completed cloud rehearsal. The basic CLI Runtime
and advanced Guide/Tools/Gateway/Memory deployments are separate. Advanced participants use
their App stack's default CloudFront HTTPS URL without ACM, DNS or custom-domain setup.

The [installation skill](skills/jeju-atlas-install/SKILL.md) supports preparation and resuming
unfinished work. [Chapter 14's integrated prompt](workshop/prompts/14-project-completion.md)
is optional full-app work; its 45 minutes cover scoping and checking the first change.
Codex Bedrock provider configuration and HUD installation are also optional preparation.

![Terminal-style workshop command cards](docs/images/workshop-terminal.png)

Paste shell commands into Bash and the shared prompts into the selected coding CLI.

![Prompt cards for each Agentic AI coding assistant](docs/images/workshop-ai-input.png)

[Workshop](workshop/README.md) | [Facilitator guide](workshop/reference/facilitator.md) | [Downloads](workshop/reference/offline-start.md)

## Configuration

| Setting | Purpose |
|---|---|
| `CATALOG_LOCAL_PATH` / `CATALOG_BUCKET` | Local SQLite or an owned S3 catalog |
| `DETAILS_BUCKET` | Official detail snapshot |
| `PUBLIC_ORIGIN` | The browser-facing application origin |
| `ROUTING_URL` | Local Valhalla endpoint |
| `ROUTING_DATA_UPDATED_AT` | Actual routing-data timestamp |
| `KAKAO_REST_API_KEY` | Server-only lookup key, injected from SSM in production |
| `GuideLimitsEnabled` | Application AI cap configuration |

Production deployers target the owner's account and Seoul region. For another account, use the namespaced workshop flow.
See [.env.example](.env.example) and the [deployment runbook](docs/runbooks/deploy.md).

## Data boundaries

The committed 137-place dataset is a workshop seed, not officially verified visitor information.
The 6,724-place production catalog is a separate snapshot and does not represent the entire Kakao catalog.
Official enrichment supports individual fields, not blanket verification of a place.
Live traffic, complete Kakao ratings/reviews and offline AI are not provided by this implementation.
See [data quality](docs/data-quality.md) and [official details](docs/official-details-olle.md).

## Project structure

| Directory | Responsibility |
|---|---|
| `src/`, `public/`, `shared/` | Map UI, assets and shared contracts |
| `server/` | Node.js API |
| `agent/guide/`, `agent/tools/` | Strands Guide and MCP Tools |
| `routing/` | Valhalla runtime |
| `infra/`, `scripts/` | CloudFormation, build, deploy and verification |
| `tests/`, `workshop/`, `docs/` | Tests, course material and documentation |

See [AGENTS.md](AGENTS.md) for repository guidance and the
[implementation index](docs/reference/INDEX.md) for code pointers and design records.

## Testing and contributing

```bash
npm run check
npm run workshop:check
# With Playwright and Chromium configured:
WORKSHOP_BROWSER_TEST=1 npm run workshop:check
```

Full checks also require boto3, requests and cfn-lint. Local checks do not perform cloud deployment or model calls.
Follow [CONTRIBUTING.md](CONTRIBUTING.md), update [CHANGELOG.md](CHANGELOG.md), and attach the checks actually performed.
Use [GitHub Issues](https://github.com/whchoi98/jeju-atlas/issues) for non-sensitive reports and [SECURITY.md](SECURITY.md) for security guidance.

## Licensing and provenance

No root code license file is currently declared. Data, photos, map imagery, fonts and emoji have separate attribution and usage conditions.
See [fonts](public/fonts/README.md), [emoji](public/emoji/README.md), and [agent provenance](agent/source-provenance.json).
