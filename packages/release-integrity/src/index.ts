import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  externalReleaseVerificationPath,
  resolveConfiguredReleaseWithDependencies,
  type ConfiguredReleaseDiagnosticCode,
  type ConfiguredReleaseExternalStatus,
  type ConfiguredReleaseResolution,
  type ResolveConfiguredReleaseInput,
} from "./configured-release.ts";
import { readStableNodeFile } from "./stable-node-file-read.ts";

export {
  externalReleaseVerificationPath,
  type ConfiguredReleaseDiagnosticCode,
  type ConfiguredReleaseExternalStatus,
  type ConfiguredReleaseResolution,
  type ResolveConfiguredReleaseInput,
};

export type ReleasePlatform = "darwin" | "linux" | "win32";
export type ReleaseArchitecture = "arm64" | "x64";

export interface ReleaseTarget {
  readonly platform: ReleasePlatform;
  readonly architecture: ReleaseArchitecture;
}

export interface ReleaseFileMetadata {
  readonly kind: "directory" | "file" | "special" | "symbolic-link";
  readonly size: number;
}

export interface ReleaseDirectoryEntry {
  readonly kind: ReleaseFileMetadata["kind"];
  readonly name: string;
}

export interface ReleaseFileReader {
  inspect(path: string): Promise<ReleaseFileMetadata>;
  inspectIfPresent(path: string): Promise<ReleaseFileMetadata | undefined>;
  list(path: string): Promise<readonly ReleaseDirectoryEntry[]>;
  read(path: string, maximumBytes: number): Promise<Uint8Array>;
  realPath(path: string): Promise<string>;
}

export type ReleaseIntegrityErrorCode =
  | "CANDIDATE_INPUT_INVALID"
  | "CANDIDATE_IO_INVALID"
  | "CANDIDATE_SCHEMA_INVALID"
  | "CANDIDATE_INTEGRITY_INVALID"
  | "PUBLISHER_STATEMENT_INVALID"
  | "PUBLISHER_TRUST_INVALID"
  | "PROMOTION_INPUT_INVALID"
  | "PROMOTION_TRUST_INVALID"
  | "SIGNED_ENVELOPE_INVALID"
  | "RELEASE_REVOKED";

export class ReleaseIntegrityError extends Error {
  readonly code: ReleaseIntegrityErrorCode;

  constructor(code: ReleaseIntegrityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseIntegrityError";
    this.code = code;
  }
}

export const nodeReleaseFileReader: ReleaseFileReader = Object.freeze({
  async inspect(path: string): Promise<ReleaseFileMetadata> {
    const metadata = await lstat(path);
    return {
      kind: metadata.isSymbolicLink()
        ? "symbolic-link"
        : metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "special",
      size: metadata.size,
    };
  },
  async inspectIfPresent(path: string): Promise<ReleaseFileMetadata | undefined> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    return {
      kind: metadata.isSymbolicLink()
        ? "symbolic-link"
        : metadata.isDirectory()
          ? "directory"
          : metadata.isFile()
            ? "file"
            : "special",
      size: metadata.size,
    };
  },
  async list(path: string): Promise<readonly ReleaseDirectoryEntry[]> {
    return (await readdir(path, { withFileTypes: true })).map((entry) => ({
      kind: entry.isSymbolicLink()
        ? "symbolic-link"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "special",
      name: entry.name,
    }));
  },
  async read(path: string, maximumBytes: number): Promise<Uint8Array> {
    return readStableNodeFile(path, maximumBytes);
  },
  async realPath(path: string): Promise<string> {
    return realpath(path);
  },
});

export interface InspectCandidateInput {
  readonly root: string;
  readonly expectedTarget: ReleaseTarget;
  readonly reader?: ReleaseFileReader;
  readonly expectedManifestSha256?: string;
}

export interface CandidateDescription {
  readonly acceptanceLedgerSha256: string;
  readonly auditedSourceCommit: string;
  readonly buildCommit: string;
  readonly buildId: string;
  readonly candidateAttestationId: string;
  readonly checksumManifestSha256: string;
  readonly declaredChannel: "release-candidate";
  readonly nativeComponentsSha256: string;
  readonly payloadManifestSha256: string;
  readonly platformAuthenticitySha256: string;
  readonly platformCertificateIdentities: readonly string[];
  readonly platformProductCertificateIdentity: string | null;
  readonly productVersion: string;
  readonly publisherStatement: {
    readonly canonicalBytes: Uint8Array;
    readonly domain: "opendelegate.release.publisher-candidate.v2";
    readonly sha256: string;
  };
  readonly releaseMetadataSha256: string;
  readonly target: ReleaseTarget;
}

export async function inspectCandidate(
  input: InspectCandidateInput,
): Promise<CandidateDescription> {
  const reader = input.reader ?? nodeReleaseFileReader;
  assertExpectedTarget(input.expectedTarget);
  if (typeof input.root !== "string" || input.root.trim() === "") {
    fail("CANDIDATE_INPUT_INVALID", "The release candidate root is invalid.");
  }
  let canonicalRoot: string;
  try {
    const metadata = await reader.inspect(input.root);
    if (metadata.kind !== "directory") {
      throw new Error("candidate root is not a directory");
    }
    canonicalRoot = await reader.realPath(input.root);
  } catch (error) {
    throw new ReleaseIntegrityError(
      "CANDIDATE_IO_INVALID",
      "The release candidate root is unreadable or unsafe.",
      { cause: error },
    );
  }

  const discovered = await listCandidateFiles(reader, input.root, canonicalRoot);
  const discoveredSet = new Set(discovered);
  for (const required of REQUIRED_CANDIDATE_FILES) {
    if (!discoveredSet.has(required)) {
      fail("CANDIDATE_SCHEMA_INVALID", "The release candidate is missing a required record.");
    }
  }

  const [checksumBytes, payloadManifestBytes] = await Promise.all([
    readCandidateFile(reader, input.root, "SHA256SUMS", MAXIMUM_MANIFEST_BYTES),
    readCandidateFile(reader, input.root, "payload-manifest.json", MAXIMUM_MANIFEST_BYTES),
  ]);
  const checksumManifestSha256 = sha256(checksumBytes);
  if (
    input.expectedManifestSha256 !== undefined &&
    (!SHA256_PATTERN.test(input.expectedManifestSha256) ||
      input.expectedManifestSha256 !== checksumManifestSha256)
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The release candidate does not match the expected manifest digest.",
    );
  }
  const checksums = parseChecksumManifest(checksumBytes);
  const payload = parsePayloadManifest(payloadManifestBytes);
  if (checksums.get("payload-manifest.json") !== sha256(payloadManifestBytes)) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The checksum manifest does not bind the payload manifest.",
    );
  }
  if (checksums.size !== payload.size + 1) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The checksum and payload manifests cover different file sets.",
    );
  }
  for (const entry of payload.values()) {
    if (checksums.get(entry.path) !== entry.sha256) {
      fail("CANDIDATE_INTEGRITY_INVALID", "The candidate manifests disagree.");
    }
  }
  const expectedFiles = new Set([...payload.keys(), "SHA256SUMS", "payload-manifest.json"]);
  if (
    expectedFiles.size !== discovered.length ||
    discovered.some((path) => !expectedFiles.has(path))
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The candidate contains an unlisted, missing, linked, or special file.",
    );
  }

  const verifiedBytes = new Map<string, Uint8Array>([
    ["SHA256SUMS", checksumBytes],
    ["payload-manifest.json", payloadManifestBytes],
  ]);
  for (const path of discovered) {
    if (path === "SHA256SUMS" || path === "payload-manifest.json") {
      continue;
    }
    const entry = payload.get(path);
    if (entry === undefined) {
      fail("CANDIDATE_INTEGRITY_INVALID", "The candidate file set is inconsistent.");
    }
    const bytes = await readCandidateFile(
      reader,
      input.root,
      path,
      maximumCandidateFileBytes(path, entry.size),
    );
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      fail("CANDIDATE_INTEGRITY_INVALID", "A candidate payload digest is invalid.");
    }
    verifiedBytes.set(path, bytes);
  }

  const nativeComponentsBytes = requireVerifiedBytes(verifiedBytes, "native-components.json");
  const platformAuthenticityBytes = requireVerifiedBytes(
    verifiedBytes,
    "platform-authenticity.json",
  );
  const metadataBytes = requireVerifiedBytes(verifiedBytes, "release-metadata.json");
  const ledgerBytes = requireVerifiedBytes(verifiedBytes, "docs/release/acceptance-evidence.json");
  const smokeBytes = requireVerifiedBytes(verifiedBytes, "smoke-evidence.json");
  const nativeComponents = parseNativeComponents(
    nativeComponentsBytes,
    input.expectedTarget,
    payload,
    verifiedBytes,
  );
  const platformAuthenticity = parsePlatformAuthenticity(
    platformAuthenticityBytes,
    input.expectedTarget,
    nativeComponents,
    payload,
    verifiedBytes,
  );
  const ledger = parseAcceptanceLedger(ledgerBytes, verifiedBytes);
  const metadata = parseReleaseMetadata(
    metadataBytes,
    input.expectedTarget,
    nativeComponents,
    ledger,
    sha256(ledgerBytes),
    verifiedBytes,
  );
  parseSmokeEvidence(smokeBytes, input.expectedTarget, metadata);

  const statementValue = {
    schemaVersion: 2,
    product: "OpenDelegate",
    domain: PUBLISHER_CANDIDATE_DOMAIN,
    target: {
      platform: input.expectedTarget.platform,
      architecture: input.expectedTarget.architecture,
    },
    productVersion: metadata.productVersion,
    buildCommit: metadata.buildCommit,
    auditedSourceCommit: metadata.auditedSourceCommit,
    acceptanceLedgerSha256: sha256(ledgerBytes),
    candidateAttestationId: ledger.candidateAttestationId,
    checksumManifestSha256,
    payloadManifestSha256: sha256(payloadManifestBytes),
    releaseMetadataSha256: sha256(metadataBytes),
    nativeComponentsSha256: sha256(nativeComponentsBytes),
    platformAuthenticitySha256: sha256(platformAuthenticityBytes),
  };
  const statementBytes = canonicalJsonBytes(statementValue);
  const target = Object.freeze({
    platform: input.expectedTarget.platform,
    architecture: input.expectedTarget.architecture,
  });
  const publisherStatement = Object.freeze({
    get canonicalBytes(): Uint8Array {
      return Uint8Array.from(statementBytes);
    },
    domain: PUBLISHER_CANDIDATE_DOMAIN,
    sha256: sha256(statementBytes),
  });
  const description = Object.freeze({
    acceptanceLedgerSha256: sha256(ledgerBytes),
    auditedSourceCommit: metadata.auditedSourceCommit,
    buildCommit: metadata.buildCommit,
    buildId: metadata.buildId,
    candidateAttestationId: ledger.candidateAttestationId,
    checksumManifestSha256,
    declaredChannel: "release-candidate",
    nativeComponentsSha256: sha256(nativeComponentsBytes),
    payloadManifestSha256: sha256(payloadManifestBytes),
    platformAuthenticitySha256: sha256(platformAuthenticityBytes),
    platformCertificateIdentities: platformAuthenticity.certificateIdentities,
    platformProductCertificateIdentity: platformAuthenticity.productCertificateIdentity,
    productVersion: metadata.productVersion,
    publisherStatement,
    releaseMetadataSha256: sha256(metadataBytes),
    target,
  });
  inspectedCandidateObjects.add(description);
  return description;
}

interface PayloadEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface NativeComponent {
  readonly kind: string;
  readonly path: string;
  readonly sha256: string;
}

interface NativeComponentsManifest {
  readonly architecture: ReleaseArchitecture;
  readonly components: readonly NativeComponent[];
  readonly platform: ReleasePlatform;
  readonly schemaVersion: 1;
}

interface ParsedAcceptanceLedger {
  readonly auditedAt: string;
  readonly candidateAttestationId: string;
  readonly sourceCommit: string;
}

interface ParsedReleaseMetadata {
  readonly auditedSourceCommit: string;
  readonly buildCommit: string;
  readonly buildId: string;
  readonly productVersion: string;
}

const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 1024 * 1024;
const MAXIMUM_ATTESTATION_BYTES = 1024 * 1024;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const PUBLISHER_CANDIDATE_DOMAIN = "opendelegate.release.publisher-candidate.v2" as const;
const PUBLISHER_ATTESTATION_DOMAIN = "opendelegate.release.publisher-attestation.v2" as const;
const PROMOTION_AUTHORIZATION_DOMAIN = "opendelegate.release.promotion-authorization.v1" as const;
const SUPPORTED_CHANNEL_RECEIPT_DOMAIN =
  "opendelegate.release.supported-channel-receipt.v1" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QUALIFIED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BASE64_URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ATTESTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const RFC3339_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const REQUIRED_CANDIDATE_FILES = Object.freeze([
  "SHA256SUMS",
  "docs/release/acceptance-evidence.json",
  "native-components.json",
  "payload-manifest.json",
  "platform-authenticity.json",
  "release-metadata.json",
  "smoke-evidence.json",
]);
const METADATA_KEYS = Object.freeze([
  "schemaVersion",
  "product",
  "productVersion",
  "protocolVersion",
  "buildId",
  "createdAt",
  "timestampPolicy",
  "platform",
  "architecture",
  "bundledNodeVersion",
  "bundledRuntime",
  "toolchain",
  "dependencyLockSha256",
  "sourcePackageManifestSha256",
  "runtimeExternals",
  "nativeComponents",
  "buildCommit",
  "auditedSourceCommit",
  "changedAttestationPaths",
  "buildSourceDirty",
  "supportStatus",
  "buildMode",
  "releaseEvidence",
  "entrypoints",
  "fileManifest",
  "checksumManifest",
]);
const PUBLISHER_CANDIDATE_BINDING_KEYS = Object.freeze([
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
]);
const FIRST_MILESTONE_TARGETS = Object.freeze([
  Object.freeze({ platform: "darwin", architecture: "arm64" }),
  Object.freeze({ platform: "linux", architecture: "x64" }),
  Object.freeze({ platform: "win32", architecture: "x64" }),
] satisfies readonly ReleaseTarget[]);
const SIGNED_RELEASE_ENVELOPE_KEYS = Object.freeze([
  "schemaVersion",
  "product",
  "role",
  "algorithm",
  "keyId",
  "statement",
  "signature",
]);
const verifiedReleaseObjects = new WeakSet<object>();
const inspectedCandidateObjects = new WeakSet<object>();
const signableStatementBrands = new WeakMap<
  object,
  {
    readonly role: "promotion" | "publisher";
    readonly schemaVersion: 1 | 2;
    readonly statement: object;
  }
>();

