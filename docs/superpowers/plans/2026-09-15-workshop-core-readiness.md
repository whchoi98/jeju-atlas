# Workshop core readiness implementation plan

**Goal:** Let an Amazon Linux 2023 ARM64 participant prepare and resume the
00–04 course without replacing system tools or another project's settings.

**Scope:** The user's 2026-09-15 EC2 observations and the preceding read-only
audit authorize these changes. Keep the existing advanced lab runner and
production deployment paths. Do not deploy, invoke models, or push Git.

**Design:** A Python-standard-library core helper validates source and prepares
an owned participant directory with a Bash activation file. Its doctor checks
only the chosen coding CLI and core dependencies, without AWS access. An
explicit installer uses the repository's ignored toolchain directory for Node,
AgentCore, managed Python and helper dependencies. Transfer the current changes
as a patch against the publicly accessible base commit, separately from the
reading-only handbook ZIP.

**Constraints**

- Source base: `bead20a933aba04a850b1c14bee19efae4e54756`.
- Node 24.18.1 or later within major 24; installation pins `.nvmrc`.
- Runtime Python 3.14; installation pins 3.14.3.
- npm AgentCore CLI 0.28.1, with private CLI config and telemetry disabled.
- Reuse installed uv, AWS CLI and the selected coding CLI. Do not change login
  files, shell startup files, system Python/Node, AWS resources or global npm.
- Preserve existing participant projects and settings; reject foreign folders,
  symlinked output paths, mismatched ownership and unsafe paths.
- Read-only doctor must report missing dependencies together, and must not
  install software, contact AWS, or invoke an assistant/model.

## 1. Core preparation and diagnosis

- [x] Add `workshop/tests/test_core.py` covering missing source, the measured
  Node 20 / missing Python and AgentCore failures, selected-assistant-only
  success, ownership protection, bad CLI config and fresh Bash restoration.
- [x] Run `python3 -B -m unittest discover -s workshop/tests -p test_core.py -v`;
  confirm failures describe the absent helper.
- [x] Add `workshop/scripts/core.py` with `prepare`, `doctor` and activation
  validation. Tests use temporary source fixtures and external-command doubles.
- [x] Require an explicit project check before the chapter 04 dry run, including
  saved EC2 account, deployment target and Runtime source/data paths.

## 2. Private toolchain installation

- [x] Add `workshop/scripts/install_core.sh` and
  `workshop/requirements-core.txt`. Verify downloaded Node archive checksums.
- [x] Test installation rejection for wrong source/foreign directories and
  failed downloads, and preserve completed owned installations on retries.
- [x] Check official download availability and exercise the available local
  toolchain without changing system paths or credentials.

## 3. Course and transfer instructions

- [x] Align chapters 00–04, their prompt cards, workshop README,
  ai-cli-environments, offline-start and facilitator.
- [x] Correct the prompt's `app/JejuGuide/data/jeju_pois.json` path.
- [x] Document separate Bash terminals, activation and restarting Claude in the
  actual participant project. Keep environment exports out of AI prompts.
- [x] Record the observed environment, core/advanced diagnostic distinction,
  source transfer before push, and installation commands.
- [x] Keep Korean/English root README aligned; update Unreleased and indexes.

## 4. Verification and delivery

- [x] Run focused success/failure tests, workshop check, build and package.
- [x] Exercise browser checks if the existing Playwright environment is usable.
- [x] Verify a fresh clone plus the generated patch contains the new helpers,
  source data and corrected documentation. Export SHA-256 with the patch.
- [x] Report actual command results and the participant/AWS/model checks that
  remain separate. Leave changes reviewable and unpushed.
