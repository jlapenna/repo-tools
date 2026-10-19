---
name: complexity-sweep
description: Sweep one repository or the active fleet for unnecessary complexity and stale maintenance paths, rank evidence-backed findings, and implement the highest-value simplifications, including duplicated policy, needless layers, stale setup, and custom security, encryption, key or token schemes without a concrete protective purpose. Use for complexity, freshness, simplification or cleanup passes and reviews of security machinery added only for safety. Routes retired behaviors to legacy-cleanup and investigation leftovers to diagnostic-hygiene; not for general security hardening, feature work or dependency-update queues.
---

# Complexity sweep

Reduce the number of concepts, independent implementations and maintenance
steps needed to support current behavior. Leave a repository unchanged when a
proposed abstraction, deletion or rewrite would cost more than it removes.
This is the family's umbrella: it owns the shared procedures and hands focused
retirements to its siblings.

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
overlapping work. For several repositories, delegate read-only audits with
the [delegated audit](../complexity-sweep/references/delegated-audit.md) prompt
and this skill's lens, [candidates](references/candidates.md).

## 2. Find candidates

Look for maintenance cost, not size: parallel implementations of one policy,
indirection that serves no present need, and docs or setup that disagree with
their owner. Size, churn and duplicate-block matches are only leads. Legacy
behaviors and diagnostic leftovers are in scope too, judged by the
sibling that owns them. Dependency-update queues go to
[renovate-maintenance](../renovate-maintenance/SKILL.md); substantive context
or skill upkeep goes to [harness-maintenance](../harness-maintenance/SKILL.md).

Read [candidates](references/candidates.md) before ranking. It lists what to
look for, what to record per candidate, and the name-pattern scan for auditors.
For custom security, encryption, signing, keys, tokens or safety gates, also
read [security purpose](references/security-purpose.md). It establishes the
protected asset and trust boundary before judging a control unnecessary.

## 3. Decide

- A dead-code claim needs caller and external-interface evidence; no grep hit
  does not rule out a dynamic or deployed caller. Check consumer repositories
  before deleting a producer they might read.
- Rank by repeated drift, change frequency and operational steps saved, against
  migration effort, uncertainty and blast radius. Keep speculative findings
  apart from fixes ready to implement.
- When cleanup is requested, implement the top verified items instead of
  stopping at a ranked list. Ask only when an unresolved policy decision
  materially affects the requested outcome.

## 4. Change

Prefer deleting a redundant owner, delegating to an existing operation, or
replacing indirection with direct code. Share only the behavior that is truly
common, and do not add modes, flags, registries or cross-repository packages to
make callers fit one abstraction. Preserve supported CLI and API behavior,
output protocols, failure semantics and safety checks; an intentional behavior
fix exposed by duplication is an explicit fix with its own regression evidence.

Make edits in a dedicated worktree, and group changes per repository as
[delivery and report](../complexity-sweep/references/sweep-report.md)
describes. Never take a production action to manufacture proof for a source
cleanup: no production migration, stored-data deletion, credential
invalidation, runner-capacity change or deploy. Take any necessary external
action only under the user's existing authorization and the repository's owning
workflow.

## 5. Verify and report

Security-purpose cuts also receive the independent review described in
[security purpose](references/security-purpose.md) before delivery.

Verify and report as
[delivery and report](../complexity-sweep/references/sweep-report.md)
describes; it covers required checks, failing gates and the report contents.

State the reduction concretely ("two workflows now delegate to one tested
operation"); line count supports a claim but never justifies one.
