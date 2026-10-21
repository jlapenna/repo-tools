#!/usr/bin/env bash
set -euo pipefail

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
      pending)
        if [ ! -e "$GH_STATE_FILE" ]; then
          printf 'OPEN\tBLOCKED\ttrue\n'
          : >"$GH_STATE_FILE"
        else
          printf 'MERGED\tCLEAN\ttrue\n'
        fi
        ;;
      failed|unresolved) printf 'OPEN\tBLOCKED\ttrue\n' ;;
      dirty) printf 'OPEN\tDIRTY\ttrue\n' ;;
      unarmed) printf 'OPEN\tBLOCKED\tfalse\n' ;;
      *) echo "unexpected scenario: $SCENARIO" >&2; exit 1 ;;
    esac
    ;;
  *'pr checks 123 --required --json name,bucket'*)
    case "$SCENARIO" in
      pending) echo '[{"name":"Verify","bucket":"pending"}]' ;;
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

run_watch() {
  local scenario="$1"
  shift
  rm -f "$tmp/state" "$tmp/calls"
  set +e
  output=$(SCENARIO="$scenario" GH_STATE_FILE="$tmp/state" GH_CALLS_FILE="$tmp/calls" \
    PATH="$tmp:$PATH" timeout 3 "$root/bin/watch-prs.sh" --interval 0 "$@" 123 2>&1)
  status=$?
  set -e
}

run_watch pending
[ "$status" -eq 0 ]
grep -F 'PR #123: OPEN:WAITING reason=checks-pending:1' <<<"$output"
grep -F 'PR #123: MERGED' <<<"$output"
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
! grep -F 'PR #123: OPEN:BLOCKED' <<<"$output" || { echo 'unexpected match: grep -F '\''PR #123: OPEN:BLOCKED'\'' <<<"$output"' >&2; exit 1; }
echo 'watch-prs pending-to-merged test passed'

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
