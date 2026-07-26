import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

import { credentialAuthorizationDigest } from "./release-credential-authorization.mjs";

const BROKER_PROTOCOL = "opendelegate.release.signer-broker.v1";
const AUTHORIZATION_RESPONSE_DOMAIN = "OpenDelegate release signer broker authorization v1\n";
const TRANSPORT_RESPONSE_DOMAIN = "OpenDelegate release signer broker response v1\n";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_TIMEOUT_MS = 60_000;
const MAXIMUM_AUTHORIZATION_MS = 15_000;
const MAXIMUM_SIGNING_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BROKER_OUTPUT_BYTES = 64 * 1024;
const MAXIMUM_PUBLIC_KEY_BYTES = 64 * 1024;
const MAXIMUM_POSIX_ENDPOINT_BYTES = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,160}$/u;
const allowedRoles = new Set(["publisher", "promotion"]);
const allowedDomainsByRole = new Map([
  ["publisher", new Set(["publisher-attestation-v2"])],
  ["promotion", new Set(["promotion-authorization-v1", "supported-channel-receipt-v2"])],
]);
const statementContractByDomain = new Map([
  [
    "publisher-attestation-v2",
    Object.freeze({
      embeddedDomain: "opendelegate.release.publisher-attestation.v2",
      keys: ["schemaVersion", "product", "domain", "candidate", "archive"],
      prefix: "OpenDelegate publisher attestation v2\n",
      role: undefined,
      schemaVersion: 2,
    }),
  ],
  [
    "promotion-authorization-v1",
    Object.freeze({
      embeddedDomain: "opendelegate.release.promotion-authorization.v1",
      keys: [
        "schemaVersion",
        "product",
        "role",
        "domain",
        "releaseId",
        "productVersion",
        "channel",
        "issuedAt",
        "statementId",
        "publicationPolicy",
        "auditedSourceCommit",
        "buildCommit",
        "acceptanceLedger",
        "supportMatrix",
        "targets",
        "liveEvidence",
      ],
      prefix: "OpenDelegate promotion authorization v1\n",
      role: "promotion",
      schemaVersion: 1,
    }),
  ],
  [
    "supported-channel-receipt-v2",
    Object.freeze({
      embeddedDomain: "opendelegate.release.supported-channel-receipt.v2",
      keys: [
        "schemaVersion",
        "product",
        "role",
        "domain",
        "receiptId",
        "releaseId",
        "channel",
        "tag",
        "promotionAttestationSha256",
        "uploaderAuthorityKeyId",
        "publishedAssets",
        "observedAt",
      ],
      prefix: "OpenDelegate supported channel receipt v2\n",
      role: "promotion",
      schemaVersion: 2,
    }),
  ],
]);

export const releaseSignerBrokerProtocol = BROKER_PROTOCOL;
export const releaseSignerBrokerAuthorizationResponseDomain = AUTHORIZATION_RESPONSE_DOMAIN;
export const releaseSignerBrokerTransportResponseDomain = TRANSPORT_RESPONSE_DOMAIN;

