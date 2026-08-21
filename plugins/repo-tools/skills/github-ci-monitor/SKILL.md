---
name: github-ci-monitor
description: Watch GitHub Actions runs and armed auto-merge pull requests until they complete or need attention. Use after enabling auto-merge, while waiting for CI, or whenever a session would otherwise poll GitHub in an ad-hoc loop.
---

# GitHub CI Monitor

Use the public `repo-tools` commands instead of hand-written polling loops or
repository-local watcher copies. Both commands emit only state changes and a
terminal verdict, so a long quiet run does not consume the caller's context.

## Watch one workflow run

`repo-watch-run` answers whether one workflow run passed:

```bash
repo-watch-run [--workflow <name>] [--timeout <minutes>] <pr-number-or-branch>
```

Examples:

```bash
repo-watch-run 885
repo-watch-run --workflow CI main
```

It finds the latest matching run, reports status changes, prints focused
failure logs, and exits nonzero on failure or timeout.

## Watch the protected auto-merge lifecycle

After arming auto-merge, the real question is whether the pull request landed
or needs intervention. Use:

```bash
repo-watch-prs [--strict] [--interval <seconds>] <pr> [<pr>...]
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
| `VERDICT ATTENTION <pr> checks-failed:<names>` | Required checks failed or were cancelled. |
| `VERDICT ATTENTION <pr> unresolved-threads:<n>` | Green checks are blocked by unresolved review threads. |
| `VERDICT ATTENTION <pr> closed-unmerged` | The pull request closed without merging. |

An attention verdict returns ownership to the calling session: diagnose the
reported state, make one targeted correction, and start the watcher again
against the new head. Do not treat attention as task completion.

Transient GitHub or network errors are reported and retried. The pull-request
watcher has no timeout because a quiet protected merge queue is normal; stop it
only when the owning task is intentionally abandoned or parked.

## Ownership boundary

This skill and the `repo-watch-*` implementations are owned by public
[`jlapenna/repo-tools`](https://github.com/jlapenna/repo-tools). Consumer
repositories may document their strict/non-strict branch policy and required
check names, but must not copy this skill or either watcher implementation.
