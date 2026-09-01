#!/usr/bin/env node
// Bumps every published repo-tools manifest to the same version in one
// atomic step and commits the result. The three files below drifted across
// separate manual PRs before (#42, #45, #46); the mirror test that used to
// catch that drift was removed in #46 because it also rejected legitimate
// temporary divergence between hand-edits. Validate-then-write-all instead
// of relying on a separate consistency check.
//
// .agents/plugins/marketplace.json (the Codex marketplace manifest) carries
// no version field of its own -- it only points at ./plugins/repo-tools, so
// it is not a release target.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    path: '.claude-plugin/marketplace.json',
    get: (manifest) => manifest.metadata?.version,
    set: (manifest, version) => {
      manifest.metadata.version = version;
    },
  },
  {
    path: 'plugins/repo-tools/.claude-plugin/plugin.json',
    get: (manifest) => manifest.version,
    set: (manifest, version) => {
      manifest.version = version;
    },
  },
  {
    path: 'plugins/repo-tools/.codex-plugin/plugin.json',
    get: (manifest) => manifest.version,
    set: (manifest, version) => {
      manifest.version = version;
    },
  },
];

class ReleaseError extends Error {}

function loadTarget(target) {
  if (!existsSync(target.path)) {
    throw new ReleaseError(`${target.path} does not exist`);
  }
  const raw = readFileSync(target.path, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseError(`${target.path}: invalid JSON (${error.message})`);
  }
  const current = target.get(manifest);
  if (typeof current !== 'string' || current.length === 0) {
    throw new ReleaseError(`${target.path} has no existing version field to bump`);
  }
  return { target, manifest, current };
}

export function release(version, { commit = true } = {}) {
  if (!version) {
    throw new ReleaseError('usage: node scripts/release.mjs <version>');
  }
  if (!VERSION_RE.test(version)) {
    throw new ReleaseError(`"${version}" is not a valid semantic version`);
  }

  // Load and validate every target before writing any of them, so a bad
  // file leaves the whole release untouched instead of half-bumped.
  const loaded = TARGETS.map(loadTarget);

  for (const { target, manifest } of loaded) {
    target.set(manifest, version);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const tmpPath = `${target.path}.tmp`;
    writeFileSync(tmpPath, serialized);
    renameSync(tmpPath, target.path);
  }

  if (commit) {
    const paths = TARGETS.map((target) => target.path);
    execFileSync('git', ['add', ...paths], { stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', `chore: release repo-tools plugin ${version}`], { stdio: 'inherit' });
  }

  return loaded.map(({ target, current }) => ({ path: target.path, from: current, to: version }));
}

function main() {
  try {
    const results = release(process.argv[2]);
    for (const { path, from, to } of results) {
      console.log(`release: ${path} ${from} -> ${to}`);
    }
    console.log('release: committed.');
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`release: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
