import { PROTOCOL_VERSION, ProtocolValidationError } from "./validation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UPLOAD_CREDENTIAL = /^u1\.([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\.[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ArtifactUploadGrantV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly uploadId: string;
  readonly artifactId: string;
  readonly uploadUrl: string;
  readonly credential: string;
  readonly expiresAtMs: number;
  readonly maximumChunkBytes: number;
  readonly declaredSizeBytes: number;
  readonly expectedSha256: string;
}

export interface ArtifactUploadProgressV1 {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly uploadId: string;
  readonly artifactId: string;
  readonly nextOffsetBytes: number;
  readonly complete: boolean;
  readonly replayed: boolean;
}

export function parseArtifactUploadGrant(input: unknown): ArtifactUploadGrantV1 {
  const record = exactRecord(input, [
    "protocolVersion",
    "uploadId",
    "artifactId",
    "uploadUrl",
    "credential",
    "expiresAtMs",
    "maximumChunkBytes",
    "declaredSizeBytes",
    "expectedSha256",
  ]);
  requireProtocolVersion(record["protocolVersion"]);
  const uploadId = identifier(record["uploadId"], "uploadId");
  const credential = text(record["credential"], "credential", 512);
  const credentialMatch = UPLOAD_CREDENTIAL.exec(credential);
  if (credentialMatch?.[1] !== uploadId) {
    invalid("credential", "Expected an upload-scoped credential.");
  }
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    uploadId,
    artifactId: identifier(record["artifactId"], "artifactId"),
    uploadUrl: uploadUrl(record["uploadUrl"], uploadId),
    credential,
    expiresAtMs: positiveSafeInteger(record["expiresAtMs"], "expiresAtMs"),
    maximumChunkBytes: positiveSafeInteger(record["maximumChunkBytes"], "maximumChunkBytes"),
    declaredSizeBytes: nonNegativeSafeInteger(record["declaredSizeBytes"], "declaredSizeBytes"),
    expectedSha256: sha256(record["expectedSha256"], "expectedSha256"),
  });
}

export function parseArtifactUploadProgress(input: unknown): ArtifactUploadProgressV1 {
  const record = exactRecord(input, [
    "protocolVersion",
    "uploadId",
    "artifactId",
    "nextOffsetBytes",
    "complete",
    "replayed",
  ]);
  requireProtocolVersion(record["protocolVersion"]);
  if (typeof record["complete"] !== "boolean") {
    invalid("complete", "Expected a boolean.");
  }
  if (typeof record["replayed"] !== "boolean") {
    invalid("replayed", "Expected a boolean.");
  }
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    uploadId: identifier(record["uploadId"], "uploadId"),
    artifactId: identifier(record["artifactId"], "artifactId"),
    nextOffsetBytes: nonNegativeSafeInteger(record["nextOffsetBytes"], "nextOffsetBytes"),
    complete: record["complete"],
    replayed: record["replayed"],
  });
}

function uploadUrl(value: unknown, uploadId: string): string {
  const textValue = text(value, "uploadUrl", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(textValue);
  } catch {
    invalid("uploadUrl", "Expected an absolute upload URL.");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) ||
    parsed.pathname !== `/worker-uploads/${encodeURIComponent(uploadId)}` ||
    textValue !== parsed.href
  ) {
    invalid("uploadUrl", "Expected a credential-free HTTPS upload URL (or loopback HTTP URL).");
  }
  return textValue;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid("", "Expected an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...expectedKeys].sort().join(",")) {
    invalid("", "Expected the exact Artifact upload contract.");
  }
  return record;
}

function requireProtocolVersion(value: unknown): void {
  if (value !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "UNKNOWN_PROTOCOL_VERSION",
      "protocolVersion",
      `Expected protocolVersion ${PROTOCOL_VERSION}.`,
    );
  }
}

function identifier(value: unknown, path: string): string {
  const parsed = text(value, path, 256);
  if (!IDENTIFIER.test(parsed)) {
    invalid(path, "Expected an identifier.");
  }
  return parsed;
}

function text(value: unknown, path: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    containsControl(value)
  ) {
    invalid(path, "Expected bounded text without control characters.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid(path, "Expected a positive safe integer.");
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, "Expected a non-negative safe integer.");
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
  if (!SHA256.test(parsed)) {
    invalid(path, "Expected a lowercase SHA-256 digest.");
  }
  return parsed;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function invalid(path: string, message: string): never {
  throw new ProtocolValidationError("INVALID_CONTRACT", path, message);
}