async function listCandidateFiles(
  reader: ReleaseFileReader,
  root: string,
  canonicalRoot: string,
): Promise<readonly string[]> {
  const files: string[] = [];
  const caseFolded = new Set<string>();
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    let canonicalDirectory: string;
    let entries: readonly ReleaseDirectoryEntry[];
    try {
      canonicalDirectory = await reader.realPath(directory);
      entries = await reader.list(directory);
    } catch (error) {
      throw new ReleaseIntegrityError(
        "CANDIDATE_IO_INVALID",
        "The release candidate tree is unreadable or unsafe.",
        { cause: error },
      );
    }
    if (
      !samePath(canonicalDirectory, canonicalRoot) &&
      !isPathDescendant(canonicalRoot, canonicalDirectory)
    ) {
      fail("CANDIDATE_IO_INVALID", "The release candidate tree escaped its root.");
    }
    for (const entry of entries) {
      assertSafeSegment(entry.name);
      const relativePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      assertPortablePath(relativePath);
      const folded = relativePath.normalize("NFC").toLowerCase();
      if (caseFolded.has(folded)) {
        fail("CANDIDATE_SCHEMA_INVALID", "The candidate contains case-colliding paths.");
      }
      caseFolded.add(folded);
      if (entry.kind === "symbolic-link" || entry.kind === "special") {
        fail(
          "CANDIDATE_IO_INVALID",
          "The candidate contains a linked or special filesystem entry.",
        );
      }
      const absolutePath = join(directory, entry.name);
      if (entry.kind === "directory") {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entry.kind !== "file") {
        fail("CANDIDATE_IO_INVALID", "The candidate contains an unknown filesystem entry.");
      }
      let canonicalFile: string;
      try {
        canonicalFile = await reader.realPath(absolutePath);
      } catch (error) {
        throw new ReleaseIntegrityError(
          "CANDIDATE_IO_INVALID",
          "A release candidate file is unreadable or unsafe.",
          { cause: error },
        );
      }
      if (!isPathDescendant(canonicalRoot, canonicalFile)) {
        fail("CANDIDATE_IO_INVALID", "A release candidate file escaped its root.");
      }
      files.push(relativePath);
    }
  };
  await visit(root, "");
  return files.sort(compareCodeUnits);
}

async function readCandidateFile(
  reader: ReleaseFileReader,
  root: string,
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  assertPortablePath(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    fail("CANDIDATE_SCHEMA_INVALID", "A candidate file has an unsafe declared size.");
  }
  try {
    return await reader.read(join(root, ...path.split("/")), maximumBytes);
  } catch (error) {
    throw new ReleaseIntegrityError(
      "CANDIDATE_IO_INVALID",
      "A required release candidate file is missing, oversized, linked, or unstable.",
      { cause: error },
    );
  }
}

function maximumCandidateFileBytes(path: string, declaredSize: number): number {
  if (path === "docs/release/acceptance-evidence.json") {
    return Math.min(declaredSize, MAXIMUM_MANIFEST_BYTES);
  }
  if (
    path === "native-components.json" ||
    path === "platform-authenticity.json" ||
    path === "release-metadata.json" ||
    path === "smoke-evidence.json"
  ) {
    return Math.min(declaredSize, MAXIMUM_METADATA_BYTES);
  }
  return declaredSize;
}

function parseChecksumManifest(bytes: Uint8Array): ReadonlyMap<string, string> {
  const text = decodeUtf8(bytes, "checksum manifest");
  if (!text.endsWith("\n")) {
    fail("CANDIDATE_SCHEMA_INVALID", "The checksum manifest is not canonical.");
  }
  const entries = new Map<string, string>();
  let previous: string | undefined;
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (match === null) {
      fail("CANDIDATE_SCHEMA_INVALID", "The checksum manifest contains a malformed entry.");
    }
    const path = match[2]!;
    assertPortablePath(path);
    if (
      path === "SHA256SUMS" ||
      entries.has(path) ||
      (previous !== undefined && compareCodeUnits(previous, path) >= 0)
    ) {
      fail(
        "CANDIDATE_SCHEMA_INVALID",
        "The checksum manifest is duplicated or not canonically ordered.",
      );
    }
    entries.set(path, match[1]!);
    previous = path;
  }
  if (entries.size === 0) {
    fail("CANDIDATE_SCHEMA_INVALID", "The checksum manifest is empty.");
  }
  return entries;
}

function parsePayloadManifest(bytes: Uint8Array): ReadonlyMap<string, PayloadEntry> {
  const value = parseCanonicalJsonObject(bytes, "payload manifest");
  assertExactKeys(
    value,
    ["schemaVersion", "excludedSelfReferences", "fileCount", "totalBytes", "files"],
    "payload manifest",
  );
  if (
    value["schemaVersion"] !== 1 ||
    !Array.isArray(value["excludedSelfReferences"]) ||
    value["excludedSelfReferences"].length !== 2 ||
    value["excludedSelfReferences"][0] !== "SHA256SUMS" ||
    value["excludedSelfReferences"][1] !== "payload-manifest.json" ||
    !Array.isArray(value["files"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The payload manifest header is invalid.");
  }
  const entries = new Map<string, PayloadEntry>();
  const foldedPaths = new Set<string>();
  let previous: string | undefined;
  let totalBytes = 0;
  for (const candidate of value["files"]) {
    const entry = requireRecord(candidate, "payload entry");
    assertExactKeys(entry, ["path", "size", "sha256"], "payload entry");
    const path = requireString(entry["path"], "payload path");
    const size = entry["size"];
    const digest = entry["sha256"];
    assertPortablePath(path);
    const folded = path.normalize("NFC").toLowerCase();
    if (
      path === "SHA256SUMS" ||
      path === "payload-manifest.json" ||
      entries.has(path) ||
      foldedPaths.has(folded) ||
      (previous !== undefined && compareCodeUnits(previous, path) >= 0) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      typeof digest !== "string" ||
      !SHA256_PATTERN.test(digest)
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The payload manifest contains an invalid entry.");
    }
    totalBytes += size as number;
    if (!Number.isSafeInteger(totalBytes)) {
      fail("CANDIDATE_SCHEMA_INVALID", "The payload manifest total byte count is unsafe.");
    }
    entries.set(path, { path, size: size as number, sha256: digest });
    foldedPaths.add(folded);
    previous = path;
  }
  if (value["fileCount"] !== entries.size || value["totalBytes"] !== totalBytes) {
    fail("CANDIDATE_SCHEMA_INVALID", "The payload manifest aggregate counts are invalid.");
  }
  return entries;
}

function parseNativeComponents(
  bytes: Uint8Array,
  target: ReleaseTarget,
  payload: ReadonlyMap<string, PayloadEntry>,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
): NativeComponentsManifest {
  const value = parseCanonicalJsonObject(bytes, "native component manifest");
  assertExactKeys(
    value,
    ["schemaVersion", "platform", "architecture", "components"],
    "native component manifest",
  );
  if (
    value["schemaVersion"] !== 1 ||
    value["platform"] !== target.platform ||
    value["architecture"] !== target.architecture ||
    !Array.isArray(value["components"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The native component manifest target is invalid.");
  }
  const expected = expectedNativeComponents(target.platform);
  if (value["components"].length !== expected.length) {
    fail(
      "CANDIDATE_SCHEMA_INVALID",
      "The native component manifest has an incomplete component set.",
    );
  }
  const components = value["components"].map((candidate, index) => {
    const component = requireRecord(candidate, "native component");
    assertExactKeys(component, ["kind", "path", "sha256"], "native component");
    const expectedComponent = expected[index]!;
    if (
      component["kind"] !== expectedComponent.kind ||
      component["path"] !== expectedComponent.path ||
      typeof component["sha256"] !== "string" ||
      !QUALIFIED_SHA256_PATTERN.test(component["sha256"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The native component record is invalid.");
    }
    const payloadEntry = payload.get(expectedComponent.path);
    const actualBytes = verifiedBytes.get(expectedComponent.path);
    if (
      payloadEntry === undefined ||
      actualBytes === undefined ||
      component["sha256"] !== `sha256:${payloadEntry.sha256}` ||
      component["sha256"] !== `sha256:${sha256(actualBytes)}`
    ) {
      fail("CANDIDATE_INTEGRITY_INVALID", "A native component does not match its payload binding.");
    }
    return Object.freeze({
      kind: expectedComponent.kind,
      path: expectedComponent.path,
      sha256: component["sha256"] as string,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    platform: target.platform,
    architecture: target.architecture,
    components: Object.freeze(components),
  });
}

interface ParsedPlatformAuthenticity {
  readonly certificateIdentities: readonly string[];
  readonly productCertificateIdentity: string | null;
}

function parsePlatformAuthenticity(
  bytes: Uint8Array,
  target: ReleaseTarget,
  nativeComponents: NativeComponentsManifest,
  payload: ReadonlyMap<string, PayloadEntry>,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
): ParsedPlatformAuthenticity {
  const value = parseCanonicalJsonObject(bytes, "platform authenticity record");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "target",
      "supportEligible",
      "status",
      "policy",
      "policySha256",
      "tool",
      "publicIdentity",
      "components",
      "thirdPartyComponents",
    ],
    "platform authenticity record",
  );
  const recordTarget = requireRecord(value["target"], "platform authenticity target");
  assertExactKeys(recordTarget, ["platform", "architecture"], "platform authenticity target");
  const expectedPolicy =
    target.platform === "darwin"
      ? "developer-id"
      : target.platform === "win32"
        ? "authenticode"
        : "publisher-only";
  if (
    value["schemaVersion"] !== 1 ||
    recordTarget["platform"] !== target.platform ||
    recordTarget["architecture"] !== target.architecture ||
    value["supportEligible"] !== true ||
    value["status"] !== "verified" ||
    value["policy"] !== expectedPolicy ||
    typeof value["policySha256"] !== "string" ||
    !SHA256_PATTERN.test(value["policySha256"]) ||
    !Array.isArray(value["components"]) ||
    value["components"].length !== nativeComponents.components.length ||
    !Array.isArray(value["thirdPartyComponents"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The platform authenticity record is not support eligible.");
  }
  const platformIdentity = parsePlatformToolAndIdentity(value, target);
  for (const [index, candidate] of value["components"].entries()) {
    const component = requireRecord(candidate, "platform authenticity component");
    assertExactKeys(
      component,
      ["kind", "path", "inputSha256", "sha256", "verification"],
      "platform authenticity component",
    );
    const expected = nativeComponents.components[index]!;
    const expectedVerification = target.platform === "linux" ? "publisher-only" : "signed";
    if (
      typeof component["inputSha256"] !== "string" ||
      !QUALIFIED_SHA256_PATTERN.test(component["inputSha256"]) ||
      component["kind"] !== expected.kind ||
      component["path"] !== expected.path ||
      component["sha256"] !== expected.sha256 ||
      component["verification"] !== expectedVerification ||
      (target.platform === "linux" && component["inputSha256"] !== component["sha256"])
    ) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "The platform authenticity component binding is invalid.",
      );
    }
  }
  const upstreamRuntimeCertificateIdentity = parseThirdPartyPlatformComponents(
    value["thirdPartyComponents"],
    target,
    nativeComponents,
    payload,
    verifiedBytes,
    platformIdentity.publicIdentity,
  );
  const productCertificateIdentity = platformIdentity.certificateIdentities[0] ?? null;
  if (target.platform === "linux") {
    if (
      productCertificateIdentity !== null ||
      upstreamRuntimeCertificateIdentity !== null ||
      platformIdentity.certificateIdentities.length !== 0
    ) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "Linux publisher-only authenticity cannot contain certificate identities.",
      );
    }
    return Object.freeze({
      certificateIdentities: Object.freeze([]),
      productCertificateIdentity: null,
    });
  }
  if (
    productCertificateIdentity === null ||
    upstreamRuntimeCertificateIdentity === null ||
    productCertificateIdentity === upstreamRuntimeCertificateIdentity ||
    platformIdentity.certificateIdentities.length !== 1
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "Product and upstream runtime certificate identities must be present and distinct.",
    );
  }
  return Object.freeze({
    certificateIdentities: Object.freeze([
      productCertificateIdentity,
      upstreamRuntimeCertificateIdentity,
    ]),
    productCertificateIdentity,
  });
}

interface ParsedPlatformSigningIdentity {
  readonly certificateIdentities: readonly string[];
  readonly publicIdentity: Readonly<Record<string, unknown>> | null;
}

function parsePlatformToolAndIdentity(
  value: Readonly<Record<string, unknown>>,
  target: ReleaseTarget,
): ParsedPlatformSigningIdentity {
  if (target.platform === "linux") {
    if (value["tool"] !== null || value["publicIdentity"] !== null) {
      fail(
        "CANDIDATE_SCHEMA_INVALID",
        "Linux publisher-only authenticity cannot claim a native signing identity.",
      );
    }
    return {
      certificateIdentities: Object.freeze([]),
      publicIdentity: null,
    };
  }
  const tool = requireRecord(value["tool"], "platform signing tool");
  assertExactKeys(tool, ["name", "version", "sha256"], "platform signing tool");
  if (
    tool["name"] !== (target.platform === "darwin" ? "codesign" : "signtool") ||
    !isBoundedDisplayString(tool["version"], 200) ||
    typeof tool["sha256"] !== "string" ||
    !SHA256_PATTERN.test(tool["sha256"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The platform signing tool identity is invalid.");
  }
  const identity = requireRecord(value["publicIdentity"], "platform signing identity");
  if (target.platform === "darwin") {
    assertExactKeys(identity, ["type", "selector", "teamId"], "Apple platform signing identity");
    if (
      identity["type"] !== "apple-developer-id-application" ||
      !isAppleDeveloperIdSelector(identity["selector"], identity["teamId"]) ||
      typeof identity["teamId"] !== "string" ||
      !/^[A-Z0-9]{10}$/u.test(identity["teamId"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The Apple signing identity is invalid.");
    }
    return {
      certificateIdentities: Object.freeze([`apple-team:${identity["teamId"]}`]),
      publicIdentity: identity,
    };
  }
  assertExactKeys(
    identity,
    ["type", "certificateSha1", "store", "timestampUrl"],
    "Windows platform signing identity",
  );
  if (
    identity["type"] !== "windows-authenticode" ||
    typeof identity["certificateSha1"] !== "string" ||
    !/^[A-F0-9]{40}$/u.test(identity["certificateSha1"]) ||
    (identity["store"] !== "CurrentUser/My" && identity["store"] !== "LocalMachine/My") ||
    typeof identity["timestampUrl"] !== "string" ||
    !isPublicHttpsUrl(identity["timestampUrl"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The Windows signing identity is invalid.");
  }
  return {
    certificateIdentities: Object.freeze([`authenticode-sha1:${identity["certificateSha1"]}`]),
    publicIdentity: identity,
  };
}

function parseThirdPartyPlatformComponents(
  candidate: unknown,
  target: ReleaseTarget,
  nativeComponents: NativeComponentsManifest,
  payload: ReadonlyMap<string, PayloadEntry>,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
  platformIdentity: Readonly<Record<string, unknown>> | null,
): string | null {
  if (!Array.isArray(candidate)) {
    fail("CANDIDATE_SCHEMA_INVALID", "The third-party native component inventory is invalid.");
  }
  const expectedPaths = discoverThirdPartyNativePaths(
    target,
    nativeComponents,
    payload,
    verifiedBytes,
  );
  if (candidate.length !== expectedPaths.length) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The third-party native component inventory is incomplete.",
    );
  }
  const runtimePath = target.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  let upstreamRuntimeCertificateIdentity: string | null = null;
  for (const [index, item] of candidate.entries()) {
    const value = requireRecord(item, "third-party native component");
    assertExactKeys(
      value,
      ["kind", "path", "inputSha256", "sha256", "verification", "publicIdentity"],
      "third-party native component",
    );
    const expectedPath = expectedPaths[index]!;
    const expectedBytes = verifiedBytes.get(expectedPath);
    if (expectedBytes === undefined) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "A third-party native component is absent from the payload.",
      );
    }
    const expectedDigest = `sha256:${sha256(expectedBytes)}`;
    const isRuntime = expectedPath === runtimePath;
    const expectedVerification =
      target.platform === "linux" ? "publisher-only" : isRuntime ? "upstream-verified" : "resigned";
    let declaredCertificateIdentity: string | null = null;
    if (target.platform !== "linux" && isRuntime) {
      declaredCertificateIdentity = parseUpstreamPlatformIdentity(value["publicIdentity"], target);
    }
    if (
      value["kind"] !== (isRuntime ? "bundled-node-runtime" : "bundled-native-library") ||
      value["path"] !== expectedPath ||
      typeof value["inputSha256"] !== "string" ||
      !QUALIFIED_SHA256_PATTERN.test(value["inputSha256"]) ||
      value["sha256"] !== expectedDigest ||
      value["verification"] !== expectedVerification ||
      ((!isRuntime || target.platform === "linux") && value["publicIdentity"] !== null) ||
      ((isRuntime || target.platform === "linux") && value["inputSha256"] !== value["sha256"])
    ) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "A third-party native component does not match its payload or authenticity binding.",
      );
    }
    if (isRuntime) {
      upstreamRuntimeCertificateIdentity = declaredCertificateIdentity;
    } else if (target.platform !== "linux" && platformIdentity === null) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "A re-signed third-party native library lacks a product signing identity.",
      );
    }
  }
  return upstreamRuntimeCertificateIdentity;
}

function parseUpstreamPlatformIdentity(candidate: unknown, target: ReleaseTarget): string {
  const identity = requireRecord(candidate, "upstream runtime signing identity");
  if (target.platform === "darwin") {
    assertExactKeys(identity, ["type", "selector", "teamId"], "upstream Apple signing identity");
    if (
      identity["type"] !== "apple-developer-id-application" ||
      !isAppleDeveloperIdSelector(identity["selector"], identity["teamId"]) ||
      typeof identity["teamId"] !== "string" ||
      !/^[A-Z0-9]{10}$/u.test(identity["teamId"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The upstream Apple signing identity is invalid.");
    }
    return `apple-team:${identity["teamId"]}`;
  }
  if (target.platform === "win32") {
    assertExactKeys(identity, ["type", "certificateSha1"], "upstream Windows signing identity");
    if (
      identity["type"] !== "windows-authenticode-upstream" ||
      typeof identity["certificateSha1"] !== "string" ||
      !/^[A-F0-9]{40}$/u.test(identity["certificateSha1"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The upstream Windows signing identity is invalid.");
    }
    return `authenticode-sha1:${identity["certificateSha1"]}`;
  }
  fail(
    "CANDIDATE_SCHEMA_INVALID",
    "Linux publisher-only authenticity cannot claim an upstream signing identity.",
  );
}

function discoverThirdPartyNativePaths(
  target: ReleaseTarget,
  nativeComponents: NativeComponentsManifest,
  payload: ReadonlyMap<string, PayloadEntry>,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
  const nativeComponentPaths = new Set(nativeComponents.components.map(({ path }) => path));
  const expectedFormat =
    target.platform === "darwin" ? "mach-o" : target.platform === "win32" ? "pe" : "elf";
  const paths: string[] = [];
  for (const path of payload.keys()) {
    if (nativeComponentPaths.has(path)) {
      continue;
    }
    const bytes = verifiedBytes.get(path);
    if (bytes === undefined) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "A payload file is unavailable for native format discovery.",
      );
    }
    const format = detectNativeExecutableFormat(bytes);
    if (hasGuardedNativeSuffix(path) && format === undefined) {
      fail(
        "CANDIDATE_INTEGRITY_INVALID",
        "A native-looking payload path does not contain a recognized native binary.",
      );
    }
    if (format !== undefined) {
      if (format !== expectedFormat) {
        fail(
          "CANDIDATE_INTEGRITY_INVALID",
          "A native payload file targets a different operating-system format.",
        );
      }
      paths.push(path);
    }
  }
  const runtimePath = target.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  if (!paths.includes(runtimePath)) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The bundled Node runtime is missing from native authenticity inventory discovery.",
    );
  }
  return Object.freeze(paths.sort(compareCodeUnits));
}

function hasGuardedNativeSuffix(path: string): boolean {
  return /(?:\.node|\.dll|\.dylib|\.exe|\.so(?:\.\d+)*)$/iu.test(path);
}

function detectNativeExecutableFormat(bytes: Uint8Array): "elf" | "mach-o" | "pe" | undefined {
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return "elf";
  }
  if (bytes.byteLength >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      false,
    );
    if (
      magic === 0xfeedface ||
      magic === 0xfeedfacf ||
      magic === 0xcefaedfe ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe ||
      magic === 0xcafebabf ||
      magic === 0xbebafeca ||
      magic === 0xbfbafeca
    ) {
      return "mach-o";
    }
  }
  if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (
    peOffset > 1024 * 1024 - 4 ||
    peOffset + 4 > bytes.byteLength ||
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0 ||
    bytes[peOffset + 3] !== 0
  ) {
    return undefined;
  }
  return "pe";
}

