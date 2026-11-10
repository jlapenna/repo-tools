#!/usr/bin/env node
// Run shared repository skill evals through built-in Codex/Claude runners or
// an explicitly selected harness adapter.
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
// Usage: repo-skill-evals [--runner NAME] [--adapter EXECUTABLE] [--root DIR]... [--evals-root DIR]... [--skill NAME]...
//                         [--list | --dry-run] [--out DIR] [--runs N]
//                         [--trigger-only] [--json] [--report DIR] [--baseline FILE]
//                         [--max-age DAYS] [--no-carry] [--cache [DIR]]
//                         [--allow-gated-tools] [-- <runner options>]
// --list prints eval coverage and exits without running anything. --dry-run
// writes the wrapper plugin and prints the command instead of running it.
// --report writes `<dir>/report.md` (a Markdown job report) and
// `<dir>/result.json` ({ report, complete, data }) for automation such as an
// LCARS recipe. --baseline compares the per-skill rows with a previous
// result.json (or its `data` object) and lists regressions first.
// Every case has an experiment key: a hash of the skill directory, the
// generated case spec, its fixtures, the claude CLI version, the model and
// this package's version. A case whose key matches a baseline (or --cache)
// result younger than --max-age days (default 28) is carried forward instead
// of re-run, so an identical experiment never runs twice; --no-carry re-runs
// everything. --cache keeps one JSON record per key on the workstation.
// Everything after `--` is passed to `claude plugin eval` (for example
// `--ablation with-without`, `--max-cost-usd 5`, `--case 'oncall--*'`).
// Exit status is the runner's (0 every case at threshold, 1 a case below
// threshold or a load failure, 2 partial), or 1 for a usage error.
// The wrapper is passed with --trust-plugin because it holds only copies of
// skills the caller chose to score; the runner's sandbox still applies, and a
// case's allowed_tools cannot grant Bash, Write, Edit, WebFetch or MCP tools
// without the operator's own `-- --allow-tools` grant. LCARS worker pods have
// no sandbox backend at all, so a committed case that grants one of those
// tools is refused outright unless --allow-gated-tools (workstation runs).
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { beginRun, finishRun, findRuns, historyRoot } from './eval-history.mjs';
import { archiveRun, archiveConfig, remoteFind } from './eval-history-remote.mjs';
import { HARNESSES, nativeBinary, nativeConfiguration, parseOptions as acpOptions } from './skill-evals-acp.mjs';
import { parseOptions as codexOptions } from './skill-evals-codex.mjs';
import { describeAdapter, normalizeAdapterResult, writeAdapterRequest } from './skill-evals-adapter.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'results', '.venv', 'dist', 'build']);
const MAX_DEPTH = 8;
const DEFAULT_TOOLS = ['Skill', 'Read', 'Glob', 'Grep'];
// Tools the runner only grants with the operator's `--allow-tools`, which needs a sandbox backend.
const GATED_TOOLS = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'WebFetch']);
const LOW_SCORE = 0.67;
const CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 28;

export function skillMetadata(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const data = match ? parse(match[1], { uniqueKeys: true }) : undefined;
  const name = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : path.basename(path.dirname(file));
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) throw new Error(`${file}: skill name ${JSON.stringify(name)} is not lowercase letters, digits and hyphens`);
  // A skill Claude may not invoke on its own can only be scored on behavior, never on triggering.
  const manualOnly = ['true', 'yes', 'on', '1'].includes(String(data?.['disable-model-invocation'] ?? '').toLowerCase());
  return { name, manualOnly };
}
export const skillName = (text, file) => skillMetadata(text, file).name;

