import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify as verifySignature,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  invokePinnedReleaseSigner,
  releaseSignerBrokerProtocol,
  releaseSignerBrokerTransportResponseDomain,
  validateReleaseSigningStatement,
} from "../external-release-signer.mjs";
import { credentialAuthorizationDigest } from "../release-credential-authorization.mjs";

const role = "publisher";
const domain = "publisher-attestation-v2";
const policySha256 = "a".repeat(64);

test("an authenticated local broker signs one authorized release statement", async (t) => {
  const fixture = await createBrokerFixture(t);
  const signingBytes = publisherSigningBytes("fixture");
  const authorization = credentialAuthorization(signingBytes);
  process.env["OPENDELEGATE_TEST_SIGNER_SECRET"] = "must-not-cross-the-broker-protocol";
  t.after(() => delete process.env["OPENDELEGATE_TEST_SIGNER_SECRET"]);

  const result = await invokePinnedReleaseSigner({
    authorization,
    domain,
    endpoint: fixture.endpoint,
    policySha256,
    publicKeyPem: fixture.releasePublicKeyPem,
    role,
    signingBytes,
    transportPublicKeyPem: fixture.transportPublicKeyPem,
  });

  assert.equal(result.algorithm, "ed25519");
  assert.equal(result.keyId, fixture.releaseKeyId);
  assert.equal(result.broker.protocol, releaseSignerBrokerProtocol);
  assert.equal(result.broker.transportKeyId, fixture.transportKeyId);
  assert.equal(result.broker.endpointSha256, sha256(Buffer.from(fixture.endpoint, "utf8")));
  assert.equal(
    verifySignature(
      null,
      signingBytes,
      fixture.releasePublicKeyPem,
      Buffer.from(result.signature, "base64url"),
    ),
    true,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.broker), true);

  const request = fixture.requests.at(-1);
  assert.equal(request.protocol, releaseSignerBrokerProtocol);
  assert.equal(request.role, role);
  assert.equal(request.domain, domain);
  assert.equal(request.releaseKeyId, fixture.releaseKeyId);
  assert.equal(request.transportKeyId, fixture.transportKeyId);
  assert.equal(request.endpointSha256, sha256(Buffer.from(fixture.endpoint, "utf8")));
  assert.equal(request.inputSha256, sha256(signingBytes));
  assert.equal(request.signingBytes, signingBytes.toString("base64url"));
  assert.deepEqual(request.authorization, authorization);
  assert.equal(request.authorizationSha256, credentialAuthorizationDigest(authorization));
  assert.equal(JSON.stringify(request).includes("OPENDELEGATE_TEST_SIGNER_SECRET"), false);
  assert.equal(JSON.stringify(result).includes(fixture.endpoint), false);
});

test("endpoint substitution fails even when the impostor has the release key", async (t) => {
  const releaseKeys = generateKeyPairSync("ed25519");
  const trustedTransportKeys = generateKeyPairSync("ed25519");
  const trustedTransportKeyId = keyId(trustedTransportKeys.publicKey);
  const impostor = await createBrokerFixture(t, {
    advertisedTransportKeyId: trustedTransportKeyId,
    releaseKeys,
    transportKeys: generateKeyPairSync("ed25519"),
  });
  const signingBytes = publisherSigningBytes("substitution");

  await assert.rejects(
    invokePinnedReleaseSigner({
      authorization: credentialAuthorization(signingBytes),
      domain,
      endpoint: impostor.endpoint,
      policySha256,
      publicKeyPem: Buffer.from(releaseKeys.publicKey.export({ format: "pem", type: "spki" })),
      role,
      signingBytes,
      transportPublicKeyPem: Buffer.from(
        trustedTransportKeys.publicKey.export({
          format: "pem",
          type: "spki",
        }),
      ),
    }),
    /does not authenticate to the pinned transport authority/u,
  );
});

