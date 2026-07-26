import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as createSignature,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  ReleaseIntegrityError,
  composePromotionStatement,
  composePublisherAttestationStatement,
  composeRemoteReadBackObservationStatement,
  composeSignedReleaseEnvelope,
  composeSupportedChannelReceiptStatement,
  externalReleaseVerificationPath,
  inspectCandidate,
  nodeReleaseFileReader,
  resolveConfiguredRelease,
  verifyRemoteReadBackObservation,
  verifyRelease,
  type CandidateDescription,
  type ReleaseFileReader,
  type VerifiedRelease,
} from "../src/index.ts";
import { createStableNodeFileRead } from "../src/stable-node-file-read.ts";
import { createReleasedConfiguredReleaseTestFixture } from "./support/release-fixture.ts";

const missingReader: ReleaseFileReader = {
  async inspect() {
    throw new Error("missing");
  },
  async inspectIfPresent() {
    throw new Error("missing");
  },
  async list() {
    throw new Error("missing");
  },
  async read() {
    throw new Error("missing");
  },
  async realPath() {
    throw new Error("missing");
  },
};

test("stable Node reads reject pathname swaps after opening a regular-file descriptor", async () => {
  let pathnameInspectionCount = 0;
  let closeCount = 0;
  let descriptorInspectionCount = 0;
  let readCount = 0;
  const windowsInode = 14_355_223_818_081_260n;
  const pathnameIdentity = fakeFileIdentity({
    dev: 0n,
    ino: windowsInode,
    size: 5n,
  });
  const descriptorIdentity = fakeFileIdentity({
    dev: 7n,
    ino: windowsInode,
    size: 5n,
  });
  const swappedIdentity = fakeFileIdentity({
    dev: 0n,
    ino: windowsInode + 1n,
    size: 5n,
  });
  const read = createStableNodeFileRead({
    noFollowFlag: 0,
    platform: "win32",
    async lstat() {
      pathnameInspectionCount += 1;
      return pathnameInspectionCount === 1 ? pathnameIdentity : swappedIdentity;
    },
    async open() {
      return {
        async close() {
          closeCount += 1;
        },
        async read(buffer, offset, length, position) {
          readCount += 1;
          const source = Buffer.from("safe\n", "utf8");
          const bytesRead = source.copy(
            buffer,
            offset,
            position,
            Math.min(source.byteLength, position + length),
          );
          return { bytesRead };
        },
        async stat() {
          descriptorInspectionCount += 1;
          return descriptorIdentity;
        },
      };
    },
    async realpath() {
      return "C:\\candidate\\artifact.json";
    },
  });

  await assert.rejects(read("C:\\candidate\\artifact.json", 5), /unsafe stable file/u);
  assert.equal(closeCount, 1);
  assert.equal(pathnameInspectionCount, 2);
  assert.equal(descriptorInspectionCount, 2);
  assert.equal(readCount, 2);
});

test("stable Node reads require O_NOFOLLOW and keep descriptor identity stable on POSIX", async () => {
  const identity = fakeFileIdentity({ ino: 51n, size: 5n });
  let openedFlags = 0;
  let descriptorStatCount = 0;
  const read = createStableNodeFileRead({
    noFollowFlag: 0x20_000,
    platform: "linux",
    async lstat() {
      return identity;
    },
    async open(_path, flags) {
      openedFlags = flags;
      return {
        async close() {},
        async read(buffer, offset, length, position) {
          const source = Buffer.from("safe\n", "utf8");
          const bytesRead = source.copy(
            buffer,
            offset,
            position,
            Math.min(source.byteLength, position + length),
          );
          return { bytesRead };
        },
        async stat() {
          descriptorStatCount += 1;
          return identity;
        },
      };
    },
    async realpath() {
      return "/candidate/artifact.json";
    },
  });

  assert.equal(Buffer.from(await read("/candidate/artifact.json", 5)).toString(), "safe\n");
  assert.notEqual(openedFlags & 0x20_000, 0);
  assert.equal(descriptorStatCount, 2);
});

test("inspectCandidate fails closed with a typed, sanitized error when the candidate is unreadable", async () => {
  await assert.rejects(
    inspectCandidate({
      root: "/candidate",
      expectedTarget: { platform: "linux", architecture: "x64" },
      reader: missingReader,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseIntegrityError);
      assert.equal(error.code, "CANDIDATE_IO_INVALID");
      assert.equal(error.message, "The release candidate root is unreadable or unsafe.");
      assert.equal(error.message.includes("/candidate"), false);
      return true;
    },
  );
});

