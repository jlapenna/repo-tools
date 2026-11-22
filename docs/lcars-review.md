# LCARS code review

The repository ruleset selects the required LCARS check. The publisher uses
the `lcars-review-publisher` environment on `main`. LCARS owns [review dispatch
and publication](https://github.com/jlapenna/agent-lcars/blob/main/docs/published-actions.md).
A maintainer can request a review on an open pull request with `/review`.

During migration, the legacy head check can still block a retargeted PR while
it waits for its base-change receipt. Its [receipt format and event lookup](https://github.com/jlapenna/repo-tools/blob/324382a608cb15a21423e3a9ecd531baf58fe1af/docs/lcars-review.md)
apply until the ruleset switches to the candidate check.
