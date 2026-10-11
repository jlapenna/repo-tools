import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AGENTS_BEGIN,
  AGENTS_END,
  ensureInstallHookTypes,
  mergeAgentsSection,
  mergePreCommitConfig,
  renderAgentsSection,
  resolveRepoToolsRev,
} from './adopt.mjs';

const script = fileURLToPath(new URL('./adopt.mjs', import.meta.url));
const REV = '0123456789abcdef0123456789abcdef01234567';
const OTHER = `  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: check-yaml
      - id: end-of-file-fixer
`;

/** A fixture directory whose PATH `git` records (and fails) any network call. */
function fixture(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'repo-adopt-'));
  const bin = path.join(dir, 'stub-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/git-calls"
case "$1" in
  ls-remote) [ -n "\${STUB_LS_REMOTE:-}" ] && { printf '%s\\trefs/heads/main\\n' "$STUB_LS_REMOTE"; exit 0; }; exit 128 ;;
esac
exit 0
`);
  chmodSync(path.join(bin, 'git'), 0o755);
  const target = path.join(dir, 'repo');
  mkdirSync(target);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    writeFileSync(path.join(target, file), text);
  }
  return { dir, target, bin };
}

function run(fx, args, env = {}) {
  const result = spawnSync(process.execPath, [script, '--target', fx.target, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, ...env },
  });
  const rows = result.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
  return { ...result, rows, actions: Object.fromEntries(rows.filter(([a]) => a !== 'note').map(([a, f]) => [f, a])), notes: rows.filter(([a]) => a === 'note').map(([, n]) => n) };
}

const read = (fx, file) => readFileSync(path.join(fx.target, file), 'utf8');
const gitCalls = (fx) => (existsSync(path.join(fx.dir, 'git-calls')) ? readFileSync(path.join(fx.dir, 'git-calls'), 'utf8') : '');
const sh = (file) => spawnSync('sh', ['-n', file], { encoding: 'utf8' });

test('fresh repository: --check reports drift without writing or network, apply creates, rerun is a no-op', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const check = run(fx, ['--check']);
  assert.equal(check.status, 1, check.stderr);
  assert.deepEqual(check.actions, { '.pre-commit-config.yaml': 'create', 'renovate.json': 'create', 'AGENTS.md': 'create' });
  assert.deepEqual(Object.keys(check.actions).filter((file) => existsSync(path.join(fx.target, file))), []);
  assert.equal(gitCalls(fx), '', 'check mode must not resolve a rev over the network');

  const apply = run(fx, ['--repo-tools-rev', REV]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(apply.actions, { '.pre-commit-config.yaml': 'create', 'renovate.json': 'create', 'AGENTS.md': 'create' });
  assert.equal(gitCalls(fx), '', 'an explicit rev needs no network');
  assert.match(apply.notes.join('\n'), /pre-commit install --install-hooks -t pre-commit -t pre-push/);

  const config = read(fx, '.pre-commit-config.yaml');
  assert.match(config, /^default_install_hook_types: \[pre-commit, pre-push\]$/m);
  assert.match(config, new RegExp(`- repo: https://github.com/jlapenna/repo-tools\\n    rev: ${REV}\\n    hooks:\\n      - id: repo-require-worktree\\n      - id: repo-require-worktree-push\\n`));
  const renovate = JSON.parse(read(fx, 'renovate.json'));
  assert.deepEqual(renovate.extends, ['github>jlapenna/repo-tools//renovate-preset']);
  assert.deepEqual(renovate.vulnerabilityAlerts, { enabled: true, labels: ['bot:renovate', 'type:security'] });
  const agents = read(fx, 'AGENTS.md');
  assert.match(agents, /^# Agent Guide\n\n<!-- repo-tools:begin -->/);
  assert.match(agents, /skills\/worktree-hygiene\/SKILL\.md/);
  assert.match(agents, /skills\/land-pr\/SKILL\.md/);
  assert.match(agents, /Do not mirror their bodies locally/);

  const again = run(fx, ['--repo-tools-rev', REV]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.actions, { '.pre-commit-config.yaml': 'unchanged', 'renovate.json': 'unchanged', 'AGENTS.md': 'unchanged' });
  const recheck = run(fx, ['--check']);
  assert.equal(recheck.status, 0, recheck.stdout);
  assert.equal(gitCalls(fx), '', 'a settled repository never needs the network');
});

test('resolves the rev from repo-tools main only when a pin is written', (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const apply = run(fx, [], { STUB_LS_REMOTE: REV });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(gitCalls(fx), /^ls-remote https:\/\/github\.com\/jlapenna\/repo-tools\.git refs\/heads\/main$/m);
  assert.match(read(fx, '.pre-commit-config.yaml'), new RegExp(`rev: ${REV}`));

  const failing = fixture();
  t.after(() => rmSync(failing.dir, { recursive: true, force: true }));
  const result = run(failing, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pass --repo-tools-rev/);
  assert.equal(existsSync(path.join(failing.target, '.pre-commit-config.yaml')), false);

  assert.equal(resolveRepoToolsRev(() => `${REV}\trefs/heads/main\n`), REV);
  assert.throws(() => resolveRepoToolsRev(() => ''), /pass --repo-tools-rev/);
});

