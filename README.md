# repo-tools

General repository-management commands, independent of Agent LCARS.

The package owns worktree safety, process inspection, CI monitoring, shared
repository tooling, and provider-neutral GitHub App identity helpers. Agent
LCARS-specific session, dispatch, and runtime behavior remains in Agent LCARS.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component and consumer boundaries,
and [docs/README.md](docs/README.md) for the documentation index.

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

The [generated interface inventory](docs/interfaces.md) lists commands and
skills directly from their manifests. `repo-docs generate --output
docs/interfaces.md` refreshes it; `repo-docs check --output docs/interfaces.md`
rejects drift, malformed skill frontmatter, and broken literal local Markdown
file links. Use `--files <paths...>` last for focused link/skill checks; inventory
checks still cover all source manifests. Code examples, web URLs, root-relative
web routes, and heading anchors are not checked. Nx inventories include only
explicit targets, not inferred targets. These are source contracts, not runtime
health checks.

- `repo-doctor [--json]` — read-only check that the installed runtime is
  usable before an agent relies on it. It reports the repo-tools package
  root (and commit, for a checkout), the enclosing repository if any, the
  `git`, `bash`, `gh`, and `jq` binaries, every `repo-*` command on `PATH`
  with the file its symlink or pnpm shim runs, the repo-tools commands that
  Codex (`$CODEX_HOME/hooks.json`) and Claude Code
  (`$CLAUDE_CONFIG_DIR/settings.json`) hooks call, and installed Codex and
  Claude plugin versions. A missing `git` or `bash`, a missing command a hook
  calls, a shim or plugin install path that no longer exists, or an enabled
  Codex plugin with no installed version fails (exit 1, naming the exact
  dependency); other gaps, version drift between plugin caches, and commands
  resolving from several installs only warn (exit 0). It reads hook files for
  command names only: it never reads stdin or prints hook command text,
  prompts, or payloads. It never repairs, installs, edits configuration, or
  uses the network. `--json` prints one object: `ok`, `package`,
  `repository`, and `checks` (`name`, `status` of `ok`/`warn`/`fail`,
  `detail`).
- `repo-adopt [--target DIR] [--hooks auto|pre-commit|husky|none] [--repo-tools-rev SHA] [--check] [--force]`
  — idempotently install this package's generic conventions into a
  repository: the `repo-require-worktree` commit and push guards (merged into
  an existing `.pre-commit-config.yaml` pinned to a rev, or seeded
  `.husky/pre-commit` and `.husky/pre-push` when the repository uses
  `package.json` without pre-commit), a `renovate.json` extending the shared
  preset (never modified once present), and a marker-delimited `AGENTS.md`
  section routing to the `worktree-hygiene` and `land-pr` skills by URL.
  Output is TSV (`action<TAB>file`, then `note<TAB>guidance`). `--check`
  writes nothing, never reaches the network, and exits 1 on drift; a second
  run after apply is a no-op. An existing Husky hook without the guard is
  reported as `locally-owned` with guidance; `--force` replaces it and re-pins
  an existing pre-commit entry. The rev defaults to `git ls-remote` of
  repo-tools `main`, resolved only when a pin is written.
- `repo-adopt-agent-identity [<repo>] [--dry-run] [--force]` — give existing
  linked worktrees the agent commit identity. Setting it at creation only
  helps worktrees made afterwards, and a busy checkout can hold dozens that
  predate it. Never touches the primary checkout, and leaves a worktree that
  already carries a different identity alone unless forced.
- `repo-github-app-token [--repo owner/name] [--json] [--refresh]` — mint a
  short-lived GitHub App installation token for one explicit automation
  boundary. Reads the App key on demand via
  `GITHUB_APP_PRIVATE_KEY_COMMAND` (or `GITHUB_APP_PRIVATE_KEY`) and
  `GITHUB_APP_CLIENT_ID`, so no long-lived credential is stored on the
  host. The client id and the key command also fall back to
  `git config repo-tools.githubAppClientId` and
  `repo-tools.githubAppPrivateKeyCommand`, which is how to configure a host
  whose agent tool shells never source a profile. Only `--global` and
  `--system` are read: a repository's own config is untrusted input, and the
  key command is executed. The PEM itself is environment-only. Tokens are scoped to the single repository, cached until
  shortly before expiry, and printed bare for an explicit invocation such as
  `GH_TOKEN="$(repo-github-app-token)"`.
