#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  'repo view --json owner,name --jq .owner.login + "/" + .name') echo 'owner/repo' ;;
  *'pr view 123 --json state,mergeStateStatus,autoMergeRequest'*) printf 'OPEN\tBLOCKED\tfalse\n' ;;
  *'pr checks 123 --required --json name,bucket'*) echo '[{"name":"Verify","bucket":"pass"}]' ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"

set +e
output=$(PATH="$tmp:$PATH" timeout 3 "$root/bin/watch-prs.sh" --interval 1 123 2>&1)
status=$?
set -e

[ "$status" -eq 2 ]
grep -Fqx 'VERDICT ATTENTION 123 auto-merge-unarmed' <<<"$output"
echo 'watch-prs unarmed-auto-merge test passed'