test('existing pre-commit config: entry is inserted, other entries and keys survive, hook types are extended', (t) => {
  const fx = fixture({
    '.pre-commit-config.yaml': `# project hooks\ndefault_install_hook_types: [pre-commit]\nfail_fast: true\nrepos:\n${OTHER}`,
    'renovate.json': '{"extends":["local>me/preset"]}\n',
  });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const apply = run(fx, ['--repo-tools-rev', REV]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(apply.actions, { '.pre-commit-config.yaml': 'update', 'renovate.json': 'keep', 'AGENTS.md': 'create' });
  const config = read(fx, '.pre-commit-config.yaml');
  assert.equal(config, `# project hooks\ndefault_install_hook_types: [pre-commit, pre-push]\nfail_fast: true\nrepos:\n  - repo: https://github.com/jlapenna/repo-tools\n    rev: ${REV}\n    hooks:\n      - id: repo-require-worktree\n      - id: repo-require-worktree-push\n${OTHER}`);
  const parsed = parseYaml(config);
  assert.deepEqual(parsed.default_install_hook_types, ['pre-commit', 'pre-push']);
  assert.deepEqual(parsed.repos[0], { repo: 'https://github.com/jlapenna/repo-tools', rev: REV, hooks: [{ id: 'repo-require-worktree' }, { id: 'repo-require-worktree-push' }] });
  assert.equal(parsed.repos.length, 2);
  assert.equal(read(fx, 'renovate.json'), '{"extends":["local>me/preset"]}\n', 'an existing renovate.json is never modified');
  assert.equal(gitCalls(fx), '');

  const again = run(fx, ['--check']);
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.actions['.pre-commit-config.yaml'], 'unchanged');
});

test('existing repo-tools entry: missing hook ids are added, the pin is kept unless forced', () => {
  const partial = `repos:\n  - repo: https://github.com/jlapenna/repo-tools.git\n    rev: v1.0.0\n    hooks:\n      - id: repo-require-worktree\n${OTHER}`;
  const merged = mergePreCommitConfig(partial, REV);
  assert.equal(merged, `default_install_hook_types: [pre-commit, pre-push]\n\nrepos:\n  - repo: https://github.com/jlapenna/repo-tools.git\n    rev: v1.0.0\n    hooks:\n      - id: repo-require-worktree\n      - id: repo-require-worktree-push\n${OTHER}`);
  assert.equal(mergePreCommitConfig(merged, REV), merged, 'merge is idempotent');
  assert.match(mergePreCommitConfig(merged, REV, { force: true }), new RegExp(`rev: ${REV}\\n`));
  assert.doesNotMatch(mergePreCommitConfig(merged, REV, { force: true }), /v1\.0\.0/);
  // The repo-tools entry may be last in the file, with comments and no trailing newline.
  const last = `repos:\n${OTHER}  - repo: https://github.com/jlapenna/repo-tools\n    # pinned\n    rev: ${REV}\n    hooks:\n      - id: repo-require-worktree-push`;
  assert.match(mergePreCommitConfig(last, REV), /- id: repo-require-worktree-push\n      - id: repo-require-worktree$/);
  assert.throws(() => mergePreCommitConfig('minimum_pre_commit_version: 4.4.0\n', REV), /no top-level repos:/);
});

test('default_install_hook_types keeps its block or flow shape', () => {
  assert.deepEqual(ensureInstallHookTypes(['default_install_hook_types:', '  - pre-commit', '  - commit-msg', 'repos: []']),
    ['default_install_hook_types:', '  - pre-commit', '  - commit-msg', '  - pre-push', 'repos: []']);
  assert.deepEqual(ensureInstallHookTypes(["default_install_hook_types: ['pre-push', pre-commit] # both", 'repos: []']),
    ["default_install_hook_types: ['pre-push', pre-commit] # both", 'repos: []']);
  assert.deepEqual(ensureInstallHookTypes(['repos: []']), ['default_install_hook_types: [pre-commit, pre-push]', '', 'repos: []']);
});

