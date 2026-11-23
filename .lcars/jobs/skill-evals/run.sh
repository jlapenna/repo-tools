#!/bin/sh
# Publish only after the evaluator exits; a report written before a crash is not success.
set -eu

work="${TMPDIR:-/tmp}/skill-evals"
state="$work/invocation"
result="$state/report/result.json"
mkdir -p "$work"

# SKILL_EVALS_SHARD=i/n scores one of n skill groups balanced by case count, so an ablation that
# outgrows the 30-minute job runs as n jobs (skill-evals and skill-evals-2), each carrying forward
# only its own cases. It is chosen before the invocation starts so a bad value cannot strand one.
shard=''
if [ -n "${SKILL_EVALS_SHARD:-}" ]; then
  if command -v repo-skill-evals >/dev/null 2>&1; then list="$(repo-skill-evals --root plugins/repo-tools/skills --list --json)"; else list="$(node /opt/repo-tools/bin/skill-evals.mjs --root plugins/repo-tools/skills --list --json)"; fi
  shard="$(printf '%s' "$list" | node --input-type=module -e '
import {readFileSync} from "node:fs";
const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(process.argv[1] ?? "");
if (!m || Number(m[1]) > Number(m[2])) throw new Error("SKILL_EVALS_SHARD must be i/n with 1 <= i <= n");
const [i, n] = [Number(m[1]), Number(m[2])];
const skills = JSON.parse(readFileSync(0, "utf8")).skills.filter((s) => s.cases > 0)
  .sort((a, b) => b.cases - a.cases || (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
const load = Array(n).fill(0), mine = [];
for (const s of skills) { let k = 0; for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j; load[k] += s.cases; if (k === i - 1) mine.push(s.skill); }
if (!mine.length) throw new Error(`shard ${i}/${n} has no skills`);
console.log(mine.join("\n"));
' "$SKILL_EVALS_SHARD")"
fi
if mkdir "$state" 2>/dev/null; then
  set -- --root plugins/repo-tools/skills --json --out "$work/run" --report "$state/report"
  for skill in $shard; do set -- "$@" --skill "$skill"; done
  if [ -f "$work/baseline.json" ]; then
    set -- "$@" --baseline "$work/baseline.json"
  fi
  # The with-without ablation answers every case again without the skill and reports its lift.
  set -- "$@" -- --ablation with-without --max-cost-usd 12 -j 2
  if command -v repo-skill-evals >/dev/null 2>&1; then
    if EVAL_HISTORY_REMOTE=garage:eval-history EVAL_HISTORY_RCLONE_CONFIG="$LCARS_JOB_SECRET_FILES_DIR/garage-rclone" repo-skill-evals "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  else
    if EVAL_HISTORY_REMOTE=garage:eval-history EVAL_HISTORY_RCLONE_CONFIG="$LCARS_JOB_SECRET_FILES_DIR/garage-rclone" node /opt/repo-tools/bin/skill-evals.mjs "$@" >"$state/output.log" 2>&1; then status=0; else status=$?; fi
  fi
  printf '%s\n' "$status" >"$state/exit"
else
  if [ ! -f "$state/exit" ]; then
    echo 'Evaluator already started; wait for its existing command. An interrupted run must not restart.' >&2
    exit 75
  fi
  status="$(cat "$state/exit")"
  result="$work/report/result.json"
  if [ ! -f "$result" ]; then
    echo 'Original invocation has not published a report; do not restart evaluation.' >&2
    case "$status" in 0|1|2) exit 75 ;; *) exit "$status" ;; esac
  fi
fi

# Keep signals and unexpected command failures visible. Their staged output is diagnostic only.
case "$status" in
  0|1|2) ;;
  *) tail -n 40 "$state/output.log" >&2; exit "$status" ;;
esac
if ! node --input-type=module - "$result" "$status" <<'JS'
import {readFileSync, statSync} from 'node:fs';
const [file, status] = process.argv.slice(2);
const result = JSON.parse(readFileSync(file, 'utf8'));
if (!statSync(file).isFile() || typeof result.report !== 'string' || typeof result.complete !== 'boolean' || !result.data || Array.isArray(result.data) || result.data.exit !== Number(status) || ((Number(status) === 2 || Boolean(result.data.partial)) && result.complete)) {
  throw new Error('Evaluator did not produce a valid report matching its exit status');
}
JS
then
  tail -n 40 "$state/output.log" >&2
  exit 1
fi
if [ "$result" != "$work/report/result.json" ]; then
  mkdir -p "$work/report"
  if [ -f "$state/report/report.md" ]; then cp "$state/report/report.md" "$work/report/report.md"; fi
  mv "$result" "$work/report/result.json"
fi
printf 'Evaluator exited %s. Exact report saved at %s/report/result.json; evaluation will not run again.\n' "$status" "$work"
