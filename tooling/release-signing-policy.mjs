import { createHash, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  invokePinnedReleaseSigner,
  releaseSignerBrokerProtocol,
  validateReleaseSignerBrokerEndpoint,
} from "./external-release-signer.mjs";
import {
  consumeCredentialAuthorization,
  describeCredentialAuthorization,
} from "./release-credential-authorization.mjs";
import { assertNoLinkedPathComponents } from "./release-tooling-io.mjs";

const MAXIMUM_POLICY_BYTES = 256 * 1024;
const MAXIMUM_PUBLIC_KEY_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const policyDetails = new WeakMap();

export async function readPinnedReleaseSigningPolicy(input) {
  requireExactKeys(
    input,
    ["expectedRole", "path", "sha256"],
    "pinned release-signing policy input",
  );
  assertRole(input.expectedRole, "expected release-signing policy role");
  assertAbsolutePath(input.path, "release-signing policy");
  assertSha256(input.sha256, "release-signing policy");

  const policyFile = await readStablePinnedFile({
    label: "release-signing policy",
    maximumBytes: MAXIMUM_POLICY_BYTES,
    path: input.path,
    sha256: input.sha256,
  });
  const value = parseCanonicalPolicy(policyFile.bytes);
  if (value.role !== input.expectedRole) {
    throw new Error("The release-signing policy role does not match the expected authority.");
  }
  const [publicKeyFile, transportPublicKeyFile] = await Promise.all([
    readStablePinnedFile({
      label: "release-signing public key",
      maximumBytes: MAXIMUM_PUBLIC_KEY_BYTES,
      path: value.publicKey.path,
      sha256: value.publicKey.sha256,
    }),
    readStablePinnedFile({
      label: "signer-broker transport public key",
      maximumBytes: MAXIMUM_PUBLIC_KEY_BYTES,
      path: value.broker.transportPublicKey.path,
      sha256: value.broker.transportPublicKey.sha256,
    }),
  ]);
  const publicKey = parseEd25519PublicKey(publicKeyFile.bytes, "release-signing public key");
  const transportPublicKey = parseEd25519PublicKey(
    transportPublicKeyFile.bytes,
    "signer-broker transport public key",
  );
  const keyId = keyIdFor(publicKey);
  const transportKeyId = keyIdFor(transportPublicKey);
  if (keyId === transportKeyId) {
    throw new Error("The release-signing and broker-transport authorities must be distinct.");
  }
  const endpoint = validateReleaseSignerBrokerEndpoint(value.broker.endpoint);
  const handle = Object.freeze(Object.create(null));
  policyDetails.set(
    handle,
    Object.freeze({
      broker: Object.freeze({
        endpoint,
        endpointSha256: sha256(Buffer.from(endpoint, "utf8")),
        protocol: value.broker.protocol,
        timeoutMs: value.broker.timeoutMs,
        transportKeyId,
        transportPublicKey: Object.freeze({
          bytes: Buffer.from(transportPublicKeyFile.bytes),
          path: transportPublicKeyFile.path,
          sha256: transportPublicKeyFile.sha256,
        }),
      }),
      keyId,
      policy: Object.freeze({
        path: policyFile.path,
        sha256: policyFile.sha256,
      }),
      publicKey: Object.freeze({
        bytes: Buffer.from(publicKeyFile.bytes),
        path: publicKeyFile.path,
        sha256: publicKeyFile.sha256,
      }),
      role: value.role,
    }),
  );
  return handle;
}

export function describePinnedReleaseSigningPolicy(policy) {
  const details = requirePolicyHandle(policy);
  return Object.freeze({
    brokerEndpointSha256: details.broker.endpointSha256,
    brokerProtocol: details.broker.protocol,
    brokerTransportKeyId: details.broker.transportKeyId,
    keyId: details.keyId,
    policySha256: details.policy.sha256,
    publicKeySha256: details.publicKey.sha256,
    role: details.role,
    transportPublicKeySha256: details.broker.transportPublicKey.sha256,
  });
}

export function getPinnedReleaseSigningTrust(policy) {
  const details = requirePolicyHandle(policy);
  return Object.freeze({
    keyId: details.keyId,
    get publicKeyPem() {
      return Uint8Array.from(details.publicKey.bytes);
    },
    role: details.role,
  });
}

export function assertPinnedReleaseSigningPolicyExternal(policy, prohibitedRoots) {
  const details = requirePolicyHandle(policy);
  if (!Array.isArray(prohibitedRoots) || prohibitedRoots.length === 0) {
    throw new Error("At least one prohibited release-signing root is required.");
  }
  const paths = [
    details.policy.path,
    details.publicKey.path,
    details.broker.transportPublicKey.path,
    ...(process.platform === "win32" ? [] : [details.broker.endpoint]),
  ];
  for (const root of prohibitedRoots) {
    assertAbsolutePath(root, "prohibited release-signing root");
    if (paths.some((path) => isSameOrDescendant(root, path))) {
      throw new Error(
        "Release-signing policies, trust roots, and broker endpoints must remain outside candidate and output roots.",
      );
    }
  }
}

