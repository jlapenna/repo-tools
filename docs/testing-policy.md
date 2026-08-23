# Testing policy

Use this policy when adding, retaining, removing, or configuring a test or CI
check. A repository may add local detail, but must not lower these rules.

## Observable contracts

Keep coverage only when it protects an observable production contract or a
previously observed regression, and a person or system acts on its result.
Test count is not a quality metric; deletion count is not one either.

Coverage earns its cost for:

- safety, security, data-integrity, availability, public API, CLI,
  configuration, schema, workflow, infrastructure, or artifact contracts;
- independently deployed service, repository, or tool boundaries;
- durable business policy and non-trivial externally visible behavior; and
- a production incident: the fix includes the narrowest test that would have
  caught that incident.

Use the cheapest layer that exercises the contract:

| Contract | Preferred coverage |
| --- | --- |
| Durable policy or algorithm | Focused unit test |
| API, config, schema, workflow, manifest, or artifact | Contract or integration test |
| Auth, persistence, deployment, browser, or external-service path | Targeted end-to-end smoke |
| Rendered appearance that is itself contractual | Reviewed visual baseline |
| Deployed environment | Post-deploy verification through the real consumer path |

## Coverage that does not earn its cost

Remove tests that prove only a private implementation detail, framework
behavior, a hypothetical feature, a typed literal, a constant, or an
expectation reimplemented inline in the test. Remove permanently skipped
suites without linked rationale, obsolete compatibility paths, and migration
code together with the migration tests that no longer protect the final
contract.

Do not remove a real contract test merely because it is flaky: fix or
quarantine it with an owner and linked issue. A test is redundant only when a
stronger check covers every breaking event, blocks that event, and is not
skipped by a fork guard, path filter, or disabled lane.

## Every CI check has one consumer

Each check is exactly one of:

- a required merge check that blocks a pull request;
- a release gate that blocks publication or deployment of the artifact it
  measures; or
- an owned signal feeding an alert or dashboard with an accountable owner.

"Informational" alone is not a consumer. Remove a check with no consumer.
Measure the artifact that ships at the boundary where it ships: image budgets
belong before image publication, deployment smoke checks around deployment,
and cross-repository checks only at the relevant interface.

## Required jobs and control flags

Required jobs must always report a result. Do not put fork guards, draft
guards, or path filters on a required job: GitHub treats a skipped job as a
passing required check. Put the decision inside the job instead, including an
explicit successful short-circuit after it has established that no protected
input changed.

An intentional operational control flag is the exception. A flag may skip a
required lane when its designed semantics explicitly permit merging without
that lane. Such flags must:

1. make their engaged state visible on every affected run;
2. have a documented default and restore operation; and
3. never be cited as the stronger coverage that justifies removing another
   check while engaged.

Use names that make the default legible: `*_ENABLED` for a normal verification
lane that is enabled unless explicitly set to `false`, and `*_ARMED` for an
external-effect action that is disarmed unless explicitly set to `true`.

This policy does not prescribe a scheduled configuration-only auditor. Normal
code and workflow changes are validated in their pull-request checks; a
scheduled check is justified only when the violating event is genuinely
external to the repository and it has a named consumer.

## Operational hygiene

- Bound every job with `timeout-minutes` near its realistic worst case.
- Give pull-request workflows concurrency with cancellation for superseded
  commits.
- Keep secret scanning required or release-gating in every repository.
- Remove dead triggers rather than retaining unexercised configuration.
- Rerun only infrastructure outcomes, with a cap and a still-current-head
  check; never rerun a real failure into green.
- Track duration and failures caught after a cleanup. Restore coverage only
  for a concrete missed production contract; the restored test is then
  incident-derived and permanent.