test("inspectCandidate revalidates one immutable release candidate through the public seam", async () => {
  const fixture = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  try {
    const result = await inspectCandidate({
      root: fixture.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      expectedManifestSha256: fixture.checksumManifestSha256,
    });

    assert.deepEqual(result.target, { platform: "linux", architecture: "x64" });
    assert.equal(result.productVersion, "0.1.0-alpha.1");
    assert.equal(result.buildId, "release-candidate-bbbbbbbbbbbb");
    assert.equal(result.auditedSourceCommit, "a".repeat(40));
    assert.equal(result.buildCommit, "b".repeat(40));
    assert.equal(result.declaredChannel, "release-candidate");
    assert.equal(result.acceptanceLedgerSha256, fixture.acceptanceLedgerSha256);
    assert.equal(result.candidateAttestationId, "release:candidate:test-0001");
    assert.equal(result.checksumManifestSha256, fixture.checksumManifestSha256);
    assert.equal(result.payloadManifestSha256, fixture.payloadManifestSha256);
    assert.equal(result.releaseMetadataSha256, fixture.releaseMetadataSha256);
    assert.equal(result.nativeComponentsSha256, fixture.nativeComponentsSha256);
    assert.equal(result.platformAuthenticitySha256, fixture.platformAuthenticitySha256);
    assert.deepEqual(result.platformCertificateIdentities, []);
    assert.equal(result.publisherStatement.domain, "opendelegate.release.publisher-candidate.v2");
    assert.equal(
      result.publisherStatement.sha256,
      sha256(result.publisherStatement.canonicalBytes),
    );
    assert.match(
      Buffer.from(result.publisherStatement.canonicalBytes).toString("utf8"),
      /"acceptanceLedgerSha256": "[a-f0-9]{64}"/u,
    );
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.target));
    assert.ok(Object.isFrozen(result.platformCertificateIdentities));
    assert.ok(Object.isFrozen(result.publisherStatement));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inspectCandidate rejects metadata that points at a different acceptance ledger", async () => {
  const fixture = await createCandidateFixture(
    { platform: "linux", architecture: "x64" },
    { corruptMetadataLedgerBinding: true },
  );
  try {
    await assert.rejects(
      inspectCandidate({
        root: fixture.root,
        expectedTarget: { platform: "linux", architecture: "x64" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReleaseIntegrityError);
        assert.equal(error.code, "CANDIDATE_INTEGRITY_INVALID");
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inspectCandidate rejects preview identity and any post-manifest payload mutation", async () => {
  const preview = await createCandidateFixture(
    { platform: "linux", architecture: "x64" },
    { supportStatus: "internal-preview-complete" },
  );
  const mutated = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  try {
    await assert.rejects(
      inspectCandidate({
        root: preview.root,
        expectedTarget: { platform: "linux", architecture: "x64" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReleaseIntegrityError);
        assert.equal(error.code, "CANDIDATE_SCHEMA_INVALID");
        return true;
      },
    );
    await writeFile(
      join(mutated.root, "bin", "opendelegate-service-host"),
      "post-manifest mutation\n",
      "utf8",
    );
    await assert.rejects(
      inspectCandidate({
        root: mutated.root,
        expectedTarget: { platform: "linux", architecture: "x64" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReleaseIntegrityError);
        assert.equal(error.code, "CANDIDATE_INTEGRITY_INVALID");
        return true;
      },
    );
  } finally {
    await Promise.all([
      rm(preview.root, { recursive: true, force: true }),
      rm(mutated.root, { recursive: true, force: true }),
    ]);
  }
});

test("inspectCandidate rejects non-canonical JSON even when manifests bind those bytes", async () => {
  const fixture = await createCandidateFixture(
    { platform: "linux", architecture: "x64" },
    { nonCanonicalMetadata: true },
  );
  try {
    await assert.rejects(
      inspectCandidate({
        root: fixture.root,
        expectedTarget: { platform: "linux", architecture: "x64" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ReleaseIntegrityError);
        assert.equal(error.code, "CANDIDATE_SCHEMA_INVALID");
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("inspectCandidate rejects incomplete, extra, altered, or disguised third-party native inventory", async () => {
  const invalidCases: readonly CandidateFixtureOptions[] = [
    { omitThirdPartyComponent: true },
    { addThirdPartyComponent: true },
    { corruptThirdPartyDigest: true },
    { corruptThirdPartyVerification: true },
    { omitRuntimePayload: true },
    { addUndeclaredNativePayload: true },
    { addUnknownNativeSuffixPayload: true },
  ];
  for (const options of invalidCases) {
    const fixture = await createCandidateFixture(
      { platform: "linux", architecture: "x64" },
      options,
    );
    try {
      await assert.rejects(
        inspectCandidate({
          root: fixture.root,
          expectedTarget: { platform: "linux", architecture: "x64" },
        }),
        (error: unknown) =>
          error instanceof ReleaseIntegrityError && error.code === "CANDIDATE_INTEGRITY_INVALID",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("inspectCandidate binds distinct product and upstream runtime certificate identities", async () => {
  const targets = [
    {
      target: { platform: "darwin", architecture: "arm64" } as const,
      identities: ["apple-team:OPENDELEG1", "apple-team:HX7739G8FX"],
      productIdentity: "apple-team:OPENDELEG1",
    },
    {
      target: { platform: "win32", architecture: "x64" } as const,
      identities: [`authenticode-sha1:${"E".repeat(40)}`, `authenticode-sha1:${"A".repeat(40)}`],
      productIdentity: `authenticode-sha1:${"E".repeat(40)}`,
    },
  ];
  for (const { target, identities, productIdentity } of targets) {
    const valid = await createCandidateFixture(target);
    const collision = await createCandidateFixture(target, { collideRuntimeIdentity: true });
    const changedRuntime = await createCandidateFixture(target, {
      corruptRuntimeInputDigest: true,
    });
    try {
      const inspected = await inspectCandidate({ root: valid.root, expectedTarget: target });
      assert.deepEqual(inspected.platformCertificateIdentities, identities);
      assert.equal(inspected.platformProductCertificateIdentity, productIdentity);
      for (const invalid of [collision, changedRuntime]) {
        await assert.rejects(
          inspectCandidate({ root: invalid.root, expectedTarget: target }),
          (error: unknown) =>
            error instanceof ReleaseIntegrityError && error.code === "CANDIDATE_INTEGRITY_INVALID",
        );
      }
    } finally {
      await Promise.all(
        [valid, collision, changedRuntime].map((fixture) =>
          rm(fixture.root, { recursive: true, force: true }),
        ),
      );
    }
  }
});

test("verifyRelease authenticates a final archive but publisher authority cannot promote it", async () => {
  const fixture = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  const candidate = await inspectCandidate({
    root: fixture.root,
    expectedTarget: { platform: "linux", architecture: "x64" },
  });
  const publisher = await createPublisherFixture(candidate, fixture.root);
  try {
    const result = await verifyRelease({
      root: fixture.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      expectedCandidateDigest: candidate.publisherStatement.sha256,
      candidatePublisherEvidence: {
        archivePath: publisher.archivePath,
        attestationPath: publisher.attestationPath,
      },
      publisherTrust: {
        publicKeyPem: publisher.publicKeyPem,
      },
    });

    assert.equal(result.effectiveChannel, "release-candidate");
    assert.equal(result.publisherKeyId, publisher.keyId);
    assert.equal(result.publisherAttestationSha256, publisher.attestationSha256);
    assert.deepEqual(result.archive, {
      path: basename(publisher.archivePath),
      size: publisher.archiveBytes.byteLength,
      sha256: sha256(publisher.archiveBytes),
    });
    assert.equal(result.candidate.publisherStatement.sha256, candidate.publisherStatement.sha256);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.archive));
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(publisher.archivePath, { force: true }),
      rm(publisher.attestationPath, { force: true }),
    ]);
  }
});

test("verifyRelease rejects a non-canonical publisher sidecar and an unrelated publisher key", async () => {
  const fixture = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  const candidate = await inspectCandidate({
    root: fixture.root,
    expectedTarget: { platform: "linux", architecture: "x64" },
  });
  const publisher = await createPublisherFixture(candidate, fixture.root);
  const canonicalAttestation = await readFile(publisher.attestationPath);
  const verificationInput = {
    root: fixture.root,
    expectedTarget: { platform: "linux", architecture: "x64" } as const,
    candidatePublisherEvidence: {
      archivePath: publisher.archivePath,
      attestationPath: publisher.attestationPath,
    },
    publisherTrust: { publicKeyPem: publisher.publicKeyPem },
  };
  try {
    await writeFile(
      publisher.attestationPath,
      JSON.stringify(JSON.parse(canonicalAttestation.toString("utf8"))),
      "utf8",
    );
    await assert.rejects(
      verifyRelease(verificationInput),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PUBLISHER_TRUST_INVALID",
    );

    await writeFile(publisher.attestationPath, canonicalAttestation);
    const unrelated = generateKeyPairSync("ed25519");
    const unrelatedPublicKey = unrelated.publicKey.export({
      format: "pem",
      type: "spki",
    });
    await assert.rejects(
      verifyRelease({
        ...verificationInput,
        publisherTrust: { publicKeyPem: Buffer.from(unrelatedPublicKey) },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PUBLISHER_TRUST_INVALID",
    );
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(publisher.archivePath, { force: true }),
      rm(publisher.attestationPath, { force: true }),
    ]);
  }
});

test("composePublisherAttestationStatement is the immutable signer/verifier contract", async () => {
  const fixture = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  try {
    const candidate = await inspectCandidate({
      root: fixture.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
    });
    const archive = {
      path: "opendelegate-v0.1.0-alpha.1-linux-x64.tar.gz",
      size: 123_456,
      sha256: "9".repeat(64),
    };
    const composed = composePublisherAttestationStatement({ candidate, archive });

    assert.equal(composed.domain, "opendelegate.release.publisher-attestation.v2");
    assert.deepEqual(composed.statement.archive, archive);
    assert.deepEqual(composed.statement.candidate, candidateBinding(candidate));
    assert.equal(
      Buffer.from(composed.canonicalBytes).toString("utf8"),
      `${JSON.stringify(composed.statement, null, 2)}\n`,
    );
    assert.equal(
      Buffer.from(composed.signingBytes).toString("utf8"),
      `OpenDelegate publisher attestation v2\n${JSON.stringify(composed.statement, null, 2)}\n`,
    );
    assert.equal(composed.sha256, sha256(composed.canonicalBytes));
    assert.ok(Object.isFrozen(composed));
    assert.ok(Object.isFrozen(composed.statement));
    assert.ok(Object.isFrozen(composed.statement.archive));
    assert.ok(Object.isFrozen(composed.statement.candidate));
    assert.ok(Object.isFrozen(composed.statement.candidate.target));

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = `sha256:${sha256(publicKey.export({ format: "der", type: "spki" }))}`;
    const signature = createSignature(null, composed.signingBytes, privateKey).toString(
      "base64url",
    );
    const envelope = composeSignedReleaseEnvelope({
      composed,
      keyId,
      signature,
    });
    assert.deepEqual(envelope.envelope, {
      schemaVersion: 2,
      product: "OpenDelegate",
      role: "publisher",
      algorithm: "ed25519",
      keyId,
      statement: composed.statement,
      signature,
    });
    assert.equal(
      Buffer.from(envelope.canonicalBytes).toString("utf8"),
      `${JSON.stringify(envelope.envelope, null, 2)}\n`,
    );
    assert.equal(envelope.sha256, sha256(envelope.canonicalBytes));
    assert.ok(Object.isFrozen(envelope));
    assert.ok(Object.isFrozen(envelope.envelope));
    assert.throws(
      () =>
        composeSignedReleaseEnvelope({
          composed: { ...composed },
          keyId,
          signature,
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "SIGNED_ENVELOPE_INVALID",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("composePromotionStatement binds one exact, complete three-target candidate set", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  try {
    const mac = releaseSet.releases.find(
      (release) => release.candidate.target.platform === "darwin",
    )!;
    const notarizationBytes = canonicalJson({
      schemaVersion: 1,
      product: "OpenDelegate",
      type: "macos-notarization",
      target: { platform: "darwin", architecture: "arm64" },
      archive: mac.archive,
      status: "accepted",
      submissionId: "0f7b7a50-584d-43fc-b746-0a1419b64630",
      teamId: "OPENDELEG1",
      resultId: "apple-notary-result-0001",
      logId: "apple-notary-log-0001",
      observedAt: "2026-07-26T01:00:00.000Z",
    });
    const supportMatrix = {
      path: "docs/release/SUPPORT_MATRIX.md",
      bytes: Buffer.from("# Immutable support matrix\n", "utf8"),
    };
    const liveEvidence = Array.from({ length: 36 }, (_, index) => ({
      criterionId: index + 1,
      path: `docs/release/evidence/live-${String(index + 1).padStart(2, "0")}.json`,
      bytes: Buffer.from(`{"criterion":${String(index + 1)},"status":"verified"}\n`, "utf8"),
    }));
    const platformAuthenticityEvidence = releaseSet.releases.map((release) => {
      const platform = release.candidate.target.platform;
      return {
        target: release.candidate.target,
        recordSha256: release.candidate.platformAuthenticitySha256,
        certificateIdentities: release.candidate.platformCertificateIdentities,
        productCertificateIdentity: release.candidate.platformProductCertificateIdentity,
        verificationEvidence: [
          {
            path: `docs/release/evidence/${platform}-native-authenticity.json`,
            bytes: Buffer.from(`{"platform":"${platform}","verified":true}\n`, "utf8"),
          },
        ],
      };
    });
    const composed = composePromotionStatement({
      verifiedCandidates: releaseSet.releases,
      platformAuthenticityEvidence,
      notarizationReceipt: {
        path: "docs/release/evidence/macos-notarization.json",
        bytes: notarizationBytes,
      },
      supportMatrix,
      liveEvidence,
      releaseId: "opendelegate-v0.1.0-alpha.1",
      channel: "stable",
      issuedAt: "2026-07-26T02:00:00.000Z",
      statementId: "promotion:opendelegate-v0.1.0-alpha.1:0001",
    });

    const text = Buffer.from(composed.canonicalBytes).toString("utf8");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text, `${JSON.stringify(composed.statement, null, 2)}\n`);
    assert.equal(
      Buffer.from(composed.signingBytes).toString("utf8"),
      `OpenDelegate promotion authorization v1\n${JSON.stringify(composed.statement, null, 2)}\n`,
    );
    assert.equal(composed.sha256, sha256(composed.canonicalBytes));
    assert.equal(composed.domain, "opendelegate.release.promotion-authorization.v1");
    assert.equal(composed.statementId, "promotion:opendelegate-v0.1.0-alpha.1:0001");
    const statement = JSON.parse(text) as {
      readonly acceptanceLedger: { readonly sha256: string };
      readonly targets: readonly {
        readonly target: { readonly platform: string; readonly architecture: string };
      }[];
    };
    assert.deepEqual(
      statement.targets.map(({ target }) => `${target.platform}-${target.architecture}`),
      ["darwin-arm64", "linux-x64", "win32-x64"],
    );
    assert.equal(
      statement.acceptanceLedger.sha256,
      releaseSet.releases[0]!.candidate.acceptanceLedgerSha256,
    );
    assert.ok(Object.isFrozen(composed));
    assert.ok(Object.isFrozen(composed.statement));
    assert.ok(Object.isFrozen(composed.statement.targets));
    assert.ok(Object.isFrozen(composed.statement.targets[0]));
    assert.ok(Object.isFrozen(composed.statement.targets[0]!.archive));
    assert.ok(Object.isFrozen(composed.statement.targets[0]!.candidate));
    assert.ok(Object.isFrozen(composed.statement.targets[0]!.platformAuthenticity));
  } finally {
    await releaseSet.cleanup();
  }
});

test("composeSupportedChannelReceiptStatement binds canonical remote read-back proof", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  try {
    const promotion = composePromotionStatement(promotionCompositionInput(releaseSet));
    const promotionAttestationSha256 = "7".repeat(64);
    const observations = createVerifiedReadBackObservations(releaseSet);
    const composed = composeSupportedChannelReceiptStatement({
      promotion,
      promotionAttestationSha256,
      verifiedObservations: [...observations.verified].reverse(),
      receiptId: "receipt:opendelegate-v0.1.0-alpha.1:0001",
      observedAt: "2026-07-26T03:00:00.000Z",
    });

    assert.equal(composed.domain, "opendelegate.release.supported-channel-receipt.v2");
    assert.equal(composed.receiptId, "receipt:opendelegate-v0.1.0-alpha.1:0001");
    assert.equal(
      Buffer.from(composed.canonicalBytes).toString("utf8"),
      `${JSON.stringify(composed.statement, null, 2)}\n`,
    );
    assert.equal(
      Buffer.from(composed.signingBytes).toString("utf8"),
      `OpenDelegate supported channel receipt v2\n${JSON.stringify(composed.statement, null, 2)}\n`,
    );
    assert.equal(composed.sha256, sha256(composed.canonicalBytes));
    assert.deepEqual(
      composed.statement.publishedAssets.map(({ target }) => target),
      [
        { platform: "darwin", architecture: "arm64" },
        { platform: "linux", architecture: "x64" },
        { platform: "win32", architecture: "x64" },
      ],
    );
    assert.ok(Object.isFrozen(composed));
    assert.ok(Object.isFrozen(composed.statement));
    assert.ok(Object.isFrozen(composed.statement.publishedAssets));
    assert.ok(Object.isFrozen(composed.statement.publishedAssets[0]));
    assert.ok(Object.isFrozen(composed.statement.publishedAssets[0]!.target));

    assert.throws(
      () =>
        composeSupportedChannelReceiptStatement({
          promotion,
          promotionAttestationSha256,
          verifiedObservations: [...observations.verified.slice(0, 2), observations.verified[0]!],
          receiptId: "receipt:opendelegate-v0.1.0-alpha.1:0002",
          observedAt: "2026-07-26T03:00:00.000Z",
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
  } finally {
    await releaseSet.cleanup();
  }
});

test("verifyRemoteReadBackObservation authenticates one canonical independent observation", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  try {
    const release = releaseSet.releases[0]!;
    const observer = generateKeyPairSync("ed25519");
    const uploader = generateKeyPairSync("ed25519");
    const observerAuthorityKeyId = `sha256:${sha256(
      observer.publicKey.export({ format: "der", type: "spki" }),
    )}`;
    const uploaderAuthorityKeyId = `sha256:${sha256(
      uploader.publicKey.export({ format: "der", type: "spki" }),
    )}`;
    const composed = composeRemoteReadBackObservationStatement({
      archive: release.archive,
      channel: "stable",
      immutableObjectId: "fixture/releases/release:opendelegate-v0.1.0-alpha.1/archive",
      immutableObjectVersion: "fixture-version-0001",
      observedAt: "2026-07-26T03:00:00.000Z",
      observedStreamSha256: release.archive.sha256,
      observerAuthorityKeyId,
      provider: "fixture-channel",
      releaseId: "release:opendelegate-v0.1.0-alpha.1",
      tag: "v0.1.0-alpha.1",
      target: release.candidate.target,
      uploaderAuthorityKeyId,
    });
    const signature = createSignature(null, composed.signingBytes, observer.privateKey).toString(
      "base64url",
    );
    const envelope = composeSignedReleaseEnvelope({
      composed,
      keyId: observerAuthorityKeyId,
      signature,
    });

    const verified = verifyRemoteReadBackObservation({
      envelopeBytes: envelope.canonicalBytes,
      expectedUploaderAuthorityKeyId: uploaderAuthorityKeyId,
      observerTrust: {
        publicKeyPem: Buffer.from(observer.publicKey.export({ format: "pem", type: "spki" })),
      },
    });

    assert.equal(verified.observerAuthorityKeyId, observerAuthorityKeyId);
    assert.equal(verified.uploaderAuthorityKeyId, uploaderAuthorityKeyId);
    assert.equal(verified.observationEnvelopeSha256, envelope.sha256);
    assert.equal(verified.observationSignature, signature);
    assert.equal(verified.source.immutableObjectVersion, "fixture-version-0001");
    assert.ok(Object.isFrozen(verified));
    assert.ok(Object.isFrozen(verified.source));
  } finally {
    await releaseSet.cleanup();
  }
});

test("composeSupportedChannelReceiptStatement rejects caller-forged observation objects", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  try {
    const promotion = composePromotionStatement(promotionCompositionInput(releaseSet));
    const observations = createVerifiedReadBackObservations(releaseSet);
    assert.throws(
      () =>
        composeSupportedChannelReceiptStatement({
          promotion,
          promotionAttestationSha256: "7".repeat(64),
          verifiedObservations: observations.verified.map((observation) => ({
            ...observation,
          })),
          receiptId: "receipt:opendelegate-v0.1.0-alpha.1:forged",
          observedAt: "2026-07-26T03:00:00.000Z",
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
  } finally {
    await releaseSet.cleanup();
  }
});

test("verifyRemoteReadBackObservation rejects unsigned, incomplete, mutated, and same-authority evidence", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  try {
    const observations = createVerifiedReadBackObservations(releaseSet);
    const envelope = observations.envelopes[0]!;
    const trust = {
      publicKeyPem: Buffer.from(
        observations.observer.publicKey.export({ format: "pem", type: "spki" }),
      ),
    };
    const verify = (envelopeBytes: Uint8Array, uploader = observations.uploaderAuthorityKeyId) =>
      verifyRemoteReadBackObservation({
        envelopeBytes,
        expectedUploaderAuthorityKeyId: uploader,
        observerTrust: trust,
      });
    assert.throws(
      () => verify(canonicalJson(envelope.envelope.statement)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );

    const incomplete = structuredClone(envelope.envelope) as unknown as Record<string, unknown>;
    delete incomplete["signature"];
    assert.throws(
      () => verify(canonicalJson(incomplete)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );

    const mutated = structuredClone(envelope.envelope);
    (
      mutated.statement as {
        source: { immutableObjectVersion: string };
      }
    ).source.immutableObjectVersion = "fixture-version-mutated";
    assert.throws(
      () => verify(canonicalJson(mutated)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );

    assert.throws(
      () => verify(envelope.canonicalBytes, observations.observerAuthorityKeyId),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );
  } finally {
    await releaseSet.cleanup();
  }
});

test("composePromotionStatement rejects missing, duplicate, and mixed candidate identities", async () => {
  const baseSet = await createVerifiedReleaseSet();
  try {
    const input = promotionCompositionInput(baseSet);
    assert.throws(
      () =>
        composePromotionStatement({
          ...input,
          verifiedCandidates: baseSet.releases.slice(0, 2),
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
    assert.throws(
      () =>
        composePromotionStatement({
          ...input,
          verifiedCandidates: [baseSet.releases[0]!, baseSet.releases[1]!, baseSet.releases[1]!],
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
    assert.throws(
      () =>
        composePromotionStatement({
          ...input,
          platformAuthenticityEvidence: input.platformAuthenticityEvidence.map((evidence) =>
            evidence.target.platform === "darwin"
              ? { ...evidence, certificateIdentities: ["apple-team:BADTEAM001"] }
              : evidence,
          ),
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
    const mismatchedNotarization = JSON.parse(
      Buffer.from(input.notarizationReceipt.bytes).toString("utf8"),
    ) as Record<string, unknown>;
    mismatchedNotarization["teamId"] = "BADTEAM001";
    assert.throws(
      () =>
        composePromotionStatement({
          ...input,
          notarizationReceipt: {
            ...input.notarizationReceipt,
            bytes: canonicalJson(mismatchedNotarization),
          },
        }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
  } finally {
    await baseSet.cleanup();
  }

  const mixedCases: readonly Partial<
    Record<"darwin" | "linux" | "win32", CandidateFixtureOptions>
  >[] = [
    { linux: { productVersion: "0.1.0-alpha.2" } },
    { linux: { buildCommit: "c".repeat(40) } },
    { linux: { auditedSourceCommit: "d".repeat(40) } },
    { linux: { candidateAttestationId: "release:candidate:test-0002" } },
  ];
  for (const options of mixedCases) {
    const releaseSet = await createVerifiedReleaseSet(options);
    try {
      const input = promotionCompositionInput(releaseSet);
      assert.throws(
        () => composePromotionStatement(input),
        (error: unknown) =>
          error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
      );
    } finally {
      await releaseSet.cleanup();
    }
  }
});

test("verifyRelease computes released only from a distinct trusted promotion and channel receipt", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const promotion = await createPromotionFixture(releaseSet);
  try {
    const linuxIndex = releaseSet.releases.findIndex(
      (release) => release.candidate.target.platform === "linux",
    );
    const fixture = releaseSet.fixtures[linuxIndex]!;
    const publisher = releaseSet.publishers[linuxIndex]!;
    const candidate = releaseSet.releases[linuxIndex]!.candidate;
    const result = await verifyRelease({
      root: fixture.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      expectedCandidateDigest: candidate.publisherStatement.sha256,
      candidatePublisherEvidence: {
        archivePath: publisher.archivePath,
        attestationPath: publisher.attestationPath,
      },
      publisherTrust: { publicKeyPem: publisher.publicKeyPem },
      promotionAttestation: {
        attestationPath: promotion.attestationPath,
        liveEvidence: promotion.liveEvidence,
        notarizationReceiptPath: promotion.notarizationReceiptPath,
        supportMatrix: promotion.supportMatrix,
      },
      promotionReceipt: {
        observerTrust: { publicKeyPem: promotion.observerPublicKeyPem },
        readBackObservations: promotion.readBackObservations,
        receiptPath: promotion.receiptPath,
      },
      promotionTrust: { publicKeyPem: promotion.publicKeyPem },
    });

    assert.equal(result.effectiveChannel, "released");
    assert.equal(result.promotionStatementId, promotion.statementId);
    assert.equal(result.receiptId, promotion.receiptId);
    assert.notEqual(result.publisherKeyId, promotion.keyId);
  } finally {
    await Promise.all([releaseSet.cleanup(), promotion.cleanup()]);
  }
});

test("verifyRelease independently authenticates the external read-back evidence set", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const promotion = await createPromotionFixture(releaseSet);
  try {
    const complete = linuxVerificationInput(releaseSet, promotion);
    await assert.rejects(
      verifyRelease({
        ...complete,
        promotionReceipt: {
          ...complete.promotionReceipt,
          observerTrust: { publicKeyPem: promotion.publicKeyPem },
        },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        promotionReceipt: {
          ...complete.promotionReceipt,
          readBackObservations: [
            complete.promotionReceipt.readBackObservations[0]!,
            complete.promotionReceipt.readBackObservations[1]!,
            complete.promotionReceipt.readBackObservations[1]!,
          ],
        },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );

    const forgedPath = promotion.readBackObservations[0]!.envelopePath;
    const forged = JSON.parse(await readFile(forgedPath, "utf8")) as {
      statement: { source: { immutableObjectVersion: string } };
    };
    forged.statement.source.immutableObjectVersion = "caller-forged-version";
    await writeFile(forgedPath, canonicalJson(forged));
    await assert.rejects(
      verifyRelease(complete),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "READ_BACK_TRUST_INVALID",
    );
  } finally {
    await Promise.all([releaseSet.cleanup(), promotion.cleanup()]);
  }
});

test("verifyRelease rejects incomplete promotion, role confusion, revocation, and false read-back", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const normal = await createPromotionFixture(releaseSet);
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const sameRole = await createPromotionFixture(releaseSet, {
    privateKey: releaseSet.publishers[linuxIndex]!.privateKey,
  });
  const otherPublisherRole = await createPromotionFixture(releaseSet, {
    privateKey: releaseSet.publishers[0]!.privateKey,
  });
  const wrongDomain = await createPromotionFixture(releaseSet, {
    receiptDomain: "opendelegate.release.publisher-attestation.v2",
  });
  const falseReadBack = await createPromotionFixture(releaseSet, {
    receiptReadBackMismatch: true,
  });
  const mismatchedMacIdentity = await createPromotionFixture(releaseSet, {
    macCertificateIdentity: "apple-team:BADTEAM001",
  });
  const mismatchedNotarizationTeam = await createPromotionFixture(releaseSet, {
    notarizationTeamId: "BADTEAM001",
  });
  try {
    const complete = linuxVerificationInput(releaseSet, normal);
    const { promotionReceipt: omittedPromotionReceipt, ...withoutPromotionReceipt } = complete;
    void omittedPromotionReceipt;
    await assert.rejects(
      verifyRelease(withoutPromotionReceipt),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_INPUT_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, sameRole)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, otherPublisherRole)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, wrongDomain)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, falseReadBack)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, mismatchedMacIdentity)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease(linuxVerificationInput(releaseSet, mismatchedNotarizationTeam)),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "PROMOTION_TRUST_INVALID",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        policy: {
          revokedPublisherKeyIds: [releaseSet.publishers[linuxIndex]!.keyId],
        },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "RELEASE_REVOKED",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        policy: { revokedPromotionKeyIds: [normal.keyId] },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "RELEASE_REVOKED",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        policy: { revokedCertificateIdentities: ["apple-team:OPENDELEG1"] },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "RELEASE_REVOKED",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        policy: { revokedCertificateIdentities: ["apple-team:HX7739G8FX"] },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "RELEASE_REVOKED",
    );
    await assert.rejects(
      verifyRelease({
        ...complete,
        policy: { revokedStatementIds: [normal.statementId] },
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "RELEASE_REVOKED",
    );
  } finally {
    await Promise.all([
      releaseSet.cleanup(),
      normal.cleanup(),
      sameRole.cleanup(),
      otherPublisherRole.cleanup(),
      wrongDomain.cleanup(),
      falseReadBack.cleanup(),
      mismatchedMacIdentity.cleanup(),
      mismatchedNotarizationTeam.cleanup(),
    ]);
  }
});

test("resolveConfiguredRelease distinguishes absent, publisher-verified, and released state", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const promotion = await createPromotionFixture(releaseSet);
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const absentStateRoot = await mkdtemp(join(tmpdir(), "opendelegate-release-state-absent-"));
  const publisherState = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  const releasedState = await createConfiguredReleaseState(releaseSet, linuxIndex, promotion);
  try {
    const release = releaseSet.releases[linuxIndex]!;
    assert.equal(
      externalReleaseVerificationPath({
        stateRoot: absentStateRoot,
        productVersion: release.candidate.productVersion,
        target: release.candidate.target,
        checksumManifestSha256: release.candidate.checksumManifestSha256,
      }),
      join(
        absentStateRoot,
        "trust",
        "releases",
        "0.1.0-alpha.1",
        "linux-x64",
        release.candidate.checksumManifestSha256,
        "release-verification.json",
      ),
    );
    const absent = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: absentStateRoot,
    });
    assert.equal(absent.effectiveChannel, "release-candidate");
    assert.deepEqual(absent.external, { status: "absent" });

    const publisherVerified = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: publisherState.stateRoot,
    });
    assert.equal(publisherVerified.effectiveChannel, "release-candidate");
    assert.equal(publisherVerified.external.status, "publisher-verified");
    assert.equal(
      publisherVerified.external.publisherKeyId,
      releaseSet.publishers[linuxIndex]!.keyId,
    );

    const released = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: releasedState.stateRoot,
    });
    assert.equal(released.effectiveChannel, "released");
    assert.equal(released.external.status, "released");
    assert.equal(released.external.promotionStatementId, promotion.statementId);
    assert.equal(released.external.receiptId, promotion.receiptId);
    assert.ok(Object.isFrozen(released));
    assert.ok(Object.isFrozen(released.external));
  } finally {
    await Promise.all([
      releaseSet.cleanup(),
      promotion.cleanup(),
      publisherState.cleanup(),
      releasedState.cleanup(),
      rm(absentStateRoot, { recursive: true, force: true }),
    ]);
  }
});

test("resolveConfiguredRelease fails closed for configuration and promotion failures", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const promotion = await createPromotionFixture(releaseSet);
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const malformed = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  const missingPromotionFile = await createConfiguredReleaseState(
    releaseSet,
    linuxIndex,
    promotion,
  );
  const invalidPromotion = await createConfiguredReleaseState(releaseSet, linuxIndex, promotion);
  const revoked = await createConfiguredReleaseState(releaseSet, linuxIndex, promotion, {
    revokedCertificateIdentities: ["apple-team:HX7739G8FX"],
  });
  try {
    await writeFile(malformed.configurationPath, '{"schemaVersion":1}\n', "utf8");
    const malformedResult = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: malformed.stateRoot,
    });
    assert.equal(malformedResult.external.status, "invalid");
    assert.equal(malformedResult.external.diagnosticCode, "RELEASE_CONFIGURATION_INVALID");

    await rm(missingPromotionFile.promotionAttestationPath!, { force: true });
    const missingResult = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: missingPromotionFile.stateRoot,
    });
    assert.equal(missingResult.external.status, "invalid");

    await writeFile(invalidPromotion.promotionAttestationPath!, "invalid\n", "utf8");
    const promotionResult = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: invalidPromotion.stateRoot,
    });
    assert.equal(promotionResult.external.status, "promotion-invalid");
    assert.equal(promotionResult.external.diagnosticCode, "PROMOTION_TRUST_INVALID");
    assert.equal(promotionResult.external.publisherKeyId, releaseSet.publishers[linuxIndex]!.keyId);

    const revokedResult = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: revoked.stateRoot,
    });
    assert.equal(revokedResult.external.status, "revoked");
    assert.equal(revokedResult.external.diagnosticCode, "RELEASE_REVOKED");
  } finally {
    await Promise.all([
      releaseSet.cleanup(),
      promotion.cleanup(),
      malformed.cleanup(),
      missingPromotionFile.cleanup(),
      invalidPromotion.cleanup(),
      revoked.cleanup(),
    ]);
  }
});

test("resolveConfiguredRelease rejects path escapes, incomplete evidence, policy disorder, and case collisions", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const promotion = await createPromotionFixture(releaseSet);
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const escaped = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  const incomplete = await createConfiguredReleaseState(releaseSet, linuxIndex, promotion);
  const disordered = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  const collision = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  const resolveLinux = (stateRoot: string, reader?: ReleaseFileReader) =>
    resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot,
      ...(reader === undefined ? {} : { reader }),
    });
  try {
    const escapedValue = JSON.parse(await readFile(escaped.configurationPath, "utf8")) as {
      candidate: { archiveFile: string };
    };
    escapedValue.candidate.archiveFile = "../outside.tar.gz";
    await writeFile(escaped.configurationPath, canonicalJson(escapedValue));
    assert.equal((await resolveLinux(escaped.stateRoot)).external.status, "invalid");

    const incompleteValue = JSON.parse(await readFile(incomplete.configurationPath, "utf8")) as {
      promotion: { liveEvidence: unknown[] };
    };
    incompleteValue.promotion.liveEvidence.pop();
    await writeFile(incomplete.configurationPath, canonicalJson(incompleteValue));
    assert.equal((await resolveLinux(incomplete.stateRoot)).external.status, "invalid");

    const disorderedValue = JSON.parse(await readFile(disordered.configurationPath, "utf8")) as {
      policy: { revokedStatementIds: string[] };
    };
    disorderedValue.policy.revokedStatementIds = ["statement:z-release", "statement:a-release"];
    await writeFile(disordered.configurationPath, canonicalJson(disorderedValue));
    assert.equal((await resolveLinux(disordered.stateRoot)).external.status, "invalid");

    const collisionValue = JSON.parse(await readFile(collision.configurationPath, "utf8")) as {
      candidate: { archiveFile: string };
    };
    const collisionCandidateParent = dirname(
      dirname(
        join(collision.stateRoot, "trust", ...collisionValue.candidate.archiveFile.split("/")),
      ),
    );
    const collisionReader: ReleaseFileReader = {
      ...nodeReleaseFileReader,
      async list(path) {
        const entries = await nodeReleaseFileReader.list(path);
        return path === collisionCandidateParent
          ? [...entries, { kind: "directory", name: "Candidate" }]
          : entries;
      },
    };
    assert.equal(
      (await resolveLinux(collision.stateRoot, collisionReader)).external.status,
      "invalid",
    );
  } finally {
    await Promise.all([
      releaseSet.cleanup(),
      promotion.cleanup(),
      escaped.cleanup(),
      incomplete.cleanup(),
      disordered.cleanup(),
      collision.cleanup(),
    ]);
  }
});

test("resolveConfiguredRelease rejects a referenced file in a sibling release directory", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const configured = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  try {
    const configuration = JSON.parse(await readFile(configured.configurationPath, "utf8")) as {
      candidate: { archiveFile: string };
    };
    const originalArchivePath = join(
      configured.stateRoot,
      "trust",
      ...configuration.candidate.archiveFile.split("/"),
    );
    const siblingArchiveFile = `releases/shared/${basename(configuration.candidate.archiveFile)}`;
    const siblingArchivePath = join(
      configured.stateRoot,
      "trust",
      ...siblingArchiveFile.split("/"),
    );
    await mkdir(dirname(siblingArchivePath), { recursive: true });
    await writeFile(siblingArchivePath, await readFile(originalArchivePath));
    configuration.candidate.archiveFile = siblingArchiveFile;
    await writeFile(configured.configurationPath, canonicalJson(configuration));

    const resolved = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: configured.stateRoot,
    });

    assert.equal(resolved.external.status, "invalid");
    assert.equal(resolved.external.diagnosticCode, "RELEASE_CONFIGURATION_INVALID");
  } finally {
    await Promise.all([releaseSet.cleanup(), configured.cleanup()]);
  }
});

test("resolveConfiguredRelease rejects a referenced file from another release digest", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const configured = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  try {
    const release = releaseSet.releases[linuxIndex]!;
    const configuration = JSON.parse(await readFile(configured.configurationPath, "utf8")) as {
      candidate: { archiveFile: string };
    };
    const originalArchivePath = join(
      configured.stateRoot,
      "trust",
      ...configuration.candidate.archiveFile.split("/"),
    );
    const otherDigest =
      release.candidate.checksumManifestSha256 === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    const otherReleaseArchiveFile =
      `releases/${release.candidate.productVersion}/linux-x64/${otherDigest}/files/candidate/` +
      basename(configuration.candidate.archiveFile);
    const otherReleaseArchivePath = join(
      configured.stateRoot,
      "trust",
      ...otherReleaseArchiveFile.split("/"),
    );
    await mkdir(dirname(otherReleaseArchivePath), { recursive: true });
    await writeFile(otherReleaseArchivePath, await readFile(originalArchivePath));
    configuration.candidate.archiveFile = otherReleaseArchiveFile;
    await writeFile(configured.configurationPath, canonicalJson(configuration));

    const resolved = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      stateRoot: configured.stateRoot,
    });

    assert.equal(resolved.external.status, "invalid");
    assert.equal(resolved.external.diagnosticCode, "RELEASE_CONFIGURATION_INVALID");
  } finally {
    await Promise.all([releaseSet.cleanup(), configured.cleanup()]);
  }
});

test("resolveConfiguredRelease rejects a canonical alias outside its release digest directory", async () => {
  const releaseSet = await createVerifiedReleaseSet();
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const configured = await createConfiguredReleaseState(releaseSet, linuxIndex, null);
  try {
    const configuration = JSON.parse(await readFile(configured.configurationPath, "utf8")) as {
      candidate: { archiveFile: string };
    };
    const archivePath = join(
      configured.stateRoot,
      "trust",
      ...configuration.candidate.archiveFile.split("/"),
    );
    const aliasedArchivePath = join(
      configured.stateRoot,
      "trust",
      "releases",
      "shared",
      basename(configuration.candidate.archiveFile),
    );
    await mkdir(dirname(aliasedArchivePath), { recursive: true });
    await writeFile(aliasedArchivePath, await readFile(archivePath));
    const aliasedReader: ReleaseFileReader = {
      ...nodeReleaseFileReader,
      async realPath(path) {
        return path === archivePath
          ? nodeReleaseFileReader.realPath(aliasedArchivePath)
          : nodeReleaseFileReader.realPath(path);
      },
    };

    const resolved = await resolveConfiguredRelease({
      root: releaseSet.fixtures[linuxIndex]!.root,
      expectedTarget: { platform: "linux", architecture: "x64" },
      reader: aliasedReader,
      stateRoot: configured.stateRoot,
    });

    assert.equal(resolved.external.status, "invalid");
    assert.equal(resolved.external.diagnosticCode, "RELEASE_CONFIGURATION_INVALID");
  } finally {
    await Promise.all([releaseSet.cleanup(), configured.cleanup()]);
  }
});

test("resolveConfiguredRelease never downgrades candidate corruption into external status", async () => {
  const fixture = await createCandidateFixture({
    platform: "linux",
    architecture: "x64",
  });
  const stateRoot = await mkdtemp(join(tmpdir(), "opendelegate-release-state-"));
  try {
    await writeFile(
      join(fixture.root, "bin", "opendelegate-service-host"),
      "candidate corruption\n",
      "utf8",
    );
    await assert.rejects(
      resolveConfiguredRelease({
        root: fixture.root,
        expectedTarget: { platform: "linux", architecture: "x64" },
        stateRoot,
      }),
      (error: unknown) =>
        error instanceof ReleaseIntegrityError && error.code === "CANDIDATE_INTEGRITY_INVALID",
    );
  } finally {
    await Promise.all([
      rm(fixture.root, { recursive: true, force: true }),
      rm(stateRoot, { recursive: true, force: true }),
    ]);
  }
});

test("resolveConfiguredRelease accepts a composer-style digest-contained subtree", async () => {
  const fixture = await createReleasedConfiguredReleaseTestFixture();
  try {
    const configuration = JSON.parse(
      await readFile(fixture.configuration.configurationPath, "utf8"),
    ) as {
      candidate: {
        archiveFile: string;
        publisherAttestationFile: string;
        publisherTrustRootFile: string;
      };
      promotion: {
        liveEvidence: readonly { file: string }[];
        notarizationReceiptFile: string;
        observerTrustRootFile: string;
        promotionAttestationFile: string;
        promotionTrustRootFile: string;
        readBackObservations: readonly { file: string }[];
        supportMatrix: { file: string };
        supportedChannelReceiptFile: string;
      };
    };
    const targetKey = `${fixture.candidate.target.platform}-${fixture.candidate.target.architecture}`;
    const containedPrefix =
      `releases/${fixture.candidate.productVersion}/${targetKey}/` +
      `${fixture.candidate.checksumManifestSha256}/files/`;
    const referencedFiles = [
      configuration.candidate.archiveFile,
      configuration.candidate.publisherAttestationFile,
      configuration.candidate.publisherTrustRootFile,
      configuration.promotion.promotionAttestationFile,
      configuration.promotion.supportedChannelReceiptFile,
      configuration.promotion.promotionTrustRootFile,
      configuration.promotion.observerTrustRootFile,
      configuration.promotion.supportMatrix.file,
      configuration.promotion.notarizationReceiptFile,
      ...configuration.promotion.readBackObservations.map(({ file }) => file),
      ...configuration.promotion.liveEvidence.map(({ file }) => file),
    ];
    assert.equal(
      referencedFiles.every((file) => file.startsWith(containedPrefix)),
      true,
    );

    const resolved = await resolveConfiguredRelease({
      root: fixture.root,
      expectedTarget: fixture.expectedTarget,
      stateRoot: fixture.stateRoot,
    });
    assert.equal(resolved.external.status, "released");
    assert.equal(resolved.candidate.buildId, fixture.candidate.buildId);
  } finally {
    await fixture.cleanup();
  }
});

interface CandidateFixture {
  readonly acceptanceLedgerSha256: string;
  readonly checksumManifestSha256: string;
  readonly nativeComponentsSha256: string;
  readonly payloadManifestSha256: string;
  readonly platformAuthenticitySha256: string;
  readonly releaseMetadataSha256: string;
  readonly root: string;
}

interface VerifiedReleaseSet {
  readonly cleanup: () => Promise<void>;
  readonly fixtures: readonly CandidateFixture[];
  readonly publishers: readonly PublisherFixture[];
  readonly releases: readonly VerifiedRelease[];
}

function promotionCompositionInput(releaseSet: VerifiedReleaseSet) {
  const mac = releaseSet.releases.find(
    (release) => release.candidate.target.platform === "darwin",
  )!;
  const notarizationReceipt = {
    path: "docs/release/evidence/macos-notarization.json",
    bytes: canonicalJson({
      schemaVersion: 1,
      product: "OpenDelegate",
      type: "macos-notarization",
      target: { platform: "darwin", architecture: "arm64" },
      archive: mac.archive,
      status: "accepted",
      submissionId: "0f7b7a50-584d-43fc-b746-0a1419b64630",
      teamId: "OPENDELEG1",
      resultId: "apple-notary-result-0001",
      logId: "apple-notary-log-0001",
      observedAt: "2026-07-26T01:00:00.000Z",
    }),
  };
  const supportMatrix = {
    path: "docs/release/SUPPORT_MATRIX.md",
    bytes: Buffer.from("# Immutable support matrix\n", "utf8"),
  };
  const liveEvidence = Array.from({ length: 36 }, (_, index) => ({
    criterionId: index + 1,
    path: `docs/release/evidence/live-${String(index + 1).padStart(2, "0")}.json`,
    bytes: Buffer.from(`{"criterion":${String(index + 1)},"status":"verified"}\n`, "utf8"),
  }));
  const platformAuthenticityEvidence = releaseSet.releases.map((release) => {
    const platform = release.candidate.target.platform;
    return {
      target: release.candidate.target,
      recordSha256: release.candidate.platformAuthenticitySha256,
      certificateIdentities: release.candidate.platformCertificateIdentities,
      productCertificateIdentity: release.candidate.platformProductCertificateIdentity,
      verificationEvidence: [
        {
          path: `docs/release/evidence/${platform}-native-authenticity.json`,
          bytes: Buffer.from(`{"platform":"${platform}","verified":true}\n`, "utf8"),
        },
      ],
    };
  });
  return {
    verifiedCandidates: releaseSet.releases,
    platformAuthenticityEvidence,
    notarizationReceipt,
    supportMatrix,
    liveEvidence,
    releaseId: "opendelegate-v0.1.0-alpha.1",
    channel: "stable",
    issuedAt: "2026-07-26T02:00:00.000Z",
    statementId: "promotion:opendelegate-v0.1.0-alpha.1:0001",
  };
}

async function createVerifiedReleaseSet(
  options: Partial<Record<"darwin" | "linux" | "win32", CandidateFixtureOptions>> = {},
): Promise<VerifiedReleaseSet> {
  const targets = [
    { platform: "darwin", architecture: "arm64" },
    { platform: "linux", architecture: "x64" },
    { platform: "win32", architecture: "x64" },
  ] as const;
  const fixtures: CandidateFixture[] = [];
  const publishers: PublisherFixture[] = [];
  const releases: VerifiedRelease[] = [];
  try {
    for (const target of targets) {
      const fixture = await createCandidateFixture(target, options[target.platform]);
      fixtures.push(fixture);
      const candidate = await inspectCandidate({
        root: fixture.root,
        expectedTarget: target,
      });
      const publisher = await createPublisherFixture(candidate, fixture.root);
      publishers.push(publisher);
      releases.push(
        await verifyRelease({
          root: fixture.root,
          expectedTarget: target,
          candidatePublisherEvidence: {
            archivePath: publisher.archivePath,
            attestationPath: publisher.attestationPath,
          },
          publisherTrust: { publicKeyPem: publisher.publicKeyPem },
        }),
      );
    }
  } catch (error) {
    await cleanupReleaseFixtures(fixtures, publishers);
    throw error;
  }
  return {
    fixtures,
    publishers,
    releases,
    async cleanup() {
      await cleanupReleaseFixtures(fixtures, publishers);
    },
  };
}

interface PromotionFixture {
  readonly attestationPath: string;
  readonly cleanup: () => Promise<void>;
  readonly keyId: string;
  readonly liveEvidence: readonly {
    readonly criterionId: number;
    readonly path: string;
    readonly bytes: Buffer;
  }[];
  readonly notarizationReceiptPath: string;
  readonly observerPublicKeyPem: Buffer;
  readonly publicKeyPem: Buffer;
  readonly readBackObservations: readonly {
    readonly envelopePath: string;
    readonly target: CandidateDescription["target"];
  }[];
  readonly receiptId: string;
  readonly receiptPath: string;
  readonly statementId: string;
  readonly supportMatrix: { readonly path: string; readonly bytes: Buffer };
}

function linuxVerificationInput(releaseSet: VerifiedReleaseSet, promotion: PromotionFixture) {
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const fixture = releaseSet.fixtures[linuxIndex]!;
  const publisher = releaseSet.publishers[linuxIndex]!;
  const candidate = releaseSet.releases[linuxIndex]!.candidate;
  return {
    root: fixture.root,
    expectedTarget: { platform: "linux", architecture: "x64" } as const,
    expectedCandidateDigest: candidate.publisherStatement.sha256,
    candidatePublisherEvidence: {
      archivePath: publisher.archivePath,
      attestationPath: publisher.attestationPath,
    },
    publisherTrust: { publicKeyPem: publisher.publicKeyPem },
    promotionAttestation: {
      attestationPath: promotion.attestationPath,
      liveEvidence: promotion.liveEvidence,
      notarizationReceiptPath: promotion.notarizationReceiptPath,
      supportMatrix: promotion.supportMatrix,
    },
    promotionReceipt: {
      observerTrust: { publicKeyPem: promotion.observerPublicKeyPem },
      readBackObservations: promotion.readBackObservations,
      receiptPath: promotion.receiptPath,
    },
    promotionTrust: { publicKeyPem: promotion.publicKeyPem },
  };
}

async function createPromotionFixture(
  releaseSet: VerifiedReleaseSet,
  options: {
    readonly macCertificateIdentity?: string;
    readonly notarizationTeamId?: string;
    readonly privateKey?: KeyObject;
    readonly receiptDomain?: string;
    readonly receiptReadBackMismatch?: boolean;
  } = {},
): Promise<PromotionFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-promotion-"));
  const mac = releaseSet.releases.find(
    (release) => release.candidate.target.platform === "darwin",
  )!;
  const statementId = "promotion:opendelegate-v0.1.0-alpha.1:0001";
  const receiptId = "receipt:opendelegate-v0.1.0-alpha.1:0001";
  const notarizationReceiptPath = join(directory, "macos-notarization.json");
  const canonicalNotarizationValue = {
    schemaVersion: 1,
    product: "OpenDelegate",
    type: "macos-notarization",
    target: { platform: "darwin", architecture: "arm64" },
    archive: mac.archive,
    status: "accepted",
    submissionId: "0f7b7a50-584d-43fc-b746-0a1419b64630",
    teamId: "OPENDELEG1",
    resultId: "apple-notary-result-0001",
    logId: "apple-notary-log-0001",
    observedAt: "2026-07-26T01:00:00.000Z",
  };
  const canonicalNotarizationBytes = canonicalJson(canonicalNotarizationValue);
  const supportMatrix = {
    path: "docs/release/SUPPORT_MATRIX.md",
    bytes: Buffer.from("# Immutable support matrix\n", "utf8"),
  };
  const liveEvidence = Array.from({ length: 36 }, (_, index) => ({
    criterionId: index + 1,
    path: `docs/release/evidence/live-${String(index + 1).padStart(2, "0")}.json`,
    bytes: Buffer.from(`{"criterion":${String(index + 1)},"status":"verified"}\n`, "utf8"),
  }));
  const platformAuthenticityEvidence = releaseSet.releases.map((release) => {
    const platform = release.candidate.target.platform;
    return {
      target: release.candidate.target,
      recordSha256: release.candidate.platformAuthenticitySha256,
      certificateIdentities: release.candidate.platformCertificateIdentities,
      productCertificateIdentity: release.candidate.platformProductCertificateIdentity,
      verificationEvidence: [
        {
          path: `docs/release/evidence/${platform}-native-authenticity.json`,
          bytes: Buffer.from(`{"platform":"${platform}","verified":true}\n`, "utf8"),
        },
      ],
    };
  });
  const composed = composePromotionStatement({
    verifiedCandidates: releaseSet.releases,
    platformAuthenticityEvidence,
    notarizationReceipt: {
      path: "docs/release/evidence/macos-notarization.json",
      bytes: canonicalNotarizationBytes,
    },
    supportMatrix,
    liveEvidence,
    releaseId: "opendelegate-v0.1.0-alpha.1",
    channel: "stable",
    issuedAt: "2026-07-26T02:00:00.000Z",
    statementId,
  });
  const generated = options.privateKey === undefined ? generateKeyPairSync("ed25519") : undefined;
  const privateKey = options.privateKey ?? generated!.privateKey;
  const publicKey = generated?.publicKey ?? createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const keyId = `sha256:${sha256(publicKeyDer)}`;
  const promotionUsesComposer =
    options.macCertificateIdentity === undefined && options.notarizationTeamId === undefined;
  const alteredPromotionStatement = promotionUsesComposer
    ? undefined
    : (JSON.parse(Buffer.from(composed.canonicalBytes).toString("utf8")) as Record<
        string,
        unknown
      > & {
        targets: {
          notarization: {
            receipt: { sha256: string };
            teamId: string;
          } | null;
          platformAuthenticity: { certificateIdentities: string[] };
        }[];
      });
  const notarizationBytes =
    options.notarizationTeamId === undefined
      ? canonicalNotarizationBytes
      : canonicalJson({
          ...canonicalNotarizationValue,
          teamId: options.notarizationTeamId,
        });
  if (options.macCertificateIdentity !== undefined) {
    alteredPromotionStatement!.targets[0]!.platformAuthenticity.certificateIdentities = [
      options.macCertificateIdentity,
    ];
  }
  if (options.notarizationTeamId !== undefined) {
    alteredPromotionStatement!.targets[0]!.notarization!.teamId = options.notarizationTeamId;
    alteredPromotionStatement!.targets[0]!.notarization!.receipt.sha256 = sha256(notarizationBytes);
  }
  const promotionStatement = alteredPromotionStatement ?? composed.statement;
  const promotionCanonicalBytes = promotionUsesComposer
    ? composed.canonicalBytes
    : canonicalJson(promotionStatement);
  const promotionSigningBytes = promotionUsesComposer
    ? composed.signingBytes
    : Buffer.concat([
        Buffer.from("OpenDelegate promotion authorization v1\n", "utf8"),
        promotionCanonicalBytes,
      ]);
  const promotionSignature = createSignature(null, promotionSigningBytes, privateKey).toString(
    "base64url",
  );
  const attestationBytes = promotionUsesComposer
    ? composeSignedReleaseEnvelope({
        composed,
        keyId,
        signature: promotionSignature,
      }).canonicalBytes
    : canonicalJson({
        schemaVersion: 1,
        product: "OpenDelegate",
        role: "promotion",
        algorithm: "ed25519",
        keyId,
        statement: promotionStatement,
        signature: promotionSignature,
      });
  const attestationPath = join(directory, "promotion-attestation.json");
  const observer = generateKeyPairSync("ed25519");
  const observerKeyId = `sha256:${sha256(observer.publicKey.export({ format: "der", type: "spki" }))}`;
  const observerPublicKeyPem = Buffer.from(
    observer.publicKey.export({ format: "pem", type: "spki" }),
  );
  const observationEvidence = releaseSet.releases.map((release) => {
    const targetKey = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
    const observation = composeRemoteReadBackObservationStatement({
      archive: release.archive,
      channel: "stable",
      immutableObjectId: `fixture/releases/opendelegate-v0.1.0-alpha.1/${release.archive.path}`,
      immutableObjectVersion: `fixture-version-${targetKey}`,
      observedAt: "2026-07-26T02:30:00.000Z",
      observedStreamSha256: release.archive.sha256,
      observerAuthorityKeyId: observerKeyId,
      provider: "fixture-channel",
      releaseId: "opendelegate-v0.1.0-alpha.1",
      tag: "v0.1.0-alpha.1",
      target: release.candidate.target,
      uploaderAuthorityKeyId: keyId,
    });
    const signature = createSignature(null, observation.signingBytes, observer.privateKey).toString(
      "base64url",
    );
    const envelope = composeSignedReleaseEnvelope({
      composed: observation,
      keyId: observerKeyId,
      signature,
    });
    return {
      envelopeBytes: envelope.canonicalBytes,
      envelopePath: join(directory, `read-back-${targetKey}.json`),
      target: release.candidate.target,
      verified: verifyRemoteReadBackObservation({
        envelopeBytes: envelope.canonicalBytes,
        expectedUploaderAuthorityKeyId: keyId,
        observerTrust: { publicKeyPem: observerPublicKeyPem },
      }),
    };
  });
  const verifiedObservations = observationEvidence.map(({ verified }) => verified);
  const receiptUsesComposer =
    options.receiptDomain === undefined && options.receiptReadBackMismatch !== true;
  const receiptComposed = composeSupportedChannelReceiptStatement({
    promotion: composed,
    promotionAttestationSha256: sha256(attestationBytes),
    verifiedObservations,
    receiptId,
    observedAt: "2026-07-26T03:00:00.000Z",
  });
  let receiptStatement: unknown = receiptComposed.statement;
  if (!receiptUsesComposer) {
    const alteredReceiptStatement = JSON.parse(
      Buffer.from(receiptComposed.canonicalBytes).toString("utf8"),
    ) as {
      domain: string;
      publishedAssets: {
        observedStreamSha256: string;
        target: { platform: string };
      }[];
    };
    if (options.receiptDomain !== undefined) {
      alteredReceiptStatement.domain = options.receiptDomain;
    }
    if (options.receiptReadBackMismatch === true) {
      alteredReceiptStatement.publishedAssets.find(
        ({ target }) => target.platform === "linux",
      )!.observedStreamSha256 = "0".repeat(64);
    }
    receiptStatement = alteredReceiptStatement;
  }
  const receiptStatementBytes = receiptUsesComposer
    ? receiptComposed.canonicalBytes
    : canonicalJson(receiptStatement);
  const receiptSignature = createSignature(
    null,
    receiptUsesComposer
      ? receiptComposed.signingBytes
      : Buffer.concat([
          Buffer.from("OpenDelegate supported channel receipt v2\n", "utf8"),
          receiptStatementBytes,
        ]),
    privateKey,
  ).toString("base64url");
  const receiptBytes = !receiptUsesComposer
    ? canonicalJson({
        schemaVersion: 2,
        product: "OpenDelegate",
        role: "promotion",
        algorithm: "ed25519",
        keyId,
        statement: receiptStatement,
        signature: receiptSignature,
      })
    : composeSignedReleaseEnvelope({
        composed: receiptComposed,
        keyId,
        signature: receiptSignature,
      }).canonicalBytes;
  const receiptPath = join(directory, "release-receipt.json");
  await Promise.all([
    writeFile(notarizationReceiptPath, notarizationBytes),
    writeFile(attestationPath, attestationBytes),
    writeFile(receiptPath, receiptBytes),
    ...observationEvidence.map(({ envelopeBytes, envelopePath }) =>
      writeFile(envelopePath, envelopeBytes),
    ),
  ]);
  return {
    attestationPath,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
    keyId,
    liveEvidence,
    notarizationReceiptPath,
    observerPublicKeyPem,
    publicKeyPem: Buffer.from(publicKeyPem),
    readBackObservations: observationEvidence.map(({ envelopePath, target }) => ({
      envelopePath,
      target,
    })),
    receiptId,
    receiptPath,
    statementId,
    supportMatrix,
  };
}

interface ConfiguredReleaseStateFixture {
  readonly cleanup: () => Promise<void>;
  readonly configurationPath: string;
  readonly promotionAttestationPath?: string;
  readonly stateRoot: string;
}

async function createConfiguredReleaseState(
  releaseSet: VerifiedReleaseSet,
  releaseIndex: number,
  promotion: PromotionFixture | null,
  policy: {
    readonly revokedCertificateIdentities?: readonly string[];
    readonly revokedPromotionKeyIds?: readonly string[];
    readonly revokedPublisherKeyIds?: readonly string[];
    readonly revokedStatementIds?: readonly string[];
  } = {},
): Promise<ConfiguredReleaseStateFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), "opendelegate-release-state-"));
  const trustRoot = join(stateRoot, "trust");
  const release = releaseSet.releases[releaseIndex]!;
  const publisher = releaseSet.publishers[releaseIndex]!;
  const targetKey = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
  const releaseMaterialRoot =
    `releases/${release.candidate.productVersion}/${targetKey}/` +
    `${release.candidate.checksumManifestSha256}/files`;
  const publisherRoot = `${releaseMaterialRoot}/candidate`;
  const archiveFile = `${publisherRoot}/${basename(publisher.archivePath)}`;
  const publisherAttestationFile = `${publisherRoot}/${basename(publisher.attestationPath)}`;
  const publisherTrustRootFile = `${publisherRoot}/publisher-public.pem`;
  const writeTrustFile = async (path: string, bytes: Uint8Array): Promise<string> => {
    const absolutePath = join(trustRoot, ...path.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    return absolutePath;
  };
  await Promise.all([
    writeTrustFile(archiveFile, await readFile(publisher.archivePath)),
    writeTrustFile(publisherAttestationFile, await readFile(publisher.attestationPath)),
    writeTrustFile(publisherTrustRootFile, publisher.publicKeyPem),
  ]);

  let promotionConfiguration: object | null = null;
  let promotionAttestationPath: string | undefined;
  if (promotion !== null) {
    const promotionRoot = `${releaseMaterialRoot}/promotion`;
    const promotionAttestationFile = `${promotionRoot}/promotion-attestation.json`;
    const supportedChannelReceiptFile = `${promotionRoot}/supported-channel-receipt.json`;
    const promotionTrustRootFile = `${promotionRoot}/promotion-public.pem`;
    const observerTrustRootFile = `${promotionRoot}/observer-public.pem`;
    const supportMatrixFile = `${promotionRoot}/support-matrix.md`;
    const notarizationReceiptFile = `${promotionRoot}/macos-notarization.json`;
    promotionAttestationPath = await writeTrustFile(
      promotionAttestationFile,
      await readFile(promotion.attestationPath),
    );
    await Promise.all([
      writeTrustFile(supportedChannelReceiptFile, await readFile(promotion.receiptPath)),
      writeTrustFile(promotionTrustRootFile, promotion.publicKeyPem),
      writeTrustFile(observerTrustRootFile, promotion.observerPublicKeyPem),
      writeTrustFile(supportMatrixFile, promotion.supportMatrix.bytes),
      writeTrustFile(notarizationReceiptFile, await readFile(promotion.notarizationReceiptPath)),
    ]);
    const liveEvidence = [];
    for (const evidence of promotion.liveEvidence) {
      const file =
        `${promotionRoot}/live/` + `${String(evidence.criterionId).padStart(2, "0")}.json`;
      await writeTrustFile(file, evidence.bytes);
      liveEvidence.push({
        criterionId: evidence.criterionId,
        statementPath: evidence.path,
        file,
      });
    }
    const readBackObservations = [];
    for (const observation of promotion.readBackObservations) {
      const file =
        `${promotionRoot}/read-back/` +
        `${observation.target.platform}-${observation.target.architecture}.json`;
      await writeTrustFile(file, await readFile(observation.envelopePath));
      readBackObservations.push({ target: observation.target, file });
    }
    promotionConfiguration = {
      promotionAttestationFile,
      supportedChannelReceiptFile,
      promotionTrustRootFile,
      observerTrustRootFile,
      readBackObservations,
      supportMatrix: {
        statementPath: promotion.supportMatrix.path,
        file: supportMatrixFile,
      },
      notarizationReceiptFile,
      liveEvidence,
    };
  }

  const configuration = {
    schemaVersion: 1,
    product: "OpenDelegate",
    target: release.candidate.target,
    candidate: {
      expectedManifestSha256: release.candidate.checksumManifestSha256,
      expectedCandidateDigest: release.candidate.publisherStatement.sha256,
      archiveFile,
      publisherAttestationFile,
      publisherTrustRootFile,
    },
    promotion: promotionConfiguration,
    policy: {
      revokedCertificateIdentities: policy.revokedCertificateIdentities ?? [],
      revokedPromotionKeyIds: policy.revokedPromotionKeyIds ?? [],
      revokedPublisherKeyIds: policy.revokedPublisherKeyIds ?? [],
      revokedStatementIds: policy.revokedStatementIds ?? [],
    },
  };
  const configurationPath = externalReleaseVerificationPath({
    stateRoot,
    productVersion: release.candidate.productVersion,
    target: release.candidate.target,
    checksumManifestSha256: release.candidate.checksumManifestSha256,
  });
  await mkdir(dirname(configurationPath), { recursive: true });
  await writeFile(configurationPath, canonicalJson(configuration));
  return {
    async cleanup() {
      await rm(stateRoot, { recursive: true, force: true });
    },
    configurationPath,
    ...(promotionAttestationPath === undefined ? {} : { promotionAttestationPath }),
    stateRoot,
  };
}