export async function invokePinnedReleaseSigner(input) {
  requireExactKeys(
    input,
    [
      "authorization",
      "beforeSign",
      "domain",
      "endpoint",
      "policySha256",
      "publicKeyPem",
      "role",
      "signingBytes",
      "timeoutMs",
      "transportPublicKeyPem",
    ],
    "release signer input",
    new Set(["timeoutMs"]),
  );
  if (typeof input.beforeSign !== "function") {
    throw new Error("The release signer requires a post-capability revalidation callback.");
  }
  const role = requireRole(input.role);
  const domain = requireDomain(role, input.domain);
  const endpoint = validateReleaseSignerBrokerEndpoint(input.endpoint);
  const endpointSha256 = sha256(Buffer.from(endpoint, "utf8"));
  const policySha256 = requireSha256(input.policySha256, "release-signing policy");
  const signingBytes = copyBoundedBytes(
    input.signingBytes,
    MAXIMUM_SIGNING_BYTES,
    "The release signing input is empty or oversized.",
  );
  validateReleaseSigningStatement(signingBytes, domain);
  const publicKeyBytes = copyBoundedBytes(
    input.publicKeyPem,
    MAXIMUM_PUBLIC_KEY_BYTES,
    "The external signer trust root is empty or oversized.",
  );
  const transportPublicKeyBytes = copyBoundedBytes(
    input.transportPublicKeyPem,
    MAXIMUM_PUBLIC_KEY_BYTES,
    "The signer-broker transport trust root is empty or oversized.",
  );
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error(
      `The external signer timeout must be an integer between 100 and ${MAXIMUM_TIMEOUT_MS}.`,
    );
  }

  const publicKey = parseEd25519PublicKey(publicKeyBytes, "external signer trust root");
  const transportPublicKey = parseEd25519PublicKey(
    transportPublicKeyBytes,
    "signer-broker transport trust root",
  );
  const releaseKeyId = keyIdFor(publicKey);
  const transportKeyId = keyIdFor(transportPublicKey);
  if (releaseKeyId === transportKeyId) {
    throw new Error("The release-signing and broker-transport authorities must be distinct.");
  }
  const inputSha256 = sha256(signingBytes);
  const authorization = requireAuthorization(input.authorization, {
    domain,
    inputSha256,
    role,
  });
  const authorizationSha256 = credentialAuthorizationDigest(authorization);
  const authorizationRequest = createAuthorizationRequest({
    authorization,
    authorizationSha256,
    domain,
    endpointSha256,
    inputSha256,
    inputSize: signingBytes.byteLength,
    policySha256,
    releaseKeyId,
    role,
    transportKeyId,
  });
  const authorizationRequestBytes = canonicalLine(authorizationRequest);
  const session = await openBrokerSession(endpoint, timeoutMs);
  try {
    await session.write(authorizationRequestBytes);
    const authorizationResponseBytes = await session.readLine();
    const authorizationResponse = parseAuthorizationResponse(authorizationResponseBytes);
    assertAuthorizationResponseMatches(authorizationResponse, authorizationRequest, authorization);
    verifyTransportResponse({
      domain: AUTHORIZATION_RESPONSE_DOMAIN,
      publicKey: transportPublicKey,
      requestBytes: authorizationRequestBytes,
      response: authorizationResponse,
      signature: authorizationResponse.transportSignature,
      unsigned: unsignedAuthorizationResponse(authorizationResponse),
    });

    const finalizedAuthorization = requireAuthorization(await input.beforeSign(), {
      domain,
      inputSha256,
      role,
    });
    if (
      credentialAuthorizationDigest(finalizedAuthorization) !== authorizationSha256 ||
      Date.now() > Date.parse(authorizationResponse.expiresAt)
    ) {
      throw new Error(
        "The post-capability credential authorization changed or expired before signer invocation.",
      );
    }
    const signRequest = createSignRequest({
      authorizationRequest,
      authorizationResponse,
      signingBytes,
    });
    const signRequestBytes = canonicalLine(signRequest);
    await session.write(signRequestBytes);
    const signResponseBytes = await session.readLine();
    const signResponse = parseSignResponse(signResponseBytes);
    assertSignResponseMatches(signResponse, signRequest);
    verifyTransportResponse({
      domain: TRANSPORT_RESPONSE_DOMAIN,
      publicKey: transportPublicKey,
      requestBytes: signRequestBytes,
      response: signResponse,
      signature: signResponse.transportSignature,
      unsigned: unsignedSignResponse(signResponse),
    });
    if (
      !verifySignature(
        null,
        signingBytes,
        publicKey,
        Buffer.from(signResponse.releaseSignature, "base64url"),
      )
    ) {
      throw new Error(
        "The external signer response signature does not verify against the release trust root.",
      );
    }
    if (Date.now() > Date.parse(authorization.expiresAt)) {
      throw new Error("The signer credential authorization expired before the response verified.");
    }
    return Object.freeze({
      algorithm: "ed25519",
      broker: Object.freeze({
        endpointSha256,
        protocol: BROKER_PROTOCOL,
        transportKeyId,
      }),
      keyId: releaseKeyId,
      signature: signResponse.releaseSignature,
    });
  } finally {
    session.close();
  }
}

function createAuthorizationRequest(input) {
  return {
    schemaVersion: 1,
    protocol: BROKER_PROTOCOL,
    type: "authorize-request",
    requestId: randomUUID(),
    clientNonce: randomBytes(32).toString("base64url"),
    role: input.role,
    domain: input.domain,
    releaseKeyId: input.releaseKeyId,
    transportKeyId: input.transportKeyId,
    policySha256: input.policySha256,
    endpointSha256: input.endpointSha256,
    authorization: input.authorization,
    authorizationSha256: input.authorizationSha256,
    inputSha256: input.inputSha256,
    inputSize: input.inputSize,
  };
}