export function discoverSkills(roots) {
  const skills = new Map();
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      const file = path.join(dir, 'SKILL.md');
      const { name, manualOnly } = skillMetadata(readFileSync(file, 'utf8'), file);
      if (skills.has(name)) throw new Error(`skill ${name} found twice: ${skills.get(name).dir} and ${dir}`);
      skills.set(name, { name, dir, manualOnly });
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
    // skill-creator also wrote object assertions ({ name, text }); grade their text, not "[object Object]".
    const checkText = (c) => (c && typeof c === 'object' ? c.text ?? c.name ?? c.value ?? '' : c);
    return {
      slug: slug(entry.name ?? `eval-${entry.id ?? index + 1}`),
      prompt: entry.prompt.trim(),
      expected: typeof entry.expected_output === 'string' ? entry.expected_output.trim() : '',
      checks: checks.map(checkText).map(String).map((s) => s.trim()).filter(Boolean),
      files: Array.isArray(entry.files) ? entry.files.map(String) : [],
      options: (() => {
        if (entry.execution !== undefined && entry.plugin_eval !== undefined) throw Error(`${file}: evals[${index}] must use execution or plugin_eval, not both`);
        const field = entry.execution === undefined ? 'plugin_eval' : 'execution';
        if (field === 'execution') for (const key of Object.keys(entry.execution ?? {})) if (!(key in LIMITS) && key !== 'allowed_tools') throw Error(`${file}: evals[${index}].execution has unsupported option ${key}`);
        return runnerOptions(entry[field], `${file}: evals[${index}].${field}`);
      })(),
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

// `Bash(git status)` names Bash; `mcp__server__tool` names an MCP tool.
export const gatedTool = (tools) => tools.find((t) => { const base = t.replace(/\(.*$/, ''); return GATED_TOOLS.has(base) || base.startsWith('mcp__'); });

export function buildCase(skill, entry, options) {
  const name = `${skill.name}--${entry.slug}`;
  if (!CASE_NAME.test(name)) throw new Error(`cannot derive a valid case name from ${name}`);
  const gated = gatedTool(entry.options.allowed_tools ?? []);
  if (gated && !options.allowGatedTools) {
    throw new Error(`${skill.name}: case ${name} grants the tool ${gated}; shared evals are read-only, so such cases must not be committed. Pass --allow-gated-tools only when the caller's execution environment supports them.`);
  }
  const graders = [];
  if (!skill.manualOnly) {
    graders.push({ name: 'skill-fired', type: 'tool_used', tool: 'Skill', input_match: `"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill.name.replaceAll('-', '\\-')}"` });
  }
  const rubric = criteria(entry);
  if (rubric && !options.triggerOnly) graders.push({ name: 'criteria', type: 'llm', criteria: rubric });
  if (!graders.length) throw new Error(`${skill.name}: ${entry.slug} has nothing to grade (manual-only skill without assertions or expected_output)`);
  // Claude never loads a manual-only skill on its own, so its behavior cases invoke it the way a user does.
  const execution = {
    prompt: skill.manualOnly ? `/${skill.name} ${entry.prompt}` : entry.prompt,
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
  const inside = (p) => { const real = realpathSync(p); return real === base || real.startsWith(base + path.sep); };
  if (!inside(source)) throw new Error(`${evalsFile}: fixture ${file} resolves outside the evals directory`);
  return { source: realpathSync(source), inside };
}

export function writeWrapper(outDir, skills, options) {
  const plugin = path.join(outDir, 'plugin');
  mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: options.pluginName ?? 'skill-evals', description: 'Temporary wrapper generated by repo-skill-evals; skills are copies of their source directories.' }, null, 2) + '\n');
  const manifest = { skills: [], cases: [] };
  for (const skill of skills) {
    cpSync(skill.dir, path.join(plugin, 'skills', skill.name), { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) || src === skill.dir });
    manifest.skills.push({ name: skill.name, dir: skill.dir, evals: skill.evals ?? null, cases: skill.entries?.length ?? 0, manualOnly: skill.manualOnly ?? false });
    for (const entry of skill.entries ?? []) {
      const spec = buildCase(skill, entry, options);
      const caseDir = path.join(plugin, 'evals', spec.name);
      mkdirSync(caseDir, { recursive: true });
      for (const file of entry.files) {
        const { source, inside } = fixturePath(skill.evals, file);
        // Follow links but copy nothing whose target leaves the evals directory, nested entries included.
        cpSync(source, path.join(caseDir, 'resources', path.basename(file)), { recursive: true, dereference: true, filter: (src) => { if (!inside(src)) throw new Error(`${skill.evals}: fixture ${file} links outside the evals directory (${path.relative(source, src) || '.'})`); return true; } });
      }
      // YAML is a superset of JSON, so the case file needs no YAML writer.
      writeFileSync(path.join(caseDir, 'case.yaml'), JSON.stringify(spec, null, 2) + '\n');
      manifest.cases.push({ name: spec.name, skill: skill.name, prompt: spec.execution.prompt });
    }
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { plugin, manifest };
}

// Content addressing: an experiment is identified by everything that can change its outcome.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Canonical JSON: object keys sorted at every level, undefined members dropped, array order kept.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort(compareText).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Every regular file below dir as { path, sha256 }, sorted by POSIX relative path; links are followed.
export function hashTree(dir, { skip = () => false, prefix = '' } = {}) {
  const files = [];
  const walk = (abs, rel) => {
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) return; // a dangling link has no content
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs)) {
        const child = rel ? `${rel}/${name}` : name;
        if (!skip(child, name)) walk(path.join(abs, name), child);
      }
    } else if (stat.isFile()) files.push({ path: `${prefix}${rel}`, sha256: sha256(readFileSync(abs)) });
  };
  walk(dir, '');
  return files.sort((a, b) => compareText(a.path, b.path));
}

// The skill as the runner sees it, minus old eval output and installed dependencies.
export const skillFiles = (dir) => hashTree(dir, { skip: (rel, name) => name === 'node_modules' || rel === 'evals/results' });

export function fixtureFiles(evalsFile, files) {
  return files.flatMap((file) => {
    const { source } = fixturePath(evalsFile, file);
    return statSync(source).isDirectory() ? hashTree(source, { prefix: `${file}/` }) : [{ path: file, sha256: sha256(readFileSync(source)) }];
  });
}

export function experimentKey({ skill, spec, fixtures, claudeVersion, model, toolsVersion, runner, judgeModel, adapter, native }) {
  return sha256(canonicalJson({ skill, spec, fixtures, claudeVersion: claudeVersion ?? null, model, toolsVersion, ...(runner ? { runner, judgeModel } : {}), ...(adapter ? { adapter } : {}), ...(native ? { native } : {}) })).slice(0, 32);
}

export function modelOf(passthrough) {
  for (let i = 0; i < passthrough.length; i += 1) {
    if (passthrough[i] === '--model' && i + 1 < passthrough.length) return passthrough[i + 1];
    if (passthrough[i].startsWith('--model=')) return passthrough[i].slice('--model='.length);
  }
  return 'default';
}

// The plugin manifest carries the release version; the npm manifest is the fallback for a package install.
export function toolsVersion(root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))) {
  for (const file of ['plugins/repo-tools/.claude-plugin/plugin.json', 'package.json']) {
    try { const version = JSON.parse(readFileSync(path.join(root, file), 'utf8')).version; if (typeof version === 'string') return version; } catch { /* try the next manifest */ }
  }
  return 'unknown';
}

// One planned case per eval entry, with the spec the wrapper will write and its experiment key.
export function planCases(skills, options, context) {
  const planned = [];
  for (const skill of skills) {
    const files = skillFiles(skill.dir);
    for (const entry of skill.entries) {
      const spec = buildCase(skill, entry, options);
      const fixtures = entry.files.length ? fixtureFiles(skill.evals, entry.files) : [];
      planned.push({ skill: skill.name, slug: entry.slug, name: spec.name, manualOnly: skill.manualOnly ?? false, entry, key: experimentKey({ skill: files, spec, fixtures, ...context }) });
    }
  }
  return planned;
}

