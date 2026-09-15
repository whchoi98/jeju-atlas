# Workshop CloudFront default domain plan

The user's added requirement replaces the advanced course's custom-domain
workflow. Preserve the completed core environment fixes and the immutable
`jeju-atlas-core-readiness.patch`. Participant source now lives at
`/home/ec2-user/my-project/jeju-atlas`.

Use the application template's existing default CloudFront certificate and
domain branches. Browser-to-CloudFront is HTTPS; the participant ALB origin uses
HTTP with the existing origin secret and CloudFront prefix-list restriction.
Production templates, settings and deployment scripts remain unchanged.

- [x] Add failing tests for default viewer settings, rejected custom inputs,
  owned stack URL lookup, invalid/missing outputs, removed certificate steps,
  and verifier arguments.
- [x] Add a standalone CloudFront helper shared by the lab runner and generated
  participant verification scripts. Obtain URLs with DescribeStacks, validating
  the stack identity, ownership tag, distribution ID and HTTPS output.
- [x] Scope participant preparation to default viewer settings. Remove domain
  configuration, certificate/probe steps and certificate cleanup from the lab.
- [x] Adapt only generated copies of deployment/verification scripts. Prevent
  automatic origin certificate attachment; verify the actual default domain,
  avoid an empty `https://` alias, and pass actual URL/image arguments.
- [x] Update chapters 08–09, 12–13, prompts, navigation, resources, facilitator,
  offline instructions and environment examples. Preserve production references
  as explicitly excluded inventory, not course prerequisites.
- [x] Run focused tests, workshop checks with browser coverage, build/package,
  and checks on generated participant assets.
- [x] Produce a CloudFront follow-up patch against the already delivered
  environment patch, verify it on a fresh copy, and report actual results.

No AWS resource mutation, production deployment, model invocation or Git push is
authorized. Local test fixtures and temporary Git snapshots are allowed.
