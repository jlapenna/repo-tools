#!/usr/bin/env bash
# Managed by repo-install-worktree-guard. This file is copied into core.hooksPath.
set -euo pipefail

fail() {
  echo "repo-tools worktree hook: $*" >&2
  exit 1
}

hook_name="$(basename "$0")"
case "$hook_name" in
  pre-commit | pre-push) ;;
  *) fail "unsupported hook name: $hook_name" ;;
esac

guard_command="$(git config --local --get repoTools.worktreeGuard.command || true)"
previous_hooks="$(git config --local --get repoTools.worktreeGuard.previousHooksPath || true)"
[ -n "$guard_command" ] || fail "missing repoTools.worktreeGuard.command; rerun repo-install-worktree-guard"
[ -x "$guard_command" ] || fail "guard command is not executable: $guard_command"
[ -n "$previous_hooks" ] || fail "missing prior hook path; rerun repo-install-worktree-guard"

case "$previous_hooks" in
  /*) previous_hook="$previous_hooks/$hook_name" ;;
  ~/*) previous_hook="$HOME/${previous_hooks#~/}/$hook_name" ;;
  *) previous_hook="$(git rev-parse --show-toplevel)/$previous_hooks/$hook_name" ;;
esac

if [ "$hook_name" = "pre-commit" ]; then
  "$guard_command" "commits and pushes"
  if [ -x "$previous_hook" ]; then
    exec "$previous_hook" "$@"
  fi
  exit 0
fi

stdin_file="$(mktemp "${TMPDIR:-/tmp}/repo-tools-pre-push.XXXXXX")"
cleanup() {
  rm -f "$stdin_file"
}
trap cleanup EXIT HUP INT TERM
cat >"$stdin_file"

"$guard_command" pushes <"$stdin_file"
if [ -x "$previous_hook" ]; then
  "$previous_hook" "$@" <"$stdin_file"
fi
