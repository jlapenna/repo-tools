#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$ROOT/bin/adopt-agent-identity.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

export GIT_CONFIG_GLOBAL="$tmpdir/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
git config --global user.name "Human Person"
git config --global user.email "human@example.com"
git config --global init.defaultBranch main

repo="$tmpdir/repo"
git init -q "$repo"
git -C "$repo" commit -q --allow-empty -m init
git -C "$repo" worktree add -q "$tmpdir/wt-a" -b feature-a
git -C "$repo" worktree add -q "$tmpdir/wt-b" -b feature-b

BOT_NAME="bot-account"
BOT_EMAIL="1+bot-account@users.noreply.github.com"

# A dry run reports what it would do and changes nothing.
out="$("$script" "$repo" --name "$BOT_NAME" --email "$BOT_EMAIL" --dry-run)"
grep -q 'would adopt 2' <<<"$out" \
  || { echo "FAIL: dry run should plan 2 adoptions, got: $out" >&2; exit 1; }
[ "$(git -C "$tmpdir/wt-a" config user.email)" = "human@example.com" ] \
  || { echo "FAIL: dry run modified a worktree" >&2; exit 1; }

# The real run adopts both linked worktrees.
out="$("$script" "$repo" --name "$BOT_NAME" --email "$BOT_EMAIL")"
grep -q 'adopted 2' <<<"$out" \
  || { echo "FAIL: expected 2 adoptions, got: $out" >&2; exit 1; }
for wt in wt-a wt-b; do
  [ "$(git -C "$tmpdir/$wt" config user.email)" = "$BOT_EMAIL" ] \
    || { echo "FAIL: $wt was not adopted" >&2; exit 1; }
  [ "$(git -C "$tmpdir/$wt" config user.name)" = "$BOT_NAME" ] \
    || { echo "FAIL: $wt name was not set" >&2; exit 1; }
done

# The primary checkout is left alone. The whole separation depends on this.
[ "$(git -C "$repo" config user.email)" = "human@example.com" ] \
  || { echo "FAIL: primary checkout was modified" >&2; exit 1; }

# Running again is a no-op rather than a second round of writes.
out="$("$script" "$repo" --name "$BOT_NAME" --email "$BOT_EMAIL")"
grep -q 'adopted 0, left 2' <<<"$out" \
  || { echo "FAIL: second run should be a no-op, got: $out" >&2; exit 1; }

# A worktree deliberately set to something else is reported and preserved,
# because it may be a human's.
git -C "$tmpdir/wt-a" config --worktree user.email "someone@example.com"
out="$("$script" "$repo" --name "$BOT_NAME" --email "$BOT_EMAIL")"
grep -q 'keeping .*wt-a' <<<"$out" \
  || { echo "FAIL: divergent identity should be reported, got: $out" >&2; exit 1; }
[ "$(git -C "$tmpdir/wt-a" config user.email)" = "someone@example.com" ] \
  || { echo "FAIL: divergent identity was overwritten without --force" >&2; exit 1; }

# --force is the deliberate override.
"$script" "$repo" --name "$BOT_NAME" --email "$BOT_EMAIL" --force >/dev/null
[ "$(git -C "$tmpdir/wt-a" config user.email)" = "$BOT_EMAIL" ] \
  || { echo "FAIL: --force did not overwrite" >&2; exit 1; }

# Environment defaults work, so a host can configure this once.
git -C "$tmpdir/wt-b" config --worktree --unset user.email
git -C "$tmpdir/wt-b" config --worktree --unset user.name
REPO_AGENT_IDENTITY_NAME="$BOT_NAME" REPO_AGENT_IDENTITY_EMAIL="$BOT_EMAIL" \
  "$script" "$repo" >/dev/null
[ "$(git -C "$tmpdir/wt-b" config user.email)" = "$BOT_EMAIL" ] \
  || { echo "FAIL: env defaults were not used" >&2; exit 1; }

# Without an identity it refuses rather than guessing one. `env -u` is
# load-bearing: a configured host exports REPO_AGENT_IDENTITY_* from its shell
# profile, so without it this case inherits a real identity and stops testing
# the refusal it names. CI has no such profile, so the failure only ever
# appears on the machines that actually use the tool.
if env -u REPO_AGENT_IDENTITY_NAME -u REPO_AGENT_IDENTITY_EMAIL \
  "$script" "$repo" >/dev/null 2>"$tmpdir/err"; then
  echo "FAIL: missing identity should exit non-zero" >&2
  exit 1
fi
grep -q 'REPO_AGENT_IDENTITY_NAME' "$tmpdir/err" \
  || { echo "FAIL: error should name the variables" >&2; exit 1; }

# A path that is not a repository is a clear error, not a stack trace.
if "$script" "$tmpdir" --name x --email y >/dev/null 2>"$tmpdir/err2"; then
  echo "FAIL: non-repository should exit non-zero" >&2
  exit 1
fi
grep -q 'not a git repository' "$tmpdir/err2" \
  || { echo "FAIL: error should say it is not a repository" >&2; exit 1; }

echo "adopt-agent-identity: all assertions passed"
