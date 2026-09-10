# Bounded load and recovery checks

Run from `jeju-3d` after the new release. Requires Python 3, `requests`, and
`boto3` for recovery. Only fixture tests were executed during implementation.
No live load, model invocation, or task replacement was performed.

Both scripts require `--output` and write only that JSON report, creating its
parent directory if needed. Python bytecode writes are disabled. Response
bodies, cookies, CSRF proofs, prompts, and AWS error messages are never logged.
Fixed error codes, release IDs, aggregate timings, and task ARNs are reported.

## Load

```bash
python3 scripts/load-check.py https://YOUR-APP-DOMAIN \
  --output .local/load-check.json
```

Default: one `/healthz` preflight, six warmup GETs, then **50 independent HTTP
sessions x 10 GETs = 500 measured requests**. Each session makes five fixed
public catalog searches interleaved with five `/api/config` requests.
Searches use `한라산`, `협재`, `성산`, `가족`, and `카페`, each with `limit=12`.
Warmup covers the five searches and config once; it is reported separately and
excluded from measurements. `--no-warmup` skips it. `--sessions` accepts 1..100.

Reports include p50/p95/max, error/status counts, RPS, and per-route statistics.
Percentiles use nearest rank; RPS uses wall-clock measurement time. Schema
failures and HTTP errors count as errors. Health must identify `jeju-3d`;
config must match its release and contain real feature/guide settings.
Search results must be valid and nonempty. Placeholder 200 responses fail.

The temporary goal is **zero measured errors and p95 <= 1,000 ms from a Seoul
test host**. Location is an operator-supplied testing assumption, not detected
by the script. This is an HTTP test, not browser FPS or model latency.

## Recovery

```bash
# Read-only observation: no StopTask.
python3 scripts/recovery-check.py https://YOUR-APP-DOMAIN \
  --output .local/recovery-observe.json

# Explicitly request ONE task replacement after all safety checks.
python3 scripts/recovery-check.py https://YOUR-APP-DOMAIN \
  --replace-one --output .local/recovery-replace.json
```

The script reads deployed `Jeju3dApp` outputs in account `061525506239`,
region `ap-northeast-2`. The URL must match `ApplicationUrl` or `CloudFrontUrl`,
so the custom domain and default CloudFront domain are both supported.
`--outputs .local/app-outputs.json` optionally compares a saved copy against
the deployed outputs; the file never overrides deployed resource identities.

Before replacement, including a fresh check immediately before the action:

- Require the correct account/region, stable app stack, and exact owned
  `jeju-3d` cluster/service, task definition, ALB and target group.
- Confirm CloudFormation resource identities, ECS ownership tags, task groups,
  private task IPs and their matching ALB targets.
- Require at least two running healthy tasks with healthy targets across two
  availability zones. Require zero pending tasks and one completed primary
  deployment, with running count equal to desired count.
- Require valid public health/config responses before stopping anything.

One eligible task is selected, favoring an AZ with more eligible tasks.
HTTP observation starts before the final preflight and stop, so a slow stop
acknowledgment does not hide the fault window. An expired observation window
refuses the stop.
`StopTask` has one SDK attempt, with no automatic or application retry.
Uncertain results and interruptions retain the attempted task ARN and unknown
outcome. The script never selects another task or performs a rollback stop.
The remaining guard-to-action race cannot be locked atomically by ECS;
run without concurrent deployment or manual task operations.

Health/config GET pairs run on a nominal one-second cadence independently of
AWS health polling, with progress approximately every 30 seconds.
`--duration` defaults to 300 and accepts 1..300 seconds. Slow HTTP responses
reduce cadence instead of queuing unbounded probes. HTTP connect/read timeout
is at most 15 seconds, with an elapsed-time check while reading and a 1 MiB
JSON body cap. This is not an OS-wide DNS deadline. The monitoring window is
bounded; preflight, in-flight requests and final checks add bounded network
wait time. AWS clients use three-second connect/five-second read timeouts.

Read-only mode can observe degraded target health. Replacement mode stops
early only after a new healthy task appears, the selected task leaves the
running-task list, and the service is stable again. Final public probes and service
inspection are mandatory. Passing requires zero HTTP errors and at least two
owned healthy targets across AZs at the end; replacement also requires a new
task ARN. A failed HTTP observer cannot pass using only preflight results.

Both tools return 0 on a passing report and 1 on failure/refusal. Inspect
`stop.outcome` independently: an unknown stop acknowledgment is not retried.
The read-only AWS calls require STS identity, CloudFormation describe,
ECS service/task/tag describe/list, and ELB target-group/health permissions.
Only `--replace-one` additionally needs `ecs:StopTask` for the owned task.

## Offline tests

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tests -p 'load_recovery_test.py' -v
```

Fixtures exercise real workload/report logic and safety branches: 500 GETs,
warmup exclusion, placeholder rejection, wrong account/region, one target,
wrong ownership/AZ, active deployment, uncertain/interrupted stops, monitor
failure, and SDK retry configuration. No AWS or model calls are made.

SDK/API references checked during implementation:
`https://boto3.amazonaws.com/v1/documentation/api/latest/guide/retries.html`
and `https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_StopTask.html`.