function parseAcceptanceLedger(
  bytes: Uint8Array,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
): ParsedAcceptanceLedger {
  const value = parseCanonicalJsonObject(bytes, "acceptance ledger");
  assertExactKeys(
    value,
    [
      "$schema",
      "schemaVersion",
      "product",
      "milestone",
      "auditedAt",
      "sourceCommit",
      "releaseStatus",
      "criteria",
      "candidateAttestation",
    ],
    "acceptance ledger",
  );
  if (
    value["$schema"] !== "./acceptance-evidence.schema.json" ||
    value["schemaVersion"] !== 1 ||
    value["product"] !== "OpenDelegate" ||
    value["milestone"] !== "first" ||
    !isRfc3339Instant(value["auditedAt"]) ||
    typeof value["sourceCommit"] !== "string" ||
    !FULL_COMMIT_PATTERN.test(value["sourceCommit"]) ||
    value["releaseStatus"] !== "candidate" ||
    !Array.isArray(value["criteria"]) ||
    value["criteria"].length !== 36
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The acceptance ledger is not a complete candidate.");
  }
  const sourceCommit = value["sourceCommit"];
  for (const [index, candidate] of value["criteria"].entries()) {
    const criterion = requireRecord(candidate, "acceptance criterion");
    assertExactKeys(
      criterion,
      [
        "id",
        "title",
        "implementationStatus",
        "liveProofStatus",
        "evidence",
        "nextGate",
        "verification",
      ],
      "acceptance criterion",
    );
    if (
      criterion["id"] !== index + 1 ||
      !isNonEmptyString(criterion["title"]) ||
      criterion["implementationStatus"] !== "verified" ||
      criterion["liveProofStatus"] !== "verified" ||
      !Array.isArray(criterion["evidence"]) ||
      criterion["evidence"].length === 0 ||
      new Set(criterion["evidence"]).size !== criterion["evidence"].length ||
      !isNonEmptyString(criterion["nextGate"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "An acceptance criterion is incomplete.");
    }
    const evidenceHashes = new Map<string, string>();
    for (const path of criterion["evidence"]) {
      if (typeof path !== "string") {
        fail("CANDIDATE_SCHEMA_INVALID", "An acceptance evidence path is invalid.");
      }
      assertPortablePath(path);
      const evidenceBytes = verifiedBytes.get(path);
      if (evidenceBytes === undefined) {
        fail(
          "CANDIDATE_INTEGRITY_INVALID",
          "The acceptance ledger references missing candidate evidence.",
        );
      }
      evidenceHashes.set(path, sha256(evidenceBytes));
    }
    const verification = requireRecord(criterion["verification"], "criterion verification");
    assertExactKeys(verification, ["implementation", "liveProof"], "criterion verification");
    parseProof(verification["implementation"], sourceCommit, evidenceHashes);
    parseProof(verification["liveProof"], sourceCommit, evidenceHashes);
  }
  const candidateAttestation = requireRecord(
    value["candidateAttestation"],
    "candidate attestation",
  );
  assertExactKeys(
    candidateAttestation,
    ["sourceCommit", "attestationId", "evidence"],
    "candidate attestation",
  );
  const candidateEvidence = new Map<string, string>();
  if (
    candidateAttestation["sourceCommit"] !== sourceCommit ||
    typeof candidateAttestation["attestationId"] !== "string" ||
    !ATTESTATION_ID_PATTERN.test(candidateAttestation["attestationId"]) ||
    !Array.isArray(candidateAttestation["evidence"]) ||
    candidateAttestation["evidence"].length === 0
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The candidate attestation is invalid.");
  }
  for (const candidate of candidateAttestation["evidence"]) {
    const reference = requireRecord(candidate, "candidate attestation evidence");
    const path = requireString(reference["path"], "candidate attestation evidence path");
    assertPortablePath(path);
    const evidenceBytes = verifiedBytes.get(path);
    if (evidenceBytes !== undefined) {
      candidateEvidence.set(path, sha256(evidenceBytes));
    }
  }
  parseProof(candidateAttestation, sourceCommit, candidateEvidence);
  return {
    auditedAt: value["auditedAt"] as string,
    candidateAttestationId: candidateAttestation["attestationId"],
    sourceCommit,
  };
}

function parseProof(
  candidate: unknown,
  expectedCommit: string,
  evidenceHashes: ReadonlyMap<string, string>,
): void {
  const proof = requireRecord(candidate, "release proof");
  assertExactKeys(proof, ["sourceCommit", "attestationId", "evidence"], "release proof");
  if (
    proof["sourceCommit"] !== expectedCommit ||
    typeof proof["attestationId"] !== "string" ||
    !ATTESTATION_ID_PATTERN.test(proof["attestationId"]) ||
    !Array.isArray(proof["evidence"]) ||
    proof["evidence"].length === 0
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "A release proof is invalid.");
  }
  const paths = new Set<string>();
  for (const candidateReference of proof["evidence"]) {
    const reference = requireRecord(candidateReference, "release proof evidence");
    assertExactKeys(reference, ["path", "sha256"], "release proof evidence");
    const path = requireString(reference["path"], "release proof evidence path");
    if (
      paths.has(path) ||
      typeof reference["sha256"] !== "string" ||
      !SHA256_PATTERN.test(reference["sha256"]) ||
      evidenceHashes.get(path) !== reference["sha256"]
    ) {
      fail("CANDIDATE_INTEGRITY_INVALID", "A release proof evidence binding is invalid.");
    }
    paths.add(path);
  }
}

function parseReleaseMetadata(
  bytes: Uint8Array,
  target: ReleaseTarget,
  nativeComponents: NativeComponentsManifest,
  ledger: ParsedAcceptanceLedger,
  ledgerSha256: string,
  verifiedBytes: ReadonlyMap<string, Uint8Array>,
): ParsedReleaseMetadata {
  const value = parseCanonicalJsonObject(bytes, "release metadata");
  assertExactKeys(value, METADATA_KEYS, "release metadata");
  const productVersion = requireString(value["productVersion"], "product version");
  const buildCommit = requireString(value["buildCommit"], "build commit");
  const auditedSourceCommit = requireString(value["auditedSourceCommit"], "audited source commit");
  const buildId = requireString(value["buildId"], "build ID");
  if (
    value["schemaVersion"] !== 2 ||
    value["product"] !== "OpenDelegate" ||
    !SEMVER_PATTERN.test(productVersion) ||
    value["protocolVersion"] !== "v1" ||
    !isRfc3339Instant(value["createdAt"]) ||
    value["timestampPolicy"] !== "source-commit" ||
    value["platform"] !== target.platform ||
    value["architecture"] !== target.architecture ||
    value["bundledNodeVersion"] !== "24.18.0" ||
    !FULL_COMMIT_PATTERN.test(buildCommit) ||
    !FULL_COMMIT_PATTERN.test(auditedSourceCommit) ||
    buildCommit === auditedSourceCommit ||
    auditedSourceCommit !== ledger.sourceCommit ||
    value["buildSourceDirty"] !== false ||
    value["supportStatus"] !== "release-candidate" ||
    value["buildMode"] !== "release-candidate" ||
    value["fileManifest"] !== "payload-manifest.json" ||
    value["checksumManifest"] !== "SHA256SUMS"
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The release metadata is not a valid candidate.");
  }
  const runtimeExecutableSha256 = parseBundledRuntime(value["bundledRuntime"]);
  const runtimePath = target.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  const runtimeBytes = verifiedBytes.get(runtimePath);
  if (runtimeBytes === undefined || sha256(runtimeBytes) !== runtimeExecutableSha256) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The bundled runtime provenance does not bind the enclosed Node executable.",
    );
  }
  parseToolchain(value["toolchain"]);
  requireSha256(value["dependencyLockSha256"], "dependency lock digest");
  requireSha256(value["sourcePackageManifestSha256"], "source package manifest digest");
  parseRuntimeExternals(value["runtimeExternals"]);
  if (
    JSON.stringify(value["nativeComponents"]) !==
    JSON.stringify({
      schemaVersion: nativeComponents.schemaVersion,
      platform: nativeComponents.platform,
      architecture: nativeComponents.architecture,
      components: nativeComponents.components,
    })
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "Release metadata does not match the native component manifest.",
    );
  }
  parseChangedAttestationPaths(value["changedAttestationPaths"]);
  const releaseEvidence = requireRecord(value["releaseEvidence"], "release evidence summary");
  assertExactKeys(
    releaseEvidence,
    ["auditedAt", "releaseStatus", "sha256", "implementation", "liveProof", "complete"],
    "release evidence summary",
  );
  if (
    releaseEvidence["auditedAt"] !== ledger.auditedAt ||
    releaseEvidence["releaseStatus"] !== "candidate" ||
    releaseEvidence["sha256"] !== ledgerSha256 ||
    releaseEvidence["complete"] !== true
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The release metadata does not bind the enclosed acceptance ledger.",
    );
  }
  requireSha256(releaseEvidence["sha256"], "acceptance ledger digest");
  parseVerifiedCount(releaseEvidence["implementation"], "implementation count");
  parseVerifiedCount(releaseEvidence["liveProof"], "live proof count");
  const expectedEntrypoints =
    target.platform === "win32"
      ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
      : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"];
  if (
    !Array.isArray(value["entrypoints"]) ||
    value["entrypoints"].length !== expectedEntrypoints.length ||
    value["entrypoints"].some((entry, index) => entry !== expectedEntrypoints[index])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The release entrypoint set is invalid.");
  }
  return { auditedSourceCommit, buildCommit, buildId, productVersion };
}

