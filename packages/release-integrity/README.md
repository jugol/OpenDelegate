# `@opendelegate/release-integrity`

Deterministic verification primitives for OpenDelegate release candidates and the
external promotion chain defined by
[ADR-0021](../../docs/adr/0021-supported-release-promotion-and-native-authenticity.md).

This package validates immutable bytes and computes release status. It does not sign,
notarize, publish, choose trust roots, mutate a candidate, or accept an enclosed
channel, filename, Git tag, or environment variable as proof that a release is
supported. Callers must supply trust roots and external evidence independently of
the candidate.

## Verification APIs

- `inspectCandidate(input)` validates the candidate directory, exact manifest-bound
  file set, release metadata, acceptance ledger, smoke evidence, and native
  authenticity records. It returns an immutable `CandidateDescription` whose
  declared channel is always `release-candidate`.
- `verifyRelease(input)` verifies an inspected candidate plus its detached archive,
  publisher attestation, externally supplied publisher key, and revocation policy.
  Publisher verification alone remains `release-candidate`. A complete and valid
  promotion attestation, evidence set, distinct promotion trust root, and
  supported-channel receipt produce `released`.
- `resolveConfiguredRelease(input)` is the installer/runtime entry point. It always
  inspects the candidate first, then resolves external authority from the configured
  state root. Candidate corruption throws a `ReleaseIntegrityError` with a
  `CANDIDATE_*` code. Missing, malformed, untrusted, revoked, or incomplete external
  authority is returned as structured status and never upgrades the effective
  channel.

The package also exports typed composition helpers for canonical publisher,
promotion, receipt, and signed-envelope statements. These helpers construct bytes
to sign; they do not hold credentials or perform signing.

## Configured authority

`externalReleaseVerificationPath()` derives the only accepted configuration
location:

```text
<stateRoot>/trust/releases/<productVersion>/<platform>-<architecture>/<checksumManifestSha256>/release-verification.json
```

`stateRoot` must be absolute. The configuration is strict canonical JSON and binds
the candidate manifest and immutable candidate-description digests. Every referenced
archive, attestation, key, support-matrix record, notarization receipt, and live
evidence file is a bounded regular file beneath `<stateRoot>/trust`. Trust storage
must not overlap the candidate; linked, escaping, aliased, case-colliding, duplicate,
or changing paths fail closed. Files are pinned to the bytes read for one
verification.

Publisher and promotion keys are distinct Ed25519 trust authorities. Policy can
revoke publisher keys, promotion keys, platform certificate identities, promotion
statements, and release receipts.

## Resolution results

The enclosed `declaredChannel` is always `release-candidate`. Only one external
status changes the computed `effectiveChannel`:

| `external.status` | `effectiveChannel` | Meaning |
| --- | --- | --- |
| `absent` | `release-candidate` | No digest-addressed configuration exists. |
| `invalid` | `release-candidate` | Configuration, publisher authority, or required external input is invalid. |
| `publisher-verified` | `release-candidate` | The target candidate is authenticated, but not promoted. |
| `promotion-invalid` | `release-candidate` | Publisher authentication passed, but the promotion chain did not. |
| `revoked` | `release-candidate` | An applicable trusted identity or statement is revoked. |
| `released` | `released` | The complete external publisher, promotion, evidence, and publication-receipt chain passed. |

Promotion is defined only for the exact first-milestone target set:
`darwin-arm64`, `linux-x64`, and `win32-x64`.

## Tests and release evidence

Run the package checks with:

```sh
pnpm --filter @opendelegate/release-integrity typecheck
pnpm --filter @opendelegate/release-integrity test
```

`test/support/release-fixture.ts` creates synthetic trust material and evidence for
tests. It is not exported and must not be used by production release tooling.
Passing these tests proves verifier mechanics only. This documentation makes no
claim that real platform identities, notarization, owner-device evidence, live
provider or Discord proof, or supported-channel publication read-back currently
exists.
