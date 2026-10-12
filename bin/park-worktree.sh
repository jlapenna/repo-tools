#!/usr/bin/env bash
# Internal preservation primitive for the sweep's explicit parking modes.
# Keep Git history and non-cache files before invoking the normal safe remover.
set -euo pipefail
[[ -r /proc/$$/stat ]] || { echo 'parking needs Linux process evidence' >&2; exit 75; }
worktree=$1
expected=$2
hook=${3:-}
idle_hours=${4:-0}
here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
source "$here/worktree-idle.sh"
common=$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)
records=$(git --git-dir="$common" worktree list --porcelain)
primary=$(sed -n 's/^worktree //p' <<<"$records" | head -n 1)
branch=$(git -C "$worktree" symbolic-ref --quiet --short HEAD || true)
[[ $worktree != "$primary" && $(git -C "$worktree" rev-parse HEAD) == "$expected" ]] || exit 75
# Nested worktrees have separate ownership and must be handled independently.
while IFS= read -r path; do
  [[ $path != "$worktree/"* ]] || { echo 'nested worktree must be handled first' >&2; exit 75; }
done < <(sed -n 's/^worktree //p' <<<"$records")
submodules=$(git -C "$worktree" submodule status --recursive) || exit 75
if [[ -n $submodules ]] && grep -qv '^-' <<<"$submodules"; then
  echo 'initialized submodule needs its own history archive' >&2; exit 75
fi
check_snapshot() {
  [[ $(git -C "$worktree" rev-parse HEAD) == "$expected" ]] &&
    [[ $(git -C "$worktree" symbolic-ref --quiet --short HEAD || true) == "$branch" ]] &&
    [[ -z $(git -C "$worktree" status --porcelain --untracked-files=all) ]] &&
    [[ -z $("$here/scan-live-processes.sh" "$worktree") ]] &&
    cleanup_worktree_idle "$worktree" "$branch" "$idle_hours" >/dev/null
}
check_snapshot || exit 75

# Archive private local inputs too, including ignored .env files. Only known
# reinstallable dependencies/caches may be omitted, and only when Git confirms
# they are ignored and have no tracked contents. Do not follow symlinks.
umask 077
root="$common/parked-worktrees"
[[ ! -L $root ]] || { echo 'archive root must not be a symlink' >&2; exit 1; }
mkdir -p "$root"
[[ -O $root ]] || { echo 'archive root must be owned by the caller' >&2; exit 1; }
chmod 700 "$root"
archive=$(mktemp -d "$root/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
id=${archive##*/}
ref="refs/parked-worktrees/$id"
printf './.git\n' > "$archive/excludes"
while IFS= read -r -d '' path; do
  path=${path%/}
  case ${path##*/} in node_modules|.nx|.next|.venv|__pycache__|.turbo) ;; *) continue ;; esac
  [[ ! -L $worktree/$path && -d $worktree/$path && $path != *$'\n'* ]] || continue
  git -C "$worktree" check-ignore -q -- "$path" || continue
  [[ -z $(git -C "$worktree" ls-files -- "$path") ]] || continue
  printf './%s\n' "$path" >> "$archive/excludes"
done < <(git -C "$worktree" ls-files --others --ignored --exclude-standard --directory -z)
tar --no-wildcards --exclude-from="$archive/excludes" -czf "$archive/files.tar.gz" -C "$worktree" .
# Verify every retained file against the archive before any removal. Changes
# during archival, including ignored-file changes, fail closed.
tar -dzf "$archive/files.tar.gz" -C "$worktree" >/dev/null
check_snapshot || { echo "snapshot changed; preserved archive: $archive" >&2; exit 75; }
git -C "$primary" update-ref "$ref" "$expected" ""
checksum=$(sha256sum "$archive/files.tar.gz" | cut -d ' ' -f 1)
jq -n --arg primary "$primary" --arg common "$common" --arg path "$worktree" \
  --arg branch "$branch" --arg head "$expected" --arg ref "$ref" \
  --arg checksum "$checksum" --rawfile excludes "$archive/excludes" \
  '{version:1,primary:$primary,common:$common,path:$path,branch:$branch,head:$head,
    ref:$ref,checksum:$checksum,excludedCaches:($excludes|split("\n")|map(select(.!="" and .!="./.git"))),
    state:"prepared"}' > "$archive/manifest.json"
# Capture complete restoration instructions privately before the remover runs.
printf 'repo-restore-worktree %q\n' "$archive" > "$archive/restore.sh"
check_snapshot || exit 75
if [[ -n $hook ]]; then
  # The consumer calls this guard while holding its resource lock. Recompare
  # ignored local inputs at that point, not before waiting for the lock.
  guard="$archive/remove-snapshot.sh"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'worktree=%q\nexpected=%q\nbranch=%q\nidle_hours=%q\nhere=%q\narchive=%q\n' \
      "$worktree" "$expected" "$branch" "$idle_hours" "$here" "$archive"
    printf 'source "$here/worktree-idle.sh"\n'
    declare -f check_snapshot
    printf '%s\n' \
      '[[ ${1:-} == "$worktree" ]] || exit 75' \
      'tar -dzf "$archive/files.tar.gz" -C "$worktree" >/dev/null || { echo "snapshot changed under resource lock" >&2; exit 75; }' \
      'check_snapshot || exit 75' \
      'exec "$here/safe-remove-worktree.sh" "$@"'
  } > "$guard"
  chmod 700 "$guard"
  status=0
  "$hook" "$worktree" "$guard" || status=$?
  if (( status != 0 )); then
    # A documented refusal leaves the checkout intact. Do not accumulate a
    # new backup and protected ref on every retry. Keep evidence on partial
    # removals or other errors, where the backup may be the only copy.
    if (( status == 75 )) && [[ -d $worktree && -e $worktree/.git ]] &&
      [[ $(git -C "$worktree" rev-parse HEAD) == "$expected" ]] &&
      git --git-dir="$common" worktree list --porcelain | grep -Fqx "worktree $worktree"; then
      git -C "$primary" update-ref -d "$ref" "$expected"
      rm -rf -- "$archive"
    else
      echo "removal failed; archive retained: $archive" >&2
    fi
    exit "$status"
  fi
else
  "$here/safe-remove-worktree.sh" "$worktree"
fi
[[ ! -e $worktree ]] || { echo "removal refused; archive retained: $archive" >&2; exit 1; }
jq '.state="parked"' "$archive/manifest.json" > "$archive/manifest.tmp"
mv "$archive/manifest.tmp" "$archive/manifest.json"
printf '%s\n' "$archive"
