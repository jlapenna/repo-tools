#!/usr/bin/env node
// Read-only diagnosis of the installed repo-tools runtime: where it resolves
// from, whether its commands and the ones Codex/Claude hooks call are on PATH
// and point at files that still exist, and which plugin versions are
// installed. It never repairs, installs, edits configuration, or uses the
// network, and reads hook configuration only for command names: prompt data,
// hook payloads, and hook command text are never read from stdin or printed.
//
// Usage: repo-doctor [--json]
// Exit: 0 when no check fails (warnings allowed), 1 when any check fails,
// 64 on a usage error.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = Object.keys(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).bin);

// Required by every command and hook helper; the rest serve specific commands.
const RUNTIME = { git: true, bash: true, gh: false, jq: false };

function which(name, env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // absent or not executable here; the shell would keep searching too
    }
  }
  return null;
}

// The file a PATH entry finally runs: a symlink's target, or the target a pnpm
// shim records. A missing target means a stale install.
function shimTarget(file) {
  const real = realpathSync(file);
  const text = readFileSync(real, 'utf8').slice(-4096);
  const recorded = /^# cmd-shim-target=(.+)$/m.exec(text)?.[1];
  return recorded ?? real;
}

function hookCommands(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const found = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'command' && typeof value === 'string') {
          // Command-position words only, so a path such as .../repo-tools/...
          // is not a command. Names the current package no longer ships are
          // kept: a hook calling a removed command is exactly what must fail.
          for (const [, name] of value.matchAll(/(?:^|[\s|;&(`])(repo-[a-z0-9-]+)(?=$|[\s|;&)`])/g)) found.add(name);
        } else visit(value);
      }
    }
  };
  visit(config.hooks);
  return [...found].sort();
}

function versions(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const newest = (list) =>
  [...list].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null;

export function diagnose({ env = process.env, cwd = process.cwd() } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const home = env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');

  let packageCommit = null;
  try {
    packageCommit = execFileSync('git', ['-C', packageRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // an installed package is not a git checkout
  }

  const major = Number(process.versions.node.split('.')[0]);
  add('runtime:node', major >= 24 ? 'ok' : 'warn', `${process.execPath} v${process.versions.node}${major >= 24 ? '' : ' (package engines require 24)'}`);
  for (const [name, required] of Object.entries(RUNTIME)) {
    const found = which(name, env);
    add(`runtime:${name}`, found ? 'ok' : required ? 'fail' : 'warn', found ?? `missing ${name} on PATH`);
  }

  const hooks = [
    ['codex', path.join(codexHome, 'hooks.json')],
    ['claude', path.join(claudeHome, 'settings.json')],
  ];
  const hooked = new Map();
  for (const [runtime, file] of hooks) {
    if (!existsSync(file)) continue;
    const names = hookCommands(file);
    if (names === null) {
      add(`hooks:${runtime}`, 'warn', `${file} is not valid JSON; hook commands not checked`);
      continue;
    }
    add(`hooks:${runtime}`, 'ok', `${file} calls ${names.length ? names.join(', ') : 'no repo-tools commands'}`);
    for (const name of names) hooked.set(name, [...(hooked.get(name) ?? []), runtime]);
  }

  const roots = new Set();
  for (const name of [...new Set([...commands, ...hooked.keys()])]) {
    const found = which(name, env);
    const by = hooked.get(name);
    const needed = by ? ` (required by ${by.join(' and ')} hooks)` : '';
    if (!found) {
      add(`command:${name}`, by ? 'fail' : 'warn', `missing ${name} on PATH${needed}`);
      continue;
    }
    let target;
    try {
      target = shimTarget(found);
    } catch {
      target = null;
    }
    if (!target || !existsSync(target)) {
      add(`command:${name}`, 'fail', `stale: ${found} points at missing ${target ?? 'target'}${needed}`);
      continue;
    }
    roots.add(path.dirname(path.dirname(realpathSync(target))));
    add(`command:${name}`, 'ok', `${found} -> ${target}`);
  }
  if (roots.size > 1) add('commands:install', 'warn', `commands resolve from ${roots.size} installs: ${[...roots].join(', ')}`);

  const claudePlugins = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const claudeVersions = [];
  if (existsSync(claudePlugins)) {
    try {
      const installed = JSON.parse(readFileSync(claudePlugins, 'utf8')).plugins ?? {};
      for (const [key, entries] of Object.entries(installed)) {
        if (!key.startsWith('repo-tools@')) continue;
        for (const entry of entries) {
          claudeVersions.push(entry.version);
          if (existsSync(entry.installPath)) add(`plugin:claude:${key}`, 'ok', `${entry.version} at ${entry.installPath}`);
          else add(`plugin:claude:${key}`, 'fail', `stale: ${entry.version} install path ${entry.installPath} is missing`);
        }
      }
    } catch {
      add('plugin:claude', 'warn', `${claudePlugins} is not valid JSON`);
    }
  }
  const codexConfig = path.join(codexHome, 'config.toml');
  // Enabled unless its own section says `enabled = false`.
  const codexSection = existsSync(codexConfig)
    ? /^\[plugins\."repo-tools@[^"]+"\]\s*\n((?:(?!\[).*\n?)*)/m.exec(readFileSync(codexConfig, 'utf8'))
    : null;
  if (codexSection && !/^\s*enabled\s*=\s*false\b/m.test(codexSection[1])) {
    const cache = path.join(codexHome, 'plugins', 'cache', 'repo-tools', 'repo-tools');
    const latest = newest(versions(cache));
    if (latest) add('plugin:codex', 'ok', `${latest} at ${path.join(cache, latest)}`);
    else add('plugin:codex', 'fail', `stale: repo-tools is enabled in ${codexConfig} but ${cache} has no installed version`);
    const claudeLatest = newest(claudeVersions);
    if (latest && claudeLatest && latest !== claudeLatest) {
      add('plugin:versions', 'warn', `codex has ${latest}, claude has ${claudeLatest}`);
    }
  }

  let repository = null;
  try {
    repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // not inside a repository, or git is missing (reported above)
  }

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    package: { root: packageRoot, commit: packageCommit },
    repository,
    checks,
  };
}

function main(argv) {
  if (argv.some((arg) => arg !== '--json')) {
    process.stderr.write('usage: repo-doctor [--json]\n');
    return 64;
  }
  const report = diagnose();
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    // Healthy commands collapse to one line; anything else is listed.
    const healthy = report.checks.filter((c) => commands.includes(c.name.slice('command:'.length)) && c.status === 'ok');
    const lines = [
      `repo-tools ${report.package.root}${report.package.commit ? ` @ ${report.package.commit.slice(0, 12)}` : ''}`,
      `repository: ${report.repository ?? 'none (not a git repository)'}`,
      ...report.checks
        .filter((c) => !healthy.includes(c))
        .map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.name}: ${c.detail}`),
      `OK   commands: ${healthy.length}/${commands.length} resolve on PATH`,
      report.ok ? 'OK' : `FAIL ${report.checks.filter((c) => c.status === 'fail').map((c) => c.name).join(' ')}`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