// A hit is the run of a runner case the run did not error on; hitting max_turns is a --trigger-only design.
// Provider quota stops in any runner's per-run errors become the structured
// partial reason callers use to retry on another harness. Grading failures and
// other provider errors keep their own reason.
const PROVIDER_LIMIT_ERROR = /\b(?:usage limit|rate limit|quota|spend limit)\b|hit your (?:weekly |monthly |usage )?limit|credit balance is too low|RESOURCE_EXHAUSTED|ResourceExhausted|usage_limit_reached|insufficient_quota/i;
export function markProviderLimit(results) {
  if (!results?.partial || results.partialReason === 'provider-limit') return results;
  const limited = (results.cases ?? []).some((c) => (c.arms?.with ?? []).some((run) => typeof run.error === 'string' && PROVIDER_LIMIT_ERROR.test(run.error)));
  return limited ? { ...results, partialReason: 'provider-limit' } : results;
}
const runErrored = (run) => Boolean((run.error && !/maximum number of turns/i.test(run.error)) || run.aborted);

// The compact per-case record kept in result.json data and the cache. It holds no evidence text, `fired`
// stands in for the skill-fired grader, and `runs` appears only above 1, so ~200 cases stay under 48 KiB.
// A grader or the skill firing counts as passed only when it passed in every run.
export function caseRecord(result, planned, runAt) {
  const runs = result.arms?.with ?? [];
  if (typeof result.aggregates?.score !== 'number' || !runs.length || runs.some(runErrored)) return null;
  const graders = new Map();
  for (const run of runs) for (const g of run.graders ?? []) if (g.name !== 'skill-fired') graders.set(g.name, (graders.get(g.name) ?? true) && g.passed !== false);
  const fired = planned.manualOnly ? null : runs.every((run) => (run.graders ?? []).some((g) => g.name === 'skill-fired' && g.passed === true));
  const record = { skill: planned.skill, case: planned.slug, key: planned.key, score: Number(result.aggregates.score.toFixed(2)), fired, graders: [...graders].map(([name, passed]) => ({ name, passed })), runAt, carried: false };
  if (runs.length > 1) record.runs = runs.length;
  return record;
}

const validRecord = (r) => r && typeof r === 'object' && typeof r.key === 'string' && typeof r.skill === 'string' && typeof r.case === 'string' && typeof r.score === 'number' && Array.isArray(r.graders) && !Number.isNaN(Date.parse(r.runAt));

// Pick, per planned key, the newest prior result within maxAgeDays from the baseline's cases and the cache.
export function carryForward(planned, sources, now, maxAgeDays) {
  const newest = new Map();
  for (const record of sources.flat().filter(validRecord)) {
    const age = now.getTime() - Date.parse(record.runAt);
    if (age > maxAgeDays * DAY_MS) continue;
    const seen = newest.get(record.key);
    if (!seen || Date.parse(record.runAt) > Date.parse(seen.runAt)) newest.set(record.key, record);
  }
  const carried = new Map();
  for (const p of planned) {
    const record = newest.get(p.key);
    if (!record) continue;
    const copy = { skill: p.skill, case: p.slug, key: p.key, score: record.score, fired: p.manualOnly ? null : record.fired === true, graders: record.graders.filter((g) => g?.name !== 'skill-fired').map((g) => ({ name: String(g.name), passed: g.passed !== false })), runAt: record.runAt, carried: true };
    if (Number.isInteger(record.runs) && record.runs > 1) copy.runs = record.runs;
    carried.set(p.key, copy);
  }
  return carried;
}

// A carried record rendered as a runner case so per-skill rows and the report treat it like a fresh one.
export function carriedResult(record) {
  const graders = [...(record.fired === null ? [] : [{ name: 'skill-fired', passed: record.fired }]), ...record.graders];
  return { name: `${record.skill}--${record.case}`, carried: true, runAt: record.runAt, aggregates: { score: record.score, passRate: graders.every((g) => g.passed) ? 1 : 0 }, arms: { with: Array.from({ length: record.runs ?? 1 }, () => ({ graders })) } };
}

export function defaultCacheDir(env = process.env) {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'repo-skill-evals');
}

export function readCache(dir, planned) {
  const records = [];
  for (const p of planned) {
    try { const record = JSON.parse(readFileSync(path.join(dir, `${p.key}.json`), 'utf8')); if (record?.key === p.key) records.push(record); } catch { /* a miss or an unreadable entry just re-runs */ }
  }
  return records;
}

export function writeCache(dir, records) {
  mkdirSync(dir, { recursive: true });
  for (const record of records) writeFileSync(path.join(dir, `${record.key}.json`), JSON.stringify({ ...record, carried: false }) + '\n');
}

export function summarize(results, manifest) {
  const bySkill = new Map(manifest.skills.map((s) => [s.name, { skill: s.name, evals: s.evals, manualOnly: s.manualOnly ?? false, cases: 0, carried: 0, runs: 0, fired: 0, scores: [], failed: [], errors: 0 }]));
  for (const c of results.cases ?? []) {
    const owner = manifest.cases.find((m) => m.name === c.name)?.skill;
    const row = bySkill.get(owner);
    if (!row) continue;
    row.cases += 1;
    if (c.carried) row.carried += 1;
    if (typeof c.aggregates?.score === 'number') row.scores.push(c.aggregates.score);
    for (const run of c.arms?.with ?? []) {
      row.runs += 1;
      if (runErrored(run)) row.errors += 1;
      for (const g of run.graders ?? []) {
        if (g.name === 'skill-fired' && g.passed) row.fired += 1;
        if (g.passed === false && !row.failed.includes(`${c.name}/${g.name}`)) row.failed.push(`${c.name}/${g.name}`);
      }
    }
  }
  return [...bySkill.values()].map((row) => ({
    ...row,
    score: row.scores.length && !row.errors ? Number((row.scores.reduce((a, b) => a + b, 0) / row.scores.length).toFixed(2)) : null,
  }));
}

