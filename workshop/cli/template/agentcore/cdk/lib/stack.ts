import {
  AgentCoreApplication,
  type AgentCoreProjectSpec,
  type AwsDeploymentTarget,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Ownership {
  module: string;
  projectName: string;
  accountId: string;
  region: string;
  target: string;
  runtime: string;
  stackName: string;
  cliVersion: string;
}

export function assertWorkshopBoundary(
  spec: AgentCoreProjectSpec,
  targets: AwsDeploymentTarget[],
  owner: Ownership,
  projectRoot: string,
): void {
  if (!/^[A-Za-z0-9_./-]+$/.test(projectRoot)) {
    throw new Error('The pinned ZIP packager requires an ASCII workspace path without spaces/metacharacters.');
  }
  if (
    owner.module !== 'agentcore-cli-intro' ||
    !/^AtlasCli[A-Za-z0-9]{1,15}$/.test(owner.projectName) ||
    /prod|shared|live|reference|default/i.test(owner.projectName.slice('AtlasCli'.length)) ||
    !/^[0-9]{12}$/.test(owner.accountId) || owner.accountId === '000000000000' ||
    owner.region !== 'ap-northeast-2' || owner.target !== 'default' ||
    owner.runtime !== 'Warmup' || owner.cliVersion !== '0.28.1' ||
    owner.stackName !== `AgentCore-${owner.projectName}-default` ||
    spec.name !== owner.projectName
  ) {
    throw new Error('Workshop ownership/name boundary changed. Create a fresh workshop project.');
  }
  if (
    targets.length !== 1 || targets[0]?.name !== owner.target ||
    targets[0]?.account !== owner.accountId || targets[0]?.region !== owner.region
  ) {
    throw new Error('Only the original workshop account and ap-northeast-2 target are permitted.');
  }
  for (const [key, value] of Object.entries(spec)) {
    if (key !== 'runtimes' && Array.isArray(value) && value.length > 0) {
      throw new Error(`The CLI warmup cannot provision ${key}. Use the separate Atlas workshop.`);
    }
  }
  const runtimes = spec.runtimes ?? [];
  // Zero is allowed so `remove agent` followed by `deploy` can remove the runtime.
  if (runtimes.length > 1) throw new Error('Only one Warmup runtime is allowed.');
  for (const runtime of runtimes) {
    if (
      runtime.name !== 'Warmup' || runtime.build !== 'CodeZip' ||
      runtime.codeLocation !== 'app/warmup' || runtime.entrypoint !== 'main.py' ||
      runtime.runtimeVersion !== 'PYTHON_3_14' || runtime.protocol !== 'HTTP' ||
      runtime.networkMode !== 'PUBLIC' || runtime.authorizerType !== 'AWS_IAM' ||
      runtime.instrumentation?.enableOtel !== false ||
      runtime.executionRoleArn || runtime.additionalPolicies?.length ||
      runtime.connections?.length || Object.keys(runtime.endpoints ?? {}).length ||
      runtime.filesystemConfigurations?.length ||
      runtime.lifecycleConfiguration?.idleRuntimeSessionTimeout !== 300 ||
      runtime.lifecycleConfiguration?.maxLifetime !== 600
    ) {
      throw new Error('The deterministic CodeZip/HTTP runtime boundary changed.');
    }
    const expectedEnv: Record<string, string> = {
      OTEL_SDK_DISABLED: 'true',
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    };
    const values = runtime.envVars ?? [];
    if (
      values.length !== Object.keys(expectedEnv).length ||
      new Set(values.map(v => v.name)).size !== values.length ||
      values.some(v => expectedEnv[v.name] !== v.value)
    ) {
      throw new Error('Prompt-content telemetry must stay disabled; no extra environment variables.');
    }
    const codeRoot = path.join(projectRoot, 'app', 'warmup');
    const entrypoint = path.join(codeRoot, 'main.py');
    if (fs.realpathSync(codeRoot) !== codeRoot || fs.realpathSync(entrypoint) !== entrypoint) {
      throw new Error('Runtime source must stay inside this generated workspace without symlinks.');
    }
  }
}

interface WorkshopStackProps extends StackProps {
  spec: AgentCoreProjectSpec;
  owner: Ownership;
}

export class WorkshopStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: WorkshopStackProps) {
    super(scope, id, props);
    const { spec, owner } = props;
    const roles: iam.Role[] = [];
    const runtimes = (spec.runtimes ?? []).map(runtime => {
      const runtimePrefix = `${owner.projectName}_${runtime.name}`;
      const logGroupArn =
        `arn:aws:logs:${owner.region}:${owner.accountId}:log-group:` +
        `/aws/bedrock-agentcore/runtimes/${runtimePrefix}-*`;
      const role = new iam.Role(this, 'WarmupExecutionRole', {
        description: 'Owned deterministic warmup Runtime logs only; no model permissions',
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': owner.accountId },
            ArnLike: {
              'aws:SourceArn':
                `arn:aws:bedrock-agentcore:${owner.region}:${owner.accountId}:runtime/${runtimePrefix}-*`,
            },
          },
        }),
      });
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:DescribeLogGroups'],
        // This discovery action does not support a resource ARN.
        resources: ['*'],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: [logGroupArn],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroupArn}:log-stream:*`],
      }));
      roles.push(role);
      // Supported executionRoleArn avoids the L3's default model/X-Ray/broad-log grants.
      // The role still belongs to this CloudFormation stack and is removed with it.
      return { ...runtime, executionRoleArn: role.roleArn };
    });

    this.application = new AgentCoreApplication(this, 'Application', {
      spec: { ...spec, runtimes },
    });
    for (const environment of this.application.environments.values()) {
      // An imported role reference alone does not depend on its separate IAM policy.
      for (const role of roles) environment.runtime.node.addDependency(role);
    }
    new CfnOutput(this, 'StackNameOutput', { value: this.stackName });
  }
}
