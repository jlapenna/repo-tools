#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/config/nx"
cat > "$fixture/bin/pnpm" <<'SH'
#!/bin/sh
[ "${NX_SELF_HOSTED_REMOTE_CACHE_SERVER:-}" = "${TEST_EXPECTED_SERVER:-}" ] || exit 41
[ "${NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN:-}" = "${TEST_EXPECTED_TOKEN:-}" ] || exit 42
SH
cat > "$fixture/bin/curl" <<'SH'
#!/bin/sh
exit "${TEST_HEALTH_STATUS:-0}"
SH
chmod +x "$fixture/bin/"*
git init -qb main "$fixture/primary"
git -C "$fixture/primary" -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm initial
git -C "$fixture/primary" worktree add -qb feature "$fixture/worktree"
cd "$fixture/worktree"
run() {
  env -u NX_SELF_HOSTED_REMOTE_CACHE_SERVER -u NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN \
    PATH="$fixture/bin:$PATH" XDG_CONFIG_HOME="$fixture/config" \
    TEST_EXPECTED_SERVER="${1:-}" TEST_EXPECTED_TOKEN="${2:-}" \
    bash "$here/nx.sh" --version
}
write_cache() {
  printf 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://cache.invalid\nNX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=%s\n' "$2" > "$1"
}
write_cache "$fixture/config/nx/remote-cache.env" first-fixture-token
run http://cache.invalid first-fixture-token
# Rotation changes the next invocation without making a worktree-local copy.
write_cache "$fixture/config/nx/remote-cache.env" rotated-fixture-token
run http://cache.invalid rotated-fixture-token
[[ ! -e .nx-remote-cache.env ]]
# A primary checkout's explicit per-repository configuration still wins.
write_cache "$fixture/primary/.nx-remote-cache.env" repo-fixture-token
run http://cache.invalid repo-fixture-token
# An unreachable server does not load credentials or block local computation.
TEST_HEALTH_STATUS=7 run '' ''
# An explicit CI environment takes precedence and bypasses even failed health.
env PATH="$fixture/bin:$PATH" XDG_CONFIG_HOME="$fixture/config" TEST_HEALTH_STATUS=7 \
  NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://explicit.invalid \
  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=ci-fixture-token \
  TEST_EXPECTED_SERVER=http://explicit.invalid TEST_EXPECTED_TOKEN=ci-fixture-token \
  bash "$here/nx.sh" --version
echo 'account-wide Nx cache fallback passed'
