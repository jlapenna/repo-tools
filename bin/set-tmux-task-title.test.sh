#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$ROOT/bin/set-tmux-task-title.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mock_tmux="$tmpdir/tmux"
calls="$tmpdir/calls"
cat >"$mock_tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TMUX_TEST_CALLS"
if [ "$1" = show-window-options ]; then
  printf '%s' "${TMUX_TEST_CURRENT:-}"
fi
EOF
chmod +x "$mock_tmux"

TMUX=socket TMUX_PANE=%42 TMUX_BIN="$mock_tmux" TMUX_TEST_CALLS="$calls" \
  "$script" <<'EOF'
{"prompt":"  1234 Fix   flaky\n title assignment  "}
EOF

grep -Fx 'show-window-options -v -t %42 @user_title' "$calls"
grep -Fx 'set-window-option -t %42 @user_title 1234 Fix flaky title assignment' "$calls"
grep -Fx 'set-window-option -t %42 automatic-rename on' "$calls"

: >"$calls"
TMUX=socket TMUX_PANE=%42 TMUX_BIN="$mock_tmux" TMUX_TEST_CALLS="$calls" \
  "$script" <<'EOF'
{"prompt":"Please fix #2468: title helper formatting"}
EOF

grep -Fx 'set-window-option -t %42 @user_title 2468 title helper formatting' "$calls"

: >"$calls"
TMUX=socket TMUX_PANE=%42 TMUX_BIN="$mock_tmux" TMUX_TEST_CALLS="$calls" TMUX_TEST_CURRENT='existing task' \
  "$script" <<'EOF'
{"prompt":"This must not replace the pinned title"}
EOF

test "$(wc -l <"$calls")" -eq 1
grep -Fx 'show-window-options -v -t %42 @user_title' "$calls"
