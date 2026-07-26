import assert from "node:assert/strict";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

import {
  invokePinnedReleaseSigner,
  parseReleaseSignerBrokerAuthorizationRequest,
  releaseSignerBrokerProtocol,
  validateReleaseSigningStatement,
} from "../external-release-signer.mjs";
import { credentialAuthorizationDigest } from "../release-credential-authorization.mjs";
import {
  createCredentialAuthorization,
  createPublisherSigningBytes,
  createReleaseSignerBrokerFixture,
  keyIdFor,
  sha256,
} from "./support/release-signer-broker-fixture.mjs";

test("an authenticated broker uses a same-session one-shot capability before signing", async (t) => {
  const fixture = await createReleaseSignerBrokerFixture(t);
  const signingBytes = createPublisherSigningBytes("happy");
  const authorization = createCredentialAuthorization(signingBytes);
  fixture.approve(authorization);
  let beforeSignCalls = 0;
  process.env["OPENDELEGATE_TEST_SIGNER_SECRET"] = "must-not-cross-the-broker-protocol";
  t.after(() => delete process.env["OPENDELEGATE_TEST_SIGNER_SECRET"]);

  const result = await invokePinnedReleaseSigner(
    validSignerInput(fixture, signingBytes, authorization, async () => {
      beforeSignCalls += 1;
      return authorization;
    }),
  );

  assert.equal(beforeSignCalls, 1);
  assert.equal(fixture.metrics.capabilitiesIssued, 1);
  assert.equal(fixture.metrics.capabilitiesConsumed, 1);
  assert.equal(fixture.metrics.releaseKeyUseCount, 1);
  assert.equal(result.algorithm, "ed25519");
  assert.equal(result.keyId, fixture.releaseKeyId);
  assert.deepEqual(result.broker, {
    endpointSha256: fixture.endpointSha256,
    protocol: releaseSignerBrokerProtocol,
    transportKeyId: fixture.transportKeyId,
  });
  assert.equal(
    verifySignature(
      null,
      signingBytes,
      fixture.releasePublicKeyPem,
      Buffer.from(result.signature, "base64url"),
    ),
    true,
  );
  const authorizationRequest = fixture.authorizationRequests[0];
  const signRequest = fixture.signRequests[0];
  assert.equal(
    authorizationRequest.authorizationSha256,
    credentialAuthorizationDigest(authorization),
  );
  assert.equal(authorizationRequest.endpointSha256, fixture.endpointSha256);
  assert.equal(signRequest.capabilityId.length, 43);
  assert.equal(signRequest.brokerNonce.length, 43);
  assert.equal(signRequest.inputSha256, sha256(signingBytes));
  assert.equal(signRequest.signingBytes, signingBytes.toString("base64url"));
  assert.equal(
    JSON.stringify(authorizationRequest).includes("OPENDELEGATE_TEST_SIGNER_SECRET"),
    false,
  );
  assert.equal(JSON.stringify(result).includes(fixture.endpoint), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.broker), true);
});

test("post-capability revalidation failure closes the session before release-key use", async (t) => {
  const fixture = await createReleaseSignerBrokerFixture(t);
  const signingBytes = createPublisherSigningBytes("revalidation");
  const authorization = createCredentialAuthorization(signingBytes);
  fixture.approve(authorization);

  await assert.rejects(
    invokePinnedReleaseSigner(
      validSignerInput(fixture, signingBytes, authorization, async () => {
        throw new Error("runner snapshot changed");
      }),
    ),
    /runner snapshot changed/u,
  );
  assert.equal(fixture.metrics.capabilitiesIssued, 1);
  assert.equal(fixture.metrics.capabilitiesConsumed, 0);
  assert.equal(fixture.metrics.releaseKeyUseCount, 0);
  assert.equal(fixture.signRequests.length, 0);

  const changed = createCredentialAuthorization(signingBytes, {
    snapshotSha256: "9".repeat(64),
  });
  const second = await createReleaseSignerBrokerFixture(t);
  const secondAuthorization = createCredentialAuthorization(signingBytes);
  second.approve(secondAuthorization);
  await assert.rejects(
    invokePinnedReleaseSigner(
      validSignerInput(second, signingBytes, secondAuthorization, async () => changed),
    ),
    /changed or expired/u,
  );
  assert.equal(second.metrics.releaseKeyUseCount, 0);
});

