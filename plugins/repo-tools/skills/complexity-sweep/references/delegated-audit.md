# Delegated audit

Use when a sweep spans several repositories, or when the audit and the changes
should be done by different hands. The audit is read-only and produces an
evidence table; the implementer works from the table. Keeping them apart means
whoever decides a cut sees evidence rather than a diff, and the audit cannot
widen into edits.

## Audit prompt

Fill the bracketed fields. `[lenses]` contains only the selected candidate
references from [complexity-sweep](../SKILL.md), for example
`references/diagnostic-candidates.md`; paste the files, or point the auditor
at them. Pass explicit exclusions too. `[default]` is the repository's default
branch. Do not ask the auditor to load every lens for a focused request.

```text
READ-ONLY AUDIT. Do not edit files or run any git command that mutates state
(no checkout, branch, commit, stash, reset, worktree add). Write only under
[scratch directory]. Use `git -C [repo path]` with a fixed path; do not cd into
the repository.

Repository: [repo path] ([owner/name]). Audit `origin/[default]` with
`git -C [repo path] show origin/[default]:<path>` and
`git -C [repo path] log origin/[default] -- <path>` so a stale checkout cannot
mislead you. Read-only `gh issue view`, `gh pr list` and `gh run list` are
allowed.

Goal and candidate rules: [lenses]. Explicit exclusions: [exclusions].
This audit is read-only even when the parent task authorizes later cleanup.

Live production monitoring, alerting, backup and drift timers are KEEP by
default; list them only with evidence they are dead (not deployed, target
gone).

For each candidate record: path; what it is for; origin PR/issue and that
issue's state; every live route that references it (workflows, Dockerfile RUN,
timers, playbooks, deploy catalogs, package scripts, skills routed from the
agent guide, consumer repositories); last meaningful change; verdict with one
sentence of reason. Be skeptical of keeping anything whose subject is resolved
and that nothing invokes; be equally skeptical of removing anything a live
route invokes.

Leads: [paths from the selected lenses' name-pattern scans].

Also report what an implementer needs: branch protection and required checks,
the agent guide's worktree and deletion rules, test and docs-check commands,
generated inventories to regenerate, and routers (agent guide, skill
marketplace, docs index) that must lose their rows.

Write a Markdown report to [scratch directory]/audit.md with the table
(path | purpose | origin + status | referenced by | last change | verdict |
reason), then a "safe to act" section grouped into: removals with no caller
and no code change; code, CI, configuration or skill changes; needs evidence
from outside the repository; keep until a named issue closes. Concrete paths only; no speculation presented as fact.
```

## Name-pattern scan

Run against the fetched default branch and treat hits as leads to read, never
as verdicts. Set `lens_pattern` to the calling lens's pattern and `default` to
the default branch. For combined audits, use the selected patterns and
deduplicate findings; do not count one path once per lens.

```bash
git -C "$repo" ls-tree -r --name-only "origin/$default" \
  | grep -Eiv '(^|/)(node_modules|vendor|\.pnpm|\.cache)/' \
  | grep -Ei "$lens_pattern"
```

## Implementer handoff

Give the implementer the audit file, the repository's own workflow skill, and
the exact items to land, grouped as the
[sweep report](sweep-report.md) groups them. Name what must not be touched (the
kept rows) so a tidy-minded agent does not widen the cut. Ask for PR URLs and
head revisions, exact changes, anything kept with the evidence that kept it,
verification commands with results, and confirmation that the worktree was
removed.
