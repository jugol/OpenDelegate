import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { readStableRegularFile } from "./stable-file.ts";

const DEVELOPMENT_VERSION = "0.0.0-development";
const DEVELOPMENT_BUILD_ID = "development-local";
const ACCEPTANCE_LEDGER_PATH = "docs/release/acceptance-evidence.json";
const ATTESTATION_EVIDENCE_PREFIX = "docs/release/evidence/";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RFC3339_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const ATTESTATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/;
const IMPLEMENTATION_STATUSES = ["missing", "partial", "verified"] as const;
const LIVE_PROOF_STATUSES = ["not-run", "blocked-external", "verified"] as const;
const METADATA_KEYS = [
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
] as const;

export type RuntimeReleaseChannel = "development" | "internal-preview" | "release-candidate";

export interface RuntimeIdentity {
  readonly build: {
    readonly version: string;
    readonly buildId: string;
  };
  readonly releaseChannel: RuntimeReleaseChannel;
}

export class ReleaseIdentityError extends Error {
  readonly code = "RELEASE_IDENTITY_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReleaseIdentityError";
  }
}

interface PayloadEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface LedgerSummary {
  readonly releaseStatus: "blocked" | "candidate";
  readonly auditedAt: string;
  readonly sourceCommit: string;
  readonly implementation: Readonly<Record<string, number>>;
  readonly liveProof: Readonly<Record<string, number>>;
  readonly complete: boolean;
  readonly proofReferences: readonly PayloadReference[];
}

interface PayloadReference {
  readonly path: string;
  readonly sha256: string;
}

export async function resolveRuntimeIdentity(input: {
  readonly installationRoot: string;
  readonly bundled: boolean;
}): Promise<RuntimeIdentity> {
  if (!input.bundled) {
    return {
      build: {
        version: DEVELOPMENT_VERSION,
        buildId: DEVELOPMENT_BUILD_ID,
      },
      releaseChannel: "development",
    };
  }

  try {
    return await resolveBundledIdentity(input.installationRoot);
  } catch (error) {
    if (error instanceof ReleaseIdentityError) {
      throw error;
    }
    throw new ReleaseIdentityError("The bundled release identity could not be verified.", {
      cause: error,
    });
  }
}

async function resolveBundledIdentity(installationRoot: string): Promise<RuntimeIdentity> {
  const [checksumBytes, manifestBytes, metadataBytes, ledgerBytes] = await Promise.all([
    readRegularPayloadFile(installationRoot, "SHA256SUMS"),
    readRegularPayloadFile(installationRoot, "payload-manifest.json"),
    readRegularPayloadFile(installationRoot, "release-metadata.json"),
    readRegularPayloadFile(installationRoot, ACCEPTANCE_LEDGER_PATH),
  ]);
  const checksums = parseChecksumManifest(checksumBytes.toString("utf8"));
  const payload = parsePayloadManifest(manifestBytes);

  verifyManifestChain(checksums, payload, manifestBytes);
  verifyPayloadEntry(payload, checksums, "release-metadata.json", metadataBytes);
  verifyPayloadEntry(payload, checksums, ACCEPTANCE_LEDGER_PATH, ledgerBytes);
  await verifyCompletePayload(installationRoot, payload, checksums);

  const ledger = parseJsonRecord(ledgerBytes, "acceptance evidence");
  const ledgerSummary = validateLedger(ledger);
  const metadata = parseJsonRecord(metadataBytes, "release metadata");
  const identity = validateMetadata(metadata, ledgerSummary);

  const metadataEvidence = requireRecord(metadata["releaseEvidence"], "releaseEvidence");
  if (metadataEvidence["sha256"] !== sha256(ledgerBytes)) {
    invalid("releaseEvidence.sha256 does not match the bundled acceptance ledger.");
  }
  for (const reference of ledgerSummary.proofReferences) {
    if (payload.get(reference.path)?.sha256 !== reference.sha256) {
      invalid(`Acceptance proof SHA-256 does not match ${reference.path}.`);
    }
  }

  return identity;
}

