#!/usr/bin/env bash
# Set a stable tmux task title from a Codex UserPromptSubmit hook payload.
#
# The helper deliberately assigns only an empty @user_title. A user or agent
# can still pin a more precise title, and later follow-up prompts do not make
# a window's label churn.
set -euo pipefail

tmux_bin="${TMUX_BIN:-tmux}"

if [ -z "${TMUX:-}" ] || [ -z "${TMUX_PANE:-}" ]; then
  exit 0
fi

input="$(cat)"
current="$("$tmux_bin" show-window-options -v -t "$TMUX_PANE" @user_title 2>/dev/null || true)"

if [ -n "$current" ]; then
  exit 0
fi

title="$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//' | cut -c1-52)"

if [ -z "$title" ]; then
  exit 0
fi

"$tmux_bin" set-window-option -t "$TMUX_PANE" @user_title "$title"
"$tmux_bin" set-window-option -t "$TMUX_PANE" automatic-rename on
