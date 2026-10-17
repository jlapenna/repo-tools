#!/usr/bin/env bash
# Restore a locally parked checkout; dependencies and caches can be reinstalled.
set -euo pipefail
usage() { echo 'Usage: repo-restore-worktree <archive-directory> [--path <new-path>]' >&2; }
[[ $# -gt 0 ]] || { usage; exit 64; }
archive=$(realpath -e -- "$1"); shift
target=""
while (($#)); do
  case $1 in
    --path) [[ $# -ge 2 ]] || { usage; exit 64; }; target=$2; shift ;;
    *) usage; exit 64 ;;
  esac
  shift
done
manifest="$archive/manifest.json"
if [[ $(jq -r .version "$manifest") == 2 || $(jq -r .version "$manifest") == 3 || $(jq -r .version "$manifest") == 4 ]]; then
  here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
  exec python3 "$here/created-worktree.py" restore "$archive" "$target"
fi
jq -e '.version==1 and (.head|test("^[0-9a-f]{40}$")) and
  (.ref|startswith("refs/parked-worktrees/")) and
  (.checksum|test("^[0-9a-f]{64}$")) and (.state=="parked" or .state=="prepared")' \
  "$manifest" >/dev/null
primary=$(jq -r .primary "$manifest")
common=$(jq -r .common "$manifest")
head=$(jq -r .head "$manifest")
ref=$(jq -r .ref "$manifest")
branch=$(jq -r .branch "$manifest")
[[ -n $target ]] || target=$(jq -r .path "$manifest")
target=$(realpath -m -- "$target")
[[ ! -e $target && ! -L $target ]] || { echo "restore path already exists: $target" >&2; exit 1; }
[[ $(git -C "$primary" rev-parse --path-format=absolute --git-common-dir) == "$common" ]] ||
  { echo 'owning repository changed' >&2; exit 1; }
[[ $(git -C "$primary" rev-parse --verify "$ref") == "$head" ]] ||
  { echo 'preserved Git ref changed or is missing' >&2; exit 1; }
[[ $(sha256sum "$archive/files.tar.gz" | cut -d ' ' -f 1) == "$(jq -r .checksum "$manifest")" ]] ||
  { echo 'archive checksum mismatch' >&2; exit 1; }
# Archives must not overwrite Git administration or escape the new checkout.
tar -tzf "$archive/files.tar.gz" | awk '
  /^\/|(^|\/)\.\.(\/|$)|^(\.\/)?\.git(\/|$)/ { bad=1 }
  END { exit bad }' || { echo 'unsafe archive member path' >&2; exit 1; }
if [[ -n $branch ]] && [[ $(git -C "$primary" rev-parse --verify "refs/heads/$branch" 2>/dev/null || true) == "$head" ]] &&
  ! git -C "$primary" worktree list --porcelain | grep -Fqx "branch refs/heads/$branch"; then
  git -C "$primary" worktree add -- "$target" "$branch"
else
  # Do not reset a branch that moved while parked.
  git -C "$primary" worktree add --detach -- "$target" "$ref"
fi
tar -xzf "$archive/files.tar.gz" --no-same-owner -C "$target"
printf 'RESTORED\t%s\t%s\n' "$target" "$head"
echo 'Reinstall dependencies/caches with the repository worktree setup command.' >&2
