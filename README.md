# repo-tools

General repository-management commands, independent of Agent LCARS.

The package owns worktree safety, process inspection, CI monitoring, and
shared repository tooling. It must not contain agent identity, agent session,
or Agent LCARS runtime behavior.

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
- `repo-nx` — run Nx with portable cache and linked-worktree safeguards.

## Skills

The Codex plugin exposes `worktree-hygiene`, the authoritative guidance for
using these commands safely in a shared repository checkout. Repository-local
documentation should link to this skill rather than mirror its body.
