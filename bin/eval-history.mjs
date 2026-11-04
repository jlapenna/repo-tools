#!/usr/bin/env node
// Private, durable provenance for skill/model evals and optimization attempts.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, copyFileSync, realpathSync, chmodSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const historyRoot = () => path.resolve(process.env.EVAL_HISTORY_DIR || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state'), 'eval-history'));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const inputFingerprint = inputs => createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex');
const statuses = new Set(['running', 'completed', 'failed', 'partial', 'kept', 'discarded', 'inconclusive']);
function runPath(root, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid evaluation run id');
  return path.join(root, 'runs', id);
}
function save(root, record) {
  const dir = runPath(root, record.id);
  const temp = path.join(dir, `.record-${randomUUID()}.json`);
  writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, path.join(dir, 'record.json'));
  return record;
}
export function readRun(root, id) { return JSON.parse(readFileSync(path.join(runPath(root, id), 'record.json'), 'utf8')); }
export function beginRun({ kind, subject, inputs, summary = '', root = historyRoot(), now = new Date() }) {
  if (typeof kind !== 'string' || !kind.trim() || typeof subject !== 'string' || !subject.trim() || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw Error('kind, subject and an inputs object are required');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, 'runs'), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  mkdirSync(runPath(root, id), { mode: 0o700 });
  return save(root, { schemaVersion: 1, id, kind, subject, inputs, fingerprint: inputFingerprint(inputs), summary, status: 'running', host: hostname(), createdAt: now.toISOString(), updatedAt: now.toISOString(), artifacts: [] });
}
export function finishRun(root, id, { status, summary, result = {}, artifacts = [], now = new Date() }) {
  if (!statuses.has(status) || status === 'running') throw Error('A terminal evaluation status is required');
  const record = readRun(root, id);
  if (record.status !== 'running') throw Error('Evaluation record is already terminal; record a new attempt instead');
  const dir = path.join(runPath(root, id), 'artifacts');
  mkdirSync(dir, { mode: 0o700 });
  const saved = artifacts.map((file, i) => {
    const source = path.resolve(file);
    if (!statSync(source).isFile()) throw Error('Artifacts must be explicitly selected regular files');
    const bytes = readFileSync(source);
    const name = `${i}-${path.basename(source)}`;
    const target = path.join(dir, name);
    copyFileSync(source, target); chmodSync(target, 0o600);
    return { source, path: `artifacts/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return save(root, { ...record, status, ...(summary !== undefined ? { summary } : {}), result, artifacts: saved, updatedAt: now.toISOString() });
}
export function findRuns({ root = historyRoot(), kind, subject, inputs, fingerprint, days = 90, now = new Date(), limit = 20 } = {}) {
  if (!Number.isFinite(days) || days < 0 || !Number.isInteger(limit) || limit < 1) throw Error('days must be nonnegative and limit positive');
  const wanted = fingerprint ?? (inputs ? inputFingerprint(inputs) : undefined);
  let dirs;
  try { dirs = readdirSync(path.join(root, 'runs')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const id of dirs) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const r = readRun(root, id);
    if ((kind && r.kind !== kind) || (subject && r.subject !== subject) || (wanted && r.fingerprint !== wanted)) continue;
    if (days && new Date(r.createdAt).getTime() < now.getTime() - days * 86400000) continue;
    rows.push(r);
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function main(argv) {
  const args = [...argv], command = args.shift();
  if (!command || command === '--help') {
    console.log('repo-eval-history begin --kind KIND --subject SUBJECT --inputs FILE [--summary TEXT]\nrepo-eval-history finish --id ID --status STATUS [--summary TEXT] [--result FILE] [--artifact FILE]...\nrepo-eval-history record --kind KIND --subject SUBJECT --inputs FILE --status STATUS [--result FILE] [--artifact FILE]...\nrepo-eval-history find [--kind KIND] [--subject SUBJECT] [--inputs FILE] [--days 90] [--limit 20]\nrepo-eval-history show --id ID\nAll commands emit JSON. --store DIR overrides EVAL_HISTORY_DIR or the private XDG state store. No automatic deletion.');
    return 0;
  }
  const o = { artifacts: [] };
  while (args.length) {
    const flag = args.shift();
    if (!['--store', '--kind', '--subject', '--inputs', '--summary', '--id', '--status', '--result', '--artifact', '--days', '--limit'].includes(flag) || !args.length) throw Error(`Unknown or incomplete option: ${flag}`);
    const v = args.shift();
    if (flag === '--artifact') o.artifacts.push(path.resolve(v));
    else o[flag.slice(2)] = v;
  }
  const root = o.store ? path.resolve(o.store) : historyRoot();
  const inputs = o.inputs ? JSON.parse(readFileSync(o.inputs, 'utf8')) : undefined;
  const result = o.result ? JSON.parse(readFileSync(o.result, 'utf8')) : {};
  let value;
  if (command === 'begin' || command === 'record') {
    if (command === 'record' && (!statuses.has(o.status) || o.status === 'running')) throw Error('record needs a terminal --status');
    value = beginRun({ root, kind: o.kind, subject: o.subject, inputs, summary: o.summary });
    if (command === 'record') value = finishRun(root, value.id, { status: o.status, result, artifacts: o.artifacts });
  } else if (command === 'finish') value = finishRun(root, o.id, { status: o.status, summary: o.summary, result, artifacts: o.artifacts });
  else if (command === 'find') value = findRuns({ root, kind: o.kind, subject: o.subject, inputs, days: o.days === undefined ? 90 : Number(o.days), limit: o.limit === undefined ? 20 : Number(o.limit) });
  else if (command === 'show') value = readRun(root, o.id);
  else throw Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(value, null, 2));
  return 0;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
