#!/usr/bin/env node
// Package PATH entrypoint; the installed plugin bundles the canonical
// implementation under plugins/repo-tools/scripts.
import { main } from '../plugins/repo-tools/scripts/repo-hindsight-dream.mjs';

main().then((code) => {
  process.exitCode = code;
});