const pad = (value, width) => String(value).padEnd(width);
export function renderTable(rows) {
  const lines = [`${pad('skill', 32)} ${pad('cases', 6)} ${pad('score', 6)} ${pad('fired', 8)} failed graders`];
  for (const r of rows) {
    const score = r.cases === 0 ? 'no evals' : r.score ?? '-';
    const fired = r.manualOnly ? 'manual' : r.runs ? `${r.fired}/${r.runs}` : '-';
    lines.push(`${pad(r.skill, 32)} ${pad(r.cases, 6)} ${pad(score, 6)} ${pad(fired, 8)} ${r.failed.join(', ')}${r.errors ? ` (${r.errors} run error${r.errors > 1 ? 's' : ''})` : ''}`);
  }
  return lines.join('\n');
}

// A baseline is a previous --report result.json, or just its `data` object.
export function loadBaseline(file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`--baseline ${file}: ${error.message}`); }
  const data = parsed && typeof parsed === 'object' && Array.isArray(parsed.data?.skills) ? parsed.data : parsed;
  if (!Array.isArray(data?.skills)) throw new Error(`--baseline ${file}: expected a result.json (or its "data" object) with a "skills" array`);
  return data;
}

const firedRate = (row) => (row.manualOnly || !row.runs ? null : row.fired / row.runs);
// With per-case records on both sides, only fresh cases are compared with their previous values, so a
// carried case cannot regress; a baseline without `cases` (4.2 and earlier) compares per-skill rows.
export function compareBaseline(rows, baseline, records = null) {
  const previous = new Map(baseline.skills.filter((s) => s && typeof s.skill === 'string').map((s) => [s.skill, s]));
  const previousCases = Array.isArray(baseline.cases) && records ? new Map(baseline.cases.filter(validRecord).map((c) => [`${c.skill}--${c.case}`, c])) : null;
  const comparison = { regressions: [], improvements: [], unchanged: 0, new: [], removed: [] };
  for (const row of rows) {
    const prev = previous.get(row.skill);
    if (!prev) { comparison.new.push(row.skill); continue; }
    const change = { skill: row.skill, score: row.score, previousScore: prev.score ?? null, fired: row.fired, runs: row.runs, previousFired: prev.fired ?? 0, previousRuns: prev.runs ?? 0 };
    if (previousCases) {
      const down = [];
      const up = [];
      for (const record of records.filter((r) => r.skill === row.skill && !r.carried)) {
        const before = previousCases.get(`${record.skill}--${record.case}`);
        if (!before) continue;
        const deltas = [record.score - before.score];
        if (typeof record.fired === 'boolean' && typeof before.fired === 'boolean') deltas.push(Number(record.fired) - Number(before.fired));
        if (deltas.some((d) => d < 0)) down.push(record.case);
        else if (deltas.some((d) => d > 0)) up.push(record.case);
      }
      if (down.length) comparison.regressions.push({ ...change, cases: down });
      else if (up.length) comparison.improvements.push({ ...change, cases: up });
      else comparison.unchanged += 1;
      continue;
    }
    const deltas = [];
    if (typeof row.score === 'number' && typeof prev.score === 'number') deltas.push(row.score - prev.score);
    const rate = firedRate(row);
    const prevRate = firedRate(prev);
    if (rate !== null && prevRate !== null) deltas.push(rate - prevRate);
    if (deltas.some((d) => d < 0)) comparison.regressions.push(change);
    else if (deltas.some((d) => d > 0)) comparison.improvements.push(change);
    else comparison.unchanged += 1;
  }
  for (const name of previous.keys()) if (!rows.some((r) => r.skill === name)) comparison.removed.push(name);
  return comparison;
}

const clip = (text, max) => { const s = String(text ?? ''); return s.length > max ? `${s.slice(0, max)}…` : s; };
const fence = (text) => `\n\`\`\`text\n${String(text).replace(/`{3}/g, '⁣``')}\n\`\`\`\n`;
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const fmtFired = (r) => (r.manualOnly ? 'manual' : r.runs ? `${r.fired}/${r.runs}` : '-');
const fmtScore = (r) => (r.cases === 0 ? 'no evals' : r.score ?? '-');
const changeLine = (c) => `- ${c.skill}: score ${c.previousScore ?? '-'} -> ${c.score ?? '-'}, fired ${c.previousFired}/${c.previousRuns} -> ${c.fired}/${c.runs}${c.cases?.length ? ` (cases: ${c.cases.join(', ')})` : ''}`;
const ageDays = (runAt, now) => Math.max(0, Math.floor((now.getTime() - Date.parse(runAt)) / DAY_MS));

export function renderChanges(comparison) {
  const lines = ['## Changes since baseline', ''];
  lines.push(`### Regressions (${comparison.regressions.length})`, '');
  lines.push(...(comparison.regressions.length ? comparison.regressions.map(changeLine) : ['- none']), '');
  lines.push(`### Improvements (${comparison.improvements.length})`, '');
  lines.push(...(comparison.improvements.length ? comparison.improvements.map(changeLine) : ['- none']), '');
  lines.push(`- Unchanged: ${comparison.unchanged}`);
  lines.push(`- New skills: ${comparison.new.length ? comparison.new.join(', ') : 'none'}`);
  lines.push(`- Removed skills: ${comparison.removed.length ? comparison.removed.join(', ') : 'none'}`);
  return lines.join('\n');
}

