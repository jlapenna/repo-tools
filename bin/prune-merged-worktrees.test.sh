#!/usr/bin/env bash
# Contract: the pruning CLI preserves primary, dirty, locked, live, open-PR,
# and unverified work; scopes session sweeps; and exposes a safe cache adapter
# boundary without running it during audits. Consumer: pnpm test in ci.yml.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
subject="$here/prune-merged-worktrees.sh"
scratch=$(mktemp -d)
live_pid=""
trap '[[ -z $live_pid ]] || kill "$live_pid" 2>/dev/null || true; rm -rf "$scratch"' EXIT
cd "$scratch"
mkdir -p "$scratch/bin"
cat > "$scratch/bin/gh" <<'GH'
#!/usr/bin/env bash
[[ ${GH_UNAVAILABLE:-false} != true ]] || exit 1
if [[ $1 == api ]]; then
  printf '%s\n' "${OPEN_PRS:-[[]]}"
else
  printf '%s\n' "${MERGED_PRS:-[]}"
fi
GH
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"
repo="$scratch/primary with spaces"
git init -q -b main "$repo"
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.com
echo base > "$repo/file"
git -C "$repo" add file
git -C "$repo" commit -qm base
wt() { git -C "$repo" worktree add -qb "$1" "$2" main; }
claude="$repo/.claude/worktrees/landed"
codex="$repo/.codex/worktrees/landed"
manual="$scratch/manual"
dirty="$repo/.claude/worktrees/dirty"
locked="$repo/.codex/worktrees/locked"
live="$repo/.claude/worktrees/live"
open="$repo/.claude/worktrees/open"
unmerged="$repo/.codex/worktrees/unmerged"
squash="$repo/.codex/worktrees/squash"
for name in claude codex manual dirty locked live open unmerged squash; do
  wt "$name" "${!name}"
done
echo wip >> "$dirty/file"
git -C "$repo" worktree lock --reason active "$locked"
(cd "$live" && exec sleep 60) & live_pid=$!
for _ in {1..100}; do
  [[ $(readlink "/proc/$live_pid/cwd" 2>/dev/null) != "$live" ]] || break
  sleep 0.02
done
echo unmerged >> "$unmerged/file"
git -C "$unmerged" commit -qam unmerged
echo squash >> "$squash/file"
git -C "$squash" commit -qam squash
git -C "$repo" merge --squash squash >/dev/null
git -C "$repo" commit -qm squashed
export OPEN_PRS='[[{"head":{"ref":"open"}}]]'
export MERGED_PRS
MERGED_PRS=$(jq -nc --arg head "$(git -C "$squash" rev-parse HEAD)" --arg merge "$(git -C "$repo" rev-parse main)" \
  '[{headRefName:"squash", headRefOid:$head, mergeCommit:{oid:$merge}}]')

rc() {
  local expected=$1 actual=0; shift
  "$subject" --repo "$repo" --base main "$@" > "$scratch/report" 2>&1 || actual=$?
  [[ $actual == "$expected" ]] || { cat "$scratch/report" >&2; echo "expected $expected, got $actual" >&2; exit 1; }
}

# Audit is read-only, even when a hook was supplied.
cat > "$scratch/hook" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$HOOK_CALLS"
[[ ${REFUSE_HOOK:-false} != true ]] || { echo 'REFUSING: cache is in use' >&2; exit "${HOOK_REFUSAL_STATUS:-1}"; }
"$2" "$1"
exit "${HOOK_POST_REMOVE_STATUS:-0}"
HOOK
chmod +x "$scratch/hook"
export HOOK_CALLS="$scratch/calls"
rc 0 --session-only --remove-hook "$scratch/hook"
[[ ! -e $HOOK_CALLS ]]
for name in claude codex manual dirty locked live open unmerged squash; do [[ -d ${!name} ]]; done
! grep -Fq "$manual" "$scratch/report"
grep -Eq '^KEEP.*locked' "$scratch/report"

# Invalid/primary/out-of-scope named targets fail before mutation.
rc 2 "$repo"
rc 2 "$scratch/not-registered"
rc 2 --session-only "$manual"
rc 2 "$claude" "$codex"

# Named refusals carry a nonzero status; PR metadata outages retain ancestors.
rc 1 --delete "$dirty"
rc 1 --delete "$locked"
rc 1 --delete "$live"
rc 1 --delete "$open"
rc 1 --delete "$unmerged"
GH_UNAVAILABLE=true rc 1 --delete "$claude"
REFUSE_HOOK=true rc 1 --delete --remove-hook "$scratch/hook" "$claude"
[[ -d $claude ]]
REFUSE_HOOK=true HOOK_REFUSAL_STATUS=75 rc 0 --session-only --delete --remove-hook "$scratch/hook"
[[ -d $claude && -d $codex && -d $squash ]]
grep -Eq '^KEEP.*consumer-resources-in-use' "$scratch/report"

# A path relative to caller cwd retains its meaning, including spaces.
rc 0 --delete --remove-hook "$scratch/hook" 'primary with spaces/.claude/worktrees/landed/'
[[ ! -e $claude ]]
grep -Fqx "$claude" "$HOOK_CALLS"
git -C "$repo" show-ref --verify --quiet refs/heads/claude && exit 1

# Session scope reclaims both runtime directories and exact squash heads,
# leaving manually registered worktrees and every protected candidate intact.
rc 0 --delete --session-only
[[ ! -e $codex && ! -e $squash ]]
for name in manual dirty locked live open unmerged; do [[ -d ${!name} ]]; done
rc 0 --delete "$manual"
[[ ! -e $manual && -d $repo ]]

# A failing consumer hook remains a failure even after it removed the target.
# Preserve the exact branch for recovery, for both named and sweep callers.
for hook_status in 1 75; do
  post="$repo/.claude/worktrees/post-$hook_status"
  wt "post-$hook_status" "$post"
  if [[ $hook_status == 1 ]]; then
    HOOK_POST_REMOVE_STATUS=$hook_status rc 1 --delete --remove-hook "$scratch/hook" "$post"
  else
    HOOK_POST_REMOVE_STATUS=$hook_status rc 1 --session-only --delete --remove-hook "$scratch/hook"
  fi
  [[ ! -e $post ]]
  git -C "$repo" show-ref --verify --quiet "refs/heads/post-$hook_status"
  grep -Eq "^FAILED.*remove-hook exited $hook_status after removal; branch kept" "$scratch/report"
  ! grep -Eq '^REMOVED' "$scratch/report"
done
echo 'repo-prune-merged-worktrees: ok'
