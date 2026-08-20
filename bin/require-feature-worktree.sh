#!/usr/bin/env bash
# Reject commits and pushes from the shared primary checkout or main.
#
# This command is repository-neutral. It is installed as
# `repo-require-worktree`; hooks may call it behind a `command -v` guard so
# machines without the package degrade quietly.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  exit 0
fi

action="${1:-commits and pushes}"

# A deletion-only push carries no content and normally originates in the
# primary checkout after its worktree has gone. Do not create a guardrail that
# can only be bypassed with --no-verify. A mixed push remains guarded.
if [ "$action" = "pushes" ] && [ ! -t 0 ]; then
  refs="$(cat)"
  if [ -n "$refs" ] &&
    printf '%s\n' "$refs" |
      awk '$2 ~ /^0+$/ { del++ } $2 !~ /^0+$/ { other++ } END { exit !(del > 0 && other == 0) }'; then
    echo "repo-require-worktree: deletion-only push (no content) -- worktree guard skipped." >&2
    exit 0
  fi
fi

git_dir="$(git rev-parse --path-format=absolute --git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
branch="$(git symbolic-ref --quiet --short HEAD || printf '<detached HEAD>')"

if [ "$git_dir" != "$common_dir" ] && [ "$branch" != "main" ]; then
  exit 0
fi

echo "======================================================================" >&2
echo "ERROR: $action must come from a feature worktree." >&2
if [ "$git_dir" = "$common_dir" ]; then
  echo "This is the primary checkout, which is reserved for a clean main." >&2
else
  echo "Direct $action to main are forbidden." >&2
fi
echo "Create a feature worktree from origin/main and submit a pull request." >&2
if [ -n "${REQUIRE_WORKTREE_EXTRA_HINT:-}" ]; then
  echo "$REQUIRE_WORKTREE_EXTRA_HINT" >&2
fi
echo "======================================================================" >&2
exit 1
