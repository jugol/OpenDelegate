# ADR-0021: Supported release promotion and native authenticity

Status: **Accepted**

Date: **2026-07-26**

Refines: **ADR-0010, D-040**

## Context

ADR-0010 defines reproducible target-specific bundles, the audited-source commit
**A** and attestation commit **B** contract, payload integrity manifests, and a
detached Ed25519 publisher attestation. It intentionally stops bundle assembly at
`release-candidate`. It does not define the later trust decision that makes those
exact bytes an effective `released` artifact.

That distinction is necessary because several different claims must not be
collapsed:

- a checksum manifest proves only that enclosed files agree with one another;
- a publisher attestation authenticates one target bundle to an externally
  provisioned OpenDelegate publisher key;
- macOS and Windows native signatures authenticate executable code through their
  platform trust systems;
- Apple notarization records Apple's analysis of one exact submitted macOS
  archive;
- the 36-criterion ledger and live evidence establish product support eligibility
  across the complete declared platform matrix; and
- observer-signed remote read-back envelopes establish that each of the three
  promoted target archives was retrieved unchanged from its immutable channel
  object; and
- a supported-channel receipt binds those observations to the same promotion and
  channel authorization.

Native code signing changes executable bytes. Running it after
`payload-manifest.json` or `SHA256SUMS` is written would invalidate the integrity
chain. Rewriting those manifests afterward would create a second, unaudited
candidate and make evidence identity ambiguous. Apple notarization can examine an
exact final archive without rewriting it, but stapling a ticket afterward would
change bytes already bound by manifests and attestations.

The acceptance ledger also cannot be edited to add final archive hashes after
candidate construction. ADR-0010 deliberately restricts A-to-B changes, and a
candidate must remain bound to the exact completed ledger from which it was built.
Cross-platform asset identities therefore need a detached, non-circular promotion
record.

Finally, CI-generated keys, ad-hoc signatures, and a certificate delivered beside
the bytes it signs do not create a trust root. Credential-bearing release tools must
not run from a developer's live checkout or from mutable, unpinned helper code.

## Decision

### Distinct trust artifacts

OpenDelegate uses the following distinct artifacts and authorities:

1. **Candidate payload integrity** consists of the enclosed
   `SHA256SUMS` → `payload-manifest.json` → `release-metadata.json` →
   acceptance-ledger chain defined by ADR-0010. It is self-consistency evidence,
   not publisher authentication.
2. **Platform native authenticity** covers executable code before payload
   manifests are generated:
   - macOS release code uses the approved Developer ID identities, hardened runtime
     where applicable, and an inside-out signing order for every
     OpenDelegate-produced Mach-O, native helper, and containing bundle.
     Third-party native code must retain a verified upstream identity or be
     re-signed according to the declared release policy before payload freeze;
   - Windows release code uses the approved Authenticode identity and trusted
     timestamp for every OpenDelegate-produced PE executable and native helper.
     Third-party PE files retain a verified upstream signature and pinned digest or
     are re-signed according to the declared release policy before payload freeze;
     and
   - the first-milestone Linux archive has no additional platform-native signature
     requirement. It still requires the publisher and promotion authorities below.
3. **Publisher attestation** is one detached Ed25519 statement per target candidate.
   It authenticates the exact payload-manifest digest, checksum-manifest digest,
   final archive digest, target tuple, build commit B, audited source commit A, and
   acceptance-ledger digest. Its public key is provisioned through the existing
   external publisher trust-root path. It does not assert `released`.
4. **macOS notarization receipt** is an external sidecar for the exact final macOS
   archive. It records the archive SHA-256, Apple submission identifier, accepted
   status, Team ID, and the retained Apple result/log identities. It is created
   only after the final archive and its publisher attestation exist. It is never
   stapled into or otherwise used to rewrite that archive.
5. **Cross-platform promotion attestation** is one detached statement for the whole
   release, signed under a dedicated promotion key whose public trust root is
   distinct from the publisher trust root. It authorizes a complete set of exact
   target candidates for one supported channel.
6. **Remote read-back observations** are exactly three signed envelopes, one for
   each first-milestone target archive. Each binds the immutable channel and object
   identity, target tuple, expected and observed digest, observation time, the
   promotion statement, and the uploader authorization. They verify against a
   separately provisioned observer trust root. The observer key is distinct from
   every publisher and promotion/uploader key and can be revoked independently.
7. **Supported-channel release receipt** is produced only after publication and
   verification of all three remote read-back envelopes. It records the immutable
   channel, tag or release identity, promotion-attestation digest, published asset
   identities and SHA-256 digests, observer envelope identities and digests, and
   observation time. It is signed with the promotion role using a domain distinct
   from the promotion authorization.

Publisher, promotion, and observer keys must have different SPKIs and key IDs.
Native platform certificate chains and those three external trust roots are
separate authorities. The read-back plan deliberately names the promotion key ID
as its uploader authorization; it does not provision a separate uploader signing
key. Compromise or approval in one role cannot silently grant another role.

