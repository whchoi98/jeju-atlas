#!/usr/bin/env node
// Same public ConfigIO + AgentCoreApplication entry points as CLI 0.28.1's scaffold.
import { ConfigIO } from '@aws/agentcore-cdk';
import { App } from 'aws-cdk-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertWorkshopBoundary, WorkshopStack, type Ownership } from '../lib/stack';

async function main(): Promise<void> {
  // The CLI invokes the CDK app with agentcore/cdk as its working directory.
  const configRoot = path.resolve(process.cwd(), '..');
  const projectRoot = path.resolve(configRoot, '..');
  const owner: Ownership = JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.atlas-cli-workshop.json'), 'utf8'),
  );
  const configIO = new ConfigIO({ baseDir: configRoot });
  const spec = await configIO.readProjectSpec();
  const targets = await configIO.readAWSDeploymentTargets();
  assertWorkshopBoundary(spec, targets, owner, projectRoot);

  const app = new App({ analyticsReporting: false });
  new WorkshopStack(app, owner.stackName, {
    spec,
    owner,
    env: { account: owner.accountId, region: owner.region },
    description: 'Independent AgentCore CLI lifecycle workshop; no model calls',
    tags: {
      'workshop:module': 'agentcore-cli-intro',
      'workshop:project': owner.projectName,
      'agentcore:project-name': owner.projectName,
      'agentcore:target-name': owner.target,
    },
  });
  app.synth();
}

main().catch((error: unknown) => {
  console.error('Workshop synthesis failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
