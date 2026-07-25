import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as createSignature,
} from "node:crypto";
import { chmod, lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPortableTree,
  createChecksumManifest,
  createPayloadManifest,
  isDirectReleaseInvocation,
} from "./build-release.mjs";

const currentFile = fileURLToPath(import.meta.url);
const maximumPrivateKeyBytes = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const candidateStatus = "release-candidate";
const previewStatuses = new Set(["internal-preview-blocked", "internal-preview-complete"]);
const requiredSmokeChecks = [
  "cliHelp",
  "backupCliHelp",
  "serviceCliHelp",
  "cleanHomeInitialization",
  "mainHealth",
  "adminStaticApp",
  "loopbackOwnerClaim",
  "ownerLogin",
  "ownerSessionCookieContract",
  "ownerSessionRoundTrip",
];

export function parsePublisherSigningArguments(values) {
  let bundle;
  let privateKey;
  let publicKeyDestination;
  let allowUnsupportedPreview = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--allow-unsupported-preview") {
      allowUnsupportedPreview = true;
      continue;
    }
    if (value === "--bundle" || value === "--private-key" || value === "--public-key-destination") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new Error(`${value} requires an absolute path.`);
      }
      if (!isAbsolute(candidate)) {
        throw new Error(`${value} must be an absolute path.`);
      }
      if (value === "--bundle") {
        if (bundle !== undefined) {
          throw new Error("--bundle may be specified only once.");
        }
        bundle = resolve(candidate);
      } else if (value === "--private-key") {
        if (privateKey !== undefined) {
          throw new Error("--private-key may be specified only once.");
        }
        privateKey = resolve(candidate);
      } else {
        if (publicKeyDestination !== undefined) {
          throw new Error("--public-key-destination may be specified only once.");
        }
        publicKeyDestination = resolve(candidate);
      }
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      return { help: true };
    }
    throw new Error(`Unknown publisher-signing option: ${String(value)}.`);
  }

  if (bundle === undefined) {
    throw new Error("--bundle is required.");
  }
  if (privateKey === undefined) {
    throw new Error("--private-key is required.");
  }
  if (publicKeyDestination === undefined) {
    throw new Error("--public-key-destination is required.");
  }
  return {
    allowUnsupportedPreview,
    bundle,
    help: false,
    privateKey,
    publicKeyDestination,
  };
}

export function publisherSignatureInput(manifestSha256) {
  if (typeof manifestSha256 !== "string" || !sha256Pattern.test(manifestSha256)) {
    throw new Error("The release manifest digest must be a lowercase SHA-256 value.");
  }
  return Buffer.from(`OpenDelegate release manifest v1\n${manifestSha256}\n`, "utf8");
}

