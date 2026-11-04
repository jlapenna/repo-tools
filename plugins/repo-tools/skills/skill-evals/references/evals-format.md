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
| `assertions` (or `expectations`) | no | The `llm` grader rubric: PASS only if every statement holds. |
| `expected_output` | no | Rubric when there are no assertions; otherwise shown to humans as the expected outcome. |
| `files` | no | Fixture paths relative to the `evals.json` directory, copied into the case's `resources/` and granted read-only. |
| `plugin_eval` | no | Per-entry runner overrides: `runs`, `max_turns` (default 8), `timeout_seconds` (default 600), `allowed_tools` (default `Skill, Read, Glob, Grep`). |

Write assertions a judge can verify from the final message or the trace:
a named file, command, decision, ordering or refusal. Avoid assertions about
tone or about work that happens outside the sandbox. Two or three per entry
is enough; one obvious prompt and one that uses the user's plain wording
covers most description regressions.

A `--trigger-only` run keeps only the `skill-fired` grader and caps each run
at three turns, so an entry with just a `prompt` is a valid trigger test.
