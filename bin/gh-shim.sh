#!/usr/bin/env bash
# Run `gh` as a GitHub App bot when an agent session is driving it.
#
# `repo-github-app-token` makes a bot token available, but a token nobody uses
# changes nothing: an agent has to remember to pass it on every single call,
# and relying on that is what put the wrong name on the work in the first
# place. This removes the remembering. Put it ahead of the real `gh` on PATH
# and agent sessions authenticate as the App without cooperating; humans are
# unaffected, because the identity only applies when an agent session
# variable is present.
#
# Opt in per host, e.g.:
#   ln -s "$(command -v repo-gh-shim)" ~/.local/bin/gh
#
# Environment:
#   REPO_GH_IDENTITY=off       passthrough; never substitute an identity
#   REPO_GH_IDENTITY=optional  fall back to the caller's own credentials when
#                              minting fails, instead of refusing
#   REPO_AGENT_SESSION_VARS    space-separated names whose presence marks an
#                              agent session (default: CLAUDE_CODE_SESSION_ID
#                              CODEX_THREAD_ID)
set -euo pipefail

# A package manager may install this command as a *wrapper script* rather than
# a symlink (pnpm does), so $0 is the file in the package store while the PATH
# entry that led here is a different path entirely. Path comparison alone
# therefore cannot always recognise this shim in PATH, and picking itself as
# "the real gh" makes exec replace the process with itself forever: one pid,
# spinning, indistinguishable from a hang. This guard makes that impossible to
# reach regardless of how the command was installed.
if [ -n "${REPO_GH_SHIM_GUARD:-}" ]; then
  cat >&2 <<'MSG'
repo-gh-shim: refusing to re-enter itself.

The `gh` found on PATH behind this shim is the shim again, so running it would
loop forever. Point the shim at a PATH that also contains the real gh, or
remove whatever alias or link makes `gh` resolve back here.
MSG
  exit 1
fi

self="$0"
hops=0
while [ -L "$self" ]; do
  hops=$((hops + 1))
  # Cap at the kernel's own symlink limit so a cycle cannot hang the shim.
  [ "$hops" -gt 40 ] && break
  link=$(readlink "$self")
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
self_real="$(cd "$(dirname "$self")" && pwd -P)/$(basename "$self")"

# Find the real gh: the first PATH entry holding an executable `gh` that is not
# this shim. Comparing resolved paths matters because the shim is normally
# reached through a symlink named `gh`.
find_real_gh() {
  local dir candidate resolved
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || dir=.
    candidate="$dir/gh"
    [ -x "$candidate" ] && [ ! -d "$candidate" ] || continue
    resolved="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
    [ "$resolved" = "$self_real" ] && continue
    # A symlink named gh that points at this shim is still this shim.
    if [ -L "$candidate" ]; then
      local target
      target="$(readlink -f "$candidate" 2>/dev/null || true)"
      [ "$target" = "$self_real" ] && continue
      # ...and a symlink to a wrapper script that runs this shim is too. The
      # wrapper names the file it runs, so the name is what identifies it;
      # comparing paths cannot, because the wrapper and its target differ.
      if [ -n "$target" ] && head -c 4096 "$target" 2>/dev/null | grep -q 'gh-shim'; then
        continue
      fi
    fi
    # The same wrapper reached directly rather than through a symlink.
    if head -c 4096 "$candidate" 2>/dev/null | grep -q 'gh-shim'; then
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

real_gh="$(find_real_gh || true)"
if [ -z "$real_gh" ]; then
  echo "repo-gh-shim: no real 'gh' found on PATH behind this shim" >&2
  exit 127
fi

passthrough() { REPO_GH_SHIM_GUARD=1 exec "$real_gh" "$@"; }

[ "${REPO_GH_IDENTITY:-}" = "off" ] && passthrough "$@"

# An explicit token from the caller always wins. Substituting one here would
# silently override a deliberate choice, including this shim's own re-exec.
[ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && passthrough "$@"

session_vars="${REPO_AGENT_SESSION_VARS:-CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID}"
in_agent_session=0
for var in $session_vars; do
  # Indirect expansion: test the named variable, not the name.
  [ -n "${!var:-}" ] && in_agent_session=1 && break
done
[ "$in_agent_session" = 0 ] && passthrough "$@"

# The token is scoped to one repository, so honour an explicit --repo/-R rather
# than minting for whatever directory the agent happens to be standing in.
repo=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -R | --repo) repo="$arg" ;;
  esac
  case "$arg" in
    --repo=*) repo="${arg#--repo=}" ;;
    -R=*) repo="${arg#-R=}" ;;
  esac
  prev="$arg"
done

token=""
if [ -n "$repo" ]; then
  token="$(repo-github-app-token --repo "$repo" 2>/dev/null || true)"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  token="$(repo-github-app-token 2>/dev/null || true)"
else
  # No repository in play at all (`gh auth status`, `gh api /user`). There is
  # nothing to scope a token to, and these are not the writes that get
  # misattributed, so let them through untouched.
  passthrough "$@"
fi

if [ -z "$token" ]; then
  if [ "${REPO_GH_IDENTITY:-}" = "optional" ]; then
    passthrough "$@"
  fi
  cat >&2 <<'MSG'
repo-gh-shim: could not mint a GitHub App token for this agent session.

Refusing rather than falling back to your own credentials, because silently
writing under a human's name is the failure this shim exists to prevent.

  - run `repo-github-app-token` directly to see why it failed
  - set REPO_GH_IDENTITY=optional to allow the fallback
  - set REPO_GH_IDENTITY=off to disable the shim entirely
MSG
  exit 1
fi

GH_TOKEN="$token" REPO_GH_SHIM_GUARD=1 exec "$real_gh" "$@"
