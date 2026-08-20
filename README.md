# repo-tools

General repository-management commands, independent of Agent LCARS.

The package owns worktree safety, process inspection, CI monitoring, and
shared repository tooling. It must not contain agent identity, agent session,
or Agent LCARS runtime behavior.

## Commands

- `repo-scan-live-processes <directory>` — list processes whose working
  directory is inside a repository or worktree.
- `repo-require-worktree [commits and pushes|pushes]` — reject authoring from
  a primary checkout or `main`, while allowing deletion-only pushes.
