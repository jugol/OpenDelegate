import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type {
  ConfiguredReleaseResolution,
  ReleaseArchitecture,
  ReleasePlatform,
} from "@opendelegate/release-integrity";

import { ServiceCommandExecutionError } from "./service-command.ts";
import type { PlatformServiceConfiguration } from "./types.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QUALIFIED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface CandidateReleaseVerificationSeal {
  readonly schemaVersion: 1;
  readonly candidate: {
    readonly acceptanceLedgerSha256: string;
    readonly auditedSourceCommit: string;
    readonly buildCommit: string;
    readonly buildId: string;
    readonly candidateAttestationId: string;
    readonly checksumManifestSha256: string;
    readonly nativeComponentsSha256: string;
    readonly payloadManifestSha256: string;
    readonly platformAuthenticitySha256: string;
    readonly productVersion: string;
    readonly publisherStatementSha256: string;
    readonly releaseMetadataSha256: string;
    readonly target: {
      readonly architecture: ReleaseArchitecture;
      readonly platform: ReleasePlatform;
    };
  };
  readonly declaredChannel: "release-candidate";
  readonly effectiveChannel: "release-candidate" | "released";
  readonly external:
    | {
        readonly archiveSha256: string;
        readonly archiveSize: number;
        readonly configurationSha256: string;
        readonly publisherAttestationSha256: string;
        readonly publisherKeyId: string;
        readonly status: "publisher-verified";
      }
    | {
        readonly archiveSha256: string;
        readonly archiveSize: number;
        readonly configurationSha256: string;
        readonly promotionStatementId: string;
        readonly publisherAttestationSha256: string;
        readonly publisherKeyId: string;
        readonly receiptId: string;
        readonly status: "released";
      };
  readonly externalVerificationSha256: string;
}

export function createCandidateReleaseVerificationSeal(
  resolution: ConfiguredReleaseResolution,
): CandidateReleaseVerificationSeal {
  const { candidate, external } = resolution;
  if (
    resolution.declaredChannel !== "release-candidate" ||
    candidate.declaredChannel !== "release-candidate"
  ) {
    fail("The configured candidate has an invalid declared release channel.");
  }
  const sanitizedExternal =
    external.status === "publisher-verified"
      ? {
          archiveSha256: external.archive.sha256,
          archiveSize: external.archive.size,
          configurationSha256: requireSha256(
            external.configurationSha256,
            "release authority configuration",
          ),
          publisherAttestationSha256: external.publisherAttestationSha256,
          publisherKeyId: external.publisherKeyId,
          status: "publisher-verified" as const,
        }
      : external.status === "released"
        ? {
            archiveSha256: external.archive.sha256,
            archiveSize: external.archive.size,
            configurationSha256: requireSha256(
              external.configurationSha256,
              "release authority configuration",
            ),
            promotionStatementId: external.promotionStatementId,
            publisherAttestationSha256: external.publisherAttestationSha256,
            publisherKeyId: external.publisherKeyId,
            receiptId: external.receiptId,
            status: "released" as const,
          }
        : fail("The configured external release authority is not installable.");
  if (
    (sanitizedExternal.status === "publisher-verified" &&
      resolution.effectiveChannel !== "release-candidate") ||
    (sanitizedExternal.status === "released" && resolution.effectiveChannel !== "released")
  ) {
    fail("The configured release authority does not match the effective channel.");
  }
  validateExternal(sanitizedExternal);
  const candidateSeal = {
    acceptanceLedgerSha256: candidate.acceptanceLedgerSha256,
    auditedSourceCommit: candidate.auditedSourceCommit,
    buildCommit: candidate.buildCommit,
    buildId: candidate.buildId,
    candidateAttestationId: candidate.candidateAttestationId,
    checksumManifestSha256: candidate.checksumManifestSha256,
    nativeComponentsSha256: candidate.nativeComponentsSha256,
    payloadManifestSha256: candidate.payloadManifestSha256,
    platformAuthenticitySha256: candidate.platformAuthenticitySha256,
    productVersion: candidate.productVersion,
    publisherStatementSha256: candidate.publisherStatement.sha256,
    releaseMetadataSha256: candidate.releaseMetadataSha256,
    target: {
      architecture: candidate.target.architecture,
      platform: candidate.target.platform,
    },
  };
  validateCandidate(candidateSeal);
  return deepFreeze({
    schemaVersion: 1 as const,
    candidate: candidateSeal,
    declaredChannel: "release-candidate" as const,
    effectiveChannel: resolution.effectiveChannel,
    external: sanitizedExternal,
    externalVerificationSha256: sha256(canonicalJson(sanitizedExternal)),
  });
}

