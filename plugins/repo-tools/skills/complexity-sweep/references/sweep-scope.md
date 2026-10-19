# Sweep scope

Shared by the sweep family: [complexity-sweep](../SKILL.md),
[legacy-cleanup](../../legacy-cleanup/SKILL.md) and
[diagnostic-hygiene](../../diagnostic-hygiene/SKILL.md). Read it once at the
start of a sweep; it decides which repositories and which revisions the
findings are about.

## Select the repositories

- Use the requested repositories. For "our active repos", resolve the set from
  the workspace, a maintained repository registry or the hosting account, and
  state the inclusion rule: recent default-branch commits and owned open work
  over a stated window. Thirty days is a starting assumption, not a retention
  policy.
- Deduplicate checkouts and linked worktrees by repository identity. A path
  whose `.git` is a file is a linked worktree, not another repository.
- Distinguish source checkouts from deployment checkouts and preserve their
  local state. Exclude archived, vendored and upstream trees unless requested;
  include maintained forks when their local work is in scope.
- Treat an inaccessible repository as unverified and disclose the gap.
- Carry every selected repository into the report, including those where
  nothing qualified, so "swept" has a verifiable scope.

## Establish freshness

- Record each repository's default branch and the exact revision inspected.
- Inspect the fetched default branch (`git show origin/<default>:<path>`,
  `git log origin/<default> -- <path>`), not the working tree. The default
  branch is not always `main`; resolve it rather than assuming it. Local checkouts are
  routinely days behind, and a cached tracking ref or `pushedAt` alone does not
  prove default-branch freshness. A hosting API or
  `git ls-remote --symref origin HEAD` establishes remote identity without
  moving a checkout.
- Honor explicit offline or local-snapshot instructions: inspect the supplied
  revision, label remote freshness unverified, and continue without fetching.

## Respect other work

- Read each repository's agent guide and owning development workflow before
  deciding anything; its delivery, verification and approval rules govern.
- Check open PRs, linked worktrees and live sessions for overlapping
  implementations before editing. Unrelated activity is not a reason to stop
  the sweep; a sibling session's branch, local edits and running services are
  never yours to change.
- Do every edit and Git mutation in a dedicated worktree through
  [worktree-hygiene](../../worktree-hygiene/SKILL.md), and remove it at task end.
