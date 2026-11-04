// Protected contract: repo-skill-evals turns the fleet's committed
// skill-creator `evals.json` files into `claude plugin eval` cases inside a
// wrapper plugin, so every repository's skills can be scored by the stock
// runner without hand-made plugin manifests. Consumer: `pnpm test` in ci.yml
// and the skill-evals skill, which tells agents to run this command.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCase, discoverSkills, findEvals, fixturePath, loadEntries, main, parseArgs, renderTable, summarize, writeWrapper } from './skill-evals.mjs';

const script = fileURLToPath(new URL('./skill-evals.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-evals-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  write('repo/.agents/skills/oncall/SKILL.md', '---\nname: oncall\ndescription: Triage alerts.\n---\n# Oncall\n');
  write('repo/.agents/skills/oncall/evals/evals.json', JSON.stringify({ skill_name: 'oncall', evals: [
    { id: 1, prompt: 'Headscale probe is failing, what now?', expected_output: 'Checks logs first.', files: ['files/probe.log'], assertions: ['Reads the probe log', 'Names the failing unit'] },
    { id: 2, name: 'Memory alert', prompt: 'SparkMemoryCriticallyLow fired.', expected_output: 'Stops the model container.', files: [] },
  ] }));
  write('repo/.agents/skills/oncall/evals/files/probe.log', 'probe failed\n');
  write('repo/.agents/skills/oncall/evals/results/old/report.html', '<html>');
  write('repo/skills/land-pr/SKILL.md', '---\nname: land-pr\ndescription: Land it.\n---\n');
  write('repo/skills/plain/SKILL.md', '---\ndescription: No name field, so the directory names it.\n---\n');
  write('repo/skills/handoff/SKILL.md', '---\nname: handoff\ndescription: Write a handoff.\ndisable-model-invocation: true\n---\n');
  write('repo/skills/handoff/evals/evals.json', JSON.stringify({ evals: [{ id: 1, prompt: 'Write the handoff.', assertions: ['Names the next step'] }, { id: 2, prompt: 'Trigger only.', expected_output: 'Writes it.' }] }));
  write('repo/node_modules/dep/skills/ignored/SKILL.md', '---\nname: ignored\ndescription: x\n---\n');
  write('central/repo/land-pr/evals.json', JSON.stringify({ skill_name: 'land-pr', evals: [{ id: 1, prompt: 'Land PR 7.', expectations: ['Waits for CI'], plugin_eval: { max_turns: 2, allowed_tools: ['Skill'] } }] }));
  return { root, write };
}

test('discovers skills below roots, skipping dependencies and nested results', (t) => {
  const { root } = fixture(t);
  const skills = discoverSkills([path.join(root, 'repo')]);
  assert.deepEqual(skills.map((s) => s.name), ['handoff', 'land-pr', 'oncall', 'plain']);
  assert.deepEqual(skills.map((s) => s.manualOnly), [true, false, false, false]);
  assert.equal(findEvals(skills[2], []), path.join(root, 'repo/.agents/skills/oncall/evals/evals.json'));
  assert.equal(findEvals(skills[1], []), undefined);
  assert.equal(findEvals(skills[1], [path.join(root, 'central')]), path.join(root, 'central/repo/land-pr/evals.json'));
});

test('rejects a skill name that would not be a valid plugin skill', (t) => {
  const { root, write } = fixture(t);
  write('bad/Bad_Name/SKILL.md', '---\nname: Bad_Name\ndescription: x\n---\n');
  assert.throws(() => discoverSkills([path.join(root, 'bad')]), /Bad_Name/);
});

test('builds a case per eval entry with a skill-fired grader and a rubric from assertions', (t) => {
  const { root } = fixture(t);
  const skill = { name: 'oncall', dir: path.join(root, 'repo/.agents/skills/oncall') };
  const entries = loadEntries(path.join(skill.dir, 'evals/evals.json'));
  assert.deepEqual(entries.map((e) => e.slug), ['eval-1', 'memory-alert']);
  const first = buildCase(skill, entries[0], {});
  assert.equal(first.name, 'oncall--eval-1');
  assert.equal(first.schema_version, '1.1');
  assert.equal(first.runs, 1);
  assert.deepEqual(first.context, { add_dirs: ['resources'] });
  assert.deepEqual(first.execution.allowed_tools, ['Skill', 'Read', 'Glob', 'Grep']);
  assert.equal(first.graders[0].type, 'tool_used');
  assert.match('{"skill":"homelab-skills:oncall"}', new RegExp(first.graders[0].input_match));
  assert.doesNotMatch('{"skill":"oncall-extra"}', new RegExp(first.graders[0].input_match));
  assert.equal(first.graders[1].type, 'llm');
  assert.match(first.graders[1].criteria, /- Reads the probe log\n- Names the failing unit/);
  const second = buildCase(skill, entries[1], { runs: 3 });
  assert.equal(second.runs, 3);
  assert.equal(second.context, undefined);
  assert.match(second.graders[1].criteria, /Stops the model container/);
  assert.equal(buildCase(skill, entries[1], { triggerOnly: true }).graders.length, 1);
  assert.equal(buildCase(skill, entries[1], { triggerOnly: true }).execution.max_turns, 3);
  const manual = { name: 'handoff', dir: path.join(root, 'repo/skills/handoff'), manualOnly: true };
  const manualEntries = loadEntries(path.join(manual.dir, 'evals/evals.json'));
  assert.deepEqual(buildCase(manual, manualEntries[0], {}).graders.map((g) => g.name), ['criteria'], 'a manual-only skill is graded on behavior, never on firing');
  assert.throws(() => buildCase(manual, { ...manualEntries[1], expected: '' }, {}), /nothing to grade/);
  const central = loadEntries(path.join(root, 'central/repo/land-pr/evals.json'))[0];
  const landed = buildCase({ name: 'land-pr', dir: '' }, central, {});
  assert.deepEqual(landed.execution.allowed_tools, ['Skill']);
  assert.equal(landed.execution.max_turns, 2);
  assert.match(landed.graders[1].criteria, /Waits for CI/);
});

test('fixtures must stay inside the evals directory and runner overrides stay in range', (t) => {
  const { root, write } = fixture(t);
  const evals = path.join(root, 'repo/.agents/skills/oncall/evals/evals.json');
  assert.equal(fixturePath(evals, 'files/probe.log').source, realpathSync(path.join(root, 'repo/.agents/skills/oncall/evals/files/probe.log')));
  assert.throws(() => fixturePath(evals, '../SKILL.md'), /inside the evals directory/);
  assert.throws(() => fixturePath(evals, '/etc/hostname'), /inside the evals directory/);
  assert.throws(() => fixturePath(evals, 'files/missing'), /does not exist/);
  mkdirSync(path.join(root, 'repo/.agents/skills/oncall/evals/files'), { recursive: true });
  symlinkSync(path.join(root, 'repo/skills/land-pr/SKILL.md'), path.join(root, 'repo/.agents/skills/oncall/evals/files/escape'));
  assert.throws(() => fixturePath(evals, 'files/escape'), /outside the evals directory/);
  mkdirSync(path.join(root, 'repo/.agents/skills/oncall/evals/files/tree'), { recursive: true });
  symlinkSync(path.join(root, 'repo/skills/land-pr'), path.join(root, 'repo/.agents/skills/oncall/evals/files/tree/nested'));
  write('repo/.agents/skills/oncall/evals/evals.json', JSON.stringify({ evals: [{ prompt: 'x', files: ['files/tree'] }] }));
  const skill = { name: 'oncall', dir: path.join(root, 'repo/.agents/skills/oncall'), evals, entries: loadEntries(evals) };
  assert.throws(() => writeWrapper(path.join(root, 'out-escape'), [skill], {}), /links outside the evals directory \(nested\)/);
  write('bad/evals.json', JSON.stringify({ evals: [{ prompt: 'x', plugin_eval: { max_turns: 999 } }] }));
  assert.throws(() => loadEntries(path.join(root, 'bad/evals.json')), /max_turns must be an integer from 1 to 200/);
  write('bad/evals.json', JSON.stringify({ evals: [{ prompt: 'x', plugin_eval: { allowed_tools: ['Bash; rm -rf /'] } }] }));
  assert.throws(() => loadEntries(path.join(root, 'bad/evals.json')), /allowed_tools must be a list of tool names/);
  write('bad/evals.json', JSON.stringify({ evals: [{ prompt: 'x', plugin_eval: { allowed_tools: ['Bash(git status)', 'mcp__x__y'] } }] }));
  assert.deepEqual(loadEntries(path.join(root, 'bad/evals.json'))[0].options.allowed_tools, ['Bash(git status)', 'mcp__x__y']);
});

test('real CLI lists coverage and writes a runnable wrapper plugin on --dry-run', (t) => {
  const { root } = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: path.join(root, 'repo') });
  const list = run('--list', '--evals-root', path.join(root, 'central'));
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^land-pr\s+1\s/m);
  assert.match(list.stdout, /^oncall\s+2\s/m);
  assert.match(list.stdout, /^plain\s+0\s+no evals/m);
  assert.match(list.stdout, /^handoff\s+2\s/m);
  assert.match(list.stdout, /3\/4 skills have evals \(5 cases\)/);
  const trigger = run('--list', '--trigger-only');
  assert.match(trigger.stdout, /^handoff\s+0\s+no evals\s+manual/m, 'manual-only skills drop out of a trigger-only run');
  const out = path.join(root, 'out');
  const dry = run('--dry-run', '--out', out, '--evals-root', path.join(root, 'central'), '--', '--ablation', 'none');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /5 cases for 3 skills/);
  assert.match(dry.stdout, /claude plugin eval .* --trust-plugin --no-publish --json .*results\.json --output-dir .* --ablation none$/m);
  const plugin = path.join(out, 'plugin');
  assert.equal(JSON.parse(readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')).name, 'skill-evals');
  assert.ok(existsSync(path.join(plugin, 'skills/oncall/SKILL.md')));
  assert.ok(!existsSync(path.join(plugin, 'skills/oncall/evals/results')), 'old results are not copied into the wrapper');
  assert.ok(!existsSync(path.join(plugin, 'skills/plain')), 'skills without evals stay out of the wrapper');
  const spec = JSON.parse(readFileSync(path.join(plugin, 'evals/oncall--eval-1/case.yaml'), 'utf8'));
  assert.equal(spec.execution.prompt, 'Headscale probe is failing, what now?');
  assert.equal(readFileSync(path.join(plugin, 'evals/oncall--eval-1/resources/probe.log'), 'utf8'), 'probe failed\n');
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')).cases.map((c) => c.skill), ['handoff', 'handoff', 'land-pr', 'oncall', 'oncall']);
  const only = run('--list', '--skill', 'oncall');
  assert.match(only.stdout, /1\/1 skills have evals/);
  assert.equal(run('--list', '--skill', 'nope').status, 1);
  assert.equal(run('--bogus').status, 1);
});