export function encodeCandidateReleaseVerificationSeal(
  seal: CandidateReleaseVerificationSeal,
): Buffer {
  validateSeal(seal);
  return Buffer.from(`${canonicalJson(seal)}\n`, "utf8");
}

export function parseCandidateReleaseVerificationSeal(
  bytes: Buffer,
): CandidateReleaseVerificationSeal {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    fail("The installed release verification seal has an invalid size.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail("The installed release verification seal is invalid.");
  }
  validateSeal(value);
  return deepFreeze(value);
}

export function assertCandidateReleaseVerificationSeal(
  expected: CandidateReleaseVerificationSeal,
  actual: CandidateReleaseVerificationSeal,
): void {
  validateSeal(expected);
  validateSeal(actual);
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    fail("The release verification seal no longer matches the authenticated candidate.");
  }
}

export function nativeReleaseVerificationSealPath(
  configuration: PlatformServiceConfiguration,
): string {
  const path = configuration.platform === "windows" ? win32 : posix;
  return path.join(
    configuration.paths.stateRoot,
    "release-verification",
    `${configuration.bundle.version}.json`,
  );
}

export function nativeReleaseVerificationSealDirectory(
  configuration: PlatformServiceConfiguration,
): string {
  const path = configuration.platform === "windows" ? win32 : posix;
  return path.join(configuration.paths.stateRoot, "release-verification");
}

function validateSeal(value: unknown): asserts value is CandidateReleaseVerificationSeal {
  const record = requireRecord(value, "release verification seal");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "candidate",
      "declaredChannel",
      "effectiveChannel",
      "external",
      "externalVerificationSha256",
    ],
    "release verification seal",
  );
  if (
    record["schemaVersion"] !== 1 ||
    record["declaredChannel"] !== "release-candidate" ||
    (record["effectiveChannel"] !== "release-candidate" &&
      record["effectiveChannel"] !== "released") ||
    typeof record["externalVerificationSha256"] !== "string" ||
    !SHA256_PATTERN.test(record["externalVerificationSha256"])
  ) {
    fail("The installed release verification seal header is invalid.");
  }
  const candidate = requireRecord(record["candidate"], "release verification candidate");
  validateCandidate(candidate);
  const external = requireRecord(record["external"], "release verification authority");
  validateExternal(external);
  if (
    (external["status"] === "publisher-verified" &&
      record["effectiveChannel"] !== "release-candidate") ||
    (external["status"] === "released" && record["effectiveChannel"] !== "released") ||
    sha256(canonicalJson(external)) !== record["externalVerificationSha256"]
  ) {
    fail("The installed release verification authority binding is invalid.");
  }
}

