---
name: autonomous-work
description: Complete an authorized task without optional questions when the user says they are unavailable, AFK, unable to answer, "keep going", "don't ask me", or asks to keep working autonomously. Resolve routine ambiguity from evidence and reversible defaults, make judgment calls instead of handing back options, continue independent work around blockers, and check every item before reporting it as the user's. Use for hands-off execution of a bounded task, and again before writing the final report of an autonomous run. Do not use it to start an unsolicited backlog, schedule work, or grant new permissions.
---

# Autonomous work

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

Keep autonomous execution active for this task while the user is unavailable.
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
4. **Judgment calls and policy choices:** when there are several reasonable
   options, pick one, say why in a sentence or two, and carry it out. If a
   standing rule requires review before implementation (a spec-first or
   design-review rule), the decision still belongs to you: write the
   reviewable artifact with your choice filled in, publish it where the
   reviewer will see it, and continue other work. A spec with a
   recommendation is finished work; a list of options without a choice
   hands your job back.
5. **Consequential uncertainty:** if incompatible interpretations would change
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

Before handing back a next step or asking approval for routine follow-through,
check its live state: PR and issue comments, workflow or deploy runs, or the
resource's own status output. Another session may already have done it. If it
is done, say so with the evidence. If it is pending and within the request, do
it through the repository's procedure, including any required dry run.

## Before handing anything back

A user who said they cannot answer questions gets nothing from an item
labelled "your call", "needs your decision", "left for you", or "next action
for you". Each of these turns into a question they have to stop and answer,
which is exactly the interruption they ruled out. Before an item goes into your
report as the user's, run it through these tests:

1. **Can I do it with the tools and authorization I already hold?** Updating
   a branch, rerunning a check, filing or commenting on an issue, cleaning up
   your own artifacts, or following a documented procedure: do it now, then
   report it as done.
2. **Is it a choice between options?** Make the choice (step 4 above). If a
   review gate applies, publish the artifact with the decision filled in. Then
   report it as "spec posted with decision X, awaiting review", not "pick one".
3. **Did I defer it earlier?** An item you set aside earlier in the session, or
   one a compaction summary lists as left alone, gets these tests again. "I
   left them alone" records a past choice; it is not a constraint.
4. **Does someone else's label call it the user's decision?** A triage bot,
   an issue body, or your own earlier note saying "needs <user>" is a guess
   about ownership. Check it against what the user actually reserved.

Only these stay with the user: their credentials or identity (logins,
signing, 2FA), money or legal commitments, physical-world actions, actions the
user explicitly reserved for themselves, and approvals a tool or policy
enforces. For each one, name the specific missing authority. "This is a policy
choice" is not on that list.

When the response style asks for a closing next action, under autonomy that
action is yours: the next thing you will do, or the event you are waiting on.
A chore for the user belongs there only when it is one of the reserved items
above.

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

Sort remaining items into three groups: done, still in progress (yours, with
what you are doing next), and blocked (reserved items only, each naming the
missing authority). There is no fourth group of things for the user to decide.
If you are about to write one, go back to "Before handing anything back".

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
- **“Keep going; don't ask me anything.” An issue offers three options, and
  the user requires a spec before policy changes.** Choose the option, post
  the spec with your reasoning on the issue, and report "spec posted with
  option 2, awaiting review". Do not report "pick one of three".
- **Open PRs fell behind main after your change.** Bringing them up to date
  through the forge's own update or its rebase mechanism is routine and
  reversible. Do it, and skip the ones with conflicts while naming them. Do
  not list it as the user's next step.
