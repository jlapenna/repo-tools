import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('./verify.mjs', import.meta.url));
function fixture(t, config = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  mkdirSync(path.join(root, '.repo'));
  writeFileSync(path.join(root, '.repo/verify.json'), JSON.stringify({ version: 1, documentationOnly: true, checks: [{ id: 'native', command: ['node', '-e', 'process.exit(0)'], when: 'full' }], ...config }));
  writeFileSync(path.join(root, 'README.md'), '# Example\n');
  writeFileSync(path.join(root, 'runtime.js'), 'export const value = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, '--base', base, ...args], { encoding: 'utf8' });
  return { root, git, base, run, write: (file, text) => writeFileSync(path.join(root, file), text) };
}

test('local selection includes committed, staged, unstaged and untracked files; CI freezes its head', (t) => {
  const f = fixture(t);
  f.write('README.md', '# Committed docs\n'); f.git('add', '.'); f.git('commit', '-qm', 'docs');
  const head = f.git('rev-parse', 'HEAD');
  f.write('staged.md', '# Staged\n'); f.git('add', 'staged.md');
  f.write('README.md', '# Unstaged\n'); f.write('new.js', 'new runtime');
  const local = JSON.parse(f.run().stdout);
  assert.equal(local.lane, 'full');
  assert.deepEqual(local.files, ['README.md', 'new.js', 'staged.md']);
  const ci = JSON.parse(f.run('--head', head).stdout);
  assert.equal(ci.lane, 'documentation'); assert.deepEqual(ci.files, ['README.md']);
});

test('renaming runtime code to Markdown cannot evade the full lane; empty and unknown diffs fail safe', (t) => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.run().stdout).lane, 'full');
  renameSync(path.join(f.root, 'runtime.js'), path.join(f.root, 'runtime.md'));
  f.git('add', '-A');
  assert.equal(JSON.parse(f.run().stdout).lane, 'full');
  assert.notEqual(f.run('--base', 'missing-base').status, 0);
  assert.notEqual(f.run('--check', 'typo').status, 0);
});

test('documentation selection is opt-in; native failure stops execution', (t) => {
  const f = fixture(t, { documentationOnly: false, checks: [{ id: 'native', command: ['node', '-e', 'process.exit(7)'], when: 'full' }] });
  f.write('README.md', '# Docs\n');
  assert.equal(JSON.parse(f.run().stdout).lane, 'full');
  const result = f.run('--run'); assert.notEqual(result.status, 0); assert.match(result.stderr, /native failed \(7\)/);
});

test('docs run even when native checks skip and broken links block the command', (t) => {
  const f = fixture(t, { checks: [{ id: 'native', command: ['node', '-e', 'process.exit(7)'], when: 'full' }] });
  f.write('README.md', '# Docs\n');
  const passed = f.run('--run'); assert.equal(passed.status, 0, passed.stderr); assert.match(passed.stdout, /SKIP native/);
  f.write('README.md', '[broken](absent.txt)\n');
  const failed = f.run('--run'); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /missing link target/);
});

test('execution uses argv without shell interpolation and resolved refs in env', (t) => {
  const f = fixture(t, { checks: [{ id: 'args', command: ['node', '-e', 'if(process.argv[1] !== "$(exit 9)" || !/^[a-f0-9]{40}$/.test(process.env.TEST_BASE)) process.exit(3)', '$(exit 9)'], env: { TEST_BASE: '{base}' } }] });
  assert.equal(f.run('--run', '--check', 'args').status, 0);
  f.write('README.md', '# New\n'); f.git('add', '.'); f.git('commit', '-qm', 'next');
  assert.notEqual(f.run('--head', f.base, '--run').status, 0);
});

test('installed bin symlink executes and malformed plans cannot silently pass', (t) => {
  const f = fixture(t); const link = path.join(f.root, 'repo-verify'); symlinkSync(cli, link);
  const result = spawnSync(process.execPath, [link, '--root', f.root, '--base', f.base, '--check', 'missing'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unknown check/);
  f.write('.repo/verify.json', JSON.stringify({ version: 1, checks: [{ id: 'native', command: [] }] }));
  assert.notEqual(f.run().status, 0);
});
