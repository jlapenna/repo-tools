---
name: compatibility-cleanup
description: Sweep repositories for obsolete compatibility branches, migration scaffolding, aliases, and superseded configuration paths; remove those whose current consumers no longer need them. Use for compatibility cleanup, completed-migration retirement, or repository freshness and complexity sweeps, rather than general dependency upgrades or feature redesign.
---

# Compatibility cleanup

Reduce the number of supported paths and stale contracts while preserving
behavior that has a current consumer. Favor deletion over replacing an old
compatibility layer with another abstraction or permanent audit framework.

## Establish the sweep

Use the requested repository set. For an unspecified set of active repositories,
inspect the workspace, maintained repository registry and recent development;
state the inclusion rule. Deduplicate linked checkouts by repository identity,
exclude archived/upstream vendor trees unless requested, and record the base
revision examined for each repository. Include repositories with no changes
in the outcome so “swept” has a verifiable scope.

Read each target's agent guide and owning development workflow. Inspect fresh
source under its fetch policy; stale primary checkouts are not proof of current
behavior. Use the shared [worktree-hygiene skill](../worktree-hygiene/SKILL.md)
before edits or Git mutation. Check for overlapping work without treating
unrelated activity as a reason to stop the sweep.

## Find and decide

Search tracked source, configuration and current runbooks for legacy/deprecated
markers, compatibility shims, old-format readers, aliases, migration commands,
feature-flag transitions and fallback chains. Follow the owning interfaces and
callers beyond those words: unmarked obsolete branches also count. Exclude
lockfile notices, vendor syntax and dated history from actionable hits.

For each candidate, establish the old contract, its replacement, and what can
still select the old behavior. Trace producers and consumers, including CI,
CLI entry points, re-exports, deployment manifests, persisted records, browser
storage, generated clients and other repositories in scope. Tests are consumers
of code, but a test devoted solely to retired behavior is not a reason to keep
that behavior.

Base removal on the relevant evidence:

- **Closed repository contract:** all supported targets/callers select the
  replacement; the old implementation/configuration has no remaining supported
  caller. A manifest census plus call tracing can establish this without
  production access.
- **Persisted data or deployed clients:** obtain a complete migration/census
  result or equivalent authoritative evidence covering the relevant versions,
  scopes and rollback policy. A migration script existing, an old commit date,
  a sample containing no old records, or “it has been a while” is insufficient.
- **External or unknown consumers:** check the published support/retirement
  contract and available usage evidence. No local reference alone does not
  prove a public API, metric, installed client or recovery path is unused.

Keep a path when its immediate value is concrete: an active caller, retained
user data, an ongoing rollout, a supported restore/rollback path, or an external
support commitment. When evidence is missing, name the specific consumer or
retirement proof needed. Continue independent removals; ask only when an
unresolved policy decision materially affects the requested outcome. Do not
invent a universal age threshold or preserve hypothetical compatibility forever.

## Delete the complete obsolete path

Remove the branch together with helpers, imports, flags, configuration examples,
workflow variables and tests that exist only for it. Update current runbooks
and regenerate inventories from their owner. Preserve historical records.
Collapse callers onto the supported interface; do not silently reinterpret old
input as valid new input. Where old input can still enter, use the existing
validation boundary to give an actionable unsupported-input error.

Keep each repository's change reviewable and tie it to its retirement evidence.
Do not run a production migration, delete stored data, invalidate credentials,
alter runner capacity or deploy merely to manufacture proof for a code cleanup.
Follow the user's existing authorization and each repository's owning workflow
for any necessary external action.

## Verify and finish

Exercise the supported path at the affected boundary and any meaningful
rejection of retired input. Retain tests for current behavior and safety
properties. Remove tests whose entire purpose is the retired feature; do not
replace them with text/absence assertions. Apply the
[testing-policy skill](../testing-policy/SKILL.md) for proportionate checks.
Search again for surviving references to removed interfaces and inspect the
complete diff for accidentally broadened deletion.

Follow each repository's authorized delivery and cleanup workflow. Report the
repository/revision coverage, actual removals and complexity reduction,
verification performed, and retained candidates with concrete reasons. Distinguish
local verification, merged source and deployed behavior. A clean keyword search
or passing tests is not proof that every migration has completed.
