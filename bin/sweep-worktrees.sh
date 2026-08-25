#!/usr/bin/env bash
# Sweep the linked worktrees of a repository: remove the ones whose work has
# landed and that nothing is using; report everything else.
#
# Usage: repo-sweep-worktrees [--repo <checkout>] [--base <ref>] [--delete]
#
# A worktree is SAFE to remove only when all of these hold:
#   - its tree is clean (no uncommitted or untracked-but-tracked-path changes);
#   - no process has its cwd inside it (run this from the primary checkout);
#   - its branch has no OPEN pull request; and
#   - its work is in the base: the tip is an ancestor of --base, or the
#     branch's pull request is MERGED and the branch's content is identical to
#     that squash commit on every file the branch touched.
# Anything else is KEEP with the reason. Nothing is removed without --delete.
# Nested worktrees are removed before their parents. Removal goes through
# safe-remove-worktree, which re-checks live processes and cleanliness.
#
# Output: one tab-separated line per worktree: VERDICT  path  branch  reason,
# where VERDICT is SAFE, REMOVED, FAILED, or KEEP. Lines starting with '#' are
# commentary.
set -euo pipefail

REPO=""
BASE=""
DELETE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || { echo "--repo requires a path" >&2; exit 64; }; REPO="$2"; shift ;;
    --base) [ "$#" -ge 2 ] || { echo "--base requires a ref" >&2; exit 64; }; BASE="$2"; shift ;;
    --delete) DELETE=true ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
REMOVER="$here/safe-remove-worktree.sh"
SCANNER="$here/scan-live-processes.sh"
[ -x "$REMOVER" ] && [ -x "$SCANNER" ] || { echo "missing sibling scripts next to $0" >&2; exit 70; }

[ -n "$REPO" ] || REPO=$PWD
COMMON=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  { echo "not a git repository: $REPO" >&2; exit 1; }
RECORDS=$(git --git-dir="$COMMON" worktree list --porcelain)
PRIMARY=$(printf '%s\n' "$RECORDS" | sed -n 's/^worktree //p' | head -n 1)
if [ -z "$BASE" ]; then
  if git -C "$PRIMARY" rev-parse -q --verify origin/main >/dev/null 2>&1; then BASE=origin/main; else BASE=main; fi
fi
git -C "$PRIMARY" rev-parse -q --verify "$BASE^{commit}" >/dev/null || { echo "unknown base ref: $BASE" >&2; exit 1; }

# One PR lookup for the whole sweep. Without gh or jq, only ancestor evidence
# counts, and squash-merged branches are reported as unverified.
PRS=""
if command -v gh >/dev/null && command -v jq >/dev/null; then
  PRS=$(cd "$PRIMARY" && gh pr list --state all --limit 1000 --json headRefName,state,mergeCommit 2>/dev/null) || PRS=""
fi
[ -n "$PRS" ] || echo "# no pull-request data (gh/jq unavailable or failed): only ancestor evidence counts" >&2

