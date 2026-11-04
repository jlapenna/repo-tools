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
import { findRuns, readRun } from './eval-history.mjs';
import { buildCase, compareBaseline, discoverSkills, findEvals, fixturePath, gatedTool, loadBaseline, loadEntries, main, parseArgs, renderTable, summarize, writeWrapper } from './skill-evals.mjs';

const script = fileURLToPath(new URL('./skill-evals.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-evals-'));
  const originalHistory = process.env.EVAL_HISTORY_DIR;
  process.env.EVAL_HISTORY_DIR = path.join(root, 'history');
  t.after(() => { if (originalHistory === undefined) delete process.env.EVAL_HISTORY_DIR; else process.env.EVAL_HISTORY_DIR = originalHistory; });
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
  assert.equal(buildCase(manual, manualEntries[0], {}).execution.prompt, '/handoff Write the handoff.', 'a manual-only case invokes the skill the way a user does');
  assert.equal(buildCase(skill, entries[0], {}).execution.prompt, entries[0].prompt);
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
  write('bad/evals.json', JSON.stringify({ evals: [{ prompt: 'x', assertions: [{ name: 'Names the host', type: 'llm' }, { text: 'Refuses to deploy' }, 'plain'] }] }));
  assert.deepEqual(loadEntries(path.join(root, 'bad/evals.json'))[0].checks, ['Names the host', 'Refuses to deploy', 'plain']);
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
  assert.match(dry.stdout, /claude plugin eval .* --trust-plugin --no-publish --keep-temp --json .*results\.json --output-dir .* --ablation none$/m);
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

test('default runs persist snapshots and results, warn about prior identical work, and archive only selected traces', t => {
  const { root, write } = fixture(t);
  write('sandbox/config/private-auth.json', 'DO NOT COPY SDK STATE');
  write('sandbox/out/trace.jsonl', '{"type":"result"}\n');
  const outputs = [], warnings = [];
  const spawn = (cmd, args) => {
    writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify({ costUsd: 0.1, cases: [{ name: 'oncall--eval-1', arms: { with: [{ tracePath: path.join(root, 'sandbox/out/trace.jsonl'), graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: true }] }] }, aggregates: { score: 1 } }] }));
    return { status: 0, stdout: '' };
  };
  const args = ['--root', path.join(root, 'repo'), '--skill', 'oncall', '--json'];
  main(args, { spawn, log: s => outputs.push(JSON.parse(s)), warn: s => warnings.push(s) });
  assert.ok(outputs[0].out.startsWith(path.join(root, 'history/work')));
  const store = path.join(root, 'history');
  const record = readRun(store, outputs[0].history.id);
  assert.equal(record.status, 'completed');
  assert.ok(record.artifacts.some(f => f.source.endsWith('SKILL.md')));
  assert.ok(record.artifacts.some(f => f.source.endsWith('trace.jsonl')));
  assert.ok(!record.artifacts.some(f => f.source.includes('private-auth')));
  rmSync(outputs[0].out, { recursive: true });
  const result = record.artifacts.find(f => f.source.endsWith('results.json'));
  assert.equal(JSON.parse(readFileSync(path.join(store, 'runs', record.id, result.path))).costUsd, 0.1);
  main(args, { spawn, log: s => outputs.push(JSON.parse(s)), warn: s => warnings.push(s) });
  assert.equal(outputs[1].history.previous[0], record.id);
  assert.match(warnings[0], /recent matching/);
});