function parseChecksumManifest(text: string): ReadonlyMap<string, string> {
  if (!text.endsWith("\n")) {
    invalid("SHA256SUMS must end with a newline.");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line === "")) {
    invalid("SHA256SUMS must contain a non-empty canonical entry list.");
  }
  const entries = new Map<string, string>();
  let previousPath: string | undefined;
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) {
      invalid("SHA256SUMS contains an invalid entry.");
    }
    const path = match[2]!;
    assertPortableRelativePath(path, "SHA256SUMS");
    if (path === "SHA256SUMS" || entries.has(path)) {
      invalid(`SHA256SUMS contains a duplicate or self-referential entry: ${path}.`);
    }
    if (previousPath !== undefined && compareCodeUnits(previousPath, path) >= 0) {
      invalid("SHA256SUMS entries must use canonical code-unit order.");
    }
    entries.set(path, match[1]!);
    previousPath = path;
  }
  return entries;
}

function parsePayloadManifest(bytes: Buffer): ReadonlyMap<string, PayloadEntry> {
  const manifest = parseJsonRecord(bytes, "payload manifest");
  assertExactKeys(
    manifest,
    ["schemaVersion", "excludedSelfReferences", "fileCount", "totalBytes", "files"],
    "Payload manifest",
  );
  if (manifest["schemaVersion"] !== 1) {
    invalid("Payload manifest schemaVersion must be 1.");
  }
  if (
    !Array.isArray(manifest["excludedSelfReferences"]) ||
    manifest["excludedSelfReferences"].length !== 2 ||
    manifest["excludedSelfReferences"][0] !== "SHA256SUMS" ||
    manifest["excludedSelfReferences"][1] !== "payload-manifest.json"
  ) {
    invalid("Payload manifest self-reference exclusions are not canonical.");
  }
  if (!Array.isArray(manifest["files"])) {
    invalid("Payload manifest files must be an array.");
  }

  const entries = new Map<string, PayloadEntry>();
  const caseFoldedPaths = new Map<string, string>();
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const value of manifest["files"]) {
    const entry = requireRecord(value, "payload file entry");
    assertExactKeys(entry, ["path", "size", "sha256"], "Payload file entry");
    const path = requireString(entry["path"], "Payload file path");
    const size = entry["size"];
    const digest = entry["sha256"];
    assertPortableRelativePath(path, "Payload manifest");
    if (
      path === "SHA256SUMS" ||
      path === "payload-manifest.json" ||
      entries.has(path) ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      typeof digest !== "string" ||
      !SHA256_PATTERN.test(digest)
    ) {
      invalid(`Payload manifest contains an invalid entry for ${path}.`);
    }
    if (previousPath !== undefined && compareCodeUnits(previousPath, path) >= 0) {
      invalid("Payload manifest entries must use canonical code-unit order.");
    }
    assertNoCaseCollision(caseFoldedPaths, path, "Payload manifest");
    entries.set(path, { path, size: size as number, sha256: digest });
    totalBytes += size as number;
    if (!Number.isSafeInteger(totalBytes)) {
      invalid("Payload manifest totalBytes exceeds the supported range.");
    }
    previousPath = path;
  }
  if (manifest["fileCount"] !== entries.size || manifest["totalBytes"] !== totalBytes) {
    invalid("Payload manifest aggregate counts do not match its file entries.");
  }
  return entries;
}

