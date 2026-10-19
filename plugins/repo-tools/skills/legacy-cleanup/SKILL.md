---
name: legacy-cleanup
description: Sweep one repository or the active fleet for legacy code and behaviors whose purpose has ended, such as retired feature modes, outdated defaults, temporary workarounds and fallbacks, compatibility shims, aliases, old-format readers and completed migrations, and remove those no current consumer needs. Use when the user asks for legacy cleanup, to retire a finished migration or cutover, to drop deprecated paths or workarounds, or to keep supported paths current, even if they only say the old way is gone. Not for general complexity passes (complexity-sweep), leftover diagnostics (diagnostic-hygiene), dependency upgrades or feature redesign.
---

# Legacy cleanup

Remove legacy code and behaviors whose purpose has ended, reducing the paths
and concepts maintainers must support. Legacy includes retired feature modes,
old defaults, temporary workarounds and fallback behavior as well as backward
compatibility and completed migrations. Preserve behavior with concrete current
value; age, naming and unfamiliar style alone do not make it obsolete. Favor
deletion over another abstraction or a permanent audit framework.

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
and this skill's lens, [retirement evidence](references/retirement-evidence.md).

## 2. Find candidates

Search for legacy and deprecated markers, retired feature modes, outdated
defaults, temporary workarounds, shims, old-format readers, aliases, migration
commands, flag transitions and fallback chains, then follow the
owning interfaces past those words: unmarked obsolete branches count too.

Read [retirement evidence](references/retirement-evidence.md) before removing
anything. It covers tracing producers and consumers, the evidence each consumer
class needs, and the name-pattern scan for auditors.
For retired security protocols, encryption formats, keys or tokens, also read
[security purpose](../complexity-sweep/references/security-purpose.md); retain
current trust boundaries and prove stored-data and restore consumers retired.

## 3. Decide

- For each candidate, name its original purpose, what ended that need, the
  current supported behavior if there is a replacement, and everything that
  can still select the old behavior.
- Persisted data and deployed clients need a complete census or migration
  result covering versions, scopes and rollback. A script existing, an old
  commit date, a clean sample or elapsed time is not evidence. Gather it
  yourself when you can reach the system: a read-only count, a verify or
  dry-run mode, or a names-only listing is evidence gathering, not a
  production change. Only when access genuinely fails, name the exact
  command that would settle it.
- No local reference does not prove a public API, metric, installed client or
  recovery path is unused; check the published support contract. Check
  consumer repositories before deleting a producer they might read.
- Keep a path with a concrete current value: an active caller, retained data,
  an ongoing rollout, a supported restore or rollback path, or an external
  commitment. When proof is missing, name the census or consumer that would
  settle it and continue with independent removals. Ask only when an
  unresolved policy decision materially affects the requested outcome.

## 4. Change

Remove the branch with its helpers, imports, flags, config examples, workflow
variables and the tests that exist only for it, and collapse callers onto the
supported interface. Where old input can still arrive, return an actionable
unsupported-input error at the existing validation boundary rather than
silently reinterpreting it.

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

Exercise the supported path and any meaningful rejection of retired input. A
clean keyword search is not proof that a migration finished.

Stop when the selected set is done; a sweep does not authorize an unsolicited
backlog or recurring automation.