test("unapproved, replayed, direct-sign, and cross-session requests never reach the release key", async (t) => {
  const fixture = await createReleaseSignerBrokerFixture(t);
  const signingBytes = createPublisherSigningBytes("approval");
  const unapproved = createCredentialAuthorization(signingBytes);
  let beforeSignCalls = 0;
  await assert.rejects(
    invokePinnedReleaseSigner(
      validSignerInput(fixture, signingBytes, unapproved, async () => {
        beforeSignCalls += 1;
        return unapproved;
      }),
    ),
    /closed before returning|connection failed/u,
  );
  assert.equal(beforeSignCalls, 0);
  assert.equal(fixture.metrics.releaseKeyUseCount, 0);

  const approved = createCredentialAuthorization(signingBytes);
  fixture.approve(approved);
  await invokePinnedReleaseSigner(validSignerInput(fixture, signingBytes, approved));
  const keyUsesAfterSuccess = fixture.metrics.releaseKeyUseCount;
  const capturedAuthorization = canonicalLine(fixture.authorizationRequests.at(-1));
  const capturedSign = canonicalLine(fixture.signRequests.at(-1));

  await sendRawLines(fixture.endpoint, [capturedAuthorization]);
  await sendRawLines(fixture.endpoint, [capturedSign]);
  assert.equal(fixture.metrics.releaseKeyUseCount, keyUsesAfterSuccess);
  assert.ok(fixture.errors.length >= 2);
});

test("endpoint substitution and transcript replay fail before release-key use", async (t) => {
  const releaseKeys = generateKeyPairSync("ed25519");
  const trustedTransport = generateKeyPairSync("ed25519");
  const impostor = await createReleaseSignerBrokerFixture(t, {
    advertisedTransportKeyId: keyIdFor(trustedTransport.publicKey),
    releaseKeys,
    transportKeys: generateKeyPairSync("ed25519"),
  });
  const signingBytes = createPublisherSigningBytes("substitution");
  const authorization = createCredentialAuthorization(signingBytes);
  impostor.approve(authorization);

  await assert.rejects(
    invokePinnedReleaseSigner({
      ...validSignerInput(impostor, signingBytes, authorization),
      transportPublicKeyPem: Buffer.from(
        trustedTransport.publicKey.export({ format: "pem", type: "spki" }),
      ),
    }),
    /does not authenticate to the pinned transport authority/u,
  );
  assert.equal(impostor.metrics.releaseKeyUseCount, 0);

  const trusted = await createReleaseSignerBrokerFixture(t);
  const firstAuthorization = createCredentialAuthorization(signingBytes);
  trusted.approve(firstAuthorization);
  await invokePinnedReleaseSigner(validSignerInput(trusted, signingBytes, firstAuthorization));
  trusted.behavior.replayAuthorizationResponse = Buffer.from(trusted.authorizationResponses.at(-1));
  const secondAuthorization = createCredentialAuthorization(signingBytes);
  trusted.approve(secondAuthorization);
  const keyUsesBeforeReplay = trusted.metrics.releaseKeyUseCount;
  await assert.rejects(
    invokePinnedReleaseSigner(validSignerInput(trusted, signingBytes, secondAuthorization)),
    /does not match request field requestId/u,
  );
  assert.equal(trusted.metrics.releaseKeyUseCount, keyUsesBeforeReplay);
});

