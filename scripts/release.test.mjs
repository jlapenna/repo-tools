import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { release } from './release.mjs';

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

test('does not require the three files to already agree on a version', () => {
  withFixtureCwd((dir) => {
    const path = 'plugins/repo-tools/.codex-plugin/plugin.json';
    writeFileSync(join(dir, path), `${JSON.stringify({ name: 'repo-tools', version: '0.9.9-drifted' }, null, 2)}\n`);
    release('2.0.0');
    const versions = readVersions(dir);
    assert.deepEqual(Object.values(versions), ['2.0.0', '2.0.0', '2.0.0']);
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
