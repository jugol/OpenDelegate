import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const MAXIMUM_GRANT_FILE_BYTES = 65_536;
const MAXIMUM_CERTIFICATE_BYTES = 32_768;
const MAXIMUM_ENDPOINTS = 16;

export interface EnrollmentGrantFileDocument {
  readonly schemaVersion: 1;
  readonly grantId: string;
  readonly token: string;
  readonly deviceId: string;
  readonly mainDeviceId: string;
  readonly expectedMainSpkiSha256: string;
  readonly certificateAuthorityPem: string;
  readonly enrollmentUrl: string;
  readonly channelEndpoints: readonly EnrollmentChannelEndpoint[];
  readonly protocolRange: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly expiresAt: number;
}

export interface EnrollmentChannelEndpoint {
  readonly endpointId: string;
  readonly label: string;
  readonly kind: "https" | "wss";
  readonly url: string;
}

export interface EnrollmentGrantFileOptions {
  readonly sourceCheckoutRoot: string;
  readonly clock?: { now(): number };
}

export type EnrollmentGrantFileErrorCode =
  "GRANT_EXECUTOR_FAILED" | "GRANT_FILE_INVALID" | "GRANT_FILE_UNAVAILABLE" | "GRANT_FILE_UNSAFE";

export class EnrollmentGrantFileError extends Error {
  public readonly code: EnrollmentGrantFileErrorCode;

  public constructor(code: EnrollmentGrantFileErrorCode, message: string) {
    super(message);
    this.name = "EnrollmentGrantFileError";
    this.code = code;
  }
}

export async function executeWithEnrollmentGrantFile<TResult>(
  grantFilePath: string,
  options: EnrollmentGrantFileOptions,
  executor: (grant: EnrollmentGrantFileDocument) => TResult | Promise<TResult>,
): Promise<TResult> {
  const sourceCheckoutRoot = validateAbsolutePath(
    options.sourceCheckoutRoot,
    "source checkout root",
  );
  const grantPath = validateAbsolutePath(grantFilePath, "Enrollment Grant file");
  assertOutside(sourceCheckoutRoot, grantPath);
  const now = readClock(options.clock ?? { now: () => Date.now() });
  let handle;
  let bytes: Buffer | undefined;
  let before:
    | {
        readonly dev: number;
        readonly ino: number;
        readonly pathDev: number;
        readonly pathIno: number;
        readonly size: number;
        readonly mtimeMs: number;
      }
    | undefined;
  try {
    const pathMetadata = await lstat(grantPath);
    if (!isRestrictedRegularFile(pathMetadata)) {
      throw grantError("GRANT_FILE_UNSAFE", "The Enrollment Grant file is not safe to open.");
    }
    const canonical = await realpath(grantPath);
    if (!pathsEqual(canonical, grantPath)) {
      throw grantError("GRANT_FILE_UNSAFE", "The Enrollment Grant file path is not canonical.");
    }
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(grantPath, flags);
    const metadata = await handle.stat();
    if (
      !isRestrictedRegularFile(metadata) ||
      metadata.size <= 0 ||
      metadata.size > MAXIMUM_GRANT_FILE_BYTES ||
      (process.platform !== "win32" &&
        (metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino))
    ) {
      throw grantError("GRANT_FILE_UNSAFE", "The Enrollment Grant file changed while opening.");
    }
    before = {
      dev: metadata.dev,
      ino: metadata.ino,
      pathDev: pathMetadata.dev,
      pathIno: pathMetadata.ino,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
    };
    bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      afterRead.dev !== before.dev ||
      afterRead.ino !== before.ino ||
      afterRead.size !== before.size ||
      afterRead.mtimeMs !== before.mtimeMs
    ) {
      throw grantError("GRANT_FILE_UNSAFE", "The Enrollment Grant file changed while reading.");
    }
  } catch (error) {
    if (error instanceof EnrollmentGrantFileError) {
      throw error;
    }
    if (isNodeError(error, "ENOENT")) {
      throw grantError("GRANT_FILE_UNAVAILABLE", "The Enrollment Grant file is unavailable.");
    }
    throw grantError("GRANT_FILE_UNSAFE", "The Enrollment Grant file could not be read safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let grant: EnrollmentGrantFileDocument;
  try {
    grant = parseEnrollmentGrantFile(bytes, now);
  } finally {
    bytes.fill(0);
  }

  let result: TResult;
  try {
    result = await executor(grant);
  } catch {
    throw grantError(
      "GRANT_EXECUTOR_FAILED",
      "Enrollment did not complete; the local Grant file was retained for a bounded retry.",
    );
  }

  try {
    const metadata = await lstat(grantPath);
    if (
      before === undefined ||
      !isRestrictedRegularFile(metadata) ||
      metadata.dev !== before.pathDev ||
      metadata.ino !== before.pathIno ||
      metadata.size !== before.size ||
      metadata.mtimeMs !== before.mtimeMs
    ) {
      throw grantError(
        "GRANT_FILE_UNSAFE",
        "Enrollment completed, but the Grant file changed before cleanup.",
      );
    }
    await rm(grantPath);
  } catch (error) {
    if (error instanceof EnrollmentGrantFileError) {
      throw error;
    }
    throw grantError(
      "GRANT_FILE_UNSAFE",
      "Enrollment completed, but the Grant file could not be removed safely.",
    );
  }
  return result;
}

export function parseEnrollmentGrantFile(
  bytes: Uint8Array,
  now = Date.now(),
): EnrollmentGrantFileDocument {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAXIMUM_GRANT_FILE_BYTES
  ) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant file size is invalid.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant file is not valid JSON.");
  }
  const record = readRecord(value);
  assertExactKeys(record, [
    "schemaVersion",
    "grantId",
    "token",
    "deviceId",
    "mainDeviceId",
    "expectedMainSpkiSha256",
    "certificateAuthorityPem",
    "enrollmentUrl",
    "channelEndpoints",
    "protocolRange",
    "expiresAt",
  ]);
  if (
    record["schemaVersion"] !== 1 ||
    typeof record["grantId"] !== "string" ||
    !/^grant_[A-Za-z0-9_-]{22}$/u.test(record["grantId"]) ||
    typeof record["token"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["token"]) ||
    typeof record["expectedMainSpkiSha256"] !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(record["expectedMainSpkiSha256"])
  ) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant identity fields are invalid.");
  }
  const certificateAuthorityPem = readCertificate(record["certificateAuthorityPem"]);
  const protocolRange = readRecord(record["protocolRange"]);
  assertExactKeys(protocolRange, ["minimum", "maximum"]);
  const minimum = readProtocolVersion(protocolRange["minimum"]);
  const maximum = readProtocolVersion(protocolRange["maximum"]);
  if (minimum > maximum || minimum > 1 || maximum < 1) {
    throw grantError(
      "GRANT_FILE_INVALID",
      "The Enrollment Grant does not support this protocol version.",
    );
  }
  const expiresAt = readTimestamp(record["expiresAt"]);
  if (expiresAt <= readTimestamp(now)) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant has expired.");
  }
  const channelEndpoints = readEndpoints(record["channelEndpoints"]);
  return deepFreeze({
    schemaVersion: 1 as const,
    grantId: record["grantId"],
    token: record["token"],
    deviceId: readDeviceId(record["deviceId"]),
    mainDeviceId: readDeviceId(record["mainDeviceId"]),
    expectedMainSpkiSha256: record["expectedMainSpkiSha256"],
    certificateAuthorityPem,
    enrollmentUrl: readSecureUrl(record["enrollmentUrl"], "https:"),
    channelEndpoints,
    protocolRange: { minimum, maximum },
    expiresAt,
  });
}