test("the broker parser requires an independently approved authorization tuple and exact endpoint", async (t) => {
  const fixture = await createReleaseSignerBrokerFixture(t);
  const signingBytes = createPublisherSigningBytes("parser");
  const authorization = createCredentialAuthorization(signingBytes);
  const approval = fixture.approve(authorization);
  await invokePinnedReleaseSigner(validSignerInput(fixture, signingBytes, authorization));
  const requestBytes = canonicalLine(fixture.authorizationRequests[0]);
  const expected = {
    approvedInputSha256: approval.inputSha256,
    approvedSnapshotSha256: approval.snapshotSha256,
    domain: fixture.domain,
    endpointSha256: fixture.endpointSha256,
    policySha256: fixture.policySha256,
    releaseKeyId: fixture.releaseKeyId,
    role: fixture.role,
    transportKeyId: fixture.transportKeyId,
  };

  assert.doesNotThrow(() => parseReleaseSignerBrokerAuthorizationRequest(requestBytes, expected));
  assert.throws(
    () =>
      parseReleaseSignerBrokerAuthorizationRequest(requestBytes, {
        ...expected,
        approvedSnapshotSha256: "0".repeat(64),
      }),
    /snapshot is not independently approved/u,
  );
  assert.throws(
    () =>
      parseReleaseSignerBrokerAuthorizationRequest(requestBytes, {
        ...expected,
        approvedInputSha256: "0".repeat(64),
      }),
    /invalid or unauthorized/u,
  );
  assert.throws(
    () =>
      parseReleaseSignerBrokerAuthorizationRequest(requestBytes, {
        ...expected,
        endpointSha256: "0".repeat(64),
      }),
    /invalid or unauthorized/u,
  );
});

