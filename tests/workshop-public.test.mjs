import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('app release includes the complete public workshop and a repeatable PC handout', async (t) => {
  const script = new URL('../scripts/build-workshop-public.mjs', import.meta.url);
  const present = await readFile(script, 'utf8').catch(() => '');
  assert.match(present, /export async function buildWorkshopPublic/, 'The application release needs a public workshop build');
  const { buildWorkshopPublic } = await import(script);
  const appRoot = await mkdtemp(join(tmpdir(), 'atlas-public-workshop-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  await writeFile(join(appRoot, 'index.html'), '<title>map shell</title>');
  const first = await buildWorkshopPublic({ appRoot });
  const workshop = join(appRoot, 'workshop');
  const course = JSON.parse(await readFile(new URL('../workshop/course.json', import.meta.url), 'utf8'));
  const marker = JSON.parse(await readFile(join(workshop, '.workshop-site.json'), 'utf8'));
  assert.equal(marker.pages.length, 1 + course.chapters.length + course.references.length);
  const overview = await readFile(join(workshop, 'index.html'), 'utf8');
  assert.match(overview, /읽기용 교재 ZIP에는 <code>core\.py<\/code> 등 실행 스크립트가 없습니다/);
  assert.match(overview, /href="reference\/offline-start\.html">EC2 실행 소스 준비 방법/);
  assert.match(overview, /href="reference\/preconfiguration\.html">사전 구성: Node, Python과 AgentCore CLI 설치/);
  assert.match(overview, /href="reference\/keys-and-integrations\.html">Bedrock 단기키를 \.env에 입력하기/);
  for (const page of marker.pages) assert.match(await readFile(join(workshop, page), 'utf8'), /<!doctype html>/i);
  const zipPath = join(workshop, 'downloads/jeju-atlas-workshop-handbook.zip');
  const zip = await readFile(zipPath);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  assert.equal(first.sha256, sha256);
  assert.equal(await readFile(`${zipPath}.sha256`, 'utf8'), `${sha256}  jeju-atlas-workshop-handbook.zip\n`);
  const { stdout } = await run(process.env.ATLAS_PYTHON || 'python3', [
    '-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps(z.namelist()))', zipPath,
  ]);
  const names = JSON.parse(stdout);
  assert.ok(names.includes('jeju-atlas-workshop/index.html'));
  assert.ok(names.includes('jeju-atlas-workshop/START-HERE.txt'));
  assert.ok(names.filter(name => name.endsWith('.md')).length >= course.chapters.length);
  assert.ok(names.every(name => !/(?:^|\/)(?:\.local|\.git|\.env|scripts|cli|node_modules)(?:\/|$)/.test(name)));
  assert.ok(names.every(name => !name.endsWith('.zip') && !name.endsWith('.workshop-site.json')));
  assert.equal(await readFile(join(appRoot, 'index.html'), 'utf8'), '<title>map shell</title>');
  const second = await buildWorkshopPublic({ appRoot });
  assert.equal(second.sha256, sha256);
  assert.deepEqual((await readdir(appRoot)).sort(), ['index.html', 'workshop']);
});

test('public workshop build does not replace an unrelated directory', async (t) => {
  const script = new URL('../scripts/build-workshop-public.mjs', import.meta.url);
  assert.ok(await readFile(script, 'utf8').catch(() => ''), 'The public workshop builder must exist');
  const { buildWorkshopPublic } = await import(script);
  const appRoot = await mkdtemp(join(tmpdir(), 'atlas-workshop-ownership-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  await mkdir(join(appRoot, 'workshop'));
  await writeFile(join(appRoot, 'workshop/notes.txt'), 'keep');
  await assert.rejects(buildWorkshopPublic({ appRoot }), /owned workshop/i);
  assert.equal(await readFile(join(appRoot, 'workshop/notes.txt'), 'utf8'), 'keep');
});
