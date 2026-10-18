---
name: diagnostic-hygiene
description: Sweep one repository or the active fleet for obsolete diagnostic machinery and retire what no longer earns its place, including committed evidence dumps and screenshots, one-off probes and measurement harnesses, canaries for settled upgrades, incident logs nobody appends, shipped implementation plans, CI steps guarding deleted facilities, and dated history inside runbooks. Use whenever the user asks to clean up diagnostics, debug tooling, evidence, probes, audits, or investigation leftovers, or wants repositories fresher and simpler, even without the word "diagnostic". Not for compatibility shims or migrations (compatibility-cleanup), dependency updates, or fixing a live incident.
---

# Diagnostic hygiene

Investigations leave machinery behind: the script that measured a timeout, the
screenshots that proved a click stalled, the canary that compared two versions,
the plan that was executed, the log that was meant to be appended forever. Each
was valuable while the question was open. Once the question closed, it became
weight that agents retrieve, lint, and reason about on every task. This skill
finds that weight and removes it without touching the diagnostics that still
protect production.

This is the focused retirement sibling of the
[complexity-sweep skill](../complexity-sweep/SKILL.md), which owns how a sweep
establishes its repository set, remote freshness and base revisions; reuse
that procedure here. Retired contracts, shims and migrations belong to
[compatibility-cleanup](../compatibility-cleanup/SKILL.md).

## What counts as diagnostic machinery

Anything whose purpose was to investigate, observe, prove or debug a specific
problem rather than deliver product or infrastructure function. The recurring
shapes, with the signal that made each one obsolete in practice:

| Shape | Typical paths | Obsolete when |
| --- | --- | --- |
| Committed evidence | `docs/evidence/`, Playwright reports, PNG/JSON/log dumps, benchmark result bundles, `*-evidence-<date>.md`, `*.bak.<timestamp>`, committed runtime pointers | the issue it proved is closed and nothing links or reads the files |
| One-off tools | `measure-*`, `probe-*`, `survey.py`, `analyze_traces.py`, codemods at repo root, canaries comparing two versions, reconcilers for one report format | the fix or decision landed; no workflow, timer, playbook, skill route or package script invokes them |
| Investigation-era checks | CI steps or tests for a facility that was deleted, debug tasks that only print, failure-receipt hooks for a closed issue, per-click phase recorders in e2e tests | the facility is gone or the issue closed, so the check guards nothing live |
| Chronology | shipped `plans/*.md`, incident logs with no append in months, "Revision history" and "Phase N status" sections inside design docs and runbooks, specs for implemented features | the current contract already lives in code, tests or the canonical doc |
| Finished-lane skills | debugging skills with speculative "hunting" sections, benchmark SOPs pointing at paths that may not exist, baseline records a skill links as "historical" | the live procedure is elsewhere and the skill text is the only reader |

Names are not evidence. A daily `label-contract-audit` workflow applies labels;
`cleanup-evidence.sh` is a library the cleanup commands source; a product's
"evidence" store is a feature with Terraform behind it. Read what the thing
does and who calls it.

Evidence is what an investigation recorded, not what it built. A CAD model, a
recipe, a fixture or a script that an experiment produced is source once it
sits in the project's source tree; keep it unless the repository's own rules
retire it. Likewise an unreachable branch, a stale docstring or a weak test
assertion is ordinary code quality, not diagnostic machinery; leave it to the
owning workflow rather than padding a hygiene pass with it.

## Decide with evidence, not age

Build one row per candidate before deciding anything. The
[audit brief](references/audit-brief.md) carries the table and a delegable
read-only prompt; use it when the sweep spans several repositories. Scale the
evidence to the cut: a lead that a test imports or a workflow runs needs that
one citation and a KEEP, not a full row, so a single-repository pass stays
quick.

- **Diagnoses:** the specific question or problem it was built for.
- **Origin:** the PR and issue that introduced it, and whether that issue is
  closed, open, or abandoned. `git log --follow --diff-filter=A` finds the
  commit; the subject usually names the PR.
- **Referenced by:** every live route in the current tree: CI workflows,
  Dockerfile `RUN` gates, timers and cron, playbooks and deploy catalogs,
  package scripts, skills routed from the agent guide, generated inventories,
  and consumer repositories when the artifact is a published contract.
- **Last change:** the last meaningful edit, ignoring mechanical renames.
- **Verdict and reason:** one sentence.

Then apply the verdicts:

- **KEEP** when any live route invokes it, when it is production monitoring or
  alerting, when it is the sole coverage of a safety or integrity invariant,
  when its issue, rollout or support case is still open, or when it is a product
  feature that happens to use diagnostic vocabulary.
- **DELETE** when the subject is resolved, nothing routes to it, and the
  durable lesson already has an owner (a contract test, a canonical doc
  section, an incident entry, the merged fix itself).
- **FOLD** when one fact still matters but the ledger around it does not: move
  the contract table, the two durable facts, or the one-line conclusion into
  its owner, then delete the rest.

"No commits since" and "looks old" are not verdicts; a build gate can be
untouched for months and run on every image. Conversely, a measurement harness
touched last week is still obsolete if its issue closed and nothing runs it.
When the consumer may live in another repository, check that repository before
deleting the producer. Keep candidates tied to open issues and say which issue
must close first.

## Delete the whole thing, then the links to it

Remove the artifact together with its test, fixtures, CI step, debug task,
catalog entry, skill row and router reference. Then search the tree for each
deleted basename; documentation link checks and skill-inventory tests fail on
the stragglers you did not search for. Regenerate generated inventories from
their owner instead of editing them. When an artifact slipped past an ignore
rule, extend the rule in the same change so the next one does not land.

Keep the durable conclusion as prose where the "run this script" instruction
used to be: the numbers a benchmark produced, the version a canary settled on,
the one-line note that a workaround was removed and why it must not return.

Group changes so review stays cheap and CI stays fast:

1. Deletions with no caller and no code change (evidence, plans, dated docs).
2. Fold-then-delete work that edits code, CI or skills.
3. Anything that needed external verification first, with the evidence noted.

One pull request per group per repository, each listing the closed issue
numbers that justify its cuts. Follow the repository's own worktree, PR and
auto-merge rules through the [worktree-hygiene](../worktree-hygiene/SKILL.md)
and [land-pr](../land-pr/SKILL.md) skills, and the
[testing-policy skill](../testing-policy/SKILL.md) when a deleted check had a
required-status consumer.

## Verify and report

Run the repository's required checks locally before pushing; deletions often
select the broadest validation plan. Do not add a contract test asserting the
artifact stays gone, and do not run production actions to manufacture proof.

Report, per repository: base revision examined, what was deleted grouped as
above, what was kept with the route or issue that keeps it, and load-bearing
findings outside the sweep (a submodule pointing at a removed directory, a
lane that never cut over). Include repositories where nothing qualified so the
sweep's coverage is verifiable.
