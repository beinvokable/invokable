#!/usr/bin/env node
/** Sets every package (and the root) to one version. Usage: node scripts/set-version.mjs 0.2.0 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <semver>   e.g. 0.2.0 or 0.2.0-alpha.1');
  process.exit(2);
}

const root = new URL('../', import.meta.url).pathname;

function bump(manifest) {
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  pkg.version = version;
  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
  return pkg.name;
}

bump(join(root, 'package.json'));

const packagesDir = join(root, 'packages');
for (const name of readdirSync(packagesDir)) {
  try {
    console.log(`${bump(join(packagesDir, name, 'package.json'))} -> ${version}`);
  } catch {
    // Not a package directory.
  }
}

console.log(
  `\nNext:\n  pnpm install\n  git commit -am "Release ${version}"\n` +
    `  git tag v${version}\n  git push --follow-tags`,
);
