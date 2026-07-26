import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  CandidateDescription,
  ImmutableLiveEvidenceFile,
  InspectCandidateInput,
  ReleaseFileMetadata,
  ReleaseFileReader,
  ReleaseIntegrityErrorCode,
  ReleaseTarget,
  ReleaseVerificationPolicy,
  VerifiedArchive,
  VerifiedRelease,
  VerifyReleaseInput,
} from "./index.ts";

const CONFIGURATION_FILE = "release-verification.json";
const MAXIMUM_CONFIGURATION_BYTES = 1024 * 1024;
const MAXIMUM_ATTESTATION_BYTES = 1024 * 1024;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const QUALIFIED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const CERTIFICATE_IDENTITY_PATTERN =
  /^(?:apple-team:[A-Z0-9]{10}|authenticode-sha1:[A-F0-9]{40})$/u;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/u;
const FIRST_MILESTONE_TARGETS = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);

export type ConfiguredReleaseDiagnosticCode =
  ReleaseIntegrityErrorCode | "RELEASE_CONFIGURATION_INVALID" | "RELEASE_CONFIGURATION_IO_INVALID";

interface ConfiguredReleaseExternalBase {
  readonly configurationSha256?: string;
  readonly diagnosticCode?: ConfiguredReleaseDiagnosticCode;
}

export type ConfiguredReleaseExternalStatus =
  | (ConfiguredReleaseExternalBase & {
      readonly status: "absent";
    })
  | (ConfiguredReleaseExternalBase & {
      readonly status: "invalid";
    })
  | (ConfiguredReleaseExternalBase & {
      readonly archive: VerifiedArchive;
      readonly publisherAttestationSha256: string;
      readonly publisherKeyId: string;
      readonly status: "publisher-verified";
    })
  | (ConfiguredReleaseExternalBase & {
      readonly archive: VerifiedArchive;
      readonly publisherAttestationSha256: string;
      readonly publisherKeyId: string;
      readonly status: "promotion-invalid";
    })
  | (ConfiguredReleaseExternalBase & {
      readonly status: "revoked";
    })
  | (ConfiguredReleaseExternalBase & {
      readonly archive: VerifiedArchive;
      readonly promotionStatementId: string;
      readonly publisherAttestationSha256: string;
      readonly publisherKeyId: string;
      readonly receiptId: string;
      readonly status: "released";
    });

export interface ConfiguredReleaseResolution {
  readonly candidate: CandidateDescription;
  readonly declaredChannel: "release-candidate";
  readonly effectiveChannel: "release-candidate" | "released";
  readonly external: ConfiguredReleaseExternalStatus;
}

export interface ResolveConfiguredReleaseInput extends InspectCandidateInput {
  readonly stateRoot: string;
}

export interface ConfiguredReleaseDependencies {
  readonly defaultReader: ReleaseFileReader;
  readonly inspectCandidate: (input: InspectCandidateInput) => Promise<CandidateDescription>;
  readonly releaseErrorCode: (error: unknown) => ReleaseIntegrityErrorCode | undefined;
  readonly verifyRelease: (input: VerifyReleaseInput) => Promise<VerifiedRelease>;
}

interface LocatedFile {
  readonly canonicalPath: string;
  readonly lexicalPath: string;
  readonly size: number;
}

interface LocatedDirectory {
  readonly canonicalPath: string;
  readonly lexicalPath: string;
}

interface ConfigurationLocation {
  readonly candidateRoot: string;
  readonly configuration: LocatedFile;
  readonly configurationDirectory: LocatedDirectory;
  readonly trustRoot: LocatedDirectory;
}

interface ParsedCandidateConfiguration {
  readonly archiveFile: string;
  readonly expectedCandidateDigest: string;
  readonly expectedManifestSha256: string;
  readonly publisherAttestationFile: string;
  readonly publisherTrustRootFile: string;
}

interface ParsedEvidenceConfiguration {
  readonly file: string;
  readonly statementPath: string;
}

interface ParsedLiveEvidenceConfiguration extends ParsedEvidenceConfiguration {
  readonly criterionId: number;
}

interface ParsedPromotionConfiguration {
  readonly liveEvidence: readonly ParsedLiveEvidenceConfiguration[];
  readonly notarizationReceiptFile: string;
  readonly promotionAttestationFile: string;
  readonly promotionTrustRootFile: string;
  readonly supportMatrix: ParsedEvidenceConfiguration;
  readonly supportedChannelReceiptFile: string;
}

