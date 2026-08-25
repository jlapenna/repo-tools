#!/usr/bin/env bash
# Protected contract: repo-sweep-worktrees removes a linked worktree only when
# its work has landed (tip is an ancestor of the base, or its PR merged and the
# branch's content is byte-identical to the squash commit), the tree is clean,
# and no process lives inside it; everything else is reported and kept. It
# never deletes anything without --delete.
#
# Incident: 50 merged worktrees accumulated in one checkout because
# per-session teardown was never completed (see safe-remove-worktree.test.sh).
# Consumer: `pnpm test` in ci.yml.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="$here/sweep-worktrees.sh"
tmp="$(mktemp -d)"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT
cd "$tmp"

g() { git -c user.name=t -c user.email=t@t "$@"; }

# A stub gh: `gh pr list ...` prints $GH_PRS_JSON; anything else fails.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1" = pr ] && [ "$2" = list ]; then printf '%s\n' "${GH_PRS_JSON:-[]}"; exit 0; fi
echo "gh stub: unsupported: $*" >&2; exit 1
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"

primary="$tmp/primary"
g init -q -b main "$primary"
cd "$primary"
echo base > a.txt; echo base > b.txt; g add .; g commit -q -m init
wt() { # wt <dir> <branch>
  g worktree add -q "$tmp/$1" -b "$2" 2>/dev/null
}

# a. squash-merged: branch edits a.txt in two commits; main gets one squash commit with the same result.
wt wt-squash feat/squash
( cd "$tmp/wt-squash" && echo one > a.txt && g commit -qam c1 && echo two > a.txt && g commit -qam c2 )
echo two > a.txt; g commit -qam 'feat: squash (#1)'; squash=$(git rev-parse HEAD)
# b. ancestor: branch at main tip, nothing ahead.
wt wt-ancestor feat/ancestor
# c. dirty: at main tip but with an uncommitted edit.
wt wt-dirty feat/dirty; echo wip >> "$tmp/wt-dirty/b.txt"
# d. open PR, ahead.
wt wt-open feat/open; ( cd "$tmp/wt-open" && echo open > b.txt && g commit -qam open )
# e. unverified WIP: ahead, no PR record.
wt wt-wip feat/wip; ( cd "$tmp/wt-wip" && echo wip > b.txt && g commit -qam wip )
# f. live: at main tip but a process has its cwd inside.
wt wt-live feat/live; ( cd "$tmp/wt-live" && exec sleep 300 ) & pids+=("$!"); sleep 0.2
# g. nested: parent worktree with a child worktree inside it, both at main tip.
wt wt-parent feat/parent; g worktree add -q "$tmp/wt-parent/.claude/worktrees/child" -b feat/child 2>/dev/null
# h. detached HEAD at main tip.
g worktree add -q --detach "$tmp/wt-detached" 2>/dev/null

export GH_PRS_JSON="[{\"headRefName\":\"feat/squash\",\"state\":\"MERGED\",\"mergeCommit\":{\"oid\":\"$squash\"}},{\"headRefName\":\"feat/open\",\"state\":\"OPEN\",\"mergeCommit\":null}]"

all_dirs=(wt-squash wt-ancestor wt-dirty wt-open wt-wip wt-live wt-parent wt-parent/.claude/worktrees/child wt-detached)

# 1. Default run reports and removes nothing.
"$sweep" --repo "$primary" --base main > "$tmp/report" 2>&1 || { echo "report run failed" >&2; cat "$tmp/report" >&2; exit 1; }
for d in "${all_dirs[@]}"; do [ -d "$tmp/$d" ] || { echo "report-only run removed $d" >&2; exit 1; }; done
grep -Eq "^SAFE[[:space:]].*/wt-squash[[:space:]]" "$tmp/report"
grep -Eq "^SAFE[[:space:]].*/wt-ancestor[[:space:]]" "$tmp/report"
grep -Eq "^SAFE[[:space:]].*/child[[:space:]]" "$tmp/report"
grep -Eq "^SAFE[[:space:]].*/wt-detached[[:space:]]" "$tmp/report"
grep -Eq "^KEEP[[:space:]].*/wt-dirty[[:space:]].*dirty" "$tmp/report"
grep -Eq "^KEEP[[:space:]].*/wt-open[[:space:]].*open" "$tmp/report"
grep -Eq "^KEEP[[:space:]].*/wt-wip[[:space:]].*unverified" "$tmp/report"
grep -Eq "^KEEP[[:space:]].*/wt-live[[:space:]].*live" "$tmp/report"

# 2. --delete removes exactly the SAFE set (nested child before its parent) and their branches.
"$sweep" --repo "$primary" --base main --delete > "$tmp/deleted" 2>&1 || { echo "delete run failed" >&2; cat "$tmp/deleted" >&2; exit 1; }
for d in wt-squash wt-ancestor wt-parent/.claude/worktrees/child wt-parent wt-detached; do
  [ ! -e "$tmp/$d" ] || { echo "expected $d removed" >&2; cat "$tmp/deleted" >&2; exit 1; }
  grep -Eq "^REMOVED[[:space:]].*/${d##*/}[[:space:]]" "$tmp/deleted"
done
for d in wt-dirty wt-open wt-wip wt-live; do
  [ -d "$tmp/$d" ] || { echo "expected $d kept" >&2; exit 1; }
done
for b in feat/squash feat/ancestor feat/child feat/parent; do
  ! git show-ref --verify --quiet "refs/heads/$b" || { echo "expected branch $b deleted" >&2; exit 1; }
done
for b in feat/dirty feat/open feat/wip feat/live; do
  git show-ref --verify --quiet "refs/heads/$b" || { echo "branch $b must survive" >&2; exit 1; }
done
[ "$(git worktree list --porcelain | grep -c '^worktree ')" = 5 ] # primary + 4 kept

# 3. Without gh, only ancestor evidence counts: an unmerged-by-ancestry branch is unverified, not removed.
wt wt-squash2 feat/squash2; ( cd "$tmp/wt-squash2" && echo three > a.txt && g commit -qam c3 )
echo three > a.txt; g commit -qam 'feat: squash2 (#2)'
PATH="/usr/bin:/bin" GH_PRS_JSON='' "$sweep" --repo "$primary" --base main --delete > "$tmp/nogh" 2>&1 || true
[ -d "$tmp/wt-squash2" ] || { echo "removed a branch without PR evidence" >&2; cat "$tmp/nogh" >&2; exit 1; }
grep -Eq "^KEEP[[:space:]].*/wt-squash2[[:space:]].*unverified" "$tmp/nogh"

echo "repo-sweep-worktrees: ok"
