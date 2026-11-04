import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beginRun, finishRun, findRuns, readRun, inputFingerprint } from './eval-history.mjs';

test('public CLI records and discovers a finished ordinary evaluation', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-history-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs.json');
  writeFileSync(inputs, JSON.stringify({ suite: 'ordinary-regression', model: 'fixed' }));
  const cli = (...args) => spawnSync(process.execPath, [new URL('./eval-history.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, EVAL_HISTORY_DIR: path.join(root, 'history'), EVAL_HISTORY_CONFIG: path.join(root, 'no-config'), EVAL_HISTORY_REMOTE: '' } });
  const recorded = cli('record', '--kind', 'model', '--subject', 'tools', '--inputs', inputs, '--status', 'failed', '--summary', 'Candidate regressed');
  assert.equal(recorded.status, 0, recorded.stderr);
  const record = JSON.parse(recorded.stdout);
  const found = cli('find', '--kind', 'model', '--subject', 'tools', '--inputs', inputs);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout)[0].id, record.id);
  assert.equal(JSON.parse(cli('show', '--id', record.id).stdout).summary, 'Candidate regressed');
  assert.equal(cli('finish', '--id', record.id, '--status', 'completed').status, 1);
});

test('shared eval history retains failures, hypotheses and artifact bytes after scratch cleanup', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'discarded.patch'); writeFileSync(artifact, 'a failed candidate\n');
  const inputs = { suite: 'readiness', model: 'unchanged', sourceHash: 'abc', hypothesis: 'clarify tool outputs' };
  const run = beginRun({ root, kind: 'autoresearch', subject: 'readiness', inputs });
  assert.equal(readRun(root, run.id).status, 'running');
  const done = finishRun(root, run.id, { status: 'discarded', summary: 'No gain', result: { passes: 2, total: 3 }, artifacts: [artifact] });
  rmSync(artifact);
  assert.equal(readFileSync(path.join(root, 'runs', run.id, done.artifacts[0].path), 'utf8'), 'a failed candidate\n');
  assert.equal(statSync(path.join(root, 'runs', run.id)).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(root, 'runs', run.id, 'record.json')).mode & 0o777, 0o600);
  assert.equal(findRuns({ root, kind: 'autoresearch', subject: 'readiness', inputs })[0].status, 'discarded');
  assert.equal(findRuns({ root, inputs: { ...inputs, model: 'different' } }).length, 0);
  assert.throws(() => finishRun(root, run.id, { status: 'kept' }), /already terminal/);
});

test('lookup window is not deletion; equivalent input objects match and run identities never overwrite', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(inputFingerprint({ a: 1, b: { x: 2 } }), inputFingerprint({ b: { x: 2 }, a: 1 }));
  const a = beginRun({ root, kind: 'model', subject: 'tools', inputs: { model: 'a' }, now: new Date('2025-01-01') });
  const b = beginRun({ root, kind: 'model', subject: 'tools', inputs: { model: 'a' }, now: new Date('2025-01-01') });
  assert.notEqual(a.id, b.id);
  assert.equal(findRuns({ root, now: new Date('2025-06-01') }).length, 0);
  assert.equal(findRuns({ root, days: 0 }).length, 2);
  assert.equal(readRun(root, a.id).status, 'running');
  assert.throws(() => readRun(root, '../outside'), /Invalid/);
});
