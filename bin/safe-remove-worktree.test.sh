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

echo "repo-safe-remove-worktree: ok"