function parseBundledRuntime(candidate: unknown): string {
  const value = requireRecord(candidate, "bundled runtime");
  assertExactKeys(
    value,
    [
      "source",
      "archive",
      "archiveUrl",
      "archiveSha256",
      "shasumsUrl",
      "executableSha256",
      "licenseSha256",
    ],
    "bundled runtime",
  );
  if (
    value["source"] !== "official-nodejs-distribution" ||
    !isNonEmptyString(value["archive"]) ||
    typeof value["archiveUrl"] !== "string" ||
    !isHttpsUrl(value["archiveUrl"]) ||
    typeof value["shasumsUrl"] !== "string" ||
    !isHttpsUrl(value["shasumsUrl"])
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The bundled runtime provenance is invalid.");
  }
  requireSha256(value["archiveSha256"], "runtime archive digest");
  const executableSha256 = requireSha256(value["executableSha256"], "runtime executable digest");
  requireSha256(value["licenseSha256"], "runtime license digest");
  return executableSha256;
}

function parseToolchain(candidate: unknown): void {
  const value = requireRecord(candidate, "release toolchain");
  assertExactKeys(value, ["packageManager", "bundler"], "release toolchain");
  if (value["packageManager"] !== "pnpm@11.15.1" || value["bundler"] !== "esbuild@0.28.1") {
    fail("CANDIDATE_SCHEMA_INVALID", "The release toolchain is not pinned.");
  }
}

function parseRuntimeExternals(candidate: unknown): void {
  if (!Array.isArray(candidate)) {
    fail("CANDIDATE_SCHEMA_INVALID", "The runtime external inventory is invalid.");
  }
  const expected = ["@node-rs/argon2", "better-sqlite3", "pg"];
  if (candidate.length !== expected.length) {
    fail("CANDIDATE_SCHEMA_INVALID", "The runtime external inventory is incomplete.");
  }
  for (const [index, item] of candidate.entries()) {
    const value = requireRecord(item, "runtime external");
    assertExactKeys(value, ["name", "version"], "runtime external");
    if (
      value["name"] !== expected[index] ||
      typeof value["version"] !== "string" ||
      !SEMVER_PATTERN.test(value["version"])
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "A runtime external identity is invalid.");
    }
  }
}

function parseChangedAttestationPaths(candidate: unknown): void {
  if (!Array.isArray(candidate) || candidate.length < 2) {
    fail("CANDIDATE_SCHEMA_INVALID", "The restricted attestation path set is incomplete.");
  }
  const paths = new Set<string>();
  let previous: string | undefined;
  for (const path of candidate) {
    if (typeof path !== "string") {
      fail("CANDIDATE_SCHEMA_INVALID", "A restricted attestation path is invalid.");
    }
    assertPortablePath(path);
    if (
      paths.has(path) ||
      (previous !== undefined && compareCodeUnits(previous, path) >= 0) ||
      (path !== "docs/release/acceptance-evidence.json" &&
        !path.startsWith("docs/release/evidence/"))
    ) {
      fail("CANDIDATE_SCHEMA_INVALID", "The restricted attestation path set is invalid.");
    }
    paths.add(path);
    previous = path;
  }
  if (!paths.has("docs/release/acceptance-evidence.json")) {
    fail("CANDIDATE_SCHEMA_INVALID", "The acceptance ledger is absent from the attestation diff.");
  }
}

function parseVerifiedCount(candidate: unknown, label: string): void {
  const value = requireRecord(candidate, label);
  assertExactKeys(value, ["verified"], label);
  if (value["verified"] !== 36) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} is incomplete.`);
  }
}

function parseSmokeEvidence(
  bytes: Uint8Array,
  target: ReleaseTarget,
  metadata: ParsedReleaseMetadata,
): void {
  const value = parseCanonicalJsonObject(bytes, "packaged smoke evidence");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "platform",
      "architecture",
      "bundledNodeVersion",
      "buildId",
      "productVersion",
      "checks",
    ],
    "packaged smoke evidence",
  );
  if (
    value["schemaVersion"] !== 1 ||
    value["platform"] !== target.platform ||
    value["architecture"] !== target.architecture ||
    value["bundledNodeVersion"] !== "24.18.0" ||
    value["buildId"] !== metadata.buildId ||
    value["productVersion"] !== metadata.productVersion
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The packaged smoke evidence target is invalid.");
  }
  const checks = requireRecord(value["checks"], "packaged smoke checks");
  assertExactKeys(
    checks,
    [
      "cliHelp",
      "backupCliHelp",
      "serviceCliHelp",
      "workerCliHelp",
      "workerCliVersion",
      "workerUnenrolledStatus",
      "cleanHomeInitialization",
      "mainHealth",
      "adminStaticApp",
      "loopbackOwnerClaim",
      "ownerLogin",
      "ownerSessionCookieContract",
      "ownerSessionRoundTrip",
      "recoveryCredentialsIssued",
      "cleanShutdown",
    ],
    "packaged smoke checks",
  );
  const simpleChecks = [
    "cliHelp",
    "backupCliHelp",
    "serviceCliHelp",
    "workerCliHelp",
    "workerCliVersion",
    "workerUnenrolledStatus",
    "cleanHomeInitialization",
    "mainHealth",
    "adminStaticApp",
    "loopbackOwnerClaim",
    "ownerLogin",
    "ownerSessionCookieContract",
    "ownerSessionRoundTrip",
  ];
  if (
    simpleChecks.some((name) => checks[name] !== "passed") ||
    !Number.isSafeInteger(checks["recoveryCredentialsIssued"]) ||
    (checks["recoveryCredentialsIssued"] as number) <= 0
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The packaged smoke checks are incomplete.");
  }
  const shutdown = requireRecord(checks["cleanShutdown"], "packaged clean shutdown");
  assertExactKeys(
    shutdown,
    [
      "status",
      "markerObserved",
      "naturalExit",
      "exitCode",
      "signal",
      "shutdownTimedOut",
      "forcedTermination",
    ],
    "packaged clean shutdown",
  );
  if (
    shutdown["status"] !== "passed" ||
    shutdown["markerObserved"] !== true ||
    shutdown["naturalExit"] !== true ||
    shutdown["exitCode"] !== 0 ||
    shutdown["signal"] !== null ||
    shutdown["shutdownTimedOut"] !== false ||
    shutdown["forcedTermination"] !== false
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "The packaged clean shutdown proof is invalid.");
  }
}

function expectedNativeComponents(
  platform: ReleasePlatform,
): readonly { readonly kind: string; readonly path: string }[] {
  if (platform === "darwin") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
      { kind: "computer-use-helper", path: "libexec/opendelegate-macos-computer-use" },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-macos-computer-use-fixture",
      },
      { kind: "secret-store-helper", path: "runtime/native/opendelegate-keychain-helper" },
    ];
  }
  if (platform === "win32") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host.exe" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper.exe" },
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-windows-computer-use-helper.exe",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-windows-computer-use-fixture.exe",
      },
    ];
  }
  return [
    { kind: "core-service-host", path: "bin/opendelegate-service-host" },
    { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
    { kind: "computer-use-helper", path: "libexec/opendelegate-linux-computer-use" },
    {
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-linux-computer-use-fixture",
    },
  ];
}

function requireVerifiedBytes(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) {
    fail("CANDIDATE_SCHEMA_INVALID", "The release candidate is missing a required record.");
  }
  return bytes;
}

function parseCanonicalJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  const text = decodeUtf8(bytes, label);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReleaseIntegrityError(
      "CANDIDATE_SCHEMA_INVALID",
      `The ${label} is not valid canonical JSON.`,
      { cause: error },
    );
  }
  const record = requireRecord(value, label);
  if (`${JSON.stringify(record, null, 2)}\n` !== text) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} is not canonical JSON.`);
  }
  return record;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ReleaseIntegrityError(
      "CANDIDATE_SCHEMA_INVALID",
      `The ${label} is not valid UTF-8.`,
      { cause: error },
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} must be a non-empty string.`);
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} fields do not match their strict schema.`);
  }
}

function assertSafeSegment(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    segment.normalize("NFC") !== segment
  ) {
    fail("CANDIDATE_IO_INVALID", "The release candidate contains an unsafe path segment.");
  }
}

