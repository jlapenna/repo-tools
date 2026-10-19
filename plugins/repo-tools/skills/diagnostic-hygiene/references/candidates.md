# Diagnostic candidates

The lens for [diagnostic-hygiene](../SKILL.md). Read it before deciding any
candidate; hand it to auditors through the
[delegated audit](../../complexity-sweep/references/delegated-audit.md).

## What to look for

Anything whose purpose was to investigate, observe, prove or debug a specific
problem rather than deliver product or infrastructure function. The recurring
shapes, and the signal that made each obsolete in practice:

| Shape | Typical paths | Obsolete when |
| --- | --- | --- |
| Committed evidence | `docs/evidence/`, Playwright reports, PNG/JSON/log dumps, benchmark result bundles, `*-evidence-<date>.md`, `*.bak.<timestamp>`, committed runtime pointers | the issue it proved is closed and nothing links or reads the files |
| One-off tools | `measure-*`, `probe-*`, `survey.py`, trace analyzers, codemods at the repo root, canaries comparing two versions, reconcilers for one report format | the fix or decision landed; no workflow, timer, playbook, skill route or package script invokes them |
| Investigation-era checks | CI steps or tests for a deleted facility, debug tasks that only print, failure-receipt hooks for a closed issue, per-click phase recorders in e2e tests | the facility is gone or the issue closed, so the check guards nothing live |
| Chronology | shipped `plans/*.md`, incident logs with no append in months, "Revision history" and "Phase N status" sections in design docs and runbooks, specs for implemented features | the current contract already lives in code, tests or the canonical doc |
| Finished-lane skills | debugging skills with speculative "hunting" sections, benchmark procedures pointing at paths that may not exist, baseline records a skill links as historical | the live procedure is elsewhere and the skill text is the only reader |

Name-pattern scan for leads:

```text
diag|debug|doctor|probe|troubleshoot|investigat|forensic|dump|observation|evidence|incident|postmortem|triage|repro|smoke|snapshot|capture|telemetry|trace|audit|verify|check-|-check|bench|canary|measure|baseline|scratch|wip|legacy|old|backup|\.bak
```

Most hits are live infrastructure; the scan only makes sure the right
directories get read. Also grep contents for: diagnostic, debug, evidence,
observation, incident, postmortem, probe, forensic, troubleshoot, repro,
shadow, telemetry, preflight, canary, measure, baseline.

## Names are not evidence

A daily `label-contract-audit` workflow applies labels; `cleanup-evidence.sh`
is a library the cleanup commands source; a product's "evidence" store is a
feature with Terraform behind it. Read what the thing does and who calls it.

Evidence is what an investigation recorded, not what it built. A CAD model, a
recipe, a fixture or a script an experiment produced is source once it sits in
the project's source tree; keep it unless the repository's own rules retire
it. An unreachable branch, a stale docstring or a weak assertion is ordinary
code quality, not diagnostic machinery; leave it to the owning workflow rather
than padding a hygiene pass with it.

## Evidence row

Build one row per candidate before deciding. Scale it to the cut: a lead that
a test imports or a workflow runs needs that one citation and a KEEP, not a
full row.

- **Diagnoses:** the specific question it was built for.
- **Origin:** the PR and issue that introduced it, and whether that issue is
  closed, open or abandoned. `git log --follow --diff-filter=A` finds the
  commit; its subject usually names the PR.
- **Referenced by:** every live route: CI workflows, Dockerfile `RUN` gates,
  timers and cron, playbooks and deploy catalogs, package scripts, skills
  routed from the agent guide, generated inventories, and consumer
  repositories when the artifact is a published contract.
- **Last change:** the last meaningful edit, ignoring mechanical renames.
- **Verdict and reason:** one sentence.

## Verdicts

- **KEEP** when a live route invokes it, when it is production monitoring or
  alerting, when it is the sole coverage of a safety or integrity invariant,
  when its issue, rollout or support case is still open, or when it is a
  product feature that uses diagnostic vocabulary.
- **DELETE** when the subject is resolved, nothing routes to it, and the
  durable lesson already has an owner: a contract test, a canonical doc
  section, an incident entry, the merged fix.
- **FOLD** when one fact still matters but the ledger around it does not: move
  the contract table, the two durable facts or the one-line conclusion into
  its owner, then delete the rest. A long dated ledger that an open issue still
  needs can move verbatim to a comment on that issue, when the issue tracker
  has the same visibility as the repository.

"No commits since" and "looks old" are not verdicts: a build gate can sit
untouched for months and run on every image, while a harness touched last
week is obsolete if its issue closed and nothing runs it. When the consumer
may live in another repository, check it before deleting the producer. For a
candidate tied to an open issue, say which issue must close first.
