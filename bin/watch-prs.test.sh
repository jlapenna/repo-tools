#!/usr/bin/env bash
set -euo pipefail

# Keep fake command PATH intact even on hosts with shell startup hooks.
export BASH_ENV=/dev/null

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$GH_CALLS_FILE"
case "$*" in
  'repo view --json owner,name --jq .owner.login + "/" + .name')
    [ "$SCENARIO" = norepo ] && { echo 'not a git repository' >&2; exit 1; }
    echo 'owner/repo'
    ;;
  'repo view other/name --json owner,name --jq .owner.login + "/" + .name') echo 'other/name' ;;
  *'pr view 123 --json state,mergeStateStatus,autoMergeRequest'*)
    case "$SCENARIO" in
      pending|steady)
        if [ "$SCENARIO" = steady ] || [ ! -e "$GH_STATE_FILE" ]; then
          printf 'OPEN\tBLOCKED\ttrue\n'
          : >"$GH_STATE_FILE"
        else
          printf 'MERGED\tCLEAN\ttrue\n'
        fi
        ;;
      reread-error)
        count=$(cat "$GH_STATE_FILE" 2>/dev/null || echo 0)
        echo "$((count + 1))" >"$GH_STATE_FILE"
        case "$count" in
          0) printf 'OPEN\tBLOCKED\ttrue\n' ;;
          1) exit 1 ;;
          *) printf 'MERGED\tCLEAN\ttrue\n' ;;
        esac
        ;;
      failed|unresolved) printf 'OPEN\tBLOCKED\ttrue\n' ;;
      dirty) printf 'OPEN\tDIRTY\ttrue\n' ;;
      unarmed) printf 'OPEN\tBLOCKED\tfalse\n' ;;
      *) echo "unexpected scenario: $SCENARIO" >&2; exit 1 ;;
    esac
    ;;
  *'pr checks 123 --required --json name,bucket'*)
    case "$SCENARIO" in
      pending|steady|reread-error) echo '[{"name":"Verify","bucket":"pending"}]' ;;
      failed) echo '[{"name":"Verify Required","bucket":"fail"}]' ;;
      unresolved|unarmed) echo '[{"name":"Verify","bucket":"pass"}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  'api graphql'*) echo '1' ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"

# A fake lcars on PATH: LCARS_SCENARIO=ok accepts the subscription, anything
# else refuses it the way an absent delivery agent does.
cat >"$tmp/lcars" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$LCARS_CALLS_FILE"
if [[ "$*" == session\ unsubscribe* ]]; then exit 0; fi
if [ "$LCARS_SCENARIO" = usage ]; then exit 2; fi
if [ "$LCARS_SCENARIO" = ok ]; then
  printf '{"id":"5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f","key":"%s","until":"merged"}\n' "$3"
  exit 0
fi
echo 'lcars session subscribe: the LCARS events agent is not running on this host' >&2
exit 1
EOF
chmod +x "$tmp/lcars"

run_watch() {
  local scenario="$1"
  shift
  rm -f "$tmp/state" "$tmp/calls" "$tmp/lcars-calls"
  set +e
  output=$(SCENARIO="$scenario" GH_STATE_FILE="$tmp/state" GH_CALLS_FILE="$tmp/calls" \
    LCARS_SCENARIO="${LCARS_SCENARIO:-down}" LCARS_CALLS_FILE="$tmp/lcars-calls" \
    PATH="${WATCH_PATH:-$tmp:$PATH}" timeout 3 "$root/bin/watch-prs.sh" --interval 0 "$@" 123 2>&1)
  status=$?
  set -e
}

