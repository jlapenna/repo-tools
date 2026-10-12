#!/usr/bin/env bash
# Sourceable inactivity evidence. Reads do not count as activity; file writes,
# checkout/commit/ref movements do. Every error keeps the worktree.
cleanup_worktree_idle() {
  local path=$1 branch=$2 hours=$3 cutoff recent line moved ref committed
  (( hours > 0 )) || return 0
  cutoff=$(( $(date +%s) - hours * 3600 ))
  committed=$(git -C "$path" show -s --format=%ct HEAD) || {
    echo 'unverified:commit-activity-check-failed'; return 1;
  }
  if (( committed >= cutoff )); then
    echo "recent:commit-activity-within-${hours}h"; return 1
  fi
  recent=$(find "$path" -newermt "@$cutoff" -print -quit) || {
    echo 'unverified:activity-check-failed'; return 1;
  }
  [[ -z $recent ]] || { echo "recent:file-activity-within-${hours}h"; return 1; }
  local refs=(HEAD)
  [[ -z $branch ]] || refs+=("refs/heads/$branch")
  for ref in "${refs[@]}"; do
    line=$(git -C "$path" reflog show --date=unix --format=%gd -1 "$ref") || {
      echo 'unverified:ref-activity-check-failed'; return 1;
    }
    moved=$(sed -n 's/.*@{\([0-9]*\)}$/\1/p' <<<"$line")
    if [[ -n $moved ]] && (( moved >= cutoff )); then
      echo "recent:git-ref-activity-within-${hours}h"; return 1
    fi
  done
}
