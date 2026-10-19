# Complexity candidates

The lens for [complexity-sweep](../SKILL.md). Read it before ranking anything;
hand it to auditors through the [delegated audit](delegated-audit.md).

## What to look for

Maintenance cost, not size. Use tracked source, call sites, history and
existing checks to find:

- Parallel implementations of the same policy or lifecycle, especially ones
  that have already drifted or that usually change together.
- Layers, configurable frameworks, indirect dispatch or duplicated state that
  make a current operation harder to trace without serving a present need.
- Stale documentation, setup steps or generated projections that disagree with
  their actual owner and make routine maintenance fail.
- Obsolete adapters, migrations, flags and compatibility paths, and leftover
  diagnostic machinery. They are in scope; decide them by the stricter
  evidence rules of [legacy-cleanup](../../legacy-cleanup/SKILL.md)
  or [diagnostic-hygiene](../../diagnostic-hygiene/SKILL.md).

Size, nesting, churn and duplicate-block matches are leads. Generated outputs,
deployment bundles, snapshot references and independently shipped modules can
legitimately resemble their sources, and separate operations may need
different policies despite similar syntax. Read the callers and the protected
behavior before deciding code is unnecessary.

Name-pattern scan for leads (see the [delegated audit](delegated-audit.md)):

```text
legacy|deprecated|compat|shim|fallback|v1|old|adapter|wrapper|registry|factory|manager|helpers?|utils?
```

## Record each candidate

Path and revision, current consumer, maintenance cost, the smallest proposed
simplification, the contract it must preserve, and the proof available. A
claim of dead code needs caller and external-interface evidence: no grep hit
does not prove the absence of a dynamic or deployed caller.

## Rank

Favor repeated sources of behavioral drift, frequently changed code, and
unnecessary operational steps with clear ownership and affordable
verification. Weigh the benefit against migration effort, uncertainty and blast
radius. Keep speculative or high-risk findings in a separate list from fixes
ready to implement.

## Simplify

- Prefer deleting a redundant owner, delegating to an existing operation, or
  replacing indirection with direct code.
- Share only the behavior that is actually common. Keep platform-specific
  permissions, I/O, error handling and policy at their existing boundaries. Do
  not introduce modes, flags, generic registries or a cross-repository package
  to make two small callers fit one abstraction.
- Preserve supported CLI and API behavior, output protocols, failure semantics
  and safety checks. An intentional behavior correction exposed by duplication
  is an explicit fix with its own regression evidence, not a silent refactor.
- When coverage changes, protect observable contracts, particularly both
  consumers of a newly shared operation.

## Describe the reduction

State it concretely, for example: two independently maintained workflows now
delegate to one tested operation while each keeps its input validation. Line
count is supporting evidence, never a quota or sufficient reason.
