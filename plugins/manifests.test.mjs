// Protected contract: repo-tools has one source layout consumed by four agent
// runtimes — Codex, Claude Code, and Antigravity install its plugin manifests
// and Stop hooks, while OpenCode loads its configured skill directory and
// server plugin. A broken manifest, hook path, or mismatched skill set fails
// provider setup fleet-wide without any other check noticing. Consumer:
// `pnpm test` in ci.yml.
import assert from 'node:assert/strict';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const runtimes = {
  codex: { marketplace: '.agents/plugins/marketplace.json', pluginManifest: '.codex-plugin/plugin.json' },
  claude: { marketplace: '.claude-plugin/marketplace.json', pluginManifest: '.claude-plugin/plugin.json' },
};
const opencode = { skills: 'plugins/repo-tools/skills' };

const pluginPath = (entry) =>
  typeof entry.source === 'string' ? entry.source : entry.source.path;

for (const [runtime, { marketplace, pluginManifest }] of Object.entries(runtimes)) {
  test(`${runtime} marketplace points at real plugins with a ${pluginManifest}`, () => {
    const manifest = readJson(marketplace);
    assert.equal(manifest.name, 'repo-tools');
    assert.ok(Array.isArray(manifest.plugins) && manifest.plugins.length > 0);
    for (const entry of manifest.plugins) {
      const dir = join(root, pluginPath(entry));
      assert.ok(existsSync(dir), `${runtime}: ${entry.name} -> ${pluginPath(entry)} does not exist`);
      const plugin = JSON.parse(readFileSync(join(dir, pluginManifest), 'utf8'));
      assert.equal(plugin.name, entry.name, `${runtime}: plugin manifest name must match marketplace entry`);
      const skills = readdirSync(join(dir, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory());
      assert.ok(skills.length > 0, `${runtime}: ${entry.name} ships no skills`);
      for (const skill of skills) {
        const skillMd = readFileSync(join(dir, 'skills', skill.name, 'SKILL.md'), 'utf8');
        assert.match(skillMd, new RegExp(`^name: ${skill.name}$`, 'm'), `skill ${skill.name} frontmatter name must match its directory`);
      }
    }
  });
}

test('codex and claude marketplaces describe the same plugins', () => {
  const names = (path) => readJson(path).plugins.map((p) => `${p.name}@${pluginPath(p)}`).sort();
  assert.deepEqual(names(runtimes.codex.marketplace), names(runtimes.claude.marketplace));
});

// The installer rejects more than three starter prompts; directory listing
// validation also bounds the subtitle and prompt lengths. Consumer: pnpm test.
// https://developers.openai.com/plugins/deploy/submission-errors
test('Codex discovery metadata fits the supported listing limits', () => {
  const metadata = readJson('plugins/repo-tools/.codex-plugin/plugin.json').interface;
  assert.ok(metadata.shortDescription.trim().length > 0);
  assert.ok([...metadata.shortDescription].length <= 30);
  assert.ok(Array.isArray(metadata.defaultPrompt));
  assert.ok(metadata.defaultPrompt.length <= 3);
  for (const prompt of metadata.defaultPrompt) {
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.trim().length > 0);
    assert.ok([...prompt].length <= 128);
    assert.doesNotMatch(prompt, /[\r\n]/);
  }
});

