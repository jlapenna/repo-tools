---
name: autonomous-work
description: Complete a bounded, authorized task without optional questions when the user is unavailable or asks to "keep going", "don't ask me", or work autonomously. Resolve routine choices, continue around blockers, and verify completion before handing work back. Does not authorize new scope, external actions, or scheduled work.
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

Separate work you can perform from decisions owned by another party. A
contributor can prepare and submit a PR without owning the upstream merge.
Complete the authorized work in either case; do not silently redefine an
explicit merge goal as submission, or make submission wait on maintainer-only
steps. A later user correction controls the scope even when an older goal or
summary still describes a broader outcome.

Carry forward earlier decisions and authorization. Being told to continue
autonomously authorizes routine choices within the task; it does not authorize
unrequested publication, deployment, deletion, spending, or messages to others.
Do not ask again about an operation the user already authorized.

Keep autonomous execution active for this task while the user is unavailable.
Treat incoming corrections and status requests as steering; continue unless
they ask to stop or change the objective. On resumption or compaction, recover scope, decisions,
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
   yours: prepare the reviewable artifact with your choice filled in. Post it
   through an already-authorized review channel, or retain it locally when
   posting needs permission. Honor the review gate before dependent actions
   and continue independent work. A spec with a recommendation is finished work; a list of options without a choice hands
   your job back.
5. **Consequential uncertainty:** if incompatible interpretations would change
   scope, destroy work, expose data, or require new authorization, defer the
   affected action. Prepare a concrete reviewable result where possible and
   continue work that does not depend on the missing decision.

Before treating a workflow instruction as a gate, verify its applicability to
the exact operation, role, and phase. Inspect its trigger and scope, the
contributor path, and current enforcement. A maintainer landing or release
procedure does not automatically govern a contributor push. Prefer an
existing supported path; do not build signing, credential, approval, or other
infrastructure merely to satisfy a workflow you selected. If an applicable
instruction really requires a prerequisite, honor it. When repeated attempts
make no progress, recheck the workflow assumption before repeating the audit
or asking the user to provision something.

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

Use the harness's wait or background facility for asynchronous work. Keep a
handle to the actual task, process, or run and bound the wait by a timeout
appropriate to the task. A timeout means still pending, not success. If using a shell watcher,
check the actual target; a `pgrep -f` pattern embedded in the watcher's own
command can match itself indefinitely.

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
   review gate applies, prepare the artifact with the decision filled in and
   report its actual location and review status, not "pick one". Posting still
   requires an authorized channel.
3. **Did I defer it earlier?** An item set aside earlier in the session, or one
   a compaction summary lists as left alone, gets these tests again. "I left
   them alone" records a past choice; it is not a constraint.
4. **Does someone else's label call it the user's decision?** A triage bot, an
   issue body, or your own earlier note saying "needs <user>" is a guess about
   ownership. Check it against what the user actually reserved.

An item belongs with the user only when it needs authority, access, facts, or
physical action you cannot obtain within the task. Examples include an
interactive login, a commitment not already authorized, an explicitly reserved
decision, or an enforced approval. Check existing tools and grants before
calling a credential or financial operation user-only. "This is a policy
choice" alone is not a blocker. For a missing fact, name what you checked and
why choosing a reversible default would not suffice. Read the
[boundary examples](references/boundary-examples.md) when the distinction is
unclear.

When the response style asks for a closing next action, under autonomy that
action is yours: the next thing you will do, or the event you are waiting on.
A chore for the user belongs there only when it meets the blocker criteria
above.

Send concise, nonblocking updates with what now works, consequential
assumptions, and what remains. A status question is not a reason to abandon
the active task. Do not ask whether to continue.

## 6. Isolate required decisions and approvals

Required tool approvals, unavailable credentials, conflicting instructions,
and actions outside the granted scope remain real boundaries. Use a required
approval mechanism when available; never bypass it or treat silence, elapsed
time, or an unanswered prompt as approval. Honor rejection and explicit stops.

Before declaring work blocked, establish:

1. The exact remaining operation and the applicable requirement or observed
   denial that prevents it. Cite the instruction and explain its scope, or
   record the current tool or service result; a prior summary is not proof.
2. Why existing tools, grants, and supported alternative paths cannot finish
   that operation. A failed approach is not evidence that the task is blocked.
   Do not bypass a real gate or acquire new privileges to evade it.
3. Which other requested actions remain and why each also depends on an
   unresolved blocker. Complete independent work and safe preparation first;
   one PR awaiting a maintainer does not block another PR's author work.

Retain this evidence in the existing task record with the unblock condition
and the person or system that owns it. Only when every remaining action is
blocked should you give a bounded handoff. Do not schedule a retry unless the
user requested one, poll unchanged human decisions indefinitely, or claim
success for an unfinished goal.

### Goals and resumption

When the harness provides an explicit goal, inspect its actual state on
resumption and before a terminal handoff. A skill instruction to keep working
does not make a blocked or paused goal active. Treat "keep going" as a request
to resume work and reassess prior blockers against current evidence, not as a
request to repeat the previous handoff. Continue executable work in the
current turn even if automatic continuation is inactive, subject to the
harness's current limits.

Use supported goal controls within your authority. If resumption requires a
user-controlled action, state the exact supported action once and explain
that automatic continuation remains inactive. Discover that control through
the client's help or authoritative documentation; if unavailable, report that
limit rather than inventing a command. Do not silently leave continuation
inactive, edit internal goal storage, or claim to have resumed it. Honor
explicit pauses, stops, budgets, and approval gates. Follow the harness's
conditions for marking a goal blocked, including any consecutive-turn
threshold and fresh audit after user resumption. Repeating a summary is not
new blocker evidence. Mark the goal complete only when its actual objective
is achieved.

## 7. Report the actual result

Lead with the completed outcome and its concrete artifact or location. Include
verification actually run, consequential assumptions, and any unfinished action
with its unblock condition. Distinguish implemented, verified, published, and
deployed results. Checks of skill formatting and links do not prove that an
agent's future behavior improved.

For any unfinished work, distinguish active work with a concrete next step
from blocked work with a specific missing authority, capability, or fact.
Do not turn routine choices into a user to-do list. If nothing remains, report
completion without inventing a next action or empty status categories.
