#!/usr/bin/env bash
# Publish Husky's generated bootstrap into Git's common directory so new linked
# worktrees execute their tracked hooks even before their first pnpm install.
set -euo pipefail

if [[ "${1:-}" == --help ]]; then
  echo 'usage: repo-install-husky-hooks [PROJECT_HOOK_DIRECTORY]'
  echo 'Run after Husky installation. Defaults to .husky; no tracked hook is copied.'
  exit 0
fi
[[ $# -le 1 ]] || { echo 'expected at most one hook directory' >&2; exit 2; }
project_hooks="${1:-.husky}"
[[ "$project_hooks" != /* && "$project_hooks" != *..* && "$project_hooks" != *$'\n'* ]] || {
  echo 'hook directory must be a repository-relative path without ..' >&2; exit 2;
}
root="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --path-format=absolute --git-common-dir)"
bootstrap="$root/$project_hooks/_/h"
[[ -f "$bootstrap" ]] || { echo 'Husky bootstrap missing; run the project install first' >&2; exit 1; }
current="$(git config --local --get core.hooksPath || true)"
target="$common/repo-tools-husky"
[[ "$current" == "$project_hooks/_" || "$current" == "$target" ]] || {
  echo 'refusing to replace a non-Husky core.hooksPath' >&2; exit 1;
}
mkdir -p "$target"
# Atomic file replacement keeps a concurrent hook invocation from reading a
# partial bootstrap. Only upstream-generated runtime is stored here; project
# policy continues to come from the current worktree's tracked hook files.
staging="$(mktemp -d "$target/.install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
cp "$(dirname "${BASH_SOURCE[0]}")/run-husky-hook.sh" "$staging/run-hook"
chmod 0755 "$staging/run-hook"
mv -f "$staging/run-hook" "$target/run-hook"
cp "$bootstrap" "$staging/h"
mv -f "$staging/h" "$target/h"
for hook in applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push post-rewrite pre-auto-gc; do
  cat > "$staging/$hook" <<'HOOK'
#!/bin/sh
exec "$(dirname "$0")/run-hook" "$(basename "$0")" "$@"
HOOK
  chmod 0755 "$staging/$hook"
  mv -f "$staging/$hook" "$target/$hook"
done
git config --local repoTools.huskyDirectory "$project_hooks"
git config --local core.hooksPath "$target"
echo 'Installed shared Husky bootstrap; each worktree keeps its own tracked hooks.'
