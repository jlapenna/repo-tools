---
name: github-ci-monitor
description: Watch GitHub Actions runs and armed auto-merge pull requests until they complete or need attention. Use after enabling auto-merge, while waiting for CI, or whenever a session would otherwise poll GitHub in an ad-hoc loop.
---

# GitHub CI Monitor

Use the watcher scripts bundled with this plugin instead of hand-written
polling loops or repository-local copies. Derive an absolute plugin root from
the path used to read this file: it is two directories above this `SKILL.md`.
The examples call that resolved path `$REPO_TOOLS_PLUGIN_ROOT`. Both scripts
emit only state changes and a terminal verdict, so a long quiet run does not
consume the caller's context.

An npm installation of `@jlapenna/repo-tools` also exposes equivalent
`repo-watch-run` and `repo-watch-prs` commands on `PATH`. Do not assume that
package is installed when this skill came from the Codex or Claude plugin;
the plugin-relative scripts below are always available with the skill.

## Watch one workflow run

`repo-watch-run.cjs` answers whether one workflow run passed:

```bash
node "$REPO_TOOLS_PLUGIN_ROOT/scripts/repo-watch-run.cjs" [--workflow <name>] [--timeout <minutes>] <pr-number-or-branch>
```

Examples:

```bash
node "$REPO_TOOLS_PLUGIN_ROOT/scripts/repo-watch-run.cjs" 885
node "$REPO_TOOLS_PLUGIN_ROOT/scripts/repo-watch-run.cjs" --workflow CI main
```

It finds the latest matching run, reports status changes, prints focused
failure logs, and exits nonzero on failure or timeout.

## Watch the protected auto-merge lifecycle

After arming auto-merge, the real question is whether the pull request landed
or needs intervention. Use:

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

This skill and the `repo-watch-*` implementations are owned by public
[`jlapenna/repo-tools`](https://github.com/jlapenna/repo-tools). Consumer
repositories may document their strict/non-strict branch policy and required
check names, but must not copy this skill or either watcher implementation.
