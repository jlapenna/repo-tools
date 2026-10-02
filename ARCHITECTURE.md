# Architecture

repo-tools packages repository-safe commands, reusable workflow skills, and a
shared ESLint implementation. It is infrastructure consumed by agents and
repositories, but it does not own an agent runtime.

## Delivery Flow

```text
source modules
  |-- bin/ command implementations
  |-- plugins/repo-tools/skills/ workflow guidance
  |-- eslint/ shared lint rules
  v
package + Codex/Claude plugin manifests
  v
consumer repositories and agent runtimes
```

Consumers install or reference these interfaces. They retain their own
repository policy, check names, deployment rules, and product behavior.

## Ownership Map

| Concern | Source of truth | Evidence |
| --- | --- | --- |
| CLI behavior | implementation in `bin/` | adjacent `*.test.*` scripts |
| Safe worktree lifecycle | `worktree-hygiene` skill and removal commands | worktree and process tests |
| CI monitoring | watcher commands and `github-ci-monitor` skill | watcher tests |
| PR delivery workflow | `land-pr` skill | skill validation and real protected consumers |
| Testing policy | `testing-policy` skill and reference | documented examples |
| Plugin topology | `.claude-plugin/`, `.agents/`, `plugins/` manifests | `plugins/manifests.test.mjs` |
| ESLint rules | `eslint/` | build, consumer contract, Vitest rules |
| Public interface inventory | package and skill manifests | generated `docs/interfaces.md` check |

## Runtime-Neutral Boundary

repo-tools may inspect repository state and coordinate generic Git/GitHub
operations. It must not contain:

- agent identity or session ownership;
- Agent LCARS dispatch/runtime behavior;
- consumer-specific branch protection or deployment policy;
- copied skill bodies inside consumer repositories.

Agent LCARS may invoke these tools, while Homelab and application repositories
may consume them. Those systems own their local authorization and operational
decisions.

## Change Shape

- Keep a command and its regression test adjacent in `bin/` where practical.
- Put cross-repository decision guidance in a skill, not a command help dump.
- Keep provider manifests as projections of the same plugin source.
- Regenerate `docs/interfaces.md` after package or skill interface changes.
- Preserve machine-readable output and exit semantics; callers compose these
  tools in hooks and automation.

## Proof Ladder

1. Run the focused command, manifest, or rule test while iterating.
2. Run `pnpm test:docs` for documentation/interface changes.
3. Run `pnpm test` for the complete command, plugin, build, and lint-rule gate.
4. Require protected CI on the exact PR head.
5. Validate behavior in a consumer only when the change affects an integration
   contract; consumer deployment remains outside this repository.
