#!/usr/bin/env bash
# Audit merged linked worktrees, or remove them with --delete.
# Uses the same merge, ownership, cleanliness, and process checks as the sweep.
# --session-only restricts scope to .claude/worktrees and .codex/worktrees.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: repo-prune-merged-worktrees [--repo <checkout>] [--base <ref>]
       [--fetch] [--delete] [--session-only] [--remove-hook <executable>]
       [--merged-pr <GitHub-PR-URL>] [<worktree-path>]

Default: report only, using current local refs. --fetch refreshes origin first.
--delete removes only clean, idle, unlocked worktrees with verified landed work.
A named target must be a registered linked worktree. With --delete, exit 1
means that target was kept; invalid targets/options return 2. Sweep skips are
normal. A failed removal returns 1 in either mode.
--session-only restricts candidates to the primary checkout's
.claude/worktrees and .codex/worktrees directories.

An optional remove hook receives <worktree-path> <safe-remover-executable> after
merge/ownership verification. It may hold consumer resource locks, invoke the
provided remover, then clean up consumer-owned resources. A refusal must leave
the worktree in place; exit 75 reports a normal resource-related KEEP, while
other failures report FAILED. No hook runs in report-only mode.

--merged-pr binds one named target to an exact merged PR head, regardless of
its local branch name. The URL selects the GitHub repository; its merge must
be on the selected origin base branch. Closed unmerged PRs are always kept.
USAGE
}

repo=$PWD
base=""
target=""
delete=false
fetch=false
session_only=false
hook=""
merged_pr=""
while (($#)); do
  case "$1" in
    --repo|--base|--remove-hook|--merged-pr)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --repo) repo=$2 ;;
        --base) base=$2 ;;
        --remove-hook) hook=$2 ;;
        --merged-pr) merged_pr=$2 ;;
      esac
      shift ;;
    --fetch) fetch=true ;;
    --delete) delete=true ;;
    --session-only) session_only=true ;;
    -h|--help) usage; exit 0 ;;
    --) shift; (($# == 1)) || { usage >&2; exit 2; }; target=$1; break ;;
    -*) usage >&2; exit 2 ;;
    *) [[ -z $target ]] || { usage >&2; exit 2; }; target=$1 ;;
  esac
  shift
done
[[ -z $merged_pr || ( -n $target && $merged_pr =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$ ) ]] || {
  echo '--merged-pr requires a GitHub PR URL and one named worktree' >&2; exit 2;
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
[[ -z $merged_pr ]] || args+=(--merged-pr "$merged_pr")
[[ $delete != true ]] || args+=(--delete)
report=$("$here/sweep-worktrees.sh" "${args[@]}")
printf '%s\n' "$report"
[[ $delete == true ]] || exit 0
if awk -F '\t' '$1 == "FAILED" { found=1 } END { exit !found }' <<<"$report"; then
  exit 1
fi
if [[ -n $target ]] && ! awk -F '\t' -v target="$target" '
  $1 == "REMOVED" && $2 == target { found=1 } END { exit !found }
' <<<"$report"; then
  exit 1
fi
