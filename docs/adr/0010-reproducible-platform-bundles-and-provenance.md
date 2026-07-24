# ADR-0010: Reproducible platform bundles and release provenance

Status: **Accepted**

Date: **2026-07-24**

## Context

The owner-facing installation path must work without a development checkout, a
package-manager workspace, or an arbitrary globally installed Node.js version.
OpenDelegate also has native runtime dependencies whose binaries are specific to an
operating system and architecture. A bundle that happens to start on the build
machine is not sufficient release evidence, and an archive must not be described as
supported while the first-milestone ledger is incomplete.

Runtime state, credentials, Artifacts, and Device Knowledge must remain outside both
the source checkout and the immutable release payload. Builds must not overwrite an
existing output because mixing files from two builds makes provenance and rollback
ambiguous.

## Decision

### Target-specific bundle

1. Each release payload is built for exactly one declared operating-system and
   architecture tuple. Native dependencies are installed and verified for that
   tuple; a payload assembled for one tuple is never relabeled for another.
2. Every payload contains the official **Node.js 24.18.0 LTS** runtime. The builder
   downloads the exact target archive from the Node.js distribution endpoint,
   verifies its audited SHA-256 before extraction, retains the archive provenance
   and runtime license, and records the extracted executable hash. OpenDelegate
   launchers invoke that bundled executable and do not fall back to `node` on
   `PATH`.
3. Main's TypeScript entry point is bundled as ESM with esbuild. Packages that load
   native binaries or must resolve files dynamically remain explicit runtime
   externals. Their exact names and versions are recorded in release metadata.
4. Production dependencies are materialized as a portable, hoisted dependency tree
   beside the bundled application. It may not contain links that escape the payload
   to the source checkout, a pnpm content-addressable store, or a build user's home
   directory. Native externals must resolve from this tree under the bundled Node
   runtime.
5. The complete Admin Web production build, Main application, stable CLI launchers,
   init skill, license, notices, and operator-facing release documentation ship in
   the same target payload. Source-only or Admin-only archives are not release
   bundles.

### Reproducibility and output safety

1. The builder receives an absolute destination outside the source checkout. The
   destination must not exist; the builder refuses to merge with or overwrite a
   prior output. An internal-preview destination basename contains
   `internal-preview`.
2. Build inputs are pinned by the lockfile and release tool versions. Archive entry
   order, normalized paths, generated metadata shape, and checksum-manifest order
   use locale-independent ordering and are deterministic. Target-specific native
   binaries are expected to differ across target tuples.
3. The payload contains a machine-readable manifest with at least:
   - product and protocol versions;
   - target OS and architecture;
   - exact Node.js, package-manager, bundler, and runtime-external versions;
   - distinct audited-source commit A and bundle-build commit B identities, whether
     the B checkout was clean, and the complete restricted attestation-path diff;
   - build invocation mode and timestamp policy;
   - release-ledger digest and status;
   - every packaged file's relative path, size, and SHA-256 digest except unavoidable
     manifest/checksum self-references, with those exclusions recorded explicitly;
     and
   - the overall payload or archive SHA-256 digest when an archive is produced.
4. The checksum manifest covers the packaged bytes, including the bundled runtime,
   Main, Admin Web, native externals, skills, and notices. It proves payload
   self-consistency after acquisition; because it travels with the payload, it does
   not authenticate the publisher. Supported publication requires a digest,
   signature, or attestation delivered through a separately trusted channel.
5. The third-party inventory records every deployed runtime package instance and
   every production dependency compiled into Admin Web, together with retained
   license/notice file paths and hashes. Admin dependency terms, including bundled
   font terms, are copied into the payload under `licenses/admin-web/`. When a
   platform subpackage reuses a same-project license, or an upstream package omits a
   standalone file, the inventory records the exact retained source rather than
   silently omitting it.

### Audited source and attestation commit

1. A criterion proof is about audited source commit **A**. After the implementation
   and live lab runs complete, a distinct commit **B** may add their immutable
   attestations and update the acceptance ledger. A production candidate is built
   only from a clean checkout of B; requiring B to equal A would make it impossible
   to commit evidence that attests A without circular provenance.
2. The ledger's `sourceCommit` is the exact lowercase 40-character SHA for A. The
   builder proves that A exists as a commit and is an ancestor of B. Provenance Git
   reads set `GIT_NO_REPLACE_OBJECTS=1`; a local replacement ref cannot substitute
   another tree while the metadata records A or B's original object name.
3. The tree diff from A to B may contain only:
   - a mode-`100644` modification to
     `docs/release/acceptance-evidence.json`; and
   - added or modified mode-`100644` files below
     `docs/release/evidence/` whose current SHA-256 is explicitly referenced by a
     criterion's `verification.implementation`, `verification.liveProof`, or the
     top-level `candidateAttestation`.
4. A criterion's generic `evidence` list does not authorize an A-to-B tree change.
   Unreferenced files, source or configuration changes, other documentation or
   schema changes, deletions, renames, copies, type changes, executable-bit changes,
   symlinks, and submodules fail the candidate build.
5. The builder verifies the clean B identity and the restricted A-to-B diff both
   before and after assembly. Release metadata records `buildCommit`,
   `auditedSourceCommit`, and `changedAttestationPaths`; unsupported previews
   mark this candidate-only diff as unverified.
6. Candidate assembly does not consume first-party files from the live checkout.
   With replacement objects disabled, the builder exports commit B through
   `git archive`, performs a frozen dependency install in that external snapshot,
   and builds and copies every source, Admin, documentation, skill, and legal input
   from the snapshot. Untracked and ignored files, including environment inputs,
   therefore cannot enter or alter the candidate. The live clean-B check still
   explicitly includes all untracked files regardless of local Git status
   configuration as defense in depth.

