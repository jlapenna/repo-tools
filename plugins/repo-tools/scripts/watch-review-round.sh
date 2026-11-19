#!/usr/bin/env bash
# Wait for one review provider's terminal comment on one PR revision.
set -euo pipefail
if [[ $# != 7 ]]; then
  echo "usage: watch-review-round.sh OWNER/REPO PR HEAD_SHA TRIGGER_COMMENT_ID BOT_LOGIN FINISHED_FIRST_LINE FAILED_FIRST_LINE" >&2
  exit 1
fi
repo=$1 pr=$2 head=$3 trigger=$4 bot=$5 finished=$6 failed=$7
[[ $pr =~ ^[0-9]+$ && $trigger =~ ^[0-9]+$ && $head =~ ^[0-9a-f]{40}$ && -n $bot && -n $finished && -n $failed && $finished != "$failed" ]] || exit 1
comments="repos/$repo/issues/$pr/comments"
while true; do
  # Comments are untrusted text. Compare the provider login and literal
  # first line (including the round identifier) without executing either.
  verdict=$(gh api --paginate "$comments?per_page=100" | jq -rs \
    --arg bot "$bot" --argjson trigger "$trigger" --arg finished "$finished" --arg failed "$failed" '
      [.[][] | select(.id > $trigger and .user.login == $bot) |
        (.body | split("\n")[0] | rtrimstr("\r")) as $line |
        if $line == $finished then "finished" elif $line == $failed then "failed" else empty end] | last // empty')
  state=$(gh pr view "$pr" --repo "$repo" --json headRefOid,state --jq '[.headRefOid,.state] | @tsv')
  if [[ $state != "$head"$'\t'OPEN ]]; then
    echo "Review target changed: $state" >&2
    exit 2
  fi
  case "$verdict" in
    finished) echo "Review round finished"; exit 0 ;;
    failed) echo "Review round failed"; exit 2 ;;
  esac
  sleep 30
done