test('summarizes runner results per skill', () => {
  const manifest = { skills: [{ name: 'oncall', evals: 'e', cases: 2 }, { name: 'plain', evals: null, cases: 0 }], cases: [{ name: 'oncall--eval-1', skill: 'oncall' }, { name: 'oncall--memory-alert', skill: 'oncall' }] };
  const results = { cases: [
    { name: 'oncall--eval-1', aggregates: { score: 1 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: true }] }] } },
    { name: 'oncall--memory-alert', aggregates: { score: 0.5 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: false }, { name: 'criteria', passed: true }] }, { error: 'boom', graders: [] }, { error: 'exit 1: Reached maximum number of turns (3)', graders: [{ name: 'skill-fired', passed: true }] }] } },
  ] };
  const rows = summarize(results, manifest);
  assert.equal(rows[0].score, 0.75);
  assert.equal(rows[0].fired, 2);
  assert.equal(rows[0].runs, 4);
  assert.equal(rows[0].errors, 1);
  assert.deepEqual(rows[0].failed, ['oncall--memory-alert/skill-fired']);
  assert.equal(rows[1].cases, 0);
  assert.match(renderTable(rows), /^oncall\s+2\s+0\.75\s+2\/4\s+oncall--memory-alert\/skill-fired \(1 run error\)$/m);
  assert.match(renderTable(rows), /^plain\s+0\s+no evals/m);
});