### Packaged smoke and support status

1. A bundle build is successful only after the bundled Node runtime can execute the
   packaged CLI and the packaged Main can:
   - start from a fresh runtime home outside the payload;
   - initialize its local database;
   - serve the packaged Admin Web;
   - issue and complete the initial owner claim only through the loopback bootstrap
     channel; and
   - stop cleanly without writing runtime state into the payload.
2. The smoke uses the packaged files, bundled runtime, and portable dependency tree.
   Running source through a workspace loader is not equivalent evidence.
3. When the canonical release ledger is incomplete, the builder may produce only an
   **unsupported preview**. The payload, filename, manifest, console output, and
   included release status must all say that it is unsupported and identify the
   blocking ledger entries. A preview is never eligible for a supported tag,
   installer channel, or support claim.
4. A supported release candidate requires the complete release gate, the clean
   attestation commit B and restricted diff from its audited source commit A,
   successful target bundle smoke, and the cross-platform evidence required by the
   implementation plan. No platform or Computer Use criterion may be waived.
5. Signing, notarization, code-signing identities, public upload, release-channel
   promotion, and Git tag publication are separate gated operations. A valid
   checksum or locally successful bundle does not authorize any of them. Bundle
   assembly stops at `release-candidate`; only a separate immutable promotion
   attestation and supported publication channel may label those exact bytes
   `released`.
6. The packaged CLI derives its version, build identity, and runtime channel only
   from bundled release metadata. It verifies the enclosed
   `SHA256SUMS` → `payload-manifest.json` → `release-metadata.json` → acceptance-ledger
   chain and fails closed when schemas, hashes, completeness, or status semantics
   disagree. This is an internal-consistency check, not publisher authentication.
7. Caller environment variables cannot elevate or replace packaged identity.
   Source-checkout execution is always `development`. Until a separate trusted
   promotion-attestation verifier exists, packaged execution rejects `released`
   rather than inferring it from a name, environment variable, or ledger field.
8. Bundle payloads contain only regular files and directories. Symbolic links,
   Windows junctions, and special files are rejected because the current payload
   and checksum manifests enumerate regular file bytes only.

## Alternatives considered

### Require a global Node.js installation

Rejected because host upgrades could change the runtime independently of the tested
payload and make rollback incomplete.

### Ship raw TypeScript and the pnpm workspace

Rejected because Node's source-loading behavior and workspace links do not form a
portable owner installation, especially for dependencies below `node_modules`.

### Produce one nominally cross-platform archive

Rejected because native dependencies and the Node runtime are target-specific. A
single archive would either contain unused binaries or conceal which tuple was
actually tested.

### Allow an incomplete ledger to produce a normal release candidate

Rejected because packaging success is not product acceptance. The first milestone
requires live macOS, Windows, Linux, Discord, provider, and Computer Use proof.

### Build inside the checkout and replace an existing destination

Rejected because it risks committing generated payloads, mixing stale files into a
new bundle, and coupling runtime state to source paths.

## Consequences

- Release CI must run target builds on each supported OS/architecture combination or
  an equivalently proven target-native builder.
- A Node.js security update or a native dependency update requires a deliberate
  bundle-version change and a new smoke/evidence cycle.
- The portable dependency tree is larger than relying on a global package store, but
  it makes resolution, rollback, and provenance inspectable.
- Unsupported previews support integration and external lab work without weakening
  the milestone definition.
- Signing and publication automation can be added later without changing the bundle
  contract or conflating signed bytes with supported behavior.

## Verification

- Builder tests reject relative, in-checkout, non-empty, and existing mixed
  destinations.
- The same source and pinned inputs produce the same normalized manifest and file
  digests for one target tuple, excluding only explicit self-references and recorded
  nondeterministic signing material.
- Dependency scans prove no packaged link resolves outside the payload and every
  runtime external loads under the bundled Node executable.
- Runtime metadata binds the exact official archive, its audited SHA-256, and the
  extracted executable and retained license hashes.
- Legal-inventory validation fails when a deployed runtime or compiled Admin
  production dependency has neither retained terms nor an explicit same-project or
  curated versioned license source. Tests also prove that Admin development-only
  dependencies do not enter the inventory.
- The full packaged Main, Admin Web, database initialization, loopback-only owner
  claim, authenticated login, and clean shutdown smoke passes from a fresh external
  runtime home.
- Release-gate tests prove an incomplete ledger can create only a prominently marked
  unsupported preview and cannot enter signing or publication.
- Provenance tests prove a clean descendant attestation commit may change only the
  ledger and SHA-bound regular evidence files, and reject generic evidence,
  unreferenced files, source/documentation/schema changes, destructive Git statuses,
  special modes, symlinks, and submodules.
- A real Git fixture proves replacement refs do not alter ancestry, diff, or archive
  inspection; an ignored environment file and a non-ignored untracked source file
  are absent from the committed snapshot; and local `status.showUntrackedFiles=no`
  cannot make the source identity clean. Non-ASCII attestation paths prove metadata
  ordering does not depend on the host locale.

## References

- `docs/PRODUCT_SPEC.md`, FR-1, Main deployment, and First Milestone Acceptance
  Criteria 1, 6, 32, and 36
- `docs/IMPLEMENTATION_PLAN.md`, Spike B, Phase 4, and Phase 13
- [`ADR-0002`](0002-development-runtime-and-monorepo.md)
- [Node.js 24.18.0 LTS release](https://nodejs.org/en/blog/release/v24.18.0)
- [esbuild: Getting Started](https://esbuild.github.io/getting-started/)
