---
name: skill-evals
description: Measure whether a repository's agent skills trigger and behave as intended by running their committed evals.json prompts through Codex, Claude Code, OpenCode, Goose or Antigravity, and keep eval coverage honest. Use when asked to eval, test, benchmark, score or validate a skill or a repository's skills, to check that a skill description triggers on real requests, to write or fix eval prompts and assertions, when a skill's evals fail, error, or seem to need hosts, credentials or a checkout, or before and after editing a SKILL.md description or body. Not for evaluating models or inference servers.
---

# Skill evals

Score committed cases with `repo-skill-evals` and read its actual per-case evidence. The unit
of proof is a committed eval prompt with checkable assertions, run through
`repo-skill-evals --runner codex`, `--runner claude`, or an explicitly selected
`--runner NAME --adapter EXECUTABLE`, and read back per skill. Read
[evals format](references/evals-format.md) before writing or editing an
`evals.json`.

Before running, consult [evaluation history](https://github.com/jlapenna/repo-tools/blob/main/docs/evaluation-history.md)
and the consumer's shared registry/memory for prior matching attempts. Keep
baselines, failed runs and discarded hill climbs for at least 90 days. The
runner now archives private snapshots/results/traces automatically and reports
recent matches; record why an unchanged input needs another run. This lookup
does not replace required regression checks or establish model-version parity.
Before scratch cleanup, verify the archived run ID and evidence. Publish a
bounded summary with that ID, owning host/path and protected report reference
to the consumer's already-authorized registry/memory; a missing local worktree
or local-store miss does not erase another host's run. Keep raw traces and
credentials out of public source. When retention/publication is already part
of the user's request, complete it without asking for the same permission
again; a new external destination still needs its own authority.

## Harness selection

Keep prompts, fixtures and assertions shared between harnesses. Choose execution
and authentication at the command or job-profile boundary. The built-in Codex
and Claude runners use the same committed cases. Other harnesses integrate through
the [versioned executable adapter contract](https://github.com/jlapenna/repo-tools/blob/main/docs/skill-eval-adapters.md),
which maps native skill-loading evidence and rubric judgments into the same
reports, history and cache. An adapter must implement the declared isolation,
tools and budget capabilities; a new harness name alone does not provide them.
Provider-specific execution options belong after `--`, not in eval prompts.

## Native harness selection

Keep one committed suite across all harnesses. Select `--runner opencode`,
`--runner goose` or `--runner antigravity` (alias `agy`) with an explicit
case and judge model. Read [native harness setup](https://github.com/jlapenna/repo-tools/blob/main/docs/skill-eval-native-harnesses.md)
for caller-owned auth, bounded tools and unknown-cost behavior. Qualify the
actual native binary; an adapter fixture alone is not qualification.
Use shared `--case PATTERN` before `--` to select a small committed case first.
Never change credentials or account limits to hide a provider failure.

## Codex execution

`--runner codex` (or `REPO_SKILL_EVALS_RUNNER=codex`) evaluates the same
committed prompts and assertions using the installed Codex app-server.
It requires a dedicated `CODEX_HOME` containing authentication only, with no
config.toml, hooks, plugins or MCP servers. The caller owns authentication
and any rotating subscription lease; never copy a live workstation login to
another host or put rotating auth.json in a static secret binding.

Cases see skill names/descriptions and load a matching skill through an
observed `Skill` tool call. Only bounded `Skill`, `Read`, `Glob` and literal
`Grep` tools can read copied skill references and fixtures. Shell, network,
write and live repository tools are not granted. A separate Codex thread
judges each rubric against the actual response and full tool trace. This is a
Codex backend with its own trigger/tool semantics, not a claim of model or
Claude-runner parity.

The reviewed default is `gpt-6.1-sol`, low reasoning, for cases and judges.
Use `-- --model gpt-6.1-sol --judge-model gpt-6.1-sol --ablation none
--max-cost-usd 12 -j 2`. Models without reviewed list prices and unsupported
options are refused before inference. Case/judge turns run sequentially in
one app-server (concurrency is an upper bound). The list-price estimate is
checked before every paid turn, so overrun is bounded to one in-flight turn;
it is not billed spend or subscription quota. Provider/usage errors stop
further cases and produce partial, unscored reports. A subscription quota
or rate-limit stop sets `partialReason: "provider-limit"` so a caller can rerun
the same suite on another harness; other failures keep "provider or grading
error". Native ACP harnesses (including Antigravity quota codes such as
`RESOURCE_EXHAUSTED`) and the stock Claude runner (weekly, usage, spend and
credit limits) report the same reason. The existing report,
baseline, cache and history interfaces remain; provider and judge identity
participate in experiment keys, so Claude scores cannot carry into Codex.

Without a runner selection, the command retains the Claude backend. The
sections below describe its stock-runner flags and behavior.

## 1. Check coverage first

Run from the repository root (or pass `--root` for a skills directory):

```bash
repo-skill-evals --list [--evals-root <dir>]
```

It lists every `*/SKILL.md` below the root with its eval source and case
count. A skill with `no evals` cannot be scored; add prompts before claiming
anything about it. `--evals-root` names a central directory laid out as
`<root>/<skill>/evals.json` or `<root>/<group>/<skill>/evals.json` for
repositories that keep evals outside skill directories.

Structure is checked separately and cheaply by the stock validator, which
reports frontmatter that does not parse: `claude plugin validate <dir>`.

## 2. Run the evals

```bash
repo-skill-evals [--skill <name>]... [--runs N] [--trigger-only] [--out <dir>] \
  [--report <dir>] [--baseline <file>] [--max-age <days>] [--no-carry] \
  [--cache [<dir>]] [-- <claude plugin eval options>]
```

The command copies the selected skills into a temporary wrapper plugin,
writes one case per eval entry (prompt, a `tool_used` grader proving the
skill fired, an `llm` grader built from the entry's assertions or
expected_output, fixture files under `resources/`), runs
`claude plugin eval` there, and prints one row per skill: cases, mean score,
how many runs fired the skill, and the graders that failed. `--json` prints
the same as one object. Results, the wrapper and `results.json` stay under
`--out` (default: a private directory under the durable evaluation history).

Cost and scope rules:

- Every run and every `llm` grader is a real model call on the caller's
  account. Start with `--trigger-only` (description check, three turns, no
  judge) and `--runs 1`; pass `-- --max-cost-usd <n>` for any run wider than
  a handful of cases. Add `-- --ablation with-without` only when the question
  is whether the skill helps at all, since it doubles the runs.
- Runs are sandboxed with a temporary home and no repository, MCP servers,
  hooks or `CLAUDE.md`. A prompt that needs live hosts, credentials or a
  checkout is testing the sandbox, not the skill: write prompts that ask for
  the plan, the exact commands or a decision, and assert on those.
- Single runs are noisy. Confirm a regression with `--runs 3` before editing
  a skill because of it, and compare before and after on the same cases.
- On Linux the runner needs `bubblewrap` and `socat`; it refuses to run
  without a sandbox backend. Nothing in a case may write outside its
  workspace.
- A case whose `plugin_eval.allowed_tools` grants `Bash`, `PowerShell`,
  `Write`, `Edit`, `WebFetch` or any `mcp__*` tool is refused before the
  runner starts: LCARS worker pods have no sandbox backend, so the runner
  would reject the case there. Do not commit such cases; rewrite the prompt
  to ask for commands or a decision. `--allow-gated-tools` opts out for a
  workstation run only.

Job reports: `--report <dir>` writes `<dir>/report.md` (header with roots,
revision, runner version and date; the per-skill table; skills without
evals; errored runs; and, for every skill that fired below its run count or
scored under 0.67, each failed case's prompt and grader evidence) and
`<dir>/result.json` as `{ report, complete, data }`, where `complete` is
true only for runner exit 0 with no partial run and `data` carries the
summary rows, exit, partial state, the runner's list-price cost estimate
(not billed spend), duration, case counts and the baseline comparison.
`--baseline <file>` takes a previous `result.json` (or its `data` object)
and adds a "Changes since baseline" section, regressions first; a missing
or unparsable baseline is an error before anything runs. Automation such
as an LCARS recipe reads `result.json` directly.

Identical experiments are never re-run. Each case has an experiment key
hashing the skill directory (minus `evals/results` and `node_modules`), the
generated case spec, its fixtures, the `claude --version`, the model from
`-- --model` and the repo-tools version; `data.cases` records each case's
key, score, fired, graders and `runAt` without evidence. A case whose key
matches a `--baseline` case run within `--max-age` days (default 28) is
carried forward instead of sent to the runner; if every case carries,
claude is not invoked at all. Rows and the report combine fresh and carried
cases, the report marks carried ones with their age, and only fresh cases
are compared for regressions. `--no-carry` re-runs everything; `--cache
[<dir>]` (default `$XDG_CACHE_HOME/repo-skill-evals`, else
`~/.cache/repo-skill-evals`) gives workstation runs the same carry-forward
without a baseline file.

## 3. Read the result and act

- `fired` below the run count means the description did not trigger on a
  prompt its owner expects it to. Fix the description (what it does and when
  to use it, including the plain phrasing users actually type), not the
  prompt, unless the prompt was out of scope.
- For a failed `criteria` grader with the skill fired, inspect the actual
  evidence and judge-vote spread in `report.html` before changing guidance.
  Preserve the original score; a disputed grade is not an automatic pass or
  proof of a missing rule. Check the recorded grader `focus`: `last_message`
  does not expose the full tool trace to that judge. A plan-only prompt must
  be judged on its proposed workflow, not on forbidden real execution. Keep
  intermediate-action claims with a trace-aware check and record any proposed
  grading-contract change as a new comparison, never a silent score fix.
- Exit status is the runner's: 0 when every case met the threshold (default
  1.0, override with `-- --threshold 0.67` for noisy cases), 1 for a case
  below threshold or a load error, 2 for a partial run stopped by the cost
  ceiling or a rejected credential.

Report the cases run, cost, the per-skill table, and the skills still
without evals. Do not report a score for a skill whose runs errored.

Iterating on one skill's description with generated trigger queries belongs
to the official `skill-creator` plugin; its `evals.json` format is the one
this command reads, so the same prompts serve both.