function createSignRequest(input) {
  return {
    schemaVersion: 1,
    protocol: BROKER_PROTOCOL,
    type: "sign-request",
    requestId: randomUUID(),
    clientNonce: input.authorizationRequest.clientNonce,
    brokerNonce: input.authorizationResponse.brokerNonce,
    capabilityId: input.authorizationResponse.capabilityId,
    role: input.authorizationRequest.role,
    domain: input.authorizationRequest.domain,
    releaseKeyId: input.authorizationRequest.releaseKeyId,
    transportKeyId: input.authorizationRequest.transportKeyId,
    policySha256: input.authorizationRequest.policySha256,
    endpointSha256: input.authorizationRequest.endpointSha256,
    authorizationSha256: input.authorizationRequest.authorizationSha256,
    inputSha256: input.authorizationRequest.inputSha256,
    inputSize: input.authorizationRequest.inputSize,
    signingBytes: input.signingBytes.toString("base64url"),
  };
}

export function parseReleaseSignerBrokerAuthorizationRequest(bytes, expected) {
  requireExactKeys(
    expected,
    [
      "approvedInputSha256",
      "approvedSnapshotSha256",
      "domain",
      "endpointSha256",
      "policySha256",
      "releaseKeyId",
      "role",
      "transportKeyId",
    ],
    "broker authorization expectation",
  );
  const value = parseCanonicalLine(
    bytes,
    [
      "schemaVersion",
      "protocol",
      "type",
      "requestId",
      "clientNonce",
      "role",
      "domain",
      "releaseKeyId",
      "transportKeyId",
      "policySha256",
      "endpointSha256",
      "authorization",
      "authorizationSha256",
      "inputSha256",
      "inputSize",
    ],
    "signer-broker authorization request",
    128 * 1024,
  );
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    value.type !== "authorize-request" ||
    !UUID_PATTERN.test(value.requestId) ||
    !BASE64URL_32_PATTERN.test(value.clientNonce) ||
    value.role !== expected.role ||
    value.domain !== expected.domain ||
    value.releaseKeyId !== expected.releaseKeyId ||
    value.transportKeyId !== expected.transportKeyId ||
    value.policySha256 !== expected.policySha256 ||
    value.endpointSha256 !== expected.endpointSha256 ||
    !SHA256_PATTERN.test(value.authorizationSha256) ||
    value.inputSha256 !== requireSha256(expected.approvedInputSha256, "approved signing input") ||
    !Number.isSafeInteger(value.inputSize) ||
    value.inputSize < 1 ||
    value.inputSize > MAXIMUM_SIGNING_BYTES
  ) {
    throw new Error("The signer-broker authorization request is invalid or unauthorized.");
  }
  const authorization = requireAuthorization(value.authorization, {
    domain: value.domain,
    inputSha256: value.inputSha256,
    role: value.role,
  });
  if (credentialAuthorizationDigest(authorization) !== value.authorizationSha256) {
    throw new Error("The signer-broker authorization digest is invalid.");
  }
  if (
    authorization.snapshotSha256 !==
    requireSha256(expected.approvedSnapshotSha256, "approved runner snapshot")
  ) {
    throw new Error("The signer-broker runner snapshot is not independently approved.");
  }
  return Object.freeze({
    ...value,
    authorization,
  });
}

