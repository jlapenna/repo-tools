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
  the user requires a spec before policy changes.** Choose the option, post
  the spec with your reasoning on the issue, and report "spec posted with
  option 2, awaiting review". Do not report "pick one of three".
- **Open PRs fell behind main after your change.** Bringing them up to date
  through the forge's own update or its rebase mechanism is routine and
  reversible. Do it, and skip the ones with conflicts while naming them. Do
  not list it as the user's next step.
