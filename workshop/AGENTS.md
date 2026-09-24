# Workshop guidance

This scope contains the course sources, static reader, participant-workspace
helpers, and their tests. Follow the root [AGENTS.md](../AGENTS.md) as well.
The nested `cli/template/AGENTS.md` is a participant-project template; its
substitution tokens and narrower workspace instructions are intentional.

## Sources and generated files

- Edit `course.json`, `chapters/`, `reference/`, `prompts/`, and `assets/`.
  Keep course entries, chapter links, and corresponding prompt cards aligned.
- `scripts/build.mjs` builds the reader and imports the selected fonts from
  `../public/fonts/`. `site/` is tracked generated output; rebuild it instead
  of editing its HTML, copied assets, or service worker directly.
- The core course is chapters 00–04, 100 minutes plus a 20-minute buffer;
  chapters 05–14 are optional. Keep duration and prerequisites consistent
  across the course manifest, reader, and READMEs when changing the curriculum.
- Keep shell commands separate from prompts for coding assistants. Preserve
  the terminal/prompt rendering and copy behavior tested by the reader suite.
- Call Codex, Claude Code and Kiro CLI "Agentic AI 코딩 어시스턴트" in Korean
  reader text, headings, prompt labels and accessibility labels. Use
  "Agentic AI coding assistant" in English prose.
- Keep explanatory paragraphs focused and short. Use Markdown hard line breaks
  at sentence boundaries when that helps scanning; source-only wrapping is not
  visible in HTML. Preserve command and prompt payloads when adjusting prose.
- Begin every participant-facing Bash/sh block with `cd` to its actual working
  directory. Clone and user-tool installation start from `$HOME`; preparation
  starts from the source root; project commands use the activated project path.
  Guard a failed `cd` without hiding it, and keep `source`/exports in the same
  shell rather than losing them inside a new subshell.
- Participants receive independent labs. `team01` and `AtlasCliTeam01` are
  automatic common identifiers, not team assignments. Do not ask learners to
  select or replace them; retain existing identifiers when resuming.
- Student prompts default to implementation and deployment with only necessary
  path/account/schema checks, deployment status and one example response.
  Separate test creation, full suites, model prechecks, local smoke calls and
  browser/multilingual checks are optional and scoped to a failure or request.
  `core.py doctor --project` requires test files and belongs only to that
  optional path. Never report skipped checks as passed. HUD is optional.
  Maintainer checks and production publication proofs below remain separate.

## Commands

Run from the repository root after `npm ci`. Install
`workshop/requirements.txt` in the chosen Python environment for checks.
The core participant helper `scripts/core.py` is an exception: `prepare` and
`doctor` start with Python 3.9+ and the standard library, without root npm
dependencies. Its doctor checks only the selected assistant and core tools.
The existing `lab.py doctor` remains the advanced app check.

`scripts/install_core.sh` is an explicit facilitator action with downloads and
local writes under an owned `workshop/.local/toolchain/`. Preserve its ownership
checks, Node checksum verification and uv `--no-bin` behavior. Participant
activation files are sourced in Bash and do not replace shell startup files,
system executables or assistant login settings.

Node 24, Python 3.12, helper packages and npm AgentCore CLI belong to the
documented preconfiguration phase before the 120-minute course. Full Atlas
work (chapters 05–14) also installs `requirements.txt` into the same helper
Python and checks `import yaml` before preparing an app copy. The chapter 14
bootstrap may complete this preconfiguration when starting from an empty
environment, then resume implementation without asking again for generated paths.

`check_env.sh` is the EC2 preflight (STS is opt-out with `--offline`); it does not
install tools or read keys. `start.sh` explicitly prepares a participant and
installs missing core tools before the timed course. Reuse a compatible Node
and npm AgentCore CLI from the user PATH; keep the private installer fallback.

The workshop Runtime model is `global.anthropic.claude-sonnet-4-6`. Recommend
`claude --permission-mode auto` with the organizer-verified coding model, and
Codex `-a on-request -c 'approvals_reviewer="auto_review"'` with workspace-write.
Check provider/model support for auto mode before class; do not force the
Runtime's model onto the coding assistant. Keep the deployment region separate from
the organizer-verified Bedrock caller region. `model_check.py --execute` is an
explicit real request and must never run inside doctor, build or ordinary tests.
`workshop_env.py configure` takes hidden key input only in a participant terminal.
The private `.env` lives outside Runtime codeLocation. Never source it or expose
its contents in prompts, logs, generated HTML or deployment archives. Basic
model calls use the short-term Bedrock key; AWS deployment and Runtime inbound
authentication use IAM. Publish only the owned SSM parameter ARN and its scoped
policy into CLI configuration. Key renewal and optional provider publication
are explicit actions; local doctor/build/check never invoke them. The advanced
Guide/Tools deployment keeps its own authentication contract.

Keep real failures (including the reported Seoul SCP deny) separate from local
test success. Do not change IAM/SCP to make a test pass.

| Command | Result |
|---|---|
| `npm run workshop:build` | Rebuild `workshop/site/` |
| `npm run workshop:check` | Python, CLI preparer, Node reader, content, and site-build checks |
| `npm run workshop:package` | Rebuild the site, then create the ZIP and `.sha256` under `workshop/.local/downloads/` |
| `npm run build` | Build the app and public reader, including `dist/workshop/downloads/` |

The workshop check writes `workshop/.local/checks.json` and stops at the first
failed step. `ATLAS_PYTHON` selects its interpreter and the public build's
packager; `workshop:package` invokes `python3` directly.

For reader UI changes, run `WORKSHOP_BROWSER_TEST=1 npm run workshop:check` with
Playwright and Chromium installed. Set `PLAYWRIGHT_MODULE` and
`CHROME_EXECUTABLE` when their locations differ from the test defaults. With
the flag absent, report the browser test as skipped.

## Packaging and operation boundaries

- Packaging accepts only a marked, generated site and allowlisted files.
  Do not add private state, symlinks, participant workspaces, or credentials.
- Package `workshop/site/` with `scripts/package_handbook.py`. The public
  builder packages before inserting `downloads/`; an already assembled
  `dist/workshop/` is not a valid substitute for clean packager input.
- After changing reader inputs, regenerate the tracked site and verify the
  handbook/public build as relevant. ZIPs and local check reports stay ignored.
- Preserve `/workshop/` PWA scope and its independent caches. Keep the app
  service worker's workshop exclusions aligned with reader changes.
- Local build/check/package commands do not publish the course or deploy a
  participant Runtime. Operational procedures are in [README.md](README.md)
  and [the deployment runbook](../docs/runbooks/deploy.md).
- Participant web/handbook access uses the App stack's actual default
  `*.cloudfront.net` HTTPS URL. Do not add ACM issuance, custom-domain/DNS steps,
  origin Host functions or TLS probes to the workshop. Keep production domain
  templates and deployed resources intact; adapt only participant copies.
- Preserve dated `DEPLOYMENT.md` and `VALIDATION.md` observations. New local
  checks do not establish a completed cloud rehearsal or live model call.
