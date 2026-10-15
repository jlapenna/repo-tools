// Runs repo-doctor against throwaway HOME, PATH, and agent configuration
// directories laid out like real pnpm-global and plugin installs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./doctor.mjs', import.meta.url));
const root = path.dirname(path.dirname(script));
const bins = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).bin;
let tmp;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// A pnpm-global-like layout: PATH shims recording their package target, a
// Codex hook calling repo-set-tmux-task-title, and both plugin caches.
function fixture() {
  tmp = mkdtempSync(path.join(tmpdir(), 'doctor-'));
  const shims = path.join(tmp, 'shims');
  const tools = path.join(tmp, 'tools');
  const codex = path.join(tmp, 'codex');
  const claude = path.join(tmp, 'claude');
  for (const dir of [shims, tools, codex, claude]) mkdirSync(dir);
  for (const tool of ['git', 'bash', 'gh', 'jq']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, path.join(tools, tool));
  }
  for (const [name, target] of Object.entries(bins)) {
    writeFileSync(path.join(shims, name), `#!/bin/sh\nexec "${path.join(root, target)}" "$@"\n# cmd-shim-target=${path.join(root, target)}\n`, { mode: 0o755 });
  }
  writeFileSync(
    path.join(codex, 'hooks.json'),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'input=$(cat); printf %s "$input" | repo-set-tmux-task-title # SECRET_PROMPT' }] }] } }),
  );
  writeFileSync(path.join(codex, 'config.toml'), '[plugins."repo-tools@repo-tools"]\nenabled = true\n');
  mkdirSync(path.join(codex, 'plugins/cache/repo-tools/repo-tools/2.0.9'), { recursive: true });
  mkdirSync(path.join(codex, 'plugins/cache/repo-tools/repo-tools/2.0.10'), { recursive: true });
  const installPath = path.join(claude, 'plugins/cache/repo-tools/repo-tools/2.0.10');
  mkdirSync(installPath, { recursive: true });
  writeFileSync(
    path.join(claude, 'plugins/installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'repo-tools@repo-tools': [{ version: '2.0.10', installPath }] } }),
  );
  return { shims, tools, codex, claude, installPath, path: `${shims}:${tools}` };
}

function run(fx, args = ['--json'], pathValue = fx.path) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    input: 'SECRET_PROMPT from stdin',
    env: { HOME: tmp, PATH: pathValue, CODEX_HOME: fx.codex, CLAUDE_CONFIG_DIR: fx.claude },
  });
  return { status: result.status, stdout: result.stdout, json: args.includes('--json') ? JSON.parse(result.stdout) : undefined };
}
const check = (report, name) => report.checks.find((c) => c.name === name);

test('healthy install passes outside a repository without leaking hook text', () => {
  const fx = fixture();
  const { status, json, stdout } = run(fx);
  assert.equal(status, 0, stdout);
  assert.equal(json.ok, true);
  assert.equal(json.repository, null);
  assert.equal(json.package.root, root);
  assert.equal(check(json, 'hooks:codex').detail.endsWith('calls repo-set-tmux-task-title'), true);
  assert.equal(check(json, 'command:repo-set-tmux-task-title').status, 'ok');
  assert.equal(check(json, 'plugin:codex').detail.startsWith('2.0.10 '), true);
  assert.equal(check(json, 'plugin:versions'), undefined);
  assert.doesNotMatch(stdout, /SECRET_PROMPT/);

  const human = run(fx, []);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^repository: none \(not a git repository\)$/m);
  assert.match(human.stdout, new RegExp(`^OK   commands: ${Object.keys(bins).length}/${Object.keys(bins).length} resolve on PATH$`, 'm'));
  assert.match(human.stdout, /\nOK\n$/);
});

test('a command a hook needs is a failure naming that command', () => {
  const fx = fixture();
  rmSync(path.join(fx.shims, 'repo-set-tmux-task-title'));
  rmSync(path.join(fx.shims, 'repo-nx'));
  const { status, json } = run(fx);
  assert.equal(status, 1);
  assert.deepEqual(check(json, 'command:repo-set-tmux-task-title'), {
    name: 'command:repo-set-tmux-task-title',
    status: 'fail',
    detail: 'missing repo-set-tmux-task-title on PATH (required by codex hooks)',
  });
  // Not referenced by a hook: reported, not fatal.
  assert.equal(check(json, 'command:repo-nx').status, 'warn');

  const human = run(fx, []);
  assert.match(human.stdout, /^FAIL command:repo-set-tmux-task-title: missing repo-set-tmux-task-title on PATH/m);
  assert.match(human.stdout, /\nFAIL command:repo-set-tmux-task-title\n$/);
});

test('missing git is a required runtime failure', () => {
  const fx = fixture();
  const { status, json } = run(fx, ['--json'], fx.shims);
  assert.equal(status, 1);
  assert.deepEqual(check(json, 'runtime:git'), { name: 'runtime:git', status: 'fail', detail: 'missing git on PATH' });
  assert.equal(check(json, 'runtime:jq').status, 'warn');
});

test('stale shim targets and plugin cache paths fail', () => {
  const fx = fixture();
  writeFileSync(path.join(fx.shims, 'repo-set-tmux-task-title'), '#!/bin/sh\n# cmd-shim-target=/gone/repo-tools/bin/set-tmux-task-title.mjs\n', { mode: 0o755 });
  rmSync(fx.installPath, { recursive: true });
  rmSync(path.join(fx.codex, 'plugins/cache/repo-tools/repo-tools'), { recursive: true });
  const { status, json } = run(fx);
  assert.equal(status, 1);
  assert.match(check(json, 'command:repo-set-tmux-task-title').detail, /^stale: .* points at missing \/gone\/repo-tools\/bin\/set-tmux-task-title\.mjs \(required by codex hooks\)$/);
  assert.equal(check(json, 'plugin:claude:repo-tools@repo-tools').status, 'fail');
  assert.match(check(json, 'plugin:codex').detail, /^stale: repo-tools is enabled/);
});

test('mismatched plugin versions and mixed installs warn', () => {
  const fx = fixture();
  rmSync(path.join(fx.codex, 'plugins/cache/repo-tools/repo-tools/2.0.10'), { recursive: true });
  const other = path.join(tmp, 'other/bin');
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, 'nx.sh'), '');
  rmSync(path.join(fx.shims, 'repo-nx'));
  symlinkSync(path.join(other, 'nx.sh'), path.join(fx.shims, 'repo-nx'));
  const { status, json } = run(fx);
  assert.equal(status, 0);
  assert.deepEqual(check(json, 'plugin:versions'), { name: 'plugin:versions', status: 'warn', detail: 'codex has 2.0.9, claude has 2.0.10' });
  assert.equal(check(json, 'commands:install').status, 'warn');
});

test('reports the enclosing repository and rejects unknown flags', () => {
  const fx = fixture();
  execFileSync('git', ['init', '-q', tmp]);
  assert.equal(run(fx).json.repository, execFileSync('git', ['-C', tmp, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  assert.equal(spawnSync(process.execPath, [script, '--fix']).status, 64);
});
