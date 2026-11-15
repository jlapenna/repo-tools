#!/bin/sh
# Fail-open POSIX launcher for repo-autonomous-work-hook.mjs.
# Daemon-spawned non-interactive shells on fnm/nvm/Homebrew hosts frequently
# omit user-managed Node directories from PATH; resolve node across standard
# locations and emit an empty JSON object (exit 0) if unavailable.

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      printf 'usage: run-autonomous-work-hook.sh [--harness claude|codex|opencode|antigravity]\n'
      exit 0
      ;;
  esac
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || {
  printf '{}\n'
  exit 0
}
hook_mjs="$script_dir/repo-autonomous-work-hook.mjs"
if [ ! -f "$hook_mjs" ]; then
  printf '{}\n'
  exit 0
fi

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "${HOME:-}/.local/share/fnm/aliases/default/bin/node" \
    "${HOME:-}/.nvm/current/bin/node" \
    "${HOME:-}/.volta/bin/node" \
    "${HOME:-}/.asdf/shims/node" \
    "${HOME:-}/.mise/shims/node" \
    "${HOME:-}/.local/share/mise/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if [ -d "${HOME:-}/.local/share/fnm/node-versions" ]; then
    latest_fnm=""
    for candidate in "${HOME}"/.local/share/fnm/node-versions/*/installation/bin/node; do
      if [ -x "$candidate" ]; then
        latest_fnm="$candidate"
      fi
    done
    if [ -n "$latest_fnm" ]; then
      printf '%s\n' "$latest_fnm"
      return 0
    fi
  fi
  return 1
}

node_bin=$(find_node) || {
  printf '{}\n'
  exit 0
}

out=$("$node_bin" "$hook_mjs" "$@" 2>/dev/null) || {
  printf '{}\n'
  exit 0
}

case "$out" in
  \{*\}) printf '%s\n' "$out" ;;
  *) printf '{}\n' ;;
esac
exit 0
