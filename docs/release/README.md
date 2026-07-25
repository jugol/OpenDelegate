# Release evidence and bundle policy

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
matrix remain externally unproven.

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
| `release-candidate`             | Complete-gate bundle awaiting separate publication/promotion attestation     |
| `released`                      | Immutable candidate promoted through a documented supported channel         |

The Admin runtime channel uses `development`, `internal-preview`, `release-candidate`, or
`released`. Only `released` can represent a supported publication, and only when the connected
runtime features are also ready.

## Build an unsupported internal preview

The bundle builder requires exactly **Node.js 24.18.0**. It rejects every other runtime version,
even if that version satisfies the contributor engine range.

Prepare and validate the checkout:

```sh
node --version
git status --short
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:browser
```

`node --version` must print `v24.18.0`, and `git status --short` must print nothing. Then build a
platform-specific validation bundle:

```sh
pnpm release:build --destination ABSOLUTE_PATH --internal-preview
```

The destination must:

- be an absolute path;
- be outside the source checkout; and
- not already exist; and
- contain `internal-preview` in its final directory name.

The builder refuses to overwrite an existing destination. It builds Admin Web, deploys Main's
production dependencies, bundles the Main CLI, downloads the exact official Node.js 24.18.0 archive
for the current OS and architecture, verifies its audited archive SHA-256, and writes:

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

All bundle modes export the clean build commit into a disposable directory, run the frozen install
and production deployment there, and remove it after success or failure. Packaging therefore
cannot rewrite the live checkout's pnpm state, and ignored, untracked, or environment files cannot
enter a preview. A minimal launcher re-executes the release tool and evidence auditor from the
captured commit's snapshot; the snapshot files must then byte-match their Git blobs before any
repository input is accepted. It streams the official pnpm 11.15.1 npm archive through a 25 MiB
limit and executes it only after its pinned SHA-512 matches. Every later pnpm process receives an
explicit regular CLI path outside the live checkout.

The launchers clear caller-provided identity variables. The packaged CLI derives its version,
build ID, and runtime channel only after verifying the enclosed
`SHA256SUMS` → `payload-manifest.json` → `release-metadata.json` → acceptance-ledger chain.
Schema, hash, count, or status disagreements stop startup. This proves only that the enclosed
files agree with each other; it does not authenticate their publisher. Source-checkout runs always
identify as `development`, and the current runtime rejects `released` until a separate trusted
promotion-attestation verifier is designed.

Payload assembly also rejects symbolic links, Windows junctions, and special files. The current
manifests cover regular file bytes, so a link is never allowed to sit outside their coverage.

The bundle is valid only for installation and integration testing on the OS and architecture where
it was built. It is not a cross-platform archive, does not prove native service persistence, does
not install a service by itself, and must not be published under a release tag.

Use `opendelegate.cmd` on Windows or `./opendelegate` on macOS/Linux. Runtime state, credentials,
databases, logs, and generated Artifacts must remain outside both the source checkout and the
release bundle.

## Publisher attestation for service installation

Native install and upgrade authenticate bundle bytes with a detached Ed25519 publisher
attestation. This is distinct from release-channel promotion: signing an
`internal-preview-*` bundle does not make it supported, and signing a `release-candidate` does not
make it `released`.

Keep the Ed25519 PKCS#8 private key outside the checkout, bundle, runtime home, logs, and Agent
context. After a bundle contains both target-native service hosts and its packaged smoke has
passed, sign it with:

```sh
pnpm release:sign --bundle ABSOLUTE_BUNDLE_PATH \
  --private-key ABSOLUTE_PRIVATE_KEY_PEM \
  --public-key-destination ABSOLUTE_NEW_PUBLIC_KEY_PEM
```

Signing an unsupported lab bundle additionally requires the exact
`--allow-unsupported-preview` acknowledgement. The signer:

- rejects linked or special paths and byte-compares the complete payload and checksum manifests;
- requires the two target-native service executables and matching successful packaged smoke;
- refuses an incomplete `release-candidate`;
- derives the publisher key ID from the Ed25519 public key;
- creates `BUNDLE_PATH.publisher-attestation.json` and the requested public-key file with
  create-new semantics; and
- never copies, prints, or overwrites the private key or an existing output.

Provision the emitted public key through an owner-controlled channel as
`STATE_ROOT/trust/publisher-ed25519.pem`. Configure `bundle.checksum` as
`sha256:<manifestSha256>` from the signer result. Do not accept a public key delivered only inside
the bundle it is expected to authenticate. Windows publisher-key ACL review and any platform code
signing/notarization remain separate operator gates.

## Production gate

The production evidence check is:

```sh
pnpm release:gate
```

It must fail while any of the 36 criteria is incomplete. The production bundle command omits the
preview flag:

```sh
pnpm release:build --destination ABSOLUTE_PATH
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
- signing/notarization and publishing inputs appropriate to the distributed platform bundles.

The safe metadata snapshot and fresh-target recovery contract is documented in
[`BACKUP_AND_RESTORE.md`](../BACKUP_AND_RESTORE.md). Passing its deterministic
checks does not replace the required live reconciliation proof.

Until those proofs are linked in the ledger, the honest outcome is **internal preview built**, not
**OpenDelegate deployed** or **first milestone released**.
