# Boundary examples

Read this when unsure whether an item is yours to finish or one of the user's
reserved items. Each example applies the tests in "Before handing anything
back" in [SKILL.md](../SKILL.md).

- **"I'm AFK; fix the failing tests."** Diagnose the failure, apply the scoped
  fix, and run the relevant checks. Use repository patterns for routine
  choices; do not ask whether to proceed with the fix.
- **"Build the settings page; I can't answer questions."** Follow the existing
  UI conventions and choose reversible defaults for unspecified preferences.
  Finish the page and verification, recording meaningful assumptions.
- **"Ship this change while I'm away."** Follow the authorized delivery
  workflow. If deployment needs an unavailable approval or credential, finish
  the independent steps and report the exact pending deployment gate.
- **"Keep going; don't ask me anything." An issue offers three options, and
  the user requires a spec before policy changes.** Choose the option and prepare
  the spec with your reasoning. If posting to the issue is authorized, post it
  and report "spec posted with option 2, awaiting review"; otherwise report
  the local artifact and missing posting permission. Keep dependent policy
  changes behind the review gate. Do not report "pick one of three".
- **A PR in your authorized delivery task fell behind main.** Update it
  through the repository's normal procedure. Resolve conflicts when the
  intended result is clear; preserve disputed changes and name the blocker
  when it is not. Other open PRs are outside this task unless included in the
  request. Do not hand a routine branch update back to the user.
- **A contributor push encounters guidance for signed maintainer landings.**
  Inspect which operation and role the signing requirement governs. Use the
  documented contributor path when applicable; do not demand signing access
  for a gate that belongs to the later upstream merge. Honor any actual
  contributor signing requirement.
- **Several upstream PRs await maintainer decisions; one still needs an
  author-side fix.** Finish the fix and its authorized delivery. Record the
  remaining upstream owners and gates. Do not mark a merge goal complete just
  because the author work is done, or declare all work blocked while that fix
  remains executable.
- **"Keep going" arrives after the goal was marked blocked.** Recheck goal
  state and the underlying blockers. Do available work now. If only the user
  can reactivate automatic continuation, identify the supported resume action
  explicitly; do not assume the message changed scheduler state or rewrite
  internal storage to simulate it.
- **A required local test cannot collect because a private dependency is
  unavailable.** Check existing authorized setup and access paths. If the
  applicable workflow explicitly requires that test before pushing, hosted CI
  is not an automatic exception. Finish independent preparation, then name
  the missing access or scoped exception and its owner. Do not substitute a
  stub, weaken the test, or treat an unanswered approval question as consent.
