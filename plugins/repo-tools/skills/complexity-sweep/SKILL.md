---
name: complexity-sweep
description: Analyze one repository or the active fleet for unnecessary complexity, retired legacy behaviors, and obsolete diagnostic machinery; rank evidence-backed findings and implement verified cleanup when requested. Use for complexity, freshness, simplification or cleanup sweeps; removing deprecated paths, shims, workarounds or completed migrations; retiring probes, evidence dumps, canaries or shipped plans; and reviewing custom security machinery added only for safety. Supports one, several or all analysis lenses, including analysis-only requests. Not for feature redesign, dependency-update queues, general security hardening or fixing a live incident.
---

# Complexity sweep

Reduce the concepts, independent implementations and maintenance steps needed
to support current behavior. Use one entry point with three optional analysis
lenses. Leave a repository unchanged when a proposed abstraction, deletion or
rewrite would cost more than it removes. Age, naming and line count alone are
never reasons to remove something.

## 1. Select scope and lenses

Read [sweep scope](references/sweep-scope.md) to select repositories, pin the
inspected revisions and check for overlapping work. Choose lenses from the
request, then read only their references:

| Lens | Select for | Read before analyzing candidates |
| --- | --- | --- |
| Complexity | duplication, needless layers, stale setup, conflicting policy owners | [Complexity candidates](references/candidates.md) |
| Legacy | retired modes, outdated defaults, workarounds, shims, aliases, old formats, finished migrations | [Retirement evidence](references/retirement-evidence.md) |
| Diagnostics | investigation leftovers, evidence dumps, one-off probes, settled canaries, shipped plans | [Diagnostic candidates](references/diagnostic-candidates.md) |

- A focused request selects its named lens or lenses. Explicit exclusions
  remain excluded. Do not run unrelated analyses just because they are bundled.
- A broad complexity, freshness or cleanup sweep without a narrower focus
  selects all three. State the selected lenses and repository scope briefly;
  do not ask the user to choose when the request already determines them.
- Distinguish permission to analyze from permission to change. Analysis verbs
  such as "audit", "review" or "find" alone authorize inspection and reporting
  without edits or PRs. An explicit implementation instruction such as "audit
  then fix" authorizes verified changes; an explicit "report only" or "don't
  change anything" remains a limit.
- If a candidate crosses lenses, load the additional reference before judging
  it and apply every relevant evidence bar. Record one finding, not one per
  lens. If the needed lens is explicitly excluded, defer that candidate and
  disclose the proof gap instead of widening the analysis.

For multi-repository or separately assigned read-only audits, load
[delegated audit](references/delegated-audit.md) and pass the selected lenses.
Load [security purpose](references/security-purpose.md) only when a selected
analysis encounters security, encryption, signing, key or token machinery, or
questions a safety control. Its boundary evidence and independent review apply
to security-purpose cuts across all three lenses.

Examples:

- "Analyze legacy paths only; don't change anything" → legacy, report only.
- "Find duplicated policy and obsolete probes" → complexity + diagnostics,
  report only.
- "Clean up this repository across all three lenses" → all three, implement
  verified findings.

Dependency-update queues belong to
[renovate-maintenance](../renovate-maintenance/SKILL.md); substantive context
or skill upkeep belongs to [harness-maintenance](../harness-maintenance/SKILL.md).

## 2. Find and decide

Follow each selected lens's candidate and evidence rules. Trace current
callers, external interfaces and consumer repositories before calling a path
unused; an empty local search does not rule out dynamic or deployed consumers.
Keep live production diagnostics and controls with a concrete current purpose.
For persisted data, deployed clients and recovery paths, gather reachable
read-only census or migration evidence rather than assuming retirement.

Rank findings by repeated drift, change frequency and operational steps saved,
against migration effort, uncertainty and blast radius. Keep verified changes,
speculative leads and retained candidates distinct. When evidence is missing,
name the consumer or census that would settle it and continue independent
work. Ask only when an unresolved policy decision materially affects the
requested outcome.

## 3. Change when authorized

Implement the top verified findings when cleanup is requested. Use the selected
lenses' removal or simplification instructions; remove obsolete callers,
helpers, tests and routes with their owner. Preserve supported CLI and API
behavior, output protocols, failure semantics and safety checks. An intentional
behavior correction needs its own regression evidence.

Make edits in a dedicated worktree and follow
[delivery and report](references/sweep-report.md). Never take a production
action to manufacture proof for source cleanup: no production migration,
stored-data deletion, credential invalidation, runner-capacity change or deploy.
Take a necessary external action only under the user's existing authorization
and the repository's owning workflow.

## 4. Verify and report

Read [delivery and report](references/sweep-report.md) for both analysis-only
reports and completed changes. Apply each selected lens's verification rules;
security-purpose cuts also need the independent review in
[security purpose](references/security-purpose.md) before delivery.

Report selected lenses, actual coverage and concrete maintenance reduction.
Do not claim an unselected lens was analyzed or that source checks prove a
live migration or rollout finished.
