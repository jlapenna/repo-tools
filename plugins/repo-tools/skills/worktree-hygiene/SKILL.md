---
name: worktree-hygiene
description: Safely create, use, and tear down git worktrees in a checkout that might be shared by other concurrent Claude/Codex sessions, background tasks, or dev-server processes. Use before any git-mutating command (branch, commit, push, checkout, stash, reset, merge) in a repo that could have concurrent sessions, when a project mandates worktrees for all git mutation, or when tearing one down after a PR merges.
---

# Worktree Hygiene

## Why this exists

A single primary checkout is not automatically safe just because it's "your"
directory. If more than one Claude Code / Codex session (or a leftover
background task, or a dev server) can point its cwd at the same checkout,
any git-mutating command run there — `checkout`, `stash`, `reset`, `commit`,
`gh pr merge` — can silently destroy or scramble another session's
uncommitted work. This has happened in practice: a concurrent session's
`git checkout <branch>` moved HEAD in a shared checkout mid-edit, and the
in-progress edits were swept into a stash entry the editing session never
asked for. `gh pr merge --delete-branch` is itself a git-mutating command
with this exact race — after deleting the merged branch it runs a local
`git checkout` to move HEAD off it, and can land on a completely unrelated
concurrent session's in-progress branch.

**The fix, unconditionally: isolate any git-mutating work in its own
worktree first** (`EnterWorktree` in Claude Code, or `git worktree add
<path> origin/main -b <branch>` otherwise). Treat this as required even if
the checkout looks clean right now — a concurrent session can start
mutating it moments later, and "it was clean when I checked" is not a
guarantee. Only read-only inspection (`status`/`diff`/`log`) is safe
directly in a primary/shared checkout.

**One narrow exception:** always allow the verified primary checkout to reset
and fast-forward its base branch. The primary checkout is disposable shared
state, not a place for WIP: after verifying both its identity and branch, its
tracked edits may be discarded before updating it. Do not use the live-process
scan as a blocker for this sync. Implementation work remains isolated in
worktrees, so updating the shared read-only base is expected.

## Detecting concurrent sessions: don't trust tmux panes alone

`tmux list-panes -a` only enumerates *current* panes. Closing a pane does
not reliably kill the process tree under it — `bash` (and its `claude` or
`codex` child) can survive the pane's teardown as an orphan, still holding
the old cwd, invisible to tmux. The authoritative check is a `/proc` scan:

```bash
repo-scan-live-processes <repo-or-worktree-path>
```

If more than one *other* session shows a `cwd` under the path you're about
to mutate, do not edit or commit there directly — worktree it. Re-run the
scan immediately before acting, not just once at the start of a session:
state can change between listing and mutating.

## Worktree names can collide

