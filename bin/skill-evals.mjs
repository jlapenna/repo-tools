#!/usr/bin/env node
// Run a repository's skill evals through the stock Claude Code runner
// (`claude plugin eval`) without turning every skills directory into a plugin
// by hand.
//
// Skills are the `*/SKILL.md` directories below each --root (default: the
// current directory). Each skill's eval prompts stay in the skill-creator
// `evals.json` format the fleet already commits, found at
// `<skill>/evals/evals.json` or, for skills whose evals live outside the
// skill directory, `<evals-root>/<name>/evals.json` or
// `<evals-root>/*/<name>/evals.json`. A case is generated per eval entry in a
// temporary wrapper plugin: the prompt, a `tool_used` grader proving the
// skill fired, and an `llm` grader built from the entry's assertions
// (or its expected_output). Fixture files listed in `files` are copied into
// the case and granted read-only through `context.add_dirs`.
//
// Usage: repo-skill-evals [--root DIR]... [--evals-root DIR]... [--skill NAME]...
//                         [--list | --dry-run] [--out DIR] [--runs N]
//                         [--trigger-only] [--json] [-- <claude plugin eval options>]
// --list prints eval coverage and exits without running anything. --dry-run
// writes the wrapper plugin and prints the command instead of running it.
// Everything after `--` is passed to `claude plugin eval` (for example
// `--ablation with-without`, `--max-cost-usd 5`, `--case 'oncall--*'`).
// Exit status is the runner's (0 every case at threshold, 1 a case below
// threshold or a load failure, 2 partial), or 1 for a usage error.
// The wrapper is passed with --trust-plugin because it holds only copies of
// skills the caller chose to score; the runner's sandbox still applies, and a
// case's allowed_tools cannot grant Bash, Write, Edit, WebFetch or MCP tools
// without the operator's own `-- --allow-tools` grant.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const SKIP_DIRS = new Set(['node_modules', '.git', 'results', '.venv', 'dist', 'build']);
const MAX_DEPTH = 8;
const DEFAULT_TOOLS = ['Skill', 'Read', 'Glob', 'Grep'];
const CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function skillName(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const data = match ? parse(match[1], { uniqueKeys: true }) : undefined;
  const name = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : path.basename(path.dirname(file));
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) throw new Error(`${file}: skill name ${JSON.stringify(name)} is not lowercase letters, digits and hyphens`);
  return name;
}

export function discoverSkills(roots) {
  const skills = new Map();
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const file = path.join(dir, 'SKILL.md');
      const name = skillName(readFileSync(file, 'utf8'), file);
      if (skills.has(name)) throw new Error(`skill ${name} found twice: ${skills.get(name).dir} and ${dir}`);
      skills.set(name, { name, dir });
      return; // a skill does not nest skills
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) walk(path.resolve(root), 0);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function findEvals(skill, evalsRoots) {
  const candidates = [path.join(skill.dir, 'evals', 'evals.json')];
  for (const root of evalsRoots) {
    candidates.push(path.join(root, skill.name, 'evals.json'));
    let groups = [];
    try { groups = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no such root */ }
    for (const group of groups) candidates.push(path.join(root, group, skill.name, 'evals.json'));
  }
  return candidates.find((file) => existsSync(file));
}

export function loadEntries(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data?.evals)) throw new Error(`${file}: expected an object with an "evals" array`);
  return data.evals.map((entry, index) => {
    if (typeof entry?.prompt !== 'string' || !entry.prompt.trim()) throw new Error(`${file}: evals[${index}] has no prompt`);
    const checks = [entry.assertions, entry.expectations].find(Array.isArray) ?? [];
    return {
      slug: slug(entry.name ?? `eval-${entry.id ?? index + 1}`),
      prompt: entry.prompt.trim(),
      expected: typeof entry.expected_output === 'string' ? entry.expected_output.trim() : '',
      checks: checks.map(String).map((s) => s.trim()).filter(Boolean),
      files: Array.isArray(entry.files) ? entry.files.map(String) : [],
      options: runnerOptions(entry.plugin_eval, `${file}: evals[${index}].plugin_eval`),
    };
  });
}

// The runner validates these too, but a clear error here names the entry.
const LIMITS = { runs: [1, 50], max_turns: [1, 200], timeout_seconds: [1, 3600] };
function runnerOptions(raw, where) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const options = {};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (raw[key] === undefined) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max) throw new Error(`${where}.${key} must be an integer from ${min} to ${max}`);
    options[key] = raw[key];
  }
  if (raw.allowed_tools !== undefined) {
    if (!Array.isArray(raw.allowed_tools) || !raw.allowed_tools.every((t) => typeof t === 'string' && /^[A-Za-z][\w]*(?:\([^()]*\))?$/.test(t))) throw new Error(`${where}.allowed_tools must be a list of tool names`);
    // Gated tools (Bash, Write, Edit, WebFetch, mcp__*) still need the operator's `-- --allow-tools` grant; a case cannot widen it.
    options.allowed_tools = raw.allowed_tools;
  }
  return options;
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, '') || 'eval';

