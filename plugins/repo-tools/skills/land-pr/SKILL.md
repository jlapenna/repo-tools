---
name: land-pr
description: "Carry a local change or existing pull request through the complete GitHub delivery lifecycle: verify and commit the intended scope, push a ready PR, monitor CI, address review feedback, reply to and resolve addressed threads, merge through branch protection, perform repository-required post-merge verification, and safely clean up branches and worktrees. Use when the user says to push, publish, ship, land, or merge a change or PR and expects completion rather than a handoff at PR creation."
---

# Land a Pull Request

Finish the whole PR lifecycle. Do not stop after pushing a branch or opening a
PR when the remaining gates can be completed safely.

## Reconcile policy and authority

1. Read the repository's `AGENTS.md`, contributing guide, and applicable local
   development or release skills before mutating Git or GitHub.
2. Apply higher-level instructions first, then the most specific compatible
   repository rule, then this cross-repository workflow.
3. Treat invocation of this skill as authorization to:
   - commit and push the confirmed in-scope changes;
   - open a ready-for-review PR;
   - enable auto-merge or merge after required gates pass;
   - reply to and resolve review threads only after their feedback is addressed;
   - delete the merged feature branch and remove its clean worktree.
4. Do not treat invocation as authorization to bypass hooks or protection,
   force-push, change unrelated issues, deploy unrelated services, discard a
   dirty checkout, or guess through ambiguous feedback.
5. Prefer a ready PR and squash merge unless the user or repository specifies
   otherwise. Create a draft only when explicitly requested or required.

## Prepare the change

1. Load and follow `worktree-hygiene` before Git mutation. Keep implementation,
   commits, and PR updates in an isolated feature worktree when concurrency is
   possible or the repository requires it.
2. Inspect status and the complete diff. Stage only the intended files; stop
   for user direction if unrelated changes overlap the work.
3. Run the repository's required verification and relevant focused tests.
   Never use `--no-verify` to bypass commit or push hooks.
4. Commit intentionally and push normally with upstream tracking.
5. Confirm GitHub authentication and resolve the repository, base branch, and
   head branch from local evidence rather than assumption.

## Open the PR

Create a ready PR with a concise title and body covering:

- what changed;
- why it changed and the root cause for fixes;
- user or operational impact;
- verification already performed;
- issue-closing syntax only when the merged PR fully completes that issue.

Confirm required checks were actually created and that the PR head SHA matches
the pushed commit. Arm protected auto-merge when supported, but keep monitoring.

## Shepherd CI and review

Prefer a repository-provided lifecycle watcher when one exists. Otherwise use
the watcher bundled with this plugin after arming auto-merge. Derive an
absolute plugin root from the path used to read this file (two directories
above this `SKILL.md`), call it `$REPO_TOOLS_PLUGIN_ROOT`, and run from the
target repository:

```bash
bash "$REPO_TOOLS_PLUGIN_ROOT/scripts/repo-watch-prs.sh" <pr-number> [<pr-number>...]
```

An npm installation of `@jlapenna/repo-tools` also exposes the equivalent
`repo-watch-prs` command on `PATH`, but a plugin-only installation does not
depend on that package.

The default matches a non-strict ruleset and ignores `BEHIND`; pass `--strict`
only when branch protection actually requires an up-to-date head.

The watcher exits successfully only after every PR is actually merged. An
`ATTENTION` verdict is a handoff back into the loop below, not a terminal
status: diagnose the reported check, branch, or review-thread condition, update
the PR, then restart the watcher against the current head.

Repeat this loop until the current PR head is fully green:

1. Monitor every required check. If one fails, inspect its actual logs and load
   the repository's CI-fix skill when available. Fix the cause within scope,
   verify locally, push, and restart the loop on the new head SHA.
2. Inspect review summaries and thread-aware inline comments. Load
   `gh-address-comments` when available; flat comment lists are not sufficient
   for resolution state.
3. Address every unambiguous actionable comment by default. Ask before acting
   when feedback is ambiguous, conflicts with another request, expands scope
   materially, or would introduce a regression.
4. Re-run relevant verification and push each correction. Ensure CI and review
   evidence refer to the latest head, not a superseded commit.
5. Reply when a response adds useful evidence. Resolve a thread only after its
   requested change is present in the PR head and verified. Leave informational,
   outdated, or disputed feedback accurately classified rather than pretending
   it was fixed.
6. Re-check for new comments after every push. Do not declare success while an
   actionable unresolved thread or required check remains.

## Merge through protection

Before merging, require all of the following:

- the PR is mergeable and not a draft;
- required checks on the current head passed;
- actionable review feedback is addressed and its threads are resolved;
- the intended merge method complies with repository policy;
- no new commit invalidated the evidence.

Merge or let auto-merge complete without administrative bypass. Verify the PR's
actual `MERGED` state, merge timestamp, and merge commit; do not infer success
from a CLI message or from checks turning green.

## Verify and clean up

1. Follow repository-specific post-merge requirements. If it defines a
   canonical checkout, confirm it is clean and on the base branch, fetch, and
   fast-forward with `--ff-only`; verify its HEAD equals the upstream commit.
2. Run live or deployment verification only when the user requested rollout or
   repository policy makes it part of completion. Use the canonical deployment
   identity and source when one is defined.
3. Confirm a linked issue closed only when the merged PR completed it. Do not
   close partial or follow-up work silently.
4. Hand teardown to `worktree-hygiene`. Prove squash-merged content landed,
   scan for live processes, require a clean worktree, remove it safely, delete
   the exact local and remote feature branches, and synchronize a clean primary
   base checkout.
5. Report anything intentionally retained. Deleted branch/worktree content is
   recoverable from the merged commit and PR when the tree-equivalence proof
   succeeded.

Finish with the PR link, merge commit, checks, review disposition, post-merge
verification, and cleanup result. Stop and name the precise blocker only when
authentication, permissions, ambiguous review, protected external state, or an
unsafe dirty checkout prevents further progress.
