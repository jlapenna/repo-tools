# LCARS code review

A pull request merges only with one approving review of its current head;
GitHub dismisses an approval when the head moves. Agent LCARS reviews every
pull request as an ordinary reviewer, so its approval normally satisfies the
rule and its change request blocks the merge. Comment `/review` to ask for a
fresh review. Verified Renovate updates are approved without a review run.

The rule is declared in [infra/github-ruleset](../infra/github-ruleset/README.md)
and applied by Homelab. LCARS owns [review dispatch](https://github.com/jlapenna/agent-lcars/blob/main/docs/published-actions.md).