function verifyManifestChain(
  checksums: ReadonlyMap<string, string>,
  payload: ReadonlyMap<string, PayloadEntry>,
  manifestBytes: Buffer,
): void {
  if (checksums.get("payload-manifest.json") !== sha256(manifestBytes)) {
    invalid("SHA256SUMS does not bind the bundled payload manifest.");
  }
  if (checksums.size !== payload.size + 1) {
    invalid("SHA256SUMS and the payload manifest cover different file sets.");
  }
  for (const entry of payload.values()) {
    if (checksums.get(entry.path) !== entry.sha256) {
      invalid(`SHA256SUMS and the payload manifest disagree for ${entry.path}.`);
    }
  }
}

async function verifyCompletePayload(
  installationRoot: string,
  payload: ReadonlyMap<string, PayloadEntry>,
  checksums: ReadonlyMap<string, string>,
): Promise<void> {
  const rootMetadata = await lstat(installationRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    invalid("The bundle installation root must be a regular directory.");
  }
  const discovered = await listPayloadFiles(installationRoot);
  const expected = new Set([...payload.keys(), "SHA256SUMS", "payload-manifest.json"]);
  const discoveredSet = new Set(discovered);
  const missing = [...expected].find((path) => !discoveredSet.has(path));
  if (missing !== undefined) {
    invalid(`The bundle is missing payload path ${missing}.`);
  }
  const extra = discovered.find((path) => !expected.has(path));
  if (extra !== undefined || discovered.length !== expected.size) {
    invalid(`The bundle contains an unlisted payload path: ${extra ?? "duplicate path"}.`);
  }

  const verifiablePaths = discovered.filter((path) => path !== "SHA256SUMS");
  let cursor = 0;
  const workerCount = Math.min(16, verifiablePaths.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const path = verifiablePaths[index];
        if (path === undefined) {
          return;
        }
        const bytes = await readRegularPayloadFile(installationRoot, path);
        if (path === "payload-manifest.json") {
          if (checksums.get(path) !== sha256(bytes)) {
            invalid("SHA256SUMS does not bind the installed payload manifest.");
          }
        } else {
          verifyPayloadEntry(payload, checksums, path, bytes);
        }
      }
    }),
  );
}

async function listPayloadFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const caseFoldedPaths = new Map<string, string>();

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      assertPortableRelativePath(path, "Bundle");
      assertNoCaseCollision(caseFoldedPaths, path, "Bundle");
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        invalid(`The bundle contains a symbolic link or junction: ${path}.`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, path);
      } else if (metadata.isFile()) {
        files.push(path);
      } else {
        invalid(`The bundle contains a special payload entry: ${path}.`);
      }
    }
  };

  await visit(root, "");
  return files.sort(compareCodeUnits);
}

function verifyPayloadEntry(
  payload: ReadonlyMap<string, PayloadEntry>,
  checksums: ReadonlyMap<string, string>,
  path: string,
  bytes: Buffer,
): void {
  const entry = payload.get(path);
  const digest = sha256(bytes);
  if (
    entry === undefined ||
    entry.size !== bytes.length ||
    entry.sha256 !== digest ||
    checksums.get(path) !== digest
  ) {
    invalid(`The bundled integrity manifests do not bind ${path}.`);
  }
}

