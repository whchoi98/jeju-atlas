#!/usr/bin/env node
/** Repeatable local/CI release checks. No AWS mutation or model invocation. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.versions.node.split('.').map(Number);
if (version[0] !== 24 || version[1] < 18 || (version[1] === 18 && version[2] < 1)) {
  throw new Error('Release checks require Node 24.18.1 or later in the Node 24 line.');
}

const tests = (await readdir(path.join(root, 'tests'))).filter((name) => name.endsWith('.test.mjs')).sort();
const templates = (await readdir(path.join(root, 'infra'))).filter((name) => name.endsWith('.yaml')).sort();
const steps = [
  ['node-tests', process.execPath, ['--test', '--test-concurrency=1', ...tests.map((name) => `tests/${name}`)]],
  ['deployment-tests', process.env.ATLAS_PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', '*_test.py']],
  ['cloudformation', 'cfn-lint', templates.map((name) => `infra/${name}`)],
  ['dependencies', 'npm', ['audit', '--audit-level=high']],
  ['production-build', 'npm', ['run', 'build']],
];

async function sourceDigest() {
  const digest = createHash('sha256');
  const files = ['package.json', 'package-lock.json', 'Dockerfile', '.dockerignore', 'index.html', 'vite.config.ts', 'tsconfig.json'];
  async function collect(directory) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  for (const directory of ['src', 'server', 'public', 'infra', 'tests', 'scripts']) await collect(directory);
  for (const name of files.sort()) {
    // Python imports create caches while checks run. They are not release input.
    if (name.includes('/__pycache__/') || name.endsWith('.pyc')) continue;
    digest.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
  }
  return digest.digest('hex');
}

const initialDigest = await sourceDigest();
const report = {
  startedAt: new Date().toISOString(),
  node: process.versions.node,
  sourceDigest: initialDigest,
  steps: [],
  passed: false,
};
await mkdir(path.join(root, '.local'), { recursive: true });
for (const [name, command, args] of steps) {
  const started = Date.now();
  console.log(`Running ${name}`);
  const code = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` },
    });
    child.once('error', (error) => {
      console.error(`${name}: ${error.code || 'could not start'}`);
      resolve(1);
    });
    child.once('exit', (status) => resolve(status ?? 1));
  });
  report.steps.push({ name, exitCode: code, elapsedMs: Date.now() - started });
  if (code !== 0) break;
}
report.sourceUnchanged = (await sourceDigest()) === initialDigest;
report.passed = report.steps.length === steps.length
  && report.steps.every((step) => step.exitCode === 0) && report.sourceUnchanged;
report.finishedAt = new Date().toISOString();
await writeFile(path.join(root, '.local/checks.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