export function criteria(entry) {
  if (entry.checks.length) {
    return `PASS only if every one of the following holds for the response and its trace:\n${entry.checks.map((c) => `- ${c}`).join('\n')}\nFAIL if any of them does not hold.`;
  }
  if (entry.expected) return `PASS if the response does what this expected behavior describes:\n${entry.expected}\nFAIL if it does not, or if it only talks about doing it.`;
  return undefined;
}

export function buildCase(skill, entry, options) {
  const name = `${skill.name}--${entry.slug}`;
  if (!CASE_NAME.test(name)) throw new Error(`cannot derive a valid case name from ${name}`);
  const graders = [{
    name: 'skill-fired',
    type: 'tool_used',
    tool: 'Skill',
    input_match: `"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill.name.replaceAll('-', '\\-')}"`,
  }];
  const rubric = criteria(entry);
  if (rubric && !options.triggerOnly) graders.push({ name: 'criteria', type: 'llm', criteria: rubric });
  const execution = {
    prompt: entry.prompt,
    max_turns: options.triggerOnly ? 3 : entry.options.max_turns ?? 8,
    timeout_seconds: entry.options.timeout_seconds ?? 600,
    allowed_tools: entry.options.allowed_tools ?? DEFAULT_TOOLS,
  };
  const spec = { schema_version: '1.1', name, runs: options.runs ?? entry.options.runs ?? 1, expected_outcome: entry.expected || undefined, execution, graders };
  if (entry.files.length) spec.context = { add_dirs: ['resources'] };
  return spec;
}

// A fixture must live beside its evals.json; a path that escapes it (absolute,
// `..`, or a symlink out) would copy arbitrary files into the case workspace.
export function fixturePath(evalsFile, file) {
  const base = realpathSync(path.dirname(evalsFile));
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error(`${evalsFile}: fixture ${file} must be a relative path inside the evals directory`);
  const source = path.join(base, file);
  if (!existsSync(source)) throw new Error(`${evalsFile}: fixture ${file} does not exist`);
  const real = realpathSync(source);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error(`${evalsFile}: fixture ${file} resolves outside the evals directory`);
  return source;
}

export function writeWrapper(outDir, skills, options) {
  const plugin = path.join(outDir, 'plugin');
  mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: options.pluginName ?? 'skill-evals', description: 'Temporary wrapper generated by repo-skill-evals; skills are copies of their source directories.' }, null, 2) + '\n');
  const manifest = { skills: [], cases: [] };
  for (const skill of skills) {
    cpSync(skill.dir, path.join(plugin, 'skills', skill.name), { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) || src === skill.dir });
    manifest.skills.push({ name: skill.name, dir: skill.dir, evals: skill.evals ?? null, cases: skill.entries?.length ?? 0 });
    for (const entry of skill.entries ?? []) {
      const spec = buildCase(skill, entry, options);
      const caseDir = path.join(plugin, 'evals', spec.name);
      mkdirSync(caseDir, { recursive: true });
      for (const file of entry.files) {
        cpSync(fixturePath(skill.evals, file), path.join(caseDir, 'resources', path.basename(file)), { recursive: true, dereference: false });
      }
      // YAML is a superset of JSON, so the case file needs no YAML writer.
      writeFileSync(path.join(caseDir, 'case.yaml'), JSON.stringify(spec, null, 2) + '\n');
      manifest.cases.push({ name: spec.name, skill: skill.name });
    }
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { plugin, manifest };
}