function readEndpoints(value: unknown): readonly EnrollmentChannelEndpoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_ENDPOINTS) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant channel endpoints are invalid.");
  }
  const endpointIds = new Set<string>();
  return value.map((entry) => {
    const record = readRecord(entry);
    assertExactKeys(record, ["endpointId", "label", "kind", "url"]);
    const endpointId = readIdentifier(record["endpointId"]);
    if (endpointIds.has(endpointId)) {
      throw grantError("GRANT_FILE_INVALID", "Enrollment Grant endpoint IDs must be unique.");
    }
    endpointIds.add(endpointId);
    if (record["kind"] !== "https" && record["kind"] !== "wss") {
      throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant endpoint kind is invalid.");
    }
    return {
      endpointId,
      label: readIdentifier(record["label"]),
      kind: record["kind"],
      url: readSecureUrl(record["url"], record["kind"] === "wss" ? "wss:" : "https:"),
    };
  });
}

function readSecureUrl(value: unknown, protocol: "https:" | "wss:"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant URL is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant URL is invalid.");
  }
  if (
    parsed.protocol !== protocol ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant URL is unsafe.");
  }
  return value;
}

function readCertificate(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CERTIFICATE_BYTES ||
    !value.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !value.trimEnd().endsWith("-----END CERTIFICATE-----") ||
    value.includes("PRIVATE KEY")
  ) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant CA certificate is invalid.");
  }
  return value;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant field shape is invalid.");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant field set is invalid.");
  }
}

function readDeviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant Device ID is invalid.");
  }
  return value;
}

function readIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw grantError("GRANT_FILE_INVALID", "An Enrollment Grant identifier is invalid.");
  }
  return value;
}

function readProtocolVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 65_535) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant protocol range is invalid.");
  }
  return value as number;
}

function readTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8.64e15) {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant timestamp is invalid.");
  }
  return value as number;
}

function readClock(clock: { now(): number }): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw grantError("GRANT_FILE_INVALID", "The Enrollment Grant clock is unavailable.");
  }
  return readTimestamp(now);
}

function isRestrictedRegularFile(metadata: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mode: number;
  nlink: number;
}): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    (process.platform === "win32" || (metadata.mode & 0o077) === 0)
  );
}

function assertOutside(parent: string, child: string): void {
  const relationship = relative(resolve(parent), resolve(child));
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw grantError(
      "GRANT_FILE_UNSAFE",
      "The Enrollment Grant file must remain outside the source checkout.",
    );
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw grantError("GRANT_FILE_UNSAFE", `The ${label} path is invalid.`);
  }
  return resolve(value);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function grantError(code: EnrollmentGrantFileErrorCode, message: string): EnrollmentGrantFileError {
  return new EnrollmentGrantFileError(code, message);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
