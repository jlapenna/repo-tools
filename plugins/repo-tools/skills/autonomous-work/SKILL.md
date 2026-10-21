---
name: autonomous-work
description: Complete an authorized task without optional questions when the user says they are unavailable, AFK, unable to answer, "keep going", "don't ask me", or asks to keep working autonomously. Resolve routine ambiguity from evidence and reversible defaults, make judgment calls instead of handing back options, continue independent work around blockers, wait only on live bounded watchers, and check every item before reporting it as the user's. Use for hands-off execution of a bounded task, and again before writing the final report of an autonomous run. Do not use it to start an unsolicited backlog, schedule work, or grant new permissions.
---

# Autonomous work

Carry the requested task as far as its existing authorization allows. Treat
the user's unavailability as an execution constraint: do not send optional
questions or end the turn waiting for a preference. This skill needs no
companion skills, scheduler, agent fleet, or persistent service. Follow the
repository's existing workflow and the harness's required approvals.

## 1. Establish the outcome without an intake round

Recover the requested result, acceptance conditions, scope, and existing
permissions from the conversation and local instructions. Inspect the current
source and task state before acting. Without explicit acceptance criteria,
derive a bounded completion condition from the request and the repository's
normal verification. Do not invent unrelated requirements.

Carry forward earlier decisions and authorization. Being told to continue
autonomously authorizes routine choices within the task; it does not authorize
unrequested publication, deployment, deletion, spending, or messages to others.
Do not ask again about an operation the user already authorized.

Keep autonomous execution active for this task while the user is unavailable.
Treat incoming
corrections and status requests as steering; continue unless they ask to stop
or change the objective. On resumption or compaction, recover scope, decisions,
completed work, and pending actions before proceeding.

## 2. Resolve each decision where it arises

1. **Missing facts:** inspect files, history, configuration, existing tools,
   and authoritative documentation. Run a proportionate diagnostic rather than
   ask the user for information already available to the agent. Read
   [delegated evidence](references/delegated-evidence.md) before delegating
   evidence-gathering or relying on another party's receipt.
2. **Implementation choices:** follow accepted neighboring patterns and
   repository conventions. Choose the smallest change that satisfies the
   request and remains easy to review or reverse.
3. **Optional preferences:** use the existing default or a conservative,
   reversible assumption. State it briefly and proceed; do not end the update
   with a question or request acknowledgment.
4. **Judgment calls and policy choices:** when several options are reasonable,
   pick one, say why in a sentence or two, and carry it out. If a standing rule
   requires review first (spec-first or design review), the decision is still
   yours: write the reviewable artifact with your choice filled in, publish it
   where the reviewer will see it, and continue other work. A spec with a
   recommendation is finished work; a list of options without a choice hands
   your job back.
5. **Consequential uncertainty:** if incompatible interpretations would change
   scope, destroy work, expose data, or require new authorization, defer the
   affected action. Prepare a concrete reviewable result where possible and
   continue work that does not depend on the missing decision.

Preserve existing user edits and unrelated changes. Do not settle ambiguous
ownership by restoring an older version, accepting all incoming changes, or
cleaning a dirty checkout. Inspect the diff and isolate your changes; if intent
remains uncertain, leave that part intact and report it.

Record only assumptions that affect behavior, scope, or review, in the existing
task plan or issue when one exists; a short progress update is enough for a
small task. Do not create a decision-log file for every choice.

## 3. Continue through authorized completion

Implement, verify, and repair concrete failures within the requested scope.
When the task includes delivery, finish the already-authorized commit, PR, CI,
review, merge, or post-delivery steps its workflow requires. Do not stop at a
plan, the first passing check, or a PR link when later steps are part of the
requested outcome. Finish required checks and investigate real failures; do
not weaken checks or repeatedly rerun a product failure into green.

A timed-out mutation can already have succeeded. Retain its exact target and
supported idempotency key, read back the authoritative state, and recover the
original result before issuing another admission or publication. Reuse the
same supported key and inputs when recovering a lost response; a fresh request
is not evidence that the earlier one failed.

Use available alternatives when a tool or approach fails. Retry only when new
evidence or a changed approach makes progress plausible. Do not spin on the
same blocker, expand into an unrelated backlog, or add a polling service to
keep the session busy. Finish independent work before declaring the task
blocked.

## 4. Wait only on a live watcher

Arm each wait with the harness's background facility and record its PID or
task ID. Bound every wait with a timeout from the task's remaining budget; a
timeout means still pending, not success. Check a PID with `kill -0`, an exact
process name with `pgrep -x`, or a file or service state. Never loop on
`pgrep -f <pattern>` when the pattern appears in the loop's own command line:
the loop matches itself and never exits.

End a turn "waiting on X" only when a live watcher you armed will wake it;
otherwise check X now or keep working. Stop your own watchers before reporting
done, and name any you deliberately leave running by PID or task ID.

Before handing back a next step or asking approval for routine follow-through,
check its live state: PR and issue comments, workflow or deploy runs, or the
resource's own status output. Another session may already have done it. If it
is done, say so with the evidence. If it is pending and within the request, do
it through the repository's procedure, including any required dry run.

## 5. Before handing anything back

A user who said they cannot answer questions gets nothing from an item labelled
"your call", "needs your decision", "left for you", or "next action for you":
each becomes a question they must stop and answer, the interruption they ruled
out. Before an item goes into your report as the user's, run these tests:

1. **Can I do it with the tools and authorization I already hold?** Updating a
   branch, rerunning a check, filing or commenting on an issue, cleaning up your
   own artifacts, or following a documented procedure: do it now, then report
   it as done.
2. **Is it a choice between options?** Make the choice (step 2, item 4). If a
   review gate applies, publish the artifact with the decision filled in and
   report "spec posted with decision X, awaiting review", not "pick one".
3. **Did I defer it earlier?** An item set aside earlier in the session, or one
   a compaction summary lists as left alone, gets these tests again. "I left
   them alone" records a past choice; it is not a constraint.
4. **Does someone else's label call it the user's decision?** A triage bot, an
   issue body, or your own earlier note saying "needs <user>" is a guess about
   ownership. Check it against what the user actually reserved.

Only these stay with the user: their credentials or identity (logins, signing,
2FA), money or legal commitments, physical-world actions, actions the user
explicitly reserved for themselves, and approvals a tool or policy enforces.
For each, name the specific missing authority. "This is a policy choice" is
not on that list. When unsure where an item falls, read the
[boundary examples](references/boundary-examples.md).

When the response style asks for a closing next action, under autonomy that
action is yours: the next thing you will do, or the event you are waiting on.
A chore for the user belongs there only when it is a reserved item above.

Send concise, nonblocking updates with what now works, consequential
assumptions, and what remains. A status question is not a reason to abandon
the active task. Do not ask whether to continue.

## 6. Isolate required decisions and approvals

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

## 7. Report the actual result

Lead with the completed outcome and its concrete artifact or location. Include
verification actually run, consequential assumptions, and any unfinished action
with its unblock condition. Distinguish implemented, verified, published, and
deployed results. Checks of skill formatting and links do not prove that an
agent's future behavior improved.

Sort remaining items into three groups: done, still in progress (yours, with
what you are doing next), and blocked (reserved items only, each naming the
missing authority). There is no fourth group of things for the user to decide.
If you are about to write one, go back to step 5.
