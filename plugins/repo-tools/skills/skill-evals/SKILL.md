---
name: skill-evals
description: Measure whether a repository's agent skills trigger and behave as intended by running their committed evals.json prompts through the stock Claude Code runner (claude plugin eval), and keep eval coverage honest. Use when asked to eval, test, benchmark, score or validate a skill or a repository's skills, to check that a skill description triggers, to add evals to a skill, or before and after editing a SKILL.md description or body. Not for evaluating models or inference servers.
---

# Skill evals

Score skills with the stock runner instead of hand-built harnesses. The unit
of proof is a committed eval prompt with checkable assertions, run through
`claude plugin eval` and read back per skill. Read
[evals format](references/evals-format.md) before writing or editing an
`evals.json`.

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
  [-- <claude plugin eval options>]
```

The command copies the selected skills into a temporary wrapper plugin,
writes one case per eval entry (prompt, a `tool_used` grader proving the
skill fired, an `llm` grader built from the entry's assertions or
expected_output, fixture files under `resources/`), runs
`claude plugin eval` there, and prints one row per skill: cases, mean score,
how many runs fired the skill, and the graders that failed. `--json` prints
the same as one object. Results, the wrapper and `results.json` stay under
`--out` (default: a timestamped directory in the system temp dir).

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

## 3. Read the result and act

- `fired` below the run count means the description did not trigger on a
  prompt its owner expects it to. Fix the description (what it does and when
  to use it, including the plain phrasing users actually type), not the
  prompt, unless the prompt was out of scope.
- A failed `criteria` grader with the skill fired means the body did not
  carry the behavior the assertion names. Read the run in `report.html`
  under the results directory before changing anything; the judge sees the
  final message and the trace, so assertions about intermediate steps need
  the step to be visible there.
- Exit status is the runner's: 0 when every case met the threshold (default
  1.0, override with `-- --threshold 0.67` for noisy cases), 1 for a case
  below threshold or a load error, 2 for a partial run stopped by the cost
  ceiling or a rejected credential.

Report the cases run, cost, the per-skill table, and the skills still
without evals. Do not report a score for a skill whose runs errored.

Iterating on one skill's description with generated trigger queries belongs
to the official `skill-creator` plugin; its `evals.json` format is the one
this command reads, so the same prompts serve both.
