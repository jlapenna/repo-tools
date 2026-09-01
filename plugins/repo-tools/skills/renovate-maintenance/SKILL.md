---
name: renovate-maintenance
description: Audit, verify, merge, and clean up Renovate dependency updates in the current repository. Use when asked to process Renovate PRs, clear its Renovate queue, investigate its Dependency Dashboard, or finish dependency-update maintenance without conflating it with deployment.
---

# Renovate Maintenance

Turn the current repository's Renovate queue into reviewed, verified changes.
Keep repository maintenance distinct from deployment and production-state
validation.

## Establish the real scope

1. Read the repository's policy before changing Git or GitHub state. Use its
   required worktree, test, review, merge, and cleanup workflows; load the
   shared `worktree-hygiene`, `testing-policy`, and `land-pr` skills when their
   respective work begins.
2. Resolve the current repository and default branch from local Git and GitHub
   evidence instead of assuming their names.
3. Query this repository's current GitHub state using both Renovate authorship
   and branch naming (`author:app/renovate` and `head:renovate/` are useful
   cross-checks).
   Dependabot and hand-authored dependency PRs are separate scope unless the
   user includes them.
4. Snapshot each PR's exact head and base SHA, diff, merge state, checks,
   auto-merge state, reviews, and thread-aware comments. Re-query live state
   before acting; Renovate can replace branches while the sweep is running.
5. Treat a Renovate Dependency Dashboard as a persistent control surface, not
   a normal implementation issue. Do not close it merely because the queue is
   empty.

## Avoid racing the base branch

- Exact-head inspection and local verification may run independently, but
  merge dependency PRs sequentially. Every merge advances the base, can
  invalidate sibling checks, and can make an otherwise green PR stale or
  conflicting.
- After each merge, refresh the remaining PRs and let branch protection or
  Renovate recalculate them. Never reuse green evidence from a superseded head.
- Respect active claims, worktrees, and human-authored changes. Do not take
  over a bot branch that another session is already managing.

## Review and verify each update

1. Inspect the complete diff. Confirm it contains only the expected manifests,
   lockfiles, action pins, image digests, or generated metadata.
2. Classify risk from the actual change, not the PR title. Major runtimes,
   providers, build tools, base images, and lockfile format changes deserve
   more scrutiny than a routine digest refresh.
3. Use authoritative release notes or migration documentation when compatibility
   is not obvious. Check repository code for removed APIs and version-specific
   assumptions.
4. Verify the exact PR head in an isolated worktree. Run the repository's
   required gate plus focused checks that exercise the affected path: frozen
   lockfile installation, lint/type checks, tests, package or container builds,
   configuration rendering, or artifact inspection as appropriate.
5. Add a regression test only when the update exposes behavior the repository
   actually owns. Do not add tests that merely restate a version pin or simulate
   a deployment-only contract to make the update look safer.

For provider, image, runtime, or other updates whose correctness depends on
trusted production state or physical hardware, read
[references/infrastructure-updates.md](references/infrastructure-updates.md).

## Handle failures and dashboard warnings

- Diagnose the failing current head. Distinguish an incompatible dependency
  from a stale base, a repository regression, an unavailable runner, and an
  unrelated infrastructure outage.
- Prefer changing Renovate configuration or repository code in a separate,
  human-owned PR when the fix is not part of the generated dependency diff.
  Do not casually force-push or hand-edit a bot-owned branch.
- Trace dashboard warnings to the exact extracted file and dependency. If the
  source is genuinely retired, remove the dead configuration and its obsolete
  exceptions instead of hiding it with a broad ignore rule. If it remains
  intentional, document and narrowly exclude it.
- When a warning depends on hosted Renovate behavior, confirm the next managed
  refresh clears it. A local lookup is useful evidence but is not the hosted
  acceptance result.

## Deliver and close the sweep

1. Require all repository-mandated checks and resolved actionable threads on
   the current head, then merge through protection using the repository's
   required method.
2. Re-query the remaining queue after every merge and continue sequentially
   within that repository.
3. Verify the final combined base branch. Individually green dependency PRs
   can still interact; follow the latest descendant main commit when workflows
   cancel intermediate runs after rapid merges.
4. Remove only clean, process-free worktrees and branches whose content is
   proven merged. Confirm whether GitHub removed Renovate's remote branches and
   prune the corresponding tracking refs.
5. Repeat the repository-scoped search once after the final merge because
   Renovate may open a follow-up update. Finish when no in-scope Renovate PRs
   remain, or report each intentionally retained item and its blocker.

Do not deploy, apply infrastructure, contact an offline host, or broaden the
maintenance window merely because a dependency PR merged. Perform those
actions only when the user separately requests the operational rollout.
