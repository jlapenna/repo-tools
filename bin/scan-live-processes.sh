#!/usr/bin/env bash
# Scan /proc for processes whose cwd is under (or equals) a given path.
set -euo pipefail

target="${1:?usage: repo-scan-live-processes <directory>}"
target=$(cd "$target" && pwd -P)

found=0
for pid_dir in /proc/[0-9]*; do
  pid="${pid_dir#/proc/}"
  link=$(readlink "$pid_dir/cwd" 2>/dev/null) || continue
  case "$link" in
    "$target" | "$target"/*) ;;
    *) continue ;;
  esac
  cmd=$(tr '\0' ' ' <"$pid_dir/cmdline" 2>/dev/null || echo "?")
  echo "$pid  $link  $cmd"
  found=1
done

if [ "$found" -eq 0 ]; then
  echo "no live processes found under: $target" >&2
fi