function validateCandidate(value: Readonly<Record<string, unknown>>): void {
  assertExactKeys(
    value,
    [
      "acceptanceLedgerSha256",
      "auditedSourceCommit",
      "buildCommit",
      "buildId",
      "candidateAttestationId",
      "checksumManifestSha256",
      "nativeComponentsSha256",
      "payloadManifestSha256",
      "platformAuthenticitySha256",
      "productVersion",
      "publisherStatementSha256",
      "releaseMetadataSha256",
      "target",
    ],
    "release verification candidate",
  );
  const target = requireRecord(value["target"], "release verification target");
  assertExactKeys(target, ["architecture", "platform"], "release verification target");
  if (
    typeof value["acceptanceLedgerSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["acceptanceLedgerSha256"]) ||
    typeof value["auditedSourceCommit"] !== "string" ||
    !COMMIT_PATTERN.test(value["auditedSourceCommit"]) ||
    typeof value["buildCommit"] !== "string" ||
    !COMMIT_PATTERN.test(value["buildCommit"]) ||
    typeof value["buildId"] !== "string" ||
    value["buildId"].length === 0 ||
    value["buildId"].length > 256 ||
    typeof value["candidateAttestationId"] !== "string" ||
    !EXTERNAL_ID_PATTERN.test(value["candidateAttestationId"]) ||
    typeof value["checksumManifestSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["checksumManifestSha256"]) ||
    typeof value["nativeComponentsSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["nativeComponentsSha256"]) ||
    typeof value["payloadManifestSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["payloadManifestSha256"]) ||
    typeof value["platformAuthenticitySha256"] !== "string" ||
    !SHA256_PATTERN.test(value["platformAuthenticitySha256"]) ||
    typeof value["productVersion"] !== "string" ||
    !SEMVER_PATTERN.test(value["productVersion"]) ||
    typeof value["publisherStatementSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["publisherStatementSha256"]) ||
    typeof value["releaseMetadataSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["releaseMetadataSha256"]) ||
    !isSupportedTarget(target)
  ) {
    fail("The installed release verification candidate binding is invalid.");
  }
}

function validateExternal(value: Readonly<Record<string, unknown>>): void {
  if (value["status"] === "publisher-verified") {
    assertExactKeys(
      value,
      [
        "archiveSha256",
        "archiveSize",
        "configurationSha256",
        "publisherAttestationSha256",
        "publisherKeyId",
        "status",
      ],
      "publisher release verification authority",
    );
  } else if (value["status"] === "released") {
    assertExactKeys(
      value,
      [
        "archiveSha256",
        "archiveSize",
        "configurationSha256",
        "promotionStatementId",
        "publisherAttestationSha256",
        "publisherKeyId",
        "receiptId",
        "status",
      ],
      "released verification authority",
    );
    if (
      typeof value["promotionStatementId"] !== "string" ||
      !EXTERNAL_ID_PATTERN.test(value["promotionStatementId"]) ||
      typeof value["receiptId"] !== "string" ||
      !EXTERNAL_ID_PATTERN.test(value["receiptId"])
    ) {
      fail("The released verification authority identifiers are invalid.");
    }
  } else {
    fail("The installed release verification authority status is invalid.");
  }
  if (
    typeof value["archiveSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["archiveSha256"]) ||
    !Number.isSafeInteger(value["archiveSize"]) ||
    (value["archiveSize"] as number) <= 0 ||
    (value["archiveSize"] as number) > 512 * 1024 * 1024 ||
    typeof value["configurationSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["configurationSha256"]) ||
    typeof value["publisherAttestationSha256"] !== "string" ||
    !SHA256_PATTERN.test(value["publisherAttestationSha256"]) ||
    typeof value["publisherKeyId"] !== "string" ||
    !QUALIFIED_SHA256_PATTERN.test(value["publisherKeyId"])
  ) {
    fail("The installed release verification authority binding is invalid.");
  }
}

function isSupportedTarget(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value["platform"] === "darwin" && value["architecture"] === "arm64") ||
    (value["platform"] === "linux" && value["architecture"] === "x64") ||
    (value["platform"] === "win32" && value["architecture"] === "x64")
  );
}

function requireSha256(value: string | undefined, label: string): string {
  if (value === undefined || !SHA256_PATTERN.test(value)) {
    fail(`The ${label} digest is invalid.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`The ${label} is invalid.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`The ${label} fields are invalid.`);
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  fail("The release verification seal contains an invalid value.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function fail(message: string): never {
  throw new ServiceCommandExecutionError("SERVICE_COMMAND_PREFLIGHT_FAILED", message, false);
}
