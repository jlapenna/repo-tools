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
