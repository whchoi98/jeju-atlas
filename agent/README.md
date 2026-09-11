# Jeju Atlas agents

This directory owns the travel guide and MCP tools used by this project.
`guide/` and `tools/` are ordinary source directories in this repository. They
are not symlinks, submodules, or runtime imports from another project.

The initial source was copied from a reviewed commit and recorded in
`source-provenance.json`. Subsequent changes belong to Jeju Atlas.

## Independent resources

- CloudFormation stack: `Jeju3dAgentCore`
- Runtime names: `JejuAtlas_Guide`, `JejuAtlas_Tools`
- HTTP gateway: `jeju-atlas-tools`, with target `JejuAtlasTools`
- Memory: `JejuAtlas_Memory`, with facts, preferences, summaries and episodes
- Separate execution roles and runtime log groups
- Code archives, dependency archives and catalog:
  `jeju-3d-data-061525506239-ap-northeast-2`

The gateway uses an IAM-protected HTTP runtime target. The MCP client connects
to `/<target-name>/invocations`; it does not depend on an aggregated `/mcp`
endpoint. The guide uses the `jejuatlastools_` tool prefix.

The guide uses Seoul-routed Global CRIS Sol for short requests and Astra for
planning. No provider API credentials are bundled into either runtime. Official
visitor information is read from this project's collected S3 snapshot.

Existing memory records from the source project are not imported.

## Build and deploy

The dependency archives in `dependency-artifacts.json` are immutable, versioned
objects in this project's private bucket. They preserve the tested Python 3.14
runtime dependencies and let future builds run without the source project's
directory or AWS runtime.

From this repository's root:

```sh
python3 scripts/deploy-atlas-agent.py build
python3 scripts/deploy-atlas-agent.py publish
python3 scripts/deploy-atlas-agent.py plan
python3 scripts/deploy-atlas-agent.py apply
python3 scripts/deploy-atlas-agent.py status
```

Inspect the generated change set before applying it. The deployer accepts only
the nine declared resources in `Jeju3dAgentCore`, rejects ordinary deployments
that replace a runtime or memory, and refuses changed source/artifacts after
review. Completed stack outputs are written to
`.local/atlas-agent-outputs.json`; the web deployment consumes those owned
runtime and catalog identifiers.

AgentCore creates its runtime log groups during runtime creation. After the
stack completes, run `python3 scripts/deploy-atlas-agent.py configure-logs` to
verify the two owned runtime identifiers and apply 14-day retention. The log
groups are not also declared as CloudFormation resources, avoiding duplicate
creation.

The one-time `bootstrap-dependencies` command imports explicitly selected,
versioned code objects read-only. Once the independent manifest exists, it uses
that manifest and does not return to the source project.

The previous `scripts/deploy-guide-models.py` command is retired. Its CLI exits
before connecting to AWS.

## Data and privacy

The initial catalog copy preserves 6,724 records and their original evidence:
6,587 OpenStreetMap records and 137 sample seed records. Copying the database does
not verify seed coordinates, addresses, or visitor facilities.

The guide and tools disable GenAI content capture and sanitize telemetry before
export. Runtime logs retain 14 days. Memory events retain 30 days; memory and log
retention are separate. API keys remain with the separate data collection task.