test('OpenCode configured skill source is the same well-formed repo-tools skill set', () => {
  const skillRoot = join(root, opencode.skills);
  assert.ok(existsSync(skillRoot), `OpenCode skill source ${opencode.skills} does not exist`);

  const opencodeSkills = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(opencodeSkills.length > 0, 'OpenCode skill source must not be empty');

  for (const skill of opencodeSkills) {
    const skillMd = readFileSync(join(skillRoot, skill, 'SKILL.md'), 'utf8');
    assert.match(skillMd, new RegExp(`^name: ${skill}$`, 'm'));
    assert.match(skillMd, /^description: .+$/m, `OpenCode skill ${skill} needs discovery metadata`);
  }

  const marketplaceSkills = readdirSync(join(root, pluginPath(readJson(runtimes.codex.marketplace).plugins[0]), 'skills'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(opencodeSkills, marketplaceSkills);
});

test('repo-tools plugin bundles the executable auto-merge watcher referenced by its skills', () => {
  const pluginRoot = join(root, 'plugins/repo-tools');
  const watchPrs = join(pluginRoot, 'scripts/repo-watch-prs.sh');

  assert.ok(existsSync(watchPrs), `${watchPrs} must be bundled with the plugin`);
  assert.doesNotThrow(
    () => accessSync(watchPrs, constants.X_OK),
    `${watchPrs} must remain executable`,
  );

  const ciMonitor = readFileSync(
    join(pluginRoot, 'skills/github-ci-monitor/SKILL.md'),
    'utf8',
  );
  const landPr = readFileSync(
    join(pluginRoot, 'skills/land-pr/SKILL.md'),
    'utf8',
  );
  assert.match(ciMonitor, /scripts\/repo-watch-prs\.sh/);
  assert.match(landPr, /scripts\/repo-watch-prs\.sh/);

  const prsUsage = spawnSync('bash', [watchPrs], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
  assert.equal(prsUsage.status, 1);
  assert.match(prsUsage.stderr, /^usage: watch-prs\.sh/m);
});

test('repo-tools plugin wires the autonomous-work stall hook across Claude Code, Codex, Antigravity, and OpenCode', async () => {
  const pluginRoot = join(root, 'plugins/repo-tools');
  const hookScript = join(pluginRoot, 'scripts/repo-autonomous-work-hook.mjs');
  const opencodePlugin = join(pluginRoot, 'opencode/autonomous-work.mjs');

  assert.ok(existsSync(hookScript), `${hookScript} must be bundled with the plugin`);
  assert.doesNotThrow(() => accessSync(hookScript, constants.X_OK), `${hookScript} must be executable`);
  assert.ok(existsSync(opencodePlugin), `${opencodePlugin} must be bundled for OpenCode`);

  for (const manifestRel of ['plugins/repo-tools/.claude-plugin/plugin.json', 'plugins/repo-tools/.codex-plugin/plugin.json']) {
    const manifest = readJson(manifestRel);
    assert.equal(typeof manifest.hooks, 'string', `${manifestRel} must declare hooks path`);
    const hooksFile = resolve(pluginRoot, manifest.hooks);
    assert.ok(existsSync(hooksFile), `${manifestRel} hooks file ${hooksFile} must exist`);
    const hooksSpec = JSON.parse(readFileSync(hooksFile, 'utf8'));
    const stopHooks = hooksSpec.hooks?.Stop?.flatMap((group) => group.hooks ?? []) ?? [];
    assert.ok(stopHooks.length > 0, `${manifestRel} must register a Stop hook`);
    for (const handler of stopHooks) {
      const resolvedCmd = handler.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
      const run = spawnSync('sh', ['-c', resolvedCmd], {
        cwd: pluginRoot,
        input: '{}',
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), {});
    }
  }

  const agyManifest = readJson('plugins/repo-tools/plugin.json');
  assert.equal(agyManifest.name, 'repo-tools');
  const agyHooks = readJson('plugins/repo-tools/hooks.json');
  const agyStopHandlers = Object.values(agyHooks).flatMap((spec) => spec.Stop ?? []);
  assert.ok(agyStopHandlers.length > 0, 'Antigravity hooks.json must register a Stop hook');
  for (const handler of agyStopHandlers) {
    const run = spawnSync('sh', ['-c', handler.command], {
      cwd: pluginRoot,
      input: '{}',
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {});
  }

  const mod = await import(opencodePlugin);
  assert.equal(typeof mod.default, 'function', 'OpenCode plugin must export a default plugin factory');
});
