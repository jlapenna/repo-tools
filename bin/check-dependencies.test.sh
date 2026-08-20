#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command="$here/check-dependencies.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin"
cat > "$tmp/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PNPM_LOG"
case "$1" in
  install) exit "${PNPM_INSTALL_EXIT:-0}" ;;
  ls) printf '%s\n' "${PNPM_TREE_OUTPUT:-}" ;;
esac
PNPM
chmod +x "$tmp/bin/pnpm"

run() {
  PATH="$tmp/bin:$PATH" PNPM_LOG="$tmp/pnpm.log" "$command"
}

run > "$tmp/output"
grep -Fxq 'install --frozen-lockfile --lockfile-only --ignore-scripts' "$tmp/pnpm.log"
grep -Fxq 'ls --depth=10' "$tmp/pnpm.log"
grep -Fxq 'Dependency checks passed.' "$tmp/output"

: > "$tmp/pnpm.log"
if PNPM_TREE_OUTPUT='missing: example@1.0.0' run > "$tmp/failure" 2>&1; then
  echo "expected missing dependency to fail" >&2
  exit 1
fi
grep -Fq 'missing: example@1.0.0' "$tmp/failure"

echo "repo-check-dependencies: ok"
