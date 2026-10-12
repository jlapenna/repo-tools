#!/usr/bin/env node
// Bumps every published repo-tools manifest to the same version in one
// atomic step and commits the result. The three files below drifted across
// separate manual PRs before (#42, #45, #46); the mirror test that used to
// catch that drift was removed in #46 because it also rejected legitimate
// temporary divergence between hand-edits. Validate-then-write-all instead
// of relying on a separate consistency check.
//
// It refuses a requested version that is not strictly greater (by semver
// precedence) than the version the manifests already carry, and refuses when
// the manifests disagree: a rebased release commit once set 1.7.0 on top of
// main's 1.8.1 and only a manual check caught the downgrade. `--check-base
// <ref>` applies the same non-decreasing rule to the working tree against a
// base commit so CI catches a release that became a downgrade after rebase.
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

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    return undefined;
  }
  return {
    core: match.slice(1, 4).map(BigInt),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

// Semantic Versioning 2.0.0 precedence (section 11); build metadata is ignored.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new ReleaseError(`cannot compare "${left}" and "${right}": not semantic versions`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] < b.core[i] ? -1 : 1;
    }
  }
  // A version without a prerelease outranks the same core with one.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i += 1) {
    const order = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

function agreedVersion(loaded, label) {
  const versions = new Set(loaded.map(({ current }) => current));
  if (versions.size !== 1) {
    const detail = loaded.map(({ target, current }) => `${target.path}=${current}`).join(', ');
    throw new ReleaseError(`${label} manifests disagree on the current version (${detail}); reconcile them before releasing`);
  }
  const [version] = versions;
  if (!VERSION_RE.test(version)) {
    throw new ReleaseError(`${label} version "${version}" is not a valid semantic version`);
  }
  return version;
}

function loadTarget(target, read) {
  const raw = read(target.path);
  if (raw === undefined) {
    throw new ReleaseError(`${target.path} does not exist`);
  }
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
  const loaded = TARGETS.map((target) => loadTarget(target, readWorkingTree));
  const current = agreedVersion(loaded, 'release');
  if (compareVersions(version, current) <= 0) {
    throw new ReleaseError(
      `requested version ${version} is not greater than the current version ${current}; choose a version above ${current}`,
    );
  }

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

function readWorkingTree(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function readAtRef(ref) {
  return (path) => {
    try {
      return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw new ReleaseError(`cannot read ${path} at ${ref}: ${String(error.stderr ?? error.message).trim()}`);
    }
  };
}

// Refuses a working tree whose manifests disagree or whose version is lower
// than the version at `baseRef`. Equal is allowed: most changes do not release.
export function checkAgainstBase(baseRef) {
  const head = agreedVersion(TARGETS.map((target) => loadTarget(target, readWorkingTree)), 'working-tree');
  const base = agreedVersion(TARGETS.map((target) => loadTarget(target, readAtRef(baseRef))), `base (${baseRef})`);
  if (compareVersions(head, base) < 0) {
    throw new ReleaseError(
      `working-tree version ${head} is lower than the base version ${base} at ${baseRef}; rerun pnpm release with a version above ${base}`,
    );
  }
  return { base, head };
}

function main() {
  try {
    if (process.argv[2] === '--check-base') {
      const { base, head } = checkAgainstBase(process.argv[3] ?? 'origin/main');
      console.log(`release: version ${head} does not decrease base version ${base}.`);
      return;
    }
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
