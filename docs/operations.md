# Jeju Atlas edge protection and operations

These independent CloudFormation stacks consume outputs from `Jeju3dApp`.
They create no VPC, compute, application role, catalog bucket, or subscription.
The application stack and deployment script remain owned by the parent integration.

## Implementation and validation plan

1. Test the security and integration contracts: API-only rate limiting, disabled
   request sampling, an explicit safe access-log field list, bounded retention,
   scoped publishing permissions, correct metric dimensions, and missing-data behavior.
2. Build `infra/edge.yaml` for `Jeju3dEdge` in `us-east-1`, then
   `infra/operations.yaml` for `Jeju3dOperations` in `ap-northeast-2`.
3. Run the structural tests and `cfn-lint`; review the rendered dashboard JSON and
   resource dependencies. No AWS deployment is part of this implementation.

## Application output contract

The parent should add these outputs to `infra/application.yaml`:

| Output | CloudFormation value |
| --- | --- |
| `DistributionArn` | `!Sub 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}'` |
| `AlbFullName` | `!GetAtt LoadBalancer.LoadBalancerFullName` |
| `TargetGroupFullName` | `!GetAtt TargetGroup.TargetGroupFullName` |

Reuse the existing `ClusterName`, `ServiceName`, `LogGroupName`, and
`GuideQuotaTableName` outputs. Full names are metric dimension values such as
`app/jeju-3d-alb/0123456789abcdef` and
`targetgroup/jeju-3d-tasks/0123456789abcdef`; they are not ARNs or display names.

## Edge stack

Deploy `Jeju3dEdge` in `us-east-1`, in the distribution's account.

| Parameter | Required/default |
| --- | --- |
| `DistributionArn` | Required; existing, same-account distribution ARN |
| `ApiRequestsPer5Minutes` | 2,000 requests per source IP per 300 seconds |
| `LogRetentionDays` | 14; allowed values 14 or 30 |

Outputs: `WebAclArn`, `EdgeAccessLogGroupName`, `EdgeDeliveryId`,
`EdgeNotificationTopicArn`, and `EdgeDashboardName`.

Pass `WebAclArn` back to the application stack and set
`DistributionConfig.WebACLId` to that ARN. CloudFront WAF association belongs in
the distribution configuration, not `AWS::WAFv2::WebACLAssociation`.
Use explicit parameters between regions; CloudFormation exports cannot be
imported across regions. The edge template does not replace or own the existing
distribution.

The rate rule covers `/api/` after URL decoding and path normalization. Terrain
tile paths are outside that rule. AWS CommonRuleSet applies normally, except
`SizeRestrictions_BODY` is counted: its 8 KB managed threshold must not reject
requests allowed by the application's existing 16 KB parser. WAF request
sampling and raw WAF logging are disabled.

Standard logging **V2** uses a delivery source, destination, and delivery for
the distribution ARN. Its JSON records contain only:

```
date time sc-status sc-bytes time-taken time-to-first-byte x-edge-location
x-edge-result-type x-edge-response-result-type x-edge-detailed-result-type
cache-behavior-path-pattern
```

`cache-behavior-path-pattern` is the configured route pattern, such as `/api/*`,
not the requested URI. No cookie, IP, user agent, request ID, host, referrer,
query, URI, arbitrary header, or request body is selected. Do not remove
`RecordFields`: omission would restore the service's default field set.
The destination policy grants only the AWS log-delivery service access to this
new log group's streams, with account and source-region conditions. The log
group is retained on stack deletion/replacement; its 14/30-day event retention
continues to apply.

The deployment identity needs the documented CloudWatch Logs V2 delivery
configuration permissions and
`cloudfront:AllowVendedLogDeliveryForResource` on the existing distribution,
plus the normal CloudFormation/WAF/SNS/CloudWatch resource permissions.
Application execution/task roles need none of these permissions. No custom
resource, Lambda, or subscription is used to configure delivery.

CloudFront supports one delivery source per distribution. Check for an existing
V2 source before creating this stack; existing logging needs a reviewed import
or integration rather than another source. Logging configuration changes can
take up to 12 hours to propagate. The selected fields remain explicit during
that process.

CloudFront metric queries include `Region=Global`. CloudFront-scoped WAF metric
queries omit that dimension; both are read from `us-east-1`.

## Operations stack

Deploy `Jeju3dOperations` in `ap-northeast-2`.

| Parameter | Required/default |
| --- | --- |
| `ClusterName` | Required app output |
| `ServiceName` | Required app output |
| `AlbFullName` | Required app output |
| `TargetGroupFullName` | Required app output |
| `LogGroupName` | Required app output; existing application log group |
| `GuideQuotaTableName` | Required app output |
| `MinimumHealthyTargets` | 2; cannot be lowered below 2 |
| `TargetP95Seconds` | 2 seconds |
| `GuideFailureThreshold` | 3 failures per five minutes |

