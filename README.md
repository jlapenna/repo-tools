# repo-tools

General repository-management commands, independent of Agent LCARS.

The package owns worktree safety, process inspection, CI monitoring, shared
repository tooling, and provider-neutral GitHub App identity helpers. Agent
LCARS-specific session, dispatch, and runtime behavior remains in Agent LCARS.

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

`repo-verify --base origin/main` explains the repository's executable plan;
add `--run` to execute it. `.repo/verify.json` owns native commands, not another
set of copied wrappers. CI passes immutable `--base` and `--head` values and
may select a job's checks with repeatable `--check <id>` options. Unknown refs,
unknown checks, malformed plans, and failed commands fail closed. `--head`
must match the checkout when executing; omit it to include local changes.

Plans use `version: 1`, optional `inventory`, and a `checks` array. Each check
has a unique `id`, an argv `command`, optional string-valued `env`, and
`when: "always"` (default) or `"full"`. `{base}` and `{head}` expand to resolved
commit IDs; a standalone `{files}` argument expands to changed paths. Commands
run without a shell unless the plan explicitly invokes one. They have the same
authority as running that repository's tests; do not run untrusted plans with
credentials or elevated privileges.

Documentation selection is **off by default**. `documentationOnly: true`
allows a nonempty Markdown-only diff to skip checks marked `full`. Opt in only
where Markdown is not a build/runtime input requiring those checks. Renames
include both paths; empty diffs retain full validation; invalid bases fail.
The built-in `docs` check always validates changed local links and any requested
inventory. Prerequisite installation, release checks, E2E selection, and
authorization remain with the repository; this command does not deploy or
change required-check policy. `--github-output <file>` emits the chosen lane.

This repository uses the same plan locally and in its required Verify job:
`node bin/verify.mjs --base origin/main --run`.

The [generated interface inventory](docs/interfaces.md) lists commands and
skills directly from their manifests. `repo-docs generate --output
docs/interfaces.md` refreshes it; `repo-docs check --output docs/interfaces.md`
rejects drift, malformed skill frontmatter, and broken literal local Markdown
file links. Use `--files <paths...>` last for focused link/skill checks; inventory
checks still cover all source manifests. Code examples, web URLs, root-relative
web routes, and heading anchors are not checked. Nx inventories include only
explicit targets, not inferred targets. These are source contracts, not runtime
health checks.

- `repo-gh-shim` — a `gh` wrapper that authenticates as the App bot when an
  agent session is driving, and does nothing otherwise. A token only helps
  if it is actually used, and requiring an agent to remember it on every
  call is how the wrong name ends up on the work; this removes the
  remembering. Opt in per host by putting it ahead of `gh` on `PATH`
  (`ln -s "$(command -v repo-gh-shim)" ~/.local/bin/gh`). Human
  invocations, an explicitly supplied `GH_TOKEN`, and commands outside any
  repository all pass straight through. If minting fails it refuses rather
  than silently writing under the human's name; `REPO_GH_IDENTITY=optional`
  allows the fallback and `=off` disables the shim.
- `repo-adopt-agent-identity [<repo>] [--dry-run] [--force]` — give existing
  linked worktrees the agent commit identity. Setting it at creation only
  helps worktrees made afterwards, and a busy checkout can hold dozens that
  predate it. Never touches the primary checkout, and leaves a worktree that
  already carries a different identity alone unless forced.
- `repo-github-app-token [--repo owner/name] [--json] [--refresh]` — mint a
  short-lived GitHub App installation token for a repository, so an agent
  session's GitHub writes carry the App's bot identity instead of the
  human maintainer's. Reads the App key on demand via
  `GITHUB_APP_PRIVATE_KEY_COMMAND` (or `GITHUB_APP_PRIVATE_KEY`) and
  `GITHUB_APP_CLIENT_ID`, so no long-lived credential is stored on the
  host. The client id and the key command also fall back to
  `git config repo-tools.githubAppClientId` and
  `repo-tools.githubAppPrivateKeyCommand`, which is how to configure a host
  whose agent tool shells never source a profile. Only `--global` and
  `--system` are read: a repository's own config is untrusted input, and the
  key command is executed. The PEM itself is environment-only. Tokens are scoped to the single repository, cached until
  shortly before expiry, and printed bare for
  `GH_TOKEN="$(repo-github-app-token)"`.
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
  ones whose work has landed (ancestor of the base, or exact merged PR head
  whose merge commit is on the base) that are clean and unoccupied;
  dirty, live, open-PR, and unverified worktrees are reported and kept. Run
  it from the primary checkout, on a schedule, as the backstop for sessions
  that never completed their own teardown.
- Use `--path <worktree>` to scope that command to one completed task. Both
  the sweep and `repo-audit-branches [--base main] [--fetch] [--delete] [--delete-remote]`
  use the same fail-closed merge/ownership checker. Reports are TSV with stable
  reasons; missing ownership evidence preserves work. No fetch is implicit.
  Local and remote branch deletion require separate flags; remote deletion uses
  the originally audited SHA and runs push hooks.
- `repo-nx` — run Nx with portable cache and linked-worktree safeguards.

## Releasing

`pnpm release <version>` bumps the plugin version across every published
manifest — `.claude-plugin/marketplace.json`, `plugins/repo-tools/.claude-plugin/plugin.json`,
and `plugins/repo-tools/.codex-plugin/plugin.json` — in one atomic step and
commits the result. It validates all three files before writing any of
them, so a missing file or malformed version leaves the release untouched
rather than half-applied. Run it from a feature worktree, then push and open
a PR as usual; it does not push or open the PR itself.

## Pre-commit worktree guard

Consumers using [pre-commit](https://pre-commit.com/) can enable both commit
and content-push enforcement directly from this repository:

```yaml
default_install_hook_types: [pre-commit, pre-push]

repos:
  - repo: https://github.com/jlapenna/repo-tools
    rev: main
    hooks:
      - id: repo-require-worktree
      - id: repo-require-worktree-push
```

First-party consumers follow `main`; pre-commit caches hook environments, so
reinstall/refresh the environment when updating shared tooling. Run
`pre-commit install --install-hooks` after updating the configuration.
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

| Runtime     | Supported integration from a shared checkout                                                        |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Codex       | `codex plugin marketplace add /opt/repo-tools`, then `codex plugin add repo-tools@repo-tools`       |
| Claude Code | `claude plugin marketplace add /opt/repo-tools`, then `claude plugin install repo-tools@repo-tools` |
| OpenCode    | Add `"/opt/repo-tools/plugins/repo-tools/skills"` to the global `opencode.json` `skills` array.     |

Codex and Claude Code maintain their own required plugin snapshots; OpenCode
uses its documented configured skill-directory discovery. The provider matrix
in `plugins/manifests.test.mjs` protects this shared source layout.

Repository-local documentation may retain its own protection policy and check
names, but should link to these skills rather than mirror their bodies.