- `repo-scan-live-processes <directory>` — list processes whose working
  directory is inside a repository or worktree.
- `repo-check-dependencies` — validate a pnpm frozen lockfile and report
  missing or invalid packages in the resolved dependency tree. Repository
  policy (such as permitted workspace dependency names) remains local.
- `repo-require-worktree [commits and pushes|pushes]` — reject authoring from
  a primary checkout or `main`, while allowing deletion-only pushes.
- `repo-check-runner-labels [file ...]` — reject a literal workflow `runs-on`
  that pairs `self-hosted` with a label declared in `.github/actionlint.yaml`'s
  `self-hosted-runner.labels`. actionlint accepts `self-hosted` everywhere, but
  a runner scale set matches only its own name, so the pair never schedules.
  Adopt it (also as the `repo-check-runner-labels` pre-commit hook) only where
  declared labels name scale sets. Dependency-free; no-op without labels.
- `repo-check-schedules [--list] [file ...]` — reject a periodic schedule
  that fires more often than hourly unless an adjacent
  `# schedule-justification: <reason>` comment explains why polling is the
  right design: systemd timers (`OnUnitActiveSec`, `OnUnitInactiveSec`,
  `OnCalendar`, including `*.timer.d/*.conf` drop-ins and `[Timer]` blocks
  embedded in YAML), GitHub Actions
  `on.schedule` crons, and Kubernetes CronJobs. A frequent timer usually means
  the design should react to an event instead. With no files it checks every
  tracked file, so `--list` (or `git grep schedule-justification`) is the
  complete inventory. Also the `repo-check-schedules` pre-commit hook.
- `repo-watch-prs` — watch auto-merge lifecycle for pull requests in the
  current repository.
