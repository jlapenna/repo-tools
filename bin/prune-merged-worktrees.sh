#!/usr/bin/env bash
# Audit merged linked worktrees, or remove them with --delete.
# Uses the same merge, ownership, cleanliness, and process checks as the sweep.
# --session-only restricts scope to .claude/worktrees and .codex/worktrees.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: repo-prune-merged-worktrees [--repo <checkout>] [--base <ref>]
       [--fetch] [--delete] [--session-only] [--remove-hook <executable>]
       [<worktree-path>]
       [--park-unmerged|--park-inactive] [--idle-hours N]
       [--retire-created-hours N]

Default: report only, using current local refs. --fetch refreshes origin first.
--delete removes only clean, idle, unlocked worktrees with verified landed work.
A named target must be a registered linked worktree. With --delete, exit 1
means that target was kept; invalid targets/options return 2. Sweep skips are
normal. A failed removal returns 1 in either mode.
--session-only restricts candidates to the primary checkout's
.claude/worktrees and .codex/worktrees directories.

--park-unmerged also permits clean, idle, unlocked unmerged worktrees without
open PR ownership. With --delete, retain their branches, protect detached HEADs
with a Git ref, and save a private verified archive before removing the checkout.
Only ignored dependency/cache directories are omitted. Restore using the
reported repo-restore-worktree command. Missing PR data still keeps work.
--idle-hours N additionally requires no file/directory modifications or Git
checkout/ref activity within N hours, checked again before removal.

--park-inactive is explicit cold-checkout retirement, requiring a positive
--idle-hours window. It archives even an open-PR or already-merged checkout,
always keeps branches/history, and performs no GitHub reads or writes.
Local writes, live processes, dirty/locked/nested checkouts and resource
adapter refusals still keep it.

--retire-created-hours N is explicitly authorized checkout retirement measured
from the Git link file's reliable creation time. Recent edits do not renew age.
It preserves dirty files, staging state, exact history and private local inputs
in a verified recovery snapshot before removal, without GitHub access. Live,
locked, nested, split/sparse-index and in-progress-operation checkouts stay.
Use the owner's positive creation-age window; unknown creation age stays.

An optional remove hook receives <worktree-path> <safe-remover-executable> after
merge/ownership verification. It may hold consumer resource locks, invoke the
provided remover, then clean up consumer-owned resources. A refusal must leave
the worktree in place; exit 75 reports a normal resource-related KEEP, while
other failures report FAILED. No hook runs in report-only mode.

USAGE
}

repo=$PWD
base=""
target=""
delete=false
fetch=false
session_only=false
hook=""
park_unmerged=false
park_inactive=false
idle_hours=0
created_hours=0
while (($#)); do
  case "$1" in
    --repo|--base|--remove-hook)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --repo) repo=$2 ;;
        --base) base=$2 ;;
        --remove-hook) hook=$2 ;;
      esac
      shift ;;
    --fetch) fetch=true ;;
    --delete) delete=true ;;
    --park-unmerged) park_unmerged=true ;;
    --park-inactive) park_inactive=true ;;
    --idle-hours) [[ $# -ge 2 && $2 =~ ^[0-9]+$ ]] || { usage >&2; exit 2; }; idle_hours=$2; shift ;;
    --retire-created-hours) [[ $# -ge 2 && $2 =~ ^[1-9][0-9]*$ ]] || { usage >&2; exit 2; }; created_hours=$2; shift ;;
    --session-only) session_only=true ;;
    -h|--help) usage; exit 0 ;;
    --) shift; (($# == 1)) || { usage >&2; exit 2; }; target=$1; break ;;
    -*) usage >&2; exit 2 ;;
    *) [[ -z $target ]] || { usage >&2; exit 2; }; target=$1 ;;
  esac
  shift
done
[[ $park_inactive == false || ( $idle_hours -gt 0 ) ]] || {
  echo '--park-inactive requires a positive --idle-hours window' >&2; exit 2;
}
[[ $created_hours == 0 || ( $park_inactive == false && $park_unmerged == false && $idle_hours == 0 ) ]] || {
  echo '--retire-created-hours cannot be combined with inactivity parking' >&2; exit 2;
}

# Canonicalize relative arguments before using the primary checkout.
repo=$(realpath -e -- "$repo") || exit 2
[[ -z $target ]] || target=$(realpath -m -- "$target")
[[ -z $hook ]] || hook=$(realpath -e -- "$hook") || exit 2
[[ -z $hook || -x $hook ]] || { echo "remove hook is not executable: $hook" >&2; exit 2; }
common=$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir) || exit 2
records=$(git --git-dir="$common" worktree list --porcelain)
primary=$(sed -n 's/^worktree //p' <<<"$records" | head -n 1)
roots=("$primary/.claude/worktrees" "$primary/.codex/worktrees")

if [[ -n $target ]]; then
  registered=""
  while IFS= read -r path; do
    [[ $(realpath -m -- "$path") != "$target" ]] || { registered=$path; break; }
  done < <(sed -n 's/^worktree //p' <<<"$records")
  [[ -n $registered ]] || { echo "not a registered worktree: $target" >&2; exit 2; }
  [[ $registered != "$primary" ]] || { echo "refusing to remove the primary checkout: $target" >&2; exit 2; }
  [[ $session_only == false || $registered == "${roots[0]}"/* || $registered == "${roots[1]}"/* ]] || {
    echo "outside session worktree directories: $target" >&2; exit 2;
  }
  target=$registered
fi

if [[ $fetch == true ]]; then
  git -C "$primary" fetch origin --prune --quiet
fi
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
args=(--repo "$primary")
[[ $session_only != true ]] || args+=(--under "${roots[0]}" --under "${roots[1]}")
[[ -z $base ]] || args+=(--base "$base")
[[ -z $target ]] || args+=(--path "$target")
[[ -z $hook ]] || args+=(--remove-hook "$hook")
[[ $park_unmerged != true ]] || args+=(--park-unmerged)
[[ $park_inactive != true ]] || args+=(--park-inactive)
args+=(--idle-hours "$idle_hours")
[[ $created_hours == 0 ]] || args+=(--retire-created-hours "$created_hours")
[[ $delete != true ]] || args+=(--delete)
sweep_status=0
report=$("$here/sweep-worktrees.sh" "${args[@]}") || sweep_status=$?
[[ -z $report ]] || printf '%s\n' "$report"
((sweep_status == 0)) || exit "$sweep_status"
[[ $delete == true ]] || exit 0
if awk -F '\t' '$1 == "FAILED" { found=1 } END { exit !found }' <<<"$report"; then
  exit 1
fi
if [[ -n $target ]] && ! awk -F '\t' -v target="$target" '
  ($1 == "REMOVED" || $1 == "PARKED") && $2 == target { found=1 } END { exit !found }
' <<<"$report"; then
  exit 1
fi
