---
name: diagnostic-hygiene
description: Sweep one repository or the active fleet for obsolete diagnostic machinery and retire what no longer earns its place, including committed evidence dumps and screenshots, one-off probes and measurement harnesses, canaries for settled upgrades, incident logs nobody appends, shipped implementation plans, CI steps guarding deleted facilities, and dated history inside runbooks. Use whenever the user asks to clean up diagnostics, debug tooling, evidence, probes, audits or investigation leftovers, or wants repositories fresher by removing investigation leftovers, even without the word diagnostic. Not for retired product behaviors, shims or migrations (legacy-cleanup), general refactoring (complexity-sweep), dependency updates, or fixing a live incident.
---

# Diagnostic hygiene

Investigations leave machinery behind: the script that measured a timeout, the
screenshots that proved a click stalled, the canary that compared two versions,
the plan that was executed. Each was valuable while its question was open;
afterwards it is weight that agents retrieve, lint and reason about on every
task. Remove that weight without touching the diagnostics that still protect
production.

| Skill | Removes or simplifies | Its evidence bar |
| --- | --- | --- |
| [complexity-sweep](../complexity-sweep/SKILL.md) | duplicated policy, needless layers, stale setup and projections | preserved consumer contracts and a concrete maintenance reduction |
| [legacy-cleanup](../legacy-cleanup/SKILL.md) | retired feature modes, outdated defaults and workarounds, shims, finished migrations | retirement proof per consumer class, including persisted data |
| [diagnostic-hygiene](../diagnostic-hygiene/SKILL.md) | evidence dumps, one-off probes, settled canaries, shipped plans | closed issue, no live route, durable lesson already owned |

Shared procedures live with complexity-sweep:
[sweep scope](../complexity-sweep/references/sweep-scope.md),
[delegated audit](../complexity-sweep/references/delegated-audit.md) and
[delivery and report](../complexity-sweep/references/sweep-report.md).

## 1. Scope the sweep

Read [sweep scope](../complexity-sweep/references/sweep-scope.md) first. It
selects the repositories, pins the revisions inspected, and checks for
overlapping work. Never change another session's branch, local edits or running
services. For several repositories, delegate read-only audits with
the [delegated audit](../complexity-sweep/references/delegated-audit.md) prompt
and this skill's lens, [candidates](references/candidates.md).

## 2. Find candidates

Anything built to investigate, observe, prove or debug a specific problem
rather than deliver function: committed evidence, one-off tools,
investigation-era checks, chronology, and finished-lane skills. Names are not
evidence, and what an experiment built (a model, a fixture, a recipe) is
source, not evidence.

Read [candidates](references/candidates.md) before deciding. It has the shape
table with each shape's obsolescence signal, the evidence row, and the
name-pattern scan for auditors.

## 3. Decide

- **KEEP** anything a live route invokes; production monitoring, alerting,
  backup and drift timers; sole coverage of a safety or integrity invariant;
  anything tied to an open issue, rollout or support case; and product
  features that use diagnostic vocabulary.
- **DELETE** when the subject is resolved, nothing routes to it, and the
  durable lesson already has an owner.
- **FOLD** when one fact still matters: move it to its owner, delete the rest.
- Age is not a verdict either way. Check a consumer repository before deleting
  a producer it might read. Ask only when an unresolved policy decision
  materially affects the requested outcome.

## 4. Change

Remove the artifact with its test, fixtures, CI step, debug task, catalog
entry, skill row and router reference, and keep the durable conclusion as prose
where the obsolete procedure used to be. Extend an ignore rule in the same
change when an artifact slipped past it.

Make edits in a dedicated worktree, and group changes per repository as
[delivery and report](../complexity-sweep/references/sweep-report.md)
describes. Never take a production action to manufacture proof for a source
cleanup: no production migration, stored-data deletion, credential
invalidation, runner-capacity change or deploy. Take any necessary external
action only under the user's existing authorization and the repository's owning
workflow.

## 5. Verify and report

Run the repository's required checks before pushing. Never weaken a failing
gate; check whether it also fails at the inspected base. Do not add tests
asserting a file stays deleted or a layout stays as it is.

Report as [delivery and report](../complexity-sweep/references/sweep-report.md)
describes: the revisions inspected, what changed, what was kept and why, and
repositories where nothing qualified.

List kept candidates with the route or open issue that keeps them, and
load-bearing findings outside the sweep (a submodule pointing at a removed
directory, a lane that never cut over).

Stop when the selected set is done; a sweep does not authorize an unsolicited
backlog or recurring automation.
