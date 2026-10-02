import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('always-loaded agent context stays compact', async () => {
  const agents = await read('AGENTS.md');
  assert.ok(Buffer.byteLength(agents) <= 14 * 1024);
});

test('agent router points to architecture, docs, skills, and proof', async () => {
  const agents = await read('AGENTS.md');
  for (const route of [
    'ARCHITECTURE.md',
    'docs/README.md',
    'worktree-hygiene/SKILL.md',
    'pnpm test',
    'plugins/manifests.test.mjs',
  ]) {
    assert.match(agents, new RegExp(route.replaceAll('.', '\\.'), 'i'));
  }
});

test('router stays free of duplicated control procedures', async () => {
  const agents = await read('AGENTS.md');
  assert.doesNotMatch(agents, /gh pr (create|merge)|git (pull|rebase)|repo-watch-prs --/);
});

test('documentation index targets exist', async () => {
  const paths = [
    'ARCHITECTURE.md',
    'README.md',
    'docs/interfaces.md',
    'plugins/repo-tools/skills/worktree-hygiene/SKILL.md',
    'plugins/repo-tools/skills/github-ci-monitor/SKILL.md',
    'plugins/repo-tools/skills/land-pr/SKILL.md',
    'plugins/repo-tools/skills/testing-policy/SKILL.md',
    'plugins/repo-tools/skills/renovate-maintenance/SKILL.md',
  ];
  for (const path of paths) await assert.doesNotReject(read(path), path);
});

test('architecture protects the runtime-neutral ownership boundary', async () => {
  const architecture = await read('ARCHITECTURE.md');
  for (const concept of ['Runtime-Neutral Boundary', 'bin/', 'plugins/', 'eslint/', 'Proof Ladder']) {
    assert.match(architecture, new RegExp(concept.replaceAll('.', '\\.'), 'i'));
  }
});

test('negative fixtures violate the contract', () => {
  assert.ok(Buffer.byteLength('x'.repeat(14 * 1024 + 1)) > 14 * 1024);
  assert.match('gh pr create', /gh pr (create|merge)/);
});
