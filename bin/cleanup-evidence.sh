#!/usr/bin/env bash
# Shared, fail-closed cleanup evidence. Source from branch and worktree commands.
# PR data is a snapshot, not permission: callers recheck before applying a plan.
cleanup_load_prs() {
  local repo=$1 open err msg status=0
  CLEANUP_PRS=''
  CLEANUP_PRS_AUTH_FAILED=''
  err=$(mktemp) || return 1
  open=$(cd "$repo" && gh api --paginate --slurp 'repos/{owner}/{repo}/pulls?state=open&per_page=100' 2>"$err") || status=$?
  msg=$(<"$err"); rm -f -- "$err"
  [[ -z $msg ]] || printf '%s\n' "$msg" >&2
  if ((status != 0)); then
    # A rejected or missing credential is a host defect, not a transient
    # outage: callers must surface it instead of quietly pinning KEEP.
    if grep -qiE 'HTTP 401|bad credentials|gh auth login|not logged in' <<<"$msg"; then
      CLEANUP_PRS_AUTH_FAILED=1
    fi
    return 1
  fi
  open=$(jq -ce 'if type == "array" and all(.[]; type == "array") then
    [.[][] | if (.head.ref | type) == "string" then
      {headRefName: .head.ref, headRefOid: .head.sha,
       headRepository: .head.repo.full_name, baseRepository: .base.repo.full_name,
       state: "OPEN"} else error("invalid open PR head") end]
    else error("invalid open PR pages") end' <<<"$open") || return 1
  CLEANUP_PRS=$open
}

cleanup_evidence() {
  local repo=$1 base=$2 branch=$3 tip=$4 merge associated
  if [[ -z ${CLEANUP_PRS:-} ]]; then
    if [[ -n ${CLEANUP_PRS_AUTH_FAILED:-} ]]; then echo 'unverified:gh-auth-failed'; else echo 'unverified:pr-data-unavailable'; fi
    return 1
  fi
  if jq -e --arg branch "$branch" --arg tip "$tip" 'any(.[]; .state == "OPEN" and (.headRefName == $branch or .headRefOid == $tip))' <<<"$CLEANUP_PRS" >/dev/null; then
    echo 'open-pr'; return 1
  fi
  if git -C "$repo" merge-base --is-ancestor "$tip" "$base" 2>/dev/null; then
    echo 'landed:ancestor'; return 0
  fi
  # Only non-ancestor tips need squash/rebase evidence. Ask about that exact
  # commit, not a bounded window of unrelated repository history.
  associated=$(cd "$repo" && gh api --paginate --slurp "repos/{owner}/{repo}/commits/$tip/pulls?per_page=100" 2>/dev/null) || {
    # GitHub explicitly reports an unpublished/unknown commit with this 422.
    # It is not merge proof; ordinary cleanup retains it. Separate opt-in
    # abandonment still requires fresh branch/upstream PR-absence evidence.
    if jq -e --arg tip "$tip" 'type == "array" and length == 1 and
      .[0].status == "422" and
      .[0].message == ("No commit found for SHA: " + $tip)' <<<"$associated" >/dev/null 2>&1; then
      echo 'unverified:unmerged'; return 1
    fi
    echo 'unverified:pr-data-unavailable'; return 1;
  }
  associated=$(jq -ce 'if type == "array" and all(.[]; type == "array") then
    [.[][] | if (.head.sha | type) == "string" and
      (.state == "open" or .state == "closed") and
      (.merged_at == null or (.merged_at | type) == "string") and
      (.merged_at == null or (.merge_commit_sha | type) == "string")
      then . else error("invalid associated PR") end]
    else error("invalid associated PR pages") end' <<<"$associated") || {
    echo 'unverified:pr-data-unavailable'; return 1;
  }
  if jq -e 'any(.[]; .state == "open")' <<<"$associated" >/dev/null; then
    echo 'open-pr'; return 1
  fi
  while IFS= read -r merge; do
    if git -C "$repo" merge-base --is-ancestor "$merge" "$base" 2>/dev/null; then
      echo 'landed:merged-pr-head'; return 0
    fi
  # A renamed branch or detached review checkout still has the exact reviewed
  # commit. The merge on the selected base proves landing; the local name does
  # not add provenance. Never accept a merely equivalent tree or newer tip.
  done < <(jq -r --arg tip "$tip" '.[] |
    select(.state == "closed" and .merged_at != null and .head.sha == $tip) |
    .merge_commit_sha' <<<"$associated")
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
# Only same-repository PRs count: a fork's PR can reuse a branch name and
# point at a commit it copied, and it restores into the fork, not here.
cleanup_load_closed_prs() {
  local repo=$1 branch=$2 closed encoded
  CLEANUP_CLOSED_PRS=''
  encoded=$(jq -rn --arg branch "$branch" '$branch | @uri') || return 1
  closed=$(cd "$repo" && gh api --paginate --slurp "repos/{owner}/{repo}/pulls?state=closed&head={owner}:$encoded&per_page=100") || return 1
  CLEANUP_CLOSED_PRS=$(jq -ce 'if type == "array" and all(.[]; type == "array") then
    [.[][] | if (.number | type) == "number" and (.head.ref | type) == "string" and
      (.head.sha | type) == "string" and .state == "closed" then
      {number, headRefName:.head.ref, headRefOid:.head.sha,
       isCrossRepository:(.head.repo.full_name == null or
         .head.repo.full_name != .base.repo.full_name)}
      else error("invalid closed PR") end]
    else error("invalid closed PR pages") end' <<<"$closed") || return 1
}

# A tip that moved after its PR closed carries commits GitHub never kept:
# only the exact head is recoverable. Missing data is not recoverability.
cleanup_closed_pr_head() {
  local branch=$1 tip=$2 number
  [[ -n ${CLEANUP_CLOSED_PRS:-} ]] || return 1
  number=$(jq -r --arg branch "$branch" --arg tip "$tip" 'first(.[] |
    select(.isCrossRepository == false and .headRefName == $branch and .headRefOid == $tip) | .number) // empty' <<<"$CLEANUP_CLOSED_PRS")
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
    # GitHub may already have deleted the branch while tracking refs are stale.
    # An empty push still runs hooks, but carries no deletion for a worktree
    # guard to recognize. Lookup failure must never be treated as absence.
    local remote_head
    remote_head=$(git -C "$repo" ls-remote --heads origin "refs/heads/$branch") || return 1
    [[ -n $remote_head ]] || return 0
    git -C "$repo" push --force-with-lease="refs/heads/$branch:$tip" origin ":refs/heads/$branch"
  else
    # Compare-and-delete: never discard a newer tip. Do not use branch -D,
    # which cannot bind deletion to the reviewed SHA.
    git -C "$repo" update-ref -d "refs/heads/$branch" "$tip"
  fi
}
