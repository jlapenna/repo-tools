#!/usr/bin/env bash
# Package PATH entrypoint; the installed Codex/Claude plugin bundles the
# canonical implementation under plugins/repo-tools/scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../plugins/repo-tools/scripts/repo-watch-prs.sh" "$@"
