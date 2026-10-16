#!/usr/bin/env bash
# Sweep the linked worktrees of a repository: remove the ones whose work has
# landed and that nothing is using; report everything else.
#
# Usage: repo-sweep-worktrees [--repo <checkout>] [--base <ref>] [--path <worktree>] [--under <directory>] [--remove-hook <executable>] [--delete]
#
# A worktree is SAFE to remove only when all of these hold:
#   - its tree is clean (no uncommitted or untracked-but-tracked-path changes);
#   - no process has its cwd inside it (run this from the primary checkout);
#   - its branch has no OPEN pull request; and
#   - its work is in the base: the tip is an ancestor of --base, or the
#     exact branch head was merged by a PR whose merge commit is on the base.
# Missing PR ownership data is unverified, never permission to delete.
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
ONLY_PATH=""
REMOVE_HOOK=""
PARK_UNMERGED=false
PARK_INACTIVE=false
IDLE_HOURS=0
CREATED_HOURS=0
UNDER=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || { echo "--repo requires a path" >&2; exit 64; }; REPO="$2"; shift ;;
    --base) [ "$#" -ge 2 ] || { echo "--base requires a ref" >&2; exit 64; }; BASE="$2"; shift ;;
    --path) [ "$#" -ge 2 ] || exit 64; ONLY_PATH=$(realpath -e -- "$2"); shift ;;
    --under) [ "$#" -ge 2 ] || exit 64; UNDER+=("$(realpath -m -- "$2")"); shift ;;
    --remove-hook) [ "$#" -ge 2 ] || exit 64; REMOVE_HOOK=$(realpath -e -- "$2"); shift ;;
    --delete) DELETE=true ;;
    --park-unmerged) PARK_UNMERGED=true ;;
    --park-inactive) PARK_INACTIVE=true ;;
    --idle-hours) [[ $# -ge 2 && $2 =~ ^[0-9]+$ ]] || exit 64; IDLE_HOURS=$2; shift ;;
    --retire-created-hours) [[ $# -ge 2 && $2 =~ ^[1-9][0-9]*$ ]] || exit 64; CREATED_HOURS=$2; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done
[[ $PARK_INACTIVE == false || ( $IDLE_HOURS -gt 0 ) ]] || {
  echo '--park-inactive requires a positive --idle-hours window' >&2; exit 64;
}
[[ $CREATED_HOURS == 0 || ( $PARK_INACTIVE == false && $PARK_UNMERGED == false && $IDLE_HOURS == 0 ) ]] || {
  echo '--retire-created-hours cannot be combined with inactivity parking' >&2; exit 64;
}
export GIT_OPTIONAL_LOCKS=0

here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=bin/cleanup-evidence.sh
source "$here/cleanup-evidence.sh"
source "$here/worktree-idle.sh"
REMOVER="$here/safe-remove-worktree.sh"
SCANNER="$here/scan-live-processes.sh"
[ -x "$REMOVER" ] && [ -x "$SCANNER" ] || { echo "missing sibling scripts next to $0" >&2; exit 70; }
[[ -z $REMOVE_HOOK || -x $REMOVE_HOOK ]] || { echo "remove hook is not executable: $REMOVE_HOOK" >&2; exit 64; }

[ -n "$REPO" ] || REPO=$PWD
COMMON=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
  { echo "not a git repository: $REPO" >&2; exit 1; }
RECORDS=$(git --git-dir="$COMMON" worktree list --porcelain)
PRIMARY=$(printf '%s\n' "$RECORDS" | sed -n 's/^worktree //p' | head -n 1)
if [ -z "$BASE" ]; then
  if [[ $PARK_INACTIVE == true || $CREATED_HOURS != 0 ]]; then BASE=HEAD
  elif git -C "$PRIMARY" rev-parse -q --verify origin/main >/dev/null 2>&1; then BASE=origin/main
  else BASE=main; fi
fi
git -C "$PRIMARY" rev-parse -q --verify "$BASE^{commit}" >/dev/null || { echo "unknown base ref: $BASE" >&2; exit 1; }

BASE=$(git -C "$PRIMARY" rev-parse "$BASE^{commit}")
if [[ $PARK_INACTIVE != true && $CREATED_HOURS == 0 ]]; then
  cleanup_load_prs "$PRIMARY" || echo '# PR data unavailable; keeping unverified worktrees' >&2
fi

worktree_evidence() {
  local reason
  if [[ $CREATED_HOURS != 0 ]]; then
    python3 "$here/created-worktree.py" eligible "$3" "$CREATED_HOURS" 2>&1
    return $?
  fi
  # Explicit cold-checkout retirement does not discard Git history or claim a
  # merge. Local inactivity/occupancy and preservation are its authority; PRs
  # and branches remain available. No GitHub lookup or write is needed.
  if [[ $PARK_INACTIVE == true ]]; then echo parkable:inactive; return 0; fi
  if reason=$(cleanup_evidence "$PRIMARY" "$BASE" "$1" "$2"); then
    echo "$reason"; return 0
  fi
  if [[ $PARK_UNMERGED == true && $reason == unverified:unmerged ]]; then
    # Published work may use a different local name. Keep an upstream alias
    # or a commit included in an open PR, even though parking preserves it.
    local upstream known_tips known_json
    upstream=$(git -C "$PRIMARY" config "branch.$1.merge" 2>/dev/null || true)
    upstream=${upstream#refs/heads/}
    if [[ -n $upstream ]] && jq -e --arg branch "$upstream" \
      'any(.[]; .state=="OPEN" and .headRefName==$branch and
        .headRepository!=null and .headRepository==.baseRepository)' <<<"$CLEANUP_PRS" >/dev/null; then
      echo open-pr; return 1
    fi
    # Query known refs once instead of spawning Git for every open PR.
    # Large upstreams can have thousands of unrelated/unknown fork heads.
    known_tips=$(git -C "$PRIMARY" for-each-ref --contains "$2" \
      --format='%(objectname)' refs/heads/ refs/remotes/) || {
      echo unverified:ref-ownership-check-failed; return 1;
    }
    known_json=$(printf '%s\n' "$known_tips" | jq -Rsc 'split("\n")|map(select(.!=""))')
    if printf '%s\n%s\n' "$CLEANUP_PRS" "$known_json" | jq -es \
      '.[0] as $prs | (.[1]|map({key:.,value:true})|from_entries) as $known |
       any($prs[]; .state=="OPEN" and $known[.headRefOid // ""]==true)' >/dev/null; then
      echo open-pr; return 1
    fi
    echo parkable:unmerged; return 0
  fi
  echo "$reason"; return 1
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

in_scope() {
  local candidate=$1 root
  [[ -z $ONLY_PATH || $candidate == "$ONLY_PATH" ]] || return 1
  ((${#UNDER[@]} > 0)) || return 0
  for root in "${UNDER[@]}"; do
    [[ $candidate == "$root"/* ]] && return 0
  done
  return 1
}

safe_paths=()
safe_branches=()
safe_heads=()
path=""; head=""; branch=""; locked=false
while IFS= read -r line; do
  case "$line" in
    "worktree "*) path=${line#worktree }; head=""; branch=""; locked=false ;;
    "HEAD "*) head=${line#HEAD } ;;
    "branch "*) branch=${line#branch refs/heads/} ;;
    locked*) locked=true ;;
    "")
      [ -n "$path" ] || continue
      if [ "$path" != "$PRIMARY" ] && in_scope "$path"; then
        if [ ! -d "$path" ]; then
          emit KEEP "$path" "$branch" "directory missing (git worktree prune)"
        elif [ "$locked" = true ]; then
          emit KEEP "$path" "$branch" "locked"
        elif [[ $CREATED_HOURS == 0 ]] && dirty=$(dirty_count "$path") && [ "$dirty" -gt 0 ]; then
          emit KEEP "$path" "$branch" "dirty: $dirty uncommitted change(s)"
        elif live=$(live_count "$path") && [ "$live" -gt 0 ]; then
          emit KEEP "$path" "$branch" "live: $live process(es) with cwd inside"
        elif [[ $CREATED_HOURS == 0 ]] && ! idle_reason=$(cleanup_worktree_idle "$path" "$branch" "$IDLE_HOURS"); then
          emit KEEP "$path" "$branch" "$idle_reason"
        else
          if reason=$(worktree_evidence "$branch" "$head" "$path"); then
            emit SAFE "$path" "$branch" "$reason"
            safe_paths+=("$path"); safe_branches+=("$branch"); safe_heads+=("$head")
          else
            emit KEEP "$path" "$branch" "$reason"
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
  h=${safe_heads[$i]}
  if { [[ $PARK_INACTIVE != true && $CREATED_HOURS == 0 ]] && ! cleanup_load_prs "$PRIMARY"; } ||
    ! current_reason=$(worktree_evidence "$b" "$h" "$p") ||
    [[ $(git -C "$p" rev-parse HEAD) != "$h" ]] ||
    { [[ $CREATED_HOURS == 0 ]] && ! cleanup_worktree_idle "$p" "$b" "$IDLE_HOURS" >/dev/null; }; then
    emit KEEP "$p" "$b" 'unverified:plan-changed'; continue
  fi
  if [[ $current_reason == parkable:* ]]; then
    park_status=0
    if [[ $CREATED_HOURS != 0 ]]; then
      out=$(python3 "$here/created-worktree.py" retire "$p" "$h" "$REMOVE_HOOK" "$CREATED_HOURS" 2>&1) || park_status=$?
    else
      out=$("$here/park-worktree.sh" "$p" "$h" "$REMOVE_HOOK" "$IDLE_HOURS" 2>&1) || park_status=$?
    fi
    if [[ $park_status == 75 && -e $p ]]; then
      if [[ $CREATED_HOURS != 0 && -n $out ]]; then printf '%s\n' "$out" >&2; fi
      emit KEEP "$p" "$b" 'parking-refused:snapshot-or-resources-changed'
    elif [[ $park_status != 0 ]]; then
      printf '%s\n' "$out" >&2
      emit FAILED "$p" "$b" 'parking failed; inspect retained archive and worktree'
    else
      archive=$(tail -n 1 <<<"$out")
      emit PARKED "$p" "$b" "branch retained; restore with repo-restore-worktree $archive"
    fi
    continue
  fi
  # The remover re-checks live processes and cleanliness right before acting.
  hook_status=0
  if [[ -n $REMOVE_HOOK ]]; then
    out=$("$REMOVE_HOOK" "$p" "$REMOVER" 2>&1) || hook_status=$?
  else
    out=$("$REMOVER" "$p" 2>&1) || true
  fi
  [[ -z $out ]] || printf '%s\n' "$out" >&2
  if [[ $hook_status != 0 ]]; then
    if [[ $hook_status == 75 && -e "$p" ]]; then
      emit KEEP "$p" "$b" 'consumer-resources-in-use'; continue
    fi
    if [[ ! -e "$p" ]]; then
      emit FAILED "$p" "$b" "remove-hook exited $hook_status after removal; branch kept"
    else
      emit FAILED "$p" "$b" "remove-hook exited $hook_status; worktree and branch kept"
    fi
    continue
  fi
  if [ -e "$p" ]; then
    reason=$(grep -m1 -E 'REFUSING|ERROR' <<<"$out" || echo "safe-remove-worktree failed")
    emit FAILED "$p" "$b" "$reason"
    continue
  fi
  note="removed"
  if [ -n "$b" ]; then
    if cleanup_delete_branch "$PRIMARY" "$b" "$h" false >/dev/null 2>&1; then note="removed; branch $b deleted"; else note="removed; branch $b kept (occupied or changed)"; fi
  fi
  emit REMOVED "$p" "$b" "$note"
done