export function parseReleaseSignerBrokerSignRequest(bytes, pending) {
  requireExactKeys(
    pending,
    ["authorizationRequest", "authorizationResponse"],
    "pending signer-broker capability",
  );
  const authorizationRequest = pending.authorizationRequest;
  const authorizationResponse = pending.authorizationResponse;
  const value = parseCanonicalLine(
    bytes,
    [
      "schemaVersion",
      "protocol",
      "type",
      "requestId",
      "clientNonce",
      "brokerNonce",
      "capabilityId",
      "role",
      "domain",
      "releaseKeyId",
      "transportKeyId",
      "policySha256",
      "endpointSha256",
      "authorizationSha256",
      "inputSha256",
      "inputSize",
      "signingBytes",
    ],
    "signer-broker sign request",
    6 * 1024 * 1024,
  );
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    value.type !== "sign-request" ||
    !UUID_PATTERN.test(value.requestId) ||
    value.clientNonce !== authorizationRequest.clientNonce ||
    value.brokerNonce !== authorizationResponse.brokerNonce ||
    value.capabilityId !== authorizationResponse.capabilityId ||
    value.role !== authorizationRequest.role ||
    value.domain !== authorizationRequest.domain ||
    value.releaseKeyId !== authorizationRequest.releaseKeyId ||
    value.transportKeyId !== authorizationRequest.transportKeyId ||
    value.policySha256 !== authorizationRequest.policySha256 ||
    value.endpointSha256 !== authorizationRequest.endpointSha256 ||
    value.authorizationSha256 !== authorizationRequest.authorizationSha256 ||
    value.inputSha256 !== authorizationRequest.inputSha256 ||
    value.inputSize !== authorizationRequest.inputSize ||
    typeof value.signingBytes !== "string"
  ) {
    throw new Error("The signer-broker sign request does not match its one-shot capability.");
  }
  const signingBytes = Buffer.from(value.signingBytes, "base64url");
  if (
    signingBytes.toString("base64url") !== value.signingBytes ||
    signingBytes.byteLength !== value.inputSize ||
    sha256(signingBytes) !== value.inputSha256
  ) {
    throw new Error("The signer-broker sign request bytes do not match their authorized digest.");
  }
  validateReleaseSigningStatement(signingBytes, value.domain);
  if (Date.now() > Date.parse(authorizationResponse.expiresAt)) {
    throw new Error("The signer-broker one-shot capability expired before key use.");
  }
  return Object.freeze({
    request: Object.freeze({ ...value }),
    get signingBytes() {
      return Uint8Array.from(signingBytes);
    },
  });
}

export function createReleaseSignerBrokerAuthorizationResponseSigningBytes(
  requestBytes,
  unsignedResponse,
) {
  return transportSigningBytes(AUTHORIZATION_RESPONSE_DOMAIN, requestBytes, unsignedResponse);
}

export function createReleaseSignerBrokerSignResponseSigningBytes(requestBytes, unsignedResponse) {
  return transportSigningBytes(TRANSPORT_RESPONSE_DOMAIN, requestBytes, unsignedResponse);
}

function parseAuthorizationResponse(bytes) {
  const value = parseCanonicalLine(
    bytes,
    [
      "schemaVersion",
      "protocol",
      "type",
      "requestId",
      "clientNonce",
      "brokerNonce",
      "capabilityId",
      "role",
      "domain",
      "releaseKeyId",
      "transportKeyId",
      "policySha256",
      "endpointSha256",
      "authorizationSha256",
      "inputSha256",
      "inputSize",
      "expiresAt",
      "transportSignature",
    ],
    "signer-broker authorization response",
    MAXIMUM_BROKER_OUTPUT_BYTES,
  );
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    value.type !== "authorize-response" ||
    !UUID_PATTERN.test(value.requestId) ||
    !BASE64URL_32_PATTERN.test(value.clientNonce) ||
    !BASE64URL_32_PATTERN.test(value.brokerNonce) ||
    !BASE64URL_32_PATTERN.test(value.capabilityId) ||
    !allowedRoles.has(value.role) ||
    typeof value.domain !== "string" ||
    !KEY_ID_PATTERN.test(value.releaseKeyId) ||
    !KEY_ID_PATTERN.test(value.transportKeyId) ||
    !SHA256_PATTERN.test(value.policySha256) ||
    !SHA256_PATTERN.test(value.endpointSha256) ||
    !SHA256_PATTERN.test(value.authorizationSha256) ||
    !SHA256_PATTERN.test(value.inputSha256) ||
    !Number.isSafeInteger(value.inputSize) ||
    value.inputSize < 1 ||
    value.inputSize > MAXIMUM_SIGNING_BYTES ||
    !isCanonicalTimestamp(value.expiresAt) ||
    !ED25519_SIGNATURE_PATTERN.test(value.transportSignature)
  ) {
    throw new Error("The signer-broker authorization response fields are invalid.");
  }
  return value;
}