test("a broker response cannot be replayed across request IDs or nonces", async (t) => {
  const fixture = await createBrokerFixture(t);
  const signingBytes = publisherSigningBytes("replay");
  await invokePinnedReleaseSigner({
    authorization: credentialAuthorization(signingBytes),
    domain,
    endpoint: fixture.endpoint,
    policySha256,
    publicKeyPem: fixture.releasePublicKeyPem,
    role,
    signingBytes,
    transportPublicKeyPem: fixture.transportPublicKeyPem,
  });
  fixture.behavior.replayResponse = Buffer.from(fixture.responses.at(-1));

  await assert.rejects(
    invokePinnedReleaseSigner({
      authorization: credentialAuthorization(signingBytes),
      domain,
      endpoint: fixture.endpoint,
      policySha256,
      publicKeyPem: fixture.releasePublicKeyPem,
      role,
      signingBytes,
      transportPublicKeyPem: fixture.transportPublicKeyPem,
    }),
    /does not match request field requestId/u,
  );
});

test("the broker boundary rejects generic signing, malformed authority, and old helper fields", async (t) => {
  const fixture = await createBrokerFixture(t);
  const signingBytes = publisherSigningBytes("strict");
  const valid = {
    authorization: credentialAuthorization(signingBytes),
    domain,
    endpoint: fixture.endpoint,
    policySha256,
    publicKeyPem: fixture.releasePublicKeyPem,
    role,
    signingBytes,
    transportPublicKeyPem: fixture.transportPublicKeyPem,
  };

  await assert.rejects(
    invokePinnedReleaseSigner({ ...valid, executable: { path: process.execPath } }),
    /release signer input fields do not match the strict schema/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      domain: "generic-arbitrary-bytes",
      authorization: { ...valid.authorization, domain: "generic-arbitrary-bytes" },
    }),
    /signing domain is not authorized/u,
  );
  const arbitraryBytes = Buffer.from("arbitrary bytes under an otherwise allowed domain", "utf8");
  const requestsBeforeArbitraryInput = fixture.requests.length;
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: credentialAuthorization(arbitraryBytes),
      signingBytes: arbitraryBytes,
    }),
    /do not match the authorized statement domain/u,
  );
  assert.equal(fixture.requests.length, requestsBeforeArbitraryInput);
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: { ...valid.authorization, inputSha256: "0".repeat(64) },
    }),
    /authorization does not match/u,
  );
  await assert.rejects(
    invokePinnedReleaseSigner({
      ...valid,
      authorization: {
        ...valid.authorization,
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
});

test("the broker boundary enforces canonical output, output bounds, and timeout", async (t) => {
  const fixture = await createBrokerFixture(t);
  const signingBytes = publisherSigningBytes("bounded");
  const valid = {
    authorization: credentialAuthorization(signingBytes),
    domain,
    endpoint: fixture.endpoint,
    policySha256,
    publicKeyPem: fixture.releasePublicKeyPem,
    role,
    signingBytes,
    transportPublicKeyPem: fixture.transportPublicKeyPem,
  };

  fixture.behavior.reorderResponse = true;
  await assert.rejects(
    invokePinnedReleaseSigner(valid),
    /response fields do not match the canonical order|not canonical JSON/u,
  );
  fixture.behavior.reorderResponse = false;

  fixture.behavior.oversizedResponse = true;
  await assert.rejects(invokePinnedReleaseSigner(valid), /emitted oversized output/u);
  fixture.behavior.oversizedResponse = false;

  fixture.behavior.hang = true;
  const startedAt = Date.now();
  await assert.rejects(
    invokePinnedReleaseSigner({ ...valid, timeoutMs: 100 }),
    /exceeded its bounded timeout/u,
  );
  assert.ok(Date.now() - startedAt < 2_000);
});

async function createBrokerFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-signer-broker-"));
  const releaseKeys = options.releaseKeys ?? generateKeyPairSync("ed25519");
  const transportKeys = options.transportKeys ?? generateKeyPairSync("ed25519");
  const releasePublicKeyPem = Buffer.from(
    releaseKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  const transportPublicKeyPem = Buffer.from(
    transportKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  const releaseKeyId = keyId(releaseKeys.publicKey);
  const transportKeyId = options.advertisedTransportKeyId ?? keyId(transportKeys.publicKey);
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\opendelegate-signer-${randomUUID()}`
      : join(root, "broker.sock");
  const requests = [];
  const responses = [];
  const sockets = new Set();
  const behavior = {
    hang: false,
    oversizedResponse: false,
    reorderResponse: false,
    replayResponse: undefined,
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.byteLength > 6 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      if (behavior.hang) {
        return;
      }
      if (behavior.oversizedResponse) {
        socket.end(Buffer.alloc(64 * 1024 + 1, 0x61));
        return;
      }
      if (behavior.replayResponse !== undefined) {
        socket.end(behavior.replayResponse);
        return;
      }
      const requestBytes = input.subarray(0, newline + 1);
      const request = JSON.parse(requestBytes.toString("utf8"));
      const signingBytes = Buffer.from(request.signingBytes, "base64url");
      validateReleaseSigningStatement(signingBytes, request.domain);
      requests.push(request);
      const unsigned = {
        schemaVersion: 1,
        protocol: releaseSignerBrokerProtocol,
        type: "sign-response",
        requestId: request.requestId,
        clientNonce: request.clientNonce,
        brokerNonce: randomBytes(32).toString("base64url"),
        role: request.role,
        domain: request.domain,
        releaseKeyId,
        transportKeyId,
        inputSha256: request.inputSha256,
        releaseSignature: sign(null, signingBytes, releaseKeys.privateKey).toString("base64url"),
      };
      const transportSigningBytes = Buffer.concat([
        Buffer.from(releaseSignerBrokerTransportResponseDomain, "utf8"),
        Buffer.from(`${sha256(requestBytes)}\n`, "utf8"),
        Buffer.from(`${JSON.stringify(unsigned)}\n`, "utf8"),
      ]);
      const transportSignature = sign(
        null,
        transportSigningBytes,
        transportKeys.privateKey,
      ).toString("base64url");
      const response = behavior.reorderResponse
        ? {
            schemaVersion: unsigned.schemaVersion,
            protocol: unsigned.protocol,
            type: unsigned.type,
            requestId: unsigned.requestId,
            clientNonce: unsigned.clientNonce,
            brokerNonce: unsigned.brokerNonce,
            role: unsigned.role,
            domain: unsigned.domain,
            releaseKeyId: unsigned.releaseKeyId,
            transportKeyId: unsigned.transportKeyId,
            inputSha256: unsigned.inputSha256,
            transportSignature,
            releaseSignature: unsigned.releaseSignature,
          }
        : { ...unsigned, transportSignature };
      const responseBytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
      responses.push(responseBytes);
      socket.end(responseBytes);
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolvePromise);
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(root, { force: true, recursive: true });
  });
  return {
    behavior,
    endpoint,
    releaseKeyId,
    releasePublicKeyPem,
    requests,
    responses,
    transportKeyId,
    transportPublicKeyPem,
  };
}

function credentialAuthorization(signingBytes) {
  const authorizedAt = new Date();
  return {
    authorizationId: randomBytes(32).toString("base64url"),
    role,
    domain,
    inputSha256: sha256(signingBytes),
    snapshotSha256: "b".repeat(64),
    authorizedAt: authorizedAt.toISOString(),
    expiresAt: new Date(authorizedAt.getTime() + 15_000).toISOString(),
  };
}

function publisherSigningBytes(candidate) {
  const statement = {
    schemaVersion: 2,
    product: "OpenDelegate",
    domain: "opendelegate.release.publisher-attestation.v2",
    candidate,
  };
  return Buffer.from(
    `OpenDelegate publisher attestation v2\n${JSON.stringify(statement, null, 2)}\n`,
    "utf8",
  );
}

function keyId(publicKey) {
  return `sha256:${sha256(publicKey.export({ format: "der", type: "spki" }))}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
