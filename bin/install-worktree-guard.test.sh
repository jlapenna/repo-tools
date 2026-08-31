#!/usr/bin/env bash
# Protected contract: the install command enforces worktrees on commit and
# content push, preserves deletion-only pushes, and composes with an existing
# hook path without consuming its pre-push input. Consumer: `pnpm test` in
# ci.yml.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="$here/install-worktree-guard.sh"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

remote="$tmp/remote.git"
primary="$tmp/primary"
worktree="$tmp/worktree"
installer_link="$tmp/repo-install-worktree-guard"
ln -s "$installer" "$installer_link"
git init -q --bare "$remote"
git init -q -b main "$primary"
git -C "$primary" config user.name test
git -C "$primary" config user.email test@example.com
git -C "$primary" remote add origin "$remote"

mkdir -p "$primary/.husky/_"
cat >"$primary/.husky/_/pre-commit" <<'EOF'
#!/usr/bin/env bash
echo pre-commit >>"$HOOK_LOG"
EOF
cat >"$primary/.husky/_/pre-push" <<'EOF'
#!/usr/bin/env bash
echo "pre-push:$1:$2" >>"$HOOK_LOG"
cat >>"$HOOK_STDIN"
EOF
chmod +x "$primary/.husky/_/pre-commit" "$primary/.husky/_/pre-push"
git -C "$primary" add .husky
git -C "$primary" commit -q -m initial
git -C "$primary" push -q -u origin main
git -C "$primary" config core.hooksPath .husky/_

(cd "$primary" && "$installer_link") >/dev/null
managed_hooks="$(git -C "$primary" config --get core.hooksPath)"
[ "$managed_hooks" = "$primary/.git/repo-tools/hooks" ]
[ "$(git -C "$primary" config --get repoTools.worktreeGuard.previousHooksPath)" = .husky/_ ]
[ -x "$managed_hooks/pre-commit" ]
[ -x "$managed_hooks/pre-push" ]
[ -x "$managed_hooks/repo-require-worktree" ]
[ "$(git -C "$primary" config --get repoTools.worktreeGuard.command)" = "$managed_hooks/repo-require-worktree" ]

first_config="$(git -C "$primary" config --local --list | sort)"
(cd "$primary" && "$installer_link") >/dev/null
second_config="$(git -C "$primary" config --local --list | sort)"
[ "$first_config" = "$second_config" ]

export HOOK_LOG="$tmp/hook.log"
export HOOK_STDIN="$tmp/hook.stdin"
if git -C "$primary" commit -q --allow-empty -m rejected >"$tmp/commit.out" 2>&1; then
  echo "expected a commit from the primary checkout to be rejected" >&2
  exit 1
fi
grep -Fq 'must come from a feature worktree' "$tmp/commit.out"
[ ! -e "$HOOK_LOG" ]

git -C "$primary" worktree add -q -b feat/test "$worktree" main
git -C "$worktree" commit -q --allow-empty -m allowed
grep -Fxq pre-commit "$HOOK_LOG"

: >"$HOOK_STDIN"
git -C "$worktree" push -q -u origin feat/test
grep -Fq 'pre-push:origin:' "$HOOK_LOG"
grep -Eq '^refs/heads/feat/test [0-9a-f]+ refs/heads/feat/test 0+$' "$HOOK_STDIN"

if git -C "$primary" push origin main:refs/heads/from-primary >"$tmp/push.out" 2>&1; then
  echo "expected a content push from the primary checkout to be rejected" >&2
  exit 1
fi
grep -Fq 'must come from a feature worktree' "$tmp/push.out"

: >"$HOOK_STDIN"
git -C "$primary" push -q origin --delete feat/test 2>"$tmp/delete.err"
grep -Fq 'deletion-only push (no content)' "$tmp/delete.err"
grep -Eq '^\(delete\) 0+ refs/heads/feat/test [0-9a-f]+$' "$HOOK_STDIN"

git -C "$primary" switch -q --detach
git -C "$worktree" switch -q main
if git -C "$worktree" commit -q --allow-empty -m rejected-main >"$tmp/main.out" 2>&1; then
  echo "expected a commit to main from a linked worktree to be rejected" >&2
  exit 1
fi
grep -Fq 'Direct commits and pushes to main are forbidden' "$tmp/main.out"

echo "repo-install-worktree-guard: ok"