interface ParsedReleaseConfiguration {
  readonly candidate: ParsedCandidateConfiguration;
  readonly policy: ReleaseVerificationPolicy;
  readonly promotion: ParsedPromotionConfiguration | null;
}

interface MaterializedPublisher {
  readonly archivePath: string;
  readonly attestationPath: string;
  readonly publicKeyPem: Uint8Array;
}

interface MaterializedPromotion {
  readonly attestationPath: string;
  readonly liveEvidence: readonly ImmutableLiveEvidenceFile[];
  readonly notarizationReceiptPath: string;
  readonly publicKeyPem: Uint8Array;
  readonly receiptPath: string;
  readonly supportMatrix: {
    readonly bytes: Uint8Array;
    readonly path: string;
  };
}

interface MaterializedConfiguration {
  readonly pinnedReader: ReleaseFileReader;
  readonly promotion: MaterializedPromotion | null;
  readonly publisher: MaterializedPublisher;
}

interface PinnedFile {
  readonly bytes: Uint8Array;
  readonly canonicalPath: string;
}

export function externalReleaseVerificationPath(input: {
  readonly checksumManifestSha256: string;
  readonly productVersion: string;
  readonly stateRoot: string;
  readonly target: ReleaseTarget;
}): string {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.stateRoot !== "string" ||
    !isAbsolute(input.stateRoot) ||
    input.stateRoot.includes("\0") ||
    typeof input.productVersion !== "string" ||
    !SEMVER_PATTERN.test(input.productVersion) ||
    typeof input.checksumManifestSha256 !== "string" ||
    !SHA256_PATTERN.test(input.checksumManifestSha256)
  ) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The configured release path identity is invalid.",
    );
  }
  const target = targetKey(input.target);
  if (!FIRST_MILESTONE_TARGETS.has(target)) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The configured release path target is unsupported.",
    );
  }
  return join(
    resolve(input.stateRoot),
    "trust",
    "releases",
    input.productVersion,
    target,
    input.checksumManifestSha256,
    CONFIGURATION_FILE,
  );
}

export async function resolveConfiguredReleaseWithDependencies(
  input: ResolveConfiguredReleaseInput,
  dependencies: ConfiguredReleaseDependencies,
): Promise<ConfiguredReleaseResolution> {
  const candidate = await dependencies.inspectCandidate(input);
  const reader = input.reader ?? dependencies.defaultReader;
  let configurationSha256: string | undefined;
  try {
    const expectedConfigurationPath = externalReleaseVerificationPath({
      stateRoot: input.stateRoot,
      productVersion: candidate.productVersion,
      target: candidate.target,
      checksumManifestSha256: candidate.checksumManifestSha256,
    });
    const location = await locateConfiguration(
      reader,
      input.stateRoot,
      input.root,
      expectedConfigurationPath,
      candidate,
    );
    if (location === undefined) {
      return candidateResolution(candidate, Object.freeze({ status: "absent" }));
    }
    const configurationBytes = await readLocatedFile(
      reader,
      location.configuration,
      MAXIMUM_CONFIGURATION_BYTES,
      location.trustRoot,
      location.candidateRoot,
    );
    configurationSha256 = sha256(configurationBytes);
    const configuration = parseReleaseConfiguration(configurationBytes, candidate);
    const materialized = await materializeConfiguration(reader, location, configuration);
    const verificationInput = configuredVerifyReleaseInput(input, configuration, materialized);
    if (configuration.promotion === null) {
      try {
        const verified = await dependencies.verifyRelease(verificationInput);
        return candidateResolution(
          verified.candidate,
          Object.freeze({
            archive: verified.archive,
            configurationSha256,
            publisherAttestationSha256: verified.publisherAttestationSha256,
            publisherKeyId: verified.publisherKeyId,
            status: "publisher-verified",
          }),
        );
      } catch (error) {
        return classifyPublisherFailure(error, candidate, configurationSha256, dependencies);
      }
    }

    try {
      const verified = await dependencies.verifyRelease(verificationInput);
      if (
        verified.effectiveChannel !== "released" ||
        verified.promotionStatementId === undefined ||
        verified.receiptId === undefined
      ) {
        return invalidResolution(candidate, "PROMOTION_TRUST_INVALID", configurationSha256);
      }
      return Object.freeze({
        candidate: verified.candidate,
        declaredChannel: "release-candidate" as const,
        effectiveChannel: "released" as const,
        external: Object.freeze({
          archive: verified.archive,
          configurationSha256,
          promotionStatementId: verified.promotionStatementId,
          publisherAttestationSha256: verified.publisherAttestationSha256,
          publisherKeyId: verified.publisherKeyId,
          receiptId: verified.receiptId,
          status: "released" as const,
        }),
      });
    } catch (error) {
      const code = dependencies.releaseErrorCode(error);
      if (isCandidateError(code)) {
        throw error;
      }
      if (code === "RELEASE_REVOKED") {
        return revokedResolution(candidate, configurationSha256);
      }
      const {
        promotionAttestation: ignoredPromotionAttestation,
        promotionReceipt: ignoredPromotionReceipt,
        promotionTrust: ignoredPromotionTrust,
        ...publisherOnlyInput
      } = verificationInput;
      void ignoredPromotionAttestation;
      void ignoredPromotionReceipt;
      void ignoredPromotionTrust;
      try {
        const publisherVerified = await dependencies.verifyRelease(publisherOnlyInput);
        return candidateResolution(
          publisherVerified.candidate,
          Object.freeze({
            archive: publisherVerified.archive,
            configurationSha256,
            diagnosticCode: code ?? "PROMOTION_TRUST_INVALID",
            publisherAttestationSha256: publisherVerified.publisherAttestationSha256,
            publisherKeyId: publisherVerified.publisherKeyId,
            status: "promotion-invalid",
          }),
        );
      } catch (publisherError) {
        return classifyPublisherFailure(
          publisherError,
          candidate,
          configurationSha256,
          dependencies,
        );
      }
    }
  } catch (error) {
    const code = dependencies.releaseErrorCode(error);
    if (isCandidateError(code)) {
      throw error;
    }
    if (code === "RELEASE_REVOKED") {
      return revokedResolution(candidate, configurationSha256);
    }
    return invalidResolution(
      candidate,
      error instanceof ConfiguredReleaseError
        ? error.code
        : (code ?? "RELEASE_CONFIGURATION_IO_INVALID"),
      configurationSha256,
    );
  }
}

