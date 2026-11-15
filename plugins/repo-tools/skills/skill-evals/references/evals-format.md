# evals.json format

`repo-skill-evals` reads the skill-creator plugin's `evals.json`, so one file
serves both tools. Commit it at `<skill>/evals/evals.json`, or for a
repository that keeps evals outside its skill directories, at
`<evals-root>/<skill>/evals.json` (or one directory deeper) and pass
`--evals-root`.

```json
{
  "skill_name": "oncall",
  "evals": [
    {
      "id": 1,
      "name": "probe-failing",
      "prompt": "The Headscale HTTP probe is failing. Tell me what you would check first and the exact commands, without running anything.",
      "expected_output": "Reads the service logs before changing configuration and names the reconcile that applies the fix.",
      "files": [],
      "assertions": [
        "Checks the container logs before proposing a configuration change",
        "Names the reconcile step that applies the change",
        "Says the incident is logged in docs/incidents.md"
      ]
    }
  ]
}
```

| Field | Required | Used for |
| --- | --- | --- |
| `prompt` | yes | The user turn of the case. |
| `name` | no | Case name `<skill>--<name>` (lowercased, non `[a-z0-9._-]` runs become `-`); defaults to `eval-<id>`. |
| `assertions` (or `expectations`) | no | One `llm` grader per statement (`criteria-1`, `criteria-2`, ...; a single statement is `criteria`). The case scores the share that hold, and a report names each failed statement. The judge is told the agent had read-only tools, so a proposed step satisfies a statement about running it. |
| `expected_output` | no | Rubric when there are no assertions; otherwise shown to humans as the expected outcome. |
| `files` | no | Fixture paths relative to the `evals.json` directory, copied into the case's `resources/`, granted read-only, and listed by absolute path at the end of the prompt so the agent can find them. |
| `execution` | no | Shared per-entry limits: `runs`, `max_turns` (default 8), `timeout_seconds` (default 600), `allowed_tools` (default `Skill, Read, Glob, Grep`). These are logical capabilities mapped by the selected harness. |
| `plugin_eval` | no | Existing spelling of `execution`, retained for committed cases. Use one field, not both. |

The same prompts, assertions, expected output and fixtures work across harnesses.
Execution limits do not select a harness, model, adapter executable or credentials;
the caller owns those choices. An adapter receives explicit invocation separately
from the unchanged prompt, using its native skill-loading mechanism.

`allowed_tools` must not grant `Bash`, `PowerShell`, `Write`, `Edit`,
`WebFetch` or any `mcp__*` tool (including scoped forms such as
`Bash(git status)`). The runner only grants those with an operator
`--allow-tools` flag and a sandbox backend, and LCARS worker pods have no
sandbox, so `repo-skill-evals` refuses such a case by name before running
anything. Such entries must not be committed; `--allow-gated-tools` exists
only for workstation runs.

Write assertions a judge can verify from the final answer: a named command,
decision, ordering or refusal. The stock Claude runner's judge is a small
model (Haiku unless `--judge-model` overrides it) grading with
`focus: last_message`, so it reads the answer literally and does not see the
tool trace. Rubrics that fail for reasons unrelated to the skill share a few
shapes:

- **Execution verbs on a plan-only case.** "Opens a ready PR" is graded as an
  action that never happened when the prompt says "don't run anything" or the
  sandbox has no repository. Phrase it as "The plan opens a ready PR…" and add
  that a proposed step is enough.
- **Tool-use claims.** "Reads references/x.md" is not visible in the last
  message. Assert on the decision the reference teaches instead.
- **Packed bullets.** One assertion that lists four requirements fails on
  whichever one the answer phrased differently. State one requirement each.
- **Unasked or stale requirements.** A requirement the prompt never raises,
  or a detail the current skill contradicts, measures the rubric rather than
  the skill. Re-read the rubric when the skill changes.

Prefer requirements the skill actually teaches over generic good practice, so
the with-without lift shows whether the skill helps. If both arms score zero
on an answer that reads correctly, suspect the rubric before the skill. Avoid
assertions about tone or about work that happens outside the sandbox. Two to
four per entry is enough; one obvious prompt and one that uses the user's
plain wording covers most description regressions.

A skill with `disable-model-invocation: true` never fires on its own: its
cases carry no `skill-fired` grader, `--trigger-only` skips it, and a behavior
case sends `/<skill-name> <prompt>` so the judge grades the skill's work.

A `--trigger-only` run keeps only the `skill-fired` grader and caps each run
at three turns, so an entry with just a `prompt` is a valid trigger test.

Any edit to a file in the skill directory, including its `evals/evals.json`
and fixtures there, changes the experiment key of every case of that skill,
so all of them run again; results under `evals/results` do not. With
central evals (`--evals-root`), editing one entry re-runs only that case.
