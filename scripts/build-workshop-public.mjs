#!/usr/bin/env node
/** Assemble the public reader and PC handout from allowlisted workshop sources. */
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildSite } from '../workshop/scripts/build.mjs';

const run = promisify(execFile);
const packager = fileURLToPath(new URL('../workshop/scripts/package_handbook.py', import.meta.url));
const archiveName = 'jeju-atlas-workshop-handbook.zip';

export async function buildWorkshopPublic({ appRoot = resolve('dist') } = {}) {
  appRoot = resolve(appRoot);
  const outputDir = join(appRoot, 'workshop');
  await mkdir(appRoot, { recursive: true });
  if ((await lstat(appRoot)).isSymbolicLink()) throw new Error('App output cannot be a symbolic link');
  try {
    const info = await lstat(outputDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Expected an owned workshop output directory');
    const markerPath = join(outputDir, '.workshop-site.json');
    const markerInfo = await lstat(markerPath).catch(() => null);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) throw new Error('Expected an owned workshop output directory');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker.generator !== 'jeju-atlas-workshop/v1') throw new Error('Expected an owned workshop output directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Keep a previous complete output until both the reader and ZIP have passed
  // the existing public-file, link, and private-state checks.
  const stage = await mkdtemp(join(appRoot, '.workshop-build-'));
  try {
    const site = join(stage, 'site');
    await buildSite({ outputDir: site, publicDownloads: true });
    const archive = join(stage, archiveName);
    const { stdout } = await run(process.env.ATLAS_PYTHON || 'python3', [
      packager, '--site', site, '--output', archive,
    ], { maxBuffer: 1024 * 1024 });
    const report = JSON.parse(stdout);
    await mkdir(join(site, 'downloads'));
    await rename(archive, join(site, 'downloads', archiveName));
    await rename(`${archive}.sha256`, join(site, 'downloads', `${archiveName}.sha256`));
    await rm(outputDir, { recursive: true, force: true });
    await rename(site, outputDir);
    return { ...report, archive: join(outputDir, 'downloads', archiveName), outputDir };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await buildWorkshopPublic();
  console.log(`Public workshop: ${report.pages} pages; PC handout ${report.bytes} bytes; SHA-256 ${report.sha256}`);
}
