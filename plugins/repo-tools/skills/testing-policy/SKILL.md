---
name: testing-policy
description: Decide whether a test or CI check earns its cost and how required jobs and operational control flags must behave. Use when adding, deleting, reviewing, skipping or making required any test, CI job, path filter or enable/arm flag, or when asked whether a test is redundant, even if the word policy never comes up.
---

# Testing policy

Use this skill for a test or CI decision, not for unrelated implementation
work that merely happens to be in a repository with tests.

Read [references/testing-policy.md](references/testing-policy.md) before
deciding whether a test or CI check belongs. It defines the observable-contract
standard, the required consumer for every check, the exception for intentional
control flags, and operational hygiene.

When proposing a change, name the protected production contract and the check's
consumer. For a deletion, name the policy category that makes it redundant or
unearned. Do not treat this policy as authorization to change required checks,
repository variables, or deployment behavior without the authority for that
specific change.