test('runs the stock runner from the wrapper and propagates its exit status', (t) => {
  const { root } = fixture(t);
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    const results = args[args.indexOf('--json') + 1];
    writeFileSync(results, JSON.stringify({ costUsd: 0.5, durationSeconds: 9, cases: [{ name: 'oncall--eval-1', aggregates: { score: 0 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: false }] }] } }] }));
    assert.equal(opts.stdio[1], 'pipe', '--json keeps the runner progress lines out of stdout');
    return { status: 1, stdout: 'Wrote results.json\n' };
  };
  const logs = [];
  process.env.CLAUDECODE = '1';
  const status = main(['--root', path.join(root, 'repo'), '--out', path.join(root, 'out'), '--skill', 'oncall', '--json'], { log: (m) => logs.push(m), spawn });
  assert.equal(status, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].cwd, path.join(root, 'out/plugin'));
  assert.equal(calls[0].env.CLAUDECODE, undefined);
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.ok, false);
  assert.equal(summary.costUsd, 0.5);
  assert.deepEqual(summary.skills[0].failed, ['oncall--eval-1/skill-fired']);
  assert.equal(readFileSync(path.join(root, 'out/runner.log'), 'utf8'), 'Wrote results.json\n');
  assert.throws(() => parseArgs(['--runs', '0']), /--runs/);
});
