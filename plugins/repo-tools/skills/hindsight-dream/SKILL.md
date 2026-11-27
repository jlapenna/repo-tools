---
name: hindsight-dream
description: Audit, update, compact, and evolve a repository's Hindsight coding-agent memory bank against current source and recent history. Use for nightly or on-demand memory dreaming, pruning contradicted or duplicate memories, cleaning ephemeral review/status noise, retiring completed initiative pages, synthesizing cross-cutting lessons, and recovering failed consolidations or stale knowledge pages.
---

# Hindsight Memory Dreaming

Keep one repository's Hindsight memory bank accurate, compact, and current
against its checked-out source tree. Dreaming curates **stored memory** only —
it never edits repository files, commits, branches, issues, or pull requests.

Use `repo-hindsight-dream` (on `PATH`, or bundled at
`../../scripts/repo-hindsight-dream.mjs` relative to this `SKILL.md`) for all
reads and mutations so bearer tokens stay out of command arguments and core
taxonomy pages remain protected. When the calling runtime or job provides a
session identifier, pass `--session-id <current-session-id>` so the dreaming
session excludes and removes its own transcript from the bank.

Read [references/dream-rubric.md](references/dream-rubric.md) before mutating
memories or retiring pages.

## 1. Snapshot bank health and candidates

From the repository checkout root, capture the current baseline and candidate
queues in one pass:

```bash
dream_cli="$(command -v repo-hindsight-dream || true)"
[ -n "$dream_cli" ] || dream_cli="node <plugin-root>/scripts/repo-hindsight-dream.mjs"

# Set session_id to the current session ID when provided by your runtime or job.
session_id=""
$dream_cli status --json ${session_id:+--session-id "$session_id"}
$dream_cli candidates --days 14 --limit 300 --json ${session_id:+--session-id "$session_id"}
```

When a prior dream report or watermark timestamp is supplied, pass
`--since <last-run-iso>` on routine nights and widen to `--days 14` (or read
core pages directly with `read-page`) so older contradicted claims still get
caught. If Hindsight is disabled or unreachable, stop and report that exact
status instead of inventing changes.

## 2. Update: verify stored claims against current `HEAD`

1. Inspect `claimsWithMissingPaths` first, then high-proof items in
   `verifiablePathClaims` and claims surfaced inside the five core knowledge
   pages (`read-page --id "Conventions and patterns"`, `"Key decisions and rationale"`,
   `"Component map"`).
2. Verify each candidate against the live repository at `HEAD` (`git log`,
   `rg`, file reads, and read-only `gh issue view` / `gh pr view` when needed).
   Memory is historical claim evidence, never proof of current code state.
3. When a raw `world` or `experience` memory is **verifiably false, retired, or
   superseded**:
   - Soft-retire the raw memory unit with `invalidate-memory --id <uuid> --reason "<what changed + exact path or commit SHA>"`.
     Invalidation is reversible and automatically prunes derived observations
     and stale links. Never try to patch or delete an `observation` directly;
     curate its `source_memory_ids` instead.
   - If the replacement contract is missing from the bank, upsert a concise
     correction via `retain-doc --kind correction --slug <topic-slug> --title "<topic>" --knowledge-tag <tier> --text "<old claim -> verified truth + file/commit>"`.
     Deterministic `dream:correction:<slug>` IDs replace in place on later runs.
   - If a single valid fact only needs a small wording/path update while keeping
     its provenance, use `update-memory --id <uuid> --text "<verified statement>"`.

## 3. Compact: remove duplicates, ephemeral noise, and finished initiatives

1. **Duplicate gitlog seeds:** if `duplicateGitlogs` lists `gitlog:checkout`
   or `gitlog:workspace` alongside canonical `gitlog:<repo>`, remove the
   duplicate with `delete-doc --id gitlog:checkout --reason "Duplicate of canonical gitlog:<repo>"`.
   Leave `gitlog:checkout` intact when canonical `gitlog:<repo>` is absent, and
   do not delete sibling repositories' `gitlog:<other-repo>` seeds on shared
   multi-repo banks unless explicitly confirmed with `--allow-other-gitlog`.
2. **Ephemeral dispatch chatter:** review `ephemeralFacts` (`read-memory` when
   context is unclear). Invalidate routine zero-finding review receipts,
   auto-merge queue notices, and transient status checkpoints that carry no
   code rule, bug cause, or invariant. Keep review memories that record an
   actual defect pattern, architectural boundary, or guardrail lesson.
3. **Near-duplicate raw facts:** for each confirmed duplicate pair/cluster in
   `nearDuplicates`, keep the clearest, best-attributed memory (or refine it
   with `update-memory`) and `invalidate-memory` the redundant copies citing
   `"Compacted into <kept-memory-id>"`.
4. **Initiative pages (`knowledge:feature-work`):** inspect `initiativePages`
   (non-core pages). Check referenced issues/PRs and the codebase:
   - Keep pages for active, multi-PR work still in flight.
   - For an initiative that has **shipped and closed**, was **abandoned**, is
     **broken/empty** (`chars: 0` with `lastRefreshFailedAt`), or belongs to a
     **different repository**, first confirm its durable decisions/outcomes are
     captured (`retain-doc --kind initiative-outcome --slug <slug> --title "<initiative>" --knowledge-tag knowledge:decision ...`
     when anything durable would otherwise be lost), then run
     `retire-page --id <mm-id> --reason "<merged/closed/misfiled evidence>"`.
   - Never retire any of the five core taxonomy pages (`Component map`,
     `Core concepts`, `Conventions and patterns`, `Key decisions and rationale`,
     `Initiatives and enhancements`); the CLI enforces this guard.

## 4. Evolve and reconcile

1. Compare recent repository commits (`git log --since="3 days ago" --oneline`)
   with stored conventions and decisions. When several commits or fixes reveal a
   durable cross-cutting rule, architecture shift, or recurring failure mode not
   yet synthesized in memory, record **at most 1–3** high-signal notes via
   `retain-doc --kind evolution --slug <topic-slug> --title "<pattern>" --knowledge-tag <tier> --text "<concise rule, rationale, and exact file/commit citations>"`.
   Skip this step on quiet nights rather than writing filler.
2. Finish with `reconcile`:

```bash
$dream_cli reconcile --refresh-stale --max-refreshes 3 --wait-seconds 180 \
  ${session_id:+--session-id "$session_id"}
```

   Pass `--full-refresh <mm-id>` (at most 1–2 core pages per night) when a
   delta-refreshed core page has grown bloated near its token ceiling, accumulated
   retracted claims, or gone more than 7 days without a full rebuild.
3. Report a concise Markdown summary:
   - **Watermark:** UTC timestamp and `HEAD` commit SHA inspected;
   - **Before → After metrics:** total nodes (`world`, `experience`,
     `observation`), invalidated count, pending/failed consolidations, and
     core/initiative page counts;
   - **Updated / Corrected:** invalidated or updated memory IDs and `dream:correction:*` slugs with file/commit proof;
   - **Compacted:** duplicate/ephemeral facts retired, duplicate docs deleted, and initiative pages retired;
   - **Evolved & Refreshed:** `dream:evolution:*` notes written and pages refreshed (with operation statuses).
