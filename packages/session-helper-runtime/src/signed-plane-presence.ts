import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  SessionHelperPeerPublicKey,
  SessionHelperSigningKeyProvider,
} from "@opendelegate/session-helper-ipc";

const CORE_PRESENCE_FILENAME = "core-plane-v2.json";
const HELPER_PRESENCE_FILENAME = "helper-plane-v2.json";
const MAX_PRESENCE_BYTES = 64 * 1024;
const CORE_PRESENCE_LABEL = Buffer.from(
  "OpenDelegate signed session-helper presence v2\0core\0",
  "utf8",
);
const HELPER_PRESENCE_LABEL = Buffer.from(
  "OpenDelegate signed session-helper presence v2\0helper\0",
  "utf8",
);

interface PresenceBase {
  readonly schemaVersion: 2;
  readonly protocolVersion: 2;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly releaseVersion: string;
  readonly processId: number;
  readonly updatedAtUnixMs: number;
}

export interface CorePlanePresence extends PresenceBase {
  readonly plane: "core";
  readonly serviceEpoch: number;
  readonly keyId: `sha256:${string}`;
}

export interface HelperPlanePresence extends PresenceBase {
  readonly plane: "session-helper";
  readonly helperInstanceId: string;
  readonly sessionId: string;
  readonly keyId: `sha256:${string}`;
}

interface SignedPresence<T extends CorePlanePresence | HelperPlanePresence> {
  readonly payload: T;
  readonly signature: string;
}

export interface WriteSignedPlanePresenceOptions<
  T extends CorePlanePresence | HelperPlanePresence,
> {
  readonly runtimeRoot: string;
  readonly payload: T;
  readonly privateKeyReference: string;
  readonly signingKeyProvider: SessionHelperSigningKeyProvider;
}

export interface ReadSignedPlanePresenceOptions {
  readonly runtimeRoot: string;
  readonly expected: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly releaseVersion: string;
  };
  readonly peerKey: SessionHelperPeerPublicKey;
  readonly processIsAlive?: (processId: number) => boolean | Promise<boolean>;
}

export interface OwnedPlanePresence {
  readonly path: string;
  remove(): Promise<void>;
}

export async function writeCorePlanePresence(
  options: WriteSignedPlanePresenceOptions<CorePlanePresence>,
): Promise<OwnedPlanePresence> {
  return await writePresence(options, CORE_PRESENCE_FILENAME, CORE_PRESENCE_LABEL);
}

export async function writeHelperPlanePresence(
  options: WriteSignedPlanePresenceOptions<HelperPlanePresence>,
): Promise<OwnedPlanePresence> {
  return await writePresence(options, HELPER_PRESENCE_FILENAME, HELPER_PRESENCE_LABEL);
}

export async function readCorePlanePresence(
  options: ReadSignedPlanePresenceOptions,
): Promise<CorePlanePresence | null> {
  return await readPresence(
    options,
    CORE_PRESENCE_FILENAME,
    CORE_PRESENCE_LABEL,
    parseCorePresence,
  );
}

export async function readHelperPlanePresence(
  options: ReadSignedPlanePresenceOptions,
): Promise<HelperPlanePresence | null> {
  return await readPresence(
    options,
    HELPER_PRESENCE_FILENAME,
    HELPER_PRESENCE_LABEL,
    parseHelperPresence,
  );
}

async function writePresence<T extends CorePlanePresence | HelperPlanePresence>(
  options: WriteSignedPlanePresenceOptions<T>,
  filename: string,
  label: Buffer,
): Promise<OwnedPlanePresence> {
  const runtimeRoot = requireAbsoluteRoot(options.runtimeRoot);
  validatePresenceBase(options.payload);
  const bytes = signatureInput(label, options.payload);
  let signature: Buffer;
  try {
    signature = await options.signingKeyProvider.sign(
      options.privateKeyReference,
      options.payload.keyId,
      bytes,
    );
  } finally {
    bytes.fill(0);
  }
  if (!Buffer.isBuffer(signature) || signature.length !== 64) {
    signature?.fill(0);
    throw new Error("The signed plane presence could not be created.");
  }
  const path = join(runtimeRoot, filename);
  const temporaryPath = join(runtimeRoot, `.${filename}.${process.pid}.${Date.now()}.tmp`);
  const encoded = Buffer.from(
    JSON.stringify({
      payload: options.payload,
      signature: signature.toString("base64url"),
    }),
    "utf8",
  );
  signature.fill(0);
  if (encoded.length === 0 || encoded.length > MAX_PRESENCE_BYTES) {
    encoded.fill(0);
    throw new Error("The signed plane presence exceeds its bound.");
  }
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    encoded.fill(0);
  }
  const expectedPayload = JSON.stringify(options.payload);
  return Object.freeze({
    path,
    async remove() {
      try {
        const current = await readBoundedStable(path);
        const parsed = parseEnvelope(current, (value) =>
          options.payload.plane === "core" ? parseCorePresence(value) : parseHelperPresence(value),
        );
        if (JSON.stringify(parsed.payload) === expectedPayload) {
          await rm(path);
        }
      } catch {
        // Never remove a replacement presence record that this process does not own.
      }
    },
  });
}