function configuredVerifyReleaseInput(
  input: ResolveConfiguredReleaseInput,
  configuration: ParsedReleaseConfiguration,
  materialized: MaterializedConfiguration,
): VerifyReleaseInput {
  const base: VerifyReleaseInput = {
    root: input.root,
    expectedTarget: input.expectedTarget,
    reader: materialized.pinnedReader,
    expectedManifestSha256: configuration.candidate.expectedManifestSha256,
    expectedCandidateDigest: configuration.candidate.expectedCandidateDigest,
    candidatePublisherEvidence: {
      archivePath: materialized.publisher.archivePath,
      attestationPath: materialized.publisher.attestationPath,
    },
    publisherTrust: { publicKeyPem: materialized.publisher.publicKeyPem },
    policy: configuration.policy,
  };
  if (materialized.promotion === null) {
    return base;
  }
  return {
    ...base,
    promotionAttestation: {
      attestationPath: materialized.promotion.attestationPath,
      liveEvidence: materialized.promotion.liveEvidence,
      notarizationReceiptPath: materialized.promotion.notarizationReceiptPath,
      supportMatrix: materialized.promotion.supportMatrix,
    },
    promotionReceipt: { receiptPath: materialized.promotion.receiptPath },
    promotionTrust: { publicKeyPem: materialized.promotion.publicKeyPem },
  };
}

async function locateConfiguration(
  reader: ReleaseFileReader,
  stateRootPath: string,
  candidateRootPath: string,
  expectedConfigurationPath: string,
  candidate: CandidateDescription,
): Promise<ConfigurationLocation | undefined> {
  const stateRoot = await locateRootDirectory(reader, stateRootPath);
  if (stateRoot === undefined) {
    return undefined;
  }
  const candidateRoot = await requireCanonicalDirectory(
    reader,
    candidateRootPath,
    "candidate root",
  );
  if (pathsOverlap(stateRoot.canonicalPath, candidateRoot.canonicalPath)) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "Release trust state cannot overlap the candidate root.",
    );
  }
  const trustRoot = await locateChild(reader, stateRoot, "trust", "directory", true);
  if (trustRoot === undefined) {
    return undefined;
  }
  if (
    !isStrictDescendant(stateRoot.canonicalPath, trustRoot.canonicalPath) ||
    pathsOverlap(trustRoot.canonicalPath, candidateRoot.canonicalPath)
  ) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "Release trust storage is not isolated from the candidate.",
    );
  }
  let current: LocatedDirectory = trustRoot;
  const segments = [
    "releases",
    candidate.productVersion,
    targetKey(candidate.target),
    candidate.checksumManifestSha256,
  ];
  for (const segment of segments) {
    const child = await locateChild(reader, current, segment, "directory", true);
    if (child === undefined) {
      return undefined;
    }
    current = child;
  }
  const configuration = await locateChild(reader, current, CONFIGURATION_FILE, "file", true);
  if (configuration === undefined) {
    return undefined;
  }
  if (
    !samePath(configuration.lexicalPath, expectedConfigurationPath) ||
    !isStrictDescendant(trustRoot.canonicalPath, configuration.canonicalPath) ||
    isWithin(candidateRoot.canonicalPath, configuration.canonicalPath)
  ) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The configured release record escaped its digest-addressed location.",
    );
  }
  return Object.freeze({
    candidateRoot: candidateRoot.canonicalPath,
    configuration,
    configurationDirectory: current,
    trustRoot,
  });
}

