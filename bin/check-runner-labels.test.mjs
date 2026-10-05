import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { declaredLabels, labelsIn, violations } from './check-runner-labels.mjs';

const script = fileURLToPath(new URL('./check-runner-labels.mjs', import.meta.url));
const declared = ['homelab-ci', 'homelab-control'];

test('reads block and flow label lists from the actionlint config', () => {
  assert.deepEqual(
    declaredLabels('# c\nself-hosted-runner:\n  labels:\n    # scale set\n    - homelab-ci\n    - "homelab-control" # warm\n'),
    declared,
  );
  assert.deepEqual(declaredLabels('self-hosted-runner:\n  labels: [a-b, c]\n'), ['a-b', 'c']);
  assert.deepEqual(declaredLabels('config-variables: null\n'), []);
});

test('flags self-hosted combined with a declared label in every runs-on shape', () => {
  const shapes = [
    'runs-on: [self-hosted, homelab-ci]',
    "runs-on: ['self-hosted', 'homelab-ci'] # temp",
    'runs-on:\n      - self-hosted\n      - homelab-ci',
    'runs-on:\n      group: pool\n      labels: [self-hosted, homelab-control]',
    'runs-on:\n      labels:\n        - self-hosted\n        - homelab-ci',
    `runs-on: \${{ fromJSON('["self-hosted","homelab-ci"]') }}`,
  ];
  for (const shape of shapes) {
    const workflow = `jobs:\n  build:\n    ${shape}\n    steps: []\n`;
    const found = violations(workflow, declared, 'w.yml');
    assert.equal(found.length, 1, shape);
    assert.match(found[0], /^w\.yml:3: runs-on combines "self-hosted"/);
  }
});

test('accepts declared labels alone, unrelated self-hosted pools, and expressions', () => {
  const ok = [
    'runs-on: [homelab-ci]',
    'runs-on: homelab-ci',
    'runs-on: [self-hosted, linux, laptop]',
    'runs-on: ubuntu-latest',
    'runs-on: ${{ fromJSON(inputs.runs-on) }}',
    '# runs-on: [self-hosted, homelab-ci]',
    'runs-on:\n      group: self-hosted\n      labels: [homelab-ci]',
  ];
  for (const shape of ok) {
    assert.deepEqual(violations(`jobs:\n  build:\n    ${shape}\n    steps: []\n`, declared), [], shape);
  }
  assert.deepEqual(labelsIn('[self-hosted, homelab-ci] # note'), ['self-hosted', 'homelab-ci']);
});

test('CLI checks the repository workflows and exits nonzero on a violation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-labels-'));
  try {
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    writeFileSync(path.join(root, '.github/actionlint.yaml'), 'self-hosted-runner:\n  labels:\n    - homelab-ci\n');
    writeFileSync(path.join(root, '.github/workflows/ok.yml'), 'jobs:\n  a:\n    runs-on: [homelab-ci]\n');
    execFileSync(process.execPath, [script], { cwd: root });

    writeFileSync(path.join(root, '.github/workflows/bad.yml'), 'jobs:\n  a:\n    runs-on: [self-hosted, homelab-ci]\n');
    const all = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(all.status, 1);
    assert.match(all.stderr, /\.github\/workflows\/bad\.yml:3:/);

    // pre-commit passes only the changed files; an unrelated file stays green.
    execFileSync(process.execPath, [script, '.github/workflows/ok.yml', 'README.md'], { cwd: root });
    // A config change re-checks every workflow.
    const config = spawnSync(process.execPath, [script, '.github/actionlint.yaml'], { cwd: root, encoding: 'utf8' });
    assert.equal(config.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI is a no-op without declared self-hosted labels', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-labels-'));
  try {
    mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    writeFileSync(path.join(root, '.github/workflows/w.yml'), 'jobs:\n  a:\n    runs-on: [self-hosted, x]\n');
    execFileSync(process.execPath, [script], { cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
