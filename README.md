# repo-tools

General repository-management commands, independent of Agent LCARS.

The package owns worktree safety, process inspection, CI monitoring, and
shared repository tooling. It must not contain agent identity, agent session,
or Agent LCARS runtime behavior.

Repository-agnostic guidance for deciding which tests and checks earn their
cost is in the [testing-policy skill reference](plugins/repo-tools/skills/testing-policy/references/testing-policy.md).

## ESLint plugin and baseline

`@jlapenna/repo-tools/eslint` is the single maintained implementation of the
fleet's Nx-aware client/server and Server Action rules, plus its shared flat
config baseline. A consumer registers `fleetEslintPlugin` under its own
namespace and spreads `fleetBaseline({ simpleImportSort, unusedImports })`
into its flat config. The consuming repository retains only its local config
selection and repository-specific rules.

## Commands

- `repo-scan-live-processes <directory>` — list processes whose working
  directory is inside a repository or worktree.
- `repo-check-dependencies` — validate a pnpm frozen lockfile and report
  missing or invalid packages in the resolved dependency tree. Repository
  policy (such as permitted workspace dependency names) remains local.
- `repo-require-worktree [commits and pushes|pushes]` — reject authoring from
  a primary checkout or `main`, while allowing deletion-only pushes.
- `repo-watch-prs` — watch auto-merge lifecycle for pull requests in the
  current repository.
- `repo-set-tmux-task-title` — set an empty tmux window task title from a
  Codex `UserPromptSubmit` hook payload, without overwriting a pinned title.
- `repo-watch-run` — watch one workflow run for a pull request or branch.
- `repo-safe-remove-worktree` — validate and safely remove a completed
  feature worktree, including clean worktrees with initialized submodules.
- `repo-sweep-worktrees [--repo <checkout>] [--base <ref>] [--delete]` —
  audit every linked worktree of a checkout and, with `--delete`, remove the
  ones whose work has landed (ancestor of the base, or merged pull request
  with content identical to its squash) that are clean and unoccupied;
  dirty, live, open-PR, and unverified worktrees are reported and kept. Run
  it from the primary checkout, on a schedule, as the backstop for sessions
  that never completed their own teardown.
- `repo-nx` — run Nx with portable cache and linked-worktree safeguards.

## Pre-commit worktree guard

Consumers using [pre-commit](https://pre-commit.com/) can enable both commit
and content-push enforcement directly from this repository:

```yaml
default_install_hook_types: [pre-commit, pre-push]

repos:
  - repo: https://github.com/jlapenna/repo-tools
    rev: <commit-or-tag>
    hooks:
      - id: repo-require-worktree
      - id: repo-require-worktree-push
```

Run `pre-commit install --install-hooks` after updating the configuration.
Pre-commit skips its pre-push hooks for deletion-only pushes; content pushes
run the shared guard and are rejected from the primary checkout or `main`.

## Skills

The Codex plugin exposes five authoritative skills:

- `worktree-hygiene` covers safe creation, use, and teardown in shared
  repository checkouts.
- `github-ci-monitor` covers `repo-watch-run` and `repo-watch-prs`, including
  protected auto-merge attention states.
- `testing-policy` guides test, CI-check, and control-flag decisions.
- `land-pr` carries a local change or existing pull request through the
  complete delivery lifecycle: commit, push, PR, CI and review, protected
  merge, post-merge verification, and worktree/branch cleanup.
- `renovate-maintenance` audits and lands Renovate updates within a repository,
  with risk-based verification, sequential merges, combined-main validation,
  and explicit separation from deployment and production-state checks.

The plugin bundles the two CI watcher scripts under `scripts/`, so
`github-ci-monitor` and `land-pr` work in a plugin-only installation. The npm
package exposes the same implementations through the `repo-watch-run` and
`repo-watch-prs` commands on `PATH`.

## Provider compatibility

One checked-out copy of repo-tools can serve all supported agent runtimes. The
CLI commands remain available from that checkout's package installation; do
not copy skills into consumer repositories or install global plugins from their
setup scripts.

| Runtime | Supported integration from a shared checkout |
| --- | --- |
| Codex | `codex plugin marketplace add /opt/repo-tools`, then `codex plugin add repo-tools@repo-tools` |
| Claude Code | `claude plugin marketplace add /opt/repo-tools`, then `claude plugin install repo-tools@repo-tools` |
| OpenCode | Add `"/opt/repo-tools/plugins/repo-tools/skills"` to the global `opencode.json` `skills` array. |

Codex and Claude Code maintain their own required plugin snapshots; OpenCode
uses its documented configured skill-directory discovery. The provider matrix
in `plugins/manifests.test.mjs` protects this shared source layout.

Repository-local documentation may retain its own protection policy and check
names, but should link to these skills rather than mirror their bodies.