async function locateRootDirectory(
  reader: ReleaseFileReader,
  path: string,
): Promise<LocatedDirectory | undefined> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The release state root is invalid.",
    );
  }
  let metadata: ReleaseFileMetadata | undefined;
  try {
    metadata = await reader.inspectIfPresent(path);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      "The release state root cannot be inspected.",
      { cause: error },
    );
  }
  if (metadata === undefined) {
    return undefined;
  }
  if (metadata.kind !== "directory") {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The release state root is not a regular directory.",
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = await reader.realPath(path);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      "The release state root cannot be resolved.",
      { cause: error },
    );
  }
  if (!samePath(resolve(path), canonicalPath)) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The release state root cannot be reached through a linked path.",
    );
  }
  return Object.freeze({ canonicalPath, lexicalPath: resolve(path) });
}

async function requireCanonicalDirectory(
  reader: ReleaseFileReader,
  path: string,
  label: string,
): Promise<LocatedDirectory> {
  try {
    const metadata = await reader.inspect(path);
    if (metadata.kind !== "directory") {
      throw new Error(`${label} is not a directory`);
    }
    return Object.freeze({
      canonicalPath: await reader.realPath(path),
      lexicalPath: resolve(path),
    });
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      `The ${label} cannot be resolved.`,
      { cause: error },
    );
  }
}

async function locateChild(
  reader: ReleaseFileReader,
  parent: LocatedDirectory,
  segment: string,
  expectedKind: "directory",
  allowMissing: boolean,
): Promise<LocatedDirectory | undefined>;
async function locateChild(
  reader: ReleaseFileReader,
  parent: LocatedDirectory,
  segment: string,
  expectedKind: "file",
  allowMissing: boolean,
): Promise<LocatedFile | undefined>;
async function locateChild(
  reader: ReleaseFileReader,
  parent: LocatedDirectory,
  segment: string,
  expectedKind: "directory" | "file",
  allowMissing: boolean,
): Promise<LocatedDirectory | LocatedFile | undefined> {
  assertSafeSegment(segment);
  let entries;
  try {
    entries = await reader.list(parent.lexicalPath);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      "A release trust directory cannot be enumerated.",
      { cause: error },
    );
  }
  const folded = segment.toLocaleLowerCase("en-US");
  const matches = entries.filter(
    ({ name }) => name.normalize("NFC").toLocaleLowerCase("en-US") === folded,
  );
  if (matches.length === 0) {
    if (allowMissing) {
      return undefined;
    }
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A configured release file is missing.",
    );
  }
  if (matches.length !== 1 || matches[0]!.name !== segment) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "Release trust storage contains a case-colliding path.",
    );
  }
  const entry = matches[0]!;
  if (entry.kind !== expectedKind) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A release trust path has the wrong filesystem kind.",
    );
  }
  const lexicalPath = join(parent.lexicalPath, segment);
  let metadata: ReleaseFileMetadata;
  let canonicalPath: string;
  try {
    metadata = await reader.inspect(lexicalPath);
    canonicalPath = await reader.realPath(lexicalPath);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      "A release trust path changed during inspection.",
      { cause: error },
    );
  }
  if (metadata.kind !== expectedKind || !isStrictDescendant(parent.canonicalPath, canonicalPath)) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A release trust path is linked, special, or escaped its parent.",
    );
  }
  return Object.freeze({
    canonicalPath,
    lexicalPath,
    ...(expectedKind === "file" ? { size: metadata.size } : {}),
  });
}

