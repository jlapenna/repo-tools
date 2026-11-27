# Dream Curation Rubric

Apply strict evidence bars before changing a repository's memory bank. False
precision in memory poisons future sessions; deleting nuanced rationale loses
hard-won context.

## What to invalidate (`invalidate-memory`)

Soft-retire a `world` or `experience` memory only when at least one holds:

1. **Contradicted by `HEAD`:** names a file, command, flag, workflow, env var,
   or invariant that current tracked source demonstrably replaced or removed.
   Cite the current path or commit SHA in `--reason`.
2. **Superseded temporary state:** records a point-in-time blocker, open PR
   queue state, temporary freeze flag, or one-off incident symptom as if it
   were standing behavior, and live repo/GitHub evidence shows it settled.
3. **Ephemeral operational receipt:** records only that a review ran with zero
   findings, auto-merge was armed, a check was pending, or a subagent reported
   status, with zero durable code, architecture, or testing insight.
4. **Exact or near duplicate:** states a subset of another surviving valid
   memory in the same bank. Cite `"Compacted into <surviving-id>"`.

## What to preserve untouched

- **Why-decisions and rejected alternatives:** negative findings ("tried X;
  reverted because Y broke under Z") remain high-value even when X is absent
  from the codebase — they stop future agents from repeating a failed design.
  Invalidate them only if the constraint Z itself was retired and documented.
- **Historical incident root causes** that explain why a current guardrail or
  test exists.
- **Unverified claims** about external hosts or runtime state that cannot be
  checked from the repository checkout or read-only GitHub metadata. Leave them
  valid and note the verification boundary rather than guessing.

## Writing `dream:*` synthesis documents (`retain-doc`)

- Prefer **0–3** tight, high-density documents over broad summaries.
- Always pick a stable topic `--slug` (for example `pr-closing-ref-guard` or
  `worktree-cleanup-cwd`) so future nights overwrite the same `dream:<kind>:<slug>`
  document (`update_mode: replace`) instead of accumulating dated copies.
- Quote literal identifiers, paths, commands, and `#issue`/`#pr` numbers
  verbatim; Hindsight's reflect mission relies on exact tokens.
- Tag with the matching `--knowledge-tag` (`knowledge:decision`,
  `knowledge:convention`, `knowledge:component`, `knowledge:concept`, or
  `knowledge:feature-work`) so the corresponding taxonomy page ingests it.

## Knowledge-page lifecycle

- **Five core taxonomy pages** (`Component map`, `Core concepts`,
  `Conventions and patterns`, `Key decisions and rationale`,
  `Initiatives and enhancements`) are permanent. Never delete them.
- Core pages default to `delta` refreshes. When a core page exceeds ~13,000
  characters with superseded sections, has `lastRefreshFailedAt` set, or has
  not had a `full` refresh in over a week after major compactions, pass its ID
  via `reconcile --full-refresh <mm-id>` (cap at 1–2 full refreshes per night
  to respect local inference lane budgets).
- **Initiative pages** (`hindsight_capture_initiative` outputs) are scoped to
  active multi-step work. Once the initiative's PRs/issues are merged and its
  durable architecture or convention changes live in core facts, retire the
  standalone initiative page with `retire-page` so page-tree search stays crisp.
