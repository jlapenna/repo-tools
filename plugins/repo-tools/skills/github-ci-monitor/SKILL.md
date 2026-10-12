---
name: github-ci-monitor
description: Watch GitHub Actions runs and armed auto-merge pull requests until they complete or need attention. Use after enabling auto-merge, while waiting for CI, or whenever a session would otherwise poll GitHub in an ad-hoc loop.
---

# GitHub CI Monitor

Use GitHub CLI for individual workflow runs and PR checks. Use the bundled
auto-merge watcher when the question is whether a PR landed or needs attention.
Do not add polling loops or repository-local watcher copies.

## Watch one workflow run

Resolve the intended commit before discovering a run: the just-pushed commit,
the PR's `headRefOid` from `gh pr view`, or the actual merge commit for
post-merge verification. A primary checkout may still be behind the merge.
Filter by that SHA, the required workflow, and the expected event. For a push
of the current checkout's commit:

```bash
expected_sha=$(git rev-parse HEAD)
gh run list --commit "$expected_sha" --workflow CI --event push \
  --json databaseId,headSha,event,workflowName,status,conclusion,url
```

Verify the returned SHA and event match the intended validation, then watch
that exact run ID:

```bash
gh run watch <run-id> --exit-status --compact --interval 30
```

No matching run means validation is not yet established. Check workflow
creation within the task's deadline; do not fall back to an older branch run
or treat absence as success. If several runs match, select the intended run
explicitly. If branch/workflow discovery looks historical or
ambiguous, use `gh api` to query the workflow's runs with `head_sha` and
`event`, then verify the returned SHA and event before watching its ID.

`--exit-status` makes a failed run return nonzero. Inspect failures with
`gh run view <run-id> --log-failed` and continue the owning task's fix workflow.

For a PR's required checks rather than one workflow run, use:

```bash
gh pr checks <pr-number> --required --watch --fail-fast --interval 30
```

Check results do not prove that the PR merged. If its head changes during
verification, establish the required checks for the new head.

## Watch the protected auto-merge lifecycle

After arming auto-merge, the real question is whether the pull request landed
or needs intervention. Derive `$REPO_TOOLS_PLUGIN_ROOT` from the path used to
read this file: it is two directories above this `SKILL.md`. An npm
installation also exposes `repo-watch-prs` on `PATH`; the plugin-relative
script needs no package install.

```bash
bash "$REPO_TOOLS_PLUGIN_ROOT/scripts/repo-watch-prs.sh" [--strict] [--interval <seconds>] <pr> [<pr>...]
```

Use `--strict` only when the repository's branch protection requires the head
to be current with its base. Without it, a merely-behind pull request is not an
attention condition.

The final output line is a machine-readable verdict:

| Verdict | Meaning |
| --- | --- |
| `VERDICT ALL-MERGED` | Every watched pull request merged. |
| `VERDICT ATTENTION <pr> dirty` | The branch conflicts with its base. |
| `VERDICT ATTENTION <pr> behind` | Strict mode requires an update. |
| `VERDICT ATTENTION <pr> auto-merge-unarmed` | Green checks do not merge a PR; arm auto-merge or merge it directly. |
| `VERDICT ATTENTION <pr> checks-failed:<names>` | Required checks failed or were cancelled. |
| `VERDICT ATTENTION <pr> unresolved-threads:<n>` | Green checks are blocked by unresolved review threads. |
| `VERDICT ATTENTION <pr> closed-unmerged` | The pull request closed without merging. |

An attention verdict returns ownership to the calling session: diagnose the
reported state, make one targeted correction, and start the watcher again
against the new head. Do not treat attention as task completion. In
particular, `auto-merge-unarmed` is a required decision point: use
`gh pr merge --auto` when the repository supports protected auto-merge, or
merge directly once all gates pass and the task authorizes delivery.

Transient GitHub or network errors are reported and retried. The pull-request
watcher has no timeout because a quiet protected merge queue is normal; stop it
only when the owning task is intentionally abandoned or parked.

## Ownership boundary

This skill and the `repo-watch-prs` implementation are owned by public
[`jlapenna/repo-tools`](https://github.com/jlapenna/repo-tools). Consumer
repositories may document their strict/non-strict branch policy and required
check names, but must not copy this skill or the watcher implementation.
