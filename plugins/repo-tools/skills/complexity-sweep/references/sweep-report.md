# Sweep delivery and report

Shared by the sweep family. Read it when changes are ready to land and again
before the final report.

## Group changes

Keep each repository's changes independently reviewable and cheap to verify:

1. Removals with no caller and no code change: dated docs, committed evidence,
   executed plans, unreferenced files.
2. Code, CI, configuration or skill changes: deletions that edit callers,
   folds that move a durable fact into its owner, simplifications.
3. Changes that needed evidence from outside the repository first (a
   production census, a consumer repository, an external support contract),
   with that evidence cited.

One pull request per group per repository. Tie each to the evidence that
justifies it: the closed issue, the census result, the empty consumer search.
Follow the repository's delivery workflow through
[land-pr](../../land-pr/SKILL.md) when publication is authorized. Do not mix
dependency upgrades, model changes, CI-capacity changes or deployment into a
source cleanup.

## Finish each change completely

- Search the whole tree again for every removed name: documentation link
  checks and skill-inventory tests fail on the stragglers nobody searched for.
- Regenerate generated inventories from their owner instead of editing them.
- Reconcile current docs and runbooks with the final owner.
- Keep the durable conclusion as prose where an obsolete procedure used to be:
  the measured number, the settled version, the one-line reason a workaround
  must not return.
- Read the complete diff for accidentally broadened deletion.

## Verify

- Run the repository's required checks locally before pushing; removals often
  select the broadest validation plan. Apply
  [testing-policy](../../testing-policy/SKILL.md) when a change removes or
  adds coverage, and update branch protection in the same delivery when a
  removed check is a required status.
- If a gate fails, establish whether it also fails at the inspected base before
  blaming or excusing the change. Never weaken a gate to pass.
- Do not add tests that assert a file stays deleted or a layout stays as it is.
- Production actions are governed by step 4 of the calling skill.

## Report

Per repository:

- Base revision inspected and freshness status.
- Changes made, grouped as above, with PR URLs and merge state.
- Candidates kept, each with the live route, open issue or missing proof that
  keeps it. When proof is missing, name the specific consumer or census that
  would settle it.
- Load-bearing findings outside the sweep's scope, stated once.
- Repositories where nothing qualified.
- Verification commands run, their results, and known limits.
- Task worktree removed (absolute path), or the guard that retained it.

Distinguish triage from deep review, local verification from merged source,
and merged source from deployed behavior. A clean keyword search or a green
test run is not proof that a migration finished or that a path is unused, and
source tests do not prove a live rollout or authorize account, host or
hardware actions. Keep durable guidance generic: put repository-specific
evidence in the existing issue, PR or requested report, and never publish a
private portfolio inventory in a public tooling repository.
Stop when the selected set is done; a sweep does not authorize an unsolicited
backlog or recurring automation.
