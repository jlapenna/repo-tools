#!/usr/bin/env bash
# Shared, fail-closed cleanup evidence. Source from branch and worktree commands.
# PR data is a snapshot, not permission: callers recheck before applying a plan.
cleanup_load_prs() {
  local repo=$1 open merged
  CLEANUP_PRS=''
  open=$(cd "$repo" && gh api --paginate --slurp 'repos/{owner}/{repo}/pulls?state=open&per_page=100') || return 1
  open=$(jq -ce 'if type == "array" and all(.[]; type == "array") then
    [.[][] | if (.head.ref | type) == "string" then
      {headRefName: .head.ref, state: "OPEN"} else error("invalid open PR head") end]
    else error("invalid open PR pages") end' <<<"$open") || return 1
  # Missing older merged records is conservative: unproven squash heads stay.
  merged=$(cd "$repo" && gh pr list --state merged --limit 1000 --json headRefName,headRefOid,mergeCommit) || return 1
  # Histories of 1000 PRs exceed Linux's per-argument limit. Keep bulk data
  # on stdin; --argjson would fail before jq could validate it.
  CLEANUP_PRS=$(printf '%s\n%s\n' "$open" "$merged" | jq -ces '
    if (.[1] | type) == "array" then .[0] + (.[1] | map(. + {state:"MERGED"}))
    else error("invalid merged PR data") end') || return 1
}

cleanup_evidence() {
  local repo=$1 base=$2 branch=$3 tip=$4 merge
  if [[ -z ${CLEANUP_PRS:-} ]]; then echo 'unverified:pr-data-unavailable'; return 1; fi
  if jq -e --arg branch "$branch" 'any(.[]; .headRefName == $branch and .state == "OPEN")' <<<"$CLEANUP_PRS" >/dev/null; then
    echo 'open-pr'; return 1
  fi
  if git -C "$repo" merge-base --is-ancestor "$tip" "$base" 2>/dev/null; then
    echo 'landed:ancestor'; return 0
  fi
  while IFS= read -r merge; do
    if git -C "$repo" merge-base --is-ancestor "$merge" "$base" 2>/dev/null; then
      echo 'landed:merged-pr-head'; return 0
    fi
  done < <(jq -r --arg branch "$branch" --arg tip "$tip" '.[] |
    select(.state == "MERGED" and .headRefName == $branch and .headRefOid == $tip) |
    .mergeCommit.oid // empty' <<<"$CLEANUP_PRS")
  echo 'unverified:unmerged'; return 1
}

# An unmerged branch is abandoned when no PR in any state was ever opened from
# it (or from its upstream branch) and its tip is older than the window. A
# failed PR lookup is not absence: the branch stays.
cleanup_no_pr_abandoned() {
  local repo=$1 kind=$2 branch=$3 tip=$4 days=$5 committed name upstream count
  ((days > 0)) || return 1
  committed=$(git -C "$repo" log -1 --format=%ct "$tip") || return 1
  # A ref recently created or reset onto an old commit is recent activity:
  # its reflog, when present, outranks the commit date.
  local ref=refs/heads/$branch moved
  [[ $kind == local ]] || ref=refs/remotes/origin/$branch
  moved=$(git -C "$repo" reflog show --date=unix --format=%gd -1 "$ref" -- 2>/dev/null | sed -n 's/.*@{\([0-9]*\)}$/\1/p')
  ((${moved:-0} <= committed)) || committed=$moved
  (( $(date +%s) - committed > days * 86400 )) || return 1
  # Work published under another name may have a PR there: check the upstream
  # and every remote-tracking branch that already contains this tip.
  local names=("$branch")
  if [[ $kind == local ]] && upstream=$(git -C "$repo" config "branch.$branch.merge" 2>/dev/null); then
    names+=("${upstream#refs/heads/}")
  fi
  while IFS= read -r name; do
    [[ -z $name || $name == HEAD ]] || names+=("$name")
  done < <(git -C "$repo" for-each-ref --contains "$tip" --format='%(refname:lstrip=3)' refs/remotes/origin/) || return 1
  for name in "${names[@]}"; do
    count=$(cd "$repo" && gh pr list --head "$name" --state all --limit 1 --json number --jq length) || return 1
    [[ $count == 0 ]] || return 1
  done
  echo "abandoned:no-pr-${days}d"
}

# Opt-in: closed PRs (merged ones included) whose head may still be a branch.
# GitHub keeps every PR's last head and offers "Restore branch" on a closed
# PR, so a branch whose tip is exactly that head loses nothing when deleted.
cleanup_load_closed_prs() {
  local repo=$1 closed
  CLEANUP_CLOSED_PRS=''
  closed=$(cd "$repo" && gh pr list --state closed --limit 1000 --json number,headRefName,headRefOid) || return 1
  CLEANUP_CLOSED_PRS=$(jq -ce 'if type == "array" then . else error("invalid closed PR data") end' <<<"$closed") || return 1
}

# A tip that moved after its PR closed carries commits GitHub never kept:
# only the exact head is recoverable. Missing data is not recoverability.
cleanup_closed_pr_head() {
  local branch=$1 tip=$2 number
  [[ -n ${CLEANUP_CLOSED_PRS:-} ]] || return 1
  number=$(jq -r --arg branch "$branch" --arg tip "$tip" 'first(.[] |
    select(.headRefName == $branch and .headRefOid == $tip) | .number) // empty' <<<"$CLEANUP_CLOSED_PRS")
  [[ -n $number ]] || return 1
  echo "recoverable:closed-pr-$number"
}

cleanup_branch_occupied() {
  git -C "$1" worktree list --porcelain | sed -n 's#^branch refs/heads/##p' | grep -Fxq -- "$2"
}

cleanup_delete_branch() {
  local repo=$1 branch=$2 tip=$3 remote=$4
  cleanup_branch_occupied "$repo" "$branch" && { echo 'occupied' >&2; return 1; }
  if [[ $remote == true ]]; then
    git -C "$repo" push --force-with-lease="refs/heads/$branch:$tip" origin ":refs/heads/$branch"
  else
    # Compare-and-delete: never discard a newer tip. Do not use branch -D,
    # which cannot bind deletion to the reviewed SHA.
    git -C "$repo" update-ref -d "refs/heads/$branch" "$tip"
  fi
}
