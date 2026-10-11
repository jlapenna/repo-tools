#!/usr/bin/env node
// Install repo-tools' generic conventions into a target repository, idempotently.
//
// Hand-adopting the conventions means re-deriving the same four edits in every
// new repository: the pre-commit (or Husky) worktree guard, a Renovate config
// that extends the shared preset, and an AGENTS.md route to the shared skills.
// This command owns that repetitive part. It is runtime-neutral: nothing here
// knows about an agent fleet, a session, or a dispatch runtime.
//
// Usage:
//   repo-adopt [--target DIR] [--hooks auto|pre-commit|husky|none]
//              [--repo-tools-rev SHA] [--check] [--force]
//
// Files and their ownership rules:
//   .pre-commit-config.yaml  merge: the repo-tools entry (both worktree hooks,
//                            pinned to a rev) and default_install_hook_types
//                            are ensured; other entries are left alone. An
//                            existing pin is kept unless --force re-pins it.
//   .husky/pre-commit,       seed: written only when absent. An existing hook
//   .husky/pre-push          without the guard is reported as locally-owned
//                            with guidance; --force replaces it.
//   renovate.json            seed: never modified once present, even by --force.
//   AGENTS.md                merge: only the <!-- repo-tools:begin/end --> section
//                            is replaced; the rest of the file is untouched.
//
// --hooks auto picks pre-commit when .pre-commit-config.yaml exists, Husky when
// package.json exists, and pre-commit otherwise. The rev defaults to
// `git ls-remote` of repo-tools main, resolved only when a pin is actually
// written; --check never touches the network.
//
// Output is TSV, one `action<TAB>file` line per planned file (create, update,
// force-update, unchanged, keep, locally-owned) followed by `note<TAB>text`
// guidance. --check writes nothing and exits 1 when any file would change.
// Dependency-free so it runs from a bare checkout or an npx-style install.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_TOOLS_URL = 'https://github.com/jlapenna/repo-tools';
export const AGENTS_BEGIN = '<!-- repo-tools:begin -->';
export const AGENTS_END = '<!-- repo-tools:end -->';
export const HOOK_IDS = ['repo-require-worktree', 'repo-require-worktree-push'];
export const HOOK_TYPES = ['pre-commit', 'pre-push'];
export const HOOK_FLAVORS = ['auto', 'pre-commit', 'husky', 'none'];
const GUARD = 'repo-require-worktree';
const SKILL = (name) => `${REPO_TOOLS_URL}/blob/main/plugins/repo-tools/skills/${name}/SKILL.md`;
const PRECOMMIT_REPO = /^(\s*)-\s+repo:\s*['"]?https:\/\/github\.com\/jlapenna\/repo-tools(?:\.git)?\/?['"]?\s*(#.*)?$/;
const WRITES = new Set(['create', 'update', 'force-update']);

export class AdoptError extends Error {}

// --- rendering --------------------------------------------------------------

export function renderPreCommitBlock(rev, indent = '  ') {
  const inner = `${indent}  `;
  return [
    `${indent}- repo: ${REPO_TOOLS_URL}`,
    `${inner}rev: ${rev}`,
    `${inner}hooks:`,
    ...HOOK_IDS.map((id) => `${inner}  - id: ${id}`),
  ].join('\n') + '\n';
}

export function renderPreCommitConfig(rev) {
  return `default_install_hook_types: [${HOOK_TYPES.join(', ')}]\n\nrepos:\n${renderPreCommitBlock(rev)}`;
}

export function renderHuskyHook(stage) {
  const call = stage === 'pre-push'
    ? [
      '# Git feeds pre-push one line per ref on stdin; capture it once so later',
      '# consumers in this hook can replay it. "pushes" mode exempts deletion-only pushes.',
      'refs="$(cat)"',
      'if command -v repo-require-worktree >/dev/null 2>&1; then',
      "  printf '%s\\n' \"$refs\" | repo-require-worktree pushes",
      'fi',
    ]
    : ['if command -v repo-require-worktree >/dev/null 2>&1; then repo-require-worktree commits; fi'];
  return [
    '#!/bin/sh',
    'set -e',
    '',
    '# The public repo-tools worktree guard (on PATH as repo-require-worktree),',
    '# guarded with command -v so a machine without the package still works.',
    '# Set REQUIRE_WORKTREE_EXTRA_HINT to add a repository-specific remediation line.',
    ...call,
    '',
  ].join('\n');
}

export function renderRenovateConfig() {
  return `${JSON.stringify({
    $schema: 'https://docs.renovatebot.com/renovate-schema.json',
    extends: ['github>jlapenna/repo-tools//renovate-preset'],
    vulnerabilityAlerts: { enabled: true, labels: ['bot:renovate', 'type:security'] },
  }, null, 2)}\n`;
}

export function renderAgentsSection() {
  return `${AGENTS_BEGIN}

## Shared repository conventions

Git safety and pull-request delivery follow two skills published by
[jlapenna/repo-tools](${REPO_TOOLS_URL}):

- [worktree-hygiene](${SKILL('worktree-hygiene')}) before any
  git-mutating command: author in a linked worktree, never in the primary
  checkout or on \`main\`.
- [land-pr](${SKILL('land-pr')}) to carry a change through commit, push, CI,
  review, protected merge, and cleanup.

Do not mirror their bodies locally; load them from the plugin and use the
\`repo-*\` commands they describe. Repository-specific policy (check names,
deployment rules) stays in this file outside this section.

${AGENTS_END}`;
}

// --- merging ----------------------------------------------------------------

export function mergeAgentsSection(existingText, section = renderAgentsSection()) {
  const text = existingText ?? '';
  const start = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(0, start) + section + text.slice(end + AGENTS_END.length);
  }
  if (start !== -1 || end !== -1) throw new AdoptError('AGENTS.md has an unterminated repo-tools block');
  if (!text.trim()) return `# Agent Guide\n\n${section}\n`;
  return `${text.replace(/\s*$/, '')}\n\n${section}\n`;
}

