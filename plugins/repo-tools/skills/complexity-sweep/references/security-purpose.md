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
