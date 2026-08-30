#!/usr/bin/env bash
# Watch armed PRs until every one merges or any one needs attention.
#
# The single-run monitor (repo-watch-run) answers "did this CI run pass?";
# this script answers the auto-merge lifecycle question an agent session
# actually has after `gh pr merge --auto`: "did my PRs land, and if not,
# what do I need to fix?" It polls each PR and exits the moment anything
# needs a human/agent (a DIRTY merge state, a failed check, a close
# without merge) — or with success once every watched PR has merged.
#
# Designed to run as a BACKGROUND task in an agent session: the exit
# re-invokes the agent with the verdict on stdout, so nothing sits
# unnoticed. Failure detection matters most — an armed PR whose Verify
# fails will otherwise wait silently forever (auto-merge never fires and
# nothing pings the session; this exact gap cost hours on #4211/#4230).
#
# Usage:
#   watch-prs.sh [--strict] [--interval <seconds>] <pr-number> [<pr-number>...]
#
# Output: one timestamped operational state per classification change, then a
# final verdict. GitHub's raw mergeStateStatus is deliberately not exposed:
# BLOCKED commonly means checks are still pending, which needs no intervention.
#
#   PR #123: OPEN:WAITING reason=checks-pending:2
#   PR #123: OPEN:BLOCKED reason=checks-failed:Verify
#
# Final verdicts:
#   VERDICT ALL-MERGED                          (exit 0)
#   VERDICT ATTENTION <pr> <reason>             (exit 2)
# <reason> is always a single whitespace-free token, so a consumer may parse
# the verdict positionally. Check names are sanitized to preserve that (see
# sanitize_names below) — real names here contain spaces ("E2E Tests").
# Reasons: dirty (needs rebase), behind (only with --strict — update
# the branch), auto-merge-unarmed (green PR needs an explicit merge
# disposition), checks-failed:<names> (failed OR cancelled required checks),
# unresolved-threads:<n> (green checks but dangling review threads — under
# required_review_thread_resolution auto-merge waits forever; resolve them
# per the repo's pr.md GraphQL recipe), closed-unmerged.
#
# Requires: gh (authenticated). Poll cost is two `gh` calls per PR per
# interval; the default 120s keeps that well inside rate limits.
#
# This plugin-bundled file is the single implementation: consumer repositories
# hold no copies, and the public package's `repo-watch-prs` bin is only a thin
# wrapper around it. The script is fully repo-neutral (repository identity is
# discovered from cwd), so no parameterization hook is needed.

set -euo pipefail

interval=120
strict=false
prs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --interval)
      interval="$2"
      shift 2
      ;;
    --strict)
      strict=true
      shift
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
    *)
      prs+=("$1")
      shift
      ;;
  esac
done

if [ ${#prs[@]} -eq 0 ]; then
  echo "usage: watch-prs.sh [--strict] [--interval <seconds>] <pr-number> [<pr-number>...]" >&2
  exit 1
fi

declare -A merged=()
declare -A last=()

# Owner/name for the GraphQL review-thread query, derived once from cwd.
repo_owner=""
repo_name=""
discover_repo() {
  [ -n "$repo_owner" ] && return 0
  if repo_json=$(gh repo view --json owner,name --jq '.owner.login + "/" + .name' 2>/dev/null); then
    repo_owner="${repo_json%%/*}"
    repo_name="${repo_json##*/}"
    return 0
  fi
  return 1
}
discover_repo || true

unresolved_thread_count() {
  # Prints the PR's unresolved review-thread count (0 on any error, so a
  # GraphQL hiccup can never fabricate an attention verdict).
  discover_repo || { echo 0; return; }
  local counts
  if ! counts=$(gh api graphql --paginate \
    -F owner="$repo_owner" -F name="$repo_name" -F pr="$1" -f query='
    query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 50, after: $endCursor) {
            nodes { isResolved }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }' --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length' \
    2>/dev/null); then
    echo 0
    return
  fi
  printf '%s\n' "$counts" | awk '{ sum += $1 } END { print sum + 0 }'
}

sanitize_names() {
  # Reads `gh pr checks --json name,bucket` on stdin; prints the failed and
  # cancelled check names as ONE comma-joined, whitespace-free token.
  #
  # GitHub check names are arbitrary strings and routinely contain spaces
  # ("E2E Tests", "Detect affected E2E projects") — and a workflow can name a
  # job with a newline. Interpolated raw into the verdict line, a space
  # silently truncates <reason> for any positional parser, and a newline
  # forges an entire extra VERDICT line. Collapsing [whitespace + comma] to
  # `_` keeps names readable while making the delimiter unambiguous.
  jq -r '[.[] | select(.bucket == "fail" or .bucket == "cancel")
          | .name | gsub("[\\s,]+"; "_")] | join(",")'
}

log() {
  echo "$(date -u +%H:%M:%S) $*"
}

