// Optional shared blob archive, using rclone's maintained S3/GCS backends.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readRun, historyRoot, selectRuns, findRuns } from './eval-history.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = id => /^[0-9a-f-]{36}$/.test(id);

export function archiveConfig() {
  const file = process.env.EVAL_HISTORY_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'eval-history/config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const remote = process.env.EVAL_HISTORY_REMOTE ?? config.remote;
  if (!remote) return null;
  if (typeof remote !== 'string' || !remote.trim() || /[\r\n]/.test(remote)) throw Error('Invalid evaluation archive remote');
  return { remote: remote.replace(/\/$/, ''), rcloneConfig: process.env.EVAL_HISTORY_RCLONE_CONFIG ?? config.rcloneConfig };
}

function command(config, args) {
  const flags = ['--retries', '1', '--low-level-retries', '1', '--contimeout', '10s', '--timeout', '2m', '--log-level', 'ERROR'];
  if (config.rcloneConfig) flags.push('--config', config.rcloneConfig);
  const r = spawnSync('rclone', [...args, ...flags], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  // Do not relay provider diagnostics: credential helpers and authenticated
  // responses can include private material. Preserve the native exit code.
  if (r.error || r.status !== 0) throw Error(`Shared evaluation archive ${args[0]} failed (rclone ${r.error?.code ?? r.status}); local evidence is preserved`);
  return r.stdout;
}

function artifactPaths(record) {
  if (!uuid(record.id) || record.status === 'running' || !Array.isArray(record.artifacts)) throw Error('Only terminal evaluation records can be archived');
  return record.artifacts.map(a => {
    if (typeof a.path !== 'string' || !/^artifacts\/[^/\r\n]+$/.test(a.path) || ['.', '..'].includes(a.path.slice(10)) || /[\\\x00-\x1f]/.test(a.path) || !/^[0-9a-f]{64}$/.test(a.sha256)) throw Error('Invalid archived artifact manifest');
    return a.path;
  });
}

function verify(dir, record) {
  for (const [i, file] of artifactPaths(record).entries()) {
    const bytes = readFileSync(path.join(dir, file));
    if (sha(bytes) !== record.artifacts[i].sha256 || bytes.length !== record.artifacts[i].bytes) throw Error(`Evaluation artifact checksum mismatch: ${file}`);
  }
}

export function archiveRun(root, id, config = archiveConfig()) {
  if (!config) return null;
  const record = readRun(root, id), dir = path.join(root, 'runs', id);
  verify(dir, record);
  const files = artifactPaths(record), manifest = path.join(dir, `.archive-files-${randomUUID()}`);
  try {
    writeFileSync(manifest, files.join('\n') + (files.length ? '\n' : ''), { mode: 0o600 });
    const remote = `${config.remote}/runs/${id}`;
    if (files.length) command(config, ['copy', dir, remote, '--files-from-raw', manifest, '--immutable', '--checksum', '--transfers', '2', '--checkers', '2']);
    // This last immutable object is the discovery/commit marker. Failed
    // artifact transfers never advertise an incomplete run as available.
    writeFileSync(manifest, 'record.json\n', { mode: 0o600 });
    command(config, ['copy', dir, remote, '--files-from-raw', manifest, '--immutable', '--checksum', '--transfers', '2', '--checkers', '2']);
    const receipt = { id, remote, uploadedAt: new Date().toISOString(), objects: files.length + 1 };
    writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } finally { rmSync(manifest, { force: true }); }
}

export function remoteFind(options = {}, config = archiveConfig()) {
  if (!config) throw Error('No shared evaluation archive configured');
  // Terminal records are immutable: refresh only missing markers in one native
  // batch, then filter locally. Repeated lookups never spawn one process/GET per
  // historical run. Keep each remote profile's private catalog separate.
  const cache = config.cacheDir ?? path.join(historyRoot(), 'catalog', sha(Buffer.from(JSON.stringify([config.remote, config.rcloneConfig ?? '']))));
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  command(config, ['copy', config.remote, cache, '--include', '/runs/*/record.json', '--fast-list', '--ignore-existing', '--transfers', '4', '--checkers', '4']);
  const runs = path.join(cache, 'runs');
  const records = (existsSync(runs) ? readdirSync(runs) : []).filter(uuid).map(id => {
    const marker = path.join(runs, id, 'record.json');
    const r = JSON.parse(readFileSync(marker, 'utf8'));
    if (r.id !== id) throw Error('Shared evaluation record identity mismatch');
    artifactPaths(r); chmodSync(marker, 0o600);
    return { ...r, archive: { remote: `${config.remote}/runs/${r.id}` } };
  });
  return selectRuns(records, options);
}

export function fetchRun(root, id, config = archiveConfig()) {
  if (!config || !uuid(id)) throw Error('A configured archive and valid run id are required');
  const remote = `${config.remote}/runs/${id}`;
  const raw = command(config, ['cat', `${remote}/record.json`]), record = JSON.parse(raw);
  if (record.id !== id) throw Error('Shared evaluation record identity mismatch');
  const files = artifactPaths(record);
  mkdirSync(path.join(root, 'runs'), { recursive: true, mode: 0o700 });
  const dir = path.join(root, 'runs', id);
  if (existsSync(dir)) {
    if (readFileSync(path.join(dir, 'record.json'), 'utf8') !== raw) throw Error('Local record differs; refusing to overwrite evaluation history');
    verify(dir, record);
    return { id, out: dir, existing: true };
  }
  const temp = mkdtempSync(path.join(root, 'runs/.fetch-'));
  try {
    const list = path.join(temp, '.files'); writeFileSync(list, files.join('\n') + (files.length ? '\n' : ''), { mode: 0o600 });
    if (files.length) command(config, ['copy', remote, temp, '--files-from-raw', list, '--transfers', '2', '--checkers', '2']);
    verify(temp, record);
    rmSync(list);
    if (files.length) chmodSync(path.join(temp, 'artifacts'), 0o700);
    for (const file of files) chmodSync(path.join(temp, file), 0o600);
    writeFileSync(path.join(temp, 'record.json'), raw, { mode: 0o600 });
    renameSync(temp, dir);
    return { id, out: dir, existing: false };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function archiveCommand(commandName, options, root = historyRoot()) {
  const config = archiveConfig();
  if (!config) throw Error('No shared evaluation archive configured');
  if (commandName === 'remote-find') return remoteFind(options, config);
  const ids = options.all
    ? (commandName === 'upload'
      ? findRuns({ root, days: 0, limit: Number.MAX_SAFE_INTEGER }).filter(r => r.status !== 'running')
      : remoteFind({ days: 0, limit: Number.MAX_SAFE_INTEGER }, config)).map(r => r.id)
    : [options.id];
  return ids.map(id => commandName === 'upload' ? archiveRun(root, id, config) : fetchRun(root, id, config));
}

