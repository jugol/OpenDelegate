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
const TRANSPORT_RESPONSE_DOMAIN = "OpenDelegate release signer broker response v1\n";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_TIMEOUT_MS = 60_000;
const MAXIMUM_SIGNING_BYTES = 4 * 1024 * 1024;
const MAXIMUM_BROKER_OUTPUT_BYTES = 64 * 1024;
const MAXIMUM_PUBLIC_KEY_BYTES = 64 * 1024;
const MAXIMUM_POSIX_ENDPOINT_BYTES = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
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
      prefix: "OpenDelegate publisher attestation v2\n",
      role: undefined,
      schemaVersion: 2,
    }),
  ],
  [
    "promotion-authorization-v1",
    Object.freeze({
      embeddedDomain: "opendelegate.release.promotion-authorization.v1",
      prefix: "OpenDelegate promotion authorization v1\n",
      role: "promotion",
      schemaVersion: 1,
    }),
  ],
  [
    "supported-channel-receipt-v2",
    Object.freeze({
      embeddedDomain: "opendelegate.release.supported-channel-receipt.v2",
      prefix: "OpenDelegate supported channel receipt v2\n",
      role: "promotion",
      schemaVersion: 2,
    }),
  ],
]);

export const releaseSignerBrokerProtocol = BROKER_PROTOCOL;

export async function invokePinnedReleaseSigner(input) {
  requireExactKeys(
    input,
    [
      "authorization",
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
  const role = requireRole(input.role);
  const domain = requireDomain(role, input.domain);
  const endpoint = validateReleaseSignerBrokerEndpoint(input.endpoint);
  const policySha256 = requireSha256(input.policySha256, "release-signing policy");
  const signingBytes = copyBoundedBytes(
    input.signingBytes,
    MAXIMUM_SIGNING_BYTES,
    "The release signing input is empty or oversized.",
  );
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
  const keyId = keyIdFor(publicKey);
  const transportKeyId = keyIdFor(transportPublicKey);
  if (keyId === transportKeyId) {
    throw new Error("The release-signing and broker-transport authorities must be distinct.");
  }
  const inputSha256 = sha256(signingBytes);
  validateReleaseSigningStatement(signingBytes, domain);
  const authorization = requireAuthorization(input.authorization, {
    domain,
    inputSha256,
    role,
  });
  const request = createBrokerRequest({
    authorization,
    domain,
    endpointSha256: sha256(Buffer.from(endpoint, "utf8")),
    inputSha256,
    keyId,
    policySha256,
    role,
    signingBytes,
    transportKeyId,
  });
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  const responseBytes = await exchangeWithBroker(endpoint, requestBytes, timeoutMs);
  const response = parseBrokerResponse(responseBytes);

  assertResponseMatchesRequest(response, request);
  const unsignedResponse = unsignedBrokerResponse(response);
  const requestSha256 = sha256(requestBytes);
  const transportSigningBytes = Buffer.concat([
    Buffer.from(TRANSPORT_RESPONSE_DOMAIN, "utf8"),
    Buffer.from(`${requestSha256}\n`, "utf8"),
    Buffer.from(`${JSON.stringify(unsignedResponse)}\n`, "utf8"),
  ]);
  if (
    !verifySignature(
      null,
      transportSigningBytes,
      transportPublicKey,
      Buffer.from(response.transportSignature, "base64url"),
    )
  ) {
    throw new Error(
      "The signer-broker response does not authenticate to the pinned transport authority.",
    );
  }
  if (
    !verifySignature(
      null,
      signingBytes,
      publicKey,
      Buffer.from(response.releaseSignature, "base64url"),
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
      endpointSha256: sha256(Buffer.from(endpoint, "utf8")),
      protocol: BROKER_PROTOCOL,
      transportKeyId,
    }),
    keyId,
    signature: response.releaseSignature,
  });
}

