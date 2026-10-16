#!/usr/bin/env bash
# Scan /proc for processes whose cwd is under (or equals) a given path.
set -euo pipefail

target="${1:?usage: repo-scan-live-processes <directory> [--foreign-only]}"
shift
foreign_only=false
if (($#)); then
  [[ $# == 1 && $1 == --foreign-only ]] || {
    echo 'usage: repo-scan-live-processes <directory> [--foreign-only]' >&2
    exit 64
  }
  foreign_only=true
fi
target=$(cd "$target" && pwd -P)
readonly PROC_ROOT=/proc

declare -A ppid_of=() sid_of=() start_of=()
own_root=""
my_sid=""

read_process_identity() {
  local pid=$1 process_stat rest
  identity_ppid=""; identity_sid=""; identity_start=""
  IFS= read -r process_stat 2>/dev/null < "$PROC_ROOT/$pid/stat" || return 1
  [[ ${process_stat%% *} == "$pid" ]] || return 1
  rest=${process_stat##*) }
  # shellcheck disable=SC2086
  set -- $rest # state ppid pgrp session ... starttime (field 22)
  [[ ${2:-} =~ ^(0|[1-9][0-9]{0,9})$ && ${4:-} =~ ^(0|[1-9][0-9]{0,9})$ &&
     ${20:-} =~ ^(0|[1-9][0-9]{0,19})$ ]] || return 1
  identity_ppid=$2; identity_sid=$4; identity_start=${20}
}

identity_matches_snapshot() {
  local pid=$1
  read_process_identity "$pid" || return 1
  [[ -n ${start_of[$pid]:-} && ${ppid_of[$pid]:-} == "$identity_ppid" &&
     ${sid_of[$pid]:-} == "$identity_sid" && ${start_of[$pid]} == "$identity_start" ]]
}

require_self_identity() {
  if [[ -z ${sid_of[$$]:-} ]] || ! identity_matches_snapshot "$$"; then
    echo 'foreign process classification unavailable: caller identity is unverified' >&2
    return 75
  fi
}

if [[ $foreign_only == true ]]; then
  for pid_dir in "$PROC_ROOT"/[0-9]*; do
    pid=${pid_dir##*/}
    read_process_identity "$pid" || continue
    ppid_of[$pid]=$identity_ppid
    sid_of[$pid]=$identity_sid
    start_of[$pid]=$identity_start
  done
  my_sid=${sid_of[$$]:-}
  require_self_identity
  current=$$
  remaining=${#ppid_of[@]}
  while [[ -n $my_sid && $current =~ ^(0|[1-9][0-9]{0,9})$ && $current -gt 1 && $remaining -gt 0 ]]; do
    remaining=$((remaining - 1))
    identity_matches_snapshot "$current" || break
    [[ ${sid_of[$current]:-} == "$my_sid" ]] || break
    cwd=$(readlink "$PROC_ROOT/$current/cwd" 2>/dev/null) || cwd=""
    case "$cwd" in
      "$target" | "$target"/*) own_root=$current ;;
    esac
    parent=${ppid_of[$current]:-}
    [[ -n $parent && $parent != "$current" ]] || break
    current=$parent
  done
fi

is_own_process() {
  local current=$1 parent remaining=${#ppid_of[@]}
  [[ -n $own_root && -n $my_sid ]] || return 1
  while [[ $current =~ ^(0|[1-9][0-9]{0,9})$ && $current -gt 1 && $remaining -gt 0 ]]; do
    remaining=$((remaining - 1))
    # A detached session or missing metadata remains foreign, even when it
    # descends from an ancestor of this caller. Never infer ownership by cwd.
    identity_matches_snapshot "$current" || return 1
    [[ ${sid_of[$current]:-} == "$my_sid" ]] || return 1
    [[ $current != "$own_root" ]] || return 0
    parent=${ppid_of[$current]:-}
    [[ -n $parent && $parent != "$current" ]] || return 1
    current=$parent
  done
  return 1
}

found=0
for pid_dir in "$PROC_ROOT"/[0-9]*; do
  pid="${pid_dir##*/}"
  link=$(readlink "$pid_dir/cwd" 2>/dev/null) || continue
  case "$link" in
    "$target" | "$target"/*) ;;
    *) continue ;;
  esac
  if [[ $foreign_only == true ]] && is_own_process "$pid"; then
    continue
  fi
  if [[ $foreign_only == true ]]; then
    cmd=$(cat "$pid_dir/comm" 2>/dev/null || echo "?")
  else
    cmd=$(tr '\0' ' ' <"$pid_dir/cmdline" 2>/dev/null || echo "?")
  fi
  echo "$pid  $link  $cmd"
  found=1
done

if [[ $foreign_only == true ]]; then
  require_self_identity
fi

if [ "$found" -eq 0 ]; then
  echo "no live processes found under: $target" >&2
fi
