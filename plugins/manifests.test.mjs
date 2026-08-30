// Protected contract: the plugin marketplace manifests every host installs
// from — Codex via .agents/plugins/marketplace.json, Claude Code via
// .claude-plugin/marketplace.json — describe the same plugin, point at a real
// plugin directory that carries the runtime's plugin manifest, and that
// directory's skills are well-formed. A broken path or a plugin present in one
// runtime's manifest but not the other's fails plugin installation fleet-wide
// without any other check noticing. Consumer: `pnpm test` in ci.yml.
import assert from 'node:assert/strict';
import {
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
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

test('repo-tools plugin bundles executable CI watchers referenced by its skills', () => {
  const pluginRoot = join(root, 'plugins/repo-tools');
  const watchRun = join(pluginRoot, 'scripts/repo-watch-run.cjs');
  const watchPrs = join(pluginRoot, 'scripts/repo-watch-prs.sh');

  for (const script of [watchRun, watchPrs]) {
    assert.ok(existsSync(script), `${script} must be bundled with the plugin`);
    assert.ok(
      statSync(script).mode & constants.X_OK,
      `${script} must remain executable`,
    );
  }

  const ciMonitor = readFileSync(
    join(pluginRoot, 'skills/github-ci-monitor/SKILL.md'),
    'utf8',
  );
  const landPr = readFileSync(
    join(pluginRoot, 'skills/land-pr/SKILL.md'),
    'utf8',
  );
  assert.match(ciMonitor, /scripts\/repo-watch-run\.cjs/);
  assert.match(ciMonitor, /scripts\/repo-watch-prs\.sh/);
  assert.match(landPr, /scripts\/repo-watch-prs\.sh/);

  const runUsage = spawnSync(process.execPath, [watchRun], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
  assert.equal(runUsage.status, 1);
  assert.match(runUsage.stderr, /^Usage: repo-watch-run/m);

  const prsUsage = spawnSync('bash', [watchPrs], {
    cwd: pluginRoot,
    encoding: 'utf8',
  });
  assert.equal(prsUsage.status, 1);
  assert.match(prsUsage.stderr, /^usage: watch-prs\.sh/m);
});

test('npm package includes the plugin watcher implementations used by its bin wrappers', () => {
  const packageJson = readJson('package.json');
  assert.ok(packageJson.files.includes('plugins/repo-tools/scripts'));
  assert.equal(packageJson.bin['repo-watch-run'], 'bin/watch-run.cjs');
  assert.equal(packageJson.bin['repo-watch-prs'], 'bin/watch-prs.sh');
});
