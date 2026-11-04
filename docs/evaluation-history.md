# Retain and consult evaluation history

Use one private history for regular skill/model evaluations and optimization
attempts, including baselines, failures, discarded candidates and inconclusive
results. The owner deciding whether to run again is the consumer of this record.
This is provenance storage, not another evaluator or a claim that an old score
still applies.

## Store and discovery

`repo-eval-history` uses `$EVAL_HISTORY_DIR`, otherwise
`${XDG_STATE_HOME:-~/.local/state}/eval-history`. Every run has a unique ID,
private directory, atomic JSON record and checksummed copies of selected
artifacts. Records and copied files are private to the owning account.

The default lookup window is 90 days. It does **not** delete older records;
`find --days 0` includes all ages. There is no automatic pruning. Keep records
and the evidence needed to reproduce their conclusion for at least 90 days,
then retire them only through an explicitly authorized cleanup. Worktree or
temporary-directory cleanup must not remove this store.

Point `EVAL_HISTORY_DIR` at durable storage for ephemeral CI/jobs, or preserve
the history directory through the consumer's existing artifact mechanism before
the job disappears. A pod-local filesystem is not durable retention. Local
stores are per account/host unless configured to a shared filesystem. Consult
the consumer's shared registry or memory as well; a local miss does not establish
that another host has not already done the work. Include the owning host/path
and bounded report link in cross-host summaries. No new service is required.

```bash
repo-eval-history find --subject x1c-readiness --days 90
repo-eval-history show --id <run-id>
```

Inspect prior conditions and conclusions before launching a regular eval or
hill climb. Reuse an earlier measurement only when the material inputs match.
An input fingerprint is a lookup aid, not evidence of generalization. For a
deliberate repeat, record what changed or why additional samples are needed.
Do not rerun discarded hypotheses merely because their task checkout is gone.

## Record a regular eval or hill climb

Create an inputs JSON file describing repository/revision and source hashes,
suite/cases/fixtures, generator and grader revisions/models, sampling/seeds,
budgets, metric/extraction/direction and material runtime conditions. For an
experiment add its hypothesis, parent baseline and patch/source checksum.
Model aliases such as `default` are not resolved model revisions: verify those
conditions before reusing a result. Keep credentials and isolated SDK state out.

```bash
repo-eval-history begin --kind model --subject tool-use --inputs inputs.json \
  --summary 'Compare candidate with baseline'
# Save the returned id; execute the existing evaluator, preserving exit status.
repo-eval-history finish --id <run-id> --status completed --result metrics.json \
  --summary 'Baseline retained; candidate regressed' --artifact report.html \
  --artifact results.tsv --artifact candidate.patch
```

Statuses include `completed`, `failed`, `partial`, `kept`, `discarded` and
`inconclusive`. `completed` describes execution, not a successful optimization.
Use `record` with the same arguments to import an already-finished effort.
Copied artifacts must be explicitly selected files. Large/private collections
can stay in their existing protected evidence owner; include a durable manifest
and checksums in the record rather than copying weights or caches.

Keep original scores separately from adjudication and disputed grades. Record
what was tried, metric/denominator, cost estimate versus billed spend, outcome,
why it was retained/rejected and what evidence would justify revisiting it.
An interrupted `running` record means unresolved execution; inspect its live
owner before repeating or relabeling it. Do not overwrite a terminal attempt:
record a new one and link its predecessor in the inputs/result.

## Automatic skill-run retention

`repo-skill-evals` now keeps default output under the durable history root,
records an attempt before starting the stock runner, and archives its input
snapshot, reports, raw results and available per-run traces even on failure.
It does not copy the sandbox's credential/configuration directory. Explicit
`--out` remains supported; selected evidence is still copied into history before
returning. `--list` and `--dry-run` do not create evaluation records.

Before inference it reports recent matches for the generated input snapshot,
arguments and requested model alias. It preserves normal exit status and JSON
output, adding `history` with the run ID, store and matching prior IDs. This
notice does not suppress intentional repetitions or scheduled regression checks.
Use the record to decide whether a repeat is necessary, rather than treating a
matching fingerprint as permission to skip a required check.