function createBrokerRequest(input) {
  return {
    schemaVersion: 1,
    protocol: BROKER_PROTOCOL,
    type: "sign-request",
    requestId: randomUUID(),
    clientNonce: randomBytes(32).toString("base64url"),
    role: input.role,
    domain: input.domain,
    releaseKeyId: input.keyId,
    transportKeyId: input.transportKeyId,
    policySha256: input.policySha256,
    endpointSha256: input.endpointSha256,
    authorization: input.authorization,
    authorizationSha256: credentialAuthorizationDigest(input.authorization),
    inputSha256: input.inputSha256,
    inputSize: input.signingBytes.byteLength,
    signingBytes: input.signingBytes.toString("base64url"),
  };
}

function parseBrokerResponse(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("The signer-broker response is not valid UTF-8.", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("The signer-broker response is not canonical JSON.", { cause: error });
  }
  const canonicalKeys = [
    "schemaVersion",
    "protocol",
    "type",
    "requestId",
    "clientNonce",
    "brokerNonce",
    "role",
    "domain",
    "releaseKeyId",
    "transportKeyId",
    "inputSha256",
    "releaseSignature",
    "transportSignature",
  ];
  requireCanonicalKeys(value, canonicalKeys, "signer-broker response");
  if (`${JSON.stringify(value)}\n` !== text) {
    throw new Error("The signer-broker response is not canonical JSON.");
  }
  if (
    value.schemaVersion !== 1 ||
    value.protocol !== BROKER_PROTOCOL ||
    value.type !== "sign-response" ||
    typeof value.requestId !== "string" ||
    !UUID_PATTERN.test(value.requestId) ||
    typeof value.clientNonce !== "string" ||
    !BASE64URL_32_PATTERN.test(value.clientNonce) ||
    typeof value.brokerNonce !== "string" ||
    !BASE64URL_32_PATTERN.test(value.brokerNonce) ||
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

function unsignedBrokerResponse(response) {
  return {
    schemaVersion: response.schemaVersion,
    protocol: response.protocol,
    type: response.type,
    requestId: response.requestId,
    clientNonce: response.clientNonce,
    brokerNonce: response.brokerNonce,
    role: response.role,
    domain: response.domain,
    releaseKeyId: response.releaseKeyId,
    transportKeyId: response.transportKeyId,
    inputSha256: response.inputSha256,
    releaseSignature: response.releaseSignature,
  };
}

function assertResponseMatchesRequest(response, request) {
  for (const name of [
    "requestId",
    "clientNonce",
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

async function exchangeWithBroker(endpoint, requestBytes, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, bytes) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) {
        resolvePromise(bytes);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error("The external signer broker exceeded its bounded timeout."));
    }, timeoutMs);
    timer.unref();
    socket.on("connect", () => {
      socket.write(requestBytes, (error) => {
        if (error !== undefined && error !== null) {
          finish(new Error("The release signing request could not be sent to the broker."));
        }
      });
    });
    socket.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > MAXIMUM_BROKER_OUTPUT_BYTES) {
        finish(new Error("The external signer broker emitted oversized output."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      if (total === 0) {
        finish(new Error("The external signer broker returned an empty response."));
        return;
      }
      finish(undefined, Buffer.concat(chunks, total));
    });
    socket.on("error", () => {
      finish(new Error("The authenticated external signer broker could not be reached."));
    });
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
    !AUTHORIZATION_ID_PATTERN.test(value.authorizationId) ||
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
  if (expiresAt <= authorizedAt || expiresAt < now || authorizedAt > now + 5_000) {
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
  const prefix = Buffer.from(contract.prefix, "utf8");
  if (
    signingBytes.byteLength <= prefix.byteLength ||
    !signingBytes.subarray(0, prefix.byteLength).equals(prefix)
  ) {
    throw new Error("The release signing bytes do not match the authorized statement domain.");
  }
  const canonicalBytes = signingBytes.subarray(prefix.byteLength);
  let text;
  let statement;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes);
    statement = JSON.parse(text);
  } catch (error) {
    throw new Error("The authorized release statement is not canonical JSON.", { cause: error });
  }
  if (
    statement === null ||
    typeof statement !== "object" ||
    Array.isArray(statement) ||
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

export const releaseSignerBrokerTransportResponseDomain = TRANSPORT_RESPONSE_DOMAIN;
