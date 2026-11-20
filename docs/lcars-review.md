# LCARS code review

The installed LCARS app reviews pull requests. A maintainer can comment
`/review` to request a review of the current commit, including a Renovate
update. The workflow uses the Agent LCARS App to publish the `LCARS review` check after the first
passing verdict. A later blocking verdict reopens the check. A formal change
request for the current comparison needs an approval or dismissal. After a
retarget, a change request without the new comparison receipt is provisional.
A passing review with the current receipt clears that provisional request.
GitHub associates the check with a commit; review changes and other open PRs
at the same commit take effect when the publisher reconciles.

Before evaluating the diff, read the PR head, base branch and latest
`BASE_REF_CHANGED_EVENT` ID from GitHub GraphQL
(`pullRequest.timelineItems(last: 1, itemTypes: [BASE_REF_CHANGED_EVENT])`).
If the diff was already fetched, fetch it again after recording this identity.
Use this comparison for every review pass. Recheck all three values before
submitting. If any changed, review the new comparison before publishing a pass.
For a retargeted PR, make the first line of the review body
`<!-- lcars-review:base-event NODE_ID -->`, substituting
the ID recorded before reading the diff. The repository workflow uses this
receipt to distinguish reviews of different comparisons at the same head.
