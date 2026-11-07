// Executable boundary for harnesses that do not implement either built-in CLI.
// Eval documents never choose this executable, its authentication or its model.
import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ADAPTER_SCHEMA = 'repo-skill-evals.adapter/v1';
const TOOLS = { Skill: 'skill.load', Read: 'file.read', Glob: 'file.glob', Grep: 'file.grep', Bash: 'shell.execute', PowerShell: 'shell.execute', Write: 'file.write', Edit: 'file.edit', WebFetch: 'web.fetch' };
const requireValue = (value, message) => { if (!value) throw Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;

export function describeAdapter(executable, harness, exec, arguments_ = []) {
  const command = realpathSync(executable);
  accessSync(command, constants.X_OK);
  const result = exec(command, ['--describe', ...arguments_], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  requireValue(!result.error && result.status === 0, 'adapter --describe failed; no evaluation was started');
  let descriptor;
  try { descriptor = JSON.parse(result.stdout); } catch { throw Error('adapter --describe must return JSON'); }
  requireValue(descriptor.schema === ADAPTER_SCHEMA && descriptor.harness === harness && text(descriptor.version), 'adapter description must identify the requested harness, version and adapter/v1 schema');
  requireValue(Array.isArray(descriptor.capabilities) && descriptor.capabilities.every(text), 'adapter description must list capabilities');
  requireValue(text(descriptor.model) && (!descriptor.capabilities.includes('criteria.grade') || text(descriptor.judgeModel)), 'adapter description must identify its case and grading models');
  return { command, descriptor, identity: { harness, version: descriptor.version, model: descriptor.model, judgeModel: descriptor.judgeModel ?? null, capabilities: [...new Set(descriptor.capabilities)].sort(), arguments: arguments_, executableSha256: createHash('sha256').update(readFileSync(command)).digest('hex') } };
}

// Only snapshot paths reach the adapter. It need not understand plugin manifests,
// Claude case YAML, slash-command syntax, or the source repository layout.
export function writeAdapterRequest(file, plugin, skills, options, adapter, buildCase, criteria) {
  const required = new Set(['context.isolated']);
  const cases = [];
  for (const skill of skills) for (const entry of skill.entries) {
    const spec = buildCase(skill, entry, options);
    const tools = spec.execution.allowed_tools.map(tool => {
      const base = tool.replace(/\(.*$/, '');
      const capability = TOOLS[base] ?? `tool.${base}`;
      required.add(capability);
      if (tool !== base) required.add('tool.restrictions');
      return { capability, restriction: tool === base ? null : tool.slice(base.length) };
    });
    const rubric = options.triggerOnly ? null : criteria(entry) ?? null;
    if (rubric) required.add('criteria.grade');
    cases.push({ id: spec.name, skill: skill.name, prompt: entry.prompt, invocation: skill.manualOnly ? 'explicit' : 'automatic', expectedOutput: entry.expected || null, rubric, trigger: !skill.manualOnly, runs: spec.runs, maxTurns: spec.execution.max_turns, timeoutSeconds: spec.execution.timeout_seconds, tools, resources: entry.files.length ? path.join(plugin, 'evals', spec.name, 'resources') : null });
  }
  let budgetUsd = null;
  for (let i = 0; i < options.passthrough.length; i++) {
    const arg = options.passthrough[i];
    if (arg !== '--max-cost-usd' && !arg.startsWith('--max-cost-usd=')) continue;
    requireValue(budgetUsd === null, 'duplicate --max-cost-usd');
    budgetUsd = Number(arg === '--max-cost-usd' ? options.passthrough[++i] : arg.slice('--max-cost-usd='.length));
    requireValue(Number.isFinite(budgetUsd) && budgetUsd > 0, '--max-cost-usd must be a positive finite number');
    required.add('budget.usd');
  }
  const missing = [...required].filter(capability => !adapter.descriptor.capabilities.includes(capability));
  requireValue(!missing.length, `adapter does not support required capabilities: ${missing.join(', ')}`);
  const request = { schema: ADAPTER_SCHEMA, harness: options.runner, adapter: adapter.identity, arguments: options.passthrough, budgetUsd, skills: skills.map(skill => ({ name: skill.name, directory: path.join(plugin, 'skills', skill.name), manualOnly: Boolean(skill.manualOnly) })), cases };
  writeFileSync(file, JSON.stringify(request, null, 2) + '\n', { mode: 0o600 });
  return request;
}

function traceEvidence(file, root, skill) {
  requireValue(text(file), 'adapter run has no trace');
  const absolute = realpathSync(path.resolve(root, file));
  requireValue(absolute.startsWith(realpathSync(root) + path.sep), 'adapter trace must stay inside the output directory');
  const stat = statSync(absolute);
  requireValue(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'adapter trace must be a regular file at most 16MiB');
  const bytes = readFileSync(absolute);
  const events = bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  requireValue(events.length > 0, 'adapter run has an empty trace');
  requireValue(events.some(event => event.type === 'response' && typeof event.text === 'string'), 'adapter trace has no response evidence');
  return { tracePath: absolute, loaded: events.some(event => event.type === 'skill.loaded' && event.skill === skill), judgments: events.filter(event => event.type === 'criteria.judged') };
}

// Normalize into the existing report/history contract. Missing runs, provider
// errors and malformed evidence remain unscored; an adapter cannot omit a case
// and turn the remainder into a complete green suite.
export function normalizeAdapterResult(raw, request, outDir, processExit) {
  requireValue(raw?.schema === ADAPTER_SCHEMA && raw.harness === request.harness && raw.adapterVersion === request.adapter.version, 'adapter result identity does not match its request');
  requireValue(raw.model === request.adapter.model && (raw.judgeModel ?? null) === request.adapter.judgeModel, 'adapter result models differ from its preflight identity');
  requireValue(Array.isArray(raw.cases), 'adapter result must contain cases');
  const expected = new Map(request.cases.map(c => [c.id, c]));
  const received = new Map();
  for (const c of raw.cases) {
    requireValue(expected.has(c.id) && !received.has(c.id), 'adapter returned an unknown or duplicate case');
    requireValue(Array.isArray(c.runs) && c.runs.length <= expected.get(c.id).runs, 'adapter returned invalid run count');
    received.set(c.id, c);
  }
  let partial = Boolean(raw.partial) || processExit === null, partialReason = raw.partialReason ?? (processExit === null ? 'adapter process did not complete' : null);
  const cases = request.cases.map(spec => {
    const provided = received.get(spec.id)?.runs ?? [];
    const runs = Array.from({ length: spec.runs }, (_, index) => {
      const run = provided[index];
      try {
        requireValue(run && !run.error, run?.error || 'adapter omitted this run');
        requireValue(text(raw.model), 'adapter did not identify the case model');
        if (spec.rubric) requireValue(text(raw.judgeModel) && typeof run.criteriaPassed === 'boolean', 'adapter did not return an identified rubric judgment');
        const evidence = traceEvidence(run.tracePath, outDir, spec.skill);
        if (spec.rubric) requireValue(evidence.judgments.some(j => j.model === raw.judgeModel && j.passed === run.criteriaPassed), 'adapter trace has no matching rubric judgment');
        const graders = [];
        if (spec.trigger) graders.push({ name: 'skill-fired', passed: evidence.loaded });
        if (spec.rubric) graders.push({ name: 'criteria', passed: run.criteriaPassed });
        return { graders, tracePath: evidence.tracePath };
      } catch (error) {
        partial = true; partialReason ??= error.message;
        // A referenced trace is retained only when it passed path validation.
        return { error: error.message, graders: [] };
      }
    });
    const complete = runs.every(run => !run.error);
    const grades = runs.flatMap(run => run.graders);
    const score = complete ? grades.filter(g => g.passed).length / grades.length : null;
    return { name: spec.id, arms: { with: runs }, aggregates: { score, passRate: complete && grades.every(g => g.passed) ? 1 : 0 } };
  });
  if (processExit !== 0 && cases.every(c => c.aggregates.passRate === 1)) { partial = true; partialReason ??= `adapter exited ${processExit}`; }
  const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const passed = cases.filter(c => c.aggregates.passRate === 1).length;
  const exit = partial ? 2 : passed === cases.length ? 0 : 1;
  return { exit: processExit || exit, results: { runner: request.harness, model: raw.model ?? null, judgeModel: raw.judgeModel ?? null, adapter: request.adapter, partial, partialReason, costUsd: finite(raw.costUsd), durationSeconds: finite(raw.durationSeconds), cases, aggregates: { casesTotal: cases.length, casesPassed: passed } } };
}
