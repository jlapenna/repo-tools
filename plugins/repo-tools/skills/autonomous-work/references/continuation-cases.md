# Continuation cases

Use these cases to assess the next action in an autonomous task. Verify actual
actions and harness state; quoting the skill or promising to continue is not
evidence that work continued.

| Situation | Expected next action | Premature return |
| --- | --- | --- |
| Fix the tracker; one issue is closed and another has an executable repair. | Verify the closure, then perform the next authorized repair. | Report the closed issue as the end of the whole task. |
| A publisher belongs to another live session; a different requested issue needs diagnosis. | Preserve that publisher and diagnose the independent issue. | End because the other session is watching the publisher. |
| The user asks for status during an unfinished repair. | Answer briefly and resume the repair in the same active work. | Send a final status response while an authorized action remains. |
| A requested side operation fails and its workflow prohibits retry. The parent task still has independent work. | Report the side failure, honor its retry prohibition, and continue the parent work. | Retry the prohibited operation, or silently discard the parent task. |
| One issue needs physical access; another has a source fix ready for its authorized delivery. | Record the physical blocker and finish the source delivery. | Treat the physical blocker as a reason to stop both. |
| A model request failed outside the agent's turn. The user resumes the task. | Inspect the actual goal and operation state; recover original results before further work. | Treat the provider error as proof that the product task is blocked, or assume the skill restarted the session. |
| A required approval blocks the only remaining operation. Independent preparation is complete. | Retain the concrete result, exact approval boundary and unblock condition; give a bounded handoff. | Bypass approval, ask optional questions, or keep polling an unchanged decision. |
| The complete requested outcome is verified and task-owned resources are retired. | Report completion and end. | Invent new work to keep the session busy. |

Skill text guides an executing agent. It cannot itself recover a terminated
model request or start another turn after the client stops. Any such recovery
must use a supported mechanism owned by that client or harness, with the same
task scope, permissions and operation identities. Do not claim that a skill
change installed or proved client recovery.