test('stock temporary traces survive archive while owned SDK state is cleaned, with explicit debug opt-out', t => {
  const { root } = fixture(t);
  const run = keep => {
    const temp = mkdtempSync(path.join(tmpdir(), 'claude-eval-history-test-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    mkdirSync(path.join(temp, 'out')); mkdirSync(path.join(temp, 'config'));
    const trace = path.join(temp, 'out/trace.jsonl');
    writeFileSync(trace, 'native trace bytes\n');
    writeFileSync(path.join(temp, 'config/private-auth'), 'NEVER ARCHIVE THIS');
    let summary;
    const spawn = (cmd, args) => {
      assert.equal(args.filter(a => a === '--keep-temp').length, 1);
      writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify({ cases: [{ name: 'oncall--eval-1', arms: { with: [{ tracePath: trace, graders: [] }] }, aggregates: { score: 1 } }] }));
      return { status: 0, stdout: '' };
    };
    main(['--root', path.join(root, 'repo'), '--skill', 'oncall', '--json', ...(keep ? ['--', '--keep-temp'] : [])], { spawn, log: s => { summary = JSON.parse(s); }, warn: () => {} });
    const record = readRun(summary.history.store, summary.history.id);
    assert.ok(!record.artifacts.some(a => a.source.includes('private-auth')));
    const saved = record.artifacts.find(a => a.source === trace);
    assert.equal(readFileSync(path.join(summary.history.store, 'runs', record.id, saved.path), 'utf8'), 'native trace bytes\n');
    assert.equal(existsSync(temp), keep);
  };
  run(false); run(true);
});

test('runner startup errors retain a failed attempt without masking the original failure', t => {
  const { root } = fixture(t);
  assert.throws(() => main(['--root', path.join(root, 'repo'), '--skill', 'oncall'], { spawn: () => ({ error: new Error('CLI unavailable') }) }), /CLI unavailable/);
  const records = findRuns({ root: path.join(root, 'history') });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'failed');
  assert.ok(records[0].artifacts.length > 0);
});

test('refuses a committed case that grants a gated tool unless --allow-gated-tools', (t) => {
  const { root, write } = fixture(t);
  const skill = { name: 'oncall', dir: path.join(root, 'repo/.agents/skills/oncall') };
  for (const tool of ['Bash', 'Bash(git status)', 'PowerShell', 'Write', 'Edit', 'WebFetch', 'mcp__home__ha_get_state']) {
    write('gated/evals.json', JSON.stringify({ evals: [{ name: 'shell', prompt: 'Run it.', assertions: ['Runs'], plugin_eval: { allowed_tools: ['Skill', tool] } }] }));
    const [entry] = loadEntries(path.join(root, 'gated/evals.json'));
    assert.throws(() => buildCase(skill, entry, {}), (error) => {
      assert.match(error.message, /^oncall: case oncall--shell grants the tool /);
      assert.ok(error.message.includes(tool), `names ${tool}`);
      assert.match(error.message, /no sandbox in LCARS worker pods/);
      assert.match(error.message, /must not be committed/);
      return true;
    }, tool);
    assert.deepEqual(buildCase(skill, entry, { allowGatedTools: true }).execution.allowed_tools, ['Skill', tool]);
  }
  assert.equal(gatedTool(['Skill', 'Read', 'Glob', 'Grep', 'WebSearch']), undefined, 'the default tools and other ungated tools pass');
  const safe = loadEntries(path.join(root, 'repo/.agents/skills/oncall/evals/evals.json'))[0];
  assert.deepEqual(buildCase(skill, safe, {}).execution.allowed_tools, ['Skill', 'Read', 'Glob', 'Grep'], 'the default allowed tools are unchanged');
  assert.equal(parseArgs(['--allow-gated-tools']).allowGatedTools, true);
  assert.equal(parseArgs([]).allowGatedTools, false);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: path.join(root, 'repo') });
  write('repo/.agents/skills/oncall/evals/evals.json', JSON.stringify({ evals: [{ name: 'shell', prompt: 'Run it.', assertions: ['Runs'], plugin_eval: { allowed_tools: ['Bash'] } }] }));
  const refused = run('--dry-run', '--skill', 'oncall', '--out', path.join(root, 'out-refused'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /oncall--shell grants the tool Bash/);
  assert.equal(run('--dry-run', '--skill', 'oncall', '--out', path.join(root, 'out-allowed'), '--allow-gated-tools').status, 0);
});

