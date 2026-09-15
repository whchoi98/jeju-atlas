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
- The core course is chapters 00–04, 110 minutes plus a 10-minute buffer;
  chapters 05–13 are optional. Keep duration and prerequisites consistent
  across the course manifest, reader, and READMEs when changing the curriculum.
- Keep shell commands separate from prompts for coding assistants. Preserve
  the terminal/prompt rendering and copy behavior tested by the reader suite.

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

The workshop model is `global.anthropic.claude-sonnet-4-6`; Claude Code examples
use `claude --model claude-sonnet-4-6`. Keep the deployment region separate from
the organizer-verified Bedrock caller region. `model_check.py --execute` is an
explicit real request and must never run inside doctor, build or ordinary tests.
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
