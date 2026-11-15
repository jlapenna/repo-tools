#!/usr/bin/env node
// Package PATH entrypoint; the installed plugin bundles the canonical
// implementation under plugins/repo-tools/scripts.
import { main } from '../plugins/repo-tools/scripts/repo-autonomous-work-hook.mjs';

try {
  process.exitCode = main();
} catch {
  process.stdout.write('{}\n');
  process.exitCode = 0;
}