async function materializeConfiguration(
  reader: ReleaseFileReader,
  location: ConfigurationLocation,
  configuration: ParsedReleaseConfiguration,
): Promise<MaterializedConfiguration> {
  const usedLexicalPaths = new Set<string>();
  const usedCanonicalPaths = new Set<string>();
  const pinnedFiles = new Map<string, PinnedFile>();
  const resolveAndPin = async (path: string, maximumBytes: number): Promise<LocatedFile> => {
    const file = await locateRelativeFile(
      reader,
      location,
      path,
      usedLexicalPaths,
      usedCanonicalPaths,
    );
    const bytes = await readLocatedFile(
      reader,
      file,
      maximumBytes,
      location.configurationDirectory,
      location.candidateRoot,
    );
    pinnedFiles.set(pathKey(file.lexicalPath), {
      bytes,
      canonicalPath: file.canonicalPath,
    });
    return file;
  };

  const archive = await resolveAndPin(configuration.candidate.archiveFile, MAXIMUM_ARCHIVE_BYTES);
  const publisherAttestation = await resolveAndPin(
    configuration.candidate.publisherAttestationFile,
    MAXIMUM_ATTESTATION_BYTES,
  );
  const publisherTrust = await resolveAndPin(
    configuration.candidate.publisherTrustRootFile,
    MAXIMUM_KEY_BYTES,
  );
  const publisherTrustBytes = pinnedFiles.get(pathKey(publisherTrust.lexicalPath))!.bytes;
  const publisher: MaterializedPublisher = Object.freeze({
    archivePath: archive.lexicalPath,
    attestationPath: publisherAttestation.lexicalPath,
    publicKeyPem: Uint8Array.from(publisherTrustBytes),
  });

  let promotion: MaterializedPromotion | null = null;
  if (configuration.promotion !== null) {
    const promotionAttestation = await resolveAndPin(
      configuration.promotion.promotionAttestationFile,
      MAXIMUM_ATTESTATION_BYTES,
    );
    const receipt = await resolveAndPin(
      configuration.promotion.supportedChannelReceiptFile,
      MAXIMUM_ATTESTATION_BYTES,
    );
    const promotionTrust = await resolveAndPin(
      configuration.promotion.promotionTrustRootFile,
      MAXIMUM_KEY_BYTES,
    );
    const supportMatrix = await resolveAndPin(
      configuration.promotion.supportMatrix.file,
      MAXIMUM_EVIDENCE_BYTES,
    );
    const notarizationReceipt = await resolveAndPin(
      configuration.promotion.notarizationReceiptFile,
      MAXIMUM_ATTESTATION_BYTES,
    );
    const liveEvidence: ImmutableLiveEvidenceFile[] = [];
    for (const evidence of configuration.promotion.liveEvidence) {
      const file = await resolveAndPin(evidence.file, MAXIMUM_EVIDENCE_BYTES);
      liveEvidence.push(
        Object.freeze({
          bytes: Uint8Array.from(pinnedFiles.get(pathKey(file.lexicalPath))!.bytes),
          criterionId: evidence.criterionId,
          path: evidence.statementPath,
        }),
      );
    }
    promotion = Object.freeze({
      attestationPath: promotionAttestation.lexicalPath,
      liveEvidence: Object.freeze(liveEvidence),
      notarizationReceiptPath: notarizationReceipt.lexicalPath,
      publicKeyPem: Uint8Array.from(pinnedFiles.get(pathKey(promotionTrust.lexicalPath))!.bytes),
      receiptPath: receipt.lexicalPath,
      supportMatrix: Object.freeze({
        bytes: Uint8Array.from(pinnedFiles.get(pathKey(supportMatrix.lexicalPath))!.bytes),
        path: configuration.promotion.supportMatrix.statementPath,
      }),
    });
  }
  return Object.freeze({
    pinnedReader: createPinnedReleaseReader(reader, pinnedFiles),
    promotion,
    publisher,
  });
}

async function locateRelativeFile(
  reader: ReleaseFileReader,
  location: ConfigurationLocation,
  portablePath: string,
  usedLexicalPaths: Set<string>,
  usedCanonicalPaths: Set<string>,
): Promise<LocatedFile> {
  assertPortableRelativePath(portablePath);
  let current = location.trustRoot;
  const segments = portablePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    const child = await locateChild(reader, current, segment, "directory", false);
    if (child === undefined) {
      throw new ConfiguredReleaseError(
        "RELEASE_CONFIGURATION_INVALID",
        "A configured release directory is missing.",
      );
    }
    current = child;
  }
  const file = await locateChild(reader, current, segments[segments.length - 1]!, "file", false);
  if (file === undefined) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A configured release file is missing.",
    );
  }
  const lexicalKey = pathKey(file.lexicalPath);
  const canonicalKey = pathKey(file.canonicalPath);
  if (
    samePath(file.lexicalPath, location.configuration.lexicalPath) ||
    samePath(file.canonicalPath, location.configuration.canonicalPath) ||
    usedLexicalPaths.has(lexicalKey) ||
    usedCanonicalPaths.has(canonicalKey) ||
    !isStrictDescendant(location.configurationDirectory.lexicalPath, file.lexicalPath) ||
    !isStrictDescendant(location.configurationDirectory.canonicalPath, file.canonicalPath) ||
    isWithin(location.candidateRoot, file.canonicalPath)
  ) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "Configured release files overlap, alias, or escape their trust boundary.",
    );
  }
  usedLexicalPaths.add(lexicalKey);
  usedCanonicalPaths.add(canonicalKey);
  return file;
}

