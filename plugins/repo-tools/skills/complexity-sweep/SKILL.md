---
name: complexity-sweep
description: Sweep active repositories for unnecessary code complexity and stale maintenance paths, rank evidence-backed findings, and implement the highest-value simplifications. Use for cross-repository cleanup or a focused complexity/freshness pass; focused compatibility retirement, feature work and dependency-update queues follow their existing workflows.
---

# Complexity sweep

Reduce the number of concepts, independent implementations and maintenance
steps needed to support current behavior. Keep a repository unchanged when a
proposed abstraction, deletion or rewrite would cost more than it removes.

## Establish scope and freshness

Resolve the requested repositories from the workspace, repository registry or
hosting account. For an unspecified active set, use recent default-branch
commits and owned open work; state the activity window and exclusions. Thirty
days is a useful starting assumption, not a retention policy. Include maintained
forks when their local work is in scope. Deduplicate checkouts and linked
worktrees by repository identity; distinguish source checkouts from deployment
checkouts and preserve their local state.

Record each selected repository's default branch, inspected commit and dirty
or live-work conflicts. Verify the current remote base before diagnosing a
candidate: a local HEAD, cached tracking ref, or repository `pushedAt` alone
does not prove default-branch freshness. A hosting API or `git ls-remote
--symref origin HEAD` can establish remote identity without moving a checkout.
Treat an inaccessible repository as unverified and disclose the coverage gap.
Honor explicit offline or local-snapshot instructions: inspect the supplied
revision, label remote freshness unverified, and continue the authorized audit
without fetching or contacting a hosting service.

Read the repository's agent guide and owning development workflow. Inspect
open PRs and worktrees for overlapping implementations before editing. Use
[worktree-hygiene](../worktree-hygiene/SKILL.md) for isolated authoring and
task-end cleanup. Do not change a sibling session's branch, local edits or
running services to make the sweep easier.

## Find maintenance cost, not just large files

Use tracked source, call sites, history and existing checks to investigate:

- Parallel implementations of the same policy or lifecycle, especially when
  they have already drifted or frequently change together.
- Obsolete adapters, migrations, flags or compatibility paths whose consumers
  and supported contracts can be shown to have ended.
- Layers, configurable frameworks, indirect dispatch or duplicate state that
  make a current operation harder to trace without serving a present need.
- Stale documentation, setup steps or generated projections that disagree
  with their actual owner and make routine maintenance fail.

Size, nesting, churn and duplicate-block searches are leads. Read callers and
the protected behavior before deciding that code is unnecessary. Generated
outputs, deployment bundles, snapshot references and independently shipped
modules can legitimately resemble their sources. Separate operations may also
need different policies despite similar syntax.

For every actionable candidate, record the path/revision, current consumer,
maintenance cost, smallest proposed simplification, preserved contract and
available proof. A claim of dead code needs caller and external-interface
evidence; no grep hit does not prove the absence of a dynamic or deployed caller.

## Rank and implement the priority items

Favor repeated sources of behavioral drift, frequently changed code and
unnecessary operational steps with clear ownership and affordable verification.
Weigh the benefit against migration effort, uncertainty and blast radius. Keep
speculative or high-risk findings separate from fixes ready to implement.

When cleanup is requested, implement the highest-value verified candidates
instead of stopping at a ranked list. Prefer deleting a redundant owner,
delegating to an existing operation, or replacing indirection with direct code.
Share only the behavior that is actually common; keep platform-specific
permissions, I/O, error handling and policy at their existing boundaries. Do not
introduce modes, flags, generic registries or a cross-repository package merely
to make two small callers fit one abstraction.

Keep each repository's change independently reviewable. Preserve supported
CLI/API behavior, output protocols, failure semantics and safety checks. Treat
an intentional behavior correction exposed by duplication as an explicit fix,
with its own regression evidence, rather than silently calling it a refactor.
Do not mix bulk dependency upgrades, model changes, CI-capacity changes or
deployment into a source cleanup. Use the existing Renovate workflow for a
requested dependency queue,
[compatibility-cleanup](../compatibility-cleanup/SKILL.md) for a focused
compatibility retirement, and
[harness-maintenance](../harness-maintenance/SKILL.md) for substantive context
or skill upkeep.

## Prove the reduction and finish

Run the owning repository's focused checks and required gate. Use
[testing-policy](../testing-policy/SKILL.md) when changing coverage: protect
observable contracts, particularly both consumers of a newly shared operation.
Do not add tests that merely assert the new file layout. If a gate fails,
establish whether the failure exists at the inspected base; do not weaken it or
silently declare success. Source tests do not prove a live rollout or authorize
account, host or hardware actions.

Reconcile relevant docs with the final owner and regenerate maintained
projections through their generator. Describe the concrete reduction: for
example, two independently maintained workflows now delegate to one tested
operation, while each retains its input validation. Line count is supporting
evidence, never a quota or sufficient reason to accept a change.

Follow the existing delivery authority and
[land-pr](../land-pr/SKILL.md) when publication is authorized. Keep durable
guidance generic and put repository-specific evidence in its existing issue,
PR or requested report; do not publish a private portfolio inventory in a
public tooling repository. Report inspected coverage, completed fixes and
exact revisions/PRs, checks and limits, justified deferrals, and task-checkout
cleanup. Distinguish triage from deep review and merged code from deployed
behavior. Stop when the selected priority set is finished; the sweep does not
authorize an unsolicited backlog or recurring automation.