test('husky repository: hooks are seeded once, guarded hooks are kept, unguarded ones need --force', (t) => {
  const fx = fixture({ 'package.json': '{"name":"app","private":true}\n' });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const apply = run(fx, []);
  assert.equal(apply.status, 0, apply.stderr);
  assert.deepEqual(apply.actions, { '.husky/pre-commit': 'create', '.husky/pre-push': 'create', 'renovate.json': 'create', 'AGENTS.md': 'create' });
  assert.equal(gitCalls(fx), '', 'the Husky flavor needs no rev');
  assert.match(apply.notes.join('\n'), /repo-install-husky-hooks/);
  for (const stage of ['pre-commit', 'pre-push']) {
    const file = path.join(fx.target, '.husky', stage);
    assert.equal(statSync(file).mode & 0o111, 0o111, `${stage} is executable`);
    assert.equal(sh(file).status, 0, `${stage} parses under sh`);
    assert.match(readFileSync(file, 'utf8'), /^if command -v repo-require-worktree >\/dev\/null 2>&1; then/m);
  }
  assert.match(read(fx, '.husky/pre-commit'), /repo-require-worktree commits; fi$/m);
  assert.match(read(fx, '.husky/pre-push'), /^refs="\$\(cat\)"$/m);
  assert.match(read(fx, '.husky/pre-push'), /printf '%s\\n' "\$refs" \| repo-require-worktree pushes$/m);

  const again = run(fx, ['--check']);
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.actions['.husky/pre-commit'], 'unchanged');

  // A project hook that already carries the guard is the project's business.
  writeFileSync(path.join(fx.target, '.husky/pre-commit'), '#!/bin/sh\nif command -v repo-require-worktree >/dev/null 2>&1; then repo-require-worktree commits; fi\npnpm lint\n');
  // One without the guard is reported with guidance and left alone.
  writeFileSync(path.join(fx.target, '.husky/pre-push'), '#!/bin/sh\npnpm test\n');
  const mixed = run(fx, ['--check']);
  assert.equal(mixed.status, 0, 'locally-owned files are not drift');
  assert.equal(mixed.actions['.husky/pre-commit'], 'keep');
  assert.equal(mixed.actions['.husky/pre-push'], 'locally-owned');
  assert.match(mixed.notes.join('\n'), /\.husky\/pre-push exists without the repo-require-worktree guard.*--force/);
  assert.equal(read(fx, '.husky/pre-push'), '#!/bin/sh\npnpm test\n');

  const forcedCheck = run(fx, ['--check', '--force']);
  assert.equal(forcedCheck.status, 1);
  assert.equal(forcedCheck.actions['.husky/pre-push'], 'force-update');
  assert.equal(read(fx, '.husky/pre-push'), '#!/bin/sh\npnpm test\n', '--check never writes');
  const forced = run(fx, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(forced.actions['.husky/pre-push'], 'force-update');
  assert.equal(forced.actions['.husky/pre-commit'], 'keep');
  assert.match(read(fx, '.husky/pre-push'), /repo-require-worktree pushes/);
  assert.equal(statSync(path.join(fx.target, '.husky/pre-push')).mode & 0o111, 0o111);
});

test('--hooks overrides detection and none skips hooks entirely', (t) => {
  const fx = fixture({ 'package.json': '{}\n' });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const none = run(fx, ['--hooks', 'none']);
  assert.deepEqual(Object.keys(none.actions), ['renovate.json', 'AGENTS.md']);
  const pre = run(fx, ['--hooks=pre-commit', '--repo-tools-rev', REV]);
  assert.equal(pre.actions['.pre-commit-config.yaml'], 'create');
  assert.equal(existsSync(path.join(fx.target, '.husky')), false);
  const bad = run(fx, ['--hooks', 'yarn']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--hooks must be one of/);
  const missing = run(fx, ['--target']);
  assert.equal(missing.status, 2);
  const noDir = spawnSync(process.execPath, [script, '--target', path.join(fx.dir, 'nope')], { encoding: 'utf8' });
  assert.equal(noDir.status, 2);
  assert.match(noDir.stderr, /not a directory/);
});

test('AGENTS.md: only the marked section is replaced and surrounding content survives', (t) => {
  const before = `# My Repo\n\nLocal rules.\n\n${AGENTS_BEGIN}\nstale body\n${AGENTS_END}\n\n## After\n\nmore local rules\n`;
  const fx = fixture({ 'AGENTS.md': before });
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const apply = run(fx, ['--hooks', 'none']);
  assert.equal(apply.actions['AGENTS.md'], 'update');
  const after = read(fx, 'AGENTS.md');
  assert.equal(after, `# My Repo\n\nLocal rules.\n\n${renderAgentsSection()}\n\n## After\n\nmore local rules\n`);
  assert.equal(run(fx, ['--hooks', 'none']).actions['AGENTS.md'], 'unchanged');

  assert.equal(mergeAgentsSection('# Existing\n\nbody\n'), `# Existing\n\nbody\n\n${renderAgentsSection()}\n`);
  assert.equal(mergeAgentsSection(null), `# Agent Guide\n\n${renderAgentsSection()}\n`);
  assert.throws(() => mergeAgentsSection(`${AGENTS_BEGIN}\nno end`), /unterminated/);
});