function parseSignResponse(bytes) {
  const value = parseCanonicalLine(
    bytes,
    [
      "schemaVersion",
      "protocol",
      "type",
      "requestId",
      "clientNonce",
      "brokerNonce",
      "capabilityId",
      "role",
      "domain",
      "releaseKeyId",
      "transportKeyId",
      "inputSha256",
      "releaseSignature",
      "transportSignature",
    ],
    "signer-broker response",
    MAXIMUM_BROKER_OUTPUT_BYTES,
  );
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    value.type !== "sign-response" ||
    !UUID_PATTERN.test(value.requestId) ||
    !BASE64URL_32_PATTERN.test(value.clientNonce) ||
    !BASE64URL_32_PATTERN.test(value.brokerNonce) ||
    !BASE64URL_32_PATTERN.test(value.capabilityId) ||
    !allowedRoles.has(value.role) ||
    typeof value.domain !== "string" ||
    !KEY_ID_PATTERN.test(value.releaseKeyId) ||
    !KEY_ID_PATTERN.test(value.transportKeyId) ||
    !SHA256_PATTERN.test(value.inputSha256) ||
    !ED25519_SIGNATURE_PATTERN.test(value.releaseSignature) ||
    !ED25519_SIGNATURE_PATTERN.test(value.transportSignature)
  ) {
    throw new Error("The signer-broker response fields are invalid.");
  }
  return value;
}

function unsignedAuthorizationResponse(response) {
  return {
    schemaVersion: response.schemaVersion,
    protocol: response.protocol,
    type: response.type,
    requestId: response.requestId,
    clientNonce: response.clientNonce,
    brokerNonce: response.brokerNonce,
    capabilityId: response.capabilityId,
    role: response.role,
    domain: response.domain,
    releaseKeyId: response.releaseKeyId,
    transportKeyId: response.transportKeyId,
    policySha256: response.policySha256,
    endpointSha256: response.endpointSha256,
    authorizationSha256: response.authorizationSha256,
    inputSha256: response.inputSha256,
    inputSize: response.inputSize,
    expiresAt: response.expiresAt,
  };
}

function unsignedSignResponse(response) {
  return {
    schemaVersion: response.schemaVersion,
    protocol: response.protocol,
    type: response.type,
    requestId: response.requestId,
    clientNonce: response.clientNonce,
    brokerNonce: response.brokerNonce,
    capabilityId: response.capabilityId,
    role: response.role,
    domain: response.domain,
    releaseKeyId: response.releaseKeyId,
    transportKeyId: response.transportKeyId,
    inputSha256: response.inputSha256,
    releaseSignature: response.releaseSignature,
  };
}

function assertAuthorizationResponseMatches(response, request, authorization) {
  for (const name of [
    "requestId",
    "clientNonce",
    "role",
    "domain",
    "releaseKeyId",
    "transportKeyId",
    "policySha256",
    "endpointSha256",
    "authorizationSha256",
    "inputSha256",
    "inputSize",
  ]) {
    if (response[name] !== request[name]) {
      throw new Error(
        `The signer-broker authorization response does not match request field ${name}.`,
      );
    }
  }
  const expiresAt = Date.parse(response.expiresAt);
  const authorizationExpiry = Date.parse(authorization.expiresAt);
  const now = Date.now();
  if (
    expiresAt <= now ||
    expiresAt > authorizationExpiry ||
    expiresAt - now > MAXIMUM_AUTHORIZATION_MS
  ) {
    throw new Error("The signer-broker returned an invalid one-shot capability lifetime.");
  }
}

function assertSignResponseMatches(response, request) {
  for (const name of [
    "requestId",
    "clientNonce",
    "brokerNonce",
    "capabilityId",
    "role",
    "domain",
    "releaseKeyId",
    "transportKeyId",
    "inputSha256",
  ]) {
    if (response[name] !== request[name]) {
      throw new Error(`The signer-broker response does not match request field ${name}.`);
    }
  }
}

function verifyTransportResponse(input) {
  const signingBytes = transportSigningBytes(input.domain, input.requestBytes, input.unsigned);
  if (
    !verifySignature(null, signingBytes, input.publicKey, Buffer.from(input.signature, "base64url"))
  ) {
    throw new Error(
      "The signer-broker response does not authenticate to the pinned transport authority.",
    );
  }
}

function transportSigningBytes(domain, requestBytes, unsignedResponse) {
  return Buffer.concat([
    Buffer.from(domain, "utf8"),
    Buffer.from(`${sha256(requestBytes)}\n`, "utf8"),
    canonicalLine(unsignedResponse),
  ]);
}