test("generic, malformed, expired, oversized, and remote inputs fail before broker contact", async (t) => {
  const fixture = await createReleaseSignerBrokerFixture(t);
  const signingBytes = createPublisherSigningBytes("strict");
  const authorization = createCredentialAuthorization(signingBytes);
  const valid = validSignerInput(fixture, signingBytes, authorization);

  await assert.rejects(
    invokePinnedReleaseSigner({ ...valid, executable: { path: process.execPath } }),
    /release signer input fields do not match the strict schema/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({ ...valid, beforeSign: undefined }),
    /post-capability revalidation callback/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      domain: "generic-arbitrary-bytes",
      authorization: { ...authorization, domain: "generic-arbitrary-bytes" },
    }),
    /signing domain is not authorized/u,
  );
  const arbitrary = Buffer.from("arbitrary bytes under an otherwise allowed domain", "utf8");
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: createCredentialAuthorization(arbitrary),
      signingBytes: arbitrary,
    }),
    /do not match the authorized statement domain/u,
  );
  const malformedStatement = JSON.parse(
    signingBytes
      .subarray(Buffer.byteLength("OpenDelegate publisher attestation v2\n"))
      .toString("utf8"),
  );
  delete malformedStatement.archive;
  const malformedBytes = Buffer.from(
    `OpenDelegate publisher attestation v2\n${JSON.stringify(malformedStatement, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: createCredentialAuthorization(malformedBytes),
      signingBytes: malformedBytes,
    }),
    /strict schema/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: { ...authorization, inputSha256: "0".repeat(64) },
    }),
    /authorization does not match/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: {
        ...authorization,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    }),
    /authorization is expired/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      signingBytes: Buffer.alloc(4 * 1024 * 1024 + 1),
    }),
    /signing input is empty or oversized/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      endpoint: process.platform === "win32" ? "\\\\server\\pipe\\remote" : "relative.sock",
    }),
    /local Windows named pipe|absolute Unix socket/u,
  );
  const sameAuthority = generateKeyPairSync("ed25519");
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      publicKeyPem: Buffer.from(sameAuthority.publicKey.export({ format: "pem", type: "spki" })),
      transportPublicKeyPem: Buffer.from(
        sameAuthority.publicKey.export({ format: "pem", type: "spki" }),
      ),
    }),
    /authorities must be distinct/u,
  );
  assert.equal(fixture.authorizationRequests.length, 0);
  assert.equal(fixture.metrics.releaseKeyUseCount, 0);
});

test("capability lifetime, canonical output, output bounds, and timeout fail closed", async (t) => {
  const signingBytes = createPublisherSigningBytes("bounds");

  const longLived = await createReleaseSignerBrokerFixture(t);
  const longAuthorization = createCredentialAuthorization(signingBytes);
  longLived.approve(longAuthorization);
  longLived.behavior.authorizationResponseMutator = (value) => ({
    ...value,
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  });
  await assert.rejects(
    invokePinnedReleaseSigner(validSignerInput(longLived, signingBytes, longAuthorization)),
    /invalid one-shot capability lifetime/u,
  );
  assert.equal(longLived.metrics.releaseKeyUseCount, 0);

  const reordered = await createReleaseSignerBrokerFixture(t);
  const reorderedAuthorization = createCredentialAuthorization(signingBytes);
  reordered.approve(reorderedAuthorization);
  reordered.behavior.reorderAuthorizationResponse = true;
  await assert.rejects(
    invokePinnedReleaseSigner(validSignerInput(reordered, signingBytes, reorderedAuthorization)),
    /canonical order|not canonical JSON/u,
  );
  assert.equal(reordered.metrics.releaseKeyUseCount, 0);

  const oversized = await createReleaseSignerBrokerFixture(t);
  const oversizedAuthorization = createCredentialAuthorization(signingBytes);
  oversized.approve(oversizedAuthorization);
  oversized.behavior.oversizedAt = "authorize";
  await assert.rejects(
    invokePinnedReleaseSigner(validSignerInput(oversized, signingBytes, oversizedAuthorization)),
    /emitted oversized output/u,
  );
  assert.equal(oversized.metrics.releaseKeyUseCount, 0);

  const hanging = await createReleaseSignerBrokerFixture(t);
  const hangingAuthorization = createCredentialAuthorization(signingBytes);
  hanging.approve(hangingAuthorization);
  hanging.behavior.hangAt = "authorize";
  const startedAt = Date.now();
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...validSignerInput(hanging, signingBytes, hangingAuthorization),
      timeoutMs: 100,
    }),
    /exceeded its bounded timeout/u,
  );
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(hanging.metrics.releaseKeyUseCount, 0);
});

test("the statement parser rejects malformed nested publisher bindings", () => {
  const signingBytes = createPublisherSigningBytes("grammar");
  assert.doesNotThrow(() =>
    validateReleaseSigningStatement(signingBytes, "publisher-attestation-v2"),
  );
  const prefix = "OpenDelegate publisher attestation v2\n";
  const statement = JSON.parse(signingBytes.subarray(Buffer.byteLength(prefix)).toString("utf8"));
  statement.candidate.target = { platform: "linux", architecture: "arm64" };
  const malformed = Buffer.from(`${prefix}${JSON.stringify(statement, null, 2)}\n`, "utf8");
  assert.throws(
    () => validateReleaseSigningStatement(malformed, "publisher-attestation-v2"),
    /candidate binding target is outside/u,
  );
  const oversizedArchive = parseSigningStatement(signingBytes, prefix);
  oversizedArchive.archive.size = 512 * 1024 * 1024 + 1;
  assert.throws(
    () =>
      validateReleaseSigningStatement(
        statementSigningBytes(prefix, oversizedArchive),
        "publisher-attestation-v2",
      ),
    /publisher archive is invalid/u,
  );
});

test("the statement parser enforces exact nested promotion and receipt grammar", () => {
  const promotionBytes = promotionSigningBytes();
  assert.doesNotThrow(() =>
    validateReleaseSigningStatement(promotionBytes, "promotion-authorization-v1"),
  );
  const noMillisecondsPromotion = parseSigningStatement(
    promotionBytes,
    "OpenDelegate promotion authorization v1\n",
  );
  noMillisecondsPromotion.issuedAt = "2026-07-25T00:00:00Z";
  assert.doesNotThrow(() =>
    validateReleaseSigningStatement(
      statementSigningBytes("OpenDelegate promotion authorization v1\n", noMillisecondsPromotion),
      "promotion-authorization-v1",
    ),
  );
  const malformedPromotion = parseSigningStatement(
    promotionBytes,
    "OpenDelegate promotion authorization v1\n",
  );
  malformedPromotion.targets[1].platformAuthenticity.verificationEvidence[0].unexpected = true;
  assert.throws(
    () =>
      validateReleaseSigningStatement(
        statementSigningBytes("OpenDelegate promotion authorization v1\n", malformedPromotion),
        "promotion-authorization-v1",
      ),
    /strict schema/u,
  );

  const receiptBytes = receiptSigningBytes();
  assert.doesNotThrow(() =>
    validateReleaseSigningStatement(receiptBytes, "supported-channel-receipt-v2"),
  );
  const noMillisecondsReceipt = parseSigningStatement(
    receiptBytes,
    "OpenDelegate supported channel receipt v2\n",
  );
  noMillisecondsReceipt.observedAt = "2026-07-25T00:02:00Z";
  for (const asset of noMillisecondsReceipt.publishedAssets) {
    asset.observedAt = "2026-07-25T00:01:00Z";
  }
  assert.doesNotThrow(() =>
    validateReleaseSigningStatement(
      statementSigningBytes("OpenDelegate supported channel receipt v2\n", noMillisecondsReceipt),
      "supported-channel-receipt-v2",
    ),
  );
  const malformedReceipt = parseSigningStatement(
    receiptBytes,
    "OpenDelegate supported channel receipt v2\n",
  );
  malformedReceipt.publishedAssets[2].source = malformedReceipt.publishedAssets[1].source;
  assert.throws(
    () =>
      validateReleaseSigningStatement(
        statementSigningBytes("OpenDelegate supported channel receipt v2\n", malformedReceipt),
        "supported-channel-receipt-v2",
      ),
    /sources are duplicated/u,
  );
});

function validSignerInput(
  fixture,
  signingBytes,
  authorization,
  beforeSign = async () => authorization,
) {
  return {
    authorization,
    beforeSign,
    domain: fixture.domain,
    endpoint: fixture.endpoint,
    policySha256: fixture.policySha256,
    publicKeyPem: fixture.releasePublicKeyPem,
    role: fixture.role,
    signingBytes,
    transportPublicKeyPem: fixture.transportPublicKeyPem,
  };
}

async function sendRawLines(endpoint, lines) {
  await new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    socket.once("error", (error) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE" || error.code === "ENOENT") {
        resolvePromise();
      } else {
        reject(error);
      }
    });
    socket.once("close", resolvePromise);
    socket.once("connect", () => {
      for (const line of lines) {
        socket.write(line);
      }
      socket.end();
    });
  });
}

function canonicalLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function promotionSigningBytes() {
  const hash = "d".repeat(64);
  const targets = [
    {
      target: { platform: "darwin", architecture: "arm64" },
      certificateIdentities: ["apple-team:ABCDEFGHIJ", "apple-team:KLMNOPQRST"],
      productCertificateIdentity: "apple-team:ABCDEFGHIJ",
    },
    {
      target: { platform: "linux", architecture: "x64" },
      certificateIdentities: [],
      productCertificateIdentity: null,
    },
    {
      target: { platform: "win32", architecture: "x64" },
      certificateIdentities: [
        `authenticode-sha1:${"A".repeat(40)}`,
        `authenticode-sha1:${"B".repeat(40)}`,
      ],
      productCertificateIdentity: `authenticode-sha1:${"A".repeat(40)}`,
    },
  ].map(({ target, certificateIdentities, productCertificateIdentity }, index) => {
    const platformAuthenticitySha256 = `${index + 1}`.repeat(64);
    return {
      target,
      archive: {
        path: `opendelegate-${target.platform}.tar.gz`,
        size: 128 + index,
        sha256: hash,
      },
      candidate: {
        publisherCandidateStatementSha256: hash,
        target,
        productVersion: "0.1.0-alpha.1",
        buildCommit: "1".repeat(40),
        auditedSourceCommit: "2".repeat(40),
        acceptanceLedgerSha256: hash,
        candidateAttestationId: "candidate/release-0001",
        checksumManifestSha256: hash,
        payloadManifestSha256: hash,
        releaseMetadataSha256: hash,
        nativeComponentsSha256: hash,
        platformAuthenticitySha256,
      },
      publisher: {
        keyId: `sha256:${`${index + 3}`.repeat(64)}`,
        attestationSha256: hash,
      },
      platformAuthenticity: {
        recordSha256: platformAuthenticitySha256,
        certificateIdentities,
        productCertificateIdentity,
        verificationEvidence: [
          {
            path: `evidence/platform/${target.platform}.json`,
            sha256: hash,
          },
        ],
      },
      notarization:
        target.platform === "darwin"
          ? {
              receipt: {
                path: "evidence/notarization/macos.json",
                sha256: hash,
              },
              submissionId: "submission/macos-0001",
              status: "accepted",
              teamId: "ABCDEFGHIJ",
              resultId: "result/macos-0001",
              logId: "notary-log/macos-0001",
            }
          : null,
    };
  });
  const statement = {
    schemaVersion: 1,
    product: "OpenDelegate",
    role: "promotion",
    domain: "opendelegate.release.promotion-authorization.v1",
    releaseId: "release/0.1.0-alpha.1",
    productVersion: "0.1.0-alpha.1",
    channel: "stable",
    issuedAt: "2026-07-25T00:00:00.000Z",
    statementId: "statement/promotion-0001",
    publicationPolicy: "immutable-assets-with-remote-digest-readback",
    auditedSourceCommit: "2".repeat(40),
    buildCommit: "1".repeat(40),
    acceptanceLedger: {
      schemaVersion: 1,
      sha256: hash,
      candidateAttestationId: "candidate/release-0001",
    },
    supportMatrix: {
      path: "docs/release/SUPPORT_MATRIX.md",
      sha256: hash,
    },
    targets,
    liveEvidence: Array.from({ length: 36 }, (_, index) => ({
      criterionId: index + 1,
      path: `evidence/live/criterion-${String(index + 1).padStart(2, "0")}.json`,
      sha256: hash,
    })),
  };
  return statementSigningBytes("OpenDelegate promotion authorization v1\n", statement);
}

function receiptSigningBytes() {
  const hash = "e".repeat(64);
  const observerAuthorityKeyId = `sha256:${"a".repeat(64)}`;
  const uploaderAuthorityKeyId = `sha256:${"b".repeat(64)}`;
  const targets = [
    { platform: "darwin", architecture: "arm64" },
    { platform: "linux", architecture: "x64" },
    { platform: "win32", architecture: "x64" },
  ];
  const statement = {
    schemaVersion: 2,
    product: "OpenDelegate",
    role: "promotion",
    domain: "opendelegate.release.supported-channel-receipt.v2",
    receiptId: "receipt/release-0001",
    releaseId: "release/0.1.0-alpha.1",
    channel: "stable",
    tag: "v0.1.0-alpha.1",
    promotionAttestationSha256: hash,
    uploaderAuthorityKeyId,
    publishedAssets: targets.map((target) => ({
      target,
      path: `opendelegate-${target.platform}.tar.gz`,
      size: 256,
      sha256: hash,
      source: {
        provider: "github-release",
        immutableObjectId: `object/${target.platform}-0001`,
        immutableObjectVersion: `version/${target.platform}-0001`,
      },
      observedStreamSha256: hash,
      observerAuthorityKeyId,
      observedAt: "2026-07-25T00:01:00.000Z",
      evidenceEnvelope: {
        domain: "opendelegate.release.remote-read-back-observation.v1",
        sha256: hash,
        signature: "A".repeat(86),
      },
    })),
    observedAt: "2026-07-25T00:02:00.000Z",
  };
  return statementSigningBytes("OpenDelegate supported channel receipt v2\n", statement);
}

function parseSigningStatement(bytes, prefix) {
  return JSON.parse(bytes.subarray(Buffer.byteLength(prefix)).toString("utf8"));
}

function statementSigningBytes(prefix, statement) {
  return Buffer.from(`${prefix}${JSON.stringify(statement, null, 2)}\n`, "utf8");
}
