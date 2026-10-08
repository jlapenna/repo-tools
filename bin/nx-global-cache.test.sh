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
# Health checks pass unless TEST_HEALTH_STATUS says otherwise or the URL names
# a dead host. The token probe reads its header from stdin and prints a status:
# 404 (accepted) unless the token is "rejected-fixture-token".
for arg in "$@"; do url="$arg"; done
case "$url" in
  *dead.invalid*) exit 7 ;;
  */authprobe*)
    if grep -q 'Bearer rejected-fixture-token"'; then printf 403; else printf 404; fi
    exit 0
    ;;
esac
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
    bash "$here/nx.sh" --version 2>"$fixture/stderr"
}
write_cache() {
  printf 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER=%s\nNX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=%s\n' "${3:-http://cache.invalid}" "$2" > "$1"
}
quiet() { [[ ! -s "$fixture/stderr" ]] || { cat "$fixture/stderr" >&2; exit 43; }; }
warned() { grep -q -- "$1" "$fixture/stderr" || { cat "$fixture/stderr" >&2; exit 44; }; }
write_cache "$fixture/config/nx/remote-cache.env" first-fixture-token
run http://cache.invalid first-fixture-token
quiet
# Rotation changes the next invocation without making a worktree-local copy.
write_cache "$fixture/config/nx/remote-cache.env" rotated-fixture-token
run http://cache.invalid rotated-fixture-token
[[ ! -e .nx-remote-cache.env ]]
# A primary checkout's explicit per-repository configuration still wins.
write_cache "$fixture/primary/.nx-remote-cache.env" repo-fixture-token
run http://cache.invalid repo-fixture-token
quiet
# A repository file naming a retired host falls through to the working
# account-wide credential, and says so instead of silently recomputing.
write_cache "$fixture/primary/.nx-remote-cache.env" repo-fixture-token http://dead.invalid
run http://cache.invalid rotated-fixture-token
warned 'dead.invalid does not answer'
warned 'Using .*config/nx/remote-cache.env instead'
# A rejected token falls through the same way.
write_cache "$fixture/primary/.nx-remote-cache.env" rejected-fixture-token
run http://cache.invalid rotated-fixture-token
warned 'rejects its token (HTTP 403)'
# With every credential broken, nothing loads and the warning names the fix.
write_cache "$fixture/config/nx/remote-cache.env" rejected-fixture-token
run '' ''
warned 'no configured credential works'
write_cache "$fixture/config/nx/remote-cache.env" rotated-fixture-token
rm "$fixture/primary/.nx-remote-cache.env"
# An unreachable server does not load credentials or block local computation.
TEST_HEALTH_STATUS=7 run '' ''
quiet
# An explicit CI environment takes precedence and bypasses even failed health.
env PATH="$fixture/bin:$PATH" XDG_CONFIG_HOME="$fixture/config" TEST_HEALTH_STATUS=7 \
  NX_SELF_HOSTED_REMOTE_CACHE_SERVER=http://explicit.invalid \
  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=ci-fixture-token \
  TEST_EXPECTED_SERVER=http://explicit.invalid TEST_EXPECTED_TOKEN=ci-fixture-token \
  bash "$here/nx.sh" --version
echo 'account-wide Nx cache fallback passed'