async function openBrokerSession(endpoint, timeoutMs) {
  const socket = createConnection(endpoint);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, timeoutMs);
  timer.unref();
  try {
    await new Promise((resolvePromise, reject) => {
      const onError = () => {
        socket.off("connect", onConnect);
        reject(new Error("The authenticated external signer broker could not be reached."));
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolvePromise();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  } catch (error) {
    clearTimeout(timer);
    socket.destroy();
    if (timedOut) {
      throw new Error("The external signer broker exceeded its bounded timeout.", {
        cause: error,
      });
    }
    throw error;
  }
  const iterator = socket[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  let closed = false;
  return Object.freeze({
    close() {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        socket.destroy();
      }
    },
    async readLine() {
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline >= 0) {
          const line = Buffer.from(buffered.subarray(0, newline + 1));
          buffered = Buffer.from(buffered.subarray(newline + 1));
          return line;
        }
        let next;
        try {
          next = await iterator.next();
        } catch {
          if (timedOut) {
            throw new Error("The external signer broker exceeded its bounded timeout.");
          }
          throw new Error("The authenticated external signer broker connection failed.");
        }
        if (next.done) {
          if (timedOut) {
            throw new Error("The external signer broker exceeded its bounded timeout.");
          }
          throw new Error("The external signer broker closed before returning a response.");
        }
        buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
        if (buffered.byteLength > MAXIMUM_BROKER_OUTPUT_BYTES) {
          throw new Error("The external signer broker emitted oversized output.");
        }
      }
    },
    async write(bytes) {
      if (closed) {
        throw new Error("The authenticated external signer broker session is closed.");
      }
      await new Promise((resolvePromise, reject) => {
        socket.write(bytes, (error) => {
          if (error === undefined || error === null) {
            resolvePromise();
          } else {
            reject(new Error("A release signing request could not be sent to the broker."));
          }
        });
      });
    },
  });
}

function requireAuthorization(value, expected) {
  const keys = [
    "authorizationId",
    "role",
    "domain",
    "inputSha256",
    "snapshotSha256",
    "authorizedAt",
    "expiresAt",
  ];
  requireCanonicalKeys(value, keys, "signer credential authorization");
  if (
    typeof value.authorizationId !== "string" ||
    !BASE64URL_32_PATTERN.test(value.authorizationId) ||
    value.role !== expected.role ||
    value.domain !== expected.domain ||
    value.inputSha256 !== expected.inputSha256 ||
    typeof value.snapshotSha256 !== "string" ||
    !SHA256_PATTERN.test(value.snapshotSha256) ||
    !isCanonicalTimestamp(value.authorizedAt) ||
    !isCanonicalTimestamp(value.expiresAt)
  ) {
    throw new Error("The signer credential authorization does not match the signing request.");
  }
  const authorizedAt = Date.parse(value.authorizedAt);
  const expiresAt = Date.parse(value.expiresAt);
  const now = Date.now();
  if (
    expiresAt <= authorizedAt ||
    expiresAt < now ||
    expiresAt - authorizedAt > MAXIMUM_AUTHORIZATION_MS ||
    authorizedAt > now + 5_000
  ) {
    throw new Error("The signer credential authorization is expired or temporally invalid.");
  }
  return Object.freeze({ ...value });
}

export function validateReleaseSignerBrokerEndpoint(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    throw new Error("The release signer broker endpoint is invalid.");
  }
  if (process.platform === "win32") {
    if (!WINDOWS_PIPE_PATTERN.test(value)) {
      throw new Error("The release signer broker must use a local Windows named pipe.");
    }
    return value;
  }
  if (
    !isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_POSIX_ENDPOINT_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new Error("The release signer broker must use a bounded absolute Unix socket path.");
  }
  return value;
}

function requireRole(value) {
  if (!allowedRoles.has(value)) {
    throw new Error("The release signer role must be publisher or promotion.");
  }
  return value;
}

function requireDomain(role, value) {
  if (typeof value !== "string" || !allowedDomainsByRole.get(role)?.has(value)) {
    throw new Error("The release signing domain is not authorized for this signer role.");
  }
  return value;
}