export async function inspectBundleForPublisherSigning(bundle, { allowUnsupportedPreview }) {
  const canonicalBundle = await requireRegularDirectory(bundle, "release bundle");
  await assertPortableTree(canonicalBundle);

  const payloadPath = resolve(canonicalBundle, "payload-manifest.json");
  const checksumPath = resolve(canonicalBundle, "SHA256SUMS");
  const metadataPath = resolve(canonicalBundle, "release-metadata.json");
  const smokePath = resolve(canonicalBundle, "smoke-evidence.json");
  for (const [path, label] of [
    [payloadPath, "payload manifest"],
    [checksumPath, "checksum manifest"],
    [metadataPath, "release metadata"],
    [smokePath, "smoke evidence"],
  ]) {
    await requireRegularFile(path, label);
  }

  const expectedPayload = `${JSON.stringify(
    await createPayloadManifest(canonicalBundle),
    null,
    2,
  )}\n`;
  const actualPayload = await readFile(payloadPath, "utf8");
  if (actualPayload !== expectedPayload) {
    throw new Error("The payload manifest does not match the exact release files.");
  }

  const expectedChecksums = await createChecksumManifest(canonicalBundle);
  const actualChecksums = await readFile(checksumPath, "utf8");
  if (actualChecksums !== expectedChecksums) {
    throw new Error("The checksum manifest does not match the exact release files.");
  }

  const metadata = await readJsonObject(metadataPath, "release metadata");
  const supportStatus = metadata.supportStatus;
  if (supportStatus !== candidateStatus && !previewStatuses.has(supportStatus)) {
    throw new Error("The bundle has no publisher-signable support status.");
  }
  if (
    metadata.schemaVersion !== 2 ||
    metadata.product !== "OpenDelegate" ||
    typeof metadata.productVersion !== "string" ||
    metadata.productVersion.trim() === "" ||
    (metadata.platform !== "win32" &&
      metadata.platform !== "darwin" &&
      metadata.platform !== "linux") ||
    (metadata.architecture !== "x64" && metadata.architecture !== "arm64")
  ) {
    throw new Error("The release metadata does not identify a supported target bundle.");
  }
  if (
    supportStatus === candidateStatus &&
    (!isObject(metadata.releaseEvidence) || metadata.releaseEvidence.complete !== true)
  ) {
    throw new Error("A release candidate requires complete release evidence before signing.");
  }
  if (previewStatuses.has(supportStatus) && allowUnsupportedPreview !== true) {
    throw new Error("Signing an unsupported preview requires --allow-unsupported-preview.");
  }

  const executableSuffix = metadata.platform === "win32" ? ".exe" : "";
  for (const name of [
    `opendelegate-service-host${executableSuffix}`,
    `opendelegate-session-helper${executableSuffix}`,
  ]) {
    const path = resolve(canonicalBundle, "bin", name);
    const entry = await requireRegularFile(path, name);
    if (entry.size <= 0) {
      throw new Error(`The required service executable ${name} is empty.`);
    }
    if (metadata.platform !== "win32" && (entry.mode & 0o111) === 0) {
      throw new Error(`The required service executable ${name} is not executable.`);
    }
  }

  const smoke = await readJsonObject(smokePath, "smoke evidence");
  if (
    smoke.schemaVersion !== 1 ||
    smoke.platform !== metadata.platform ||
    smoke.architecture !== metadata.architecture ||
    smoke.productVersion !== metadata.productVersion ||
    !isObject(smoke.checks) ||
    requiredSmokeChecks.some((name) => smoke.checks[name] !== "passed") ||
    !isObject(smoke.checks.cleanShutdown) ||
    smoke.checks.cleanShutdown.status !== "passed" ||
    smoke.checks.cleanShutdown.markerObserved !== true ||
    smoke.checks.cleanShutdown.naturalExit !== true ||
    smoke.checks.cleanShutdown.exitCode !== 0 ||
    smoke.checks.cleanShutdown.shutdownTimedOut !== false ||
    smoke.checks.cleanShutdown.forcedTermination !== false
  ) {
    throw new Error("The bundle has no complete packaged smoke evidence.");
  }

  return Object.freeze({
    bundle: canonicalBundle,
    manifestSha256: sha256(Buffer.from(actualChecksums, "utf8")),
    platform: metadata.platform,
    architecture: metadata.architecture,
    productVersion: metadata.productVersion,
    supportStatus,
  });
}

