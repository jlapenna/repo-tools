#!/usr/bin/env bash
# Wait for armed PRs to merge or need attention: subscribe to their LCARS
# events when this session can receive them, otherwise poll.
#
# GitHub CLI's `gh run watch` answers "did this CI run pass?";
# this script answers the auto-merge lifecycle question an agent session
# actually has after `gh pr merge --auto`: "did my PRs land, and if not,
# what do I need to fix?"
#
# Every run first reads each PR once. A PR that already merged, closed or
# needs attention gets its verdict immediately, exactly as below. For the PRs
# still waiting, it then subscribes the calling session to
# `github:pr:<owner>/<repo>#<n>` with `lcars session subscribe ... --until
# merged` and exits 0 with `VERDICT SUBSCRIBED <prs>`: there is no loop and
# nothing to keep running. LCARS types a notice into the session's terminal
# when it is idle (review, checks-finished, pushed, merged, closed, ...), so
# the caller ends its turn and reads the PR's state with gh on each notice.
#
# Subscribing fails when the lcars CLI is missing, the host's LCARS events
# agent is not running or not configured, or this session is not live on the
# host (for example outside a herdr-core terminal or outside an agent
# session). The script then says so and falls back to polling. `--poll`
# skips the subscription and polls from the start. Use it after the source
# refuses a kind needed for this lifecycle; App coverage alone does not decide
# whether a narrower host-supported wait is available. The explicit requested
# kinds include conflict, and behind in strict mode.
#
# The polling loop exits the moment anything needs a human/agent (a DIRTY
# merge state, a failed check, a close without merge) — or with success once
# every watched PR has merged. Run it as a BACKGROUND task in an agent
# session: the exit re-invokes the agent with the verdict on stdout, so
# nothing sits unnoticed. Failure detection matters most — an armed PR whose
# Verify fails will otherwise wait silently forever (auto-merge never fires
# and nothing pings the session; this exact gap cost hours on #4211/#4230).
#
# Usage:
#   watch-prs.sh [--poll] [--strict] [--interval <seconds>] [--repo <owner/name>] <pr-number> [<pr-number>...]
#
# Without --repo, the repository is resolved from cwd. An unresolvable
# repository exits 1 at startup instead of retrying forever.
#
# Output: one timestamped operational state per classification change, then a
# final verdict. GitHub's raw mergeStateStatus is deliberately not exposed:
# BLOCKED commonly means checks are still pending, which needs no intervention.
#
#   PR #123: OPEN:WAITING reason=checks-pending:2
#   PR #123: OPEN:BLOCKED reason=checks-failed:Verify
#   PR #123: SUBSCRIBED <subscription-id> github:pr:owner/repo#123
#
# Final verdicts:
#   VERDICT ALL-MERGED                          (exit 0)
#   VERDICT SUBSCRIBED <pr>[,<pr>...]           (exit 0; notices will follow)
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
# Requires: gh (authenticated); lcars for the subscription. Poll cost is two
# `gh` calls per PR per interval; the default 120s keeps that well inside
# rate limits.
#
# This plugin-bundled file is the single implementation: consumer repositories
# hold no copies, and the public package's `repo-watch-prs` bin is only a thin
# wrapper around it. The script is fully repo-neutral (repository identity is
# discovered from cwd or --repo), so no parameterization hook is needed.

set -euo pipefail

interval=120
strict=false
poll=false
repo=""
prs=()
usage='usage: watch-prs.sh [--poll] [--strict] [--interval <seconds>] [--repo <owner/name>] <pr-number> [<pr-number>...]'
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "$usage"
      exit 0
      ;;
    --interval)
      interval="$2"
      shift 2
      ;;
    --strict)
      strict=true
      shift
      ;;
    --poll)
      poll=true
      shift
      ;;
    --repo)
      repo="$2"
      shift 2
      ;;
    -*)
      echo "unknown flag: $1" >&2
      echo "$usage" >&2
      exit 1
      ;;
    *)
      prs+=("$1")
      shift
      ;;
  esac
done

