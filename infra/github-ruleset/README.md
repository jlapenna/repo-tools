# repo-tools GitHub ruleset

This is the repository-owned declaration for its `Protect main` GitHub
ruleset, the same shape every other fleet repository declares. It
intentionally has no credential, state-bucket value, or backend prefix. The
trusted Homelab executor (`bin/plan-fleet-github-ruleset.sh` in
jlapenna/homelab) supplies those at runtime and owns the scheduled drift
check. Do not run an unconfigured local apply.

The live ruleset is `21255238`. It was created as `Require Verify` from a JSON
file in this repository and carried only the required checks; Homelab imports
it into this root and applies the full `Protect main` policy. Repository CI
initializes, formats and validates this root; only the centralized executor
receives backend and state access.