export async function signReleaseBundle(options) {
  const inspection = await inspectBundleForPublisherSigning(options.bundle, {
    allowUnsupportedPreview: options.allowUnsupportedPreview === true,
  });
  const attestationPath = `${resolve(options.bundle)}.publisher-attestation.json`;
  const canonicalPrivateKey = await requireRegularFilePath(
    options.privateKey,
    "publisher private key",
  );
  const publicKeyDestination = await canonicalizeNewFilePath(
    options.publicKeyDestination,
    "publisher public-key destination",
  );
  const canonicalAttestationPath = await canonicalizeNewFilePath(
    attestationPath,
    "publisher attestation",
  );

  for (const [path, label] of [
    [canonicalPrivateKey, "publisher private key"],
    [publicKeyDestination, "publisher public-key destination"],
    [canonicalAttestationPath, "publisher attestation"],
  ]) {
    if (isPathInside(inspection.bundle, path)) {
      throw new Error(`${label} must remain outside the signed bundle.`);
    }
  }
  if (
    samePath(canonicalPrivateKey, publicKeyDestination) ||
    samePath(canonicalPrivateKey, canonicalAttestationPath) ||
    samePath(publicKeyDestination, canonicalAttestationPath)
  ) {
    throw new Error("Publisher signing inputs and outputs must use distinct paths.");
  }
  await assertPathAbsent(publicKeyDestination, "publisher public-key destination");
  await assertPathAbsent(canonicalAttestationPath, "publisher attestation");

  const privateKeyBytes = await readFile(canonicalPrivateKey);
  if (privateKeyBytes.length === 0 || privateKeyBytes.length > maximumPrivateKeyBytes) {
    throw new Error("The publisher private key is empty or oversized.");
  }
  if (process.platform !== "win32") {
    const keyMetadata = await stat(canonicalPrivateKey);
    if ((keyMetadata.mode & 0o077) !== 0) {
      throw new Error("The publisher private-key file must not be accessible by group or others.");
    }
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch (error) {
    throw new Error("The publisher private key is unreadable.", { cause: error });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The publisher private key must be Ed25519.");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${sha256(Buffer.from(publicKeyDer))}`;
  const signature = createSignature(
    null,
    publisherSignatureInput(inspection.manifestSha256),
    privateKey,
  ).toString("base64url");
  const attestation = `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "OpenDelegate",
      algorithm: "ed25519",
      keyId,
      manifestSha256: inspection.manifestSha256,
      signature,
    },
    null,
    2,
  )}\n`;
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });

  let publicKeyFile;
  let attestationFile;
  let publicKeyCreated = false;
  let attestationCreated = false;
  try {
    publicKeyFile = await open(publicKeyDestination, "wx", 0o644);
    publicKeyCreated = true;
    try {
      attestationFile = await open(canonicalAttestationPath, "wx", 0o644);
      attestationCreated = true;
    } catch (error) {
      await publicKeyFile.close();
      publicKeyFile = undefined;
      await removeNewSigningOutput(publicKeyDestination);
      publicKeyCreated = false;
      throw error;
    }
    await publicKeyFile.writeFile(publicKeyPem);
    await publicKeyFile.sync();
    await publicKeyFile.close();
    publicKeyFile = undefined;
    await attestationFile.writeFile(attestation);
    await attestationFile.sync();
    await attestationFile.close();
    attestationFile = undefined;
    if (process.platform !== "win32") {
      await Promise.all([
        chmod(publicKeyDestination, 0o644),
        chmod(canonicalAttestationPath, 0o644),
      ]);
    }
  } catch (error) {
    await Promise.allSettled([publicKeyFile?.close(), attestationFile?.close()]);
    publicKeyFile = undefined;
    attestationFile = undefined;
    await Promise.allSettled([
      publicKeyCreated ? removeNewSigningOutput(publicKeyDestination) : undefined,
      attestationCreated ? removeNewSigningOutput(canonicalAttestationPath) : undefined,
    ]);
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("A publisher signing output already exists; nothing was overwritten.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await Promise.allSettled([publicKeyFile?.close(), attestationFile?.close()]);
  }

  return Object.freeze({
    ...inspection,
    attestationPath: canonicalAttestationPath,
    keyId,
    publicKeyPath: publicKeyDestination,
  });
}

async function readJsonObject(path, label) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) {
      throw new TypeError(`${label} is not an object.`);
    }
    return value;
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON.`, { cause: error });
  }
}

async function requireRegularDirectory(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular, non-linked directory.`);
  }
  return realpath(path);
}

async function requireRegularFile(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular, non-linked file.`);
  }
  return metadata;
}

async function requireRegularFilePath(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  await requireRegularFile(path, label);
  return realpath(path);
}

async function canonicalizeNewFilePath(path, label) {
  if (!isAbsolute(path)) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  const parent = await realpath(dirname(path));
  const candidate = resolve(parent, basename(path));
  if (candidate === parent) {
    throw new Error(`The ${label} has no file name.`);
  }
  return candidate;
}

async function removeNewSigningOutput(path) {
  try {
    const file = await open(path, "r+");
    const metadata = await file.stat();
    await file.close();
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      await unlink(path);
    }
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertPathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`The ${label} already exists; nothing was overwritten.`);
}

function isPathInside(root, candidate) {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp() {
  process.stdout.write(`Sign a verified OpenDelegate platform bundle.

Usage:
  node tooling/sign-release.mjs --bundle ABSOLUTE_BUNDLE_PATH \\
    --private-key ABSOLUTE_ED25519_PRIVATE_KEY_PATH \\
    --public-key-destination ABSOLUTE_NEW_PUBLIC_KEY_PATH

Unsupported internal previews additionally require --allow-unsupported-preview.
The detached attestation is written beside the bundle. Existing files are never
overwritten, private keys are never copied, and signing does not promote a candidate
to a released channel.
`);
}

if (await isDirectReleaseInvocation(process.argv[1], currentFile)) {
  try {
    const options = parsePublisherSigningArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = await signReleaseBundle(options);
      process.stdout.write(
        `${JSON.stringify(
          {
            attestationPath: result.attestationPath,
            keyId: result.keyId,
            manifestSha256: result.manifestSha256,
            publicKeyPath: result.publicKeyPath,
            supportStatus: result.supportStatus,
          },
          null,
          2,
        )}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
