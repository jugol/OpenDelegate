# Release evidence and bundle policy

> [!CAUTION]
> This document covers the retained Admin Web prototype. Its bundle builder is retired, and these
> instructions do not release the current SSH-first OpenDelegate workflow. See `../../CONTEXT.md`.

OpenDelegate does not infer release readiness from compilation, unit tests, hosted CI, or a
successful internal-preview smoke. The first milestone is releasable only when every criterion under
[`First Milestone Acceptance Criteria`](../PRODUCT_SPEC.md#first-milestone-acceptance-criteria) has
both complete implementation evidence and its required live proof.

There are 36 criteria. None may be waived, including macOS, Windows, Linux, Discord, native
provider, service/restart, mixed-route, Artifact, or Computer Use proof.

## Authoritative status

[`acceptance-evidence.json`](acceptance-evidence.json) is the machine-readable ledger. Check it
through the validator:

```sh
pnpm release:status
```

A zero process exit means the ledger is structurally valid. It does **not** mean the release is
complete; read the returned `releaseStatus` and `complete` fields.

The current audit remains `blocked`. Source packages now compose a runnable bundled Main with its
co-located Worker, authenticated Admin operations, durable SQLite/PostgreSQL Task state,
owner-auth, enrollment, mutual-TLS Device channels, Discord HTTP/Gateway handling, programmatic
Agent Adapters, exact native-session steering, Device-local Knowledge, resumable Artifact transfer,
SQL-backed Artifact metadata and Device observations, Task Budget inspection and extension,
platform-service hosts and executors, and native Computer Use candidates. Main also holds a
database-appropriate process-lifetime singleton authority, and its startup gate reconciles Discord
and composes Device/Artifact prerequisites before automatic Task dispatch. The owner-session helper
can open the canonical Admin origin once per login only when the typed Main preference is enabled.
Source composition and deterministic tests are not release proof.
Clean-host service privilege, signing/notarization, live provider and Discord credentials, mixed
private routes, reboot/recovery, real Artifact opening, and the complete three-OS Computer Use
matrix remain externally unproven. The repository implements ADR-0021's immutable candidate
verifier, target finalizer, strict digest-addressed external authority resolver, and declared versus
effective runtime projection. Real release credentials, independently provisioned authorities,
signed and notarized target candidates, credentialed promotion, publication, three observer-signed
remote read-back envelopes, one supported-channel receipt, and complete live evidence do not yet
exist.

## Status vocabulary

Implementation and live proof are recorded separately:

- `verified` — the implementation or required proof passed at the referenced immutable build or
  commit.
- `partial` — a public contract, deterministic fixture, or some production code exists, but
  production wiring or required proof is incomplete.
- `missing` — the implementation required by the criterion does not exist.
- `not-run` — the proof has not run or has no durable evidence yet.
- `blocked-external` — proof requires an owner-controlled Device, account, credential, permission,
  network, service, or signing identity that is not currently available.

Fake adapters, WSL/WSLg, hosted CI, read-only host probes, rendered service files, and mocked
browser APIs are useful engineering evidence. They cannot be recorded as real macOS, Windows, Linux,
Discord, provider, reboot, or desktop-control proof.

The surrounding release labels are distinct from criterion status:

| Surface                         | Exact meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------------- |
| Public source pre-alpha         | Reviewable source with no support claim                                     |
| `internal-preview-blocked`      | Unsupported validation bundle from an incomplete ledger                     |
| `internal-preview-complete`     | Unsupported validation bundle from a complete ledger                        |
| `release-candidate`             | Complete-gate immutable bundle awaiting trusted external promotion           |
| `released`                      | Effective result of immutable candidate integrity plus the verified publisher, platform, promotion, observer-read-back, channel-receipt, and revocation-policy chain |

The runtime API exposes three separate facts:

- `declaredReleaseChannel` is the identity enclosed by the build: `development`,
  `internal-preview`, or `release-candidate`;
- `releaseChannel` is the effective verified result and adds `released`; and
- `releaseVerification` is a sanitized status: `not-applicable`, `absent`,
  `publisher-verified`, `invalid`, `promotion-invalid`, `revoked`, or `released`.

Only effective `released` can represent a supported publication, and only when the connected
runtime features are also ready. Enclosed candidate metadata always remains
`release-candidate`; the verifier computes effective status from external sidecars,
independently provisioned trust roots, and revocation policy.

## Historical internal-preview procedure (retired)

Do not run the commands in this section. They document the old prototype's bundle contract for
source review and regression tests. The direct builder now fails closed with a pointer to the current
SSH-first workflow.

The bundle builder requires exactly **Node.js 24.18.0**. It rejects every other runtime version,
even if that version satisfies the contributor engine range.

The retired procedure first prepared and validated the checkout:

```sh
node --version
git status --short
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:browser
```

Historically, `node --version` had to print `v24.18.0`, and `git status --short` had to print nothing.
The next command is preserved only as a record and now fails:

```sh
pnpm release:build --destination ABSOLUTE_PATH --internal-preview
```

The destination must:

- be an absolute path;
- be outside the source checkout; and
- not already exist; and
- contain `internal-preview` in its final directory name.

Before retirement, the builder refused to overwrite an existing destination. It built Admin Web,
deployed Main's production dependencies, bundled the Main CLI, downloaded the exact official Node.js
24.18.0 archive for the current OS and architecture, verified its audited archive SHA-256, and wrote:

- `release-metadata.json` with distinct build and audited-source identities, candidate attestation
  paths when verified, dirty-state, platform, architecture, official runtime archive/executable
  hashes, lockfile/package-manifest hashes, ledger summary, and exact `internal-preview-*` support
  status;
- `INTERNAL_PREVIEW.md` with a prominent unsupported warning;
- `smoke-evidence.json` for top-level, backup, and service CLI help; clean-home initialization;
  Main health; Admin static serving; loopback owner claim; owner login; host-only session-cookie
  contract/round-trip; recovery-code issuance; and clean shutdown;
- `SHA256SUMS`;
- the Node.js license and a complete legal inventory for runtime package instances and production
  dependencies compiled into Admin Web, including copied font/package terms, retained package
  license files, and explicit same-project or curated versioned sources where publishers omitted a
  standalone file;
- an English-default launcher-first `README.md` plus Korean, Japanese, French, Spanish, and
  Simplified Chinese bundle READMEs, each with the exact support-status code, language navigation,
  unsupported-preview or unpromoted-candidate warning, and platform launcher commands;
- the Admin assets, init skill, remaining release documentation, and launchers; and
- the bundled Main runtime and production dependencies.

The packaged smoke reserves an isolated, dynamically selected adjacent loopback listener pair and
uses a temporary Main home. It does not require ports `4380` or `4381`, stop a running Main, modify
an installed service, or activate the new bundle. If no safe listener pair can be reserved, the
build fails without touching the installed runtime. If another local process claims a selected
pair during the launcher handoff, smoke retries a bounded number of times with a fresh temporary
home and pair.

All bundle modes export the clean build commit into a disposable directory, run the frozen install
and production deployment there, and remove it after success or failure. Packaging therefore
cannot rewrite the live checkout's pnpm state, and ignored, untracked, or environment files cannot
enter a preview. A minimal launcher re-executes the release tool and evidence auditor from the
captured commit's snapshot; the snapshot files must then byte-match their Git blobs before any
repository input is accepted. It streams the official pnpm 11.15.1 npm archive through a 25 MiB
limit and executes it only after its pinned SHA-512 matches. Every later pnpm process receives an
explicit regular CLI path outside the live checkout.

The launchers clear caller-provided identity variables. The packaged CLI derives its version,
build ID, and declared channel only after verifying the enclosed
`SHA256SUMS` → `payload-manifest.json` → `release-metadata.json` → acceptance-ledger chain.
Schema, hash, count, or status disagreements in candidate bytes stop startup. Source-checkout runs
always identify as `development`, and internal previews retain their unsupported identity.
For a valid candidate, Main resolves external release authority below its resolved state root:
absent, invalid, incomplete, or revoked external material keeps the effective channel at
`release-candidate`, while the complete verified ADR-0021 chain alone produces `released`.

Payload assembly also rejects symbolic links, Windows junctions, and special files. The current
manifests cover regular file bytes, so a link is never allowed to sit outside their coverage.

The bundle is valid only for installation and integration testing on the OS and architecture where
it was built. It is not a cross-platform archive, does not prove native service persistence, does
not install a service by itself, and must not be published under a release tag.

An internal preview is never support eligible, even if it is signed with a CI, ad-hoc, or
self-generated key. Support-eligible macOS and Windows native signing is a production-candidate
operation and must occur before payload manifests are generated; the current preview command does
not establish that release identity.

Use `opendelegate.cmd` on Windows or `./opendelegate` on macOS/Linux. Runtime state, credentials,
databases, logs, and generated Artifacts must remain outside both the source checkout and the
release bundle.

Building is not upgrading. For a persistent supported installation, activate exact verified bytes
only through the native `opendelegate service install` or `opendelegate service upgrade` lifecycle
described in [`SERVICE_LIFECYCLE.md`](../SERVICE_LIFECYCLE.md). A foreground or transient supervisor
used for internal-preview validation is not persistence proof; stopping such a wrapper may remove
its supervisor registration, so retain the exact validated relaunch procedure.

## Legacy preview attestation for service installation

Native install and upgrade authenticate bundle bytes with a detached Ed25519 publisher
attestation. The `release:sign` command is the legacy, explicitly unsupported preview path. It
rejects production candidates and cannot create support eligibility.

Keep the Ed25519 PKCS#8 private key outside the checkout, bundle, runtime home, logs, and Agent
context. After a bundle contains both target-native service hosts and its packaged smoke has
passed, acknowledge and sign the preview with:

```sh
pnpm release:sign --bundle ABSOLUTE_BUNDLE_PATH \
  --private-key ABSOLUTE_PRIVATE_KEY_PEM \
  --public-key-destination ABSOLUTE_NEW_PUBLIC_KEY_PEM \
  --allow-unsupported-preview
```

The preview signer:

- rejects linked or special paths and byte-compares the complete payload and checksum manifests;
- requires the two target-native service executables and matching successful packaged smoke;
- refuses every `release-candidate`;
- derives the publisher key ID from the Ed25519 public key;
- creates `BUNDLE_PATH.publisher-attestation.json` and the requested public-key file with
  create-new semantics; and
- never copies, prints, or overwrites the private key or an existing output.

Provision the emitted public key through an owner-controlled channel as
`STATE_ROOT/trust/publisher-ed25519.pem`. Configure `bundle.checksum` as
`sha256:<manifestSha256>` from the signer result. Do not accept a public key delivered only inside
the bundle it is expected to authenticate. Windows publisher-key ACL review and any platform code
signing/notarization remain separate operator gates.

Production candidates use `pnpm release:finalize` from the exact clean, committed, hash-pinned
target runner. The finalizer revalidates the already native-signed frozen payload, packaged smoke,
candidate completeness, pinned runtime and release tools; creates the deterministic final archive;
and obtains the candidate-v2 publisher attestation through the opaque external signing policy.
That statement binds the exact archive, target tuple, A/B identities, ledger, native authenticity,
and manifest digests without exposing private material in argv, output, logs, or Agent context.
Neither finalization nor publisher verification changes the enclosed channel.

## Supported promotion trust path

[`ADR-0021`](../adr/0021-supported-release-promotion-and-native-authenticity.md) fixes the
non-circular order for a supported release:

1. The completed ledger at clean attestation commit B passes `release:gate` for audited source
   commit A.
2. A clean committed, hash-pinned target runner assembles the target staging tree. macOS Developer
   ID or Windows Authenticode signing and verification mutate executable bytes only at this stage,
   before `payload-manifest.json` and `SHA256SUMS` exist.
3. The already signed payload is frozen; manifests, packaged smoke, the deterministic final
   archive, and the detached publisher attestation bind those exact bytes.
4. The exact final macOS archive is submitted for notarization only now. The accepted Apple result
   remains an external sidecar. The archive is not stapled or rewritten after its publisher
   attestation.
5. After every target and every live criterion is complete, one separately signed cross-platform
   promotion attestation binds the ledger, complete support matrix, candidate archives, native
   identities, publisher attestations, notarization receipt, and immutable evidence.
6. The exact assets are published and each of the three target archives is read back by digest.
   An independent observer signs exactly one bounded observation envelope per target against its
   separately provisioned observer trust root.
7. A signed supported-channel release receipt binds the promotion, immutable publication identity,
   uploader authorization, and all three verified observer envelopes.

The per-target publisher trust roots, cross-platform promotion trust root, and observer trust root
are external, mutually distinct, and provisioned independently of the bytes they authorize. The
read-back plan names the promotion key ID as its uploader authorization; the observer key must
differ from it and is independently revocable. The candidate payload, archive, metadata, and
acceptance ledger never change during these steps. A filename, environment variable, Git tag,
embedded `released` value, preview signature, or CI-generated public key cannot replace the
external verification chain.

For each installed candidate, provision strict canonical
`release-verification.json` at:

```text
STATE_ROOT/trust/releases/<version>/<platform>-<architecture>/<checksumManifestSha256>/release-verification.json
```

Every referenced archive, attestation, trust root, notarization record, support-matrix file, and
criterion-evidence file must be a distinct bounded regular file beneath that digest-addressed trust
directory and outside the candidate. The resolver rejects aliases, links, case collisions, path
escapes, inconsistent targets or digests, incomplete 36-item evidence, a missing or duplicate
target observation, reused authorities, and applicable publisher, promotion, observer, platform,
statement, or receipt revocations. A publisher-only configuration authorizes candidate
installation but cannot produce effective `released`.

The installer and runtime may compute effective `released` only when the candidate integrity
chain, native authenticity, publisher attestation, complete promotion attestation, all three
observer-signed target read-back envelopes, supported channel receipt, and applicable trust roots
verify for the same exact asset. Otherwise the artifact remains a `release-candidate` at most. The
verifier and deterministic promotion/receipt composition tools are implemented, but no supported
publication is possible until their exact external trust material, credentialed runs, remote
digest read-back, and complete live evidence exist.

Credential-bearing native signing, timestamping, notarization, publisher signing, promotion
signing, observer signing, and publication tools may run only from the clean committed/hash-pinned
runner contract. Their private material stays in an external Secret Store, HSM, keychain, or
short-lived workload identity and never enters argv, source, bundle files, Agent context, logs, or
public evidence. Publisher and promotion signing policies select a pre-provisioned local IPC
broker, pin distinct release and transport Ed25519 authorities, and use a same-session two-phase
one-shot capability. See [`SIGNER_BROKER_PROTOCOL.md`](SIGNER_BROKER_PROTOCOL.md) for the exact
wire grammar, peer authorization, monotonic expiry, and deployment requirements.

### Promotion, receipt, and authority tooling

The production tools intentionally do not choose a hosting provider or upload assets. An operator
may use any immutable channel whose uploader and independent reader can produce the strict pinned
records, including a private owner-controlled channel. The trust steps remain deterministic:

To inspect credential-free canonical plan and signer-policy shapes, first run
`pnpm release:examples -- --destination ABSOLUTE_NEW_DIRECTORY`; every generated file is marked
`PLACEHOLDER` and `NOT-A-RELEASE`. The output is documentation, not evidence or authorization.
See [`EXAMPLES.md`](EXAMPLES.md).

```sh
pnpm release:finalize -- \
  --candidate ABSOLUTE_CANDIDATE_DIRECTORY \
  --destination ABSOLUTE_NEW_OUTPUT_DIRECTORY \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256 \
  --target darwin-arm64 \
  --expected-manifest-sha256 SHA256 \
  --expected-candidate-digest SHA256 \
  --signing-policy ABSOLUTE_PUBLISHER_SIGNING_POLICY \
  --signing-policy-sha256 SHA256

pnpm release:promote -- \
  --repository ABSOLUTE_CLEAN_CHECKOUT \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256 \
  --plan ABSOLUTE_PROMOTION_PLAN --plan-sha256 SHA256 \
  --signing-policy ABSOLUTE_PROMOTION_SIGNING_POLICY --signing-policy-sha256 SHA256 \
  --attestation-destination ABSOLUTE_NEW_ATTESTATION \
  --runner-record-destination ABSOLUTE_NEW_RUNNER_RECORD

pnpm release:receipt -- \
  --repository ABSOLUTE_CLEAN_CHECKOUT \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256 \
  --promotion-plan ABSOLUTE_PROMOTION_PLAN --promotion-plan-sha256 SHA256 \
  --read-back-plan ABSOLUTE_READ_BACK_PLAN --read-back-plan-sha256 SHA256 \
  --observer-trust-root ABSOLUTE_OBSERVER_PUBLIC_KEY \
  --observer-trust-root-sha256 SHA256 \
  --signing-policy ABSOLUTE_PROMOTION_SIGNING_POLICY --signing-policy-sha256 SHA256 \
  --receipt-destination ABSOLUTE_NEW_RECEIPT \
  --runner-record-destination ABSOLUTE_NEW_RUNNER_RECORD

pnpm release:configure -- \
  --repository ABSOLUTE_CLEAN_CHECKOUT \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256 \
  --plan ABSOLUTE_CONFIGURATION_PLAN --plan-sha256 SHA256 \
  --destination-root ABSOLUTE_NEW_EXTERNAL_BUNDLE
```

`release:finalize` runs separately on each target-native host. `release:promote` re-verifies the
exact three candidates, their independent publisher roots, platform authenticity, macOS
notarization, support matrix, and all 36 immutable evidence records. Its promotion authority must
differ from every publisher authority. `release:receipt` re-composes and verifies that promotion,
then authenticates exactly three independently created observer envelopes against the pinned
observer trust root—one for each remotely read-back candidate archive. The observer authority must
differ from the promotion/uploader authorization and every publisher authority. The read-back plan
must name the promotion authority as `uploaderAuthorityKeyId`; this binds publication authorization
without creating a second uploader signing key. The promotion attestation is separately signature-
and digest-bound rather than counted as a target archive. The configured revocation policy covers
observer key IDs independently.

`release:configure` accepts either a publisher-only or fully released plan, re-verifies the entire
selected chain, and creates a new standalone state-root-shaped bundle containing only bounded
external public material plus a sanitized runner record. It never installs into a Device state
root. The owner must review and copy that bundle through an appropriate privileged boundary, then
rerun Main and installer verification. All plans and signing policies are strict canonical JSON,
SHA-256 pinned on the command line, and stored outside the checkout, candidates, outputs, and
credential store. Every credential-bearing production command shown above requires Node.js 24.18.0
and independently pins the exact orchestrating `process.execPath` bytes with
`--runner-executable-sha256`; derive that value from the approved runner provenance, not from an
untrusted executable at invocation time. It also pins an absolute unlinked Git executable by
SHA-256 and clears ambient Git repository and configuration overrides. The sanitized runner record
retains the verified executable digests. Output paths must be absent; partial publication rolls
back without overwrite.

## Historical production gate (retired)

This section is also a record of the legacy prototype. It does not authorize a release and its
`release:build` command now fails closed.

The production evidence check is:

```sh
pnpm release:gate
```

It must fail while any of the 36 criteria is incomplete. The production bundle command omits the
preview flag:

```sh
pnpm release:build \
  --destination ABSOLUTE_PATH \
  --git-executable ABSOLUTE_UNLINKED_GIT \
  --git-executable-sha256 APPROVED_GIT_EXECUTABLE_SHA256 \
  --runner-executable-sha256 APPROVED_NODE_EXECUTABLE_SHA256
```

That command is complete as written only for the Linux x64 candidate, whose first-milestone native
policy is built-in `publisher-only`. The macOS and Windows candidate commands must additionally
include:

```sh
  --platform-signing-policy ABSOLUTE_PLATFORM_SIGNING_POLICY \
  --platform-signing-policy-sha256 APPROVED_PLATFORM_SIGNING_POLICY_SHA256
```

That command must also fail before bundle assembly while the ledger is blocked. Once the ledger is
complete, a production candidate uses an audited-source/attestation two-commit contract:

1. `acceptance-evidence.json` names the exact 40-character audited source commit **A**.
2. The evidence and completed ledger are committed in a distinct descendant commit **B**.
3. The candidate is assembled from a clean checkout of B.
4. The builder verifies before and after assembly that A exists, A is an ancestor of B, and the
   A-to-B diff contains only:
   - a regular mode-`100644` modification of `acceptance-evidence.json`; and
   - added or modified regular mode-`100644` files under `docs/release/evidence/` that are
     SHA-256-bound by `verification.implementation`, `verification.liveProof`, or
     `candidateAttestation`.

Generic criterion `evidence` paths do not authorize a change between A and B. The candidate gate
rejects unreferenced files, deletions, renames or copies, type or mode changes, symlinks,
submodules, and every source, configuration, builder, schema, or ordinary documentation change.
Candidate `release-metadata.json` records B as `buildCommit`, A as `auditedSourceCommit`, and the
complete `changedAttestationPaths` list. Unsupported previews set that candidate-only path list to
`null` because their incomplete evidence state has not passed this candidate provenance gate.

Passing this gate authorizes candidate assembly only. It does not authorize a native-signing
credential, notarization submission, promotion signature, public upload, release tag, or support
claim. Those operations must pass the immutable ADR-0021 trust path above, and final target archive
identities are recorded in detached promotion artifacts rather than written back into the ledger.

All provenance Git reads ignore local replacement refs. Every bundle exports its clean build commit
through `git archive`, performs the frozen install inside that external committed snapshot, and
uses only the snapshot for source, Admin, documentation, skill, and legal inputs. As defense in
depth, the clean-checkout test still requests every untracked path explicitly even when local Git
status configuration would otherwise hide it.

Do not:

- edit the ledger merely to make either command pass;
- replace live proof with a prose assertion or fixture result;
- remove the internal-preview marker;
- tag, upload, sign, publish, or announce an internal preview as supported; or
- call local foreground startup a completed cross-platform deployment.

GitHub Private Vulnerability Reporting is enabled and verified for the public repository. Keep the
exact private route documented in [`SECURITY.md`](../../SECURITY.md) and reverify it before a
supported release.

## Evidence requirements

Evidence must be durable and attributable. Depending on the criterion, acceptable records include:

- immutable CI run IDs and retained reports;
- sanitized platform-lab logs bound to a source commit and bundle checksum;
- screenshots and action summaries where Computer Use requires them;
- Discord post, message, tag, and component identifiers without private message content;
- provider and service versions with start, resume, cancel, restart, and recovery results;
- bundle metadata, manifests, provenance, and checksums; and
- redacted negative-test output for authorization, replay, permission, isolation, and failure cases.

Every `verified` implementation or live-proof status must include its matching `verification`
object. That object contains a full 40-character `sourceCommit`, an immutable `attestationId`, and
one or more repository-relative evidence references with exact SHA-256 digests:

```json
{
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "attestationId": "ci-or-lab-run-immutable-id",
  "evidence": [
    {
      "path": "docs/release/evidence/sanitized-report.json",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

A complete ledger additionally requires a top-level `candidateAttestation` with the same shape.
Evidence paths must resolve to regular, non-symlink files inside the canonical repository. The
validator recalculates their hashes against commit B's checkout, while every proof remains bound to
the audited source commit A. The bundle gate then restricts the complete A-to-B diff as described
above, avoiding both a circular self-attestation and an opportunity to slip unaudited product code
into the candidate.

Keep raw credentials, bot tokens, owner claim/recovery data, private Task content, Device Knowledge,
private hostnames, and sensitive network topology out of public evidence.

Managed Secret Store callbacks bound plaintext exposure but do not create secure memory. A trusted
long-lived Main client such as the PostgreSQL pool may retain parsed connection configuration until
it closes. Release inspection must prove that credentials do not enter persisted configuration,
argv, child environments, logs, diagnostics, Agent prompts, backups, or public evidence; it must not
misstate in-process client retention as immediate erasure.

## Current blocking categories

The declared first-milestone targets are fixed in
[`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), and the exact resumable external checklist is in
[`PLATFORM_LAB.md`](PLATFORM_LAB.md). At minimum,
supported release proof still needs:

- owner-controlled Main and Worker runs on real macOS, Windows, and Linux;
- persistent native services and user-session helpers through restart, reboot, login, logout,
  upgrade, rollback, and uninstall;
- a dedicated Discord Community/Forum laboratory and production HTTP/Gateway integration;
- authenticated, pinned Codex and Claude live sessions;
- real Computer Use on macOS, Windows, and one declared graphical Linux environment, plus explicit
  headless-Linux unavailability;
- mixed-OS, mixed-route, Worker reconnect, Artifact upload, and exposure scenarios;
- signing/notarization and publishing inputs appropriate to the distributed platform bundles; and
- independently provisioned, distinct publisher, promotion, and observer authorities; credentialed
  target-native pre-manifest signing; exact-archive macOS notarization; promotion artifacts; remote
  publication; exactly three observer-signed target read-back envelopes; and the supported-channel
  digest receipt.

The safe metadata snapshot and fresh-target recovery contract is documented in
[`BACKUP_AND_RESTORE.md`](../BACKUP_AND_RESTORE.md). Passing its deterministic
checks does not replace the required live reconciliation proof.

Until those proofs are linked in the ledger, the honest outcome is **internal preview built**, not
**OpenDelegate deployed** or **first milestone released**.