async function readLocatedFile(
  reader: ReleaseFileReader,
  file: LocatedFile,
  maximumBytes: number,
  containmentRoot: LocatedDirectory,
  candidateRoot: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximumBytes) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A configured release file exceeds its bounded size.",
    );
  }
  let bytes: Uint8Array;
  let after: ReleaseFileMetadata;
  let canonicalAfter: string;
  try {
    bytes = await reader.read(file.lexicalPath, maximumBytes);
    after = await reader.inspect(file.lexicalPath);
    canonicalAfter = await reader.realPath(file.lexicalPath);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_IO_INVALID",
      "A configured release file changed or could not be read.",
      { cause: error },
    );
  }
  if (
    after.kind !== "file" ||
    after.size !== file.size ||
    bytes.byteLength !== file.size ||
    !samePath(canonicalAfter, file.canonicalPath) ||
    !isStrictDescendant(containmentRoot.lexicalPath, file.lexicalPath) ||
    !isStrictDescendant(containmentRoot.canonicalPath, canonicalAfter) ||
    isWithin(candidateRoot, canonicalAfter)
  ) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "A configured release file changed identity or escaped containment.",
    );
  }
  return Uint8Array.from(bytes);
}

function createPinnedReleaseReader(
  delegate: ReleaseFileReader,
  pinnedFiles: ReadonlyMap<string, PinnedFile>,
): ReleaseFileReader {
  const pinned = (path: string): PinnedFile | undefined => pinnedFiles.get(pathKey(path));
  return Object.freeze({
    async inspect(path: string): Promise<ReleaseFileMetadata> {
      const file = pinned(path);
      return file === undefined
        ? delegate.inspect(path)
        : { kind: "file", size: file.bytes.byteLength };
    },
    async inspectIfPresent(path: string): Promise<ReleaseFileMetadata | undefined> {
      const file = pinned(path);
      return file === undefined
        ? delegate.inspectIfPresent(path)
        : { kind: "file", size: file.bytes.byteLength };
    },
    async list(path: string) {
      return delegate.list(path);
    },
    async read(path: string, maximumBytes: number): Promise<Uint8Array> {
      const file = pinned(path);
      if (file === undefined) {
        return delegate.read(path, maximumBytes);
      }
      if (file.bytes.byteLength > maximumBytes) {
        throw new Error("Pinned release evidence exceeds the requested bound.");
      }
      return file.bytes;
    },
    async realPath(path: string): Promise<string> {
      return pinned(path)?.canonicalPath ?? delegate.realPath(path);
    },
  });
}

function parseReleaseConfiguration(
  bytes: Uint8Array,
  candidate: CandidateDescription,
): ParsedReleaseConfiguration {
  const value = parseCanonicalJsonObject(bytes);
  assertExactKeys(value, [
    "schemaVersion",
    "product",
    "target",
    "candidate",
    "promotion",
    "policy",
  ]);
  if (value["schemaVersion"] !== 1 || value["product"] !== "OpenDelegate") {
    throw configurationInvalid();
  }
  const target = requireRecord(value["target"]);
  assertExactKeys(target, ["platform", "architecture"]);
  if (
    target["platform"] !== candidate.target.platform ||
    target["architecture"] !== candidate.target.architecture
  ) {
    throw configurationInvalid();
  }
  const candidateValue = requireRecord(value["candidate"]);
  assertExactKeys(candidateValue, [
    "expectedManifestSha256",
    "expectedCandidateDigest",
    "archiveFile",
    "publisherAttestationFile",
    "publisherTrustRootFile",
  ]);
  const candidateConfiguration = Object.freeze({
    expectedManifestSha256: requireSha256(candidateValue["expectedManifestSha256"]),
    expectedCandidateDigest: requireSha256(candidateValue["expectedCandidateDigest"]),
    archiveFile: requirePortablePath(candidateValue["archiveFile"]),
    publisherAttestationFile: requirePortablePath(candidateValue["publisherAttestationFile"]),
    publisherTrustRootFile: requirePortablePath(candidateValue["publisherTrustRootFile"]),
  });
  if (
    candidateConfiguration.expectedManifestSha256 !== candidate.checksumManifestSha256 ||
    candidateConfiguration.expectedCandidateDigest !== candidate.publisherStatement.sha256
  ) {
    throw configurationInvalid();
  }
  const promotion =
    value["promotion"] === null ? null : parsePromotionConfiguration(value["promotion"]);
  const policy = parsePolicy(value["policy"]);
  return Object.freeze({ candidate: candidateConfiguration, policy, promotion });
}

