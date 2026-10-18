# Audit brief

Use this when a sweep covers more than one repository, or when the audit and
the deletions should be done by different hands. The audit is read-only; it
produces the table, and the implementer works from the table. Keeping the two
apart means the person deciding a cut sees evidence rather than a diff.

## Read-only audit prompt

Fill the bracketed fields and hand the rest over unchanged.

```text
READ-ONLY AUDIT. Do not edit files or run any git command that mutates state
(no checkout, branch, commit, stash, reset, worktree add). Write only under
[scratch directory]. Use `git -C [repo path]` with a fixed path; do not cd into
the repository.

Repository: [repo path] ([owner/name]). Audit `origin/main` with
`git -C [repo path] show origin/main:<path>` and
`git -C [repo path] log origin/main -- <path>` so a stale checkout cannot
mislead you. Read-only `gh issue view`, `gh pr list` and `gh run list` are
allowed.

Goal: inventory diagnostic machinery that is obsolete or not immediately
valuable so the owner can delete it. Diagnostic machinery is code, scripts,
workflows, skills, docs, fixtures or committed data whose purpose is to
investigate, observe, prove or debug a specific problem rather than deliver
product or infrastructure function: committed evidence and screenshots,
measurement harnesses, probes, canaries for settled upgrades, incident logs,
shipped plans, dated history sections, CI steps guarding deleted facilities,
debug tasks that only print, finished-lane skills.

Live production monitoring, alerting, backup and drift timers are KEEP by
default; list them only with evidence they are dead (not deployed, target gone).

For each candidate record: path; what it diagnoses; origin PR/issue and that
issue's state; every live route that references it (workflows, Dockerfile RUN,
timers, playbooks, catalogs, package scripts, skills routed from the agent
guide, consumer repositories); last meaningful change; verdict DELETE, KEEP or
FOLD with one sentence. Be skeptical of KEEP for anything whose subject is
resolved and that nothing invokes.

Leads: [paths from a name-pattern scan]. Also grep for: diagnostic, debug,
evidence, observation, incident, postmortem, probe, forensic, troubleshoot,
repro, shadow, telemetry, preflight, canary, measure, baseline.

Also report what an implementer needs: branch protection and required checks,
the agent guide's worktree and deletion rules, the test and docs-check
commands, generated inventories that must be regenerated, and routers
(agent guide, skill marketplace, docs index) that must lose their rows.

Write a Markdown report to [scratch directory]/audit.md with the table
(path | diagnoses | origin + status | referenced by | last change | verdict |
reason) followed by a "safe to act" section grouped into: deletions with no
caller, fold-then-delete, needs external verification, keep until issue
closes. Concrete paths only; no speculation presented as fact.
```

## Name-pattern scan for leads

Run against the fetched default branch, not the working tree, and treat hits
as leads to read rather than verdicts:

```bash
git -C "$repo" ls-tree -r --name-only origin/main \
  | grep -Eiv '(^|/)(node_modules|vendor|\.pnpm|\.cache)/' \
  | grep -Ei 'diag|debug|doctor|probe|troubleshoot|investigat|forensic|dump|observation|evidence|incident|postmortem|triage|repro|smoke|snapshot|capture|telemetry|trace|audit|verify|check-|-check|bench|canary|measure|baseline|scratch|wip|legacy|old|backup|\.bak'
```

Most hits are live infrastructure. The scan exists to make sure the audit reads
the right directories, not to shortcut the evidence table.

## Implementer handoff

Give the implementer the audit file, the repository's own workflow skill, and
the exact list of items to land, grouped as the skill describes. State what
must not be touched (the KEEP rows) so a tidy-minded agent does not widen the
cut. Ask for: PR URLs and head revisions, exact deletions, anything kept with
the evidence that kept it, verification commands with results, and
confirmation that the worktree was removed.