test('compares per-skill rows with a baseline, regressions first', (t) => {
  const { root, write } = fixture(t);
  const row = (skill, score, fired, runs, extra = {}) => ({ skill, score, fired, runs, cases: 1, manualOnly: false, failed: [], errors: 0, ...extra });
  const rows = [row('a', 0.5, 1, 2), row('b', 1, 2, 2), row('c', 1, 2, 2), row('d', null, 0, 0, { cases: 0 }), row('m', 0.5, 0, 2, { manualOnly: true }), row('new', 1, 1, 1)];
  const baseline = { skills: [row('a', 1, 2, 2), row('b', 0.5, 2, 2), row('c', 1, 2, 2), row('d', null, 0, 0, { cases: 0 }), row('m', 0.5, 0, 1, { manualOnly: true }), row('gone', 1, 1, 1)] };
  const comparison = compareBaseline(rows, baseline);
  assert.deepEqual(comparison.regressions, [{ skill: 'a', score: 0.5, previousScore: 1, fired: 1, runs: 2, previousFired: 2, previousRuns: 2 }]);
  assert.deepEqual(comparison.improvements.map((c) => c.skill), ['b']);
  assert.equal(comparison.unchanged, 3, 'equal scores, no-eval skills and manual-only skills (never fired) count as unchanged');
  assert.deepEqual(comparison.new, ['new']);
  assert.deepEqual(comparison.removed, ['gone']);
  assert.deepEqual(compareBaseline([row('x', 1, 1, 1)], { skills: [row('x', 0.5, 1, 1), row('x-fired', 1, 1, 1)] }).regressions, []);
  assert.deepEqual(compareBaseline([row('f', 1, 1, 2)], { skills: [row('f', 1, 2, 2)] }).regressions.map((c) => c.skill), ['f'], 'a fired-rate drop alone is a regression');
  write('baseline/result.json', JSON.stringify({ report: '# x', complete: true, data: { skills: [row('a', 1, 2, 2)] } }));
  write('baseline/data.json', JSON.stringify({ skills: [row('a', 1, 2, 2)] }));
  assert.equal(loadBaseline(path.join(root, 'baseline/result.json')).skills[0].skill, 'a', 'accepts a whole result.json');
  assert.equal(loadBaseline(path.join(root, 'baseline/data.json')).skills[0].skill, 'a', 'accepts the data object alone');
  assert.throws(() => loadBaseline(path.join(root, 'baseline/missing.json')), /--baseline .*missing\.json: ENOENT/);
  write('baseline/bad.json', '{not json');
  assert.throws(() => loadBaseline(path.join(root, 'baseline/bad.json')), /--baseline .*bad\.json: /);
  write('baseline/shape.json', JSON.stringify({ skills: 'nope' }));
  assert.throws(() => loadBaseline(path.join(root, 'baseline/shape.json')), /"skills" array/);
});

