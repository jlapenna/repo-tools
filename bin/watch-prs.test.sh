#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'repo view --json owner,name --jq .owner.login + "/" + .name') echo 'owner/repo' ;;
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
  rm -f "$tmp/state"
  set +e
  output=$(SCENARIO="$scenario" GH_STATE_FILE="$tmp/state" PATH="$tmp:$PATH" \
    timeout 3 "$root/bin/watch-prs.sh" --interval 0 123 2>&1)
  status=$?
  set -e
}

run_watch pending
[ "$status" -eq 0 ]
grep -F 'PR #123: OPEN:WAITING reason=checks-pending:1' <<<"$output"
grep -F 'PR #123: MERGED' <<<"$output"
grep -Fqx 'VERDICT ALL-MERGED' <<<"$output"
! grep -F 'PR #123: OPEN:BLOCKED' <<<"$output"
echo 'watch-prs pending-to-merged test passed'

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
