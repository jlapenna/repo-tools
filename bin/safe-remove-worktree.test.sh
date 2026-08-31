#!/usr/bin/env bash
# Protected contract: repo-safe-remove-worktree refuses removal only for
# processes that belong to some OTHER session; the caller's own session (its
# launcher shell, agent binary, MCP servers, tool shell — all of which inherit
# the worktree as cwd) never blocks its own teardown.
#
# Incident: agent sessions are launched with cwd inside their worktree, so the
# guard's /proc scan always found the caller itself and refused every
# documented teardown (480 refusals across 54 sessions; 50 merged worktrees
# left on disk). Consumer: `pnpm test` in ci.yml.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/safe-remove-worktree.sh"
tmp="$(mktemp -d)"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

# The test itself must not sit inside the target, or it would count as "own".
cd "$tmp"
git init -q primary
git -C primary -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
wt="$tmp/wt"
git -C primary worktree add -q "$wt" -b feat/test 2>/dev/null

park_foreign() {
  # cwd inside the worktree, but not a descendant of any ancestor of the guard
  # that also sits inside the worktree — i.e. another session's process.
  ( cd "$wt" && exec sleep 300 ) &
  pids+=("$!")
  sleep 0.2
}
unpark_foreign() {
  kill "${pids[-1]}" 2>/dev/null || true
  unset 'pids[-1]'
  sleep 0.2
}

# Run the guard the way an agent session does: from a shell whose cwd is the
# worktree, with a child (stands in for an MCP server) parked there too.
run_as_own_session() {
  bash -c '
    cd "$1"
    sleep 300 & child=$!
    bash "$2" "$1" "${@:3}"; rc=$?
    kill "$child" 2>/dev/null
    exit "$rc"
  ' _ "$wt" "$guard" "$@"
}

# 1. A foreign occupant refuses removal.
park_foreign
if "$guard" "$wt" --dry-run > "$tmp/out1" 2>&1; then
  echo "expected a foreign live process to refuse removal" >&2; cat "$tmp/out1" >&2; exit 1
fi
grep -Fq 'REFUSING: 1 foreign live process(es)' "$tmp/out1"
[ -d "$wt" ]
unpark_foreign

# 2. A foreign occupant still refuses when the caller's own session is also there.
park_foreign
if run_as_own_session --dry-run > "$tmp/out2" 2>&1; then
  echo "expected a foreign process to refuse even alongside the own session" >&2; cat "$tmp/out2" >&2; exit 1
fi
grep -Fq 'REFUSING: 1 foreign live process(es)' "$tmp/out2"
[ -d "$wt" ]
unpark_foreign

# 3. Only the caller's own session lives there: removal completes and the
#    caller is told its cwd is gone.
run_as_own_session > "$tmp/out3" 2>&1 || { echo "expected own-session removal to succeed" >&2; cat "$tmp/out3" >&2; exit 1; }
[ ! -d "$wt" ] || { echo "worktree directory still exists after removal" >&2; exit 1; }
if git -C primary worktree list --porcelain | grep -Fqx "worktree $wt"; then
  echo "worktree still registered" >&2; exit 1
fi
grep -Fq "cd $tmp/primary" "$tmp/out3"

# 4. Plain Git refuses an otherwise-clean worktree with an initialized
#    submodule. The guard's normal, safety-gated force handles that condition.
submodule_origin="$tmp/submodule-origin"
git init -q "$submodule_origin"
printf 'submodule fixture\n' > "$submodule_origin/fixture.txt"
git -C "$submodule_origin" add fixture.txt
git -C "$submodule_origin" -c user.name=t -c user.email=t@t commit -q -m fixture
git -C primary -c protocol.file.allow=always submodule add -q "$submodule_origin" modules/example
git -C primary commit -q -am 'add submodule'

submodule_wt="$tmp/wt-submodule"
git -C primary worktree add -q "$submodule_wt" -b feat/submodule 2>/dev/null
git -C "$submodule_wt" -c protocol.file.allow=always submodule update -q --init --recursive
common_dir=$(git -C primary rev-parse --path-format=absolute --git-common-dir)
if git --git-dir="$common_dir" worktree remove "$submodule_wt" > "$tmp/raw-submodule" 2>&1; then
  echo "expected plain Git to reject an initialized submodule" >&2; exit 1
fi
grep -Fq 'working trees containing submodules cannot be moved or removed' "$tmp/raw-submodule"
"$guard" "$submodule_wt" > "$tmp/out4" 2>&1 || {
  echo "expected guarded initialized-submodule removal to succeed" >&2; cat "$tmp/out4" >&2; exit 1;
}
[ ! -d "$submodule_wt" ] || { echo "submodule worktree directory still exists after removal" >&2; exit 1; }

# 5. The guard's single force must not bypass an intentional worktree lock.
#    Once explicitly unlocked, the same clean submodule worktree removes.
locked_wt="$tmp/wt-locked-submodule"
git -C primary worktree add -q "$locked_wt" -b feat/locked-submodule 2>/dev/null
git -C "$locked_wt" -c protocol.file.allow=always submodule update -q --init --recursive
git -C primary worktree lock --reason 'test lock' "$locked_wt"
if "$guard" "$locked_wt" > "$tmp/out5-locked" 2>&1; then
  echo "expected an initialized-submodule worktree lock to refuse removal" >&2; exit 1
fi
[ -d "$locked_wt" ] || { echo "locked submodule worktree was removed" >&2; exit 1; }
grep -Fq 'cannot remove a locked working tree' "$tmp/out5-locked"
git -C primary worktree unlock "$locked_wt"
"$guard" "$locked_wt" > "$tmp/out5-unlocked" 2>&1 || {
  echo "expected unlocked initialized-submodule removal to succeed" >&2; cat "$tmp/out5-unlocked" >&2; exit 1;
}
[ ! -d "$locked_wt" ] || { echo "unlocked submodule worktree directory still exists" >&2; exit 1; }

echo "repo-safe-remove-worktree: ok"