async function readPresence<T extends CorePlanePresence | HelperPlanePresence>(
  options: ReadSignedPlanePresenceOptions,
  filename: string,
  label: Buffer,
  parser: (value: unknown) => T,
): Promise<T | null> {
  const runtimeRoot = requireAbsoluteRoot(options.runtimeRoot);
  try {
    const envelope = parseEnvelope(await readBoundedStable(join(runtimeRoot, filename)), parser);
    if (
      envelope.payload.instanceId !== options.expected.instanceId ||
      envelope.payload.deviceId !== options.expected.deviceId ||
      envelope.payload.releaseVersion !== options.expected.releaseVersion ||
      envelope.payload.keyId !== options.peerKey.keyId
    ) {
      return null;
    }
    const peer = parsePeerKey(options.peerKey);
    const input = signatureInput(label, envelope.payload);
    const signature = decodeSignature(envelope.signature);
    let verified = false;
    try {
      verified = verifySignature(null, input, peer, signature);
    } finally {
      input.fill(0);
      signature.fill(0);
    }
    if (!verified) {
      return null;
    }
    const alive = await (options.processIsAlive ?? defaultProcessIsAlive)(
      envelope.payload.processId,
    );
    return alive ? envelope.payload : null;
  } catch {
    return null;
  }
}

function parseEnvelope<T extends CorePlanePresence | HelperPlanePresence>(
  value: Buffer,
  parser: (payload: unknown) => T,
): SignedPresence<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } finally {
    value.fill(0);
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["payload", "signature"]) ||
    typeof parsed.signature !== "string" ||
    !isEncodedSignature(parsed.signature)
  ) {
    throw new Error("The signed plane presence is invalid.");
  }
  return { payload: parser(parsed.payload), signature: parsed.signature };
}

function parseCorePresence(value: unknown): CorePlanePresence {
  const record = parsePresenceBase(value, ["serviceEpoch", "keyId"]);
  if (
    record.plane !== "core" ||
    !isPositiveInteger(record.serviceEpoch) ||
    !isKeyId(record.keyId)
  ) {
    throw new Error("The core plane presence is invalid.");
  }
  return Object.freeze(record as unknown as CorePlanePresence);
}

function parseHelperPresence(value: unknown): HelperPlanePresence {
  const record = parsePresenceBase(value, ["helperInstanceId", "sessionId", "keyId"]);
  if (
    record.plane !== "session-helper" ||
    !isIdentifier(record.helperInstanceId) ||
    !isIdentifier(record.sessionId) ||
    !isKeyId(record.keyId)
  ) {
    throw new Error("The helper plane presence is invalid.");
  }
  return Object.freeze(record as unknown as HelperPlanePresence);
}

function parsePresenceBase(
  value: unknown,
  additionalKeys: readonly string[],
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "protocolVersion",
      "plane",
      "instanceId",
      "deviceId",
      "releaseVersion",
      "processId",
      "updatedAtUnixMs",
      ...additionalKeys,
    ]) ||
    value.schemaVersion !== 2 ||
    value.protocolVersion !== 2 ||
    !isIdentifier(value.instanceId) ||
    !isIdentifier(value.deviceId) ||
    !isIdentifier(value.releaseVersion) ||
    !isPositiveInteger(value.processId) ||
    !Number.isSafeInteger(value.updatedAtUnixMs) ||
    typeof value.updatedAtUnixMs !== "number" ||
    value.updatedAtUnixMs < 0
  ) {
    throw new Error("The signed plane presence is invalid.");
  }
  return value;
}

function validatePresenceBase(value: CorePlanePresence | HelperPlanePresence): void {
  if (
    value.schemaVersion !== 2 ||
    value.protocolVersion !== 2 ||
    !isIdentifier(value.instanceId) ||
    !isIdentifier(value.deviceId) ||
    !isIdentifier(value.releaseVersion) ||
    !isPositiveInteger(value.processId) ||
    !Number.isSafeInteger(value.updatedAtUnixMs) ||
    value.updatedAtUnixMs < 0 ||
    !isKeyId(value.keyId) ||
    (value.plane === "core"
      ? !isPositiveInteger(value.serviceEpoch)
      : !isIdentifier(value.helperInstanceId) || !isIdentifier(value.sessionId))
  ) {
    throw new TypeError("The signed plane presence payload is invalid.");
  }
}

async function readBoundedStable(path: string): Promise<Buffer> {
  const canonical = await realpath(path);
  if (!samePath(canonical, resolve(path))) {
    throw new Error("The signed plane presence may not be linked.");
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_PRESENCE_BYTES
    ) {
      throw new Error("The signed plane presence is unsafe.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      bytes.fill(0);
      throw new Error("The signed plane presence changed while it was read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parsePeerKey(pin: SessionHelperPeerPublicKey): KeyObject {
  if (pin.usage !== "active" || pin.consumeMigration !== undefined || !isKeyId(pin.keyId)) {
    throw new Error("The plane presence requires the active peer key.");
  }
  const spki = Buffer.from(pin.publicKeySpkiBase64Url, "base64url");
  try {
    if (
      spki.length === 0 ||
      spki.length > 256 ||
      spki.toString("base64url") !== pin.publicKeySpkiBase64Url
    ) {
      throw new Error("encoding");
    }
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    const actual = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
    if (key.asymmetricKeyType !== "ed25519" || actual !== pin.keyId) {
      throw new Error("binding");
    }
    return key;
  } finally {
    spki.fill(0);
  }
}

function signatureInput(label: Buffer, payload: unknown): Buffer {
  return Buffer.concat([label, Buffer.from(JSON.stringify(payload), "utf8")]);
}

function decodeSignature(value: string): Buffer {
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    signature.fill(0);
    throw new Error("The plane presence signature is invalid.");
  }
  return signature;
}

function isEncodedSignature(value: string): boolean {
  try {
    const signature = decodeSignature(value);
    signature.fill(0);
    return true;
  } catch {
    return false;
  }
}

function requireAbsoluteRoot(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("The signed plane runtime root must be absolute.");
  }
  return resolve(value);
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error: unknown) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isKeyId(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
