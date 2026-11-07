# Harness adapters for shared skill evals

Eval prompts, assertions, expected output and fixtures are independent of the
execution harness. Codex and Claude Code have built-in integrations. Another
harness plugs into the same command through an executable adapter:

```sh
repo-skill-evals --runner opencode --adapter /absolute/path/to/opencode-eval-adapter \
  --root .agents/skills --report /tmp/skill-evals/report -- --max-cost-usd 12
```

This selects an installed adapter; it does not install one or imply that
OpenCode, Goose, Antigravity or every other harness is already integrated.
An adapter owns its native client, authentication lifecycle, model selection,
isolated tool environment and child-process cleanup. The caller selects the
adapter and grants authentication; an eval document cannot select either.
No shell command is constructed from the eval or adapter arguments.

The built-in runners retain their current CLI, reports and authentication
contracts. New adapters consume the neutral request below rather than parsing
Claude plugin manifests, Claude tool calls or Codex app-server messages.

## Preflight

Before any evaluation, the command executes:

```text
adapter --describe <options after --, as separate arguments>
```

This operation must not run inference. It returns one JSON document on stdout:

```json
{
  "schema": "repo-skill-evals.adapter/v1",
  "harness": "opencode",
  "version": "1.0.0",
  "model": "resolved-case-model",
  "judgeModel": "resolved-judge-model",
  "capabilities": [
    "context.isolated", "skill.load", "file.read", "file.glob", "file.grep",
    "criteria.grade", "budget.usd"
  ]
}
```

`version` identifies the adapter and its material native-client dependencies.
Models identify the configured execution and grading models, including options
passed by the caller. Model identities must match the eventual result. The
adapter version, executable content hash, model identities, capabilities and
options participate in experiment keys; results from a different harness or
adapter cannot carry forward.

Only declare capabilities the integration implements. `context.isolated`
means cases see the supplied copied skills and fixtures, without ambient
repository tools, hooks, plugins or MCP access. The four read-only logical
tools map to each harness's native tools. Scoped tool restrictions must be
preserved; scoped cases additionally require `tool.restrictions`. Additional tools remain subject to the existing explicit
`--allow-gated-tools` operator grant. Unsupported capabilities fail before
the adapter's evaluation operation starts.

`criteria.grade` is required for behavior assertions. `budget.usd` is required
when the caller supplies `--max-cost-usd`: the adapter must check the shared
budget before each paid case or grading turn, with at most one in-flight turn
of overrun. Preserve unknown usage and cost; never manufacture zero usage or
spend. Models without a usable budget mechanism must refuse a budgeted run.

## Evaluation request

The command then executes `adapter REQUEST_JSON RESULT_JSON`, with two absolute
file paths. Read the request and write the result atomically to the supplied
destination. Progress goes to stderr. The request includes:

- `schema`, `harness` and the preflight `adapter` identity;
- caller `arguments` and parsed `budgetUsd` (null when unspecified);
- `skills`: names, copied skill `directory` paths and `manualOnly` flags;
- `cases`: `id`, `skill`, unchanged `prompt`, `invocation` (`automatic` or
  `explicit`), `expectedOutput`, `rubric`, `trigger`, `runs`, `maxTurns`,
  `timeoutSeconds`, logical `tools` and the copied `resources` path or null.

For example, a logical tool is
`{"capability":"file.read","restriction":null}`. Restrictions retain the
existing allowed-tool scope. Explicit invocation means load the named skill
using the harness's native mechanism; the prompt is not prefixed with Claude's
slash-command syntax. Automatic invocation measures whether the harness loads
the skill from its name and description.

The adapter must honor the complete case deadline, including preparation,
execution, tools and grading, and stop further paid work on provider or usage
errors. The parent also bounds the process by the sum of declared case
deadlines plus ten seconds. The adapter owns terminating its native children.

## Result and evidence

Write the versioned result using the exact preflight model identities:

```json
{
  "schema": "repo-skill-evals.adapter/v1",
  "harness": "opencode",
  "adapterVersion": "1.0.0",
  "model": "resolved-case-model",
  "judgeModel": "resolved-judge-model",
  "partial": false,
  "costUsd": null,
  "durationSeconds": 1.2,
  "cases": [{
    "id": "triage--service-failed",
    "runs": [{ "tracePath": "service-failed.trace.jsonl", "criteriaPassed": true }]
  }]
}
```

Trace paths must resolve inside the request/result output directory. Keep
native evidence in these private JSONL traces and normalize the following
observations alongside it:

```jsonl
{"type":"skill.loaded","skill":"triage"}
{"type":"response","text":"The actual final response"}
{"type":"criteria.judged","model":"resolved-judge-model","passed":true}
```

Record `skill.loaded` only when the native harness actually loads the named
skill. The common reporter derives trigger grades from that observation,
independent of a claimed rubric pass. Behavior cases require the response and
matching judge evidence. Explicit-only skills have no trigger grade. A failed
run may provide `error` instead of grades; missing runs and invalid evidence
remain partial and unscored. Unknown or duplicate cases and changed model
identities are rejected.

The command converts this response into the existing report, baseline, cache
and private history formats. Both the original adapter result and normalized
results are retained. Exit codes remain 0 for all required grades passing,
1 for a real failure and 2 for partial execution; a nonzero adapter exit is
preserved. Keep authentication and credential directories out of traces.