async function cleanupReleaseFixtures(
  fixtures: readonly CandidateFixture[],
  publishers: readonly PublisherFixture[],
): Promise<void> {
  await Promise.all([
    ...fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...publishers.flatMap((publisher) => [
      rm(publisher.archivePath, { force: true }),
      rm(publisher.attestationPath, { force: true }),
    ]),
  ]);
}

interface PublisherFixture {
  readonly archiveBytes: Buffer;
  readonly archivePath: string;
  readonly attestationPath: string;
  readonly attestationSha256: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: Buffer;
}

async function createPublisherFixture(
  candidate: CandidateDescription,
  candidateRoot: string,
): Promise<PublisherFixture> {
  const archiveBytes = Buffer.from(
    `archive:${candidate.target.platform}:${candidate.publisherStatement.sha256}\n`,
    "utf8",
  );
  const archivePath = `${candidateRoot}.tar.gz`;
  const attestationPath = `${archivePath}.publisher-attestation.json`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const keyId = `sha256:${sha256(publicKeyDer)}`;
  const composed = composePublisherAttestationStatement({
    candidate,
    archive: {
      path: basename(archivePath),
      size: archiveBytes.byteLength,
      sha256: sha256(archiveBytes),
    },
  });
  const signature = createSignature(null, composed.signingBytes, privateKey).toString("base64url");
  const envelope = composeSignedReleaseEnvelope({
    composed,
    keyId,
    signature,
  });
  const attestationBytes = envelope.canonicalBytes;
  await Promise.all([
    writeFile(archivePath, archiveBytes),
    writeFile(attestationPath, attestationBytes),
  ]);
  return {
    archiveBytes,
    archivePath,
    attestationPath,
    attestationSha256: envelope.sha256,
    keyId,
    privateKey,
    publicKeyPem: Buffer.from(publicKeyPem),
  };
}