export function renderReport({ roots, revision, runnerVersion, date, exit, results, rows, manifest, comparison, counts, records = [], now = new Date(date) }) {
  const partial = results.partial ?? false;
  const casesTotal = results.aggregates?.casesTotal ?? (results.cases ?? []).length;
  const casesPassed = results.aggregates?.casesPassed ?? (results.cases ?? []).filter((c) => c.aggregates?.passRate === 1).length;
  const lines = ['# Skill evals report', ''];
  lines.push(`- Roots: ${roots.map((r) => `\`${r}\``).join(', ')}`);
  if (revision) lines.push(`- Revision: \`${revision}\``);
  if (runnerVersion) lines.push(`- Runner: ${runnerVersion}`);
  lines.push(`- Date: ${date}`);
  lines.push(`- Exit: ${exit}${partial ? ` (partial: ${results.partialReason ?? 'unknown reason'})` : ''}`);
  if (counts) lines.push(`- Cases: ${counts.run} run / ${counts.carried} carried / ${counts.total} total`);
  lines.push(`- Cases passed: ${casesPassed}/${casesTotal}`);
  if (counts?.run === 0) lines.push('- Evaluator not invoked: every case was carried forward', '');
  else {
    lines.push(`- Runner list-price cost estimate (not billed spend): ${results.costUsd == null ? 'unknown' : '$'+Number(results.costUsd).toFixed(2)}`);
    lines.push(`- Duration: ${results.durationSeconds ?? '?'}s`, '');
  }
  lines.push('## Results', '', '| Skill | Cases | Carried | Score | Fired | Failed graders | Run errors |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) lines.push(`| ${cell(r.skill)} | ${r.cases} | ${r.carried ?? 0} | ${fmtScore(r)} | ${fmtFired(r)} | ${cell(r.failed.join(', '))} | ${r.errors} |`);
  lines.push('');
  const carried = records.filter((r) => r.carried);
  if (carried.length) {
    lines.push('## Carried results', '', 'Same experiment key as an earlier run, so not re-run; evidence is in that run\'s report.', '');
    for (const r of carried) {
      const age = ageDays(r.runAt, now);
      lines.push(`- ${r.skill}--${r.case}: score ${r.score}, fired ${r.fired === null ? 'manual' : r.fired ? 'yes' : 'no'}, ${age} day${age === 1 ? '' : 's'} old (run ${r.runAt}, key ${r.key})`);
    }
    lines.push('');
  }
  const noEvals = rows.filter((r) => r.cases === 0).map((r) => r.skill);
  lines.push('## Skills without evals', '', ...(noEvals.length ? noEvals.map((s) => `- ${s}`) : ['- none']), '');
  const owner = (name) => manifest.cases.find((m) => m.name === name);
  const errored = [];
  for (const c of results.cases ?? []) {
    (c.arms?.with ?? []).forEach((run, i) => {
      if (runErrored(run)) errored.push(`- ${c.name} (run ${i + 1}): ${clip(run.error ?? 'aborted', 300)}`);
    });
  }
  lines.push('## Runs that errored', '', ...(errored.length ? errored : ['- none']), '');
  if (comparison) lines.push(renderChanges(comparison), '');
  const weak = rows.filter((r) => r.cases > 0 && ((!r.manualOnly && r.fired < r.runs) || (typeof r.score === 'number' && r.score < LOW_SCORE)));
  if (weak.length) {
    lines.push('## Failures', '');
    for (const r of weak) {
      lines.push(`### ${r.skill}`, '');
      const reasons = [];
      if (!r.manualOnly && r.fired < r.runs) reasons.push(`fired ${r.fired}/${r.runs}`);
      if (typeof r.score === 'number' && r.score < LOW_SCORE) reasons.push(`score ${r.score} < ${LOW_SCORE}`);
      lines.push(reasons.join(', '), '');
      for (const c of (results.cases ?? []).filter((c) => owner(c.name)?.skill === r.skill)) {
        const failures = [];
        (c.arms?.with ?? []).forEach((run, i) => {
          for (const g of run.graders ?? []) if (g.passed === false) failures.push({ run: i + 1, grader: g });
        });
        if (!failures.length) continue;
        lines.push(`#### ${c.name}${c.carried ? ` (carried, ${ageDays(c.runAt, now)} days old)` : ''}`, '', 'Prompt:', fence(clip(c.promptMarkdown ?? owner(c.name)?.prompt ?? '', 300)));
        for (const { run, grader } of failures) {
          lines.push(`- \`${grader.name}\` failed in run ${run}${grader.explanation ? `: ${clip(grader.explanation, 300)}` : ''}`);
          if (grader.evidence) lines.push(fence(clip(grader.evidence, 600)));
        }
        lines.push('');
      }
    }
  }
  return { markdown: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, casesTotal, casesPassed };
}