### Immutable candidate order

Every supported target follows this order:

1. `pnpm release:gate` passes against clean attestation commit B and its audited
   source commit A. The A-to-B restrictions from ADR-0010 remain unchanged.
2. A target-native, clean, committed, hash-pinned release runner assembles a staging
   tree from B with the pinned runtime and frozen dependencies.
3. The runner applies and verifies all required macOS or Windows native code
   signatures. No payload integrity manifest exists yet.
4. The runner freezes the payload and generates release metadata,
   `payload-manifest.json`, and `SHA256SUMS` over the already signed bytes. Packaged
   smoke and target-native signature verification run against that frozen payload.
5. The runner creates the deterministic final archive and its detached publisher
   attestation. Neither operation writes into the payload tree afterward.
6. For macOS, the exact final archive is submitted for notarization. The accepted
   result is retained only as an external sidecar, and Gatekeeper validation is
   recorded without stapling or modifying the candidate.
7. Clean-host platform, service, provider, Discord, route, Artifact, recovery, and
   Computer Use evidence runs against the exact manifest and archive digests that
   will be promoted.

Any byte change after step 4 invalidates that target candidate and all downstream
publisher, notarization, lab, promotion, and publication records. Recovery starts
again at target staging and native signing; it never patches a manifest or ledger.

The candidate's enclosed declared channel remains `release-candidate`. OpenDelegate
does not rewrite the payload, acceptance ledger, release metadata, or archive to
spell `released`.

### Cross-platform promotion

Promotion is permitted only after all required target candidates and live evidence
are complete. The cross-platform promotion attestation binds at least:

- release ID and version;
- audited source commit A and build/attestation commit B;
- acceptance-ledger schema, digest, candidate attestation ID, and digest;
- the exact support-matrix document digest and complete required target tuple set;
- for every target, the final archive, payload manifest, checksum manifest, release
  metadata, and publisher-attestation digests plus the publisher key ID;
- native-signing certificate identities and verification evidence for macOS and
  Windows;
- the macOS notarization receipt digest and accepted submission identity;
- immutable live-evidence references for every release criterion;
- the intended supported channel and publication policy; and
- a schema version, issuance time, and unique statement ID.

The promotion gate rejects a missing target, duplicate tuple, unsupported target
substitution, incomplete or preview status, different A or B, different ledger,
untrusted publisher key, untrusted or missing platform authenticity evidence, or
an evidence reference that is not bound to the same candidate.

The promotion attestation and later release receipt are external sidecars. They may
be committed or published through the supported channel, but they never authorize
an A-to-B source change and never enter or rewrite a candidate payload.

### Effective release status

`released` is a computed trust result, not a value trusted from enclosed metadata,
a filename, a Git tag, or an environment variable.

A verifier may report an effective channel of `released` only when all of the
following hold:

1. the enclosed candidate integrity chain is valid and declares
   `release-candidate`;
2. the target's detached publisher attestation verifies against the externally
   provisioned publisher trust root and matches every candidate digest;
3. required native signatures and the macOS notarization sidecar validate against
   the identities named by the promotion policy;
4. the cross-platform promotion attestation verifies against the externally
   provisioned promotion trust root and includes this exact target in a complete
   supported matrix;
5. exactly three observer-signed read-back envelopes verify against the external
   observer trust root, cover each required target archive exactly once, name the
   promotion key as uploader authorization, and match the same promotion,
   immutable channel objects, and remotely observed asset digests;
6. the supported-channel release receipt verifies under the promotion role, names
   the same promotion attestation and channel, and digest-binds those exact three
   observer envelopes; and
7. no applicable publisher, promotion, observer, or platform identity, promotion
   statement, or release receipt is revoked by the configured release policy.

If any external sidecar or trust root is absent, the bytes remain a valid
`release-candidate` at most. Enclosed metadata that directly declares `released`
fails closed. Runtime and installer surfaces should expose declared candidate status
and effective verified status separately.

### Preview and CI signatures

`internal-preview-blocked` and `internal-preview-complete` are never promotion
eligible. A complete preview must be rebuilt through the production candidate path;
renaming or resigning it is insufficient.

The existing explicit `--allow-unsupported-preview` publisher-attestation path is
only for controlled platform-lab installation. A CI-generated key, ad-hoc
certificate, self-signed native binary, or public key emitted beside its signature
does not satisfy a supported trust root, even if every digest is correct. Hosted CI
may verify mechanics with ephemeral credentials but cannot produce a
support-eligible candidate.

### Credential-bearing release runners

Native code signing, timestamping, notarization submission, publisher signing,
promotion signing, observer signing, and supported-channel publication are
credential-bearing operations. They may run only when:

- the release logic and policy come from clean committed B or an immutable
  artifact whose digest is pinned by B;
- the target-native runner image, signing tools, and helper executables are
  allowlisted by exact version and cryptographic digest;
