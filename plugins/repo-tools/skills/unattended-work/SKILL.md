---
name: unattended-work
description: Complete an authorized task without optional questions when the user says they are unavailable, AFK, unable to answer, or asks to keep working autonomously. Resolve routine ambiguity from evidence and reversible defaults, continue independent work around blockers, and report any unfinished actions. Use for hands-off execution of a bounded task, not to start an unsolicited backlog, schedule work, or grant new permissions.
---

# Unattended work

Carry the requested task as far as its existing authorization allows. Treat
the user's unavailability as an execution constraint: do not send optional
questions or end the turn waiting for a preference. This skill needs no
companion skills, scheduler, agent fleet, or persistent service. Follow the
repository's existing workflow and the harness's required approvals.

## Establish the outcome without an intake round

Recover the requested result, acceptance conditions, scope, and existing
permissions from the conversation and local instructions. Inspect the current
source and task state before acting. If no explicit acceptance criteria exist,
derive a bounded completion condition from the request and the repository's
normal verification. Do not invent unrelated requirements.

Carry forward earlier decisions and authorization. Being told to continue
autonomously authorizes routine choices within the task; it does not authorize
unrequested publication, deployment, deletion, spending, or messages to others.
Do not ask again about an operation the user already authorized.

Keep unattended execution active for this task while the user is unavailable.
Incorporate incoming corrections and status requests as steering; continue
unless they ask to stop or change the objective. On resumption or compaction,
recover scope, decisions, completed work, and pending actions before proceeding.

## Resolve the decision where it arises

1. **Missing facts:** inspect files, history, configuration, existing tools,
   and authoritative documentation. Run a proportionate diagnostic rather
   than ask the user to supply information already available to the agent.
2. **Implementation choices:** follow accepted neighboring patterns and
   repository conventions. Choose the smallest change that satisfies the
   request and remains easy to review or reverse.
3. **Optional preferences:** use the existing default or a conservative,
   reversible assumption. State the assumption briefly and proceed; do not
   end the update with a question or request acknowledgment.
4. **Consequential uncertainty:** if incompatible interpretations would change
   scope, destroy work, expose data, or require new authorization, defer the
   affected action. Prepare a concrete reviewable result where possible and
   continue work that does not depend on the missing decision.

Preserve existing user edits and unrelated changes. Do not settle ambiguous
ownership by restoring an older version, accepting all incoming changes, or
cleaning a dirty checkout. Inspect the relevant diff and isolate your changes;
if intent remains uncertain, leave that part intact and report it.

Record only assumptions that affect behavior, scope, or review. Use the
existing task plan or issue when one exists; a short progress update is enough
for a small task. Do not create a new decision-log file for every choice.

## Continue through authorized completion

Implement, verify, and repair concrete failures within the requested scope.
For a task that includes delivery, finish the already-authorized commit, PR,
CI, review, merge, or post-delivery steps required by its workflow. Do not stop
at a plan, the first passing check, or a PR link when later steps are part of
the requested outcome. Finish required checks and investigate real failures;
do not weaken checks or repeatedly rerun a product failure into green.

Use available alternatives when a tool or approach fails. Retry only when new
evidence or a changed approach makes progress plausible. Do not spin on the
same blocker, expand into an unrelated backlog, or add a polling service to
keep the session busy. Finish independent work before declaring the task
blocked.

Send concise, nonblocking updates with what now works, consequential
assumptions, and what remains. A status question from the user is not a reason
to abandon the active task. Do not ask whether to continue.

## Isolate required decisions and approvals

Required tool approvals, unavailable credentials, conflicting instructions,
and actions outside the granted scope remain real boundaries. Use a required
approval mechanism when available; never bypass it or treat silence, elapsed
time, or an unanswered prompt as approval. Honor rejection and explicit stops.

For each blocked action, retain the exact target, the missing authority or
fact, the evidence collected, and the condition that would unblock it. Complete
safe preparation and independent work. If every remaining action depends on
that blocker, give a bounded handoff instead of asking optional questions,
waiting indefinitely, or claiming success. Do not schedule a retry unless the
user requested one.

## Report the actual result

Lead with the completed outcome and its concrete artifact or location. Include
verification actually run, consequential assumptions, and any unfinished
action with its unblock condition. Distinguish implemented, verified,
published, and deployed results. Checks of skill formatting and links do not
prove that an agent's future behavior improved.

Examples of the decision boundary:

- **“I'm AFK; fix the failing tests.”** Diagnose the failure, apply the scoped
  fix, and run the relevant checks. Use repository patterns for routine
  choices; do not ask whether to proceed with the fix.
- **“Build the settings page; I can't answer questions.”** Follow the existing
  UI conventions and choose reversible defaults for unspecified preferences.
  Finish the page and verification, recording meaningful assumptions.
- **“Ship this change while I'm away.”** Follow the authorized delivery
  workflow. If deployment needs an unavailable approval or credential, finish
  the independent steps and report the exact pending deployment gate.
