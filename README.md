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
- `repo-watch-run` — watch one workflow run for a pull request or branch.
- `repo-safe-remove-worktree` — validate and safely remove a completed
  feature worktree.
- `repo-sweep-worktrees [--repo <checkout>] [--base <ref>] [--delete]` —
  audit every linked worktree of a checkout and, with `--delete`, remove the
  ones whose work has landed (ancestor of the base, or merged pull request
  with content identical to its squash) that are clean and unoccupied;
  dirty, live, open-PR, and unverified worktrees are reported and kept. Run
  it from the primary checkout, on a schedule, as the backstop for sessions
  that never completed their own teardown.
- `repo-nx` — run Nx with portable cache and linked-worktree safeguards.

## Skills

The Codex plugin exposes four authoritative skills:

- `worktree-hygiene` covers safe creation, use, and teardown in shared
  repository checkouts.
- `github-ci-monitor` covers `repo-watch-run` and `repo-watch-prs`, including
  protected auto-merge attention states.
- `testing-policy` guides test, CI-check, and control-flag decisions.
- `land-pr` carries a local change or existing pull request through the
  complete delivery lifecycle: commit, push, PR, CI and review, protected
  merge, post-merge verification, and worktree/branch cleanup.

The plugin bundles the two CI watcher scripts under `scripts/`, so
`github-ci-monitor` and `land-pr` work in a plugin-only installation. The npm
package exposes the same implementations through the `repo-watch-run` and
`repo-watch-prs` commands on `PATH`.

Repository-local documentation may retain its own protection policy and check
names, but should link to these skills rather than mirror their bodies.
