#!/usr/bin/env node
// Package PATH entrypoint; the installed Codex/Claude plugin bundles the
// canonical implementation under plugins/repo-tools/scripts.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [resolve(root, 'plugins/repo-tools/scripts/repo-set-tmux-task-title.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