test('writes a Markdown job report and result.json with the baseline comparison', (t) => {
  const { root, write } = fixture(t);
  write('repo/.agents/skills/oncall/evals/evals.json', JSON.stringify({ evals: [
    { name: 'probe', prompt: `Headscale probe is failing, ${'x'.repeat(400)}`, assertions: ['Reads the probe log'] },
    { name: 'memory', prompt: 'SparkMemoryCriticallyLow fired.', assertions: ['Stops the container'] },
  ] }));
  const spawn = (cmd, args) => {
    writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify({ claudeVersion: '2.1.318', costUsd: 0.5, durationSeconds: 9, partial: true, partialReason: 'cost ceiling', aggregates: { casesTotal: 4, casesPassed: 1 }, cases: [
      { name: 'oncall--probe', promptMarkdown: `Headscale probe is failing, ${'x'.repeat(400)}`, aggregates: { score: 0.5 }, arms: { with: [
        { graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: false, explanation: 'judge votes: FAIL', evidence: `${'e'.repeat(700)}` }] },
        { error: 'boom', graders: [] },
      ] } },
      { name: 'oncall--memory', aggregates: { score: 1 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: true }] }] } },
      { name: 'handoff--eval-1', aggregates: { score: 0.5 }, arms: { with: [{ graders: [{ name: 'criteria', passed: false, explanation: 'judge votes: FAIL PASS' }] }] } },
      { name: 'handoff--eval-2', aggregates: { score: 1 }, arms: { with: [{ graders: [{ name: 'criteria', passed: true }] }] } },
    ] }));
    return { status: 2, stdout: '' };
  };
  const probes = [];
  const exec = (cmd, args, opts) => {
    probes.push({ cmd, cwd: opts.cwd });
    if (cmd === 'git') return { status: 0, stdout: 'abc1234\n' };
    return { error: new Error('ENOENT') };
  };
  write('baseline.json', JSON.stringify({ report: '', complete: true, data: { skills: [
    { skill: 'oncall', score: 1, fired: 2, runs: 2, cases: 2 }, { skill: 'handoff', score: 0.75, fired: 0, runs: 2, cases: 2, manualOnly: true }, { skill: 'retired', score: 1, fired: 1, runs: 1, cases: 1 },
  ] } }));
  const logs = [];
  const status = main(['--root', path.join(root, 'repo'), '--out', path.join(root, 'out'), '--report', path.join(root, 'job'), '--baseline', path.join(root, 'baseline.json'), '--json'], { log: (m) => logs.push(m), spawn, exec });
  assert.equal(status, 2);
  assert.deepEqual(probes.map((p) => p.cmd), ['git', 'claude']);
  assert.equal(probes[0].cwd, path.join(root, 'repo'), 'the revision comes from the first root');
  const result = JSON.parse(readFileSync(path.join(root, 'job/result.json'), 'utf8'));
  const report = readFileSync(path.join(root, 'job/report.md'), 'utf8');
  assert.equal(result.report, report);
  assert.equal(result.complete, false, 'a partial run is not complete');
  assert.equal(result.data.exit, 2);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.partialReason, 'cost ceiling');
  assert.equal(result.data.costUsd, 0.5);
  assert.equal(result.data.durationSeconds, 9);
  assert.equal(result.data.casesTotal, 4);
  assert.equal(result.data.casesPassed, 1);
  assert.deepEqual(result.data.skills.map((s) => s.skill), ['handoff', 'land-pr', 'oncall', 'plain']);
  assert.deepEqual(result.data.baseline.regressions.map((c) => c.skill), ['oncall']);
  assert.equal(result.data.baseline.unchanged, 1, 'a manual-only skill with the same score is unchanged');
  assert.deepEqual(result.data.baseline.new, ['land-pr', 'plain']);
  assert.deepEqual(result.data.baseline.removed, ['retired']);
  assert.match(report, /^# Skill evals report\n/);
  assert.match(report, new RegExp(`- Roots: \`${path.join(root, 'repo')}\``));
  assert.match(report, /- Revision: `abc1234`/);
  assert.match(report, /- Runner: 2\.1\.318 \(Claude Code\)/, 'falls back to the runner version recorded in results.json');
  assert.match(report, /- Date: \d{4}-\d{2}-\d{2}T/);
  assert.match(report, /- Exit: 2 \(partial: cost ceiling\)/);
  assert.match(report, /- Cases passed: 1\/4/);
  assert.match(report, /list-price cost estimate \(not billed spend\): \$0\.50/);
  assert.doesNotMatch(report, /spent/i);
  assert.match(report, /\| Skill \| Cases \| Score \| Fired \| Failed graders \| Run errors \|/);
  assert.match(report, /\| oncall \| 2 \| 0\.75 \| 2\/3 \| oncall--probe\/criteria \| 1 \|/);
  assert.match(report, /\| plain \| 0 \| no evals \| - \|  \| 0 \|/);
  assert.match(report, /\| handoff \| 2 \| 0\.75 \| manual \| handoff--eval-1\/criteria \| 0 \|/);
  assert.match(report, /## Skills without evals\n\n- land-pr\n- plain\n/);
  assert.match(report, /## Runs that errored\n\n- oncall--probe \(run 2\): boom\n/);
  assert.match(report, /## Changes since baseline\n\n### Regressions \(1\)\n\n- oncall: score 1 -> 0\.75, fired 2\/2 -> 2\/3\n\n### Improvements \(0\)\n\n- none\n\n- Unchanged: 1\n/);
  assert.ok(report.indexOf('### Regressions') < report.indexOf('### Improvements'), 'regressions come first');
  assert.match(report, /- New skills: land-pr, plain\n- Removed skills: retired\n/);
  assert.match(report, /## Failures\n\n### oncall\n\nfired 2\/3\n\n#### oncall--probe\n\nPrompt:\n\n```text\nHeadscale probe is failing, x+…\n```\n/);
  assert.match(report, /- `criteria` failed in run 1: judge votes: FAIL\n\n```text\ne{600}…\n```/);
  assert.doesNotMatch(report, /x{301}/, 'prompts are clipped to 300 characters');
  assert.doesNotMatch(report, /e{601}/, 'evidence is clipped to 600 characters');
  assert.doesNotMatch(report, /#### oncall--memory/, 'passing cases are not listed');
  assert.doesNotMatch(report, /### handoff\n/, 'a manual-only skill at 0.75 with no fired expectation is not a failure');
  const summary = JSON.parse(logs[0]);
  assert.equal(summary.report, path.join(root, 'job'));
  assert.deepEqual(summary.baseline.removed, ['retired']);
});

test('--report also works with the table output and marks a clean run complete', (t) => {
  const { root } = fixture(t);
  const spawn = (cmd, args) => {
    writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify({ costUsd: 0.1, durationSeconds: 3, aggregates: { casesTotal: 2, casesPassed: 2 }, cases: [
      { name: 'oncall--eval-1', aggregates: { score: 1 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: true }] }] } },
      { name: 'oncall--memory-alert', aggregates: { score: 1 }, arms: { with: [{ graders: [{ name: 'skill-fired', passed: true }, { name: 'criteria', passed: true }] }] } },
    ] }));
    return { status: 0, stdout: '' };
  };
  const exec = (cmd) => (cmd === 'claude' ? { status: 0, stdout: '2.1.318 (Claude Code)\n' } : { status: 128, stdout: '' });
  const logs = [];
  const status = main(['--root', path.join(root, 'repo'), '--skill', 'oncall', '--out', path.join(root, 'out'), '--report', path.join(root, 'job')], { log: (m) => logs.push(m), spawn, exec });
  assert.equal(status, 0);
  assert.match(logs[0], /^oncall\s+2\s+1\s+2\/2/m);
  assert.match(logs[0], /runner cost estimate \$0\.10 \(list price, not billed spend\)/);
  assert.match(logs[0], new RegExp(`report in ${path.join(root, 'job')}`));
  const result = JSON.parse(readFileSync(path.join(root, 'job/result.json'), 'utf8'));
  assert.equal(result.complete, true);
  assert.equal(result.data.baseline, null);
  assert.match(result.report, /- Runner: 2\.1\.318 \(Claude Code\)/);
  assert.doesNotMatch(result.report, /- Revision:/, 'no revision line when the root is not a repository');
  assert.match(result.report, /## Runs that errored\n\n- none\n$/, 'the report ends after the last section with one newline');
  assert.doesNotMatch(result.report, /## Failures/);
  assert.throws(() => main(['--root', path.join(root, 'repo'), '--baseline', path.join(root, 'nope.json')], { spawn: () => assert.fail('a bad baseline must fail before the runner starts'), exec }), /--baseline .*nope\.json/);
});