if [ ${#prs[@]} -eq 0 ]; then
  echo "$usage" >&2
  exit 1
fi

declare -A merged=()
declare -A last=()
declare -A subscriptions=()
keep_subscriptions=false
cleanup_subscriptions() {
  [ "$keep_subscriptions" = true ] && return 0
  local id
  for id in "${subscriptions[@]}"; do
    lcars session unsubscribe "$id" >/dev/null 2>&1 || log "Could not remove subscription $id; stop it with: lcars session unsubscribe $id"
  done
}
trap cleanup_subscriptions EXIT

# Resolve owner/name once, from --repo or cwd, and pass it to every gh call.
# Every later gh error is then a transient one worth retrying.
if ! repo_json=$(gh repo view ${repo:+"$repo"} --json owner,name \
  --jq '.owner.login + "/" + .name' 2>&1); then
  echo "watch-prs: cannot resolve repository ${repo:-from $PWD}: $repo_json" >&2
  echo "run inside the target repository's checkout or pass --repo <owner/name>" >&2
  exit 1
fi
repo_owner="${repo_json%%/*}"
repo_name="${repo_json##*/}"
repo_args=(--repo "$repo_owner/$repo_name")

unresolved_thread_count() {
  # Prints the PR's unresolved review-thread count (0 on any error, so a
  # GraphQL hiccup can never fabricate an attention verdict).
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

# Reads one PR once. Returns 0 when it has merged and 1 while it is waiting;
# prints the verdict and exits 2 when it needs attention.
check_pr() {
  local pr="$1" status state merge_state auto_merge_armed buckets failed_raw failed pending threads
  [ "${merged[$pr]:-}" = "1" ] && return 0

  if ! status=$(gh pr view "$pr" --json state,mergeStateStatus,autoMergeRequest \
    --jq '[.state, .mergeStateStatus, (.autoMergeRequest != null)] | @tsv' \
    "${repo_args[@]}" 2>/dev/null); then
    # Transient gh/network error: report once, keep watching.
    [ "${last[$pr]:-}" != "gh-error" ] && log "PR #$pr: gh lookup failed (will retry)"
    last[$pr]="gh-error"
    snapshot_failed=true
    return 1
  fi

  IFS=$'\t' read -r state merge_state auto_merge_armed <<<"$status"

  case "$state" in
    MERGED)
      merged[$pr]=1
      log "PR #$pr: MERGED"
      return 0
      ;;
    CLOSED)
      log "PR #$pr: closed without merging"
      echo "VERDICT ATTENTION $pr closed-unmerged"
      exit 2
      ;;
  esac

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
  buckets=$(gh pr checks "$pr" --required --json name,bucket "${repo_args[@]}" 2>/dev/null || true)
  if ! printf '%s' "$buckets" | jq -e 'type == "array"' >/dev/null 2>&1; then
    log "PR #$pr: required checks lookup failed (will retry)"
    snapshot_failed=true
    return 1
  fi
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
    return 1
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
  return 1
}

# One pass over every PR; succeeds only when all of them have merged.
check_all() {
  local pr all_merged=true
  snapshot_failed=false
  for pr in "${prs[@]}"; do
    check_pr "$pr" || all_merged=false
  done
  $all_merged
}

# Subscribes this session to each waiting PR's events. Succeeds only when
# every subscription was accepted; otherwise reports why and fails, leaving
# the caller to poll.
subscribe_all() {
  local pr key out subscription_id subscribe_status subscribed=()
  if [ "$poll" = true ]; then
    return 1
  fi
  if ! command -v lcars >/dev/null 2>&1; then
    log "lcars CLI not on PATH; cannot subscribe to PR events. Falling back to polling every ${interval}s."
    return 1
  fi
  for pr in "${prs[@]}"; do
    [ "${merged[$pr]:-}" = "1" ] && continue
    key="github:pr:$repo_owner/$repo_name#$pr"
    # Ask for every state this lifecycle wrapper promises to catch. During
    # producer rollout the server refuses an unsupported kind, so a stored
    # registration alone cannot silently replace the complete watcher.
    local kinds=review,comment,thread,threads-resolved,merged,closed,reopened,pushed,conflict,auto-merge,checks-finished
    [ "$strict" = true ] && kinds="$kinds,behind"
    if out=$(lcars session subscribe "$key" --kinds "$kinds" --until merged --json 2>&1); then
      subscribe_status=0
    else
      subscribe_status=$?
    fi
    if [ "$subscribe_status" -ne 0 ]; then
      log "lcars session subscribe $key failed: $(printf '%s' "$out" | tr '\n' ' ')"
      cleanup_subscriptions
      subscriptions=()
      if [ "$subscribe_status" -eq 2 ]; then
        log "Subscription usage error; correct the key or CLI options before waiting."
        exit 1
      fi
      log "Falling back to polling every ${interval}s (pass --poll to skip subscribing)."
      return 1
    fi
    subscription_id=$(printf '%s' "$out" | jq -er '.id | select(type == "string" and length > 0)' 2>/dev/null) || {
      log "Invalid subscription response for $key; no verified wakeup."
      cleanup_subscriptions
      subscriptions=()
      return 1
    }
    subscriptions[$pr]="$subscription_id"
    log "PR #$pr: SUBSCRIBED ${subscription_id:-?} $key"
    subscribed+=("$pr")

  done
  # Close the read/subscribe race: a merge or failure between the first
  # snapshot and registration has no future event to wake this session.
  if check_all; then
    echo "VERDICT ALL-MERGED"
    return 0
  fi
  if [ "$snapshot_failed" = true ]; then
    log "Post-subscribe snapshot failed; falling back until current PR state can be verified."
    cleanup_subscriptions
    subscriptions=()
    return 1
  fi
  for pr in "${!subscriptions[@]}"; do
    if [ "${merged[$pr]:-}" = 1 ]; then
      lcars session unsubscribe "${subscriptions[$pr]}" >/dev/null 2>&1 || true
      unset 'subscriptions[$pr]'
    fi
  done
  keep_subscriptions=true
  echo "LCARS will type a notice into this session's terminal when it is idle (review, checks-finished, pushed, merged, closed, ...). End your turn now; on each notice read the PR's state with gh and act. Merge ends each subscription. Registered kinds include conflict and, in strict mode, behind; re-check current mergeability on each notice."
  echo "VERDICT SUBSCRIBED $(IFS=,; echo "${subscribed[*]}")"
  return 0
}

if check_all; then
  echo "VERDICT ALL-MERGED"
  exit 0
fi
if subscribe_all; then
  exit 0
fi

while true; do
  sleep "$interval"
  if check_all; then
    echo "VERDICT ALL-MERGED"
    exit 0
  fi
done