function candidateBinding(candidate: CandidateDescription): object {
  return {
    publisherCandidateStatementSha256: candidate.publisherStatement.sha256,
    target: candidate.target,
    productVersion: candidate.productVersion,
    buildCommit: candidate.buildCommit,
    auditedSourceCommit: candidate.auditedSourceCommit,
    acceptanceLedgerSha256: candidate.acceptanceLedgerSha256,
    candidateAttestationId: candidate.candidateAttestationId,
    checksumManifestSha256: candidate.checksumManifestSha256,
    payloadManifestSha256: candidate.payloadManifestSha256,
    releaseMetadataSha256: candidate.releaseMetadataSha256,
    nativeComponentsSha256: candidate.nativeComponentsSha256,
    platformAuthenticitySha256: candidate.platformAuthenticitySha256,
  };
}

async function createCandidateFixture(
  target: Readonly<{ platform: "darwin" | "linux" | "win32"; architecture: "arm64" | "x64" }>,
  options: CandidateFixtureOptions = {},
): Promise<CandidateFixture> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-integrity-"));
  const auditedSourceCommit = options.auditedSourceCommit ?? "a".repeat(40);
  const buildCommit = options.buildCommit ?? "b".repeat(40);
  const productVersion = options.productVersion ?? "0.1.0-alpha.1";
  const supportStatus = options.supportStatus ?? "release-candidate";
  const candidateAttestationId = options.candidateAttestationId ?? "release:candidate:test-0001";
  const evidencePath = "docs/release/evidence/release-proof.txt";
  const evidenceBytes = Buffer.from("immutable release evidence\n", "utf8");
  const evidenceSha256 = sha256(evidenceBytes);
  const componentDefinitions = expectedComponents(target.platform);
  const componentBytes = new Map(
    componentDefinitions.map((component) => [
      component.path,
      Buffer.from(`signed:${component.kind}:${target.platform}\n`, "utf8"),
    ]),
  );
  const nativeComponents = {
    schemaVersion: 1,
    platform: target.platform,
    architecture: target.architecture,
    components: componentDefinitions.map((component) => ({
      kind: component.kind,
      path: component.path,
      sha256: `sha256:${sha256(componentBytes.get(component.path)!)}`,
    })),
  };
  const nativeComponentsBytes = canonicalJson(nativeComponents);
  const runtimePath = target.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  const thirdPartyBytes = new Map<string, Buffer>([
    [
      "node_modules/example-native/build/Release/example.node",
      nativeFixtureBinary(target.platform, "example-native-final"),
    ],
    [runtimePath, nativeFixtureBinary(target.platform, "node-runtime-final")],
  ]);
  const platformPolicy =
    target.platform === "darwin"
      ? "developer-id"
      : target.platform === "win32"
        ? "authenticode"
        : "publisher-only";
  const publicIdentity =
    target.platform === "darwin"
      ? {
          type: "apple-developer-id-application",
          selector: "Developer ID Application: OpenDelegate (OPENDELEG1)",
          teamId: "OPENDELEG1",
        }
      : target.platform === "win32"
        ? {
            type: "windows-authenticode",
            certificateSha1: "E".repeat(40),
            store: "CurrentUser/My",
            timestampUrl: "https://timestamp.example.test/",
          }
        : null;
  const upstreamRuntimeIdentity =
    target.platform === "darwin"
      ? {
          type: "apple-developer-id-application",
          selector: "Developer ID Application: Node.js Foundation (HX7739G8FX)",
          teamId: "HX7739G8FX",
        }
      : target.platform === "win32"
        ? {
            type: "windows-authenticode-upstream",
            certificateSha1: "A".repeat(40),
          }
        : null;
  const thirdPartyComponents = [...thirdPartyBytes]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, finalBytes]) => {
      const digest = `sha256:${sha256(finalBytes)}`;
      const isRuntime = path === runtimePath;
      return {
        kind: isRuntime ? "bundled-node-runtime" : "bundled-native-library",
        path,
        inputSha256:
          target.platform === "linux" || isRuntime
            ? digest
            : `sha256:${sha256(nativeFixtureBinary(target.platform, `${path}:input`))}`,
        sha256: digest,
        verification:
          target.platform === "linux"
            ? "publisher-only"
            : isRuntime
              ? "upstream-verified"
              : "resigned",
        publicIdentity: isRuntime ? upstreamRuntimeIdentity : null,
      };
    });
  const runtimeComponent = thirdPartyComponents.find(({ path }) => path === runtimePath)!;
  if (options.collideRuntimeIdentity === true && target.platform !== "linux") {
    runtimeComponent.publicIdentity =
      target.platform === "darwin"
        ? publicIdentity
        : {
            type: "windows-authenticode-upstream",
            certificateSha1: "E".repeat(40),
          };
  }
  if (options.corruptRuntimeInputDigest === true) {
    runtimeComponent.inputSha256 = `sha256:${"7".repeat(64)}`;
  }
  if (options.omitThirdPartyComponent === true) {
    thirdPartyComponents.pop();
  }
  if (options.addThirdPartyComponent === true) {
    thirdPartyComponents.push({
      kind: "bundled-native-library",
      path: "vendor/extra.node",
      inputSha256: `sha256:${"8".repeat(64)}`,
      sha256: `sha256:${"9".repeat(64)}`,
      verification: target.platform === "linux" ? "publisher-only" : "resigned",
      publicIdentity: null,
    });
  }
  if (options.corruptThirdPartyDigest === true) {
    thirdPartyComponents[0]!.sha256 = `sha256:${"0".repeat(64)}`;
  }
  if (options.corruptThirdPartyVerification === true) {
    thirdPartyComponents[0]!.verification = "unsigned";
  }
  const platformAuthenticity = {
    schemaVersion: 1,
    target,
    supportEligible: true,
    status: "verified",
    policy: platformPolicy,
    policySha256: "c".repeat(64),
    tool:
      target.platform === "linux"
        ? null
        : {
            name: target.platform === "darwin" ? "codesign" : "signtool",
            version: "1.0.0",
            sha256: "d".repeat(64),
          },
    publicIdentity,
    components: nativeComponents.components.map((component) => ({
      kind: component.kind,
      path: component.path,
      inputSha256:
        target.platform === "linux"
          ? component.sha256
          : `sha256:${sha256(Buffer.from(`unsigned:${component.kind}:${target.platform}\n`))}`,
      sha256: component.sha256,
      verification: target.platform === "linux" ? "publisher-only" : "signed",
    })),
    thirdPartyComponents,
  };
  const platformAuthenticityBytes = canonicalJson(platformAuthenticity);
  const proof = {
    sourceCommit: auditedSourceCommit,
    attestationId: "release:proof:test-0001",
    evidence: [{ path: evidencePath, sha256: evidenceSha256 }],
  };
  const criteria = Array.from({ length: 36 }, (_, index) => ({
    id: index + 1,
    title: `Release criterion ${String(index + 1)}`,
    implementationStatus: "verified",
    liveProofStatus: "verified",
    evidence: [evidencePath],
    nextGate: "Complete.",
    verification: {
      implementation: proof,
      liveProof: proof,
    },
  }));
  const ledger = {
    $schema: "./acceptance-evidence.schema.json",
    schemaVersion: 1,
    product: "OpenDelegate",
    milestone: "first",
    auditedAt: "2026-07-26T00:00:00.000Z",
    sourceCommit: auditedSourceCommit,
    releaseStatus: "candidate",
    criteria,
    candidateAttestation: {
      sourceCommit: auditedSourceCommit,
      attestationId: candidateAttestationId,
      evidence: [{ path: evidencePath, sha256: evidenceSha256 }],
    },
  };
  const ledgerBytes = canonicalJson(ledger);
  const releaseMetadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion,
    protocolVersion: "v1",
    buildId: `release-candidate-${buildCommit.slice(0, 12)}`,
    createdAt: "2026-07-26T00:00:00.000Z",
    timestampPolicy: supportStatus === "release-candidate" ? "source-commit" : "wall-clock",
    platform: target.platform,
    architecture: target.architecture,
    bundledNodeVersion: "24.18.0",
    bundledRuntime: {
      source: "official-nodejs-distribution",
      archive: "node-v24.18.0.tar.gz",
      archiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.gz",
      archiveSha256: "1".repeat(64),
      shasumsUrl: "https://nodejs.org/dist/v24.18.0/SHASUMS256.txt",
      executableSha256: sha256(thirdPartyBytes.get(runtimePath)!),
      licenseSha256: "3".repeat(64),
    },
    toolchain: {
      packageManager: "pnpm@11.15.1",
      bundler: "esbuild@0.28.1",
    },
    dependencyLockSha256: "4".repeat(64),
    sourcePackageManifestSha256: "5".repeat(64),
    runtimeExternals: [
      { name: "@node-rs/argon2", version: "2.0.2" },
      { name: "better-sqlite3", version: "13.0.1" },
      { name: "pg", version: "8.22.0" },
    ],
    nativeComponents,
    buildCommit,
    auditedSourceCommit,
    changedAttestationPaths: ["docs/release/acceptance-evidence.json", evidencePath],
    buildSourceDirty: false,
    supportStatus,
    buildMode: supportStatus === "release-candidate" ? "release-candidate" : "internal-preview",
    releaseEvidence: {
      auditedAt: ledger.auditedAt,
      releaseStatus: "candidate",
      sha256: options.corruptMetadataLedgerBinding ? "0".repeat(64) : sha256(ledgerBytes),
      implementation: { verified: 36 },
      liveProof: { verified: 36 },
      complete: true,
    },
    entrypoints:
      target.platform === "win32"
        ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
        : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  const releaseMetadataBytes = options.nonCanonicalMetadata
    ? Buffer.from(JSON.stringify(releaseMetadata), "utf8")
    : canonicalJson(releaseMetadata);
  const payloadFiles = new Map<string, Buffer>([
    [evidencePath, evidenceBytes],
    ["docs/release/acceptance-evidence.json", ledgerBytes],
    ["native-components.json", nativeComponentsBytes],
    ["platform-authenticity.json", platformAuthenticityBytes],
    ["release-metadata.json", releaseMetadataBytes],
    [
      "smoke-evidence.json",
      canonicalJson(createSmokeEvidence(target, releaseMetadata.buildId, productVersion)),
    ],
  ]);
  for (const [path, bytes] of componentBytes) {
    payloadFiles.set(path, bytes);
  }
  for (const [path, bytes] of thirdPartyBytes) {
    if (options.omitRuntimePayload !== true || path !== runtimePath) {
      payloadFiles.set(path, bytes);
    }
  }
  if (options.addUndeclaredNativePayload === true) {
    payloadFiles.set(
      "vendor/undeclared.node",
      nativeFixtureBinary(target.platform, "undeclared-native"),
    );
  }
  if (options.addUnknownNativeSuffixPayload === true) {
    payloadFiles.set(
      "vendor/not-a-native-library.node",
      Buffer.from("not actually native\n", "utf8"),
    );
  }
  for (const entrypoint of releaseMetadata.entrypoints) {
    payloadFiles.set(entrypoint, Buffer.from(`launcher:${entrypoint}\n`, "utf8"));
  }
  const payloadEntries = [...payloadFiles]
    .map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const payloadManifestBytes = canonicalJson({
    schemaVersion: 1,
    excludedSelfReferences: ["SHA256SUMS", "payload-manifest.json"],
    fileCount: payloadEntries.length,
    totalBytes: payloadEntries.reduce((sum, entry) => sum + entry.size, 0),
    files: payloadEntries,
  });
  const checksumEntries = [
    ...payloadEntries,
    {
      path: "payload-manifest.json",
      size: payloadManifestBytes.byteLength,
      sha256: sha256(payloadManifestBytes),
    },
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
  const checksumManifestBytes = Buffer.from(
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""),
    "utf8",
  );
  payloadFiles.set("payload-manifest.json", payloadManifestBytes);
  payloadFiles.set("SHA256SUMS", checksumManifestBytes);
  for (const [path, bytes] of payloadFiles) {
    const destination = join(root, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
  }
  return {
    acceptanceLedgerSha256: sha256(ledgerBytes),
    checksumManifestSha256: sha256(checksumManifestBytes),
    nativeComponentsSha256: sha256(nativeComponentsBytes),
    payloadManifestSha256: sha256(payloadManifestBytes),
    platformAuthenticitySha256: sha256(platformAuthenticityBytes),
    releaseMetadataSha256: sha256(payloadFiles.get("release-metadata.json")!),
    root,
  };
}

