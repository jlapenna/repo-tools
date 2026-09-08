#!/usr/bin/env bash
# Give existing linked worktrees the agent commit identity.
#
# Setting the identity when a worktree is created only helps worktrees created
# afterwards. A busy checkout accumulates dozens of live ones, and every one of
# them keeps authoring commits as the human until something goes back and fixes
# them. This is that something.
#
# The primary checkout is never touched: it is the human's, and the whole
# separation depends on it staying that way.
#
# Usage:
#   repo-adopt-agent-identity [<repo-path>] [--name <name>] [--email <email>]
#                             [--dry-run] [--force]
#
# Defaults come from REPO_AGENT_IDENTITY_NAME and REPO_AGENT_IDENTITY_EMAIL.
# Worktrees that already carry their own identity are left alone unless
# --force is given.
set -euo pipefail

repo_path=""
name="${REPO_AGENT_IDENTITY_NAME:-}"
email="${REPO_AGENT_IDENTITY_EMAIL:-}"
dry_run=0
force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      name="${2:?--name needs a value}"
      shift 2
      ;;
    --email)
      email="${2:?--email needs a value}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "repo-adopt-agent-identity: unknown option: $1" >&2
      exit 1
      ;;
    *)
      repo_path="$1"
      shift
      ;;
  esac
done

if [ -z "$name" ] || [ -z "$email" ]; then
  echo "repo-adopt-agent-identity: set --name/--email or REPO_AGENT_IDENTITY_NAME/REPO_AGENT_IDENTITY_EMAIL" >&2
  exit 1
fi

repo_path="${repo_path:-$PWD}"
if ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
  echo "repo-adopt-agent-identity: not a git repository: $repo_path" >&2
  exit 1
fi

# The main worktree is the first entry `git worktree list` prints; everything
# after it is linked. Resolving it explicitly is what keeps the human's
# checkout out of the loop below.
main_worktree="$(dirname "$(git -C "$repo_path" rev-parse --path-format=absolute --git-common-dir)")"
main_worktree="$(cd "$main_worktree" && pwd -P)"

# Worktree-scoped config is inert until the extension is on, and enabling it is
# a property of the repository rather than of any one worktree.
if [ "$dry_run" = 0 ]; then
  git -C "$repo_path" config extensions.worktreeConfig true
fi

adopted=0
skipped=0
while IFS= read -r line; do
  case "$line" in
    worktree\ *) ;;
    *) continue ;;
  esac
  wt="${line#worktree }"
  [ -d "$wt" ] || continue
  wt="$(cd "$wt" && pwd -P)"
  [ "$wt" = "$main_worktree" ] && continue

  existing="$(git -C "$wt" config --worktree --get user.email 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$force" = 0 ]; then
    if [ "$existing" = "$email" ]; then
      skipped=$((skipped + 1))
    else
      echo "keeping   $wt (already $existing)"
      skipped=$((skipped + 1))
    fi
    continue
  fi

  if [ "$dry_run" = 1 ]; then
    echo "would set $wt"
  else
    git -C "$wt" config --worktree user.name "$name"
    git -C "$wt" config --worktree user.email "$email"
    echo "set       $wt"
  fi
  adopted=$((adopted + 1))
done < <(git -C "$repo_path" worktree list --porcelain)

if [ "$dry_run" = 1 ]; then
  echo "repo-adopt-agent-identity: would adopt $adopted, leave $skipped (dry run)"
else
  echo "repo-adopt-agent-identity: adopted $adopted, left $skipped"
fi