run_watch pending
[ "$status" -eq 0 ]
grep -F 'PR #123: OPEN:WAITING reason=checks-pending:1' <<<"$output"
grep -F 'PR #123: MERGED' <<<"$output"
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
! grep -F 'PR #123: OPEN:BLOCKED' <<<"$output" || { echo 'unexpected match: grep -F '\''PR #123: OPEN:BLOCKED'\'' <<<"$output"' >&2; exit 1; }
# The refused subscription is reported before polling takes over.
grep -F 'lcars session subscribe github:pr:owner/repo#123 failed: lcars session subscribe: the LCARS events agent is not running' <<<"$output"
grep -F 'Falling back to polling every 0s' <<<"$output"
echo 'watch-prs pending-to-merged test passed'

# Subscribe-first: a waiting PR is handed to LCARS and the script exits
# without polling again.
LCARS_SCENARIO=ok run_watch steady
[ "$status" -eq 0 ]
grep -F 'PR #123: OPEN:WAITING reason=checks-pending:1' <<<"$output"
grep -F 'PR #123: SUBSCRIBED 5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f github:pr:owner/repo#123' <<<"$output"
grep -F 'End your turn now' <<<"$output"
grep -Fqx 'VERDICT SUBSCRIBED 123' <<<"$output"
[ "$(cat "$tmp/lcars-calls")" = 'session subscribe github:pr:owner/repo#123 --kinds review,comment,thread,threads-resolved,merged,closed,reopened,pushed,conflict,auto-merge,checks-finished --until merged --json' ]
[ "$(grep -c '^pr view ' "$tmp/calls")" -eq 2 ]
! grep -F 'MERGED' <<<"$output" || { echo 'subscribe path must not keep polling' >&2; exit 1; }
echo 'watch-prs subscribe-first test passed'

# A terminal transition before registration is caught by the post-subscribe
# snapshot, and the now-obsolete subscription is removed.
LCARS_SCENARIO=ok run_watch pending
[ "$status" -eq 0 ]
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
grep -F 'session unsubscribe 5f0c2a9e7b1d4c3a8e6f0b2d4c6a8e0f' "$tmp/lcars-calls"
! grep -F 'VERDICT SUBSCRIBED' <<<"$output"
echo 'watch-prs registration-race test passed'
LCARS_SCENARIO=ok run_watch reread-error
[ "$status" -eq 0 ]
grep -F 'Post-subscribe snapshot failed' <<<"$output"
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
! grep -F 'VERDICT SUBSCRIBED' <<<"$output"
grep -F 'session unsubscribe' "$tmp/lcars-calls"
echo 'watch-prs failed registration snapshot test passed'

LCARS_SCENARIO=usage run_watch steady
[ "$status" -eq 1 ]
grep -F 'Subscription usage error' <<<"$output"
[ "$(grep -c '^pr view ' "$tmp/calls")" -eq 1 ]
echo 'watch-prs usage-error test passed'


# A state that needs attention now is reported before any subscription.
LCARS_SCENARIO=ok run_watch dirty
[ "$status" -eq 2 ]
grep -Fqx 'VERDICT ATTENTION 123 dirty' <<<"$output"
[ ! -e "$tmp/lcars-calls" ]
echo 'watch-prs attention-before-subscribe test passed'

# --poll keeps the old loop even where subscribing would work.
LCARS_SCENARIO=ok run_watch pending --poll
[ "$status" -eq 0 ]
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
[ ! -e "$tmp/lcars-calls" ]
echo 'watch-prs --poll test passed'

# Without lcars on PATH, the script says so and polls.
nolcars="$tmp/nolcars"
mkdir -p "$nolcars"
ln -s "$tmp/gh" "$nolcars/gh"
path_without_lcars="$nolcars"
IFS=: read -r -a path_dirs <<<"$PATH"
for dir in "${path_dirs[@]}"; do
  [ -n "$dir" ] && [ ! -e "$dir/lcars" ] && path_without_lcars="$path_without_lcars:$dir"
done
WATCH_PATH="$path_without_lcars" run_watch pending
[ "$status" -eq 0 ]
grep -F 'lcars CLI not on PATH' <<<"$output"
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
echo 'watch-prs missing-lcars fallback test passed'

help_out=$("$root/bin/watch-prs.sh" --help)
grep -Fq 'usage: watch-prs.sh' <<<"$help_out" || { echo 'expected usage on --help' >&2; exit 1; }
echo 'watch-prs help test passed'

run_watch failed
[ "$status" -eq 2 ]
grep -F 'PR #123: OPEN:BLOCKED reason=checks-failed:Verify_Required' <<<"$output"
grep -Fqx 'VERDICT ATTENTION 123 checks-failed:Verify_Required' <<<"$output"
echo 'watch-prs failed-check test passed'

run_watch dirty
[ "$status" -eq 2 ]
grep -F 'PR #123: OPEN:BLOCKED reason=dirty' <<<"$output"
grep -Fqx 'VERDICT ATTENTION 123 dirty' <<<"$output"
echo 'watch-prs dirty-branch test passed'

run_watch unresolved
[ "$status" -eq 2 ]
grep -F 'PR #123: OPEN:BLOCKED reason=unresolved-threads:1' <<<"$output"
grep -Fqx 'VERDICT ATTENTION 123 unresolved-threads:1' <<<"$output"
echo 'watch-prs unresolved-thread test passed'

run_watch unarmed
[ "$status" -eq 2 ]
grep -F 'PR #123: OPEN:BLOCKED reason=auto-merge-unarmed' <<<"$output"
grep -Fqx 'VERDICT ATTENTION 123 auto-merge-unarmed' <<<"$output"
echo 'watch-prs unarmed-auto-merge test passed'

run_watch pending --repo other/name
[ "$status" -eq 0 ]
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
grep -q '^pr ' "$tmp/calls"
[ -z "$(grep '^pr ' "$tmp/calls" | grep -vF -- '--repo other/name')" ]
echo 'watch-prs explicit-repo test passed'

run_watch norepo
[ "$status" -eq 1 ]
grep -F 'pass --repo <owner/name>' <<<"$output"
[ "$(grep -c '^pr ' "$tmp/calls")" -eq 0 ]
echo 'watch-prs unresolvable-repo test passed'

# Review completion belongs to the requested round, even when older rounds
# or another commenter post the same text and the PR check remains pending.
cat >"$tmp/gh" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  api)
    printf '%s\n' '[{"id":8,"user":{"login":"review-bot"},"body":"finished r2"},{"id":11,"user":{"login":"review-bot"},"body":"failed r1"},{"id":12,"user":{"login":"someone"},"body":"finished r2"}]'
    jq -nc --arg body "$RESULT" '[{id:15,user:{login:"review-bot"},body:$body}]'
    ;;
  pr) printf '%s\tOPEN\n' "$CURRENT_HEAD" ;;
  *) exit 1 ;;
esac
MOCK
sha=0123456789012345678901234567890123456789
round() {
  PATH="$tmp:$PATH" RESULT="$1" CURRENT_HEAD="$2" timeout 3 \
    "$root/plugins/repo-tools/scripts/watch-review-round.sh" \
    owner/repo 123 "$sha" 10 review-bot 'finished r2' 'failed r2'
}
round $'finished r2\nreview link' "$sha"
code=0
round 'failed r2' "$sha" || code=$?
[[ $code == 2 ]]
code=0
round 'finished r2' changed || code=$?
[[ $code == 2 ]]
