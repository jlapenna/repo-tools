#!/usr/bin/env node
// Package PATH entrypoint; the installed plugin bundles the canonical
// implementation under plugins/repo-tools/scripts.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [resolve(root, 'plugins/repo-tools/scripts/repo-autonomous-work-hook.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