function validateLedger(ledger: Record<string, unknown>): LedgerSummary {
  assertAllowedKeys(
    ledger,
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
    "Acceptance evidence",
  );
  if (
    ledger["schemaVersion"] !== 1 ||
    ledger["product"] !== "OpenDelegate" ||
    ledger["milestone"] !== "first"
  ) {
    invalid("Acceptance evidence identity fields are invalid.");
  }
  const auditedAt = requireRfc3339(ledger["auditedAt"], "Acceptance evidence auditedAt");
  const sourceCommit = requireCommit(ledger["sourceCommit"], "Acceptance evidence sourceCommit");
  if (ledger["releaseStatus"] === "released") {
    invalid("Released identity requires a separately verified promotion attestation.");
  }
  if (ledger["releaseStatus"] !== "blocked" && ledger["releaseStatus"] !== "candidate") {
    invalid("Acceptance evidence releaseStatus is invalid.");
  }
  if (!Array.isArray(ledger["criteria"]) || ledger["criteria"].length !== 36) {
    invalid("Acceptance evidence must contain exactly 36 criteria.");
  }

  const implementation: Record<string, number> = {};
  const liveProof: Record<string, number> = {};
  const criterionIds = new Set<number>();
  const proofReferences: PayloadReference[] = [];
  for (const value of ledger["criteria"]) {
    const criterion = requireRecord(value, "release criterion");
    assertAllowedKeys(
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
      "Release criterion",
    );
    const id = criterion["id"];
    if (!Number.isSafeInteger(id) || (id as number) < 1 || (id as number) > 36) {
      invalid("Acceptance evidence contains an invalid criterion ID.");
    }
    if (criterionIds.has(id as number)) {
      invalid(`Acceptance evidence repeats criterion ${String(id)}.`);
    }
    criterionIds.add(id as number);
    if (
      typeof criterion["title"] !== "string" ||
      criterion["title"].trim() === "" ||
      typeof criterion["nextGate"] !== "string" ||
      criterion["nextGate"].trim() === "" ||
      !Array.isArray(criterion["evidence"]) ||
      criterion["evidence"].some((path) => typeof path !== "string" || path.trim() === "") ||
      new Set(criterion["evidence"]).size !== criterion["evidence"].length
    ) {
      invalid(`Acceptance evidence criterion ${String(id)} has invalid descriptive fields.`);
    }
    const implementationStatus = requireEnum(
      criterion["implementationStatus"],
      IMPLEMENTATION_STATUSES,
      `Criterion ${String(id)} implementationStatus`,
    );
    const liveProofStatus = requireEnum(
      criterion["liveProofStatus"],
      LIVE_PROOF_STATUSES,
      `Criterion ${String(id)} liveProofStatus`,
    );
    implementation[implementationStatus] = (implementation[implementationStatus] ?? 0) + 1;
    liveProof[liveProofStatus] = (liveProof[liveProofStatus] ?? 0) + 1;

    const verification =
      criterion["verification"] === undefined
        ? undefined
        : requireRecord(criterion["verification"], `Criterion ${String(id)} verification`);
    if (verification !== undefined) {
      assertAllowedKeys(
        verification,
        ["implementation", "liveProof"],
        `Criterion ${String(id)} verification`,
      );
    }
    validateExpectedProof(
      verification?.["implementation"],
      implementationStatus === "verified",
      sourceCommit,
      `Criterion ${String(id)} implementation proof`,
      proofReferences,
    );
    validateExpectedProof(
      verification?.["liveProof"],
      liveProofStatus === "verified",
      sourceCommit,
      `Criterion ${String(id)} live-proof`,
      proofReferences,
    );
  }

  const complete = implementation["verified"] === 36 && liveProof["verified"] === 36;
  if (complete !== (ledger["releaseStatus"] === "candidate")) {
    invalid("Acceptance evidence completeness and releaseStatus disagree.");
  }
  validateExpectedProof(
    ledger["candidateAttestation"],
    complete,
    sourceCommit,
    "Candidate attestation",
    proofReferences,
  );
  const uniqueProofReferences = new Map<string, string>();
  for (const reference of proofReferences) {
    const existing = uniqueProofReferences.get(reference.path);
    if (existing !== undefined && existing !== reference.sha256) {
      invalid(`Acceptance proofs disagree on the SHA-256 for ${reference.path}.`);
    }
    uniqueProofReferences.set(reference.path, reference.sha256);
  }

  return {
    releaseStatus: ledger["releaseStatus"],
    auditedAt,
    sourceCommit,
    implementation,
    liveProof,
    complete,
    proofReferences: [...uniqueProofReferences]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([path, digest]) => ({ path, sha256: digest })),
  };
}