interface CandidateFixtureOptions {
  readonly addThirdPartyComponent?: boolean;
  readonly addUndeclaredNativePayload?: boolean;
  readonly addUnknownNativeSuffixPayload?: boolean;
  readonly auditedSourceCommit?: string;
  readonly buildCommit?: string;
  readonly candidateAttestationId?: string;
  readonly collideRuntimeIdentity?: boolean;
  readonly corruptMetadataLedgerBinding?: boolean;
  readonly corruptRuntimeInputDigest?: boolean;
  readonly corruptThirdPartyDigest?: boolean;
  readonly corruptThirdPartyVerification?: boolean;
  readonly nonCanonicalMetadata?: boolean;
  readonly omitRuntimePayload?: boolean;
  readonly omitThirdPartyComponent?: boolean;
  readonly productVersion?: string;
  readonly supportStatus?:
    "internal-preview-blocked" | "internal-preview-complete" | "release-candidate";
}

function createSmokeEvidence(
  target: Readonly<{ platform: string; architecture: string }>,
  buildId: string,
  productVersion: string,
): object {
  return {
    schemaVersion: 1,
    platform: target.platform,
    architecture: target.architecture,
    bundledNodeVersion: "24.18.0",
    buildId,
    productVersion,
    checks: {
      cliHelp: "passed",
      backupCliHelp: "passed",
      serviceCliHelp: "passed",
      workerCliHelp: "passed",
      workerCliVersion: "passed",
      workerUnenrolledStatus: "passed",
      cleanHomeInitialization: "passed",
      mainHealth: "passed",
      adminStaticApp: "passed",
      loopbackOwnerClaim: "passed",
      ownerLogin: "passed",
      ownerSessionCookieContract: "passed",
      ownerSessionRoundTrip: "passed",
      recoveryCredentialsIssued: 10,
      cleanShutdown: {
        status: "passed",
        markerObserved: true,
        naturalExit: true,
        exitCode: 0,
        signal: null,
        shutdownTimedOut: false,
        forcedTermination: false,
      },
    },
  };
}