export function validateReleaseSigningStatement(signingBytes, domain) {
  const contract = statementContractByDomain.get(domain);
  if (contract === undefined) {
    throw new Error("The release signing statement uses an unsupported wire domain.");
  }
  const bytes = signingBytes instanceof Uint8Array ? Buffer.from(signingBytes) : Buffer.alloc(0);
  const prefix = Buffer.from(contract.prefix, "utf8");
  if (
    bytes.byteLength <= prefix.byteLength ||
    !bytes.subarray(0, prefix.byteLength).equals(prefix)
  ) {
    throw new Error("The release signing bytes do not match the authorized statement domain.");
  }
  const canonicalBytes = bytes.subarray(prefix.byteLength);
  let text;
  let statement;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes);
    statement = JSON.parse(text);
  } catch (error) {
    throw new Error("The authorized release statement is not canonical JSON.", { cause: error });
  }
  requireCanonicalKeys(statement, contract.keys, "authorized release statement");
  if (
    `${JSON.stringify(statement, null, 2)}\n` !== text ||
    statement.schemaVersion !== contract.schemaVersion ||
    statement.product !== "OpenDelegate" ||
    statement.domain !== contract.embeddedDomain ||
    (contract.role === undefined
      ? Object.hasOwn(statement, "role")
      : statement.role !== contract.role)
  ) {
    throw new Error("The authorized release statement does not match its exact domain schema.");
  }
  validateDomainSpecificStatement(statement, domain);
  return Object.freeze({ ...statement });
}

function validateDomainSpecificStatement(statement, domain) {
  if (domain === "publisher-attestation-v2") {
    requireCanonicalKeys(
      statement.candidate,
      [
        "publisherCandidateStatementSha256",
        "target",
        "productVersion",
        "buildCommit",
        "auditedSourceCommit",
        "acceptanceLedgerSha256",
        "candidateAttestationId",
        "checksumManifestSha256",
        "payloadManifestSha256",
        "releaseMetadataSha256",
        "nativeComponentsSha256",
        "platformAuthenticitySha256",
      ],
      "publisher candidate binding",
    );
    requireCanonicalKeys(
      statement.candidate.target,
      ["platform", "architecture"],
      "release target",
    );
    validateArchive(statement.archive, "publisher archive");
    const hashFields = [
      "publisherCandidateStatementSha256",
      "acceptanceLedgerSha256",
      "checksumManifestSha256",
      "payloadManifestSha256",
      "releaseMetadataSha256",
      "nativeComponentsSha256",
      "platformAuthenticitySha256",
    ];
    if (
      !hashFields.every((name) => SHA256_PATTERN.test(statement.candidate[name])) ||
      !/^[0-9a-f]{40}$/u.test(statement.candidate.buildCommit) ||
      !/^[0-9a-f]{40}$/u.test(statement.candidate.auditedSourceCommit) ||
      typeof statement.candidate.productVersion !== "string" ||
      typeof statement.candidate.candidateAttestationId !== "string" ||
      !isReleaseTarget(statement.candidate.target)
    ) {
      throw new Error("The publisher statement candidate binding is invalid.");
    }
    return;
  }
  if (domain === "promotion-authorization-v1") {
    if (
      typeof statement.releaseId !== "string" ||
      typeof statement.productVersion !== "string" ||
      typeof statement.channel !== "string" ||
      !isCanonicalTimestamp(statement.issuedAt) ||
      typeof statement.statementId !== "string" ||
      statement.publicationPolicy !== "immutable-assets-with-remote-digest-readback" ||
      !/^[0-9a-f]{40}$/u.test(statement.auditedSourceCommit) ||
      !/^[0-9a-f]{40}$/u.test(statement.buildCommit) ||
      !Array.isArray(statement.targets) ||
      statement.targets.length !== 3 ||
      !Array.isArray(statement.liveEvidence) ||
      statement.liveEvidence.length !== 36 ||
      statement.acceptanceLedger === null ||
      typeof statement.acceptanceLedger !== "object" ||
      statement.supportMatrix === null ||
      typeof statement.supportMatrix !== "object"
    ) {
      throw new Error("The promotion authorization statement is structurally incomplete.");
    }
    return;
  }
  if (
    typeof statement.receiptId !== "string" ||
    typeof statement.releaseId !== "string" ||
    typeof statement.channel !== "string" ||
    typeof statement.tag !== "string" ||
    !SHA256_PATTERN.test(statement.promotionAttestationSha256) ||
    !KEY_ID_PATTERN.test(statement.uploaderAuthorityKeyId) ||
    !Array.isArray(statement.publishedAssets) ||
    statement.publishedAssets.length !== 3 ||
    !statement.publishedAssets.every((asset) => {
      try {
        validatePublishedAsset(asset);
        return (
          isReleaseTarget(asset.target) &&
          typeof asset.observerAuthorityKeyId === "string" &&
          KEY_ID_PATTERN.test(asset.observerAuthorityKeyId)
        );
      } catch {
        return false;
      }
    }) ||
    !isCanonicalTimestamp(statement.observedAt)
  ) {
    throw new Error("The supported-channel receipt statement is structurally incomplete.");
  }
}

