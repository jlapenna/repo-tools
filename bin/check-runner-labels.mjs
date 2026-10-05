#!/usr/bin/env node
// Reject GitHub Actions jobs whose literal `runs-on` pairs `self-hosted` with a
// label declared in `.github/actionlint.yaml` (`self-hosted-runner.labels`).
//
// actionlint accepts `self-hosted` everywhere, so it cannot see this mistake.
// For a repository whose declared labels name Actions Runner Controller scale
// sets, the combination is unschedulable: a scale set matches a job only by its
// own name, so `[self-hosted, <scale-set>]` waits in the queue indefinitely.
// Adopting this check is that declaration; repositories with classic runners
// that really carry both labels should not run it.
//
// Usage: repo-check-runner-labels [file ...]
// With no workflow file arguments (or when the actionlint config itself is
// passed), every file under .github/workflows is checked. Dependency-free so it
// runs as a pre-commit `unsupported_script` hook without an npm install.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIGS = ['.github/actionlint.yaml', '.github/actionlint.yml'];
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const indentOf = (line) => line.length - line.trimStart().length;
const stripComment = (text) => text.replace(/(^|\s)#.*$/, '');

// Labels from a runs-on (or labels) value: plain/quoted scalars, flow and block
// sequences, and string literals inside `${{ }}` expressions such as
// fromJSON('["self-hosted","x"]'). Mapping keys (group:, labels:) are dropped;
// a runner group's name is not a label.
export function labelsIn(text) {
  const labels = [];
  const literals = (expr) => [...expr.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  const body = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    for (const literal of literals(expr)) labels.push(...tokens(literal));
    return ' ';
  });
  for (const line of body.split('\n')) {
    const value = stripComment(line).replace(/^\s*-\s+/, '').replace(/^\s*group\s*:.*$/, '');
    labels.push(...tokens(value.replace(/^\s*labels\s*:/, '')));
  }
  return labels;
}

function tokens(text) {
  return text
    .split(/[\s,[\]'"]+/)
    .filter((token) => token && token !== '-' && !token.endsWith(':'));
}

// Value of a `key:` at line index i: inline text, else the more-indented block.
function blockValue(lines, i, inline) {
  if (inline.trim() && !/^[|>]/.test(inline.trim())) return { text: inline, end: i };
  const keyIndent = indentOf(lines[i].replace(/^(\s*)-\s+/, '$1  '));
  const block = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
    if (indentOf(lines[j]) <= keyIndent) break;
    block.push(lines[j]);
  }
  return { text: block.join('\n'), end: j - 1 };
}

export function declaredLabels(configText) {
  const lines = configText.split('\n');
  const section = lines.findIndex((line) => /^self-hosted-runner\s*:/.test(line));
  if (section < 0) return [];
  for (let i = section + 1; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > 0 || /^\s*#/.test(lines[i])); i++) {
    const match = /^\s+labels\s*:(.*)$/.exec(stripComment(lines[i]));
    if (match) return labelsIn(blockValue(lines, i, match[1]).text);
  }
  return [];
}

export function violations(workflowText, declared, file = '<workflow>') {
  const found = [];
  const lines = workflowText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:-\s+)?runs-on\s*:(.*)$/.exec(lines[i]);
    if (!match) continue;
    const { text } = blockValue(lines, i, stripComment(match[1]));
    const labels = labelsIn(text);
    const fleet = [...new Set(labels.filter((label) => declared.includes(label)))];
    if (labels.includes('self-hosted') && fleet.length) {
      found.push(
        `${file}:${i + 1}: runs-on combines "self-hosted" with declared runner label(s) ${fleet.join(', ')}; ` +
          `a runner scale set matches only its own name, so this job never schedules. Use ${JSON.stringify(fleet)} without "self-hosted".`,
      );
    }
  }
  return found;
}

function main(args) {
  const config = CONFIGS.find((candidate) => existsSync(candidate));
  const declared = config ? declaredLabels(readFileSync(config, 'utf8')) : [];
  if (!declared.length) return 0;

  const normalized = args.map((arg) => path.relative('.', arg).split(path.sep).join('/'));
  let files = normalized.filter((file) => WORKFLOW.test(file));
  if (!files.length || normalized.some((file) => CONFIGS.includes(file))) {
    const dir = '.github/workflows';
    files = existsSync(dir)
      ? readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).map((name) => `${dir}/${name}`)
      : [];
  }

  const found = files
    .filter((file) => existsSync(file))
    .flatMap((file) => violations(readFileSync(file, 'utf8'), declared, file));
  for (const message of found) console.error(message);
  return found.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
