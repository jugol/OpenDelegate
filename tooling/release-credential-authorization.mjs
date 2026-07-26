import { createHash, randomBytes as systemRandomBytes } from "node:crypto";

import { assertSha256 } from "./release-tooling-io.mjs";

const authorizationDetails = new WeakMap();
const defaultTtlMs = 15_000;
const maximumSnapshotBytes = 64 * 1024;
const maximumSnapshotDepth = 12;
const maximumArrayItems = 512;
const authorizationIdPattern = /^[A-Za-z0-9_-]{43}$/u;
const prohibitedSnapshotKeyPattern =
  /(?:credential|password|private.?key|secret|token|executable.?path|repository.?root|absolute.?path)/iu;
const domainRoles = new Map([
  ["publisher-attestation-v2", "publisher"],
  ["promotion-authorization-v1", "promotion"],
  ["supported-channel-receipt-v2", "promotion"],
  ["platform-native-macos-sign-v1", "platform"],
  ["platform-native-macos-notarization-v1", "platform"],
  ["platform-native-windows-sign-v1", "platform"],
]);

export async function authorizeCredentialUse(input, dependencies = {}) {
  validateAuthorizationInput(input);
  const snapshotBytes = canonicalSnapshotBytes(input.snapshot);
  if (snapshotBytes.byteLength > maximumSnapshotBytes) {
    throw new Error("The sanitized credential-authorization snapshot is too large.");
  }
  const snapshotSha256 = sha256(snapshotBytes);
  await input.revalidate();

  const now = readNow(dependencies.now);
  const ttlMs = input.ttlMs ?? defaultTtlMs;
  const entropy = (dependencies.randomBytes ?? systemRandomBytes)(32);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
    throw new Error("Credential authorization requires exactly 256 bits of local entropy.");
  }
  const authorizationId = Buffer.from(entropy).toString("base64url");
  const description = Object.freeze({
    authorizationId,
    role: input.role,
    domain: input.domain,
    inputSha256: input.inputSha256,
    snapshotSha256,
    authorizedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
  const handle = Object.freeze({});
  authorizationDetails.set(
    handle,
    Object.freeze({
      description,
      expiresAt: now.getTime() + ttlMs,
    }),
  );
  return handle;
}

export function describeCredentialAuthorization(handle) {
  return requireAuthorization(handle).description;
}

export function consumeCredentialAuthorization(handle, expected, dependencies = {}) {
  const details = requireAuthorization(handle);
  authorizationDetails.delete(handle);
  validateExpectedAuthorization(expected);
  const now = readNow(dependencies.now).getTime();
  if (now > details.expiresAt) {
    throw new Error("The short-lived credential authorization expired before signer invocation.");
  }
  if (
    details.description.role !== expected.role ||
    details.description.domain !== expected.domain ||
    details.description.inputSha256 !== expected.inputSha256
  ) {
    throw new Error(
      "The credential authorization does not match the required role, domain, or input.",
    );
  }
  return details.description;
}

export function credentialAuthorizationDigest(value) {
  const description = authorizationDetails.has(value)
    ? describeCredentialAuthorization(value)
    : validateAuthorizationDescription(value);
  return sha256(canonicalJsonBytes(description));
}

function validateAuthorizationInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Credential authorization requires a strict input object.");
  }
  const allowed = new Set(["domain", "inputSha256", "revalidate", "role", "snapshot", "ttlMs"]);
  const keys = Object.keys(input);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !["domain", "inputSha256", "revalidate", "role", "snapshot"].every((key) =>
      Object.hasOwn(input, key),
    )
  ) {
    throw new Error("Credential-authorization input fields do not match the strict schema.");
  }
  validateRoleAndDomain(input.role, input.domain);
  assertSha256(input.inputSha256, "credential signing input");
  if (typeof input.revalidate !== "function") {
    throw new Error("Credential authorization requires a precredential revalidation callback.");
  }
  if (
    input.ttlMs !== undefined &&
    (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > defaultTtlMs)
  ) {
    throw new Error(`Credential authorization TTL must be between 1 and ${defaultTtlMs} ms.`);
  }
  canonicalSnapshotBytes(input.snapshot);
}

function validateExpectedAuthorization(expected) {
  if (
    typeof expected !== "object" ||
    expected === null ||
    Array.isArray(expected) ||
    Object.keys(expected).length !== 3 ||
    !Object.hasOwn(expected, "domain") ||
    !Object.hasOwn(expected, "inputSha256") ||
    !Object.hasOwn(expected, "role")
  ) {
    throw new Error("Credential authorization consumption requires exact expected fields.");
  }
  validateRoleAndDomain(expected.role, expected.domain);
  assertSha256(expected.inputSha256, "expected credential signing input");
}

function validateAuthorizationDescription(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join("\0") !==
      [
        "authorizationId",
        "role",
        "domain",
        "inputSha256",
        "snapshotSha256",
        "authorizedAt",
        "expiresAt",
      ].join("\0") ||
    !authorizationIdPattern.test(value.authorizationId)
  ) {
    throw new Error("The credential-authorization description is invalid.");
  }
  validateRoleAndDomain(value.role, value.domain);
  assertSha256(value.inputSha256, "credential-authorization input");
  assertSha256(value.snapshotSha256, "credential-authorization snapshot");
  const authorizedAt = Date.parse(value.authorizedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(authorizedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= authorizedAt ||
    expiresAt - authorizedAt > defaultTtlMs
  ) {
    throw new Error("The credential-authorization time window is invalid.");
  }
  return value;
}

function validateRoleAndDomain(role, domain) {
  if (domainRoles.get(domain) !== role) {
    throw new Error("The credential role and wire domain are not an allowed exact pair.");
  }
}

function canonicalSnapshotBytes(snapshot) {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    Object.getPrototypeOf(snapshot) !== Object.prototype
  ) {
    throw new Error("The sanitized credential-authorization snapshot must be a plain object.");
  }
  return canonicalJsonBytes(snapshot, true);
}

function canonicalJsonBytes(value, snapshot = false) {
  return Buffer.from(canonicalJson(value, 0, snapshot), "utf8");
}

function canonicalJson(value, depth, snapshot) {
  if (depth > maximumSnapshotDepth) {
    throw new Error("The credential-authorization snapshot exceeds its canonical depth limit.");
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (value.includes("\0") || value.normalize("NFC") !== value) {
      throw new Error("Credential-authorization strings must be canonical NFC without NUL.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Credential-authorization numbers must be finite canonical JSON values.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (value.length > maximumArrayItems) {
      throw new Error("The credential-authorization snapshot array is too large.");
    }
    return `[${value.map((item) => canonicalJson(item, depth + 1, snapshot)).join(",")}]`;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("The credential-authorization snapshot contains a non-canonical value.");
  }
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (
    keys.some(
      (key) =>
        key === "" ||
        key.includes("\0") ||
        key.normalize("NFC") !== key ||
        (snapshot && prohibitedSnapshotKeyPattern.test(key)) ||
        value[key] === undefined,
    )
  ) {
    throw new Error(
      "The credential-authorization snapshot is not sanitized canonical JSON and may contain secrets.",
    );
  }
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, snapshot)}`)
    .join(",")}}`;
}

function requireAuthorization(handle) {
  const details = authorizationDetails.get(handle);
  if (details === undefined) {
    throw new Error("An opaque unconsumed credential authorization is required.");
  }
  return details;
}

function readNow(now) {
  const value = now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Credential authorization requires a valid current instant.");
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
