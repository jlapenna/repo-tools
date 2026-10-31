#!/usr/bin/env bash
# Remove a checkout whose exact head is verified landed. Finished work is never
# archived, so leftover uncommitted files go with it; every other
# safe-remove-worktree guard (live processes, locks, the Git link) still applies.
# Usage: remove-landed-worktree.sh <worktree-path> [safe-remove-worktree options]
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec "$here/safe-remove-worktree.sh" "${1:?usage: remove-landed-worktree.sh <worktree-path>}" --discard-changes "${@:2}"