pr_lookup() { # prints "STATE<TAB>mergeCommit" for a branch, preferring an OPEN PR; empty if none
  [ -n "$PRS" ] || return 0
  jq -r --arg b "$1" '
    [.[] | select(.headRefName == $b)]
    | (map(select(.state == "OPEN"))[0] // .[0])
    | if . == null then "" else "\(.state)\t\(.mergeCommit.oid // "")" end' <<<"$PRS"
}

live_count() { "$SCANNER" "$1" 2>/dev/null | grep -cE '^[0-9]+ ' || true; }

# Uncommitted changes in a worktree, not counting files that belong to a
# worktree nested inside it (a child under .claude/worktrees/ shows up as
# untracked in its parent, and is removed first anyway).
dirty_count() {
  local wt="$1" line rel abs nw skip n=0
  local -a nested=()
  while IFS= read -r nw; do [ -n "$nw" ] && nested+=("$nw"); done < <(printf '%s\n' "$RECORDS" | sed -n "s#^worktree \($wt/.*\)#\1#p")
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    rel=${line:3}; rel=${rel%\"}; rel=${rel#\"}
    abs="$wt/${rel%/}" # git lists a nested repository as "?? dir/"
    skip=false
    if [ "${line:0:2}" = "??" ]; then
      for nw in "${nested[@]}"; do
        case "$abs" in "$nw" | "$nw"/*) skip=true; break ;; esac
        case "$nw" in "$abs"/*) skip=true; break ;; esac # an ancestor dir of the nested worktree
      done
    fi
    [ "$skip" = true ] || n=$((n + 1))
  done < <(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null)
  echo "$n"
}

emit() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4"; }

safe_paths=()
safe_branches=()
path=""; head=""; branch=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path=${line#worktree }; head=""; branch="" ;;
    "HEAD "*) head=${line#HEAD } ;;
    "branch "*) branch=${line#branch refs/heads/} ;;
    "")
      [ -n "$path" ] || continue
      if [ "$path" != "$PRIMARY" ]; then
        if [ ! -d "$path" ]; then
          emit KEEP "$path" "$branch" "directory missing (git worktree prune)"
        elif dirty=$(dirty_count "$path") && [ "$dirty" -gt 0 ]; then
          emit KEEP "$path" "$branch" "dirty: $dirty uncommitted change(s)"
        elif live=$(live_count "$path") && [ "$live" -gt 0 ]; then
          emit KEEP "$path" "$branch" "live: $live process(es) with cwd inside"
        else
          pr=""; [ -n "$branch" ] && pr=$(pr_lookup "$branch")
          pr_state=${pr%%$'\t'*}; pr_merge=${pr#*$'\t'}; [ "$pr" = "$pr_state" ] && pr_merge=""
          ahead=$(git -C "$PRIMARY" rev-list --count "$BASE..$head" 2>/dev/null || echo "?")
          if [ "$pr_state" = OPEN ]; then
            emit KEEP "$path" "$branch" "open pull request"
          elif [ "$ahead" = 0 ]; then
            emit SAFE "$path" "$branch" "ancestor of $BASE"
            safe_paths+=("$path"); safe_branches+=("$branch")
          elif [ "$pr_state" = MERGED ] && [ -n "$pr_merge" ] &&
            git -C "$PRIMARY" rev-parse -q --verify "$pr_merge^{commit}" >/dev/null; then
            mb=$(git -C "$PRIMARY" merge-base "$BASE" "$head")
            files=$(git -C "$PRIMARY" diff --name-only "$mb" "$head")
            # shellcheck disable=SC2086
            if [ -z "$files" ] || git -C "$PRIMARY" diff --quiet "$head" "$pr_merge" -- $files; then
              emit SAFE "$path" "$branch" "content in merged squash ${pr_merge:0:9}"
              safe_paths+=("$path"); safe_branches+=("$branch")
            else
              emit KEEP "$path" "$branch" "unverified: differs from merge commit ${pr_merge:0:9}"
            fi
          else
            emit KEEP "$path" "$branch" "unverified: $ahead commit(s) not in $BASE, no merged pull request"
          fi
        fi
      fi
      path=""; head=""; branch=""
      ;;
  esac
done <<<"$RECORDS
"

[ "$DELETE" = true ] || { echo "# ${#safe_paths[@]} removable worktree(s); re-run with --delete to remove them" >&2; exit 0; }
[ "${#safe_paths[@]}" -gt 0 ] || exit 0

# Deepest paths first so a nested worktree goes before the parent that contains it.
order=$(for i in "${!safe_paths[@]}"; do printf '%s\t%s\n' "$(tr -cd '/' <<<"${safe_paths[$i]}" | wc -c)" "$i"; done | sort -k1,1nr | cut -f2)
for i in $order; do
  p=${safe_paths[$i]}; b=${safe_branches[$i]}
  # The remover re-checks live processes and cleanliness right before acting.
  out=$("$REMOVER" "$p" 2>&1) || true
  if [ -e "$p" ]; then
    reason=$(grep -m1 -E 'REFUSING|ERROR' <<<"$out" || echo "safe-remove-worktree failed")
    emit FAILED "$p" "$b" "$reason"
    continue
  fi
  note="removed"
  if [ -n "$b" ]; then
    if git -C "$PRIMARY" branch -D "$b" >/dev/null 2>&1; then note="removed; branch $b deleted"; else note="removed; branch $b kept (still checked out elsewhere?)"; fi
  fi
  emit REMOVED "$p" "$b" "$note"
done
