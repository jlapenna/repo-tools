#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shim="$ROOT/bin/gh-shim.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

bindir="$tmpdir/bin"
mkdir -p "$bindir"
calls="$tmpdir/calls"
: >"$calls"

# Stand-in for the real gh: records the token it was invoked with.
cat >"$bindir/gh" <<'EOF'
#!/usr/bin/env bash
printf 'token=%s args=%s\n' "${GH_TOKEN:-<none>}" "$*" >>"$GH_TEST_CALLS"
EOF
chmod +x "$bindir/gh"

# Stand-in for the minting command.
cat >"$bindir/repo-github-app-token" <<'EOF'
#!/usr/bin/env bash
if [ "${MINT_SHOULD_FAIL:-0}" = 1 ]; then
  echo "mint boom" >&2
  exit 1
fi
repo=""
while [ $# -gt 0 ]; do
  [ "$1" = "--repo" ] && repo="$2"
  shift
done
printf 'ghs_for_%s\n' "${repo:-cwd}"
EOF
chmod +x "$bindir/repo-github-app-token"

# The shim is reached the way a host reaches it: a symlink named `gh` that
# precedes the real one on PATH.
shimdir="$tmpdir/shim"
mkdir -p "$shimdir"
ln -s "$shim" "$shimdir/gh"

repo="$tmpdir/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" remote add origin https://github.com/acme/widgets.git

# Start every case from a clean slate: this suite itself usually runs inside an
# agent session, so an inherited CLAUDE_CODE_SESSION_ID would make the
# human-invocation cases silently test the agent path instead.
run_gh() {
  env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u GH_TOKEN -u GITHUB_TOKEN \
    -u REPO_GH_IDENTITY \
    PATH="$shimdir:$bindir:/usr/bin:/bin" GH_TEST_CALLS="$calls" "$@"
}

last_call() { tail -1 "$calls"; }

# An agent session inside a repository gets a minted token, without asking.
run_gh CLAUDE_CODE_SESSION_ID=abc bash -c "cd '$repo' && gh pr create --title x"
grep -q 'token=ghs_for_cwd args=pr create --title x' <<<"$(last_call)" \
  || { echo "FAIL: agent session did not get a token: $(last_call)" >&2; exit 1; }

# A human in the very same directory is untouched.
run_gh bash -c "cd '$repo' && gh pr list"
grep -q 'token=<none>' <<<"$(last_call)" \
  || { echo "FAIL: non-agent invocation was given a token: $(last_call)" >&2; exit 1; }

# --repo wins over the working directory, because the token is repo-scoped.
run_gh CLAUDE_CODE_SESSION_ID=abc bash -c "cd '$repo' && gh issue create --repo other/thing"
grep -q 'token=ghs_for_other/thing' <<<"$(last_call)" \
  || { echo "FAIL: --repo was not used for scoping: $(last_call)" >&2; exit 1; }
run_gh CLAUDE_CODE_SESSION_ID=abc bash -c "cd '$repo' && gh issue list --repo=third/thing"
grep -q 'token=ghs_for_third/thing' <<<"$(last_call)" \
  || { echo "FAIL: --repo=X form was not used: $(last_call)" >&2; exit 1; }

# Codex sessions count too.
run_gh CODEX_THREAD_ID=xyz bash -c "cd '$repo' && gh pr list"
grep -q 'token=ghs_for_cwd' <<<"$(last_call)" \
  || { echo "FAIL: CODEX_THREAD_ID was not recognised: $(last_call)" >&2; exit 1; }

# An explicit token from the caller is never overridden.
run_gh CLAUDE_CODE_SESSION_ID=abc GH_TOKEN=caller_supplied bash -c "cd '$repo' && gh pr list"
grep -q 'token=caller_supplied' <<<"$(last_call)" \
  || { echo "FAIL: caller's explicit token was overridden: $(last_call)" >&2; exit 1; }

# Outside any repository there is nothing to scope, and these are not the
# writes that get misattributed.
run_gh CLAUDE_CODE_SESSION_ID=abc bash -c "cd '$tmpdir' && gh auth status"
grep -q 'token=<none>' <<<"$(last_call)" \
  || { echo "FAIL: non-repo command should pass through: $(last_call)" >&2; exit 1; }

# The escape hatch works.
run_gh CLAUDE_CODE_SESSION_ID=abc REPO_GH_IDENTITY=off bash -c "cd '$repo' && gh pr list"
grep -q 'token=<none>' <<<"$(last_call)" \
  || { echo "FAIL: REPO_GH_IDENTITY=off did not pass through: $(last_call)" >&2; exit 1; }

# A failed mint refuses rather than quietly writing as the human. This is the
# entire point of the shim, so it must not degrade into a fallback.
: >"$calls"
if run_gh CLAUDE_CODE_SESSION_ID=abc MINT_SHOULD_FAIL=1 \
  bash -c "cd '$repo' && gh pr create" >/dev/null 2>"$tmpdir/err"; then
  echo "FAIL: failed mint should exit non-zero" >&2
  exit 1
fi
[ ! -s "$calls" ] \
  || { echo "FAIL: gh ran anyway after a failed mint: $(cat "$calls")" >&2; exit 1; }
grep -q 'REPO_GH_IDENTITY=optional' "$tmpdir/err" \
  || { echo "FAIL: refusal should name the escape hatch" >&2; exit 1; }

# ...unless the caller has explicitly accepted the fallback.
run_gh CLAUDE_CODE_SESSION_ID=abc MINT_SHOULD_FAIL=1 REPO_GH_IDENTITY=optional \
  bash -c "cd '$repo' && gh pr list"
grep -q 'token=<none>' <<<"$(last_call)" \
  || { echo "FAIL: optional mode should fall back: $(last_call)" >&2; exit 1; }

# Regression: a package manager may install this as a *wrapper script* rather
# than a symlink -- pnpm does -- so $0 is the file in the package store while
# the PATH entry that led here is a different path. Path comparison alone then
# fails to recognise the shim in PATH, it selects itself as "the real gh", and
# exec replaces the process with itself forever: one pid, spinning, which reads
# as a hang rather than a crash. This happened on a real host.
store="$tmpdir/store"
mkdir -p "$store"
cp "$shim" "$store/gh-shim.sh"
chmod +x "$store/gh-shim.sh"
cat >"$bindir/repo-gh-shim" <<EOF
#!/usr/bin/env bash
exec "$store/gh-shim.sh" "\$@"
EOF
chmod +x "$bindir/repo-gh-shim"

wrapdir="$tmpdir/wrap"
mkdir -p "$wrapdir"
ln -s "$bindir/repo-gh-shim" "$wrapdir/gh"

: >"$calls"
if ! timeout 20 env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u GH_TOKEN \
  -u GITHUB_TOKEN -u REPO_GH_IDENTITY \
  PATH="$wrapdir:$bindir:/usr/bin:/bin" GH_TEST_CALLS="$calls" \
  CLAUDE_CODE_SESSION_ID=abc bash -c "cd '$repo' && gh pr list"; then
  echo "FAIL: wrapper-script install looped or errored instead of finding real gh" >&2
  exit 1
fi
grep -q 'token=ghs_for_cwd' <<<"$(last_call)" \
  || { echo "FAIL: wrapper-script install did not reach real gh: $(last_call)" >&2; exit 1; }

# And if the only gh on PATH really is the shim, it must say so and stop rather
# than spin. Belt and braces for any install shape not anticipated above.
onlydir="$tmpdir/only"
mkdir -p "$onlydir"
ln -s "$shim" "$onlydir/gh"
if timeout 20 env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  PATH="$onlydir:/usr/bin:/bin" CLAUDE_CODE_SESSION_ID=abc \
  bash -c "cd '$repo' && gh pr list" >/dev/null 2>"$tmpdir/loop_err"; then
  echo "FAIL: shim-only PATH should exit non-zero" >&2
  exit 1
fi
[ "$?" = 124 ] && { echo "FAIL: shim-only PATH timed out (it looped)" >&2; exit 1; }

echo "gh-shim: all assertions passed"