function validateExpectedProof(
  value: unknown,
  expected: boolean,
  sourceCommit: string,
  label: string,
  references: PayloadReference[],
): void {
  if (!expected) {
    if (value !== undefined) {
      invalid(`${label} must be absent until it is verified.`);
    }
    return;
  }
  const proof = requireRecord(value, label);
  assertExactKeys(proof, ["sourceCommit", "attestationId", "evidence"], label);
  if (
    proof["sourceCommit"] !== sourceCommit ||
    typeof proof["attestationId"] !== "string" ||
    !ATTESTATION_PATTERN.test(proof["attestationId"]) ||
    !Array.isArray(proof["evidence"]) ||
    proof["evidence"].length === 0
  ) {
    invalid(`${label} is invalid or does not bind the audited source commit.`);
  }
  const paths = new Set<string>();
  for (const value of proof["evidence"]) {
    const reference = requireRecord(value, `${label} evidence reference`);
    assertExactKeys(reference, ["path", "sha256"], `${label} evidence reference`);
    const path = requireString(reference["path"], `${label} evidence path`);
    const digest = reference["sha256"];
    assertPortableRelativePath(path, label);
    if (paths.has(path) || typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
      invalid(`${label} contains an invalid evidence reference.`);
    }
    paths.add(path);
    references.push({ path, sha256: digest });
  }
}

