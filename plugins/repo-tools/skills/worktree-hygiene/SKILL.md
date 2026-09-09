---
name: worktree-hygiene
description: Safely create, use, and tear down git worktrees in a checkout that might be shared by other concurrent Claude/Codex sessions, background tasks, or dev-server processes. Use before any git-mutating command (branch, commit, push, checkout, stash, reset, merge) in a repo that could have concurrent sessions, when a project mandates worktrees for all git mutation, or when tearing one down after a PR merges.
---

# Worktree Hygiene

Apply the user's task constraints first, including requests to work from local
source without fetching. Homegit-managed files use the explicit workflow in
the `homegit` skill; do not create a linked worktree for ordinary destination
edits and captures. The rules below govern normal repository implementation.

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

**Primary synchronization is a narrow exception.** A verified, clean primary
checkout on its base branch may fast-forward without blocking on other
sessions merely having that cwd. Resetting tracked drift requires existing
user authorization for that exact primary/base and compatibility with the
repository's rules; it is not an unconditional cleanup step. Never extend the
exception to feature worktrees or untracked files.

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

**If using codebase-memory graph tools, index the new worktree first.** A freshly created
worktree is a new path the `/codebase-memory-mcp` index does not yet know
about — graph searches (`search_graph`, `trace_path`, `get_code_snippet`)
will miss or mis-resolve symbols under it until it's indexed. After creating
or entering any new worktree, trigger:

```bash
/codebase-memory-mcp index_repository repo_path=<worktree-path>
```

Run it before relying on graph tools for code discovery in that worktree.
If that integration is unavailable or unnecessary, use ordinary file search;
indexing is not a prerequisite for editing, testing, or delivery.
Use the worktree path as `repo_path` (the index is keyed by path), and let
the indexer derive the project name rather than overriding it. If the project
was already indexed at its primary checkout, this picks up the worktree as a
distinct path so the graph stays fresh for concurrent sessions working there.

## Tearing a worktree down safely

Use the shared evidence checker rather than reconstructing merge proof in shell.
From outside the target worktree:

```bash
repo-sweep-worktrees --repo <primary> --path <worktree> --base origin/main
repo-sweep-worktrees --repo <primary> --path <worktree> --base origin/main --delete
```

The report is TSV: verdict, path, branch, reason. The command combines paginated
open-PR ownership, exact merged-head/ancestor evidence, cleanliness, and live
process checks. Apply rechecks ownership and HEAD, delegates removal to
`repo-safe-remove-worktree`, and compare-and-deletes only the audited local
branch tip. Missing GitHub evidence is KEEP, not permission. No fetch is implicit;
refresh the base only when the user's task permits it.

Use `--path` for task-scoped cleanup. Omitting it audits every linked worktree;
a repository-wide `--delete` requires that broader cleanup scope. A dry run never
removes anything. Stop task-owned background watchers before cleanup, and do not
kill another session to turn KEEP into SAFE.

Standalone local/remote branches use `repo-audit-branches`; its `--delete`
and `--delete-remote` flags are independent. Remote removal binds the push to the
audited SHA and runs hooks. A closed PR, gone upstream, or timestamp is not proof
that unmerged work may be discarded.

Explicit abandonment of your own unmerged work is a separate user-authorized
operation, not "merged" cleanup. Inspect its exact content and scope, then use
`repo-safe-remove-worktree <path> --dry-run` before removal. Never override a dirty,
locked, occupied, or partially removed worktree merely to finish a checklist.
Preserve disputed work and report the specific blocker.
## Syncing the primary checkout after a merge

Treat syncing the primary checkout to the latest remote base as the final
required step of merged work. A clean worktree teardown is not complete while
the primary checkout is silently behind the branch that just received the
merge.

Synchronizing the verified primary checkout's base branch is not blocked
merely by another session's cwd. Respect explicit user limits on fetching or
resetting and repository-specific deployment-source rules:

1. Fetch the remote. Resolve the candidate to its repository top level, then
   verify it is the actual primary checkout (its `.git` is a directory, not a
   linked-worktree gitfile, and `git worktree list --porcelain` lists that
   top-level path). Identify the repository's base branch.
2. Confirm that verified primary checkout is currently on the base branch.
   If either identity or branch verification fails, stop: do not reset, switch,
   or otherwise mutate it. Linked feature worktrees retain the full protections
   in this skill.
3. If tracked drift exists, inspect its scope. Reset it only when the user's
   existing authorization and applicable repository policy permit restoring
   this verified primary/base. Otherwise preserve it and report why sync
   could not finish; do not silently stash or discard it.
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
