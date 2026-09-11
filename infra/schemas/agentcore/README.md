# AgentCore CloudFormation schemas

These four schemas were read from the AWS CloudFormation public resource
registry in `ap-northeast-2` using `DescribeType` on 2026-09-11.

They make the checked-in AgentCore template reproducibly lintable with the
current HTTP runtime gateway target, Python 3.14 code configuration, and memory
strategy fields. They contain resource type definitions, not account credentials
or a deployed stack's configuration.

Use:

```sh
cfn-lint --registry-schemas infra/schemas/agentcore --template infra/agentcore.yaml
```

`npm run check` uses the same schemas for the complete infrastructure check.
Refresh the definitions deliberately from the registry when changing supported
AgentCore resource fields; do not suppress validation errors globally.
