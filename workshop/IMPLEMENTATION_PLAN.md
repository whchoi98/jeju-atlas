# Jeju Atlas AgentCore CLI · Codex Workshop

> For agentic workers: implement the tasks below independently where their write sets do not overlap. Keep the production application and reference repositories unchanged.

**Goal:** Provide a chapter-based, executable Korean workshop that uses Codex and Amazon AgentCore CLI to deploy the existing Jeju Atlas assets, including the independent AgentCore implementation and the complete AWS application.

**Architecture:** Markdown is the source of truth; a local Node builder produces a static HTML course. Workshop automation creates a separate, namespaced copy of the existing assets under ignored local storage. Existing deployers run only inside that copy, with checked account, region and resource names. An AgentCore CLI introductory deployment is separate from the complete Atlas AgentCore stack.

**Tech Stack:** Node 24, Python, uv, AWS CLI, `@aws/agentcore` 0.28.1, Codex CLI, existing CloudFormation and container assets, Markdown/GFM and static HTML.

## Updated starting environment and distribution

The workshop now starts on an EC2 instance with Codex already installed. `init-ec2`
uses IMDSv2 and STS to bind the lab to that instance's account, region and primary VPC;
Name-tag/default-VPC fallback is not used. A local PC reads the complete HTML handbook
and copies commands/cards into the EC2 session. The generated site bundles prompt cards,
fonts and assets and can be exported as a whitelist-checked ZIP. Application and workshop
colors follow the AWS navy/orange palette with accessible interactive colors.
Kiro CLI and Claude Code are supported alternative development environments on the same EC2.
Prepared app and CLI projects include shared AGENTS, Claude import guidance, and Kiro steering.
The selected-assistant doctor check does not require the other assistant binaries.

## Constraints and delivery contract

- Write workshop material and helpers under `workshop/`. Root changes are limited to navigation, ignore rules and workshop npm commands.
- Do not modify `agentcore-cli`, its worktrees, existing AWS stacks, VPCs, NAT gateways, certificates or production data.
- The executable region is `ap-northeast-2`; global CloudFront/WAF/Lambda@Edge resources remain in `us-east-1`.
- Use an existing VPC with public/private subnets and NAT. Missing shared networking is a prerequisite failure, not permission to create or replace it.
- A participant identifier, AWS account and optional profile define an isolated lab. Never copy `.local`, credentials or production deployment outputs into a participant workspace.
- Preserve all application features: real terrain, imagery, MapLibre, catalog evidence, Olle tours, Valhalla routes/elevation, Korean/English UI, PWA, Markdown AI output, tool status, suggested questions and NanumSquare.
- Preserve Global CRIS Sol/Astra configuration for the Atlas guide. Codex authentication is separate from the deployed Bedrock model configuration.
- Deploy both a CLI-managed introductory Runtime and the actual Atlas Guide/Tools/Gateway/Memory stack. Clearly distinguish their ownership and cleanup.
- Full application deployment includes ECR, ALB/SG, private ECS, CloudFront/WAF, static/media S3 and OAC, DynamoDB quota, Secrets Manager/SSM, data Scheduler, CloudWatch/SNS, origin ACM/Lambda@Edge and terrain caching.
- Full custom-domain HTTPS requires a domain and certificates the participant can use. Do not invent domain ownership, certificate issuance or model access.
- Bootstrap dependencies from the committed application lock files; do not require private production dependency objects for a fresh participant installation.
- Build a catalog from the shipped sample seeds, with an optional bounded OSM import. Keep sample provenance explicit and allow official enrichment to preserve evidence.
- Never put provider API keys in source, HTML, command examples or JSON config. Secret input belongs in a scoped parameter/secret with no echoed value.
- Include diagnosis, expected observations, Codex prompt cards, checkpoints and cleanup in the chapters. Report local validation separately from any live AWS deployment.

## Task 1 — Executable lab isolation and asset preparation

Files: `workshop/scripts/lab.py`, supporting Python modules under `workshop/scripts/`, `workshop/config.example.json`, `workshop/tests/`.

- [x] Define validated configuration, derived names, lab state and workspace paths.
- [x] Implement `init`, `doctor`, `prepare` and a guarded command runner around the existing deployers.
- [x] Implement dependency archive and sample/OSM catalog preparation without the reference repository.
- [x] Verify account/name boundaries, source isolation, malformed configurations and data provenance with offline tests.

## Task 2 — AgentCore CLI lifecycle

Files: `workshop/cli/`, `workshop/chapters/04-agentcore-cli.md`, `workshop/prompts/04-agentcore-cli.md`.

- [x] Verify installed CLI syntax and the official schema.
- [x] Provide a reproducible isolated introductory Runtime project and commands for validation, development, deployment, invocation, logs and removal.
- [x] State the distinction between the CLI Runtime and the Atlas CloudFormation Runtime stack.
- [x] Keep the tutorial entry point free of provider credentials and unintended model calls.

## Task 3 — Complete chapter and resource coverage

Files: `workshop/chapters/`, `workshop/prompts/`, `workshop/reference/`.

- [x] Cover environment, AWS account/network, Codex workflow, registry/data, AgentCore, routes, application, HTTPS/edge, data enrichment, observability, validation and cleanup.
- [x] Map every existing infrastructure resource and application technology to a chapter and verification step.
- [x] Give commands that match the implemented helper interfaces and actual existing deployers.
- [x] Include facilitator preparation, multiple participants, model/data permissions and retained-resource cleanup.

## Task 4 — Static HTML course

Files: `workshop/scripts/build.mjs`, `workshop/assets/`, `workshop/site/`, `workshop/README.md`.

- [x] Generate HTML from Markdown using the existing Markdown dependencies.
- [x] Provide chapter navigation, code copy, local progress, print styling, responsive layout and NanumSquare.
- [x] Keep the generated site independent of `.local` files and executable Python state.
- [x] Verify HTML links, chapter coverage and browser interactions locally.

## Task 5 — Final validation and integration

- [x] Run workshop tests, render/lint the prepared infrastructure and validate the CLI project without deployment.
- [x] Build application/Agent artifacts where the local toolchain permits and record actual outcomes.
- [x] Run the relevant existing checks and secret scan; keep synthetic fixtures narrowly scoped.
- [x] Record the final tested commands and the distinction between local checks and real account deployment.

## Recorded scope of validation

All checked implementation tasks refer to local preparation, tests, packaging, CLI validation/synthesis, and static HTML. No new AWS stacks, model calls, secret writes, or cloud deletion were executed during workshop creation. See `VALIDATION.md`.
