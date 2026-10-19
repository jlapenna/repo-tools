# Retirement evidence

The lens for [legacy-cleanup](../SKILL.md). Read it before removing any
candidate; hand it to auditors through the
[delegated audit](../../complexity-sweep/references/delegated-audit.md).

## What to look for

Search tracked source, configuration and current runbooks for legacy and
deprecated markers, retired feature modes, outdated defaults, temporary
workarounds, compatibility shims, old-format readers, aliases, migration
commands, feature-flag transitions and fallback chains. Follow the
owning interfaces and callers beyond those words: unmarked obsolete branches
count too. Exclude lockfile notices, vendor syntax and dated history.

Name-pattern scan for leads:

```text
legacy|deprecated|compat|shim|alias|fallback|workaround|migrat|backfill|census|v1|old-|legacy_|LEGACY|_OLD|TODO.*remove
```

## Trace each candidate

Establish the original purpose or contract, what ended that need, the current
supported behavior if there is a replacement, and everything that can still
select the old behavior. Trace producers and consumers: CI, CLI entry points,
re-exports, deployment manifests, persisted records, browser storage,
generated clients and other repositories in scope. Tests are consumers of
code, but a test devoted solely to retired behavior is not a reason to keep
that behavior.

## Evidence by consumer class

- **Closed repository contract.** Every supported target and caller selects
  the current behavior, or the feature has been retired, and the old implementation or configuration has no
  remaining supported caller. A manifest census plus call tracing establishes
  this without production access.
- **Persisted data or deployed clients.** Obtain a complete migration or census
  result, or equivalent authoritative evidence, covering the relevant
  versions, scopes and rollback policy. Read-only verify or dry-run modes of
  the migration itself are the usual source; run them, or a names-only count on
  the host that holds the data, whenever you can reach it. Test reachability
  before reporting that access is missing. A migration script existing, an
  old commit date, a sample with no old records, or "it has been a while" is
  not evidence.
- **External or unknown consumers.** Check the published support or retirement
  contract and any usage evidence. No local reference does not prove a public
  API, metric, installed client or recovery path is unused.

Keep a path when its immediate value is concrete: an active caller, retained
user data, an ongoing rollout, a supported restore or rollback path, or an
external support commitment. Do not invent a universal age threshold, and do
not preserve hypothetical compatibility forever.

## Remove the complete path

Step 4 of the skill lists what goes with the branch. Also update current
runbooks that describe the old path, and preserve historical records such as
changelogs and incident entries.

## Verify

Exercise the supported path at the affected boundary and any meaningful
rejection of retired input. Keep tests for current behavior and safety
properties; remove tests whose entire purpose is the retired feature, without
replacing them with absence assertions.