Outputs: `NotificationTopicArn`, `OperationsDashboardName`, and
`ApplicationMetricNamespace`.

The application must run at least two healthy tasks before this stack is
expected to be green. `HealthyHostCount` uses both ALB and target-group full
names, the `Minimum` statistic, and missing data as breaching. Three consecutive
one-minute periods below the minimum alarm.

ALB-generated and target-generated 5xx alarms each use 10 failures per five
minutes. Target latency is p95 `TargetResponseTime`, the interval until target
response headers arrive. A normally streamed 90-second guide answer does not
become a 90-second sample. This is neither guide completion latency nor a
route-specific non-streaming API SLO; ALB's native metric cannot exclude a URI.
Guide failures have their own application-log metric. CPU and memory use the
standard ECS service metrics, without requiring Container Insights.

The quota-table alarm uses table-level `WriteThrottleEvents`. Normal
`ConditionalCheckFailedException` responses when the daily quota is exhausted
are not write throttling and are not treated as operational failures.

### Safe catalog heartbeat required from the parent

The current application already logs `guide_stream_error` and `guide_rejected`.
The guide failure filter counts stream errors and rejected requests with
status >= 500. It excludes user cancellations and expected 4xx/quota denials.

Catalog status currently needs an emitter in the parent-owned application.
Emit this numeric record once per minute from each task, including immediately
after initialization:

```json
{"event":"catalog_status","stale":0}
```

Use `stale: 1` for a stale or unavailable snapshot and `0` for a current usable
snapshot. Keep the existing ten-minute refresh policy; the heartbeat should
reflect its real result. Do not include paths, URLs, cookies, actors, questions,
or answers in this record. The filter extracts only the numeric `stale` field,
without metric dimensions or a default zero. Missing heartbeats therefore
cannot be hidden by unrelated application logs. A stale value or missing data
in two of three one-minute periods alarms.

Install this emitter before enabling operations; otherwise the catalog alarm
will intentionally indicate missing telemetry. No template can infer an
in-process SQLite snapshot's freshness from ECS CPU or HTTP status alone.

## Notifications and deployment order

Each region has its own SNS alarm topic with an account/stack-scoped CloudWatch
publishing policy. No email, endpoint, or subscription is created. Alarms and
dashboards are created with the stacks, but no person is notified until the owner adds a
subscriber separately. SNS messages contain operational alarm metadata only.

1. Add the output contract, minimum two-task capacity, and safe catalog heartbeat
   in the parent-owned app change.
2. Read the deployed app outputs; prepare/review the `Jeju3dEdge` change set using
   its existing distribution ARN.
3. After edge creation, pass `WebAclArn` into the application stack's distribution
   configuration and review/apply that app change separately.
4. Prepare/review `Jeju3dOperations` with the app's regional outputs.
5. Verify delivery status and the selected log fields, WAF association, both
   healthy targets, catalog heartbeat data, alarm dimensions, and dashboards.
   Check that normal terrain tile rendering does not match the API rate rule.

WAF association and log delivery are separate: creating the delivery attaches
V2 access logging, while the returned web ACL has no effect until the parent
associates it with the distribution.

## Local verification

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'operations_infra_test.py' -v
cfn-lint infra/edge.yaml infra/operations.yaml
```

These checks do not call AWS or deploy resources. IAM authorization, account
quotas, delivery activation, log ingestion, and alarm publication still require
the parent's deployment verification.

The templates were checked with `cfn-lint 1.45.0`. The locally available
CloudFormation provider schemas confirm `DeliverySource`/`DeliveryDestination`
use `Name` as their primary identifier, `Delivery` uses `DeliveryId`, and
`LogGroup.ResourcePolicyDocument` accepts a JSON object.

## Sources checked on 2026-09-10

Reference implementation at `/home/ec2-user/my-project/agentcore-cli-main`,
commit `9e42038`: `product/infra/lib/ohmyjeju-waf-stack.ts` and
`product/infra/lib/service-alarms.ts`. This implementation deliberately removes
request sampling, narrows the rate rule to the API, and creates no subscribers.

Official CloudFormation and service references:

- `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html`
- `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-deliverysource.html`
- `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-deliverydestination.html`
- `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-delivery.html`
- `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html`
- `https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AWS-logs-infrastructure-V2-CloudWatchLogs.html`
- `https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-webacl.html`
- `https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html`
- `https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html`
- `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html`
- `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html`
- `https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazoncloudfront.html`