function parsePromotionConfiguration(candidate: unknown): ParsedPromotionConfiguration {
  const value = requireRecord(candidate);
  assertExactKeys(value, [
    "promotionAttestationFile",
    "supportedChannelReceiptFile",
    "promotionTrustRootFile",
    "supportMatrix",
    "notarizationReceiptFile",
    "liveEvidence",
  ]);
  const supportMatrix = parseEvidenceConfiguration(value["supportMatrix"]);
  if (supportMatrix.statementPath !== "docs/release/SUPPORT_MATRIX.md") {
    throw configurationInvalid();
  }
  if (!Array.isArray(value["liveEvidence"]) || value["liveEvidence"].length !== 36) {
    throw configurationInvalid();
  }
  const liveEvidence = value["liveEvidence"].map((entry, index) => {
    const record = requireRecord(entry);
    assertExactKeys(record, ["criterionId", "statementPath", "file"]);
    if (record["criterionId"] !== index + 1) {
      throw configurationInvalid();
    }
    return Object.freeze({
      criterionId: index + 1,
      statementPath: requirePortablePath(record["statementPath"]),
      file: requirePortablePath(record["file"]),
    });
  });
  assertUniqueStrings(liveEvidence.map(({ statementPath }) => statementPath));
  assertUniqueStrings(liveEvidence.map(({ file }) => file));
  return Object.freeze({
    promotionAttestationFile: requirePortablePath(value["promotionAttestationFile"]),
    supportedChannelReceiptFile: requirePortablePath(value["supportedChannelReceiptFile"]),
    promotionTrustRootFile: requirePortablePath(value["promotionTrustRootFile"]),
    supportMatrix,
    notarizationReceiptFile: requirePortablePath(value["notarizationReceiptFile"]),
    liveEvidence: Object.freeze(liveEvidence),
  });
}

function parseEvidenceConfiguration(candidate: unknown): ParsedEvidenceConfiguration {
  const value = requireRecord(candidate);
  assertExactKeys(value, ["statementPath", "file"]);
  return Object.freeze({
    statementPath: requirePortablePath(value["statementPath"]),
    file: requirePortablePath(value["file"]),
  });
}

function parsePolicy(candidate: unknown): ReleaseVerificationPolicy {
  const value = requireRecord(candidate);
  assertExactKeys(value, [
    "revokedCertificateIdentities",
    "revokedPromotionKeyIds",
    "revokedPublisherKeyIds",
    "revokedStatementIds",
  ]);
  return Object.freeze({
    revokedCertificateIdentities: parseSortedUniqueStrings(
      value["revokedCertificateIdentities"],
      CERTIFICATE_IDENTITY_PATTERN,
    ),
    revokedPromotionKeyIds: parseSortedUniqueStrings(
      value["revokedPromotionKeyIds"],
      QUALIFIED_SHA256_PATTERN,
    ),
    revokedPublisherKeyIds: parseSortedUniqueStrings(
      value["revokedPublisherKeyIds"],
      QUALIFIED_SHA256_PATTERN,
    ),
    revokedStatementIds: parseSortedUniqueStrings(
      value["revokedStatementIds"],
      EXTERNAL_ID_PATTERN,
    ),
  });
}

function parseSortedUniqueStrings(candidate: unknown, pattern: RegExp): readonly string[] {
  if (!Array.isArray(candidate)) {
    throw configurationInvalid();
  }
  let previous: string | undefined;
  const values: string[] = [];
  for (const value of candidate) {
    if (
      typeof value !== "string" ||
      !pattern.test(value) ||
      (previous !== undefined && compareCodeUnits(previous, value) >= 0)
    ) {
      throw configurationInvalid();
    }
    previous = value;
    values.push(value);
  }
  return Object.freeze(values);
}

function parseCanonicalJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The release verification configuration is not UTF-8.",
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfiguredReleaseError(
      "RELEASE_CONFIGURATION_INVALID",
      "The release verification configuration is not JSON.",
      { cause: error },
    );
  }
  const record = requireRecord(value);
  const canonical = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    throw configurationInvalid();
  }
  return record;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configurationInvalid();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw configurationInvalid();
  }
}

function requireSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw configurationInvalid();
  }
  return value;
}

function requirePortablePath(value: unknown): string {
  if (typeof value !== "string") {
    throw configurationInvalid();
  }
  assertPortableRelativePath(value);
  return value;
}

function assertPortableRelativePath(value: string): void {
  const segments = value.split("/");
  if (
    value === "" ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes(":") ||
    value.normalize("NFC") !== value ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        /["<>|?*]/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment) ||
        hasControlCharacters(segment),
    )
  ) {
    throw configurationInvalid();
  }
  for (const segment of segments) {
    assertSafeSegment(segment);
  }
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

function assertSafeSegment(segment: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    segment.includes(":") ||
    segment.normalize("NFC") !== segment
  ) {
    throw configurationInvalid();
  }
}

function assertUniqueStrings(values: readonly string[]): void {
  const folded = new Set<string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase("en-US");
    if (folded.has(key)) {
      throw configurationInvalid();
    }
    folded.add(key);
  }
}

function classifyPublisherFailure(
  error: unknown,
  candidate: CandidateDescription,
  configurationSha256: string,
  dependencies: ConfiguredReleaseDependencies,
): ConfiguredReleaseResolution {
  const code = dependencies.releaseErrorCode(error);
  if (isCandidateError(code)) {
    throw error;
  }
  if (code === "RELEASE_REVOKED") {
    return revokedResolution(candidate, configurationSha256);
  }
  return invalidResolution(
    candidate,
    code ?? "RELEASE_CONFIGURATION_IO_INVALID",
    configurationSha256,
  );
}

function candidateResolution(
  candidate: CandidateDescription,
  external: ConfiguredReleaseExternalStatus,
): ConfiguredReleaseResolution {
  return Object.freeze({
    candidate,
    declaredChannel: "release-candidate" as const,
    effectiveChannel: "release-candidate" as const,
    external,
  });
}

function invalidResolution(
  candidate: CandidateDescription,
  diagnosticCode: ConfiguredReleaseDiagnosticCode,
  configurationSha256?: string,
): ConfiguredReleaseResolution {
  return candidateResolution(
    candidate,
    Object.freeze({
      ...(configurationSha256 === undefined ? {} : { configurationSha256 }),
      diagnosticCode,
      status: "invalid" as const,
    }),
  );
}

function revokedResolution(
  candidate: CandidateDescription,
  configurationSha256?: string,
): ConfiguredReleaseResolution {
  return candidateResolution(
    candidate,
    Object.freeze({
      ...(configurationSha256 === undefined ? {} : { configurationSha256 }),
      diagnosticCode: "RELEASE_REVOKED" as const,
      status: "revoked" as const,
    }),
  );
}

function configurationInvalid(): ConfiguredReleaseError {
  return new ConfiguredReleaseError(
    "RELEASE_CONFIGURATION_INVALID",
    "The release verification configuration is invalid.",
  );
}

function isCandidateError(
  code: ReleaseIntegrityErrorCode | undefined,
): code is
  | "CANDIDATE_INPUT_INVALID"
  | "CANDIDATE_IO_INVALID"
  | "CANDIDATE_SCHEMA_INVALID"
  | "CANDIDATE_INTEGRITY_INVALID" {
  return code?.startsWith("CANDIDATE_") === true;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetKey(target: ReleaseTarget): string {
  if (typeof target !== "object" || target === null) {
    return "";
  }
  return `${target.platform}-${target.architecture}`;
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    samePath(left, right) || isStrictDescendant(left, right) || isStrictDescendant(right, left)
  );
}

function isWithin(parent: string, candidate: string): boolean {
  return samePath(parent, candidate) || isStrictDescendant(parent, candidate);
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relationship = relative(resolve(parent), resolve(candidate));
  return (
    relationship !== "" &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`) &&
    !isAbsolute(relationship)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class ConfiguredReleaseError extends Error {
  readonly code: Extract<
    ConfiguredReleaseDiagnosticCode,
    "RELEASE_CONFIGURATION_INVALID" | "RELEASE_CONFIGURATION_IO_INVALID"
  >;

  constructor(code: ConfiguredReleaseError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfiguredReleaseError";
    this.code = code;
  }
}
