#!/usr/bin/env node
/**
 * Every package in this monorepo shares one version.
 *
 * They are released together and depend on each other through `workspace:^`,
 * so a package left behind at an older version publishes a dependency range
 * that resolves to something never tested against it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = new URL('../packages/', import.meta.url).pathname;
const versions = new Map();

for (const name of readdirSync(packagesDir)) {
  try {
    const pkg = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8'));
    versions.set(pkg.name, pkg.version);
  } catch {
    // Not a package directory.
  }
}

const distinct = new Set(versions.values());
if (distinct.size !== 1) {
  console.error('Packages disagree on the version:');
  for (const [name, version] of versions) console.error(`  ${name}: ${version}`);
  console.error('\nRun: pnpm version:set <version>');
  process.exit(1);
}

console.log(`All ${versions.size} packages at ${[...distinct][0]}.`);