// Best-effort probes for the report header; a missing binary or non-repo root is not an error.
function probe(exec, cmd, args, cwd) {
  const run = exec(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.error || run.status !== 0 ? null : String(run.stdout).trim() || null;
}

export function writeReport(dir, { options, rows, results, manifest, run, comparison, exec, claudeVersion, records = [], counts, now = new Date() }) {
  const revision = probe(exec, 'git', ['rev-parse', 'HEAD'], options.roots[0]);
  const runnerVersion = (claudeVersion === undefined ? probe(exec, options.runner ?? 'claude', ['--version'], undefined) : claudeVersion) ?? (results.claudeVersion ? `${results.claudeVersion} (Claude Code)` : null);
  const exit = run.status ?? 1;
  const partial = results.partial ?? false;
  const { markdown, casesTotal, casesPassed } = renderReport({ roots: options.roots.map((r) => path.resolve(r)), revision, runnerVersion, date: now.toISOString(), exit, results, rows, manifest, comparison, counts, records, now });
  const result = {
    report: markdown,
    complete: exit === 0 && !partial,
    // data is the next run's baseline, bounded to 48 KiB: rows drop the per-case scores, paths and failed graders that data.cases and the report carry.
    data: { runner: options.runner ?? 'claude', model: results.model ?? null, judgeModel: results.judgeModel ?? null, ...(results.adapter ? { adapter: results.adapter } : {}), skills: rows.map(({ scores, evals, failed, ...row }) => row), exit, partial, partialReason: results.partialReason ?? null, costUsd: results.costUsd ?? null, durationSeconds: results.durationSeconds ?? null, casesTotal, casesPassed, casesRun: counts?.run ?? null, casesCarried: counts?.carried ?? 0, baseline: comparison ?? null, cases: records },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.md'), markdown);
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function parseArgs(argv) {
  const options = { runner: process.env.REPO_SKILL_EVALS_RUNNER ?? 'claude', roots: [], evalsRoots: [], only: [], passthrough: [], list: false, dryRun: false, json: false, triggerOnly: false, allowGatedTools: false, carry: true, maxAgeDays: DEFAULT_MAX_AGE_DAYS, cache: null };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { options.passthrough = args.splice(0); break; }
    if (arg === '--runner' && args.length) options.runner = args.shift();
    else if (arg === '--adapter' && args.length) options.adapter = path.resolve(args.shift());
    else if (arg === '--root' && args.length) options.roots.push(args.shift());
    else if (arg === '--evals-root' && args.length) options.evalsRoots.push(args.shift());
    else if (arg === '--case' && args.length) options.case = args.shift();
    else if (arg === '--skill' && args.length) options.only.push(args.shift());
    else if (arg === '--out' && args.length) options.out = path.resolve(args.shift());
    else if (arg === '--report' && args.length) options.report = path.resolve(args.shift());
    else if (arg === '--baseline' && args.length) options.baseline = path.resolve(args.shift());
    else if (arg === '--runs' && args.length) {
      options.runs = Number(args.shift());
      if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) throw new Error('--runs takes an integer from 1 to 50');
    } else if (arg === '--max-age' && args.length) {
      options.maxAgeDays = Number(args.shift());
      if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays < 0) throw new Error('--max-age takes a number of days, 0 or more');
    } else if (arg === '--cache') options.cache = args.length && !args[0].startsWith('-') ? path.resolve(args.shift()) : defaultCacheDir();
    else if (arg === '--no-carry') options.carry = false;
    else if (arg === '--list') options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--trigger-only') options.triggerOnly = true;
    else if (arg === '--allow-gated-tools') options.allowGatedTools = true;
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.runner)) throw Error('--runner must be a harness name');
  if (options.runner === 'agy') options.runner = 'antigravity';
  if (!['codex', 'claude', ...HARNESSES].includes(options.runner) && !options.adapter && !options.list) throw Error('custom --runner requires --adapter EXECUTABLE');
  if (!options.roots.length) options.roots.push(process.cwd());
  return options;
}

export function plan(options) {
  const skills = discoverSkills(options.roots).filter((s) => !options.only.length || options.only.includes(s.name));
  for (const name of options.only) if (!skills.some((s) => s.name === name)) throw new Error(`no skill named ${name} under ${options.roots.join(', ')}`);
  for (const skill of skills) {
    skill.evals = findEvals(skill, options.evalsRoots) ?? null;
    skill.entries = skill.evals ? loadEntries(skill.evals) : [];
    if (options.case) skill.entries = skill.entries.filter(entry => path.matchesGlob(`${skill.name}--${entry.slug}`, options.case));
    // --trigger-only has nothing to measure for a skill the model may not invoke; a behavior case invokes it explicitly.
    if (options.triggerOnly && skill.manualOnly) skill.entries = [];
  }
  return skills;
}

