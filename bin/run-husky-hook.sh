#!/usr/bin/env bash
set -euo pipefail
hook="${1:?Git hook name is required}"
shift
[[ "$hook" =~ ^[a-z-]+$ ]] || { echo 'invalid Git hook name' >&2; exit 2; }
root="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --path-format=absolute --git-common-dir)"
project_hooks="$(git config --local --get repoTools.huskyDirectory)"
[[ -n "$project_hooks" && "$project_hooks" != /* && "$project_hooks" != *..* ]] || {
  echo 'invalid shared Husky hook configuration; rerun project setup' >&2; exit 1;
}
bootstrap="$common/repo-tools-husky/h"
[[ -r "$bootstrap" ]] || { echo 'shared Husky bootstrap missing; rerun project setup' >&2; exit 1; }
cd "$root"
# Husky derives the tracked hook from $0. Supply this worktree's path even
# when its ignored _ directory does not exist. Source the common generated h
# without changing its original arguments/stdin or global init behavior.
exec sh -c 'bootstrap=$1; shift; . "$bootstrap"' "$root/$project_hooks/_/$hook" "$bootstrap" "$@"