- `repo-pr-status [--json] [--repo OWNER/NAME] [PR]` — one read-only
  snapshot of a pull request at its current head (default: the current
  branch's PR): head SHA, mergeability and merge state, required checks,
  auto-merge disposition, and unresolved review threads, from one GraphQL
  read. It never polls; use `repo-watch-prs` to wait. `--json` prints one
  stable object (`state`, `reasons`, `head`, `mergeable`, `mergeState`,
  `autoMerge`, `requiredChecks`, `unresolvedThreads`). States and exits:
  `merged`, `ready` (green, mergeable, armed), and `waiting` (checks pending
  or merge state settling) exit 0; `blocked` and `closed` exit 2;
  `indeterminate` exits 3 when GitHub errors or the check evidence is not for
  the current head, and is never a success; usage errors exit 64. Blocking
  reasons are `checks-failed:<names>`, `dirty`, `unresolved-threads:<n>`,
  `draft`, and `auto-merge-unarmed`; waiting reasons are
  `checks-pending:<n>`, `mergeability-unknown`, `behind`, and
  `merge-state:<STATE>`.
- `repo-set-tmux-task-title [--force <title>]` — set an empty tmux window task
  title from a Codex `UserPromptSubmit` hook payload, without overwriting a
  pinned title; `--force` explicitly pins or replaces a title for manual use.
- `repo-safe-remove-worktree` — validate and safely remove a completed
  feature worktree, including clean worktrees with initialized submodules.
- `repo-sweep-worktrees [--repo <checkout>] [--base <ref>] [--delete]` —
  audit every linked worktree of a checkout and, with `--delete`, remove the
  ones whose work has landed (ancestor of the base, or exact merged PR head
  whose merge commit is on the base) that are clean and unoccupied;
  dirty, live, open-PR, and unverified worktrees are reported and kept. A
  rejected or missing `gh` credential is reported as
  `unverified:gh-auth-failed` and the command exits 77 after the report, so a
  scheduled run fails loudly instead of pinning every worktree forever. Run
  it from the primary checkout, on a schedule, as the backstop for sessions
  that never completed their own teardown.
- Exact merged-head evidence also covers renamed branches and detached review
  checkouts. An open PR with the same head still protects the checkout.
- `repo-prune-merged-worktrees [--repo <checkout>] [--base <ref>] [--fetch]
  [--delete] [--session-only] [<worktree-path>]` — the shared pruning entry
  point, using the sweep's merge and ownership evidence. It audits by default;
  `--delete` applies removal. A named target returns nonzero if it could not
  be removed. `--session-only` preserves the original Sprinkles scope of
  `.claude/worktrees` and `.codex/worktrees`; otherwise it covers all linked
  worktrees. `--fetch` explicitly refreshes origin before checking ancestry.
  A repository with associated resources may supply `--remove-hook <executable>`;
  it receives the worktree path and safe-remover executable, holds its resource
  locks around that remover, and reclaims only its own resources afterward.
  Audits never invoke hooks. Consumer cache formats and Docker rules stay in
  the consumer adapter.
- For explicitly authorized disk cleanup of inactive unmerged work, add
  `--park-unmerged --idle-hours 36 --delete`. A successful result is `PARKED`,
  not a claim that the work merged. File/directory modification times and
  worktree/branch reflogs must all be older than the cutoff; reads do not count.
  Dirty, live, locked, nested, open-PR-owned, and unverifiable work stays.
  Parking keeps the branch and creates a protected Git ref for the exact
  commit, including detached HEADs. It saves and verifies a private compressed
  checkout under the owning Git common directory's `parked-worktrees/` before
  removal. Only ignored, untracked `node_modules`, `.nx`, `.next`, `.venv`,
  `__pycache__`, and `.turbo` directories are omitted. Tracked files, other
  ignored local inputs, and symlinks are preserved. Archives have private
  permissions and must not be published because they may contain local secrets.
  Apply rechecks activity, ownership, HEAD, cleanliness, and live processes.
  Consumer resource adapters are required just as for merged cleanup.
  The supplied remover rechecks the archived files inside the adapter's locked
  transaction. A resource refusal leaves the checkout intact and discards its
  prepared archive/ref so retries do not accumulate duplicate backups.
- When the owner explicitly authorizes retirement of every checkout older than
  a window, use `--park-inactive --idle-hours 36 --delete` instead. This parks
  qualifying checkouts regardless of merge or PR status, always preserves
  branches/history/files, and requires no GitHub access. It does not change PRs
  or remote branches. A positive age window is mandatory; the same local
  inactivity, occupancy, resource, and archive-verification checks still apply.
  Scope the command to the authorized paths. Parking needs Linux process
  evidence and GNU find/tar.
- `repo-restore-worktree <archive-directory> [--path <new-path>]` verifies the
  archive checksum and protected commit before recreating the checkout. It
  restores the original branch when unchanged and available; otherwise it
  uses detached HEAD without resetting an occupied or newer branch. Run the
  repository's worktree setup command afterward to reinstall dependencies.
  Standalone empty owned `MERGE_RR` metadata and an optional regular
  `ORIG_HEAD` with a protected available commit closure are preserved in
  version-4 recovery
  archives; nonempty records, locks and other active operations remain guarded.
  Each archive includes its manifest and exact restore command. Archives and
  protected refs are retained until the owner explicitly disposes of them.
- For an explicit creation-age retirement grant, use
  `repo-prune-merged-worktrees --repo <primary> --retire-created-hours 72
  --delete <checkout>`, substituting the owner's positive hour window.
  Reliable Git-link filesystem birth time controls eligibility; recent writes
  and commit dates do not renew it. Unknown/future creation time stays.
  This mode does not consult GitHub or delete branches. It preserves exact
  HEAD and staged history with protected refs and an independent staged-object
  pack, the byte-exact index, retained working-file versions and absences, and
  untracked/ignored private inputs. Only the ignored caches listed above are
  omitted. A complete retained path/content inventory and the index are checked
  again inside the consumer resource lock, including newly added ignored files.
  Version-2, version-3 and version-4 archives restore into an empty `--no-checkout` worktree,
  preserving staged-versus-working differences and tracked deletions.
  Version 3 additionally preserves exact `config.worktree` bytes and modes for
  `user.name` / `user.email` only, with includes disabled during validation.
  It rechecks configuration inside the removal lock and refuses changed
  extension semantics, redirected files, unsafe modes or any other key.
  Group writes require the current primary group.
  Version 4 also preserves ordinary merges with a fully resolved index, exact
  private operation files and protected available merge objects. Preexisting
  missing advisory `AUTO_MERGE` state is recorded and preserved without
  reconstruction. Object inspection disables lazy fetching, and merge-control
  lock files remain protected.
  Live, locked, nested, initialized-submodule, split/sparse-index, unmerged,
  worktree-only configuration beyond regular owned identity-only settings,
  sparse-checkout patterns and other in-progress Git operations stay with
  explicit KEEP reasons.
  The safe remover's verified-snapshot option permits only this independently
  verified dirty state; it never waives occupancy or resource guards.
- With `repo-sweep-worktrees`, use `--path <worktree>` to scope it to one
  completed task. Both
  the sweep and `repo-audit-branches [--base main] [--fetch] [--branch NAME] [--delete] [--delete-remote]`
  use the same fail-closed merge/ownership checker. Reports are TSV with stable
  reasons; missing ownership evidence preserves work. No fetch is implicit.
  Non-ancestor tips use GitHub's commit-associated PR lookup for exact squash
  or rebase merge proof. Closed-PR recovery queries the candidate branch;
  neither path scans a recent repository-wide PR history window.
  `repo-audit-branches --no-pr-days N` also treats an unmerged, unoccupied branch as
  `abandoned:no-pr-Nd` when no PR in any state exists for it or its upstream
  name or any remote-tracking branch containing its tip, and its tip is older
  than `--no-pr-days N`. `--closed-pr-heads` treats an unmerged, unoccupied
  branch as `recoverable:closed-pr-N` when its tip is exactly the head of
  closed (or merged) PR N, which GitHub keeps and can restore from that PR; a
  branch pushed to after its PR closed is kept. Both rules are opt-in; without
  them unmerged work is kept.
  Local and remote branch deletion require separate flags; remote deletion uses
  the originally audited SHA and runs push hooks. A branch already absent from
  the live remote succeeds without an empty push; a failed remote lookup stops
  cleanup rather than claiming absence.
  Use `--branch NAME` for task-scoped cleanup of that local/remote name. A named
  deletion returns nonzero when the branch must be kept; the base and `HEAD`
  cannot be selected. A missing tracking ref requires live absence proof or a
  fetch before remote deletion. For a merged task whose worktree has already
  been safely removed, run from the primary checkout:
  `repo-audit-branches --base origin/main --fetch --branch <merged-head> --delete-remote`.
- `repo-nx` — run Nx with portable cache and linked-worktree safeguards.
  Explicit environment wins, followed by a worktree/primary checkout's
  `.nx-remote-cache.env`, then the account-wide
  `${XDG_CONFIG_HOME:-$HOME/.config}/nx/remote-cache.env`. Workstation
  reconciliation can rotate the last file without copying secrets into every
  checkout. Offline health checks still fall back to local computation.
- `repo-install-husky-hooks [PROJECT_HOOK_DIRECTORY]` — run after a project's
  Husky installation to keep hooks active in bare linked worktrees. The default
  directory is `.husky`. It places generated Husky runtime and a repo-tools
  dispatcher in Git's common directory and sets an absolute `core.hooksPath`.
  Every invocation runs the current worktree's tracked hook, preserving Husky's
  global init, arguments, stdin, and exit status. Project hook bodies are never
  copied. Missing bootstrap fails closed; unrelated hook configurations are
  refused. Rerun the installer after Husky setup (which restores its relative
  path), after moving the primary checkout, or when upgrading the runtime.

## GitHub authentication and provenance

Interactive and agent-driven shells use the installed `gh` command and its
normal user login. Do not place a wrapper named `gh` earlier on `PATH`, and do
not inject an App installation token into every command. Git's
`!gh auth git-credential` helper, repository administration, workflow
operations, and ordinary CLI commands then share one stable authentication
boundary instead of changing identity according to the current directory.

Agent provenance is recorded separately from authentication:

- linked worktrees use the worktree-scoped `agent-lcars-bot` commit identity;
- PR bodies record the provider and session or work-item source; and
- headless workflows use an App installation token only where the workflow
  explicitly supplies one.

GitHub's `mergedBy` field identifies the principal that executed the merge. It
is not implementation provenance: protected auto-merge may report
`github-actions`, while a direct merge reports the authenticated user or App.
Use the PR source metadata and commit authors for provenance, and use
`mergedBy` only as merge-execution evidence.

Hosts that opted into the retired ambient shim should remove only its link:

```sh
if [ -L "$HOME/.local/bin/gh" ]; then
  case "$(readlink "$HOME/.local/bin/gh")" in
    repo-gh-shim|*/repo-gh-shim) rm "$HOME/.local/bin/gh" ;;
  esac
fi
```

## Releasing

`pnpm release <version>` bumps the plugin version across every published
manifest — `.claude-plugin/marketplace.json`, `plugins/repo-tools/.claude-plugin/plugin.json`,
and `plugins/repo-tools/.codex-plugin/plugin.json` — in one atomic step and
commits the result. It validates all three files before writing any of
them, so a missing file or malformed version leaves the release untouched
rather than half-applied. It refuses a version that is not strictly greater
(by semver precedence) than the current one, and refuses manifests that
disagree with each other. CI applies the same non-decreasing check to every
pull request against its base, catching a release that became a downgrade
after a rebase. Run it from a feature worktree, then push and open
a PR as usual; it does not push or open the PR itself. When the version
change lands on `main`, the `Release tag` workflow tags that commit `vX.Y.Z`;
that tag is what consumers pin and what Renovate offers them. A change merged
without a release reaches consumers only with the next release.

## Pre-commit worktree guard

Consumers using [pre-commit](https://pre-commit.com/) can enable both commit
and content-push enforcement directly from this repository:

```yaml
default_install_hook_types: [pre-commit, pre-push]

repos:
  - repo: https://github.com/jlapenna/repo-tools
    rev: v1.5.3
    hooks:
      - id: repo-require-worktree
      - id: repo-require-worktree-push
```

First-party consumers pin a release tag: `rev: vX.Y.Z` here, and
`"@jlapenna/repo-tools": "github:jlapenna/repo-tools#vX.Y.Z"` in npm
consumers. Renovate's npm and pre-commit managers only look up git
dependencies by tag, so a `main` or bare-SHA pin is never updated; the shared
preset enables the pre-commit manager so both kinds of pin get bump PRs.
Pre-commit caches hook environments, so reinstall/refresh the environment when
updating shared tooling. Run
`pre-commit install --install-hooks` after updating the configuration.
Pre-commit skips its pre-push hooks for deletion-only pushes; content pushes
run the shared guard and are rejected from the primary checkout or `main`.

## Skills

The plugin exposes the authoritative skills listed in the generated inventory:

- `worktree-hygiene` covers safe creation, use, and teardown in shared
  repository checkouts.
- `github-ci-monitor` uses GitHub CLI for workflow runs and PR checks, and
  `repo-watch-prs` for protected auto-merge attention states.
- `testing-policy` guides test, CI-check, and control-flag decisions.
- `harness-maintenance` applies observed feedback to documentation, skills,
  context routes, and their owning contracts. Consumers keep local truth and
  authorization; structural checks do not prove better worker behavior.
- `autonomous-work` completes authorized tasks when the user is unavailable:
  resolve optional questions from evidence and reversible defaults, continue
  independent work around blockers, and report any unfinished actions. It is
  self-contained and needs no scheduler or agent runtime. Invoke it explicitly
  or say, for example, "I'm unavailable; keep working without questions."
- `land-pr` carries a local change or existing pull request through the
  complete delivery lifecycle: commit, push, PR, CI and review, protected
  merge, post-merge verification, and worktree/branch cleanup.
- `renovate-maintenance` audits and lands Renovate updates within a repository,
  with risk-based verification, sequential merges, combined-main validation,
  and explicit separation from deployment and production-state checks.
- `complexity-sweep` identifies active repositories, ranks unnecessary code
  complexity and stale maintenance paths, and implements verified priority
  fixes while preserving each repository's consumer contracts.

The plugin bundles the auto-merge watcher under `scripts/`, so
`github-ci-monitor` and `land-pr` work in a plugin-only installation. The npm
package exposes the same implementation through `repo-watch-prs` on `PATH`.
Workflow runs use `gh run list --commit <sha>` and `gh run watch <run-id>`;
PR checks use `gh pr checks`. See the skill for run selection and exit status.

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
