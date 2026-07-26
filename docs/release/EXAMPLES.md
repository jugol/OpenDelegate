# Release input examples

Status: **Operator reference — not release evidence**

OpenDelegate can generate credential-free, canonical skeletons for the external
inputs used by release promotion, remote read-back, configured authority, and
release signing:

```text
pnpm release:examples -- --destination ABSOLUTE_NEW_DIRECTORY
```

The destination must be absolute, its parent must already exist, and the destination
itself must not exist. Generation is create-new and rollback-safe: a validation or
publication failure removes only the newly created example directory and never
overwrites an existing path.

## Safety boundary

Every generated set is prominently marked `PLACEHOLDER` and `NOT-A-RELEASE`. The
command does not generate or copy:

- private keys or signing credentials;
- signatures or attestations;
- candidate archives or candidate payloads;
- notarization, platform, live-lab, or remote read-back evidence; or
- a claim that any channel or artifact is released.

The JSON is schema-valid documentation. It demonstrates exact key order, field
types, first-milestone target order, the 36-criterion evidence shape, and cross-file
bindings. It deliberately uses zeroed SHA-256 values and a zeroed Git commit where a
real immutable input is required. Production release loaders must still verify every
real artifact, signature, identity, revocation set, and external evidence file.

## Generated files

| File | Purpose |
| --- | --- |
| `plans/promotion-plan.json` | Three-target promotion input with support-matrix, notarization, live-evidence, platform-authenticity, and revocation shapes |
| `plans/read-back-plan.json` | Immutable publication and independent three-target remote read-back bindings |
| `plans/configuration-publisher-only-plan.json` | Authority projection for one publisher-verified candidate |
| `plans/configuration-released-plan.json` | Authority projection for a fully promoted and independently observed release |
| `signing/publisher-policy.json` | Publisher signer-broker policy skeleton |
| `signing/promotion-policy.json` | Promotion signer-broker policy skeleton |
| `README.md` | A local replacement checklist and safety warning |

The read-back plan contains the actual SHA-256 of the generated promotion-plan
bytes. Editing the promotion plan therefore requires recomputing and replacing that
binding.

## Required replacement work

Before invoking any credential-bearing release command:

1. Copy the plans into an operator-controlled external input location.
2. Replace every `PLACEHOLDER` identifier, path, provider value, broker endpoint,
   certificate identity, and immutable object identity.
3. Replace every zeroed SHA-256 and the zeroed Git commit with a digest captured from
   the exact immutable input.
4. Provision distinct publisher, promotion, uploader, observer, and broker
   authorities. Keep all private keys and credentials outside plan and policy files.
5. Update the signing policies with the real public release key, broker transport
   public key, local broker endpoint, and their exact pins.
6. Recompute `read-back-plan.json`'s promotion-plan digest after the final promotion
   plan is frozen.
7. Use the pinned production CLIs. Do not treat successful example generation as a
   substitute for `release:gate`, target-native signing, notarization, lab proof,
   promotion, publication, or authenticated remote read-back.

## Validation performed by the generator

Before and after publishing the directory, the generator:

- rejects extra, missing, linked, non-regular, oversized, or non-UTF-8 files;
- requires canonical one-line JSON and exact ordered keys;
- validates the exact macOS arm64, Linux x64, and Windows x64 target order;
- validates all 36 ordered live-evidence references;
- checks promotion, read-back, and configuration cross-file bindings;
- requires distinct pinned input paths and distinct signing authorities;
- requires placeholder pins and paths to remain visibly non-production; and
- rejects private-key material and credential-bearing JSON fields.

These checks protect the example contract itself. They do not weaken or replace the
strict production readers.
