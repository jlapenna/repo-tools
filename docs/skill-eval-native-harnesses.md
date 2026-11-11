# Native skill-eval harnesses

All five built-in runners consume the same committed `evals.json` prompts,
assertions and fixtures. Select the harness at invocation; eval documents do
not select credentials, models or executable code.

| Runner | Native execution | Authentication owner |
| --- | --- | --- |
| `claude` (default) | Stock `claude plugin eval` | Native Claude Code login or caller credential |
| `codex` | Codex app-server, read-only dynamic tools | Caller-owned auth-only `CODEX_HOME`; rotating leases stay with the caller |
| `opencode` | OpenCode ACP, `--pure` | Explicit provider configuration and named credential environment |
| `goose` | Goose ACP | Explicit provider/model and native provider environment |
| `antigravity` (`agy`) | Antigravity ACP with a fresh Gemini configuration root | Existing native application login directory, never a token copy |

Installed binaries are prerequisites. Package installation does not install,
log in to, upgrade or change defaults for these native applications. The native
ACP clients require an explicit `--model` (or, for unattended callers,
`REPO_SKILL_EVALS_MODEL`; a `--model` flag wins); the judge defaults to the same
model. A model must be advertised by the native session and a model change
must be acknowledged before a prompt is submitted. Case and judge use separate
sessions. Sessions, tool calls, timeouts, failures and unknown usage remain
visible in the retained evidence.

For example, first select one committed case for a bounded qualification:

```bash
repo-skill-evals --runner antigravity --skill deploy \
  --case 'deploy--coverage-first' --runs 1 --report /private/eval-report \
  -- --model gemini-4-argon --ablation none
```

The model here is an example, not an automatically selected default. Use a
value of the native session's stable `model` config option. Antigravity lists
model families there (`gemini-4-argon`) with a separate `thought_level`
(default `medium`); per-thought-level ids such as `gemini-4-argon-medium` from
its unstable model list are refused before inference, and the error names the
advertised values. `--case` before `--` filters
the shared suite before snapshots, cache lookup, inference and reporting.

## Native configuration

OpenCode receives a fresh home/config/data/cache, no project checkout and
`--pure`. Set `REPO_EVAL_OPENCODE_PROVIDER` to the native `provider` object
(JSON), with credential references such as `{env:MY_API_KEY}`. List only the
needed environment names in comma-separated `REPO_EVAL_OPENCODE_ENV`; names
must end in `KEY`, `TOKEN`, `HOST` or `URL`. Ambient OpenCode configuration,
instructions, plugins and skills are excluded. No personal auth file is copied.

Goose receives a fresh `GOOSE_PATH_ROOT`, no configured extensions, and approve
mode. Only this run's MCP read tools are preapproved; other permission requests
are cancelled. The caller supplies `GOOSE_PROVIDER`, `GOOSE_MODEL` and the
selected native provider variables (`LITELLM_HOST`/`LITELLM_API_KEY`,
`OPENAI_HOST`/`OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`). This adapter neither
enables the scheduler nor copies the caller's Goose configuration.

Antigravity excludes default customizations and starts a separate native
process/session. Its private Gemini root links to the caller-owned native
application directory so the native application retains rotating-login writes;
no token is read or cloned by the adapter. A unique temporary settings directory
is removed after the owned process exits. Override the application directory
with `REPO_EVAL_ANTIGRAVITY_AUTH_DIR` when it is not
`~/.gemini/antigravity-cli`.

Override a binary explicitly with `REPO_EVAL_OPENCODE_BINARY`,
`REPO_EVAL_GOOSE_BINARY` or `REPO_EVAL_ANTIGRAVITY_BINARY`.

## Tools and budgets

ACP sessions advertise no client filesystem or terminal capability. Their
only supplied MCP server exposes the same bounded `Skill`, `Read`, `Glob` and
literal `Grep` tools as Codex. Native shell, web, edits and arbitrary file
permissions are denied. Antigravity can spill long MCP results to files;
its adapter permits a native read only for a current-session spill file whose
contents exactly equal an already observed bounded MCP result. This preserves
full skill text without granting repository or host-file access.

Tool-call limits and case deadlines are enforced. The native child process
group is terminated on timeout or completion. Temporary workspaces and configuration are removed; native authentication
and application-owned session history remain owned by the application. Raw evidence is private evaluation history, never public source.

The eval workspace contains copied skills and declared fixtures, not the source
checkout. Skill loading lists its supplied files; a missing reference reports
that it was not supplied. Plan-only cases should use that guidance and identify
missing evidence rather than search for a checkout or live host. Native cases
receive their existing call budget explicitly; failed requests and `Skill`
calls count toward it. This does not grant more calls or filesystem access.

Codex tool events are written as they occur, including a rejected call at the
limit. Failed case and judge traces remain archived and unscored; a judge error
does not overwrite the completed case evidence. Reusing an output directory
cannot attach an earlier successful trace to a new failed invocation.

ACP context occupancy (`used`/`size`) is not billed token usage. A valid native
USD cost is retained; missing usage or another currency stays **unknown**, not
zero. `--max-cost-usd` is checked before each case/judge prompt, with overrun
bounded to one in-flight prompt. If a budgeted prompt returns no valid USD
usage, evaluation stops partial before further prompts. Do not use a claimed
USD cap as a credit/subscription quota or convert currencies by guessing.
Antigravity's ACP reports no USD usage, so a budgeted Antigravity run stops
after its first prompt. An unattended caller whose login is billed by
subscription quota sets `REPO_SKILL_EVALS_QUOTA_BILLED=1`; the cap is then
ignored with a logged notice, cost stays unknown, and an exhausted quota still
settles as `provider-limit`.
Codex retains its separately reviewed token-price estimate and default ceiling.

## Qualification

A fixture protocol test is not proof of a native harness. Qualify an installed
native binary with a real committed case and read its skill-load trace,
response, independent rubric verdict, model/version, usage and exit status.
Retain failed attempts and source changes explaining any retry. An account
quota or authentication error remains unscored and blocks qualification; do
not switch credentials or raise account limits to hide it. A passing case
establishes that bounded integration, not model parity or whole-suite quality.

A future harness can implement the [executable adapter contract](skill-eval-adapters.md).