export function summarize(results, manifest) {
  const bySkill = new Map(manifest.skills.map((s) => [s.name, { skill: s.name, evals: s.evals, cases: 0, runs: 0, fired: 0, scores: [], failed: [], errors: 0 }]));
  for (const c of results.cases ?? []) {
    const owner = manifest.cases.find((m) => m.name === c.name)?.skill;
    const row = bySkill.get(owner);
    if (!row) continue;
    row.cases += 1;
    if (typeof c.aggregates?.score === 'number') row.scores.push(c.aggregates.score);
    for (const run of c.arms?.with ?? []) {
      row.runs += 1;
      // Hitting max_turns is the design of a --trigger-only run, not a failure to run.
      if ((run.error && !/maximum number of turns/i.test(run.error)) || run.aborted) row.errors += 1;
      for (const g of run.graders ?? []) {
        if (g.name === 'skill-fired' && g.passed) row.fired += 1;
        if (g.passed === false && !row.failed.includes(`${c.name}/${g.name}`)) row.failed.push(`${c.name}/${g.name}`);
      }
    }
  }
  return [...bySkill.values()].map((row) => ({
    ...row,
    score: row.scores.length ? Number((row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(2)) : null,
  }));
}

const pad = (value, width) => String(value).padEnd(width);
export function renderTable(rows) {
  const lines = [`${pad('skill', 32)} ${pad('cases', 6)} ${pad('score', 6)} ${pad('fired', 8)} failed graders`];
  for (const r of rows) {
    const score = r.cases === 0 ? 'no evals' : r.score ?? '-';
    lines.push(`${pad(r.skill, 32)} ${pad(r.cases, 6)} ${pad(score, 6)} ${pad(r.runs ? `${r.fired}/${r.runs}` : '-', 8)} ${r.failed.join(', ')}${r.errors ? ` (${r.errors} run error${r.errors > 1 ? 's' : ''})` : ''}`);
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = { roots: [], evalsRoots: [], only: [], passthrough: [], list: false, dryRun: false, json: false, triggerOnly: false };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { options.passthrough = args.splice(0); break; }
    if (arg === '--root' && args.length) options.roots.push(args.shift());
    else if (arg === '--evals-root' && args.length) options.evalsRoots.push(args.shift());
    else if (arg === '--skill' && args.length) options.only.push(args.shift());
    else if (arg === '--out' && args.length) options.out = path.resolve(args.shift());
    else if (arg === '--runs' && args.length) {
      options.runs = Number(args.shift());
      if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) throw new Error('--runs takes an integer from 1 to 50');
    } else if (arg === '--list') options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--trigger-only') options.triggerOnly = true;
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (!options.roots.length) options.roots.push(process.cwd());
  return options;
}

export function plan(options) {
  const skills = discoverSkills(options.roots).filter((s) => !options.only.length || options.only.includes(s.name));
  for (const name of options.only) if (!skills.some((s) => s.name === name)) throw new Error(`no skill named ${name} under ${options.roots.join(', ')}`);
  for (const skill of skills) {
    skill.evals = findEvals(skill, options.evalsRoots) ?? null;
    skill.entries = skill.evals ? loadEntries(skill.evals) : [];
  }
  return skills;
}

export function main(argv, { log = console.log, spawn = spawnSync } = {}) {
  const options = parseArgs(argv);
  const skills = plan(options);
  if (!skills.length) throw new Error(`no SKILL.md found under ${options.roots.join(', ')}`);
  const withEvals = skills.filter((s) => s.entries.length);
  if (options.list) {
    const rows = skills.map((s) => ({ skill: s.name, evals: s.evals, cases: s.entries.length, runs: 0, fired: 0, failed: [], errors: 0, score: null }));
    log(options.json ? JSON.stringify({ skills: rows }, null, 2) : `${renderTable(rows)}\n\n${withEvals.length}/${skills.length} skills have evals (${withEvals.reduce((n, s) => n + s.entries.length, 0)} cases)`);
    return 0;
  }
  if (!withEvals.length) throw new Error(`none of the ${skills.length} skills has an evals.json; use --list to see them`);
  const outDir = options.out ?? mkdtempSync(path.join(tmpdir(), 'repo-skill-evals-'));
  mkdirSync(outDir, { recursive: true });
  const { plugin, manifest } = writeWrapper(outDir, withEvals, options);
  const resultsFile = path.join(outDir, 'results.json');
  const command = ['claude', ['plugin', 'eval', plugin, '--trust-plugin', '--no-publish', '--json', resultsFile, '--output-dir', path.join(outDir, 'results'), ...options.passthrough]];
  if (options.dryRun) {
    log(`${manifest.cases.length} cases for ${withEvals.length} skills written under ${plugin}\n${command[0]} ${command[1].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return 0;
  }
  // The nested runner is non-interactive; the parent session's marker would only make it refuse to start.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE'));
  const run = spawn(command[0], command[1], { cwd: plugin, stdio: ['ignore', 'inherit', 'inherit'], env });
  if (run.error) throw new Error(`could not run claude: ${run.error.message}`);
  if (!existsSync(resultsFile)) throw new Error(`claude plugin eval exited ${run.status} without writing ${resultsFile}`);
  const results = JSON.parse(readFileSync(resultsFile, 'utf8'));
  const rows = summarize(results, manifest);
  const summary = { ok: run.status === 0, exit: run.status, partial: results.partial ?? false, partialReason: results.partialReason ?? null, costUsd: results.costUsd ?? null, durationSeconds: results.durationSeconds ?? null, out: outDir, skills: rows };
  log(options.json ? JSON.stringify(summary, null, 2) : `\n${renderTable(rows)}\n\nexit ${run.status}${results.partial ? ` (partial: ${results.partialReason})` : ''}, cost $${Number(results.costUsd ?? 0).toFixed(2)}, ${results.durationSeconds ?? '?'}s, results in ${outDir}`);
  return run.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
