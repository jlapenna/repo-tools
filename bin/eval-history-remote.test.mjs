import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beginRun, finishRun } from './eval-history.mjs';
import { archiveRun, remoteFind, fetchRun } from './eval-history-remote.mjs';

const available = spawnSync('rclone', ['version']).status === 0;
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, 'source'), remote = path.join(root, 'objects'), destination = path.join(root, 'restored');
  mkdirSync(remote);
  const config = { remote: `:local:${remote}`, rcloneConfig: path.join(root, 'empty.conf') };
  writeFileSync(config.rcloneConfig, '');
  const artifact = path.join(root, 'trace.txt'); writeFileSync(artifact, 'private failed experiment\n');
  const run = beginRun({ root: store, kind: 'autoresearch', subject: 'storage-fixture', inputs: { seed: 42 } });
  const record = finishRun(store, run.id, { status: 'discarded', result: { passes: 2, total: 3 }, artifacts: [artifact] });
  return { root, store, remote, destination, config, record };
}

test('real rclone publishes immutable records, discovers failed attempts and restores verified private bytes', { skip: !available }, t => {
  const f = fixture(t), { store, config, remote, destination, record } = f;
  const receipt = archiveRun(store, record.id, config);
  assert.equal(receipt.objects, 2);
  assert.equal(remoteFind({ subject: 'storage-fixture', days: 0 }, config)[0].status, 'discarded');
  assert.equal(archiveRun(store, record.id, config).objects, 2, 'repeat uploads are idempotent');
  rmSync(store, { recursive: true });
  assert.equal(fetchRun(destination, record.id, config).existing, false);
  const restored = path.join(destination, 'runs', record.id);
  assert.equal(readFileSync(path.join(restored, record.artifacts[0].path), 'utf8'), 'private failed experiment\n');
  assert.equal(statSync(restored).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(restored, record.artifacts[0].path)).mode & 0o777, 0o600);
  assert.equal(fetchRun(destination, record.id, config).existing, true);
  const key = path.join(remote, 'runs', record.id, 'record.json');
  const raw = readFileSync(key, 'utf8'); writeFileSync(key, raw.replace('discarded', 'completed'));
  assert.throws(() => fetchRun(destination, record.id, config), /refusing to overwrite/);
  assert.equal(JSON.parse(readFileSync(path.join(restored, 'record.json'))).status, 'discarded');
  assert.throws(() => archiveRun(destination, record.id, config), /rclone/);
});

test('failed artifact transfers never publish a record; corrupted downloads never enter the local store', { skip: !available }, t => {
  const f = fixture(t), { config, remote, store, record, destination } = f;
  // A remote file where the artifact directory must be makes the native copy fail.
  const runRemote = path.join(remote, 'runs', record.id); mkdirSync(runRemote, { recursive: true });
  writeFileSync(path.join(runRemote, 'artifacts'), 'blocked');
  assert.throws(() => archiveRun(store, record.id, config), /rclone/);
  assert.equal(existsSync(path.join(runRemote, 'record.json')), false);
  rmSync(path.join(runRemote, 'artifacts'));
  archiveRun(store, record.id, config);
  writeFileSync(path.join(runRemote, record.artifacts[0].path), 'corrupt');
  assert.throws(() => fetchRun(destination, record.id, config), /checksum mismatch/);
  assert.equal(existsSync(path.join(destination, 'runs', record.id)), false);
  const raw = { ...record, artifacts: [{ ...record.artifacts[0], path: 'artifacts/..' }] };
  writeFileSync(path.join(runRemote, 'record.json'), JSON.stringify(raw));
  assert.throws(() => fetchRun(destination, record.id, config), /Invalid archived artifact/);
});

test('CLI auto-archives terminal records and finds them from an empty second store', { skip: !available }, t => {
  const f = fixture(t), configFile = path.join(f.root, 'config.json'), inputs = path.join(f.root, 'inputs.json');
  writeFileSync(configFile, JSON.stringify(f.config)); writeFileSync(inputs, '{"suite":"ordinary"}');
  const cli = (store, ...args) => spawnSync(process.execPath, [new URL('./eval-history.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8', env: { ...process.env, EVAL_HISTORY_DIR: store, EVAL_HISTORY_CONFIG: configFile, EVAL_HISTORY_REMOTE: f.config.remote } });
  const run = cli(f.store, 'record', '--kind', 'model', '--subject', 'cli-remote', '--inputs', inputs, '--status', 'failed');
  assert.equal(run.status, 0, run.stderr);
  const record = JSON.parse(run.stdout); assert.ok(record.archive.remote);
  const found = cli(f.destination, 'find', '--subject', 'cli-remote');
  assert.equal(found.status, 0, found.stderr); assert.equal(JSON.parse(found.stdout)[0].id, record.id);
  assert.deepEqual(JSON.parse(cli(f.destination, 'find', '--local').stdout), []);
  const fetched = cli(f.destination, 'fetch', '--all'); assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(JSON.parse(fetched.stdout).length, 1);
});