function validateMetadata(
  metadata: Record<string, unknown>,
  ledger: LedgerSummary,
): RuntimeIdentity {
  assertExactKeys(metadata, METADATA_KEYS, "Release metadata");
  if (
    metadata["schemaVersion"] !== 2 ||
    metadata["product"] !== "OpenDelegate" ||
    metadata["protocolVersion"] !== "v1" ||
    metadata["fileManifest"] !== "payload-manifest.json" ||
    metadata["checksumManifest"] !== "SHA256SUMS"
  ) {
    invalid("Release metadata identity or manifest fields are invalid.");
  }
  const productVersion = requireString(metadata["productVersion"], "productVersion");
  if (!SEMVER_PATTERN.test(productVersion)) {
    invalid("Release metadata productVersion is not semantic.");
  }
  const buildCommit = requireCommit(metadata["buildCommit"], "buildCommit");
  const auditedSourceCommit = requireCommit(metadata["auditedSourceCommit"], "auditedSourceCommit");
  if (auditedSourceCommit !== ledger.sourceCommit) {
    invalid("Release metadata auditedSourceCommit does not match acceptance evidence.");
  }
  requireRfc3339(metadata["createdAt"], "createdAt");
  if (
    metadata["timestampPolicy"] !== "wall-clock" &&
    metadata["timestampPolicy"] !== "source-date-epoch" &&
    metadata["timestampPolicy"] !== "source-commit"
  ) {
    invalid("Release metadata timestampPolicy is invalid.");
  }
  if (metadata["platform"] !== process.platform || metadata["architecture"] !== process.arch) {
    invalid("The bundle platform or architecture does not match this runtime.");
  }
  if (metadata["bundledNodeVersion"] !== process.versions.node) {
    invalid("The bundled Node.js version does not match release metadata.");
  }
  validateBundledRuntime(metadata["bundledRuntime"]);
  validateToolchain(metadata["toolchain"]);
  requireSha256(metadata["dependencyLockSha256"], "dependencyLockSha256");
  requireSha256(metadata["sourcePackageManifestSha256"], "sourcePackageManifestSha256");
  validateRuntimeExternals(metadata["runtimeExternals"]);
  if (typeof metadata["buildSourceDirty"] !== "boolean") {
    invalid("Release metadata buildSourceDirty must be boolean.");
  }

  const supportStatus = metadata["supportStatus"];
  if (supportStatus === "released" || metadata["buildMode"] === "released") {
    invalid("Released identity requires a separately verified promotion attestation.");
  }
  if (
    supportStatus !== "internal-preview-blocked" &&
    supportStatus !== "internal-preview-complete" &&
    supportStatus !== "release-candidate"
  ) {
    invalid("Release metadata supportStatus is invalid.");
  }
  const buildId = requireString(metadata["buildId"], "buildId");
  const expectedBuildId = `${supportStatus}-${buildCommit.slice(0, 12)}${
    metadata["buildSourceDirty"] ? "-dirty" : ""
  }-${process.platform}-${process.arch}`;
  if (buildId !== expectedBuildId) {
    invalid("Release metadata buildId is not canonical.");
  }

  const releaseEvidence = requireRecord(metadata["releaseEvidence"], "releaseEvidence");
  assertExactKeys(
    releaseEvidence,
    ["auditedAt", "releaseStatus", "sha256", "implementation", "liveProof", "complete"],
    "releaseEvidence",
  );
  requireSha256(releaseEvidence["sha256"], "releaseEvidence.sha256");
  if (
    releaseEvidence["auditedAt"] !== ledger.auditedAt ||
    releaseEvidence["releaseStatus"] !== ledger.releaseStatus ||
    releaseEvidence["complete"] !== ledger.complete ||
    !countsEqual(
      releaseEvidence["implementation"],
      ledger.implementation,
      IMPLEMENTATION_STATUSES,
    ) ||
    !countsEqual(releaseEvidence["liveProof"], ledger.liveProof, LIVE_PROOF_STATUSES)
  ) {
    invalid("Release metadata summary does not match the bundled acceptance evidence.");
  }

  const changedPaths = metadata["changedAttestationPaths"];
  let releaseChannel: RuntimeReleaseChannel;
  if (supportStatus === "release-candidate") {
    if (
      metadata["buildMode"] !== "release-candidate" ||
      !ledger.complete ||
      ledger.releaseStatus !== "candidate" ||
      metadata["buildSourceDirty"] ||
      buildCommit === auditedSourceCommit ||
      !Array.isArray(changedPaths) ||
      changedPaths.length === 0
    ) {
      invalid("Release-candidate metadata is incomplete or inconsistent.");
    }
    validateChangedPaths(changedPaths, ledger.proofReferences);
    releaseChannel = "release-candidate";
  } else {
    const expectedComplete = supportStatus === "internal-preview-complete";
    if (
      metadata["buildMode"] !== "internal-preview" ||
      ledger.complete !== expectedComplete ||
      changedPaths !== null
    ) {
      invalid("Internal-preview metadata is incomplete or inconsistent.");
    }
    releaseChannel = "internal-preview";
  }

  const expectedEntrypoints =
    process.platform === "win32" ? ["opendelegate.cmd"] : ["opendelegate", "opendelegate.cmd"];
  if (
    !Array.isArray(metadata["entrypoints"]) ||
    metadata["entrypoints"].length !== expectedEntrypoints.length ||
    metadata["entrypoints"].some((value, index) => value !== expectedEntrypoints[index])
  ) {
    invalid("Release metadata entrypoints do not match this platform.");
  }

  return {
    build: {
      version: productVersion,
      buildId,
    },
    releaseChannel,
  };
}

function validateBundledRuntime(value: unknown): void {
  const runtime = requireRecord(value, "bundledRuntime");
  assertExactKeys(
    runtime,
    [
      "source",
      "archive",
      "archiveUrl",
      "archiveSha256",
      "shasumsUrl",
      "executableSha256",
      "licenseSha256",
    ],
    "bundledRuntime",
  );
  if (
    runtime["source"] !== "official-nodejs-distribution" ||
    !["archive", "archiveUrl", "shasumsUrl"].every(
      (key) => typeof runtime[key] === "string" && runtime[key].trim() !== "",
    )
  ) {
    invalid("Release metadata bundledRuntime is invalid.");
  }
  for (const key of ["archiveSha256", "executableSha256", "licenseSha256"]) {
    requireSha256(runtime[key], `bundledRuntime.${key}`);
  }
}