export async function signWithPinnedReleasePolicy(input) {
  requireExactKeys(
    input,
    ["authorization", "policy", "signingBytes"],
    "release statement signing input",
  );
  const details = requirePolicyHandle(input.policy);
  if (!(input.signingBytes instanceof Uint8Array) || input.signingBytes.byteLength === 0) {
    throw new Error("The release statement signing bytes are empty or invalid.");
  }
  const signingBytes = Buffer.from(input.signingBytes);
  const inputSha256 = sha256(signingBytes);
  const preview = describeCredentialAuthorization(input.authorization);
  await revalidatePolicyFiles(details);
  const authorization = consumeCredentialAuthorization(input.authorization, {
    domain: preview.domain,
    inputSha256,
    role: details.role,
  });
  const signed = await invokePinnedReleaseSigner({
    authorization,
    domain: authorization.domain,
    endpoint: details.broker.endpoint,
    policySha256: details.policy.sha256,
    publicKeyPem: details.publicKey.bytes,
    role: details.role,
    signingBytes,
    timeoutMs: details.broker.timeoutMs,
    transportPublicKeyPem: details.broker.transportPublicKey.bytes,
  });
  await revalidatePolicyFiles(details);
  if (
    signed.keyId !== details.keyId ||
    signed.broker.transportKeyId !== details.broker.transportKeyId ||
    signed.broker.endpointSha256 !== details.broker.endpointSha256 ||
    signed.broker.protocol !== details.broker.protocol
  ) {
    throw new Error("The authenticated external signer broker changed after policy validation.");
  }
  return Object.freeze({
    algorithm: "ed25519",
    inputSha256,
    keyId: signed.keyId,
    role: details.role,
    runner: Object.freeze({
      brokerEndpointSha256: signed.broker.endpointSha256,
      brokerProtocol: signed.broker.protocol,
      brokerTransportKeyId: signed.broker.transportKeyId,
    }),
    signature: signed.signature,
  });
}

async function revalidatePolicyFiles(details) {
  await Promise.all([
    readStablePinnedFile({
      label: "release-signing policy",
      maximumBytes: MAXIMUM_POLICY_BYTES,
      path: details.policy.path,
      sha256: details.policy.sha256,
    }),
    readStablePinnedFile({
      label: "release-signing public key",
      maximumBytes: MAXIMUM_PUBLIC_KEY_BYTES,
      path: details.publicKey.path,
      sha256: details.publicKey.sha256,
    }),
    readStablePinnedFile({
      label: "signer-broker transport public key",
      maximumBytes: MAXIMUM_PUBLIC_KEY_BYTES,
      path: details.broker.transportPublicKey.path,
      sha256: details.broker.transportPublicKey.sha256,
    }),
  ]);
}

function parseCanonicalPolicy(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("The release-signing policy is not valid UTF-8.", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("The release-signing policy is not canonical JSON.", { cause: error });
  }
  requireCanonicalKeys(
    value,
    ["schemaVersion", "product", "role", "publicKey", "broker"],
    "release-signing policy",
  );
  if (`${JSON.stringify(value)}\n` !== text) {
    throw new Error("The release-signing policy is not canonical JSON.");
  }
  if (value.schemaVersion !== 2 || value.product !== "OpenDelegate") {
    throw new Error("The release-signing policy identity is invalid.");
  }
  assertRole(value.role, "release-signing policy role");
  validatePinnedPath(value.publicKey, "release-signing public key");
  requireCanonicalKeys(
    value.broker,
    ["protocol", "endpoint", "transportPublicKey", "timeoutMs"],
    "release-signing policy broker",
  );
  if (value.broker.protocol !== releaseSignerBrokerProtocol) {
    throw new Error("The release-signing policy uses an unsupported broker protocol.");
  }
  validateReleaseSignerBrokerEndpoint(value.broker.endpoint);
  validatePinnedPath(value.broker.transportPublicKey, "signer-broker transport public key");
  if (
    !Number.isSafeInteger(value.broker.timeoutMs) ||
    value.broker.timeoutMs < 100 ||
    value.broker.timeoutMs > 60_000
  ) {
    throw new Error("The release-signing broker timeout is outside the supported bounds.");
  }
  return value;
}

function validatePinnedPath(value, label) {
  requireCanonicalKeys(value, ["path", "sha256"], label);
  assertAbsolutePath(value.path, label);
  assertSha256(value.sha256, label);
}

async function readStablePinnedFile(input) {
  const before = await lstat(input.path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(input.maximumBytes)
  ) {
    throw new Error(`The ${input.label} is not a bounded regular file.`);
  }
  await assertNoLinkedPathComponents(input.path, input.label);
  const canonicalPath = await realpath(input.path);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error(`The ${input.label} changed before it could be read.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameFile(opened, after) ||
      after.size !== BigInt(bytes.byteLength) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > input.maximumBytes
    ) {
      bytes.fill(0);
      throw new Error(`The ${input.label} changed while it was being read.`);
    }
    const digest = sha256(bytes);
    if (digest !== input.sha256) {
      bytes.fill(0);
      throw new Error(`The ${input.label} SHA-256 does not match its required pin.`);
    }
    return Object.freeze({ bytes, path: canonicalPath, sha256: digest });
  } finally {
    await handle.close();
  }
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

function requirePolicyHandle(value) {
  const details =
    typeof value === "object" && value !== null ? policyDetails.get(value) : undefined;
  if (details === undefined) {
    throw new Error("An opaque pinned release-signing policy handle is required.");
  }
  return details;
}

function requireExactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
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

function assertRole(value, label) {
  if (value !== "publisher" && value !== "promotion") {
    throw new Error(`The ${label} must be publisher or promotion.`);
  }
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`The ${label} path must be absolute.`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} SHA-256 pin must be lowercase hexadecimal.`);
  }
}

function sameFile(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isSameOrDescendant(root, path) {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function keyIdFor(key) {
  return `sha256:${sha256(Buffer.from(key.export({ format: "der", type: "spki" })))}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