const splitFlow = (inner) => inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

/** Ensure `default_install_hook_types` lists every hook type; keep its existing shape. */
export function ensureInstallHookTypes(lines) {
  const index = lines.findIndex((line) => /^default_install_hook_types\s*:/.test(line));
  if (index === -1) {
    lines.unshift(`default_install_hook_types: [${HOOK_TYPES.join(', ')}]`, '');
    return lines;
  }
  const value = lines[index].replace(/^default_install_hook_types\s*:\s*/, '').replace(/\s+#.*$/, '').trim();
  const flow = /^\[(.*)\]$/.exec(value);
  if (flow) {
    const items = splitFlow(flow[1]);
    const missing = HOOK_TYPES.filter((type) => !items.includes(type));
    if (missing.length) lines[index] = `default_install_hook_types: [${[...items, ...missing].join(', ')}]`;
    return lines;
  }
  if (value) throw new AdoptError(`default_install_hook_types has an unrecognized value: ${value}`);
  let last = index;
  const items = [];
  let indent = '  ';
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^(\s+)-\s+['"]?([^'"#\s]+)['"]?\s*(#.*)?$/.exec(lines[i]);
    if (!match) {
      if (/^\s*(#.*)?$/.test(lines[i])) continue;
      break;
    }
    indent = match[1];
    items.push(match[2]);
    last = i;
  }
  const missing = HOOK_TYPES.filter((type) => !items.includes(type));
  lines.splice(last + 1, 0, ...missing.map((type) => `${indent}- ${type}`));
  return lines;
}

/** Locate the repo-tools entry: [startLine, endLineExclusive, indent] or null. */
function findRepoToolsEntry(lines) {
  const start = lines.findIndex((line) => PRECOMMIT_REPO.test(line));
  if (start === -1) return null;
  const indent = PRECOMMIT_REPO.exec(lines[start])[1];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const lead = /^\s*/.exec(line)[0];
    if (lead.length < indent.length || (lead.length === indent.length && /^\s*-\s/.test(line))) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && /^\s*$/.test(lines[end - 1])) end -= 1;
  return [start, end, indent];
}

export function mergePreCommitConfig(existingText, rev, { force = false } = {}) {
  if (!existingText) return renderPreCommitConfig(rev);
  let lines = existingText.split('\n');
  const entry = findRepoToolsEntry(lines);
  if (!entry) {
    const index = lines.findIndex((line) => /^repos\s*:\s*(#.*)?$/.test(line));
    if (index === -1) throw new AdoptError('.pre-commit-config.yaml has no top-level repos:');
    const sibling = lines.slice(index + 1).find((line) => /^\s*-\s+repo:/.test(line));
    const indent = sibling ? /^\s*/.exec(sibling)[0] : '  ';
    lines.splice(index + 1, 0, ...renderPreCommitBlock(rev, indent).replace(/\n$/, '').split('\n'));
  } else {
    const [start, end, indent] = entry;
    const block = lines.slice(start, end);
    const revIndex = block.findIndex((line) => /^\s*rev\s*:/.test(line));
    if (revIndex === -1) block.splice(1, 0, `${indent}  rev: ${rev}`);
    else if (force && rev) block[revIndex] = block[revIndex].replace(/(rev\s*:\s*)\S+/, `$1${rev}`);
    const hooksIndex = block.findIndex((line) => /^\s*hooks\s*:\s*(#.*)?$/.test(line));
    const present = block.map((line) => /^\s*-\s+id\s*:\s*['"]?([^'"#\s]+)/.exec(line)?.[1]).filter(Boolean);
    const missing = HOOK_IDS.filter((id) => !present.includes(id));
    if (missing.length) {
      const sample = block.find((line) => /^\s*-\s+id\s*:/.test(line));
      const idIndent = sample ? /^\s*/.exec(sample)[0] : `${indent}    `;
      if (hooksIndex === -1) block.push(`${indent}  hooks:`);
      block.push(...missing.map((id) => `${idIndent}- id: ${id}`));
    }
    lines.splice(start, end - start, ...block);
  }
  lines = ensureInstallHookTypes(lines);
  return lines.join('\n');
}

// --- planning ---------------------------------------------------------------

export function resolveRepoToolsRev(exec = execFileSync) {
  let output = '';
  try {
    output = exec('git', ['ls-remote', `${REPO_TOOLS_URL}.git`, 'refs/heads/main'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
  } catch {
    output = '';
  }
  const sha = String(output).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new AdoptError('could not resolve jlapenna/repo-tools main; pass --repo-tools-rev');
  return sha;
}

export function detectHooks(target, hooks) {
  if (hooks !== 'auto') return hooks;
  if (existsSync(path.join(target, '.pre-commit-config.yaml'))) return 'pre-commit';
  if (existsSync(path.join(target, 'package.json'))) return 'husky';
  return 'pre-commit';
}

/**
 * Plan every file. Each action carries the existing and desired content plus
 * an ownership kind: seed (written only when absent), merge (ensured in place).
 */
export function plan(target, options, { resolveRev = resolveRepoToolsRev } = {}) {
  const { check = false, force = false } = options;
  const read = (file) => {
    const full = path.join(target, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const notes = [];
  const files = [];
  const hooks = detectHooks(target, options.hooks ?? 'auto');

  if (hooks === 'pre-commit') {
    const existing = read('.pre-commit-config.yaml');
    const needsRev = !existing || !findRepoToolsEntry(existing.split('\n')) || force;
    let rev = options.repoToolsRev ?? null;
    // A check run must not reach the network; the placeholder only affects the
    // desired text of a file that is already known to change.
    if (needsRev && !rev) rev = check ? '<resolved-from-main>' : resolveRev();
    files.push({ file: '.pre-commit-config.yaml', kind: 'merge', render: (text) => mergePreCommitConfig(text, rev, { force }) });
    notes.push('Install both hook stages in the primary checkout and in every linked worktree: `pre-commit install --install-hooks -t pre-commit -t pre-push` (pre-commit >= 4.4.0).');
  } else if (hooks === 'husky') {
    for (const stage of HOOK_TYPES) {
      const file = `.husky/${stage}`;
      const existing = read(file);
      if (existing && !existing.includes(GUARD) && !force) {
        notes.push(`${file} exists without the ${GUARD} guard; add the \`command -v ${GUARD}\`-guarded call${stage === 'pre-push' ? ' (pipe the captured stdin refs into `repo-require-worktree pushes`)' : ''}, or rerun with --force to replace the hook.`);
      }
      files.push({ file, kind: 'seed', mode: 0o755, render: () => renderHuskyHook(stage) });
    }
    notes.push('Wire Husky through package.json `prepare` and run `repo-install-husky-hooks` so linked worktrees keep the hooks.');
  }
  files.push({ file: 'renovate.json', kind: 'seed', protected: true, render: renderRenovateConfig });
  files.push({ file: 'AGENTS.md', kind: 'merge', render: (text) => mergeAgentsSection(text) });

  const actions = [];
  for (const entry of files) {
    const existing = read(entry.file);
    const desired = entry.render(existing);
    let action;
    if (existing === null) action = 'create';
    else if (existing === desired) action = 'unchanged';
    else if (entry.kind === 'merge') action = 'update';
    else if (entry.protected) action = 'keep';
    else if (existing.includes(GUARD)) action = 'keep';
    else action = force ? 'force-update' : 'locally-owned';
    actions.push({ ...entry, existing, desired, action });
  }
  return { actions, notes, hooks };
}

export function apply(target, planned, { check = false } = {}) {
  const results = [];
  for (const entry of planned.actions) {
    const writes = WRITES.has(entry.action);
    if (writes && !check) {
      const full = path.join(target, entry.file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, entry.desired, { mode: entry.mode });
    }
    results.push({ file: entry.file, action: entry.action, drift: writes });
  }
  return results;
}

// --- CLI --------------------------------------------------------------------

const USAGE = `usage: repo-adopt [--target DIR] [--hooks ${HOOK_FLAVORS.join('|')}] [--repo-tools-rev SHA] [--check] [--force]
Idempotently install repo-tools conventions (worktree guard hooks, Renovate preset, AGENTS.md route).
--check reports drift without writing and exits 1 when a file would change.`;

export function parseArgs(argv) {
  const options = { target: process.cwd(), hooks: 'auto', repoToolsRev: null, check: false, force: false };
  const value = (flag, next) => {
    if (next === undefined || next.startsWith('--')) throw new AdoptError(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const take = () => inline ?? value(flag, argv[++i]);
    switch (flag) {
      case '--target': options.target = take(); break;
      case '--hooks': options.hooks = take(); break;
      case '--repo-tools-rev': options.repoToolsRev = take(); break;
      case '--check': options.check = true; break;
      case '--force': options.force = true; break;
      case '-h': case '--help': options.help = true; break;
      default: throw new AdoptError(`unknown argument: ${arg}`);
    }
  }
  if (!HOOK_FLAVORS.includes(options.hooks)) throw new AdoptError(`--hooks must be one of ${HOOK_FLAVORS.join('|')}`);
  if (options.repoToolsRev !== null && !/^[0-9a-f]{7,40}$|^v?\d[\w.-]*$/.test(options.repoToolsRev)) {
    throw new AdoptError('--repo-tools-rev must be a commit SHA or tag');
  }
  return options;
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof AdoptError)) throw err;
    error(`repo-adopt: ${err.message}`);
    error(USAGE);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const target = path.resolve(options.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    error(`repo-adopt: target is not a directory: ${target}`);
    return 2;
  }
  try {
    const planned = plan(target, options);
    const results = apply(target, planned, { check: options.check });
    for (const result of results) log(`${result.action}\t${result.file}`);
    for (const note of planned.notes) log(`note\t${note}`);
    const drift = results.some((result) => result.drift);
    if (options.check) return drift ? 1 : 0;
    return 0;
  } catch (err) {
    if (!(err instanceof AdoptError)) throw err;
    error(`repo-adopt: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
