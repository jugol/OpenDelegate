import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAXIMUM_TIMEOUT_MS = 60_000;
const MAXIMUM_SIGNING_BYTES = 4 * 1024 * 1024;
const MAXIMUM_SIGNER_OUTPUT_BYTES = 64 * 1024;
const MAXIMUM_TOOL_BYTES = 512 * 1024 * 1024;
const MAXIMUM_PUBLIC_KEY_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

export async function invokePinnedReleaseSigner(input) {
  requireExactKeys(
    input,
    ["executable", "invocationArtifacts", "publicKeyPem", "signingBytes", "timeoutMs"],
    "release signer input",
    new Set(["timeoutMs"]),
  );
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
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error(
      `The external signer timeout must be an integer between 100 and ${MAXIMUM_TIMEOUT_MS}.`,
    );
  }
  if (!Array.isArray(input.invocationArtifacts)) {
    throw new Error("The signer invocation artifacts must be an array.");
  }

  const publicKey = parseEd25519PublicKey(publicKeyBytes);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const expectedKeyId = `sha256:${sha256(Buffer.from(publicKeyDer))}`;
  const executable = await inspectPinnedFile(input.executable, "signer executable", true);
  const invocationArtifacts = [];
  for (const artifact of input.invocationArtifacts) {
    invocationArtifacts.push(
      await inspectPinnedFile(artifact, "signer invocation artifact", false),
    );
  }
  assertDistinctInvocationPaths(executable, invocationArtifacts);

  const stdout = await runSignerProcess({
    arguments: invocationArtifacts.map((artifact) => artifact.path),
    executable: executable.path,
    signingBytes,
    timeoutMs,
  });

  await inspectPinnedFile(executable, "signer executable", true);
  for (const artifact of invocationArtifacts) {
    await inspectPinnedFile(artifact, "signer invocation artifact", false);
  }

  const response = parseSignerResponse(stdout);
  if (response.keyId !== expectedKeyId) {
    throw new Error("The external signer response key ID does not match the external trust root.");
  }
  if (
    !verifySignature(null, signingBytes, publicKey, Buffer.from(response.signature, "base64url"))
  ) {
    throw new Error(
      "The external signer response signature does not verify against the external trust root.",
    );
  }

  const frozenExecutable = Object.freeze({ ...executable });
  const frozenArtifacts = Object.freeze(
    invocationArtifacts.map((artifact) => Object.freeze({ ...artifact })),
  );
  return Object.freeze({
    algorithm: "ed25519",
    keyId: response.keyId,
    runner: Object.freeze({
      executable: frozenExecutable,
      invocationArtifacts: frozenArtifacts,
    }),
    signature: response.signature,
  });
}

async function inspectPinnedFile(value, label, requireExecutable) {
  requireExactKeys(value, ["path", "sha256"], label);
  if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.includes("\0")) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`The ${label} SHA-256 pin must be lowercase hexadecimal.`);
  }

  const before = await lstat(value.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular, non-linked file.`);
  }
  const canonicalPath = await realpath(value.path);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !sameFile(before, opened) ||
      opened.size <= 0n ||
      opened.size > BigInt(MAXIMUM_TOOL_BYTES)
    ) {
      throw new Error(`The ${label} changed or has an unsupported size.`);
    }
    if (requireExecutable && process.platform !== "win32" && (opened.mode & 0o111n) === 0n) {
      throw new Error(`The ${label} is not executable.`);
    }
    const digest = await hashOpenFile(handle, Number(opened.size));
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error(`The ${label} changed while it was being hashed.`);
    }
    if (digest !== value.sha256) {
      throw new Error(`The ${label} SHA-256 does not match its required pin.`);
    }
    return Object.freeze({ path: canonicalPath, sha256: digest });
  } finally {
    await handle.close();
  }
}

async function hashOpenFile(handle, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) {
      throw new Error("A pinned release signer file ended before its declared size.");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function assertDistinctInvocationPaths(executable, artifacts) {
  const seen = new Set([comparablePath(executable.path)]);
  for (const artifact of artifacts) {
    const key = comparablePath(artifact.path);
    if (seen.has(key)) {
      throw new Error("The signer invocation paths must be distinct.");
    }
    seen.add(key);
  }
}

async function runSignerProcess(input) {
  const child = spawn(input.executable, input.arguments, {
    cwd: dirname(input.executable),
    env: sanitizedSignerEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let launchError;
  let inputError;
  let outputOverflow = false;
  let timedOut = false;

  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > MAXIMUM_SIGNER_OUTPUT_BYTES) {
      outputOverflow = true;
      child.kill();
      return;
    }
    stdoutChunks.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > MAXIMUM_SIGNER_OUTPUT_BYTES) {
      outputOverflow = true;
      child.kill();
    }
  });
  child.stdin.once("error", (error) => {
    inputError = error;
  });
  child.stdin.end(input.signingBytes);

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, input.timeoutMs);
  timer.unref();
  const completion = await new Promise((resolvePromise) => {
    child.once("error", (error) => {
      launchError = error;
    });
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
  clearTimeout(timer);

  if (timedOut) {
    throw new Error("The external release signer exceeded its bounded timeout.");
  }
  if (outputOverflow) {
    throw new Error("The external release signer emitted oversized output.");
  }
  if (launchError !== undefined) {
    throw new Error("The pinned external release signer could not be started.", {
      cause: launchError,
    });
  }
  if (completion.code !== 0) {
    throw new Error(
      `The external release signer failed with exit code ${String(completion.code)} and no diagnostics were exposed.`,
      inputError === undefined ? undefined : { cause: inputError },
    );
  }
  if (inputError !== undefined) {
    throw new Error("The external release signer did not consume its complete input.", {
      cause: inputError,
    });
  }
  return Buffer.concat(stdoutChunks, stdoutBytes);
}

function parseSignerResponse(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("The external signer response is not valid UTF-8.", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("The external signer response is not canonical JSON.", {
      cause: error,
    });
  }
  const canonicalKeys = ["schemaVersion", "algorithm", "keyId", "signature"];
  requireExactKeys(value, canonicalKeys, "external signer response");
  if (
    Object.keys(value).some((key, index) => key !== canonicalKeys[index]) ||
    `${JSON.stringify(value)}\n` !== text
  ) {
    throw new Error("The external signer response is not canonical JSON.");
  }
  if (
    value.schemaVersion !== 1 ||
    value.algorithm !== "ed25519" ||
    typeof value.keyId !== "string" ||
    !KEY_ID_PATTERN.test(value.keyId) ||
    typeof value.signature !== "string" ||
    !ED25519_SIGNATURE_PATTERN.test(value.signature)
  ) {
    throw new Error("The external signer response fields are invalid.");
  }
  return value;
}

function parseEd25519PublicKey(bytes) {
  try {
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("The key is not Ed25519.");
    }
    return key;
  } catch (error) {
    throw new Error("The external signer trust root is not a valid Ed25519 public key.", {
      cause: error,
    });
  }
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

function sameFile(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function comparablePath(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sanitizedSignerEnvironment() {
  const environment = {
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"]) {
      const value = process.env[name];
      if (typeof value === "string" && value !== "") {
        environment[name] = value;
      }
    }
  }
  return environment;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
