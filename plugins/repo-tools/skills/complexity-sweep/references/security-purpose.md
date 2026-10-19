# Security purpose

Use this lens when a cleanup encounters custom security, encryption, signing,
key or token machinery, or a request specifically questions controls added
for "safety." The goal is less machinery for the same concrete protection;
missing documentation alone does not establish that a control is unnecessary.

## Establish what the mechanism protects

Trace issuance or creation through storage, transport, verification and use.
Read the callers, deployment configuration and introduction history. Record:

- **Asset and failure:** the data, authority or operation being protected, and
  the unauthorized action or accidental failure the mechanism prevents.
- **Boundary and capability:** who can supply or alter input, obtain the key
  or token, read storage, or call the operation; distinguish network clients,
  browser origins, users, processes and deployment identities.
- **Enforcement:** where rejection happens, which downstream action it gates,
  and whether a caller can bypass it through another supported route.
- **Cost and replacement:** key provisioning, rotation, dependencies, failure
  modes and operator steps; the existing native primitive or direct operation
  that can preserve the contract with less machinery.
- **Consumers and evidence:** current callers, external clients, persisted
  formats and restore paths, inspected revision, origin and any proof gaps.
  Check mixed-version deployment and rollback: can old code read records or
  tokens written by new code, and can new code read in-flight old inputs?
  Name any bounded incompatibility window and its recovery.

Check the deployed binding, proxy and credential distribution before calling
two components the same trust domain. Localhost, a private network or a single
owner alone does not eliminate browser-origin, cross-process or remote-client
boundaries. A missing threat-model document is a reason to investigate.

## Leads, not deletion rules

Look for bespoke ciphers or encodings described as encryption, signatures
where an ordinary checksum would satisfy a non-adversarial integrity contract,
keys stored with ciphertext under identical access, tokens that neither gate
an operation nor bind an identity, repeated authentication behind the same
enforced boundary, and approval or confirmation protocols with no distinct
actor or protected action. Also look for credentials copied into metadata and
compared back to the same server secret after a client-carried format was
retired: the copy can add rotation failures without independent enforcement.
Search source contents as well as filenames:

```text
encrypt|decrypt|cipher|crypto|hmac|signing|signature|nonce|token|secret|keyring|rotation|safety|secure|auth
```

Trace test doubles too. A mock can still accept retired token fields or an
obsolete authenticated operation after its real producer is gone, hiding a
regression behind a successful fixture response. Keep its supported operations
and meaningful malformed-input checks; make unsupported requests fail visibly.

A key beside ciphertext can still separate a database export from filesystem
access. A random token can enforce capability possession, prevent replay, bind
a session or correlate one-time operations. Hashes can detect corruption or
concurrent changes without claiming adversarial protection. These purposes
must be assessed from the actual flow, not the names or primitive alone.

## Decide and simplify

**Keep** controls with a concrete present purpose: authentication and
authorization, CSRF and replay resistance, secret separation, encrypted
backups, path or input validation, process identity, concurrency and recovery
integrity. Custom code is a maintenance lead, not proof of uselessness.

**Simplify** when the traced flow demonstrates that a mechanism cannot affect
the claimed failure, a redundant owner provides no independent enforcement,
or a standard primitive preserves the same boundary with fewer moving parts.
Name the attack or accidental failure that remains prevented after the change.
State where rejection happens afterward and the platform's default behavior
when the removed mechanism is absent; deletion must not silently fail open.
Remove the obsolete helpers, settings, provisioning instructions and tests
devoted solely to that mechanism; preserve checks for observable contracts.

**Defer the cut** when a deployed consumer, credential boundary, retained
encrypted data or recovery contract remains unverified. Gather reachable
read-only evidence and continue independent work. Staged controls awaiting a
documented external cutover are not retired merely because current entry
points do not call them. If the original purpose
ended, use [retirement evidence](../../legacy-cleanup/references/retirement-evidence.md)
for every consumer class. Source cleanup does not authorize credential
invalidation, production data conversion, relaxing access policy or deployment.

Verify the supported operation and any meaningful rejection at the affected
boundary. Report the removed operational cost, protection retained, exact
evidence and limits; do not claim a security improvement from deletion alone.

## Obtain independent security review

Have the user- or project-designated security reviewer review these cuts before
delivery; use the named agent or service when one is requested, rather than
substituting a self-review. For example, a deployment may designate a secops
OpenClaw agent. If no reviewer is designated, use an available independent
reviewer without creating a new service or approval system.

Provide the exact base and head revisions, complete diffs, the boundary and
consumer evidence, checks performed and material proof gaps. Ask for a
read-only review of concrete security and integrity regressions; a code review
does not authorize scanning, secret access, credential changes or deployment.
Do not include secret values in the packet or publish private fleet evidence.
Include untracked additions when reviewing an uncommitted patch. Bind the final
published content to the reviewed files after formatting; distinguish absent
files from empty files when recording hashes. A review's prose counts or
transcribed hashes do not replace that source binding.

Hold pending delivery while the requested review is outstanding. Address
actionable findings, verify corrections and obtain review of the changed head
before resuming the normal protected delivery path. Keep unrelated preexisting
findings separate from regressions introduced by the cut. If a reviewed change
has already landed, review its exact merged revision and deliver a focused
correction when needed; never present that as a pre-merge review. Record the
reviewer, revisions, disposition and unproved behavior in the existing PR or
sweep report. An unavailable required reviewer is a named delivery blocker;
continue independent work without fabricating approval.

## Keep evidence collection from exposing credentials

Prefer the existing read-only client and bounded status or metadata needed for
the finding. Authenticated HTTP-client exceptions can include request headers,
cookies and bodies. Catch and sanitize failures inside the consuming process
before a tool renders them; return a fixed error category and retain only
credential-free request identity and status. Do not rely on an agent to redact
an exception after it has already been printed.

Treat an emitted live credential as an exposure and follow its owning incident
and revocation procedure within existing authority. Replacing a saved credential
does not by itself prove that the old one stopped authorizing requests. Keep
remediation, source delivery and any missing operational authority explicit.
