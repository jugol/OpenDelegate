import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createReleaseSignerBrokerAuthorizationResponseSigningBytes,
  createReleaseSignerBrokerSignResponseSigningBytes,
  parseReleaseSignerBrokerAuthorizationRequest,
  parseReleaseSignerBrokerSignRequest,
  releaseSignerBrokerProtocol,
} from "../../external-release-signer.mjs";
import { credentialAuthorizationDigest } from "../../release-credential-authorization.mjs";

const defaultPolicySha256 = "a".repeat(64);
const defaultRole = "publisher";
const defaultDomain = "publisher-attestation-v2";

export async function createReleaseSignerBrokerFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-signer-broker-"));
  const releaseKeys = options.releaseKeys ?? generateKeyPairSync("ed25519");
  const transportKeys = options.transportKeys ?? generateKeyPairSync("ed25519");
  const releasePublicKeyPem = Buffer.from(
    releaseKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  const transportPublicKeyPem = Buffer.from(
    transportKeys.publicKey.export({ format: "pem", type: "spki" }),
  );
  const releaseKeyId = keyIdFor(releaseKeys.publicKey);
  const actualTransportKeyId = keyIdFor(transportKeys.publicKey);
  const transportKeyId = options.advertisedTransportKeyId ?? actualTransportKeyId;
  const role = options.role ?? defaultRole;
  const domain = options.domain ?? defaultDomain;
  let policySha256 = options.policySha256 ?? defaultPolicySha256;
  const endpoint =
    options.endpoint ??
    (process.platform === "win32"
      ? `\\\\.\\pipe\\opendelegate-signer-${randomUUID()}`
      : join(root, "broker.sock"));
  const endpointSha256 = sha256(Buffer.from(endpoint, "utf8"));
  const approvals = new Map();
  const authorizationRequests = [];
  const authorizationResponses = [];
  const signRequests = [];
  const signResponses = [];
  const errors = [];
  const sockets = new Set();
  const behavior = {
    authorizationTtlMs: 10_000,
    authorizationResponseMutator: undefined,
    afterCapabilityIssued: undefined,
    hangAt: undefined,
    oversizedAt: undefined,
    reorderAuthorizationResponse: false,
    reorderSignResponse: false,
    replayAuthorizationResponse: undefined,
    replaySignResponse: undefined,
  };
  const metrics = {
    capabilitiesConsumed: 0,
    capabilitiesIssued: 0,
    releaseKeyUseCount: 0,
  };

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    let phase = "authorize";
    let pending;

    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > 6 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          return;
        }
        const line = Buffer.from(buffered.subarray(0, newline + 1));
        buffered = Buffer.from(buffered.subarray(newline + 1));
        if (behavior.hangAt === phase) {
          return;
        }
        if (behavior.oversizedAt === phase) {
          socket.end(Buffer.alloc(64 * 1024 + 1, 0x61));
          return;
        }
        try {
          if (phase === "authorize") {
            if (behavior.replayAuthorizationResponse !== undefined) {
              socket.write(behavior.replayAuthorizationResponse);
              phase = "done";
              continue;
            }
            const untrusted = JSON.parse(line.toString("utf8"));
            const approval = approvals.get(untrusted.authorizationSha256);
            if (approval === undefined) {
              throw new Error(
                "The engineering broker has no independent approval for this digest.",
              );
            }
            const authorizationRequest = parseReleaseSignerBrokerAuthorizationRequest(line, {
              approvedInputSha256: approval.inputSha256,
              approvedSnapshotSha256: approval.snapshotSha256,
              domain,
              endpointSha256,
              policySha256,
              releaseKeyId,
              role,
              transportKeyId,
            });
            approvals.delete(approval.authorizationSha256);
            const maximumExpiry = Math.min(
              Date.parse(authorizationRequest.authorization.expiresAt),
              Date.now() + behavior.authorizationTtlMs,
            );
            const unsignedBase = {
              schemaVersion: 1,
              protocol: releaseSignerBrokerProtocol,
              type: "authorize-response",
              requestId: authorizationRequest.requestId,
              clientNonce: authorizationRequest.clientNonce,
              brokerNonce: randomBytes(32).toString("base64url"),
              capabilityId: randomBytes(32).toString("base64url"),
              role,
              domain,
              releaseKeyId,
              transportKeyId,
              policySha256,
              endpointSha256,
              authorizationSha256: authorizationRequest.authorizationSha256,
              inputSha256: authorizationRequest.inputSha256,
              inputSize: authorizationRequest.inputSize,
              expiresAt: new Date(maximumExpiry).toISOString(),
            };
            const unsigned = behavior.authorizationResponseMutator?.(unsignedBase) ?? unsignedBase;
            const response = {
              ...unsigned,
              transportSignature: sign(
                null,
                createReleaseSignerBrokerAuthorizationResponseSigningBytes(line, unsigned),
                transportKeys.privateKey,
              ).toString("base64url"),
            };
            const responseBytes = behavior.reorderAuthorizationResponse
              ? Buffer.from(
                  `${JSON.stringify({
                    schemaVersion: unsigned.schemaVersion,
                    protocol: unsigned.protocol,
                    type: unsigned.type,
                    requestId: unsigned.requestId,
                    clientNonce: unsigned.clientNonce,
                    brokerNonce: unsigned.brokerNonce,
                    capabilityId: unsigned.capabilityId,
                    role: unsigned.role,
                    domain: unsigned.domain,
                    releaseKeyId: unsigned.releaseKeyId,
                    transportKeyId: unsigned.transportKeyId,
                    policySha256: unsigned.policySha256,
                    endpointSha256: unsigned.endpointSha256,
                    authorizationSha256: unsigned.authorizationSha256,
                    inputSha256: unsigned.inputSha256,
                    inputSize: unsigned.inputSize,
                    transportSignature: response.transportSignature,
                    expiresAt: unsigned.expiresAt,
                  })}\n`,
                  "utf8",
                )
              : canonicalLine(response);
            authorizationRequests.push(authorizationRequest);
            authorizationResponses.push(responseBytes);
            metrics.capabilitiesIssued += 1;
            pending = {
              authorizationRequest,
              authorizationResponse: unsigned,
            };
            phase = "sign";
            behavior.afterCapabilityIssued?.();
            socket.write(responseBytes);
            continue;
          }
          if (phase !== "sign" || pending === undefined) {
            throw new Error("The one-shot capability is absent or already consumed.");
          }
          if (behavior.replaySignResponse !== undefined) {
            socket.end(behavior.replaySignResponse);
            phase = "done";
            pending = undefined;
            continue;
          }
          const capability = pending;
          pending = undefined;
          phase = "done";
          metrics.capabilitiesConsumed += 1;
          const parsed = parseReleaseSignerBrokerSignRequest(line, capability);
          const signingBytes = Buffer.from(parsed.signingBytes);
          metrics.releaseKeyUseCount += 1;
          const unsigned = {
            schemaVersion: 1,
            protocol: releaseSignerBrokerProtocol,
            type: "sign-response",
            requestId: parsed.request.requestId,
            clientNonce: parsed.request.clientNonce,
            brokerNonce: parsed.request.brokerNonce,
            capabilityId: parsed.request.capabilityId,
            role,
            domain,
            releaseKeyId,
            transportKeyId,
            inputSha256: parsed.request.inputSha256,
            releaseSignature: sign(null, signingBytes, releaseKeys.privateKey).toString(
              "base64url",
            ),
          };
          const response = {
            ...unsigned,
            transportSignature: sign(
              null,
              createReleaseSignerBrokerSignResponseSigningBytes(line, unsigned),
              transportKeys.privateKey,
            ).toString("base64url"),
          };
          const responseBytes = behavior.reorderSignResponse
            ? Buffer.from(
                `${JSON.stringify({
                  schemaVersion: unsigned.schemaVersion,
                  protocol: unsigned.protocol,
                  type: unsigned.type,
                  requestId: unsigned.requestId,
                  clientNonce: unsigned.clientNonce,
                  brokerNonce: unsigned.brokerNonce,
                  capabilityId: unsigned.capabilityId,
                  role: unsigned.role,
                  domain: unsigned.domain,
                  releaseKeyId: unsigned.releaseKeyId,
                  transportKeyId: unsigned.transportKeyId,
                  inputSha256: unsigned.inputSha256,
                  transportSignature: response.transportSignature,
                  releaseSignature: unsigned.releaseSignature,
                })}\n`,
                "utf8",
              )
            : canonicalLine(response);
          signRequests.push(parsed.request);
          signResponses.push(responseBytes);
          socket.end(responseBytes);
        } catch (error) {
          errors.push(error);
          pending = undefined;
          phase = "done";
          socket.destroy();
          return;
        }
      }
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
    actualTransportKeyId,
    approve(authorization) {
      const approval = Object.freeze({
        authorizationSha256: credentialAuthorizationDigest(authorization),
        inputSha256: authorization.inputSha256,
        snapshotSha256: authorization.snapshotSha256,
      });
      approvals.set(approval.authorizationSha256, approval);
      return approval;
    },
    authorizationRequests,
    authorizationResponses,
    behavior,
    domain,
    endpoint,
    endpointSha256,
    errors,
    metrics,
    get policySha256() {
      return policySha256;
    },
    releaseKeyId,
    releasePublicKeyPem,
    role,
    signRequests,
    signResponses,
    setPolicySha256(value) {
      if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
        throw new Error("The engineering broker policy SHA-256 is invalid.");
      }
      policySha256 = value;
    },
    transportKeyId,
    transportPublicKeyPem,
  };
}

