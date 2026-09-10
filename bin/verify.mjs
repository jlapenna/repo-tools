#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as checkDocs } from './docs.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length);

export function loadConfig(root, file = '.repo/verify.json') {
  const config = JSON.parse(readFileSync(path.resolve(root, file), 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.checks)) throw new Error(`${file}: expected version 1 and checks array`);
  if (config.documentationOnly !== undefined && typeof config.documentationOnly !== 'boolean') throw new Error(`${file}: documentationOnly must be boolean`);
  if (config.inventory !== undefined && (typeof config.inventory !== 'string' || !config.inventory || path.isAbsolute(config.inventory) || config.inventory.split('/').includes('..'))) throw new Error(`${file}: inventory must be a repository-relative path`);
  const ids = new Set(['docs']);
  for (const check of config.checks) {
    if (typeof check?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(check.id) || ids.has(check.id)) throw new Error(`${file}: invalid or duplicate check id: ${check?.id}`);
    ids.add(check.id);
    if (!strings(check.command) || !check.command.length) throw new Error(`${file}: ${check.id} needs a nonempty command array`);
    if (!['always', 'full'].includes(check.when ?? 'always')) throw new Error(`${file}: invalid when for ${check.id}`);
    if (check.env !== undefined && (!check.env || Array.isArray(check.env) || typeof check.env !== 'object' || Object.entries(check.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'))) throw new Error(`${file}: invalid env for ${check.id}`);
  }
  return config;
}

export function select(root, base, head, config) {
  const resolve = (ref) => git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const baseSha = resolve(base);
  const headSha = resolve(head ?? 'HEAD');
  const diff = (args) => git(root, ['diff', '--name-only', '--no-renames', '-z', ...args]).split('\0');
  let files = diff([baseSha, headSha]);
  if (!head) files.push(...diff(['HEAD']), ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'));
  files = [...new Set(files.filter(Boolean))].sort();
  const docs = config.documentationOnly === true && files.length > 0 && files.every((file) => /\.mdx?$/.test(file));
  const interpolate = (value) => value.replaceAll('{base}', baseSha).replaceAll('{head}', headSha);
  return {
    base: baseSha, head: headSha, files,
    lane: docs ? 'documentation' : 'full',
    reason: docs ? 'only Markdown changed; repository opted into documentation selection' : 'full validation: non-Markdown, empty diff, or no documentation-only opt-in',
    checks: [
      { id: 'docs', selected: true, command: ['repo-docs', 'check', ...(config.inventory ? ['--output', config.inventory] : []), '--files', ...files] },
      ...config.checks.map((check) => ({
        id: check.id,
        selected: !(docs && check.when === 'full'),
        command: check.command.flatMap((arg) => arg === '{files}' ? files : [interpolate(arg)]),
        env: Object.fromEntries(Object.entries(check.env ?? {}).map(([key, value]) => [key, interpolate(value)])),
      })),
    ],
  };
}

export function main(args) {
  const options = { root: process.cwd(), base: 'origin/main', checks: [] };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--run') options.run = true;
    else if (arg === '--help') {
      console.log('Usage: repo-verify [--root DIR] [--config FILE] [--base REF] [--head REF] [--check ID ...] [--github-output FILE] [--run]\nWithout --run, prints a JSON plan. Omit --head to include local changes. Unknown bases/checks fail. Checks come from .repo/verify.json; docs is built in.');
      return;
    } else if (['--root', '--config', '--base', '--head', '--check', '--github-output'].includes(arg) && args.length && !args[0].startsWith('--')) {
      const value = args.shift();
      if (arg === '--check') options.checks.push(value);
      else options[arg.slice(2)] = value;
    } else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  const root = path.resolve(options.root);
  const config = loadConfig(root, options.config);
  const plan = select(root, options.base, options.head, config);
  for (const id of options.checks) if (!plan.checks.some((check) => check.id === id)) throw new Error(`Unknown check: ${id}`);
  if (options.checks.length) plan.checks = plan.checks.filter((check) => options.checks.includes(check.id));
  if (options.run && options.head && git(root, ['rev-parse', 'HEAD']).trim() !== plan.head) throw new Error('--head must match the checked-out HEAD when running checks');
  console.log(JSON.stringify(plan, null, 2));
  if (options['github-output']) appendFileSync(options['github-output'], `lane=${plan.lane}\n`);
  if (!options.run) return;
  for (const check of plan.checks) {
    if (!check.selected) { console.log(`SKIP ${check.id}: ${plan.reason}`); continue; }
    console.log(`RUN ${check.id}`);
    if (check.id === 'docs') checkDocs(['check', '--root', root, ...(config.inventory ? ['--output', config.inventory] : []), '--files', ...plan.files]);
    else {
      const result = spawnSync(check.command[0], check.command.slice(1), { cwd: root, stdio: 'inherit', env: { ...process.env, ...check.env } });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${check.id} failed (${result.signal ?? result.status})`);
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
