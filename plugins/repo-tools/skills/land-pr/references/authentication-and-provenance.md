# Authentication and provenance

Read this before changing which GitHub identity drives a delivery, or when
interpreting who merged a PR.

## One authentication boundary

Use the installed `gh` command with its normal user login for interactive
delivery. Do not put an identity-selecting wrapper named `gh` on `PATH` or
inject a repository-scoped App token across the lifecycle: Git credential
helpers, repository administration, and merge operations need one stable
authentication boundary. A repository-specific workflow may explicitly supply
an App token at its own automation boundary.

## Merge executor versus implementer

Treat `mergedBy` as the merge executor, not as implementation provenance.
Protected auto-merge may report `github-actions`; direct merge reports the
authenticated user or App. Preserve implementation provenance in the PR body
and worktree-scoped commit author instead.