function validatePublishedAsset(value) {
  requireCanonicalKeys(
    value,
    [
      "target",
      "path",
      "size",
      "sha256",
      "source",
      "observedStreamSha256",
      "observerAuthorityKeyId",
      "observedAt",
      "evidenceEnvelope",
    ],
    "supported-channel asset",
  );
  validateArchiveFields(value, "supported-channel asset");
  requireCanonicalKeys(
    value.source,
    ["provider", "immutableObjectId", "immutableObjectVersion"],
    "supported-channel asset source",
  );
  requireCanonicalKeys(
    value.evidenceEnvelope,
    ["domain", "sha256", "signature"],
    "supported-channel asset evidence envelope",
  );
  if (
    !isReleaseTarget(value.target) ||
    typeof value.source.provider !== "string" ||
    value.source.provider === "" ||
    typeof value.source.immutableObjectId !== "string" ||
    value.source.immutableObjectId === "" ||
    typeof value.source.immutableObjectVersion !== "string" ||
    value.source.immutableObjectVersion === "" ||
    !SHA256_PATTERN.test(value.observedStreamSha256) ||
    !KEY_ID_PATTERN.test(value.observerAuthorityKeyId) ||
    !isCanonicalTimestamp(value.observedAt) ||
    value.evidenceEnvelope.domain !== "opendelegate.release.remote-read-back-observation.v1" ||
    !SHA256_PATTERN.test(value.evidenceEnvelope.sha256) ||
    !ED25519_SIGNATURE_PATTERN.test(value.evidenceEnvelope.signature)
  ) {
    throw new Error("The supported-channel asset is invalid.");
  }
}

function validateArchive(value, label) {
  requireCanonicalKeys(value, ["path", "size", "sha256"], label);
  validateArchiveFields(value, label);
}

function validateArchiveFields(value, label) {
  if (
    typeof value.path !== "string" ||
    value.path === "" ||
    value.path.includes("/") ||
    value.path.includes("\\") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 4 * 1024 * 1024 * 1024 ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
}

function isReleaseTarget(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    ((value.platform === "darwin" && value.architecture === "arm64") ||
      (value.platform === "linux" && value.architecture === "x64") ||
      (value.platform === "win32" && value.architecture === "x64"))
  );
}

function parseCanonicalLine(bytes, keys, label, maximumBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3 || bytes.byteLength > maximumBytes) {
    throw new Error(`The ${label} is empty or oversized.`);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The ${label} is not canonical JSON.`, { cause: error });
  }
  requireCanonicalKeys(value, keys, label);
  if (`${JSON.stringify(value)}\n` !== text) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  return value;
}

function canonicalLine(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} SHA-256 pin must be lowercase hexadecimal.`);
  }
  return value;
}

function parseEd25519PublicKey(bytes, label) {
  try {
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("The key is not Ed25519.");
    }
    return key;
  } catch (error) {
    throw new Error(`The ${label} is not a valid Ed25519 public key.`, { cause: error });
  }
}

function keyIdFor(key) {
  return `sha256:${sha256(Buffer.from(key.export({ format: "der", type: "spki" })))}`;
}

function copyBoundedBytes(value, maximum, message) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error(message);
  }
  return Buffer.from(value);
}

function requireExactKeys(value, expected, label, optional = new Set()) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (
    keys.some((key) => !allowed.has(key)) ||
    expected.some((key) => !optional.has(key) && !Object.hasOwn(value, key))
  ) {
    throw new Error(`The ${label} fields do not match the strict schema.`);
  }
}

function requireCanonicalKeys(value, expected, label) {
  requireExactKeys(value, expected, label);
  if (Object.keys(value).some((key, index) => key !== expected[index])) {
    throw new Error(`The ${label} fields do not match the canonical order.`);
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
