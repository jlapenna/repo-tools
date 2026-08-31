#!/usr/bin/env bash
# Install the repo-tools worktree guard without replacing an existing hook path.
set -euo pipefail

die() {
  echo "repo-install-worktree-guard: $*" >&2
  exit 1
}

resolve_script() {
  local source_path="$1"
  local source_dir link_target

  while [ -L "$source_path" ]; do
    source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
    link_target="$(readlink "$source_path")"
    if [[ "$link_target" = /* ]]; then
      source_path="$link_target"
    else
      source_path="$source_dir/$link_target"
    fi
  done

  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  printf '%s/%s\n' "$source_dir" "$(basename "$source_path")"
}

git rev-parse --git-dir >/dev/null 2>&1 || die "run this command inside a Git repository"

installer="$(resolve_script "${BASH_SOURCE[0]}")"
bin_dir="$(dirname "$installer")"
hook_source="$bin_dir/worktree-guard-hook.sh"
guard_source="$bin_dir/require-feature-worktree.sh"

[ -x "$hook_source" ] || die "hook dispatcher is missing or not executable: $hook_source"
[ -x "$guard_source" ] || die "worktree guard is missing or not executable: $guard_source"

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
managed_hooks="$common_dir/repo-tools/hooks"
guard_command="$managed_hooks/repo-require-worktree"
configured_hooks="$(git config --local --get core.hooksPath || true)"
recorded_managed_hooks="$(git config --local --get repoTools.worktreeGuard.hooksPath || true)"
previous_hooks="$(git config --local --get repoTools.worktreeGuard.previousHooksPath || true)"

if [ "$configured_hooks" != "$managed_hooks" ]; then
  if [ -n "$configured_hooks" ]; then
    previous_hooks="$configured_hooks"
  else
    previous_hooks="$(git rev-parse --path-format=absolute --git-path hooks)"
  fi
elif [ "$recorded_managed_hooks" != "$managed_hooks" ] || [ -z "$previous_hooks" ]; then
  die "core.hooksPath already points at $managed_hooks, but its repo-tools chain metadata is incomplete"
fi

[ "$previous_hooks" != "$managed_hooks" ] || die "refusing to create a recursive hook chain"

mkdir -p "$managed_hooks"
install -m 0755 "$guard_source" "$guard_command"
for hook_name in pre-commit pre-push; do
  install -m 0755 "$hook_source" "$managed_hooks/$hook_name"
done

git config --local repoTools.worktreeGuard.previousHooksPath "$previous_hooks"
git config --local repoTools.worktreeGuard.command "$guard_command"
git config --local repoTools.worktreeGuard.hooksPath "$managed_hooks"
git config --local core.hooksPath "$managed_hooks"

echo "Installed repo-tools worktree guards for commits and pushes."
echo "Existing hooks continue through: $previous_hooks"