report_state() {
  local pr="$1" key="$2" message="$3"
  if [ "${last[$pr]:-}" != "$key" ]; then
    log "PR #$pr: $message"
    last[$pr]="$key"
  fi
}

while true; do
  all_merged=true
  for pr in "${prs[@]}"; do
    [ "${merged[$pr]:-}" = "1" ] && continue

    if ! status=$(gh pr view "$pr" --json state,mergeStateStatus,autoMergeRequest \
      --jq '[.state, .mergeStateStatus, (.autoMergeRequest != null)] | @tsv' 2>/dev/null); then
      # Transient gh/network error: report once, keep watching.
      all_merged=false
      [ "${last[$pr]:-}" != "gh-error" ] && log "PR #$pr: gh lookup failed (will retry)"
      last[$pr]="gh-error"
      continue
    fi

    IFS=$'\t' read -r state merge_state auto_merge_armed <<<"$status"

    case "$state" in
      MERGED)
        merged[$pr]=1
        log "PR #$pr: MERGED"
        continue
        ;;
      CLOSED)
        log "PR #$pr: closed without merging"
        echo "VERDICT ATTENTION $pr closed-unmerged"
        exit 2
        ;;
    esac
    all_merged=false

    case "$merge_state" in
      DIRTY)
        report_state "$pr" "blocked:dirty" "OPEN:BLOCKED reason=dirty"
        echo "VERDICT ATTENTION $pr dirty"
        exit 2
        ;;
      BEHIND)
        # A non-strict ruleset permits this state. Opt into attention only
        # when the repository actually requires an up-to-date branch.
        if [ "$strict" = true ]; then
          report_state "$pr" "blocked:behind" "OPEN:BLOCKED reason=behind"
          echo "VERDICT ATTENTION $pr behind"
          exit 2
        fi
        ;;
    esac

    # A cancelled required check blocks auto-merge exactly like a failed
    # one, so both buckets are attention states (`gh pr checks` buckets:
    # pass / fail / pending / skipping / cancel). The command exits
    # non-zero while anything is pending or failed; only the output
    # matters here.
    buckets=$(gh pr checks "$pr" --required --json name,bucket 2>/dev/null || true)
    # The human-readable log line keeps the original names; the verdict line
    # gets sanitized ones, because `reason` must stay one token.
    failed_raw=$(printf '%s' "$buckets" |
      jq -r '[.[] | select(.bucket == "fail" or .bucket == "cancel") | .name] | join(", ")' 2>/dev/null || true)
    failed=$(printf '%s' "$buckets" | sanitize_names 2>/dev/null || true)
    if [ -n "$failed" ]; then
      report_state "$pr" "blocked:checks-failed:$failed" \
        "OPEN:BLOCKED reason=checks-failed:$failed ($failed_raw)"
      echo "VERDICT ATTENTION $pr checks-failed:$failed"
      exit 2
    fi

    pending=$(printf '%s' "$buckets" |
      jq -r '[.[] | select(.bucket == "pending")] | length' 2>/dev/null || echo 1)

    if [ "$pending" != "0" ]; then
      report_state "$pr" "waiting:checks-pending:$pending" \
        "OPEN:WAITING reason=checks-pending:$pending"
      continue
    fi

    # A watcher is normally started after arming auto-merge, but verify that
    # precondition instead of sleeping forever when a PR was opened by a human
    # or an interactive agent. Green is not a merge disposition.
    if [ "$pending" = "0" ] && [ "$auto_merge_armed" != "true" ]; then
      report_state "$pr" "blocked:auto-merge-unarmed" \
        "OPEN:BLOCKED reason=auto-merge-unarmed"
      echo "VERDICT ATTENTION $pr auto-merge-unarmed"
      exit 2
    fi

    # Green checks + BLOCKED + unresolved review threads = the silent
    # forever-wait required_review_thread_resolution creates: auto-merge
    # reports no error and no state change, so without this the watch
    # sleeps for good (this exact combination held three armed PRs on
    # 2026-08-11). Only fires once nothing is pending, so a review that
    # lands mid-CI doesn't exit the watch prematurely.
    if [ "$pending" = "0" ] && [ "$merge_state" = "BLOCKED" ]; then
      threads=$(unresolved_thread_count "$pr")
      if [ "$threads" -gt 0 ]; then
        report_state "$pr" "blocked:unresolved-threads:$threads" \
          "OPEN:BLOCKED reason=unresolved-threads:$threads"
        echo "VERDICT ATTENTION $pr unresolved-threads:$threads"
        exit 2
      fi
    fi

    # Green, armed, and not otherwise actionable. BLOCKED can still mean a
    # requested review is pending or GitHub is recalculating mergeability; both
    # are waiting states until a concrete attention condition appears above.
    report_state "$pr" "waiting:auto-merge:$merge_state" \
      "OPEN:WAITING reason=auto-merge:$merge_state"
  done

  if $all_merged; then
    echo "VERDICT ALL-MERGED"
    exit 0
  fi
  sleep "$interval"
done