function assertPortablePath(path: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("CANDIDATE_SCHEMA_INVALID", "A release record contains an unsafe relative path.");
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("CANDIDATE_SCHEMA_INVALID", `The ${label} is invalid.`);
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isBoundedDisplayString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isAppleDeveloperIdSelector(selector: unknown, teamId: unknown): selector is string {
  return (
    isBoundedDisplayString(selector, 200) &&
    typeof teamId === "string" &&
    selector.startsWith("Developer ID Application: ") &&
    selector.endsWith(` (${teamId})`)
  );
}

function isRfc3339Instant(value: unknown): value is string {
  return (
    typeof value === "string" && RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function promotionAuthorizationSigningBytes(canonicalBytes: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from("OpenDelegate promotion authorization v1\n", "utf8"),
    canonicalBytes,
  ]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function isPathDescendant(parent: string, candidate: string): boolean {
  const difference = relative(resolve(parent), resolve(candidate));
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

export interface PublisherCandidateBinding {
  readonly acceptanceLedgerSha256: string;
  readonly auditedSourceCommit: string;
  readonly buildCommit: string;
  readonly candidateAttestationId: string;
  readonly checksumManifestSha256: string;
  readonly nativeComponentsSha256: string;
  readonly payloadManifestSha256: string;
  readonly platformAuthenticitySha256: string;
  readonly productVersion: string;
  readonly publisherCandidateStatementSha256: string;
  readonly releaseMetadataSha256: string;
  readonly target: ReleaseTarget;
}

export interface PublisherAttestationStatementValue {
  readonly archive: VerifiedArchive;
  readonly candidate: PublisherCandidateBinding;
  readonly domain: "opendelegate.release.publisher-attestation.v2";
  readonly product: "OpenDelegate";
  readonly schemaVersion: 2;
}

export interface ComposedPublisherAttestationStatement {
  readonly canonicalBytes: Uint8Array;
  readonly domain: "opendelegate.release.publisher-attestation.v2";
  readonly sha256: string;
  readonly signingBytes: Uint8Array;
  readonly statement: PublisherAttestationStatementValue;
}

export function composePublisherAttestationStatement(input: {
  readonly archive: VerifiedArchive;
  readonly candidate: CandidateDescription;
}): ComposedPublisherAttestationStatement {
  if (
    typeof input !== "object" ||
    input === null ||
    !inspectedCandidateObjects.has(input.candidate)
  ) {
    fail(
      "PUBLISHER_STATEMENT_INVALID",
      "Publisher composition requires an inspected release candidate.",
    );
  }
  const parsedArchive = parseArchiveRecord(
    input.archive,
    "publisher archive",
    "PUBLISHER_STATEMENT_INVALID",
  );
  const archive = Object.freeze(parsedArchive);
  const candidate = createPublisherCandidateBinding(input.candidate);
  const statement = Object.freeze({
    schemaVersion: 2 as const,
    product: "OpenDelegate" as const,
    domain: PUBLISHER_ATTESTATION_DOMAIN,
    candidate,
    archive,
  });
  const canonicalBytes = canonicalJsonBytes(statement);
  const signingBytes = Buffer.concat([
    Buffer.from("OpenDelegate publisher attestation v2\n", "utf8"),
    canonicalBytes,
  ]);
  const composed = Object.freeze({
    get canonicalBytes(): Uint8Array {
      return Uint8Array.from(canonicalBytes);
    },
    domain: PUBLISHER_ATTESTATION_DOMAIN,
    sha256: sha256(canonicalBytes),
    get signingBytes(): Uint8Array {
      return Uint8Array.from(signingBytes);
    },
    statement,
  });
  signableStatementBrands.set(composed, {
    role: "publisher",
    schemaVersion: 2,
    statement,
  });
  return composed;
}

export interface CandidatePublisherEvidence {
  readonly archivePath: string;
  readonly attestationPath: string;
}

export interface ReleasePublisherTrust {
  readonly publicKeyPem: Uint8Array;
}

export interface ReleaseVerificationPolicy {
  readonly revokedCertificateIdentities?: readonly string[];
  readonly revokedPromotionKeyIds?: readonly string[];
  readonly revokedPublisherKeyIds?: readonly string[];
  readonly revokedStatementIds?: readonly string[];
}

export interface PromotionSidecarEvidence {
  readonly attestationPath: string;
  readonly liveEvidence: readonly ImmutableLiveEvidenceFile[];
  readonly notarizationReceiptPath: string;
  readonly supportMatrix: ImmutableEvidenceFile;
}

export interface ImmutableEvidenceFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}

export interface PromotionReceiptEvidence {
  readonly receiptPath: string;
}

export interface ReleasePromotionTrust {
  readonly publicKeyPem: Uint8Array;
}

export interface VerifyReleaseInput extends InspectCandidateInput {
  readonly candidatePublisherEvidence: CandidatePublisherEvidence;
  readonly publisherTrust: ReleasePublisherTrust;
  readonly expectedCandidateDigest?: string;
  readonly promotionAttestation?: PromotionSidecarEvidence;
  readonly promotionReceipt?: PromotionReceiptEvidence;
  readonly promotionTrust?: ReleasePromotionTrust;
  readonly policy?: ReleaseVerificationPolicy;
}

export interface VerifiedArchive {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface VerifiedRelease {
  readonly archive: VerifiedArchive;
  readonly candidate: CandidateDescription;
  readonly effectiveChannel: "release-candidate" | "released";
  readonly promotionStatementId?: string;
  readonly publisherAttestationSha256: string;
  readonly publisherKeyId: string;
  readonly receiptId?: string;
}

export async function verifyRelease(input: VerifyReleaseInput): Promise<VerifiedRelease> {
  const candidate = await inspectCandidate(input);
  if (
    input.expectedCandidateDigest !== undefined &&
    (!SHA256_PATTERN.test(input.expectedCandidateDigest) ||
      input.expectedCandidateDigest !== candidate.publisherStatement.sha256)
  ) {
    fail(
      "CANDIDATE_INTEGRITY_INVALID",
      "The candidate does not match the expected immutable description digest.",
    );
  }
  const reader = input.reader ?? nodeReleaseFileReader;
  const publisher = await verifyPublisherEvidence(
    reader,
    candidate,
    input.candidatePublisherEvidence,
    input.publisherTrust,
    input.policy,
  );
  const promotionSupplied = input.promotionAttestation !== undefined;
  const receiptSupplied = input.promotionReceipt !== undefined;
  if (!promotionSupplied && !receiptSupplied) {
    const verified = Object.freeze({
      archive: publisher.archive,
      candidate,
      effectiveChannel: "release-candidate",
      publisherAttestationSha256: publisher.attestationSha256,
      publisherKeyId: publisher.keyId,
    });
    verifiedReleaseObjects.add(verified);
    return verified;
  }
  if (!promotionSupplied || !receiptSupplied || input.promotionTrust === undefined) {
    fail(
      "PROMOTION_INPUT_INVALID",
      "Promotion requires the complete attestation, receipt, evidence, and trust root set.",
    );
  }
  const promoted = await verifyPromotionChain(
    reader,
    candidate,
    publisher,
    input.promotionAttestation!,
    input.promotionReceipt!,
    input.promotionTrust,
    input.policy,
  );
  const verified = Object.freeze({
    archive: publisher.archive,
    candidate,
    effectiveChannel: "released" as const,
    promotionStatementId: promoted.statementId,
    publisherAttestationSha256: publisher.attestationSha256,
    publisherKeyId: publisher.keyId,
    receiptId: promoted.receiptId,
  });
  verifiedReleaseObjects.add(verified);
  return verified;
}

export async function resolveConfiguredRelease(
  input: ResolveConfiguredReleaseInput,
): Promise<ConfiguredReleaseResolution> {
  return resolveConfiguredReleaseWithDependencies(input, {
    defaultReader: nodeReleaseFileReader,
    inspectCandidate,
    releaseErrorCode(error) {
      return error instanceof ReleaseIntegrityError ? error.code : undefined;
    },
    verifyRelease,
  });
}

interface VerifiedPublisherEvidence {
  readonly archive: VerifiedArchive;
  readonly attestationSha256: string;
  readonly keyId: string;
}

async function verifyPublisherEvidence(
  reader: ReleaseFileReader,
  candidate: CandidateDescription,
  evidence: CandidatePublisherEvidence,
  trust: ReleasePublisherTrust,
  policy: ReleaseVerificationPolicy | undefined,
): Promise<VerifiedPublisherEvidence> {
  if (
    !isNonEmptyString(evidence?.archivePath) ||
    !isNonEmptyString(evidence?.attestationPath) ||
    !(trust?.publicKeyPem instanceof Uint8Array) ||
    trust.publicKeyPem.byteLength === 0 ||
    trust.publicKeyPem.byteLength > MAXIMUM_KEY_BYTES
  ) {
    fail("PUBLISHER_TRUST_INVALID", "The publisher evidence or trust root is invalid.");
  }
  const attestationBytes = await readExternalFile(
    reader,
    evidence.attestationPath,
    MAXIMUM_ATTESTATION_BYTES,
    "publisher attestation",
    "PUBLISHER_TRUST_INVALID",
  );
  const key = parseEd25519TrustRoot(trust.publicKeyPem, "publisher", "PUBLISHER_TRUST_INVALID");
  const keyDer = key.export({ format: "der", type: "spki" });
  const keyId = `sha256:${sha256(Buffer.from(keyDer))}`;
  const attestation = parseSignedReleaseEnvelope(
    attestationBytes,
    keyId,
    2,
    "publisher",
    "publisher attestation",
    "PUBLISHER_TRUST_INVALID",
  );
  if (policy?.revokedPublisherKeyIds?.includes(keyId) === true) {
    fail("RELEASE_REVOKED", "The publisher trust root is revoked by release policy.");
  }
  const statement = requireExternalRecord(
    attestation.statement,
    "publisher statement",
    "PUBLISHER_TRUST_INVALID",
  );
  assertExternalExactKeys(
    statement,
    ["schemaVersion", "product", "domain", "candidate", "archive"],
    "publisher statement",
    "PUBLISHER_TRUST_INVALID",
  );
  if (
    statement["schemaVersion"] !== 2 ||
    statement["product"] !== "OpenDelegate" ||
    statement["domain"] !== PUBLISHER_ATTESTATION_DOMAIN
  ) {
    fail("PUBLISHER_TRUST_INVALID", "The publisher statement domain is invalid.");
  }
  const archive = parsePublishedArchive(
    statement["archive"],
    evidence.archivePath,
    "PUBLISHER_TRUST_INVALID",
  );
  const archiveBytes = await readExternalFile(
    reader,
    evidence.archivePath,
    archive.size,
    "release archive",
    "PUBLISHER_TRUST_INVALID",
  );
  if (archiveBytes.byteLength !== archive.size || sha256(archiveBytes) !== archive.sha256) {
    fail(
      "PUBLISHER_TRUST_INVALID",
      "The publisher statement does not bind the exact final archive.",
    );
  }
  const composed = composePublisherAttestationStatement({ archive, candidate });
  if (!Buffer.from(composed.canonicalBytes).equals(Buffer.from(canonicalJsonBytes(statement)))) {
    fail(
      "PUBLISHER_TRUST_INVALID",
      "The publisher statement does not bind the inspected candidate and archive.",
    );
  }
  if (
    !verifySignature(
      null,
      composed.signingBytes,
      key,
      Buffer.from(attestation.signature, "base64url"),
    )
  ) {
    fail("PUBLISHER_TRUST_INVALID", "The publisher signature is invalid.");
  }
  return Object.freeze({
    archive: Object.freeze(archive),
    attestationSha256: sha256(attestationBytes),
    keyId,
  });
}

function createPublisherCandidateBinding(
  candidate: CandidateDescription,
): PublisherCandidateBinding {
  const target = Object.freeze({
    platform: candidate.target.platform,
    architecture: candidate.target.architecture,
  });
  return Object.freeze({
    publisherCandidateStatementSha256: candidate.publisherStatement.sha256,
    target,
    productVersion: candidate.productVersion,
    buildCommit: candidate.buildCommit,
    auditedSourceCommit: candidate.auditedSourceCommit,
    acceptanceLedgerSha256: candidate.acceptanceLedgerSha256,
    candidateAttestationId: candidate.candidateAttestationId,
    checksumManifestSha256: candidate.checksumManifestSha256,
    payloadManifestSha256: candidate.payloadManifestSha256,
    releaseMetadataSha256: candidate.releaseMetadataSha256,
    nativeComponentsSha256: candidate.nativeComponentsSha256,
    platformAuthenticitySha256: candidate.platformAuthenticitySha256,
  });
}

function parsePublishedArchive(
  candidate: unknown,
  archivePath: string,
  code: ReleaseIntegrityErrorCode,
): VerifiedArchive {
  const value = requireExternalRecord(candidate, "published archive", code);
  assertExternalExactKeys(value, ["path", "size", "sha256"], "published archive", code);
  const path = value["path"];
  const size = value["size"];
  const digest = value["sha256"];
  if (
    typeof path !== "string" ||
    path === "" ||
    path !== basename(archivePath) ||
    path.includes("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    !Number.isSafeInteger(size) ||
    (size as number) <= 0 ||
    (size as number) > MAXIMUM_ARCHIVE_BYTES ||
    typeof digest !== "string" ||
    !SHA256_PATTERN.test(digest)
  ) {
    fail(code, "The published archive identity is invalid.");
  }
  return { path, size: size as number, sha256: digest };
}

async function readExternalFile(
  reader: ReleaseFileReader,
  path: string,
  maximumBytes: number,
  label: string,
  code: ReleaseIntegrityErrorCode,
): Promise<Uint8Array> {
  if (!isNonEmptyString(path) || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    fail(code, `The ${label} reference is invalid.`);
  }
  try {
    return await reader.read(path, maximumBytes);
  } catch (error) {
    throw new ReleaseIntegrityError(
      code,
      `The ${label} is missing, oversized, linked, or unstable.`,
      { cause: error },
    );
  }
}

function parseEd25519TrustRoot(bytes: Uint8Array, role: string, code: ReleaseIntegrityErrorCode) {
  try {
    const key = createPublicKey(Buffer.from(bytes));
    if (key.asymmetricKeyType !== "ed25519") {
      fail(code, `The ${role} trust root is not an Ed25519 public key.`);
    }
    return key;
  } catch (error) {
    if (error instanceof ReleaseIntegrityError) {
      throw error;
    }
    throw new ReleaseIntegrityError(code, `The ${role} trust root is unreadable.`, {
      cause: error,
    });
  }
}

function parseExternalCanonicalJson(
  bytes: Uint8Array,
  label: string,
  code: ReleaseIntegrityErrorCode,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ReleaseIntegrityError(code, `The ${label} is not valid UTF-8.`, {
      cause: error,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReleaseIntegrityError(code, `The ${label} is not valid JSON.`, {
      cause: error,
    });
  }
  const record = requireExternalRecord(value, label, code);
  if (`${JSON.stringify(record, null, 2)}\n` !== text) {
    fail(code, `The ${label} is not canonical JSON.`);
  }
  return record;
}

function requireExternalRecord(
  value: unknown,
  label: string,
  code: ReleaseIntegrityErrorCode,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `The ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExternalExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
  code: ReleaseIntegrityErrorCode,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `The ${label} fields do not match their strict schema.`);
  }
}

interface VerifiedPromotionChain {
  readonly receiptId: string;
  readonly statementId: string;
}

interface ParsedPromotionTarget {
  readonly archive: VerifiedArchive;
  readonly candidate: Record<string, unknown>;
  readonly notarization: Record<string, unknown> | null;
  readonly platformAuthenticity: Record<string, unknown>;
  readonly publisher: {
    readonly attestationSha256: string;
    readonly keyId: string;
  };
  readonly target: ReleaseTarget;
}

interface ParsedPromotionAuthorization {
  readonly channel: string;
  readonly productVersion: string;
  readonly releaseId: string;
  readonly statementId: string;
  readonly targets: readonly ParsedPromotionTarget[];
}

async function verifyPromotionChain(
  reader: ReleaseFileReader,
  candidate: CandidateDescription,
  publisher: VerifiedPublisherEvidence,
  promotionEvidence: PromotionSidecarEvidence,
  receiptEvidence: PromotionReceiptEvidence,
  trust: ReleasePromotionTrust,
  policy: ReleaseVerificationPolicy | undefined,
): Promise<VerifiedPromotionChain> {
  if (
    !(trust.publicKeyPem instanceof Uint8Array) ||
    trust.publicKeyPem.byteLength === 0 ||
    trust.publicKeyPem.byteLength > MAXIMUM_KEY_BYTES
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promotion trust root is invalid.");
  }
  const key = parseEd25519TrustRoot(trust.publicKeyPem, "promotion", "PROMOTION_TRUST_INVALID");
  const keyId = `sha256:${sha256(Buffer.from(key.export({ format: "der", type: "spki" })))}`;
  if (keyId === publisher.keyId) {
    fail("PROMOTION_TRUST_INVALID", "Publisher and promotion trust roots must be distinct.");
  }
  if (policy?.revokedPromotionKeyIds?.includes(keyId) === true) {
    fail("RELEASE_REVOKED", "The promotion trust root is revoked by release policy.");
  }
  const attestationBytes = await readExternalFile(
    reader,
    promotionEvidence.attestationPath,
    MAXIMUM_ATTESTATION_BYTES,
    "promotion attestation",
    "PROMOTION_TRUST_INVALID",
  );
  const envelope = parseSignedPromotionEnvelope(attestationBytes, keyId, "promotion attestation");
  const statementBytes = canonicalJsonBytes(envelope.statement);
  if (
    !verifySignature(
      null,
      promotionAuthorizationSigningBytes(statementBytes),
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promotion signature is invalid.");
  }
  const promotion = await parsePromotionAuthorization(
    reader,
    envelope.statement,
    candidate,
    publisher,
    promotionEvidence,
    policy,
  );
  if (promotion.targets.some((target) => target.publisher.keyId === keyId)) {
    fail(
      "PROMOTION_TRUST_INVALID",
      "The promotion trust root must be distinct from every publisher trust root.",
    );
  }
  if (policy?.revokedStatementIds?.includes(promotion.statementId) === true) {
    fail("RELEASE_REVOKED", "The promotion statement is revoked by release policy.");
  }

  const receiptBytes = await readExternalFile(
    reader,
    receiptEvidence.receiptPath,
    MAXIMUM_ATTESTATION_BYTES,
    "supported-channel receipt",
    "PROMOTION_TRUST_INVALID",
  );
  const receiptEnvelope = parseSignedPromotionEnvelope(
    receiptBytes,
    keyId,
    "supported-channel receipt",
  );
  const receipt = parseSupportedChannelReceipt(
    receiptEnvelope.statement,
    promotion,
    sha256(attestationBytes),
  );
  if (
    !verifySignature(
      null,
      receipt.signingBytes,
      key,
      Buffer.from(receiptEnvelope.signature, "base64url"),
    )
  ) {
    fail("PROMOTION_TRUST_INVALID", "The supported-channel receipt signature is invalid.");
  }
  if (policy?.revokedStatementIds?.includes(receipt.receiptId) === true) {
    fail("RELEASE_REVOKED", "The supported-channel receipt is revoked by release policy.");
  }
  return { receiptId: receipt.receiptId, statementId: promotion.statementId };
}

function parseSignedPromotionEnvelope(
  bytes: Uint8Array,
  expectedKeyId: string,
  label: string,
): {
  readonly signature: string;
  readonly statement: Record<string, unknown>;
} {
  return parseSignedReleaseEnvelope(
    bytes,
    expectedKeyId,
    1,
    "promotion",
    label,
    "PROMOTION_TRUST_INVALID",
  );
}

function parseSignedReleaseEnvelope(
  bytes: Uint8Array,
  expectedKeyId: string,
  expectedSchemaVersion: 1 | 2,
  expectedRole: "promotion" | "publisher",
  label: string,
  code: ReleaseIntegrityErrorCode,
): {
  readonly signature: string;
  readonly statement: Record<string, unknown>;
} {
  const envelope = parseExternalCanonicalJson(bytes, label, code);
  assertExternalExactKeys(envelope, SIGNED_RELEASE_ENVELOPE_KEYS, label, code);
  if (
    envelope["schemaVersion"] !== expectedSchemaVersion ||
    envelope["product"] !== "OpenDelegate" ||
    envelope["role"] !== expectedRole ||
    envelope["algorithm"] !== "ed25519" ||
    envelope["keyId"] !== expectedKeyId ||
    typeof envelope["signature"] !== "string" ||
    !BASE64_URL_SIGNATURE_PATTERN.test(envelope["signature"])
  ) {
    fail(code, `The ${label} fields are invalid.`);
  }
  return {
    signature: envelope["signature"],
    statement: requireExternalRecord(envelope["statement"], `${label} statement`, code),
  };
}

async function parsePromotionAuthorization(
  reader: ReleaseFileReader,
  statement: Record<string, unknown>,
  candidate: CandidateDescription,
  publisher: VerifiedPublisherEvidence,
  evidence: PromotionSidecarEvidence,
  policy: ReleaseVerificationPolicy | undefined,
): Promise<ParsedPromotionAuthorization> {
  assertExternalExactKeys(
    statement,
    [
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
    "promotion authorization",
    "PROMOTION_TRUST_INVALID",
  );
  const releaseId = requirePromotionString(statement["releaseId"], "release ID");
  const productVersion = requirePromotionString(statement["productVersion"], "product version");
  const channel = requirePromotionString(statement["channel"], "supported channel");
  const statementId = requirePromotionString(statement["statementId"], "statement ID");
  const auditedSourceCommit = requirePromotionString(
    statement["auditedSourceCommit"],
    "audited source commit",
  );
  const buildCommit = requirePromotionString(statement["buildCommit"], "build commit");
  if (
    statement["schemaVersion"] !== 1 ||
    statement["product"] !== "OpenDelegate" ||
    statement["role"] !== "promotion" ||
    statement["domain"] !== PROMOTION_AUTHORIZATION_DOMAIN ||
    !isValidExternalId(releaseId) ||
    !SEMVER_PATTERN.test(productVersion) ||
    !/^[a-z][a-z0-9-]{1,31}$/u.test(channel) ||
    channel.includes("preview") ||
    channel === "release-candidate" ||
    !isRfc3339Instant(statement["issuedAt"]) ||
    !isValidExternalId(statementId) ||
    statement["publicationPolicy"] !== "immutable-assets-with-remote-digest-readback" ||
    !FULL_COMMIT_PATTERN.test(auditedSourceCommit) ||
    !FULL_COMMIT_PATTERN.test(buildCommit) ||
    auditedSourceCommit === buildCommit
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promotion authorization fields are invalid.");
  }
  const ledger = requireExternalRecord(
    statement["acceptanceLedger"],
    "promotion acceptance ledger",
    "PROMOTION_TRUST_INVALID",
  );
  assertExternalExactKeys(
    ledger,
    ["schemaVersion", "sha256", "candidateAttestationId"],
    "promotion acceptance ledger",
    "PROMOTION_TRUST_INVALID",
  );
  if (
    ledger["schemaVersion"] !== 1 ||
    typeof ledger["sha256"] !== "string" ||
    !SHA256_PATTERN.test(ledger["sha256"]) ||
    typeof ledger["candidateAttestationId"] !== "string" ||
    !ATTESTATION_ID_PATTERN.test(ledger["candidateAttestationId"])
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promoted acceptance ledger identity is invalid.");
  }
  const expectedSupportMatrix = evidenceReference(
    evidence.supportMatrix,
    "support matrix",
    "PROMOTION_TRUST_INVALID",
  );
  const declaredSupportMatrix = parseEvidenceReference(
    statement["supportMatrix"],
    "promotion support matrix",
    "PROMOTION_TRUST_INVALID",
  );
  if (
    expectedSupportMatrix.path !== "docs/release/SUPPORT_MATRIX.md" ||
    JSON.stringify(declaredSupportMatrix) !== JSON.stringify(expectedSupportMatrix)
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promotion support matrix binding is invalid.");
  }
  const expectedLiveEvidence = canonicalizeLiveEvidenceWithCode(
    evidence.liveEvidence,
    "PROMOTION_TRUST_INVALID",
  );
  const declaredLiveEvidence = parseDeclaredLiveEvidence(statement["liveEvidence"]);
  if (JSON.stringify(declaredLiveEvidence) !== JSON.stringify(expectedLiveEvidence)) {
    fail("PROMOTION_TRUST_INVALID", "The promotion live-evidence binding is invalid.");
  }
  const targets = parsePromotionTargets(
    statement["targets"],
    {
      acceptanceLedgerSha256: ledger["sha256"],
      auditedSourceCommit,
      buildCommit,
      candidateAttestationId: ledger["candidateAttestationId"],
      productVersion,
    },
    policy,
  );
  const currentIndex = FIRST_MILESTONE_TARGETS.findIndex(
    (target) => targetKey(target) === targetKey(candidate.target),
  );
  const current = targets[currentIndex];
  if (
    current === undefined ||
    JSON.stringify(current.archive) !== JSON.stringify(publisher.archive) ||
    JSON.stringify(current.candidate) !==
      JSON.stringify(createPublisherCandidateBinding(candidate)) ||
    current.publisher.keyId !== publisher.keyId ||
    current.publisher.attestationSha256 !== publisher.attestationSha256 ||
    current.platformAuthenticity["recordSha256"] !== candidate.platformAuthenticitySha256 ||
    JSON.stringify(current.platformAuthenticity["certificateIdentities"]) !==
      JSON.stringify(candidate.platformCertificateIdentities) ||
    current.platformAuthenticity["productCertificateIdentity"] !==
      candidate.platformProductCertificateIdentity
  ) {
    fail(
      "PROMOTION_TRUST_INVALID",
      "The promotion does not include this exact publisher-authenticated candidate.",
    );
  }
  const mac = targets[0]!;
  if (mac.notarization === null) {
    fail("PROMOTION_TRUST_INVALID", "The macOS target lacks notarization.");
  }
  const declaredReceipt = parseEvidenceReference(
    mac.notarization["receipt"],
    "promotion notarization receipt",
    "PROMOTION_TRUST_INVALID",
  );
  const notarizationBytes = await readExternalFile(
    reader,
    evidence.notarizationReceiptPath,
    MAXIMUM_ATTESTATION_BYTES,
    "macOS notarization receipt",
    "PROMOTION_TRUST_INVALID",
  );
  if (declaredReceipt.sha256 !== sha256(notarizationBytes)) {
    fail("PROMOTION_TRUST_INVALID", "The notarization receipt digest is invalid.");
  }
  const parsedNotarization = parseNotarizationReceipt(
    { path: declaredReceipt.path, bytes: notarizationBytes },
    mac.archive,
    requireAppleTeamId(
      mac.platformAuthenticity["productCertificateIdentity"],
      "PROMOTION_TRUST_INVALID",
    ),
    "PROMOTION_TRUST_INVALID",
  );
  if (
    mac.notarization["submissionId"] !== parsedNotarization.submissionId ||
    mac.notarization["status"] !== "accepted" ||
    mac.notarization["teamId"] !== parsedNotarization.teamId ||
    mac.notarization["resultId"] !== parsedNotarization.resultId ||
    mac.notarization["logId"] !== parsedNotarization.logId
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promoted notarization identity is invalid.");
  }
  return {
    channel,
    productVersion,
    releaseId,
    statementId,
    targets,
  };
}

function parsePromotionTargets(
  candidate: unknown,
  common: {
    readonly acceptanceLedgerSha256: unknown;
    readonly auditedSourceCommit: string;
    readonly buildCommit: string;
    readonly candidateAttestationId: unknown;
    readonly productVersion: string;
  },
  policy: ReleaseVerificationPolicy | undefined,
): readonly ParsedPromotionTarget[] {
  if (!Array.isArray(candidate) || candidate.length !== FIRST_MILESTONE_TARGETS.length) {
    fail("PROMOTION_TRUST_INVALID", "The promotion target set is incomplete.");
  }
  const archivePaths = new Set<string>();
  return Object.freeze(
    candidate.map((item, index) => {
      const value = requireExternalRecord(item, "promotion target", "PROMOTION_TRUST_INVALID");
      assertExternalExactKeys(
        value,
        ["target", "archive", "candidate", "publisher", "platformAuthenticity", "notarization"],
        "promotion target",
        "PROMOTION_TRUST_INVALID",
      );
      const target = parseTargetRecord(
        value["target"],
        "promotion target tuple",
        "PROMOTION_TRUST_INVALID",
      );
      const expectedTarget = FIRST_MILESTONE_TARGETS[index]!;
      if (targetKey(target) !== targetKey(expectedTarget)) {
        fail(
          "PROMOTION_TRUST_INVALID",
          "The promotion target set is duplicated, substituted, or not canonical.",
        );
      }
      const archive = parseArchiveRecord(
        value["archive"],
        "promoted archive",
        "PROMOTION_TRUST_INVALID",
      );
      if (archivePaths.has(archive.path)) {
        fail("PROMOTION_TRUST_INVALID", "Promoted archive identities are duplicated.");
      }
      archivePaths.add(archive.path);
      const candidateBinding = requireExternalRecord(
        value["candidate"],
        "promoted candidate binding",
        "PROMOTION_TRUST_INVALID",
      );
      validatePromotionCandidateBinding(candidateBinding, target, common);
      const publisher = requireExternalRecord(
        value["publisher"],
        "promoted publisher",
        "PROMOTION_TRUST_INVALID",
      );
      assertExternalExactKeys(
        publisher,
        ["keyId", "attestationSha256"],
        "promoted publisher",
        "PROMOTION_TRUST_INVALID",
      );
      if (
        typeof publisher["keyId"] !== "string" ||
        !QUALIFIED_SHA256_PATTERN.test(publisher["keyId"]) ||
        typeof publisher["attestationSha256"] !== "string" ||
        !SHA256_PATTERN.test(publisher["attestationSha256"])
      ) {
        fail("PROMOTION_TRUST_INVALID", "A promoted publisher identity is invalid.");
      }
      if (policy?.revokedPublisherKeyIds?.includes(publisher["keyId"]) === true) {
        fail("RELEASE_REVOKED", "A promoted publisher key is revoked by release policy.");
      }
      const platformAuthenticity = parsePromotionPlatformAuthenticity(
        value["platformAuthenticity"],
        target,
        candidateBinding,
        policy,
      );
      const notarization =
        value["notarization"] === null ? null : parsePromotionNotarization(value["notarization"]);
      if (
        (target.platform === "darwin" && notarization === null) ||
        (target.platform !== "darwin" && notarization !== null)
      ) {
        fail("PROMOTION_TRUST_INVALID", "Notarization is missing or attached to the wrong target.");
      }
      return Object.freeze({
        archive: Object.freeze(archive),
        candidate: candidateBinding,
        notarization,
        platformAuthenticity,
        publisher: Object.freeze({
          attestationSha256: publisher["attestationSha256"],
          keyId: publisher["keyId"],
        }),
        target: Object.freeze(target),
      });
    }),
  );
}

function validatePromotionCandidateBinding(
  binding: Record<string, unknown>,
  target: ReleaseTarget,
  common: {
    readonly acceptanceLedgerSha256: unknown;
    readonly auditedSourceCommit: string;
    readonly buildCommit: string;
    readonly candidateAttestationId: unknown;
    readonly productVersion: string;
  },
): void {
  assertExternalExactKeys(
    binding,
    PUBLISHER_CANDIDATE_BINDING_KEYS,
    "promoted candidate binding",
    "PROMOTION_TRUST_INVALID",
  );
  const bindingTarget = parseTargetRecord(
    binding["target"],
    "promoted candidate target",
    "PROMOTION_TRUST_INVALID",
  );
  const digestFields = [
    "publisherCandidateStatementSha256",
    "acceptanceLedgerSha256",
    "checksumManifestSha256",
    "payloadManifestSha256",
    "releaseMetadataSha256",
    "nativeComponentsSha256",
    "platformAuthenticitySha256",
  ];
  if (
    targetKey(bindingTarget) !== targetKey(target) ||
    binding["productVersion"] !== common.productVersion ||
    binding["buildCommit"] !== common.buildCommit ||
    binding["auditedSourceCommit"] !== common.auditedSourceCommit ||
    binding["acceptanceLedgerSha256"] !== common.acceptanceLedgerSha256 ||
    binding["candidateAttestationId"] !== common.candidateAttestationId ||
    digestFields.some(
      (field) =>
        typeof binding[field] !== "string" || !SHA256_PATTERN.test(binding[field] as string),
    )
  ) {
    fail("PROMOTION_TRUST_INVALID", "A promoted candidate identity is inconsistent.");
  }
}

function parsePromotionPlatformAuthenticity(
  candidate: unknown,
  target: ReleaseTarget,
  candidateBinding: Record<string, unknown>,
  policy: ReleaseVerificationPolicy | undefined,
): Record<string, unknown> {
  const value = requireExternalRecord(
    candidate,
    "promoted platform authenticity",
    "PROMOTION_TRUST_INVALID",
  );
  assertExternalExactKeys(
    value,
    ["recordSha256", "certificateIdentities", "productCertificateIdentity", "verificationEvidence"],
    "promoted platform authenticity",
    "PROMOTION_TRUST_INVALID",
  );
  const identities = value["certificateIdentities"];
  const productCertificateIdentity = value["productCertificateIdentity"];
  const verificationEvidence = value["verificationEvidence"];
  const expectedIdentityPattern =
    target.platform === "darwin"
      ? /^apple-team:[A-Z0-9]{10}$/u
      : target.platform === "win32"
        ? /^authenticode-sha1:[A-F0-9]{40}$/u
        : undefined;
  if (
    value["recordSha256"] !== candidateBinding["platformAuthenticitySha256"] ||
    !Array.isArray(identities) ||
    identities.length !== (target.platform === "linux" ? 0 : 2) ||
    new Set(identities).size !== identities.length ||
    identities.some(
      (identity) =>
        !isNonEmptyString(identity) ||
        expectedIdentityPattern === undefined ||
        !expectedIdentityPattern.test(identity),
    ) ||
    (target.platform === "linux"
      ? productCertificateIdentity !== null
      : typeof productCertificateIdentity !== "string" ||
        !expectedIdentityPattern?.test(productCertificateIdentity) ||
        identities[0] !== productCertificateIdentity) ||
    !Array.isArray(verificationEvidence) ||
    verificationEvidence.length === 0
  ) {
    fail("PROMOTION_TRUST_INVALID", "Promoted platform authenticity is incomplete.");
  }
  if (
    identities.some(
      (identity) => policy?.revokedCertificateIdentities?.includes(identity as string) === true,
    )
  ) {
    fail("RELEASE_REVOKED", "A native signing identity is revoked by release policy.");
  }
  let previous: string | undefined;
  const paths = new Set<string>();
  for (const reference of verificationEvidence) {
    const parsed = parseEvidenceReference(
      reference,
      "platform authenticity evidence",
      "PROMOTION_TRUST_INVALID",
    );
    if (
      paths.has(parsed.path) ||
      (previous !== undefined && compareCodeUnits(previous, parsed.path) >= 0)
    ) {
      fail(
        "PROMOTION_TRUST_INVALID",
        "Platform authenticity evidence is duplicated or not canonical.",
      );
    }
    paths.add(parsed.path);
    previous = parsed.path;
  }
  return value;
}

function parsePromotionNotarization(candidate: unknown): Record<string, unknown> {
  const value = requireExternalRecord(
    candidate,
    "promoted notarization",
    "PROMOTION_TRUST_INVALID",
  );
  assertExternalExactKeys(
    value,
    ["receipt", "submissionId", "status", "teamId", "resultId", "logId"],
    "promoted notarization",
    "PROMOTION_TRUST_INVALID",
  );
  parseEvidenceReference(
    value["receipt"],
    "promoted notarization receipt",
    "PROMOTION_TRUST_INVALID",
  );
  if (
    !isValidExternalId(value["submissionId"]) ||
    value["status"] !== "accepted" ||
    typeof value["teamId"] !== "string" ||
    !/^[A-Z0-9]{10}$/u.test(value["teamId"]) ||
    !isValidExternalId(value["resultId"]) ||
    !isValidExternalId(value["logId"])
  ) {
    fail("PROMOTION_TRUST_INVALID", "The promoted notarization identity is invalid.");
  }
  return value;
}

function parseDeclaredLiveEvidence(
  candidate: unknown,
): readonly { readonly criterionId: number; readonly path: string; readonly sha256: string }[] {
  if (!Array.isArray(candidate) || candidate.length !== 36) {
    fail("PROMOTION_TRUST_INVALID", "The promoted live-evidence set is incomplete.");
  }
  return candidate.map((item, index) => {
    const value = requireExternalRecord(item, "promoted live evidence", "PROMOTION_TRUST_INVALID");
    assertExternalExactKeys(
      value,
      ["criterionId", "path", "sha256"],
      "promoted live evidence",
      "PROMOTION_TRUST_INVALID",
    );
    const reference = parseEvidenceReference(
      { path: value["path"], sha256: value["sha256"] },
      "promoted live evidence",
      "PROMOTION_TRUST_INVALID",
    );
    if (value["criterionId"] !== index + 1) {
      fail("PROMOTION_TRUST_INVALID", "Promoted live evidence is not canonical.");
    }
    return { criterionId: index + 1, ...reference };
  });
}

function parseEvidenceReference(
  candidate: unknown,
  label: string,
  code: ReleaseIntegrityErrorCode,
): { readonly path: string; readonly sha256: string } {
  const value = requireExternalRecord(candidate, label, code);
  assertExternalExactKeys(value, ["path", "sha256"], label, code);
  if (
    typeof value["path"] !== "string" ||
    typeof value["sha256"] !== "string" ||
    !SHA256_PATTERN.test(value["sha256"])
  ) {
    fail(code, `The ${label} is invalid.`);
  }
  assertPortablePathWithCode(value["path"], code);
  return { path: value["path"], sha256: value["sha256"] };
}

function parseTargetRecord(
  candidate: unknown,
  label: string,
  code: ReleaseIntegrityErrorCode,
): ReleaseTarget {
  const value = requireExternalRecord(candidate, label, code);
  assertExternalExactKeys(value, ["platform", "architecture"], label, code);
  const target = {
    platform: value["platform"],
    architecture: value["architecture"],
  };
  if (!(
    (target.platform === "darwin" && target.architecture === "arm64") ||
    (target.platform === "linux" && target.architecture === "x64") ||
    (target.platform === "win32" && target.architecture === "x64")
  )) {
    fail(code, `The ${label} is outside the first-milestone matrix.`);
  }
  return target as ReleaseTarget;
}

function parseSupportedChannelReceipt(
  statement: Record<string, unknown>,
  promotion: ParsedPromotionAuthorization,
  promotionAttestationSha256: string,
): ComposedSupportedChannelReceiptStatement {
  assertExternalExactKeys(
    statement,
    [
      "schemaVersion",
      "product",
      "role",
      "domain",
      "receiptId",
      "releaseId",
      "channel",
      "tag",
      "promotionAttestationSha256",
      "publishedAssets",
      "observedAt",
    ],
    "supported-channel receipt",
    "PROMOTION_TRUST_INVALID",
  );
  const receiptId = requirePromotionString(statement["receiptId"], "receipt ID");
  const observedAt = requirePromotionString(statement["observedAt"], "receipt observation time");
  if (!Array.isArray(statement["publishedAssets"])) {
    fail("PROMOTION_TRUST_INVALID", "The supported-channel asset set is invalid.");
  }
  const publishedAssetReadBacks = statement["publishedAssets"].map((candidate) => {
    const value = requireExternalRecord(candidate, "published asset", "PROMOTION_TRUST_INVALID");
    assertExternalExactKeys(
      value,
      ["target", "path", "size", "sha256", "readBackSha256"],
      "published asset",
      "PROMOTION_TRUST_INVALID",
    );
    const target = parseTargetRecord(
      value["target"],
      "published asset target",
      "PROMOTION_TRUST_INVALID",
    );
    if (typeof value["readBackSha256"] !== "string") {
      fail("PROMOTION_TRUST_INVALID", "A published asset read-back is invalid.");
    }
    return {
      target,
      readBackSha256: value["readBackSha256"],
    };
  });
  const composed = composeSupportedChannelReceiptFromBinding(
    {
      channel: promotion.channel,
      productVersion: promotion.productVersion,
      releaseId: promotion.releaseId,
      targets: promotion.targets,
    },
    promotionAttestationSha256,
    publishedAssetReadBacks,
    receiptId,
    observedAt,
    "PROMOTION_TRUST_INVALID",
  );
  if (!Buffer.from(composed.canonicalBytes).equals(Buffer.from(canonicalJsonBytes(statement)))) {
    fail(
      "PROMOTION_TRUST_INVALID",
      "The supported-channel receipt does not bind the exact promotion and read-back.",
    );
  }
  return composed;
}

function requirePromotionString(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) {
    fail("PROMOTION_TRUST_INVALID", `The promotion ${label} is invalid.`);
  }
  return value;
}

export interface ImmutableLiveEvidenceFile extends ImmutableEvidenceFile {
  readonly criterionId: number;
}

export interface PlatformAuthenticityPromotionEvidence {
  readonly certificateIdentities: readonly string[];
  readonly productCertificateIdentity: string | null;
  readonly recordSha256: string;
  readonly target: ReleaseTarget;
  readonly verificationEvidence: readonly ImmutableEvidenceFile[];
}

export interface ComposePromotionStatementInput {
  readonly channel: string;
  readonly issuedAt: string;
  readonly liveEvidence: readonly ImmutableLiveEvidenceFile[];
  readonly notarizationReceipt: ImmutableEvidenceFile;
  readonly platformAuthenticityEvidence: readonly PlatformAuthenticityPromotionEvidence[];
  readonly releaseId: string;
  readonly statementId: string;
  readonly supportMatrix: ImmutableEvidenceFile;
  readonly verifiedCandidates: readonly VerifiedRelease[];
}

export interface PromotionEvidenceReference {
  readonly path: string;
  readonly sha256: string;
}

export interface PromotionAuthorizationTarget {
  readonly archive: VerifiedArchive;
  readonly candidate: PublisherCandidateBinding;
  readonly notarization: {
    readonly logId: string;
    readonly receipt: PromotionEvidenceReference;
    readonly resultId: string;
    readonly status: "accepted";
    readonly submissionId: string;
    readonly teamId: string;
  } | null;
  readonly platformAuthenticity: {
    readonly certificateIdentities: readonly string[];
    readonly productCertificateIdentity: string | null;
    readonly recordSha256: string;
    readonly verificationEvidence: readonly PromotionEvidenceReference[];
  };
  readonly publisher: {
    readonly attestationSha256: string;
    readonly keyId: string;
  };
  readonly target: ReleaseTarget;
}

export interface PromotionAuthorizationStatementValue {
  readonly acceptanceLedger: {
    readonly candidateAttestationId: string;
    readonly schemaVersion: 1;
    readonly sha256: string;
  };
  readonly auditedSourceCommit: string;
  readonly buildCommit: string;
  readonly channel: string;
  readonly domain: "opendelegate.release.promotion-authorization.v1";
  readonly issuedAt: string;
  readonly liveEvidence: readonly (PromotionEvidenceReference & {
    readonly criterionId: number;
  })[];
  readonly product: "OpenDelegate";
  readonly productVersion: string;
  readonly publicationPolicy: "immutable-assets-with-remote-digest-readback";
  readonly releaseId: string;
  readonly role: "promotion";
  readonly schemaVersion: 1;
  readonly statementId: string;
  readonly supportMatrix: PromotionEvidenceReference;
  readonly targets: readonly PromotionAuthorizationTarget[];
}

export interface ComposedPromotionStatement {
  readonly canonicalBytes: Uint8Array;
  readonly domain: "opendelegate.release.promotion-authorization.v1";
  readonly sha256: string;
  readonly signingBytes: Uint8Array;
  readonly statement: PromotionAuthorizationStatementValue;
  readonly statementId: string;
}

interface ReceiptPromotionBinding {
  readonly channel: string;
  readonly productVersion: string;
  readonly releaseId: string;
  readonly targets: readonly {
    readonly archive: VerifiedArchive;
    readonly target: ReleaseTarget;
  }[];
}

const composedPromotionBindings = new WeakMap<object, ReceiptPromotionBinding>();

export function composePromotionStatement(
  input: ComposePromotionStatementInput,
): ComposedPromotionStatement {
  if (
    !isValidExternalId(input.releaseId) ||
    !isValidExternalId(input.statementId) ||
    typeof input.channel !== "string" ||
    !/^[a-z][a-z0-9-]{1,31}$/u.test(input.channel) ||
    input.channel.includes("preview") ||
    input.channel === "release-candidate" ||
    !isRfc3339Instant(input.issuedAt)
  ) {
    fail("PROMOTION_INPUT_INVALID", "The promotion identity or channel is invalid.");
  }
  const candidates = canonicalizePromotionCandidates(input.verifiedCandidates);
  const first = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.candidate.productVersion !== first.candidate.productVersion ||
      candidate.candidate.buildCommit !== first.candidate.buildCommit ||
      candidate.candidate.auditedSourceCommit !== first.candidate.auditedSourceCommit ||
      candidate.candidate.acceptanceLedgerSha256 !== first.candidate.acceptanceLedgerSha256 ||
      candidate.candidate.candidateAttestationId !== first.candidate.candidateAttestationId
    ) {
      fail(
        "PROMOTION_INPUT_INVALID",
        "Promotion candidates have mixed version, source, build, or ledger identities.",
      );
    }
  }
  const platformEvidence = canonicalizePlatformEvidence(
    input.platformAuthenticityEvidence,
    candidates,
  );
  const notarization = parseNotarizationReceipt(
    input.notarizationReceipt,
    candidates[0]!.archive,
    requireAppleTeamId(
      candidates[0]!.candidate.platformProductCertificateIdentity,
      "PROMOTION_INPUT_INVALID",
    ),
  );
  const supportMatrix = evidenceReference(
    input.supportMatrix,
    "support matrix",
    "PROMOTION_INPUT_INVALID",
  );
  if (supportMatrix.path !== "docs/release/SUPPORT_MATRIX.md") {
    fail("PROMOTION_INPUT_INVALID", "The promotion support matrix path is invalid.");
  }
  const liveEvidence = canonicalizeLiveEvidence(input.liveEvidence);
  const targets = Object.freeze(
    candidates.map((release, index) => {
      const evidence = platformEvidence[index]!;
      return Object.freeze({
        target: Object.freeze({
          platform: release.candidate.target.platform,
          architecture: release.candidate.target.architecture,
        }),
        archive: Object.freeze({
          path: release.archive.path,
          size: release.archive.size,
          sha256: release.archive.sha256,
        }),
        candidate: createPublisherCandidateBinding(release.candidate),
        publisher: Object.freeze({
          keyId: release.publisherKeyId,
          attestationSha256: release.publisherAttestationSha256,
        }),
        platformAuthenticity: Object.freeze({
          recordSha256: evidence.recordSha256,
          certificateIdentities: evidence.certificateIdentities,
          productCertificateIdentity: evidence.productCertificateIdentity,
          verificationEvidence: evidence.verificationEvidence,
        }),
        notarization:
          release.candidate.target.platform === "darwin"
            ? Object.freeze({
                receipt: notarization.reference,
                submissionId: notarization.submissionId,
                status: "accepted" as const,
                teamId: notarization.teamId,
                resultId: notarization.resultId,
                logId: notarization.logId,
              })
            : null,
      });
    }),
  );
  const statement = Object.freeze({
    schemaVersion: 1,
    product: "OpenDelegate" as const,
    role: "promotion" as const,
    domain: PROMOTION_AUTHORIZATION_DOMAIN,
    releaseId: input.releaseId,
    productVersion: first.candidate.productVersion,
    channel: input.channel,
    issuedAt: input.issuedAt,
    statementId: input.statementId,
    publicationPolicy: "immutable-assets-with-remote-digest-readback" as const,
    auditedSourceCommit: first.candidate.auditedSourceCommit,
    buildCommit: first.candidate.buildCommit,
    acceptanceLedger: Object.freeze({
      schemaVersion: 1 as const,
      sha256: first.candidate.acceptanceLedgerSha256,
      candidateAttestationId: first.candidate.candidateAttestationId,
    }),
    supportMatrix,
    targets,
    liveEvidence,
  }) satisfies PromotionAuthorizationStatementValue;
  const bytes = canonicalJsonBytes(statement);
  const signingBytes = promotionAuthorizationSigningBytes(bytes);
  const composed = Object.freeze({
    get canonicalBytes(): Uint8Array {
      return Uint8Array.from(bytes);
    },
    domain: PROMOTION_AUTHORIZATION_DOMAIN,
    sha256: sha256(bytes),
    get signingBytes(): Uint8Array {
      return Uint8Array.from(signingBytes);
    },
    statement,
    statementId: input.statementId,
  });
  composedPromotionBindings.set(
    composed,
    Object.freeze({
      channel: input.channel,
      productVersion: first.candidate.productVersion,
      releaseId: input.releaseId,
      targets: Object.freeze(
        candidates.map((release) =>
          Object.freeze({
            archive: Object.freeze({
              path: release.archive.path,
              size: release.archive.size,
              sha256: release.archive.sha256,
            }),
            target: Object.freeze({
              platform: release.candidate.target.platform,
              architecture: release.candidate.target.architecture,
            }),
          }),
        ),
      ),
    }),
  );
  signableStatementBrands.set(composed, {
    role: "promotion",
    schemaVersion: 1,
    statement,
  });
  return composed;
}

export interface PublishedAssetReadBack {
  readonly readBackSha256: string;
  readonly target: ReleaseTarget;
}

export interface SupportedChannelPublishedAsset extends VerifiedArchive {
  readonly readBackSha256: string;
  readonly target: ReleaseTarget;
}

export interface SupportedChannelReceiptStatement {
  readonly schemaVersion: 1;
  readonly product: "OpenDelegate";
  readonly role: "promotion";
  readonly domain: "opendelegate.release.supported-channel-receipt.v1";
  readonly receiptId: string;
  readonly releaseId: string;
  readonly channel: string;
  readonly tag: string;
  readonly promotionAttestationSha256: string;
  readonly publishedAssets: readonly SupportedChannelPublishedAsset[];
  readonly observedAt: string;
}

export interface ComposeSupportedChannelReceiptStatementInput {
  readonly observedAt: string;
  readonly promotion: ComposedPromotionStatement;
  readonly promotionAttestationSha256: string;
  readonly publishedAssetReadBacks: readonly PublishedAssetReadBack[];
  readonly receiptId: string;
}

export interface ComposedSupportedChannelReceiptStatement {
  readonly canonicalBytes: Uint8Array;
  readonly domain: "opendelegate.release.supported-channel-receipt.v1";
  readonly receiptId: string;
  readonly sha256: string;
  readonly signingBytes: Uint8Array;
  readonly statement: SupportedChannelReceiptStatement;
}

export function composeSupportedChannelReceiptStatement(
  input: ComposeSupportedChannelReceiptStatementInput,
): ComposedSupportedChannelReceiptStatement {
  if (typeof input !== "object" || input === null) {
    fail("PROMOTION_INPUT_INVALID", "The supported-channel receipt input is invalid.");
  }
  const promotion = composedPromotionBindings.get(input.promotion);
  if (promotion === undefined) {
    fail(
      "PROMOTION_INPUT_INVALID",
      "The receipt requires a promotion composed by this verifier instance.",
    );
  }
  return composeSupportedChannelReceiptFromBinding(
    promotion,
    input.promotionAttestationSha256,
    input.publishedAssetReadBacks,
    input.receiptId,
    input.observedAt,
    "PROMOTION_INPUT_INVALID",
  );
}

function composeSupportedChannelReceiptFromBinding(
  promotion: ReceiptPromotionBinding,
  promotionAttestationSha256: string,
  readBacks: readonly PublishedAssetReadBack[],
  receiptId: string,
  observedAt: string,
  code: ReleaseIntegrityErrorCode,
): ComposedSupportedChannelReceiptStatement {
  if (
    !isValidExternalId(receiptId) ||
    !SHA256_PATTERN.test(promotionAttestationSha256) ||
    !isRfc3339Instant(observedAt) ||
    !Array.isArray(readBacks) ||
    readBacks.length !== FIRST_MILESTONE_TARGETS.length
  ) {
    fail(code, "The supported-channel receipt identity or read-back set is invalid.");
  }
  const byTarget = new Map<string, string>();
  for (const readBack of readBacks) {
    const value = requireExternalRecord(readBack, "published asset read-back", code);
    assertExternalExactKeys(value, ["target", "readBackSha256"], "published asset read-back", code);
    const target = parseTargetRecord(value["target"], "published asset read-back target", code);
    const digest = value["readBackSha256"];
    const key = targetKey(target);
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest) || byTarget.has(key)) {
      fail(code, "A published asset read-back is invalid or duplicated.");
    }
    byTarget.set(key, digest);
  }
  const publishedAssets = Object.freeze(
    promotion.targets.map(({ archive, target }) => {
      const readBackSha256 = byTarget.get(targetKey(target));
      if (readBackSha256 !== archive.sha256) {
        fail(code, "A remote read-back digest does not match the promoted archive.");
      }
      return Object.freeze({
        target: Object.freeze({
          platform: target.platform,
          architecture: target.architecture,
        }),
        path: archive.path,
        size: archive.size,
        sha256: archive.sha256,
        readBackSha256,
      });
    }),
  );
  const statement = Object.freeze({
    schemaVersion: 1 as const,
    product: "OpenDelegate" as const,
    role: "promotion" as const,
    domain: SUPPORTED_CHANNEL_RECEIPT_DOMAIN,
    receiptId,
    releaseId: promotion.releaseId,
    channel: promotion.channel,
    tag: `v${promotion.productVersion}`,
    promotionAttestationSha256,
    publishedAssets,
    observedAt,
  });
  const canonicalBytes = canonicalJsonBytes(statement);
  const signingBytes = Buffer.concat([
    Buffer.from("OpenDelegate supported channel receipt v1\n", "utf8"),
    canonicalBytes,
  ]);
  const composed = Object.freeze({
    get canonicalBytes(): Uint8Array {
      return Uint8Array.from(canonicalBytes);
    },
    domain: SUPPORTED_CHANNEL_RECEIPT_DOMAIN,
    receiptId,
    sha256: sha256(canonicalBytes),
    get signingBytes(): Uint8Array {
      return Uint8Array.from(signingBytes);
    },
    statement,
  });
  signableStatementBrands.set(composed, {
    role: "promotion",
    schemaVersion: 1,
    statement,
  });
  return composed;
}

export type SignableReleaseStatement =
  | ComposedPromotionStatement
  | ComposedPublisherAttestationStatement
  | ComposedSupportedChannelReceiptStatement;

export interface SignedReleaseEnvelopeValue {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly product: "OpenDelegate";
  readonly role: "promotion" | "publisher";
  readonly schemaVersion: 1 | 2;
  readonly signature: string;
  readonly statement:
    | PromotionAuthorizationStatementValue
    | PublisherAttestationStatementValue
    | SupportedChannelReceiptStatement;
}

export interface ComposedSignedReleaseEnvelope {
  readonly canonicalBytes: Uint8Array;
  readonly envelope: SignedReleaseEnvelopeValue;
  readonly sha256: string;
}

export function composeSignedReleaseEnvelope(input: {
  readonly composed: SignableReleaseStatement;
  readonly keyId: string;
  readonly signature: string;
}): ComposedSignedReleaseEnvelope {
  if (typeof input !== "object" || input === null) {
    fail("SIGNED_ENVELOPE_INVALID", "The signed release envelope input is invalid.");
  }
  const descriptor = signableStatementBrands.get(input.composed);
  if (
    descriptor === undefined ||
    typeof input.keyId !== "string" ||
    !QUALIFIED_SHA256_PATTERN.test(input.keyId) ||
    typeof input.signature !== "string" ||
    !BASE64_URL_SIGNATURE_PATTERN.test(input.signature)
  ) {
    fail(
      "SIGNED_ENVELOPE_INVALID",
      "The signed release envelope identity or signature is invalid.",
    );
  }
  const envelope = Object.freeze({
    schemaVersion: descriptor.schemaVersion,
    product: "OpenDelegate" as const,
    role: descriptor.role,
    algorithm: "ed25519" as const,
    keyId: input.keyId,
    statement: descriptor.statement as SignedReleaseEnvelopeValue["statement"],
    signature: input.signature,
  });
  const canonicalBytes = canonicalJsonBytes(envelope);
  return Object.freeze({
    get canonicalBytes(): Uint8Array {
      return Uint8Array.from(canonicalBytes);
    },
    envelope,
    sha256: sha256(canonicalBytes),
  });
}

interface CanonicalPlatformEvidence {
  readonly certificateIdentities: readonly string[];
  readonly productCertificateIdentity: string | null;
  readonly recordSha256: string;
  readonly verificationEvidence: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

function canonicalizePromotionCandidates(
  candidates: readonly VerifiedRelease[],
): readonly VerifiedRelease[] {
  if (!Array.isArray(candidates) || candidates.length !== FIRST_MILESTONE_TARGETS.length) {
    fail("PROMOTION_INPUT_INVALID", "Promotion requires the exact first-milestone target set.");
  }
  const byTarget = new Map<string, VerifiedRelease>();
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !verifiedReleaseObjects.has(candidate) ||
      candidate.effectiveChannel !== "release-candidate"
    ) {
      fail(
        "PROMOTION_INPUT_INVALID",
        "Promotion accepts only publisher-verified release candidates.",
      );
    }
    const key = targetKey(candidate.candidate.target);
    if (byTarget.has(key)) {
      fail("PROMOTION_INPUT_INVALID", "Promotion contains a duplicate target tuple.");
    }
    byTarget.set(key, candidate);
  }
  return Object.freeze(
    FIRST_MILESTONE_TARGETS.map((target) => {
      const candidate = byTarget.get(targetKey(target));
      if (candidate === undefined) {
        fail("PROMOTION_INPUT_INVALID", "Promotion is missing a first-milestone target tuple.");
      }
      return candidate;
    }),
  );
}

function canonicalizePlatformEvidence(
  evidence: readonly PlatformAuthenticityPromotionEvidence[],
  candidates: readonly VerifiedRelease[],
): readonly CanonicalPlatformEvidence[] {
  if (!Array.isArray(evidence) || evidence.length !== FIRST_MILESTONE_TARGETS.length) {
    fail(
      "PROMOTION_INPUT_INVALID",
      "Promotion requires platform authenticity evidence for every target.",
    );
  }
  const byTarget = new Map<string, PlatformAuthenticityPromotionEvidence>();
  for (const item of evidence) {
    assertExpectedTarget(item.target);
    const key = targetKey(item.target);
    if (byTarget.has(key)) {
      fail(
        "PROMOTION_INPUT_INVALID",
        "Platform authenticity evidence contains a duplicate target.",
      );
    }
    byTarget.set(key, item);
  }
  return Object.freeze(
    candidates.map((candidate) => {
      const item = byTarget.get(targetKey(candidate.candidate.target));
      if (
        item === undefined ||
        item.recordSha256 !== candidate.candidate.platformAuthenticitySha256 ||
        item.productCertificateIdentity !==
          candidate.candidate.platformProductCertificateIdentity ||
        !Array.isArray(item.certificateIdentities) ||
        JSON.stringify(item.certificateIdentities) !==
          JSON.stringify(candidate.candidate.platformCertificateIdentities)
      ) {
        fail(
          "PROMOTION_INPUT_INVALID",
          "Platform authenticity evidence does not bind the candidate.",
        );
      }
      if (!Array.isArray(item.verificationEvidence) || item.verificationEvidence.length === 0) {
        fail("PROMOTION_INPUT_INVALID", "Platform authenticity verification evidence is missing.");
      }
      const references = item.verificationEvidence
        .map((file) =>
          evidenceReference(file, "platform authenticity evidence", "PROMOTION_INPUT_INVALID"),
        )
        .sort((left, right) => compareCodeUnits(left.path, right.path));
      if (new Set(references.map(({ path }) => path)).size !== references.length) {
        fail("PROMOTION_INPUT_INVALID", "Platform authenticity evidence paths are duplicated.");
      }
      return Object.freeze({
        certificateIdentities: Object.freeze([...item.certificateIdentities]),
        productCertificateIdentity: item.productCertificateIdentity,
        recordSha256: item.recordSha256,
        verificationEvidence: Object.freeze(references),
      });
    }),
  );
}

interface ParsedNotarizationReceipt {
  readonly logId: string;
  readonly reference: { readonly path: string; readonly sha256: string };
  readonly resultId: string;
  readonly submissionId: string;
  readonly teamId: string;
}

function parseNotarizationReceipt(
  file: ImmutableEvidenceFile,
  macArchive: VerifiedArchive,
  expectedTeamId: string,
  errorCode: ReleaseIntegrityErrorCode = "PROMOTION_INPUT_INVALID",
): ParsedNotarizationReceipt {
  const reference = evidenceReference(file, "macOS notarization receipt", errorCode);
  const value = parseExternalCanonicalJson(file.bytes, "macOS notarization receipt", errorCode);
  assertExternalExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "type",
      "target",
      "archive",
      "status",
      "submissionId",
      "teamId",
      "resultId",
      "logId",
      "observedAt",
    ],
    "macOS notarization receipt",
    errorCode,
  );
  const target = requireExternalRecord(value["target"], "notarization target", errorCode);
  assertExternalExactKeys(target, ["platform", "architecture"], "notarization target", errorCode);
  const archive = parseArchiveRecord(value["archive"], "notarized archive", errorCode);
  const submissionId = requireExternalIdWithCode(
    value["submissionId"],
    "notarization submission ID",
    errorCode,
  );
  const teamId = value["teamId"];
  const resultId = requireExternalIdWithCode(
    value["resultId"],
    "notarization result ID",
    errorCode,
  );
  const logId = requireExternalIdWithCode(value["logId"], "notarization log ID", errorCode);
  if (
    value["schemaVersion"] !== 1 ||
    value["product"] !== "OpenDelegate" ||
    value["type"] !== "macos-notarization" ||
    target["platform"] !== "darwin" ||
    target["architecture"] !== "arm64" ||
    JSON.stringify(archive) !== JSON.stringify(macArchive) ||
    value["status"] !== "accepted" ||
    typeof teamId !== "string" ||
    !/^[A-Z0-9]{10}$/u.test(teamId) ||
    teamId !== expectedTeamId ||
    !isRfc3339Instant(value["observedAt"])
  ) {
    fail(errorCode, "The macOS notarization receipt is invalid.");
  }
  return { logId, reference, resultId, submissionId, teamId };
}

function requireAppleTeamId(
  productCertificateIdentity: unknown,
  code: ReleaseIntegrityErrorCode,
): string {
  if (
    typeof productCertificateIdentity !== "string" ||
    !/^apple-team:[A-Z0-9]{10}$/u.test(productCertificateIdentity)
  ) {
    fail(code, "The Apple signing identity is missing from the release candidate.");
  }
  return productCertificateIdentity.slice("apple-team:".length);
}

function canonicalizeLiveEvidence(
  files: readonly ImmutableLiveEvidenceFile[],
): readonly { readonly criterionId: number; readonly path: string; readonly sha256: string }[] {
  return canonicalizeLiveEvidenceWithCode(files, "PROMOTION_INPUT_INVALID");
}

function canonicalizeLiveEvidenceWithCode(
  files: readonly ImmutableLiveEvidenceFile[],
  code: ReleaseIntegrityErrorCode,
): readonly { readonly criterionId: number; readonly path: string; readonly sha256: string }[] {
  if (!Array.isArray(files) || files.length !== 36) {
    fail(code, "Promotion requires immutable live evidence for all 36 criteria.");
  }
  const byCriterion = new Map<number, ImmutableLiveEvidenceFile>();
  for (const file of files) {
    if (
      !Number.isSafeInteger(file.criterionId) ||
      file.criterionId < 1 ||
      file.criterionId > 36 ||
      byCriterion.has(file.criterionId)
    ) {
      fail(code, "Live evidence criterion identities are invalid.");
    }
    byCriterion.set(file.criterionId, file);
  }
  return Object.freeze(
    Array.from({ length: 36 }, (_, index) => {
      const criterionId = index + 1;
      const file = byCriterion.get(criterionId);
      if (file === undefined) {
        fail(code, "A live evidence criterion is missing.");
      }
      const reference = evidenceReference(file, "live evidence", code);
      return Object.freeze({ criterionId, ...reference });
    }),
  );
}

function evidenceReference(
  file: ImmutableEvidenceFile,
  label: string,
  code: ReleaseIntegrityErrorCode,
): { readonly path: string; readonly sha256: string } {
  if (
    typeof file !== "object" ||
    file === null ||
    typeof file.path !== "string" ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength === 0
  ) {
    fail(code, `The ${label} is invalid.`);
  }
  assertPortablePathWithCode(file.path, code);
  return Object.freeze({ path: file.path, sha256: sha256(file.bytes) });
}

function parseArchiveRecord(
  candidate: unknown,
  label: string,
  code: ReleaseIntegrityErrorCode,
): VerifiedArchive {
  const value = requireExternalRecord(candidate, label, code);
  assertExternalExactKeys(value, ["path", "size", "sha256"], label, code);
  if (
    typeof value["path"] !== "string" ||
    value["path"] === "" ||
    value["path"].includes("/") ||
    value["path"].includes("\\") ||
    !Number.isSafeInteger(value["size"]) ||
    (value["size"] as number) <= 0 ||
    (value["size"] as number) > MAXIMUM_ARCHIVE_BYTES ||
    typeof value["sha256"] !== "string" ||
    !SHA256_PATTERN.test(value["sha256"])
  ) {
    fail(code, `The ${label} is invalid.`);
  }
  return {
    path: value["path"],
    size: value["size"] as number,
    sha256: value["sha256"],
  };
}

function requireExternalIdWithCode(
  value: unknown,
  label: string,
  code: ReleaseIntegrityErrorCode,
): string {
  if (typeof value !== "string" || !isValidExternalId(value)) {
    fail(code, `The ${label} is invalid.`);
  }
  return value;
}

function isValidExternalId(value: unknown): value is string {
  return typeof value === "string" && ATTESTATION_ID_PATTERN.test(value);
}

function targetKey(target: ReleaseTarget): string {
  return `${target.platform}-${target.architecture}`;
}

function assertPortablePathWithCode(path: string, code: ReleaseIntegrityErrorCode): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.normalize("NFC") !== path ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(code, "A release sidecar contains an unsafe relative path.");
  }
}

function assertExpectedTarget(target: ReleaseTarget): void {
  if (!(
    (target.platform === "darwin" && target.architecture === "arm64") ||
    (target.platform === "linux" && target.architecture === "x64") ||
    (target.platform === "win32" && target.architecture === "x64")
  )) {
    fail(
      "CANDIDATE_INPUT_INVALID",
      "The expected release target is not in the first-milestone matrix.",
    );
  }
}

function fail(code: ReleaseIntegrityErrorCode, message: string): never {
  throw new ReleaseIntegrityError(code, message);
}