function expectedComponents(
  platform: "darwin" | "linux" | "win32",
): readonly { readonly kind: string; readonly path: string }[] {
  if (platform === "darwin") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
      { kind: "computer-use-helper", path: "libexec/opendelegate-macos-computer-use" },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-macos-computer-use-fixture",
      },
      { kind: "secret-store-helper", path: "runtime/native/opendelegate-keychain-helper" },
    ];
  }
  if (platform === "win32") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host.exe" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper.exe" },
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-windows-computer-use-helper.exe",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-windows-computer-use-fixture.exe",
      },
    ];
  }
  return [
    { kind: "core-service-host", path: "bin/opendelegate-service-host" },
    { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
    { kind: "computer-use-helper", path: "libexec/opendelegate-linux-computer-use" },
    {
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-linux-computer-use-fixture",
    },
  ];
}

function nativeFixtureBinary(platform: "darwin" | "linux" | "win32", label: string): Buffer {
  const body = Buffer.from(`fixture:${label}\n`, "utf8");
  if (platform === "linux") {
    return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), body]);
  }
  if (platform === "darwin") {
    return Buffer.concat([Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), body]);
  }
  const header = Buffer.alloc(0x80);
  header[0] = 0x4d;
  header[1] = 0x5a;
  header.writeUInt32LE(0x40, 0x3c);
  header[0x40] = 0x50;
  header[0x41] = 0x45;
  return Buffer.concat([header, body]);
}