export function createCredentialAuthorization(signingBytes, options = {}) {
  const authorizedAt = options.authorizedAt ?? new Date();
  return {
    authorizationId: options.authorizationId ?? randomBytes(32).toString("base64url"),
    role: options.role ?? defaultRole,
    domain: options.domain ?? defaultDomain,
    inputSha256: sha256(signingBytes),
    snapshotSha256: options.snapshotSha256 ?? "b".repeat(64),
    authorizedAt: authorizedAt.toISOString(),
    expiresAt: new Date(authorizedAt.getTime() + (options.ttlMs ?? 15_000)).toISOString(),
  };
}

export function createPublisherSigningBytes(label = "fixture") {
  const hash = "c".repeat(64);
  const candidate = {
    publisherCandidateStatementSha256: hash,
    target: {
      platform: "darwin",
      architecture: "arm64",
    },
    productVersion: "0.1.0-alpha.1",
    buildCommit: "1".repeat(40),
    auditedSourceCommit: "2".repeat(40),
    acceptanceLedgerSha256: hash,
    candidateAttestationId: `candidate/${label}-0001`,
    checksumManifestSha256: hash,
    payloadManifestSha256: hash,
    releaseMetadataSha256: hash,
    nativeComponentsSha256: hash,
    platformAuthenticitySha256: hash,
  };
  const statement = {
    schemaVersion: 2,
    product: "OpenDelegate",
    domain: "opendelegate.release.publisher-attestation.v2",
    candidate,
    archive: {
      path: `opendelegate-${label}.tar.gz`,
      size: 128,
      sha256: hash,
    },
  };
  return Buffer.from(
    `OpenDelegate publisher attestation v2\n${JSON.stringify(statement, null, 2)}\n`,
    "utf8",
  );
}

export function keyIdFor(publicKey) {
  return `sha256:${sha256(publicKey.export({ format: "der", type: "spki" }))}`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}