function validateToolchain(value: unknown): void {
  const toolchain = requireRecord(value, "toolchain");
  assertExactKeys(toolchain, ["packageManager", "bundler"], "toolchain");
  if (
    typeof toolchain["packageManager"] !== "string" ||
    toolchain["packageManager"].trim() === "" ||
    typeof toolchain["bundler"] !== "string" ||
    toolchain["bundler"].trim() === ""
  ) {
    invalid("Release metadata toolchain is invalid.");
  }
}

function validateRuntimeExternals(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    invalid("Release metadata runtimeExternals must be non-empty.");
  }
  const names = new Set<string>();
  for (const item of value) {
    const external = requireRecord(item, "runtime external");
    assertExactKeys(external, ["name", "version"], "Runtime external");
    const name = requireString(external["name"], "Runtime external name");
    const version = requireString(external["version"], "Runtime external version");
    if (names.has(name) || version.trim() === "") {
      invalid("Release metadata runtimeExternals contains a duplicate or invalid entry.");
    }
    names.add(name);
  }
}

function validateChangedPaths(
  values: unknown[],
  proofReferences: readonly PayloadReference[],
): void {
  const seen = new Set<string>();
  const shaBoundPaths = new Set(proofReferences.map((reference) => reference.path));
  let previous: string | undefined;
  for (const value of values) {
    const path = requireString(value, "changed attestation path");
    assertPortableRelativePath(path, "changedAttestationPaths");
    if (seen.has(path) || (previous !== undefined && compareCodeUnits(previous, path) >= 0)) {
      invalid("changedAttestationPaths must be unique and canonically ordered.");
    }
    if (
      path !== ACCEPTANCE_LEDGER_PATH &&
      (!path.startsWith(ATTESTATION_EVIDENCE_PREFIX) || !shaBoundPaths.has(path))
    ) {
      invalid(`Changed attestation path must be canonical SHA-bound release evidence: ${path}.`);
    }
    seen.add(path);
    previous = path;
  }
  if (!seen.has(ACCEPTANCE_LEDGER_PATH)) {
    invalid("changedAttestationPaths must include the acceptance ledger.");
  }
}

function countsEqual(
  value: unknown,
  expected: Readonly<Record<string, number>>,
  allowedStatuses: readonly string[],
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        !allowedStatuses.includes(key) ||
        !Number.isSafeInteger(value[key]) ||
        (value[key] as number) <= 0,
    )
  ) {
    return false;
  }
  const expectedKeys = Object.keys(expected);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => value[key] === expected[key])
  );
}

async function readRegularPayloadFile(root: string, relativePath: string): Promise<Buffer> {
  assertPortableRelativePath(relativePath, "Bundle");
  const path = join(root, ...relativePath.split("/"));
  return await readStableRegularFile(path);
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ReleaseIdentityError(`The bundled ${label} is not valid JSON.`, { cause: error });
  }
  return requireRecord(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`${label} must be an object.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    invalid(`${label} must be a full lowercase Git commit.`);
  }
  return value;
}

function requireRfc3339(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !RFC3339_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalid(`${label} must be an RFC3339 instant.`);
  }
  return value;
}

function requireEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    invalid(`${label} is invalid.`);
  }
  return value as Value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    invalid(`${label} fields do not match its schema.`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) {
    invalid(`${label} contains unsupported field ${unsupported}.`);
  }
}

function assertPortableRelativePath(path: string, label: string): void {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    invalid(`${label} contains an unsafe relative path.`);
  }
}

function assertNoCaseCollision(paths: Map<string, string>, path: string, label: string): void {
  const folded = path.normalize("NFC").toLowerCase();
  const existing = paths.get(folded);
  if (existing !== undefined && existing !== path) {
    invalid(`${label} contains case-colliding paths: ${existing} and ${path}.`);
  }
  paths.set(folded, path);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ReleaseIdentityError(message);
}
