import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./docs.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'repo-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8' });
  return { root, write, run };
}

test('real CLI generates stable inventories and catches source drift', (t) => {
  const { root, write, run } = fixture(t);
  write('package.json', JSON.stringify({ bin: { 'repo-one': 'bin/one.sh' } }));
  write('bin/one.sh', '#!/bin/sh\n');
  write('apps/a/project.json', JSON.stringify({ name: '@a/web', targets: { serve: {} } }));
  write('apps/a/infra/deployment.yaml', 'apps:\n  frontend:\n    project: example\n');
  write('.agents/skills/one/SKILL.md', '---\nname: one\ndescription: "Run when asked to do one"\ndisable-model-invocation: true\n---\n');
  assert.equal(run('generate', '--output', 'docs/interfaces.md').status, 0);
  const generated = readFileSync(path.join(root, 'docs/interfaces.md'), 'utf8');
  for (const name of ['repo-one', '@a/web:serve', 'a/frontend', '.agents/skills/one/SKILL.md']) assert.ok(generated.includes(name));
  assert.equal(run('check', '--output', 'docs/interfaces.md').status, 0);
  write('apps/a/project.json', JSON.stringify({ name: '@a/web', targets: { build: {} } }));
  const stale = run('check', '--output', 'docs/interfaces.md');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale inventory/);
});

test('broken links and malformed skills fail while examples and external links do not', (t) => {
  const { write, run } = fixture(t);
  write('README.md', '[web](https://example.com/a)\n[anchor](#foo)\n`[example](missing)`\n```md\n[example](missing)\n```\n[valid](<docs/with space.md>)\n');
  write('docs/with space.md', 'hello\n');
  assert.equal(run('check').status, 0);
  write('docs/bad.md', '[bad][ref]\n\n[ref]: missing.md\n');
  assert.match(run('check').stderr, /missing link target/);
  write('.agents/skills/bad/SKILL.md', '---\nname: bad\ndescription: []\n---\n');
  assert.match(run('check').stderr, /description must be a nonempty string/);
});

test('selected checks allow deleted docs but fail invalid options and output escapes', (t) => {
  const { root, write, run } = fixture(t);
  write('old.md', '[bad](missing)\n');
  write('new.md', 'valid\n');
  const selected = spawnSync(process.execPath, [cli, 'check', '--root', root, '--files', 'new.md', 'deleted.md'], { encoding: 'utf8' });
  assert.equal(selected.status, 0);
  assert.equal(run('generate', '--output', '../escape.md').status, 1);
  assert.equal(run('check', '--typo').status, 1);
});
