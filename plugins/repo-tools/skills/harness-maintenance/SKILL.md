---
name: harness-maintenance
description: Maintain repository documentation, agent context, and skills against observed work. Use when asked to improve a coding harness, refresh agent guidance, apply harness-engineering lessons, or repair repeated retrieval and workflow failures. Ordinary feature work follows its existing repository workflow.
---

# Harness maintenance

Improve the environment around the selected coding agent so it can recover
intent, find local requirements, perform authorized work, and prove the
requested outcome. Read the target's agent guide and applicable development
skill first. Its ownership, verification, delivery, and approval rules govern.

This approach is adapted from Ryan Lopopolo's
[Harness Engineering field guide](https://github.com/lopopolo/harness-engineering)
at [revision 226c8d35](https://github.com/lopopolo/harness-engineering/tree/226c8d35fb6ea3ed55467753dba6dea2b5fd5778).
The anthology's application playbooks describe their own validation limits;
this skill is a repository-management adaptation, not a proven effectiveness
claim about any consumer.

## Find the missed decision and its owner

Use a concrete requested job, review correction, incident, or failed retrieval.
Inspect the relevant source, configuration, tests, neighboring accepted work,
and existing guidance before adding context. Record the promised outcome,
observed failure, target revision, and available evidence. Agent explanations
and learning reports are leads that need corroboration.

Locate the earliest missing handoff: an absent fact, a stale or overloaded
route, an undiscoverable or unusable capability, competing domain owners,
insufficient authority, or evidence that proves only an internal proxy.
Keep external failures and uncertain worker behavior separate. Search for
sibling instances within the authorized scope.

Give the requirement one semantic owner. Stable invariants belong in types,
APIs, state machines, or existing deterministic checks. Qualitative judgment
belongs in accepted examples, scoped documentation, or focused review. Shared
packages retain their implementations; consumers retain local domain facts.
Remove obsolete routes and redundant controls when the replacement covers
their contract, preserving legitimate exceptions.

## Put context where it changes a decision

- Keep the root agent guide a task router with essential boundaries and links.
- Let a skill description identify the job and trigger; keep essential
  constraints in its entry point and conditional procedures in references.
- Keep repeatable operator procedures with their preconditions, evidence,
  recovery, and authority boundary in the owning runbook.
- For multi-session work, retain acceptance, decisions, current evidence, and
  the next step in the existing issue or scoped plan. Reconcile it with current
  source when resuming; move resulting current policy to its durable owner.
- Prefer existing tools and discover their help. Preserve complete diagnostic
  output and true exit status while returning a bounded useful summary.
  An actionable error should name the target, contract, and recovery route.

Avoid copying another repository's layout, deployment procedures, version
pins, or doctrine. Do not require new root learning files, new automation,
or an additional skill when an existing owner can serve the job.

## Verify the adaptation

State the expected observable change before editing. Run target-native checks
for the changed boundary. For docs and skills, verify source consistency,
formatting, frontmatter, routes, and relative links. Regenerate any interface
inventory from its owner rather than hand-editing it. `repo-docs` checks literal
local file links and skill metadata; it does not prove heading anchors,
semantic freshness, or worker behavior.

Report the exact artifact or revision, checks and journeys actually performed,
results, and material unproved behavior. Passing unit tests, a rendered browser
journey, a published artifact, and deployed health support different claims.
Stay within the existing operation grants; a proof gap does not authorize a
deployment, new credential, private-data export, or policy bypass.

If claiming improved agent behavior, inspect a fresh comparable trajectory
that actually retrieves or invokes the adaptation. Keep the model, coding-agent
configuration, authority, and starting conditions comparable, and record
differences. A model or agent change starts a new comparison condition.
Structural validation or one successful rerun cannot establish a general or
causal effectiveness claim.

Retain, revise, or remove the change based on accepted outcomes, proof quality,
human steering, retries, latency, risk, and maintenance burden. Token volume,
document count, and added validators are activity or cost signals.

## Finish within scope

Follow the target's normal delivery lifecycle when publication is authorized.
Keep raw logs, session archives, user records, and credentials in their
protected storage; publish only bounded evidence suitable for the destination.
For a requested gardening pass, repair stale claims at their owner and update
inbound routes. Schedule recurring work only when requested, with an owner,
bounded state and authority, a proof path, and a retirement condition.