export function main(argv, { log = console.log, warn = console.error, spawn = spawnSync, exec = spawnSync, now = () => new Date() } = {}) {
  const options = parseArgs(argv);
  // Read the baseline before anything paid runs: a bad file must not cost a run.
  const baseline = options.baseline ? loadBaseline(options.baseline) : null;
  const skills = plan(options);
  if (!skills.length) throw new Error(`no SKILL.md found under ${options.roots.join(', ')}`);
  const withEvals = skills.filter((s) => s.entries.length);
  if (options.list) {
    const rows = skills.map((s) => ({ skill: s.name, evals: s.evals, cases: s.entries.length, manualOnly: s.manualOnly, runs: 0, fired: 0, failed: [], errors: 0, score: null }));
    log(options.json ? JSON.stringify({ skills: rows }, null, 2) : `${renderTable(rows)}\n\n${withEvals.length}/${skills.length} skills have evals (${withEvals.reduce((n, s) => n + s.entries.length, 0)} cases)`);
    return 0;
  }
  if (!withEvals.length) throw new Error(`none of the ${skills.length} skills has an evals.json; use --list to see them`);
  const adapter = options.adapter ? describeAdapter(options.adapter, options.runner, exec, options.passthrough) : null;
  const runnerOptions = !adapter && options.runner === 'codex' ? codexOptions(options.passthrough) : !adapter && HARNESSES.includes(options.runner) ? acpOptions(options.passthrough) : null;
  const claudeVersion = adapter ? `${options.runner} ${adapter.descriptor.version}` : probe(exec, HARNESSES.includes(options.runner) ? nativeBinary(options.runner) : options.runner, ['--version'], undefined);
  const planned = planCases(withEvals, options, { claudeVersion, model: adapter?.identity.model ?? runnerOptions?.model ?? modelOf(options.passthrough), toolsVersion: toolsVersion(), ...(adapter ? { runner: options.runner, judgeModel: adapter.identity.judgeModel, adapter: adapter.identity } : runnerOptions ? {runner: options.runner, judgeModel: runnerOptions.judgeModel, ...(HARNESSES.includes(options.runner) ? { native: nativeConfiguration(options.runner) } : {})} : {}) });
  const startedAt = now();
  const sources = [baseline?.cases ?? [], options.cache ? readCache(options.cache, planned) : []];
  const carried = options.carry ? carryForward(planned, sources, startedAt, options.maxAgeDays) : new Map();
  const counts = { run: planned.length - carried.size, carried: carried.size, total: planned.length };
  const fresh = planned.filter((p) => !carried.has(p.key));
  const toRun = withEvals.map((s) => ({ ...s, entries: s.entries.filter((e) => fresh.some((p) => p.entry === e)) })).filter((s) => s.entries.length);
  const countLine = `${counts.run} run / ${counts.carried} carried / ${counts.total} total`;

  // Combine fresh results with carried records into rows, the report, result.json, the cache and the summary.
  const conclude = (results, run, outDir, history) => {
    // Fresh results first become compact records; errored or unscored cases are left to run again next time.
    const runAt = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const byName = new Map(planned.map((p) => [p.name, p]));
    const freshRecords = new Map();
    for (const c of results.cases ?? []) {
      const p = byName.get(c.name);
      const record = p && !carried.has(p.key) ? caseRecord(c, p, runAt) : null;
      if (record) freshRecords.set(p.key, record);
    }
    const records = planned.map((p) => carried.get(p.key) ?? freshRecords.get(p.key)).filter(Boolean);
    if (options.cache && freshRecords.size) writeCache(options.cache, [...freshRecords.values()]);
    // Summaries combine fresh and carried cases; the runner's own totals cover only the fresh ones.
    const carriedCases = [...carried.values()].map(carriedResult);
    const freshTotal = results.aggregates?.casesTotal ?? (results.cases ?? []).length;
    const freshPassed = results.aggregates?.casesPassed ?? (results.cases ?? []).filter((c) => c.aggregates?.passRate === 1).length;
    const identity = adapter ? { runner: options.runner, model: adapter.identity.model, judgeModel: adapter.identity.judgeModel, adapter: adapter.identity } : runnerOptions ? { runner: options.runner, model: runnerOptions.model, judgeModel: runnerOptions.judgeModel } : {};
    const combined = { ...identity, ...results, cases: [...(results.cases ?? []), ...carriedCases], aggregates: { ...results.aggregates, casesTotal: freshTotal + carriedCases.length, casesPassed: freshPassed + carriedCases.filter((c) => c.aggregates.passRate === 1).length } };
    const manifest = { skills: withEvals.map((s) => ({ name: s.name, evals: s.evals, cases: s.entries.length, manualOnly: s.manualOnly ?? false })), cases: planned.map((p) => ({ name: p.name, skill: p.skill, prompt: p.manualOnly ? `/${p.skill} ${p.entry.prompt}` : p.entry.prompt })) };
    // Skills without evals stay visible in the run output, as in --list, so coverage gaps are reported with the scores.
    const rows = [...summarize(combined, manifest), ...skills.filter((s) => !s.entries.length).map((s) => ({ skill: s.name, evals: null, manualOnly: s.manualOnly, cases: 0, carried: 0, runs: 0, fired: 0, scores: [], failed: [], errors: 0, score: null }))].sort((a, b) => a.skill.localeCompare(b.skill, 'en'));
    const comparison = baseline ? compareBaseline(rows, baseline, records) : null;
    if (options.report) writeReport(options.report, { options, rows, results: combined, manifest, run, comparison, exec, claudeVersion, records, counts, now: startedAt });
    const summary = { ok: run.status === 0, exit: run.status, partial: results.partial ?? false, partialReason: results.partialReason ?? null, costUsd: results.costUsd ?? null, durationSeconds: results.durationSeconds ?? null, out: outDir, report: options.report ?? null, cases: counts, baseline: comparison, history, skills: rows };
    const changes = comparison ? `\n\n${renderChanges(comparison)}` : '';
    const report = options.report ? `, report in ${options.report}` : '';
    const ran = outDir ? `, runner cost estimate ${results.costUsd == null ? 'unknown' : '$'+Number(results.costUsd).toFixed(2)} (list price, not billed spend), ${results.durationSeconds ?? '?'}s, results in ${outDir}` : ', evaluator not invoked';
    log(options.json ? JSON.stringify(summary, null, 2) : `\n${renderTable(rows)}${changes}\n\nexit ${run.status}${results.partial ? ` (partial: ${results.partialReason})` : ''}, cases ${countLine}${ran}${report}`);
    return summary;
  };

  if (!toRun.length) {
    if (options.dryRun) { log(`every case is carried forward (${countLine}); nothing to run`); return 0; }
    conclude({ cases: [] }, { status: 0 }, null, null);
    return 0;
  }
  const store = historyRoot();
  if (!options.out && !options.dryRun) mkdirSync(path.join(store, 'work'), { recursive: true, mode: 0o700 });
  const outDir = options.out ?? mkdtempSync(path.join(options.dryRun ? tmpdir() : path.join(store, 'work'), 'repo-skill-evals-'));
  if (!options.dryRun && (outDir === store || store.startsWith(outDir + path.sep))) throw Error('--out must not contain the evaluation history store');
  mkdirSync(outDir, { recursive: true });
  const { plugin, manifest } = writeWrapper(outDir, toRun, options);
  const resultsFile = path.join(outDir, 'results.json');
  // The stock runner otherwise deletes trace.jsonl before this process can archive it.
  const ownsRunnerTemp = !adapter && options.runner === 'claude' && !options.passthrough.includes('--keep-temp');
  const requestFile = path.join(outDir, 'adapter-request.json'), adapterResultFile = path.join(outDir, 'adapter-result.json');
  const adapterRequest = adapter ? writeAdapterRequest(requestFile, plugin, toRun, options, adapter, buildCase, criteria) : null;
  const command = adapter ? [adapter.command, [requestFile, adapterResultFile]] : options.runner === 'codex' ? [process.execPath, [fileURLToPath(new URL('./skill-evals-codex.mjs', import.meta.url)), plugin, resultsFile, ...options.passthrough]] : HARNESSES.includes(options.runner) ? [process.execPath, [fileURLToPath(new URL('./skill-evals-acp.mjs', import.meta.url)), options.runner, plugin, resultsFile, ...options.passthrough]] : ['claude', ['plugin', 'eval', plugin, '--trust-plugin', '--no-publish', '--keep-temp', '--json', resultsFile, '--output-dir', path.join(outDir, 'results'), ...options.passthrough.filter(a => a !== '--keep-temp')]];
  if (options.dryRun) {
    log(`${manifest.cases.length} cases for ${toRun.length} skills written under ${plugin} (${countLine})\n${command[0]} ${command[1].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return 0;
  }
  const filesBelow = (dir) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isDirectory() ? filesBelow(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);
  const inputFiles = filesBelow(plugin);
  const inputs = { files: Object.fromEntries(inputFiles.map(file => [path.relative(plugin, file), createHash('sha256').update(readFileSync(file)).digest('hex')])),
    arguments: options.passthrough, runner: options.runner, modelAlias: adapter?.identity.model ?? runnerOptions?.model ?? process.env.ANTHROPIC_MODEL ?? 'client default', ...(adapter ? { adapter: adapter.identity } : {}) };
  const subject = manifest.skills.map(s => s.name).sort().join(',');
  const localPrevious = findRuns({ root: store, kind: 'skill', subject, inputs });
  const sharedPrevious = archiveConfig() ? remoteFind({ kind: 'skill', subject, inputs }) : [];
  const previous = [...new Map([...sharedPrevious, ...localPrevious].map(r => [r.id, r])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (previous.length) warn(`Evaluation history: ${previous.length} recent matching attempt(s); latest ${previous[0].id} is ${previous[0].status}. Inspect prior evidence before repeating a hill climb.`);
  const history = beginRun({ root: store, kind: 'skill', subject, inputs, summary: 'Stock skill evaluation started' });
  let results, run, outcome;
  try {
    // The nested runner is non-interactive; the parent session's marker would only make it refuse to start.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CLAUDECODE'));
    // The runner's own progress lines stay out of --json output; they are kept in runner.log instead.
    run = spawn(command[0], command[1], { cwd: plugin, stdio: ['ignore', options.json ? 'pipe' : 'inherit', 'inherit'], env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(adapter ? { timeout: Math.min(2147483647, 10000 + adapterRequest.cases.reduce((ms, c) => ms + c.runs * c.timeoutSeconds * 1000, 0)) } : {}) });
    if (run.error) throw new Error(`could not run evaluator: ${run.error.message}`);
    if (options.json && run.stdout) writeFileSync(path.join(outDir, 'runner.log'), run.stdout);
    if (adapter) {
      if (!existsSync(adapterResultFile)) throw Error('adapter exited without its result document');
      if (!realpathSync(adapterResultFile).startsWith(realpathSync(outDir) + path.sep)) throw Error('adapter result must stay inside the output directory');
      const resultStat = statSync(adapterResultFile);
      if (!resultStat.isFile() || resultStat.size > 64 * 1024 * 1024) throw Error('adapter result must be a regular file at most 64MiB');
      const normalized = normalizeAdapterResult(JSON.parse(readFileSync(adapterResultFile, 'utf8')), adapterRequest, outDir, run.status);
      run = { ...run, status: normalized.exit };
      writeFileSync(resultsFile, JSON.stringify(normalized.results, null, 2) + '\n');
    }
    if (!existsSync(resultsFile)) throw new Error(`${options.runner} evaluator exited ${run.status} without writing ${resultsFile}`);
    results = markProviderLimit(JSON.parse(readFileSync(resultsFile, 'utf8')));
    outcome = conclude(results, run, outDir, { id: history.id, store, previous: previous.map(r => r.id) });
    return run.status ?? 1;
  } finally {
    const traces = (results?.cases ?? []).flatMap(c => Object.values(c.arms ?? {}).flatMap(runs => runs.map(r => r.tracePath).filter(p => typeof p === 'string' && existsSync(p))));
    const artifacts = [...filesBelow(outDir), ...traces];
    if (options.report) for (const name of ['report.md', 'result.json']) { const p = path.join(options.report, name); if (existsSync(p)) artifacts.push(p); }
    finishRun(store, history.id, { status: results?.partial ? 'partial' : outcome?.ok ? 'completed' : 'failed', summary: outcome ? `Stock runner exit ${run.status}` : 'Runner failed before producing a usable result', result: outcome ?? { exit: run?.status ?? null }, artifacts: [...new Set(artifacts)] });
    // Remove only this runner's recognized, account-owned scaffold after the
    // archive is durable. Explicit --keep-temp preserves it for debugging.
    if (ownsRunnerTemp) for (const trace of new Set(traces)) {
      const file = realpathSync(trace), dir = path.dirname(path.dirname(file));
      if (path.dirname(dir) !== realpathSync(tmpdir()) || !/^claude-eval-[\w-]+$/.test(path.basename(dir)) || file !== path.join(dir, 'out', 'trace.jsonl') || typeof process.getuid !== 'function' || lstatSync(dir).uid !== process.getuid()) continue;
      try {
        const writable = p => { if (!lstatSync(p).isDirectory()) return; chmodSync(p, 0o700); for (const e of readdirSync(p)) writable(path.join(p, e)); };
        writable(dir); rmSync(dir, { recursive: true });
      } catch (error) { warn(`Trace archived; retained runner temporary directory ${dir}: ${error.message}`); }
    }
    try { archiveRun(store, history.id); }
    catch (error) { throw Error(`${error.message}. Retry only the archive with repo-eval-history upload --id ${history.id}; do not repeat inference`); }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
