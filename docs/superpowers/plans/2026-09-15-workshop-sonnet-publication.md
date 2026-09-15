# Sonnet 4.6 and workshop publication plan

Continue the completed environment and CloudFront default-domain work.
The editing session's model and production Guide model stay unchanged.

The participant reported a real AWS CLI Converse failure for
`global.anthropic.claude-sonnet-4-6` in `ap-northeast-2`: AccessDeniedException,
with an explicit SCP deny for `bedrock:InvokeModel`. This is a failed real
invocation attempt, never a passed check. Do not retry other regions without
an organizer-verified caller region.

- [ ] Add separate single-attempt real-model check and offline failure-path
  tests. Require explicit execution and caller region; redact identities from
  reports and keep them in ignored local storage.
- [ ] Add a pinned Sonnet Runtime configuration with explicit Bedrock caller
  region, independent of the deployment target. Preserve existing custom files
  and assistant authentication. Do not modify IAM/SCP.
- [ ] Pin Claude Code launch examples to `claude-sonnet-4-6`; align active
  chapters, prompts, facilitator guidance and the model verification record.
- [ ] Preserve CloudFront default-domain behavior and rerun relevant checks,
  workshop check/build/package and participant-copy validation.
- [ ] Commit and push the reviewed source changes, excluding local state and
  actual participant identities. Provide safe source-sync commands.
- [ ] Publish only the existing workshop static content through the documented
  existing-service deployment flow, with a reviewed content-only image based on
  the live image. Do not create application infrastructure or change production
  domains, runtime models or security settings.
- [ ] Verify published workshop content and record the exact results separately
  from the failed participant model call.

The live CloudFront routing inspection confirmed that `/workshop/` currently
uses the default ALB origin. The existing runbook therefore requires an image
rollout. Publishing must preserve all non-workshop image content and deployed
settings, rather than rebuilding unrelated application components.