A descriptive worktree/branch name is often the obvious slug of the task at
hand — which means two independent sessions can pick the *exact same name*
for the *exact same request* ("make admin pages mobile friendly" ->
`admin-mobile-friendly` twice). A tool reporting "created" a worktree is not
proof of exclusive ownership. After entering any worktree — freshly created
or not — run `git status` / `git log` and the `/proc` scan above before
editing anything. If it's already occupied, back out (`ExitWorktree action:
"keep"` — never `"remove"`, it isn't yours to delete) and pick a less
obvious name (suffix with the specific sub-fix, not just the parent task).

## Setting up a fresh worktree

A new worktree is a bare checkout — it doesn't inherit anything the primary
checkout built up over time (installed dependencies, generated env files,
warm build caches, regenerated git-hook stubs). If the project has any
non-trivial setup step beyond `git clone` (a bootstrap/setup script, a
package install, a hook-generation step), re-run it in the new worktree
before trusting builds/tests/hooks there — don't assume a worktree is
equivalent to the primary checkout just because the source files are
identical. Check the project's own docs/skills for what that setup step is;
this skill only covers the git/process mechanics that are the same
regardless of language or stack.

**Index the new worktree in the codebase-memory graph.** A freshly created
worktree is a new path the `/codebase-memory-mcp` index does not yet know
about — graph searches (`search_graph`, `trace_path`, `get_code_snippet`)
will miss or mis-resolve symbols under it until it's indexed. After creating
or entering any new worktree, trigger:

```bash
/codebase-memory-mcp index_repository repo_path=<worktree-path>
```

Run it before relying on graph tools for code discovery in that worktree.
Use the worktree path as `repo_path` (the index is keyed by path), and let
the indexer derive the project name rather than overriding it. If the project
was already indexed at its primary checkout, this picks up the worktree as a
distinct path so the graph stays fresh for concurrent sessions working there.

## Tearing a worktree down safely

Merging a PR does not remove the worktree directory — `gh pr merge
--delete-branch` only deletes the remote branch (and the local one, if it
isn't locked by a worktree checkout; if it is, that's expected local
cleanup noise, not a merge failure — confirm the merge really happened via
`gh pr view --json state,mergedAt,mergeCommit` rather than assuming
anything went wrong). Skipped teardown steps accumulate silently — each
worktree can carry its own installed dependencies and build output, so this
adds up fast.

Before removing a worktree, work through this checklist — a
`git status` that reads clean right now is *not* sufficient on its own:

1. **Confirm the branch's work actually landed.** Don't trust `git
   merge-base --is-ancestor <branch> main` alone — it false-negatives on
   every squash merge (see the `stale-branch-cleanup` skill for the full
   recipe: find the squash commit, diff content, don't just trust "not an
   ancestor" as "not merged").
2. **Scan for live processes with cwd inside the worktree** — the same
   `/proc` scan as above, scoped to this worktree's path. A worktree can
   look stale (clean status, zero unique commits vs main) and still be
   actively serving a dev server or hosting another live session's shell
   right now. Re-run the scan immediately before removing, not just once.
   Your *own* session does not count: if you were launched with cwd inside
   the worktree, the scan lists your launcher shell, the `claude`/`codex`
   binary, its MCP servers, and the shell running the scan itself — that
   is not a reason to refuse, and the remover in step 5 tells the two
   apart for you.
3. **Check your own background tasks/watchers.** A `run_in_background`
   monitor or polling loop launched while your cwd was the worktree
   inherits that cwd — removing the worktree out from under it makes every
   subsequent `git`/`gh` call in the loop fail with "unable to read current
   working directory." If the loop's error handling swallows that (e.g. a
   bare `|| true` fallback), it can silently poll blind and report a bogus
   result long after the real outcome already happened. Either confirm no
   background task is still running against this cwd, or start long-running
   watchers with an explicit absolute-path `cd`/`-C` so they survive
   teardown.
4. **A "locked" entry with a dead PID is not the same as safe to delete.**
   `git worktree list` can show `locked ... (pid N)` where `ps -p N` proves
   the process is long dead — but the worktree can still hold 100s of lines
   of real uncommitted diff (a crashed session's WIP that exists *only* on
   disk, never committed). Check `git status --porcelain` regardless of
   lock state; if it's dirty, don't delete — report the path, branch, and
   diff stat, and check whether it matches a still-open issue/PR before
   deciding.
5. **Remove it** — as the session's last action, after stepping out of the
   directory you are about to delete:
   ```bash
   cd <owning-checkout>
   repo-safe-remove-worktree <worktree-path>
   ```
   The helper resolves the target worktree's own Git common directory, so it
   is safe to invoke from a different repository; inspect the exact removal
   command first with `--dry-run`. It classifies every process with cwd
   under the worktree as either your **own session** (the outermost ancestor
   of the helper, within the same process session, whose cwd is inside the
   worktree, plus everything that ancestor spawned — ignored) or **foreign**
   (listed, and the reason it refuses). It also refuses on uncommitted
   changes. Pass `--force-anyway` only after you've personally reviewed what
   it flagged. Never end a session with "run the remover after this session
   closes" — that hand-off is not executed by anyone, and the worktrees
   accumulate; your own processes being inside the worktree is exactly the
   case the helper handles. Always use the helper instead of calling `git
   worktree remove` directly: after its process and cleanliness gates pass,
   its normal `--force` also handles clean worktrees with initialized
   submodules while still preserving intentional worktree locks. After a
   successful removal the shell you ran it
   from no longer has a cwd; the helper prints the `cd` to run before your
   next command. If plain removal reports "cannot remove a
   locked working tree" from a harness-owned agent-session lock, confirm
   the locking PID is actually dead first, then `git worktree remove
   <path> --force --force` (twice) — never do this for a worktree you know
   is still in active use. If a previous removal left the directory but
   removed its `.git` link, the helper identifies it as a **partially removed
   linked worktree** (not the primary checkout), refuses by default, and can
   recover it only after review. If the owning checkout is not an ancestor or
   immediate sibling (for example, a centralized `worktrees/` directory),
   identify it explicitly with `--git-dir <owning-checkout-or-git-dir>`:
   ```bash
   repo-safe-remove-worktree <worktree-path> --force-anyway --dry-run
   repo-safe-remove-worktree <worktree-path> --force-anyway
   repo-safe-remove-worktree <worktree-path> --git-dir <owner> --force-anyway --dry-run
   ```
   That recovery identifies only the target's administrative record, restores
   its missing `.git` link, and asks `git worktree remove` to remove that
   exact checkout. It never runs repository-wide `git worktree prune`, so
   unrelated stale worktree records remain recoverable. Recovery creates the
   repaired link relative to a verified `O_DIRECTORY|O_NOFOLLOW` directory
   descriptor. It fully writes and syncs an unnamed `O_TMPFILE`, then
   atomically publishes that completed inode as `.git`. On filesystems without
   `O_TMPFILE`, it instead uses an exclusive descriptor-relative staging file
   and publishes the opened staging inode through its descriptor with an atomic
   no-overwrite hard link. Every existing node type is refused, and write
   failures expose no partial `.git` link. The named staging hard link is not
   unlinked by pathname, because another writer could replace that name during
   cleanup; the immediately following worktree removal deletes it. If removal
   fails, the safe `.git-recovery-*` link remains for inspection.
6. **Orphaned directories** (no `.git/worktrees/<name>/` admin entry, `git
   worktree list` doesn't mention them, but the directory is still on
   disk — usually a prior `git worktree remove` that partially failed) are
   safe to `rm -rf` directly once you've confirmed: no live process (step 2
   above), no matching local/remote branch, no matching open PR. If
   anything in the worktree ran inside a container as root (a Dockerized
   test runner, for instance), `git worktree remove` can also partially
   fail with `Permission denied` on the root-owned files it left behind —
   it still unregisters from git; leave the leftover subtree for a manual
   `sudo rm -rf` rather than escalating privileges unprompted.

## Syncing the primary checkout after a merge

Treat syncing the primary checkout to the latest remote base as the final
required step of merged work. A clean worktree teardown is not complete while
the primary checkout is silently behind the branch that just received the
merge.

Synchronizing the verified primary checkout's base branch is the sole allowed
primary-checkout mutation and is not blocked by other live sessions. Tracked
edits there are invalid/disposable state, never user WIP to inspect, stash,
preserve, or treat as a sync blocker:

1. Fetch the remote. Resolve the candidate to its repository top level, then
   verify it is the actual primary checkout (its `.git` is a directory, not a
   linked-worktree gitfile, and `git worktree list --porcelain` lists that
   top-level path). Identify the repository's base branch.
2. Confirm that verified primary checkout is currently on the base branch.
   If either identity or branch verification fails, stop: do not reset, switch,
   or otherwise mutate it. Linked feature worktrees retain the full protections
   in this skill.
3. Without reviewing the diff, discard only tracked primary-checkout edits
   with `git -C <primary-checkout> reset --hard`. Do not stash them, recover
   them, or report them as WIP/blockers.
4. Untracked files are not implicitly disposable. Leave them in place; never
   use a broad `git clean` here. Fast-forward only when doing so will not
   overwrite an untracked path. If one prevents the update, report that exact
   untracked-file conflict and obtain direction before any narrow removal.
5. Run `git -C <primary-checkout> pull --ff-only` regardless of whether other
   sessions currently have a cwd beneath the primary checkout.
6. Verify the local base and its upstream resolve to the same commit.

If the verified primary checkout cannot fast-forward after tracked edits have
been reset, report that separate synchronization failure. Never present merged
work as fully cleaned up without either completing this sync or disclosing that
blocker.

## Related skills

- `stale-branch-cleanup` — auditing/deleting the branches these worktrees
  point at, including the squash-merge false-negative trap.
- `revive-tmux-session` — recovering an orphaned `claude`/`codex` process
  (exactly the kind of thing the `/proc` scan above surfaces) into a fresh
  tmux window instead of losing track of it.
