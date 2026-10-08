#!/usr/bin/env bash
# Usage: repo-audit-branches [--base main] [--fetch] [--delete] [--delete-remote]
#                            [--no-pr-days N]
# Reports TSV: verdict, local|remote, branch, audited SHA, reason. No fetch or
# deletion by default. Local and remote deletions require separate flags.
# Unmerged branches that never had a PR are abandoned once their tip is older
# than N days (default 3; 0 keeps them).
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=bin/cleanup-evidence.sh
source "$here/cleanup-evidence.sh"
base=main; local_delete=false; remote_delete=false; fetch=false; no_pr_days=3
while (($#)); do
  case $1 in
    --base) [[ $# -ge 2 ]] || exit 64; base=$2; shift ;;
    --fetch) fetch=true ;;
    --delete) local_delete=true ;;
    --delete-remote) remote_delete=true ;;
    --no-pr-days) [[ $# -ge 2 && $2 =~ ^[0-9]+$ ]] || exit 64; no_pr_days=$2; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done
repo=$(git rev-parse --show-toplevel)
[[ $fetch == false ]] || git fetch --prune origin
base_sha=$(git rev-parse --verify "$base^{commit}")
cleanup_load_prs "$repo" || true
# Proven merged, or (when only unmerged) never proposed and older than the
# no-PR window. Any other evidence failure keeps the branch.
audit_verdict() {
  local kind=$1 branch=$2 tip=$3 reason
  if reason=$(cleanup_evidence "$repo" "$base_sha" "$branch" "$tip"); then
    echo "$reason"; return 0
  fi
  [[ $reason == unverified:unmerged ]] || { echo "$reason"; return 1; }
  cleanup_no_pr_abandoned "$repo" "$kind" "$branch" "$tip" "$no_pr_days" || { echo "$reason"; return 1; }
}
plan=$(mktemp)
trap 'rm -f "$plan"' EXIT
while read -r ref tip; do
  case $ref in
    refs/heads/*) kind=local; branch=${ref#refs/heads/} ;;
    refs/remotes/origin/*) kind=remote; branch=${ref#refs/remotes/origin/} ;;
    *) continue ;;
  esac
  [[ $branch != HEAD && $branch != "${base#origin/}" ]] || continue
  if cleanup_branch_occupied "$repo" "$branch"; then reason=occupied; verdict=KEEP
  elif reason=$(audit_verdict "$kind" "$branch" "$tip"); then verdict=SAFE
  else verdict=KEEP; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$verdict" "$kind" "$branch" "$tip" "$reason"
  [[ $verdict != SAFE ]] || printf '%s\t%s\t%s\n' "$kind" "$branch" "$tip" >> "$plan"
done < <(git for-each-ref --format='%(refname) %(objectname)' refs/heads/ refs/remotes/origin/)
[[ $local_delete == true || $remote_delete == true ]] || exit 0
cleanup_load_prs "$repo" || { echo 'PR recheck failed; nothing deleted' >&2; exit 1; }
while read -r kind branch tip; do
  [[ $kind != local || $local_delete == true ]] || continue
  [[ $kind != remote || $remote_delete == true ]] || continue
  audit_verdict "$kind" "$branch" "$tip" >/dev/null || continue
  remote=false; [[ $kind != remote ]] || remote=true
  cleanup_delete_branch "$repo" "$branch" "$tip" "$remote"
  printf 'REMOVED\t%s\t%s\t%s\n' "$kind" "$branch" "$tip"
done < "$plan"
