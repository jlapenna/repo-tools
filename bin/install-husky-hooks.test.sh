#!/usr/bin/env bash
set -euo pipefail
# Exercise workstation guards even when this fixture runs under GitHub Actions.
unset GITHUB_ACTIONS HUSKY
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/config"
export PATH="$fixture/bin:$PATH"
export XDG_CONFIG_HOME="$fixture/config"
export TEST_HOOK_LOG="$fixture/hook.log"
export TEST_WORKTREE_GUARD="$here/require-feature-worktree.sh"
primary="$fixture/primary with spaces"
worktree="$fixture/bare worktree"
git init -q -b main "$primary"
git -C "$primary" config user.name Test
git -C "$primary" config user.email test@example.invalid
mkdir -p "$primary/.husky"
cat > "$primary/.husky/pre-commit" <<'HOOK'
#!/bin/sh
bash "$TEST_WORKTREE_GUARD"
printf 'commit:%s\n' "$PWD" >> "$TEST_HOOK_LOG"
HOOK
cat > "$primary/.husky/pre-push" <<'HOOK'
#!/bin/sh
printf 'push:%s:%s\n' "$1" "$2" >> "$TEST_HOOK_LOG"
cat >> "$TEST_HOOK_LOG"
HOOK
printf '%s\n' '.husky/_/' > "$primary/.gitignore"
git -C "$primary" add .
git -C "$primary" commit -qm initial
cd "$primary"
node "$here/../node_modules/husky/bin.js"
bash "$here/install-husky-hooks.sh"
shared="$(git config --get core.hooksPath)"
[[ "$shared" == "$primary/.git/repo-tools-husky" ]]
# Repeat setup is safe and does not replace the primary's tracked hook policy.
bash "$here/install-husky-hooks.sh"
if git commit --allow-empty -qm 'must be refused' >"$fixture/out" 2>&1; then
  echo 'primary commit escaped its actual worktree guard' >&2; exit 1
fi
git worktree add -qb feature "$worktree"
[[ ! -e "$worktree/.husky/_" ]]
cd "$worktree"
git commit --allow-empty -qm 'bare worktree hook runs'
grep -Fx "commit:$worktree" "$TEST_HOOK_LOG"
# A feature-specific tracked hook is used, not the primary's tracked script.
# This hook body is expanded when Git executes it.
# shellcheck disable=SC2016
printf '\nprintf "feature-hook\\n" >> "$TEST_HOOK_LOG"\n' >> .husky/pre-commit
git add .husky/pre-commit
git commit -qm 'feature hook differs'
grep -Fx 'feature-hook' "$TEST_HOOK_LOG"
# Exercise Git's real pre-push argv and ref stdin using a local-only remote.
git init -q --bare "$fixture/remote.git"
git remote add test "$fixture/remote.git"
git push -q test feature
grep -Fx "push:test:$fixture/remote.git" "$TEST_HOOK_LOG"
grep -E '^refs/heads/feature [0-9a-f]{40} refs/heads/feature 0{40}$' "$TEST_HOOK_LOG"
# Installing again from a linked worktree restores the same absolute path,
# even though Husky's own install first sets its relative generated directory.
node "$here/../node_modules/husky/bin.js"
bash "$here/install-husky-hooks.sh"
[[ "$(git config --get core.hooksPath)" == "$shared" ]]
mv "$shared/h" "$shared/h.saved"
if git commit --allow-empty -qm 'must fail closed' >"$fixture/out" 2>&1; then
  echo 'missing shared bootstrap silently disabled the hook' >&2; exit 1
fi
grep -F 'shared Husky bootstrap missing' "$fixture/out"
mv "$shared/h.saved" "$shared/h"
git config core.hooksPath custom-hooks
if bash "$here/install-husky-hooks.sh" >"$fixture/out" 2>&1; then
  echo 'installer overwrote unrelated hooks' >&2; exit 1
fi
grep -F 'refusing to replace a non-Husky' "$fixture/out"
echo 'shared Husky hook behavior passed'
