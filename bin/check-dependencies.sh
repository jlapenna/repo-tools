#!/usr/bin/env bash
# Validate portable pnpm dependency health for a repository.
#
# This command deliberately owns only the package-manager behavior that is
# common across repositories: a frozen lockfile and an internally consistent
# resolved tree. Workspace layout and dependency-namespace policy are local
# repository concerns; callers run their own checks before this command.

set -euo pipefail

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is required for repo-check-dependencies." >&2
  exit 1
fi

echo "Checking frozen lockfile..."
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts

echo "Checking dependency tree..."
tree_output=$(pnpm ls --depth=10 2>&1 || true)
if printf '%s\n' "$tree_output" | grep -Eq 'invalid:|missing:'; then
  printf '%s\n' "$tree_output"
  exit 1
fi

echo "Dependency checks passed."
