#!/usr/bin/env node
/** Local workshop checks only. No deployment, model invocation or credential reads. */
import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.ATLAS_PYTHON || 'python3';
const siteTests = (await readdir(path.join(root, 'workshop/tests')))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `workshop/tests/${name}`);
const steps = [
  ['workshop-python', python, ['-m', 'unittest', 'discover', '-s', 'workshop/tests', '-p', 'test_*.py']],
  ['cli-preparer', python, ['-m', 'unittest', 'discover', '-s', 'workshop/cli', '-p', 'test_prepare.py']],
  ['site-tests', process.execPath, ['--test', ...siteTests]],
  ['course-content', python, ['workshop/scripts/check_content.py']],
  ['site-build', process.execPath, ['workshop/scripts/build.mjs']],
];
const report = { startedAt: new Date().toISOString(), steps: [], passed: false };
await mkdir(path.join(root, 'workshop/.local'), { recursive: true });
for (const [name, command, args] of steps) {
  console.log(`Workshop check: ${name}`);
  const code = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: {
      ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    } });
    child.once('error', () => resolve(1));
    child.once('exit', (status) => resolve(status ?? 1));
  });
  report.steps.push({ name, exitCode: code });
  if (code) break;
}
report.passed = report.steps.length === steps.length && report.steps.every((step) => step.exitCode === 0);
report.finishedAt = new Date().toISOString();
await writeFile(path.join(root, 'workshop/.local/checks.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