- the candidate input is selected by an already verified digest rather than a
  mutable path alone;
- private material arrives through an approved external Secret Store, HSM, keychain,
  or short-lived workload identity and never through source, bundle contents,
  acceptance evidence, Agent context, command arguments, or logs; and
- the runner emits a sanitized record of source identity, runner identity, tool
  hashes, public key or certificate IDs, input digests, and output digests.

A dirty checkout, uncommitted release script, unpinned helper, or unverifiable
runner may produce only engineering output. It cannot produce a trusted publisher
attestation, platform authenticity record, promotion attestation, or release
receipt.

## Alternatives considered

### Sign native executables after generating manifests

Rejected. Native signatures mutate executable bytes and would invalidate the
candidate integrity chain. Regenerating the manifests would create a different
candidate from the one already reviewed.

### Staple macOS notarization after publisher attestation

Rejected for the first milestone because stapling mutates the signed candidate
after its manifests and publisher attestation exist. The exact final archive is
notarized, and the accepted result remains an external sidecar. This means initial
Gatekeeper assessment may require access to Apple's notarization service.

### Rewrite release metadata from `release-candidate` to `released`

Rejected. It would change the payload after support evidence and create a circular
need to regenerate manifests and attestations. Effective status is derived from
external trusted promotion and publication records.

### Use one signature for publisher authenticity and support promotion

Rejected. Authenticating one bundle does not prove the cross-platform acceptance
matrix or authorize public support. Separate keys and statement domains limit the
effect of a compromised build or promotion role.

### Treat a Git tag, uploaded filename, or CI self-signature as promotion

Rejected. None proves that the remote bytes match the complete set approved by the
support gate or that the key was trusted independently.

### Add archive identities back into the acceptance ledger

Rejected. The ledger is an input to candidate construction and remains immutable.
The detached promotion attestation binds later-created target archives without
weakening ADR-0010's A-to-B diff restriction.

## Consequences

- Supported publication gains a non-circular trust chain while candidate payload
  bytes and the accepted ledger remain immutable.
- Platform build credentials, support-promotion credentials, and remote-observer
  credentials are operationally separate and can be rotated or revoked
  independently.
- The first release requires additional external sidecars and a verifier that
  computes effective status. The current publisher signer alone is insufficient.
- macOS candidates are not stapled after finalization. If offline Gatekeeper
  validation later becomes a requirement, a new ADR must change the archive order
  and rerun the complete candidate pipeline rather than mutate an existing
  candidate.
- A release is promoted as one complete platform set. A working Windows asset
  cannot become supported while the declared macOS or Linux target is missing.
- Actual Developer ID and Authenticode identities, notarization access,
  owner-controlled Devices, Discord and provider credentials, and the complete live
  matrix remain external blockers. Accepting this design does not satisfy those
  release gates.

## Verification

- Tests prove native signing occurs before manifest generation and that any
  post-manifest mutation invalidates publisher and promotion verification.
- Candidate tests prove the enclosed metadata remains `release-candidate` and that
  an enclosed `released` value fails closed.
- Promotion contract tests reject a missing tuple, preview artifact, changed ledger,
  mismatched A or B, wrong publisher key, reused statement domain, substituted
  archive, missing notarization receipt, and untrusted or revoked promotion root.
- Publication tests upload immutable candidates to a disposable channel, read the
  bytes back, require exactly three independently signed target observations, and
  reject a receipt when an observation is missing, duplicated, signed by the
  uploader/promotion authority, revoked, or bound to a different remote digest,
  tag, channel, or promotion-attestation digest.
- Self-signing tests prove an ephemeral CI key or a key supplied only beside the
  candidate cannot become support eligible.
- Runner tests reject dirty, uncommitted, unpinned, or digest-mismatched signing and
  publication tools before they can access a release credential.
- The macOS lab verifies Developer ID signatures, the accepted notarization result,
  Gatekeeper assessment, and exact archive digest without post-attestation
  stapling.
- The Windows lab verifies Authenticode chains, trusted timestamps, publisher
  identity, and exact manifest-bound PE bytes.
- Final evidence proves every declared target, service lifecycle, provider,
  Discord, route, Artifact, recovery, and Computer Use criterion against the exact
  candidate digests in one promotion attestation.

## References

- `CONTEXT.md`, invariants 19 and 20
- `docs/PRODUCT_SPEC.md`, First Milestone Acceptance Criteria 6, 19, and 32
- `docs/IMPLEMENTATION_PLAN.md`, Spike B and Phase 13
- `docs/DECISIONS.md`, D-040 and D-047
- [`ADR-0010`](0010-reproducible-platform-bundles-and-provenance.md)
- [`ADR-0011`](0011-native-two-plane-service-supervision-and-authenticated-ipc.md)
- [`ADR-0017`](0017-device-local-secret-store-backends.md)
- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Apple: Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [Microsoft: SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)
