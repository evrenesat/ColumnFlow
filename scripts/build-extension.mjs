#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const srcDir = path.join(repoRoot, 'src');
const distDir = path.join(repoRoot, 'dist');
const runtimeDirs = ['background', 'content', 'popup', 'shared', 'icons'];
const supportedTargets = new Map([
  ['firefox', 'manifest.firefox.json'],
  ['chrome', 'manifest.chrome.json'],
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeManifests(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeManifests(merged[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyRuntimeTree(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.includes('.test.')) {
      continue;
    }

    const fromPath = path.join(sourceDir, entry.name);
    const toPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyRuntimeTree(fromPath, toPath);
      continue;
    }

    if (entry.isFile()) {
      await mkdir(path.dirname(toPath), { recursive: true });
      await copyFile(fromPath, toPath);
    }
  }
}

async function buildTarget(target) {
  const manifestFile = supportedTargets.get(target);
  if (!manifestFile) {
    throw new Error(`Unknown build target: ${target}`);
  }

  const outDir = path.join(distDir, target);
  const baseManifest = await readJson(path.join(srcDir, 'manifest.base.json'));
  const overrideManifest = await readJson(path.join(srcDir, manifestFile));

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const runtimeDir of runtimeDirs) {
    await copyRuntimeTree(path.join(srcDir, runtimeDir), path.join(outDir, runtimeDir));
  }

  const manifest = mergeManifests(baseManifest, overrideManifest);
  await writeJson(path.join(outDir, 'manifest.json'), manifest);
}

async function main() {
  const target = process.argv[2] ?? 'all';

  if (target === 'all') {
    for (const browser of supportedTargets.keys()) {
      await buildTarget(browser);
    }
    return;
  }

  await buildTarget(target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
