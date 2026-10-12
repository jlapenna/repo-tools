import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkAgainstBase, compareVersions, release } from './release.mjs';

const FIXTURES = {
  '.claude-plugin/marketplace.json': { metadata: { version: '1.0.0' } },
  'plugins/repo-tools/.claude-plugin/plugin.json': { name: 'repo-tools', version: '1.0.0' },
  'plugins/repo-tools/.codex-plugin/plugin.json': { name: 'repo-tools', version: '1.0.0' },
};

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'repo-tools-release-'));
  for (const [path, contents] of Object.entries(FIXTURES)) {
    const fullPath = join(dir, path);
    mkdirSync(fullPath.slice(0, fullPath.lastIndexOf('/')), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir });
  return dir;
}

function withFixtureCwd(fn) {
  const dir = makeFixture();
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function readVersions(dir) {
  return Object.fromEntries(
    Object.keys(FIXTURES).map((path) => {
      const manifest = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      return [path, manifest.metadata?.version ?? manifest.version];
    }),
  );
}

test('bumps every manifest to the same version and commits atomically', () => {
  withFixtureCwd((dir) => {
    const results = release('1.2.3');
    assert.deepEqual(
      results.map((r) => r.to),
      ['1.2.3', '1.2.3', '1.2.3'],
    );
    const versions = readVersions(dir);
    for (const version of Object.values(versions)) {
      assert.equal(version, '1.2.3');
    }
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir }).toString().trim();
    assert.equal(log, 'chore: release repo-tools plugin 1.2.3');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
    assert.equal(status, '');
  });
});

function setVersions(dir, version) {
  for (const [path, contents] of Object.entries(FIXTURES)) {
    const manifest = structuredClone(contents);
    if (manifest.metadata) {
      manifest.metadata.version = version;
    } else {
      manifest.version = version;
    }
    writeFileSync(join(dir, path), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function assertUntouched(dir, version = '1.0.0') {
  assert.deepEqual(Object.values(readVersions(dir)), [version, version, version]);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
  assert.equal(status, '');
}

test('refuses manifests that disagree and names each version', () => {
  withFixtureCwd((dir) => {
    const path = 'plugins/repo-tools/.codex-plugin/plugin.json';
    writeFileSync(join(dir, path), `${JSON.stringify({ name: 'repo-tools', version: '0.9.9-drifted' }, null, 2)}\n`);
    execFileSync('git', ['commit', '-qam', 'drift'], { cwd: dir });
    assert.throws(() => release('2.0.0'), /disagree.*\.codex-plugin\/plugin\.json=0\.9\.9-drifted/);
    assert.deepEqual(Object.values(readVersions(dir)), ['1.0.0', '1.0.0', '0.9.9-drifted']);
  });
});

for (const [requested, kind] of [
  ['0.9.9', 'a lower version'],
  ['1.0.0', 'an equal version'],
  ['1.0.0+build.7', 'an equal-precedence version (build metadata)'],
  ['1.0.0-rc.1', 'a prerelease of the current version'],
]) {
  test(`refuses ${kind} and leaves every file untouched`, () => {
    withFixtureCwd((dir) => {
      assert.throws(
        () => release(requested),
        (error) => error.message.includes(`requested version ${requested}`) && error.message.includes('current version 1.0.0'),
      );
      assertUntouched(dir);
    });
  });
}

test('accepts a greater version, including a prerelease of a greater core', () => {
  withFixtureCwd((dir) => {
    release('1.0.1-rc.1');
    assertUntouched(dir, '1.0.1-rc.1');
    assert.throws(() => release('1.0.1-beta'), /requested version 1\.0\.1-beta is not greater than the current version 1\.0\.1-rc\.1/);
    release('1.0.1-rc.2');
    release('1.0.1');
    assertUntouched(dir, '1.0.1');
  });
});

test('orders versions by semver precedence', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
  ];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = 0; j < ordered.length; j += 1) {
      assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
});

test('base check refuses a working tree that decreases the base version', () => {
  withFixtureCwd((dir) => {
    execFileSync('git', ['tag', 'base'], { cwd: dir });
    assert.deepEqual(checkAgainstBase('base'), { base: '1.0.0', head: '1.0.0' });
    setVersions(dir, '1.1.0');
    assert.deepEqual(checkAgainstBase('base'), { base: '1.0.0', head: '1.1.0' });
    setVersions(dir, '0.9.0');
    assert.throws(() => checkAgainstBase('base'), /working-tree version 0\.9\.0 is lower than the base version 1\.0\.0/);
    setVersions(dir, '1.0.0');
    writeFileSync(
      join(dir, 'plugins/repo-tools/.codex-plugin/plugin.json'),
      `${JSON.stringify({ name: 'repo-tools', version: '1.1.0' }, null, 2)}\n`,
    );
    assert.throws(() => checkAgainstBase('base'), /working-tree manifests disagree/);
  });
});

test('rejects a malformed version and leaves every file untouched', () => {
  withFixtureCwd((dir) => {
    assert.throws(() => release('not-a-version'), /not a valid semantic version/);
    const versions = readVersions(dir);
    for (const version of Object.values(versions)) {
      assert.equal(version, '1.0.0');
    }
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
    assert.equal(status, '');
  });
});

test('rejects a missing manifest and leaves the other files untouched', () => {
  withFixtureCwd((dir) => {
    rmSync(join(dir, 'plugins/repo-tools/.codex-plugin/plugin.json'));
    assert.throws(() => release('1.5.0'), /does not exist/);
    const marketplace = JSON.parse(readFileSync(join(dir, '.claude-plugin/marketplace.json'), 'utf8'));
    const claudePlugin = JSON.parse(readFileSync(join(dir, 'plugins/repo-tools/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(marketplace.metadata.version, '1.0.0');
    assert.equal(claudePlugin.version, '1.0.0');
  });
});