function fakeFileIdentity(input: {
  readonly dev?: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}) {
  return {
    ctimeNs: 2n,
    dev: input.dev ?? 1n,
    ino: input.ino,
    mode: BigInt(0o100_644),
    mtimeNs: 1n,
    nlink: 1n,
    size: input.size,
    isFile() {
      return true;
    },
    isSymbolicLink() {
      return false;
    },
  };
}

function createVerifiedReadBackObservations(
  releaseSet: VerifiedReleaseSet,
  input: {
    readonly observer?: ReturnType<typeof generateKeyPairSync>;
    readonly uploader?: ReturnType<typeof generateKeyPairSync>;
  } = {},
) {
  const observer = input.observer ?? generateKeyPairSync("ed25519");
  const uploader = input.uploader ?? generateKeyPairSync("ed25519");
  const observerAuthorityKeyId = `sha256:${sha256(
    observer.publicKey.export({ format: "der", type: "spki" }),
  )}`;
  const uploaderAuthorityKeyId = `sha256:${sha256(
    uploader.publicKey.export({ format: "der", type: "spki" }),
  )}`;
  const composition = promotionCompositionInput(releaseSet);
  const envelopes = releaseSet.releases.map((release) => {
    const targetKey = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
    const composed = composeRemoteReadBackObservationStatement({
      archive: release.archive,
      channel: composition.channel,
      immutableObjectId: `fixture/releases/${composition.releaseId}/${release.archive.path}`,
      immutableObjectVersion: `fixture-version-${targetKey}`,
      observedAt: "2026-07-26T02:30:00.000Z",
      observedStreamSha256: release.archive.sha256,
      observerAuthorityKeyId,
      provider: "fixture-channel",
      releaseId: composition.releaseId,
      tag: `v${release.candidate.productVersion}`,
      target: release.candidate.target,
      uploaderAuthorityKeyId,
    });
    const signature = createSignature(null, composed.signingBytes, observer.privateKey).toString(
      "base64url",
    );
    return composeSignedReleaseEnvelope({
      composed,
      keyId: observerAuthorityKeyId,
      signature,
    });
  });
  return Object.freeze({
    envelopes: Object.freeze(envelopes),
    observer,
    observerAuthorityKeyId,
    uploader,
    uploaderAuthorityKeyId,
    verified: Object.freeze(
      envelopes.map((envelope) =>
        verifyRemoteReadBackObservation({
          envelopeBytes: envelope.canonicalBytes,
          expectedUploaderAuthorityKeyId: uploaderAuthorityKeyId,
          observerTrust: {
            publicKeyPem: Buffer.from(observer.publicKey.export({ format: "pem", type: "spki" })),
          },
        }),
      ),
    ),
  });
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
