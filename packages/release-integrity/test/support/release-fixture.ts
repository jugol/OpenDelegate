import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as createSignature,
  type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  composePromotionStatement,
  composePublisherAttestationStatement,
  composeSignedReleaseEnvelope,
  composeSupportedChannelReceiptStatement,
  externalReleaseVerificationPath,
  inspectCandidate,
  verifyRelease,
  type CandidateDescription,
  type VerifiedRelease,
} from "../../src/index.ts";

export interface CandidateFixture {
  readonly acceptanceLedgerSha256: string;
  readonly checksumManifestSha256: string;
  readonly nativeComponentsSha256: string;
  readonly payloadManifestSha256: string;
  readonly platformAuthenticitySha256: string;
  readonly releaseMetadataSha256: string;
  readonly root: string;
}

export interface VerifiedReleaseSet {
  readonly cleanup: () => Promise<void>;
  readonly fixtures: readonly CandidateFixture[];
  readonly publishers: readonly PublisherFixture[];
  readonly releases: readonly VerifiedRelease[];
}

export function promotionCompositionInput(releaseSet: VerifiedReleaseSet) {
  const mac = releaseSet.releases.find(
    (release) => release.candidate.target.platform === "darwin",
  )!;
  const notarizationReceipt = {
    path: "docs/release/evidence/macos-notarization.json",
    bytes: canonicalJson({
      schemaVersion: 1,
      product: "OpenDelegate",
      type: "macos-notarization",
      target: { platform: "darwin", architecture: "arm64" },
      archive: mac.archive,
      status: "accepted",
      submissionId: "0f7b7a50-584d-43fc-b746-0a1419b64630",
      teamId: "OPENDELEG1",
      resultId: "apple-notary-result-0001",
      logId: "apple-notary-log-0001",
      observedAt: "2026-07-26T01:00:00.000Z",
    }),
  };
  const supportMatrix = {
    path: "docs/release/SUPPORT_MATRIX.md",
    bytes: Buffer.from("# Immutable support matrix\n", "utf8"),
  };
  const liveEvidence = Array.from({ length: 36 }, (_, index) => ({
    criterionId: index + 1,
    path: `docs/release/evidence/live-${String(index + 1).padStart(2, "0")}.json`,
    bytes: Buffer.from(`{"criterion":${String(index + 1)},"status":"verified"}\n`, "utf8"),
  }));
  const platformAuthenticityEvidence = releaseSet.releases.map((release) => {
    const platform = release.candidate.target.platform;
    return {
      target: release.candidate.target,
      recordSha256: release.candidate.platformAuthenticitySha256,
      certificateIdentities: release.candidate.platformCertificateIdentities,
      productCertificateIdentity: release.candidate.platformProductCertificateIdentity,
      verificationEvidence: [
        {
          path: `docs/release/evidence/${platform}-native-authenticity.json`,
          bytes: Buffer.from(`{"platform":"${platform}","verified":true}\n`, "utf8"),
        },
      ],
    };
  });
  return {
    verifiedCandidates: releaseSet.releases,
    platformAuthenticityEvidence,
    notarizationReceipt,
    supportMatrix,
    liveEvidence,
    releaseId: "opendelegate-v0.1.0-alpha.1",
    channel: "stable",
    issuedAt: "2026-07-26T02:00:00.000Z",
    statementId: "promotion:opendelegate-v0.1.0-alpha.1:0001",
  };
}

export async function createVerifiedReleaseSet(
  options: Partial<Record<"darwin" | "linux" | "win32", CandidateFixtureOptions>> = {},
): Promise<VerifiedReleaseSet> {
  const targets = [
    { platform: "darwin", architecture: "arm64" },
    { platform: "linux", architecture: "x64" },
    { platform: "win32", architecture: "x64" },
  ] as const;
  const fixtures: CandidateFixture[] = [];
  const publishers: PublisherFixture[] = [];
  const releases: VerifiedRelease[] = [];
  try {
    for (const target of targets) {
      const fixture = await createCandidateFixture(target, options[target.platform]);
      fixtures.push(fixture);
      const candidate = await inspectCandidate({
        root: fixture.root,
        expectedTarget: target,
      });
      const publisher = await createPublisherFixture(candidate, fixture.root);
      publishers.push(publisher);
      releases.push(
        await verifyRelease({
          root: fixture.root,
          expectedTarget: target,
          candidatePublisherEvidence: {
            archivePath: publisher.archivePath,
            attestationPath: publisher.attestationPath,
          },
          publisherTrust: { publicKeyPem: publisher.publicKeyPem },
        }),
      );
    }
  } catch (error) {
    await cleanupReleaseFixtures(fixtures, publishers);
    throw error;
  }
  return {
    fixtures,
    publishers,
    releases,
    async cleanup() {
      await cleanupReleaseFixtures(fixtures, publishers);
    },
  };
}

export interface PromotionFixture {
  readonly attestationPath: string;
  readonly cleanup: () => Promise<void>;
  readonly keyId: string;
  readonly liveEvidence: readonly {
    readonly criterionId: number;
    readonly path: string;
    readonly bytes: Buffer;
  }[];
  readonly notarizationReceiptPath: string;
  readonly publicKeyPem: Buffer;
  readonly receiptId: string;
  readonly receiptPath: string;
  readonly statementId: string;
  readonly supportMatrix: { readonly path: string; readonly bytes: Buffer };
}

export function linuxVerificationInput(
  releaseSet: VerifiedReleaseSet,
  promotion: PromotionFixture,
) {
  const linuxIndex = releaseSet.releases.findIndex(
    (release) => release.candidate.target.platform === "linux",
  );
  const fixture = releaseSet.fixtures[linuxIndex]!;
  const publisher = releaseSet.publishers[linuxIndex]!;
  const candidate = releaseSet.releases[linuxIndex]!.candidate;
  return {
    root: fixture.root,
    expectedTarget: { platform: "linux", architecture: "x64" } as const,
    expectedCandidateDigest: candidate.publisherStatement.sha256,
    candidatePublisherEvidence: {
      archivePath: publisher.archivePath,
      attestationPath: publisher.attestationPath,
    },
    publisherTrust: { publicKeyPem: publisher.publicKeyPem },
    promotionAttestation: {
      attestationPath: promotion.attestationPath,
      liveEvidence: promotion.liveEvidence,
      notarizationReceiptPath: promotion.notarizationReceiptPath,
      supportMatrix: promotion.supportMatrix,
    },
    promotionReceipt: { receiptPath: promotion.receiptPath },
    promotionTrust: { publicKeyPem: promotion.publicKeyPem },
  };
}

export async function createPromotionFixture(
  releaseSet: VerifiedReleaseSet,
  options: {
    readonly macCertificateIdentity?: string;
    readonly notarizationTeamId?: string;
    readonly privateKey?: KeyObject;
    readonly receiptDomain?: string;
    readonly receiptReadBackMismatch?: boolean;
  } = {},
): Promise<PromotionFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-promotion-"));
  const mac = releaseSet.releases.find(
    (release) => release.candidate.target.platform === "darwin",
  )!;
  const statementId = "promotion:opendelegate-v0.1.0-alpha.1:0001";
  const receiptId = "receipt:opendelegate-v0.1.0-alpha.1:0001";
  const notarizationReceiptPath = join(directory, "macos-notarization.json");
  const canonicalNotarizationValue = {
    schemaVersion: 1,
    product: "OpenDelegate",
    type: "macos-notarization",
    target: { platform: "darwin", architecture: "arm64" },
    archive: mac.archive,
    status: "accepted",
    submissionId: "0f7b7a50-584d-43fc-b746-0a1419b64630",
    teamId: "OPENDELEG1",
    resultId: "apple-notary-result-0001",
    logId: "apple-notary-log-0001",
    observedAt: "2026-07-26T01:00:00.000Z",
  };
  const canonicalNotarizationBytes = canonicalJson(canonicalNotarizationValue);
  const supportMatrix = {
    path: "docs/release/SUPPORT_MATRIX.md",
    bytes: Buffer.from("# Immutable support matrix\n", "utf8"),
  };
  const liveEvidence = Array.from({ length: 36 }, (_, index) => ({
    criterionId: index + 1,
    path: `docs/release/evidence/live-${String(index + 1).padStart(2, "0")}.json`,
    bytes: Buffer.from(`{"criterion":${String(index + 1)},"status":"verified"}\n`, "utf8"),
  }));
  const platformAuthenticityEvidence = releaseSet.releases.map((release) => {
    const platform = release.candidate.target.platform;
    return {
      target: release.candidate.target,
      recordSha256: release.candidate.platformAuthenticitySha256,
      certificateIdentities: release.candidate.platformCertificateIdentities,
      productCertificateIdentity: release.candidate.platformProductCertificateIdentity,
      verificationEvidence: [
        {
          path: `docs/release/evidence/${platform}-native-authenticity.json`,
          bytes: Buffer.from(`{"platform":"${platform}","verified":true}\n`, "utf8"),
        },
      ],
    };
  });
  const composed = composePromotionStatement({
    verifiedCandidates: releaseSet.releases,
    platformAuthenticityEvidence,
    notarizationReceipt: {
      path: "docs/release/evidence/macos-notarization.json",
      bytes: canonicalNotarizationBytes,
    },
    supportMatrix,
    liveEvidence,
    releaseId: "opendelegate-v0.1.0-alpha.1",
    channel: "stable",
    issuedAt: "2026-07-26T02:00:00.000Z",
    statementId,
  });
  const generated = options.privateKey === undefined ? generateKeyPairSync("ed25519") : undefined;
  const privateKey = options.privateKey ?? generated!.privateKey;
  const publicKey = generated?.publicKey ?? createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const keyId = `sha256:${sha256(publicKeyDer)}`;
  const promotionUsesComposer =
    options.macCertificateIdentity === undefined && options.notarizationTeamId === undefined;
  const alteredPromotionStatement = promotionUsesComposer
    ? undefined
    : (JSON.parse(Buffer.from(composed.canonicalBytes).toString("utf8")) as Record<
        string,
        unknown
      > & {
        targets: {
          notarization: {
            receipt: { sha256: string };
            teamId: string;
          } | null;
          platformAuthenticity: { certificateIdentities: string[] };
        }[];
      });
  const notarizationBytes =
    options.notarizationTeamId === undefined
      ? canonicalNotarizationBytes
      : canonicalJson({
          ...canonicalNotarizationValue,
          teamId: options.notarizationTeamId,
        });
  if (options.macCertificateIdentity !== undefined) {
    alteredPromotionStatement!.targets[0]!.platformAuthenticity.certificateIdentities = [
      options.macCertificateIdentity,
    ];
  }
  if (options.notarizationTeamId !== undefined) {
    alteredPromotionStatement!.targets[0]!.notarization!.teamId = options.notarizationTeamId;
    alteredPromotionStatement!.targets[0]!.notarization!.receipt.sha256 = sha256(notarizationBytes);
  }
  const promotionStatement = alteredPromotionStatement ?? composed.statement;
  const promotionCanonicalBytes = promotionUsesComposer
    ? composed.canonicalBytes
    : canonicalJson(promotionStatement);
  const promotionSigningBytes = promotionUsesComposer
    ? composed.signingBytes
    : Buffer.concat([
        Buffer.from("OpenDelegate promotion authorization v1\n", "utf8"),
        promotionCanonicalBytes,
      ]);
  const promotionSignature = createSignature(null, promotionSigningBytes, privateKey).toString(
    "base64url",
  );
  const attestationBytes = promotionUsesComposer
    ? composeSignedReleaseEnvelope({
        composed,
        keyId,
        signature: promotionSignature,
      }).canonicalBytes
    : canonicalJson({
        schemaVersion: 1,
        product: "OpenDelegate",
        role: "promotion",
        algorithm: "ed25519",
        keyId,
        statement: promotionStatement,
        signature: promotionSignature,
      });
  const attestationPath = join(directory, "promotion-attestation.json");
  const receiptUsesComposer =
    options.receiptDomain === undefined && options.receiptReadBackMismatch !== true;
  const receiptComposed = receiptUsesComposer
    ? composeSupportedChannelReceiptStatement({
        promotion: composed,
        promotionAttestationSha256: sha256(attestationBytes),
        publishedAssetReadBacks: releaseSet.releases.map((release) => ({
          target: release.candidate.target,
          readBackSha256: release.archive.sha256,
        })),
        receiptId,
        observedAt: "2026-07-26T03:00:00.000Z",
      })
    : undefined;
  const receiptStatement = receiptComposed?.statement ?? {
    schemaVersion: 1,
    product: "OpenDelegate",
    role: "promotion",
    domain: options.receiptDomain ?? "opendelegate.release.supported-channel-receipt.v1",
    receiptId,
    releaseId: "opendelegate-v0.1.0-alpha.1",
    channel: "stable",
    tag: "v0.1.0-alpha.1",
    promotionAttestationSha256: sha256(attestationBytes),
    publishedAssets: releaseSet.releases.map((release) => ({
      target: release.candidate.target,
      path: release.archive.path,
      size: release.archive.size,
      sha256: release.archive.sha256,
      readBackSha256:
        options.receiptReadBackMismatch === true && release.candidate.target.platform === "linux"
          ? "0".repeat(64)
          : release.archive.sha256,
    })),
    observedAt: "2026-07-26T03:00:00.000Z",
  };
  const receiptStatementBytes = receiptComposed?.canonicalBytes ?? canonicalJson(receiptStatement);
  const receiptSignature = createSignature(
    null,
    receiptComposed?.signingBytes ??
      Buffer.concat([
        Buffer.from("OpenDelegate supported channel receipt v1\n", "utf8"),
        receiptStatementBytes,
      ]),
    privateKey,
  ).toString("base64url");
  const receiptBytes =
    receiptComposed === undefined
      ? canonicalJson({
          schemaVersion: 1,
          product: "OpenDelegate",
          role: "promotion",
          algorithm: "ed25519",
          keyId,
          statement: receiptStatement,
          signature: receiptSignature,
        })
      : composeSignedReleaseEnvelope({
          composed: receiptComposed,
          keyId,
          signature: receiptSignature,
        }).canonicalBytes;
  const receiptPath = join(directory, "release-receipt.json");
  await Promise.all([
    writeFile(notarizationReceiptPath, notarizationBytes),
    writeFile(attestationPath, attestationBytes),
    writeFile(receiptPath, receiptBytes),
  ]);
  return {
    attestationPath,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
    keyId,
    liveEvidence,
    notarizationReceiptPath,
    publicKeyPem: Buffer.from(publicKeyPem),
    receiptId,
    receiptPath,
    statementId,
    supportMatrix,
  };
}

export interface ConfiguredReleaseStateFixture {
  readonly cleanup: () => Promise<void>;
  readonly configurationPath: string;
  readonly promotionAttestationPath?: string;
  readonly stateRoot: string;
}

export interface ReleasedConfiguredReleaseTestFixture {
  readonly candidate: CandidateDescription;
  readonly cleanup: () => Promise<void>;
  readonly configuration: ConfiguredReleaseStateFixture;
  readonly expectedTarget: {
    readonly architecture: "arm64" | "x64";
    readonly platform: "darwin" | "linux" | "win32";
  };
  readonly promotion: PromotionFixture;
  readonly releaseSet: VerifiedReleaseSet;
  readonly root: string;
  readonly stateRoot: string;
}

export async function createReleasedConfiguredReleaseTestFixture(
  platform: "darwin" | "linux" | "win32" = "linux",
): Promise<ReleasedConfiguredReleaseTestFixture> {
  const releaseSet = await createVerifiedReleaseSet();
  let promotion: PromotionFixture | undefined;
  let configuration: ConfiguredReleaseStateFixture | undefined;
  try {
    promotion = await createPromotionFixture(releaseSet);
    const releaseIndex = releaseSet.releases.findIndex(
      (release) => release.candidate.target.platform === platform,
    );
    if (releaseIndex < 0) {
      throw new Error("The configured release fixture target is unavailable.");
    }
    configuration = await createConfiguredReleaseState(releaseSet, releaseIndex, promotion);
    const release = releaseSet.releases[releaseIndex]!;
    return {
      candidate: release.candidate,
      async cleanup() {
        await Promise.all([releaseSet.cleanup(), promotion!.cleanup(), configuration!.cleanup()]);
      },
      configuration,
      expectedTarget: release.candidate.target,
      promotion,
      releaseSet,
      root: releaseSet.fixtures[releaseIndex]!.root,
      stateRoot: configuration.stateRoot,
    };
  } catch (error) {
    await Promise.all([
      releaseSet.cleanup(),
      ...(promotion === undefined ? [] : [promotion.cleanup()]),
      ...(configuration === undefined ? [] : [configuration.cleanup()]),
    ]);
    throw error;
  }
}

export async function createConfiguredReleaseState(
  releaseSet: VerifiedReleaseSet,
  releaseIndex: number,
  promotion: PromotionFixture | null,
  policy: {
    readonly revokedCertificateIdentities?: readonly string[];
    readonly revokedPromotionKeyIds?: readonly string[];
    readonly revokedPublisherKeyIds?: readonly string[];
    readonly revokedStatementIds?: readonly string[];
  } = {},
): Promise<ConfiguredReleaseStateFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), "opendelegate-release-state-"));
  const trustRoot = join(stateRoot, "trust");
  const release = releaseSet.releases[releaseIndex]!;
  const publisher = releaseSet.publishers[releaseIndex]!;
  const targetKey = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
  const releaseMaterialRoot =
    `releases/${release.candidate.productVersion}/${targetKey}/` +
    `${release.candidate.checksumManifestSha256}/files`;
  const publisherRoot = `${releaseMaterialRoot}/candidate`;
  const archiveFile = `${publisherRoot}/${basename(publisher.archivePath)}`;
  const publisherAttestationFile = `${publisherRoot}/${basename(publisher.attestationPath)}`;
  const publisherTrustRootFile = `${publisherRoot}/publisher-public.pem`;
  const writeTrustFile = async (path: string, bytes: Uint8Array): Promise<string> => {
    const absolutePath = join(trustRoot, ...path.split("/"));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    return absolutePath;
  };
  await Promise.all([
    writeTrustFile(archiveFile, await readFile(publisher.archivePath)),
    writeTrustFile(publisherAttestationFile, await readFile(publisher.attestationPath)),
    writeTrustFile(publisherTrustRootFile, publisher.publicKeyPem),
  ]);

  let promotionConfiguration: object | null = null;
  let promotionAttestationPath: string | undefined;
  if (promotion !== null) {
    const promotionRoot = `${releaseMaterialRoot}/promotion`;
    const promotionAttestationFile = `${promotionRoot}/promotion-attestation.json`;
    const supportedChannelReceiptFile = `${promotionRoot}/supported-channel-receipt.json`;
    const promotionTrustRootFile = `${promotionRoot}/promotion-public.pem`;
    const supportMatrixFile = `${promotionRoot}/support-matrix.md`;
    const notarizationReceiptFile = `${promotionRoot}/macos-notarization.json`;
    promotionAttestationPath = await writeTrustFile(
      promotionAttestationFile,
      await readFile(promotion.attestationPath),
    );
    await Promise.all([
      writeTrustFile(supportedChannelReceiptFile, await readFile(promotion.receiptPath)),
      writeTrustFile(promotionTrustRootFile, promotion.publicKeyPem),
      writeTrustFile(supportMatrixFile, promotion.supportMatrix.bytes),
      writeTrustFile(notarizationReceiptFile, await readFile(promotion.notarizationReceiptPath)),
    ]);
    const liveEvidence = [];
    for (const evidence of promotion.liveEvidence) {
      const file =
        `${promotionRoot}/live/` + `${String(evidence.criterionId).padStart(2, "0")}.json`;
      await writeTrustFile(file, evidence.bytes);
      liveEvidence.push({
        criterionId: evidence.criterionId,
        statementPath: evidence.path,
        file,
      });
    }
    promotionConfiguration = {
      promotionAttestationFile,
      supportedChannelReceiptFile,
      promotionTrustRootFile,
      supportMatrix: {
        statementPath: promotion.supportMatrix.path,
        file: supportMatrixFile,
      },
      notarizationReceiptFile,
      liveEvidence,
    };
  }

  const configuration = {
    schemaVersion: 1,
    product: "OpenDelegate",
    target: release.candidate.target,
    candidate: {
      expectedManifestSha256: release.candidate.checksumManifestSha256,
      expectedCandidateDigest: release.candidate.publisherStatement.sha256,
      archiveFile,
      publisherAttestationFile,
      publisherTrustRootFile,
    },
    promotion: promotionConfiguration,
    policy: {
      revokedCertificateIdentities: policy.revokedCertificateIdentities ?? [],
      revokedPromotionKeyIds: policy.revokedPromotionKeyIds ?? [],
      revokedPublisherKeyIds: policy.revokedPublisherKeyIds ?? [],
      revokedStatementIds: policy.revokedStatementIds ?? [],
    },
  };
  const configurationPath = externalReleaseVerificationPath({
    stateRoot,
    productVersion: release.candidate.productVersion,
    target: release.candidate.target,
    checksumManifestSha256: release.candidate.checksumManifestSha256,
  });
  await mkdir(dirname(configurationPath), { recursive: true });
  await writeFile(configurationPath, canonicalJson(configuration));
  return {
    async cleanup() {
      await rm(stateRoot, { recursive: true, force: true });
    },
    configurationPath,
    ...(promotionAttestationPath === undefined ? {} : { promotionAttestationPath }),
    stateRoot,
  };
}

export async function cleanupReleaseFixtures(
  fixtures: readonly CandidateFixture[],
  publishers: readonly PublisherFixture[],
): Promise<void> {
  await Promise.all([
    ...fixtures.map((fixture) => rm(fixture.root, { recursive: true, force: true })),
    ...publishers.flatMap((publisher) => [
      rm(publisher.archivePath, { force: true }),
      rm(publisher.attestationPath, { force: true }),
    ]),
  ]);
}

export interface PublisherFixture {
  readonly archiveBytes: Buffer;
  readonly archivePath: string;
  readonly attestationPath: string;
  readonly attestationSha256: string;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: Buffer;
}

export async function createPublisherFixture(
  candidate: CandidateDescription,
  candidateRoot: string,
): Promise<PublisherFixture> {
  const archiveBytes = Buffer.from(
    `archive:${candidate.target.platform}:${candidate.publisherStatement.sha256}\n`,
    "utf8",
  );
  const archivePath = `${candidateRoot}.tar.gz`;
  const attestationPath = `${archivePath}.publisher-attestation.json`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const keyId = `sha256:${sha256(publicKeyDer)}`;
  const composed = composePublisherAttestationStatement({
    candidate,
    archive: {
      path: basename(archivePath),
      size: archiveBytes.byteLength,
      sha256: sha256(archiveBytes),
    },
  });
  const signature = createSignature(null, composed.signingBytes, privateKey).toString("base64url");
  const envelope = composeSignedReleaseEnvelope({
    composed,
    keyId,
    signature,
  });
  const attestationBytes = envelope.canonicalBytes;
  await Promise.all([
    writeFile(archivePath, archiveBytes),
    writeFile(attestationPath, attestationBytes),
  ]);
  return {
    archiveBytes,
    archivePath,
    attestationPath,
    attestationSha256: envelope.sha256,
    keyId,
    privateKey,
    publicKeyPem: Buffer.from(publicKeyPem),
  };
}

export function candidateBinding(candidate: CandidateDescription): object {
  return {
    publisherCandidateStatementSha256: candidate.publisherStatement.sha256,
    target: candidate.target,
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
  };
}

export async function createCandidateFixture(
  target: Readonly<{ platform: "darwin" | "linux" | "win32"; architecture: "arm64" | "x64" }>,
  options: CandidateFixtureOptions = {},
): Promise<CandidateFixture> {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-integrity-"));
  const auditedSourceCommit = options.auditedSourceCommit ?? "a".repeat(40);
  const buildCommit = options.buildCommit ?? "b".repeat(40);
  const productVersion = options.productVersion ?? "0.1.0-alpha.1";
  const supportStatus = options.supportStatus ?? "release-candidate";
  const candidateAttestationId = options.candidateAttestationId ?? "release:candidate:test-0001";
  const evidencePath = "docs/release/evidence/release-proof.txt";
  const evidenceBytes = Buffer.from("immutable release evidence\n", "utf8");
  const evidenceSha256 = sha256(evidenceBytes);
  const componentDefinitions = expectedComponents(target.platform);
  const componentBytes = new Map(
    componentDefinitions.map((component) => [
      component.path,
      Buffer.from(`signed:${component.kind}:${target.platform}\n`, "utf8"),
    ]),
  );
  const nativeComponents = {
    schemaVersion: 1,
    platform: target.platform,
    architecture: target.architecture,
    components: componentDefinitions.map((component) => ({
      kind: component.kind,
      path: component.path,
      sha256: `sha256:${sha256(componentBytes.get(component.path)!)}`,
    })),
  };
  const nativeComponentsBytes = canonicalJson(nativeComponents);
  const runtimePath = target.platform === "win32" ? "runtime/node.exe" : "runtime/node";
  const thirdPartyBytes = new Map<string, Buffer>([
    [
      "node_modules/example-native/build/Release/example.node",
      nativeFixtureBinary(target.platform, "example-native-final"),
    ],
    [runtimePath, nativeFixtureBinary(target.platform, "node-runtime-final")],
  ]);
  const platformPolicy =
    target.platform === "darwin"
      ? "developer-id"
      : target.platform === "win32"
        ? "authenticode"
        : "publisher-only";
  const publicIdentity =
    target.platform === "darwin"
      ? {
          type: "apple-developer-id-application",
          selector: "Developer ID Application: OpenDelegate (OPENDELEG1)",
          teamId: "OPENDELEG1",
        }
      : target.platform === "win32"
        ? {
            type: "windows-authenticode",
            certificateSha1: "E".repeat(40),
            store: "CurrentUser/My",
            timestampUrl: "https://timestamp.example.test/",
          }
        : null;
  const upstreamRuntimeIdentity =
    target.platform === "darwin"
      ? {
          type: "apple-developer-id-application",
          selector: "Developer ID Application: Node.js Foundation (HX7739G8FX)",
          teamId: "HX7739G8FX",
        }
      : target.platform === "win32"
        ? {
            type: "windows-authenticode-upstream",
            certificateSha1: "A".repeat(40),
          }
        : null;
  const thirdPartyComponents = [...thirdPartyBytes]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([path, finalBytes]) => {
      const digest = `sha256:${sha256(finalBytes)}`;
      const isRuntime = path === runtimePath;
      return {
        kind: isRuntime ? "bundled-node-runtime" : "bundled-native-library",
        path,
        inputSha256:
          target.platform === "linux" || isRuntime
            ? digest
            : `sha256:${sha256(nativeFixtureBinary(target.platform, `${path}:input`))}`,
        sha256: digest,
        verification:
          target.platform === "linux"
            ? "publisher-only"
            : isRuntime
              ? "upstream-verified"
              : "resigned",
        publicIdentity: isRuntime ? upstreamRuntimeIdentity : null,
      };
    });
  const runtimeComponent = thirdPartyComponents.find(({ path }) => path === runtimePath)!;
  if (options.collideRuntimeIdentity === true && target.platform !== "linux") {
    runtimeComponent.publicIdentity =
      target.platform === "darwin"
        ? publicIdentity
        : {
            type: "windows-authenticode-upstream",
            certificateSha1: "E".repeat(40),
          };
  }
  if (options.corruptRuntimeInputDigest === true) {
    runtimeComponent.inputSha256 = `sha256:${"7".repeat(64)}`;
  }
  if (options.omitThirdPartyComponent === true) {
    thirdPartyComponents.pop();
  }
  if (options.addThirdPartyComponent === true) {
    thirdPartyComponents.push({
      kind: "bundled-native-library",
      path: "vendor/extra.node",
      inputSha256: `sha256:${"8".repeat(64)}`,
      sha256: `sha256:${"9".repeat(64)}`,
      verification: target.platform === "linux" ? "publisher-only" : "resigned",
      publicIdentity: null,
    });
  }
  if (options.corruptThirdPartyDigest === true) {
    thirdPartyComponents[0]!.sha256 = `sha256:${"0".repeat(64)}`;
  }
  if (options.corruptThirdPartyVerification === true) {
    thirdPartyComponents[0]!.verification = "unsigned";
  }
  const platformAuthenticity = {
    schemaVersion: 1,
    target,
    supportEligible: true,
    status: "verified",
    policy: platformPolicy,
    policySha256: "c".repeat(64),
    tool:
      target.platform === "linux"
        ? null
        : {
            name: target.platform === "darwin" ? "codesign" : "signtool",
            version: "1.0.0",
            sha256: "d".repeat(64),
          },
    publicIdentity,
    components: nativeComponents.components.map((component) => ({
      kind: component.kind,
      path: component.path,
      inputSha256:
        target.platform === "linux"
          ? component.sha256
          : `sha256:${sha256(Buffer.from(`unsigned:${component.kind}:${target.platform}\n`))}`,
      sha256: component.sha256,
      verification: target.platform === "linux" ? "publisher-only" : "signed",
    })),
    thirdPartyComponents,
  };
  const platformAuthenticityBytes = canonicalJson(platformAuthenticity);
  const proof = {
    sourceCommit: auditedSourceCommit,
    attestationId: "release:proof:test-0001",
    evidence: [{ path: evidencePath, sha256: evidenceSha256 }],
  };
  const criteria = Array.from({ length: 36 }, (_, index) => ({
    id: index + 1,
    title: `Release criterion ${String(index + 1)}`,
    implementationStatus: "verified",
    liveProofStatus: "verified",
    evidence: [evidencePath],
    nextGate: "Complete.",
    verification: {
      implementation: proof,
      liveProof: proof,
    },
  }));
  const ledger = {
    $schema: "./acceptance-evidence.schema.json",
    schemaVersion: 1,
    product: "OpenDelegate",
    milestone: "first",
    auditedAt: "2026-07-26T00:00:00.000Z",
    sourceCommit: auditedSourceCommit,
    releaseStatus: "candidate",
    criteria,
    candidateAttestation: {
      sourceCommit: auditedSourceCommit,
      attestationId: candidateAttestationId,
      evidence: [{ path: evidencePath, sha256: evidenceSha256 }],
    },
  };
  const ledgerBytes = canonicalJson(ledger);
  const releaseMetadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion,
    protocolVersion: "v1",
    buildId: `release-candidate-${buildCommit.slice(0, 12)}`,
    createdAt: "2026-07-26T00:00:00.000Z",
    timestampPolicy: supportStatus === "release-candidate" ? "source-commit" : "wall-clock",
    platform: target.platform,
    architecture: target.architecture,
    bundledNodeVersion: "24.18.0",
    bundledRuntime: {
      source: "official-nodejs-distribution",
      archive: "node-v24.18.0.tar.gz",
      archiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0.tar.gz",
      archiveSha256: "1".repeat(64),
      shasumsUrl: "https://nodejs.org/dist/v24.18.0/SHASUMS256.txt",
      executableSha256: sha256(thirdPartyBytes.get(runtimePath)!),
      licenseSha256: "3".repeat(64),
    },
    toolchain: {
      packageManager: "pnpm@11.15.1",
      bundler: "esbuild@0.28.1",
    },
    dependencyLockSha256: "4".repeat(64),
    sourcePackageManifestSha256: "5".repeat(64),
    runtimeExternals: [
      { name: "@node-rs/argon2", version: "2.0.2" },
      { name: "better-sqlite3", version: "13.0.1" },
      { name: "pg", version: "8.22.0" },
    ],
    nativeComponents,
    buildCommit,
    auditedSourceCommit,
    changedAttestationPaths: ["docs/release/acceptance-evidence.json", evidencePath],
    buildSourceDirty: false,
    supportStatus,
    buildMode: supportStatus === "release-candidate" ? "release-candidate" : "internal-preview",
    releaseEvidence: {
      auditedAt: ledger.auditedAt,
      releaseStatus: "candidate",
      sha256: options.corruptMetadataLedgerBinding ? "0".repeat(64) : sha256(ledgerBytes),
      implementation: { verified: 36 },
      liveProof: { verified: 36 },
      complete: true,
    },
    entrypoints:
      target.platform === "win32"
        ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
        : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  const releaseMetadataBytes = options.nonCanonicalMetadata
    ? Buffer.from(JSON.stringify(releaseMetadata), "utf8")
    : canonicalJson(releaseMetadata);
  const payloadFiles = new Map<string, Buffer>([
    [evidencePath, evidenceBytes],
    ["docs/release/acceptance-evidence.json", ledgerBytes],
    ["native-components.json", nativeComponentsBytes],
    ["platform-authenticity.json", platformAuthenticityBytes],
    ["release-metadata.json", releaseMetadataBytes],
    [
      "smoke-evidence.json",
      canonicalJson(createSmokeEvidence(target, releaseMetadata.buildId, productVersion)),
    ],
  ]);
  for (const [path, bytes] of componentBytes) {
    payloadFiles.set(path, bytes);
  }
  for (const [path, bytes] of thirdPartyBytes) {
    if (options.omitRuntimePayload !== true || path !== runtimePath) {
      payloadFiles.set(path, bytes);
    }
  }
  if (options.addUndeclaredNativePayload === true) {
    payloadFiles.set(
      "vendor/undeclared.node",
      nativeFixtureBinary(target.platform, "undeclared-native"),
    );
  }
  if (options.addUnknownNativeSuffixPayload === true) {
    payloadFiles.set(
      "vendor/not-a-native-library.node",
      Buffer.from("not actually native\n", "utf8"),
    );
  }
  for (const entrypoint of releaseMetadata.entrypoints) {
    payloadFiles.set(entrypoint, Buffer.from(`launcher:${entrypoint}\n`, "utf8"));
  }
  const payloadEntries = [...payloadFiles]
    .map(([path, bytes]) => ({ path, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const payloadManifestBytes = canonicalJson({
    schemaVersion: 1,
    excludedSelfReferences: ["SHA256SUMS", "payload-manifest.json"],
    fileCount: payloadEntries.length,
    totalBytes: payloadEntries.reduce((sum, entry) => sum + entry.size, 0),
    files: payloadEntries,
  });
  const checksumEntries = [
    ...payloadEntries,
    {
      path: "payload-manifest.json",
      size: payloadManifestBytes.byteLength,
      sha256: sha256(payloadManifestBytes),
    },
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
  const checksumManifestBytes = Buffer.from(
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""),
    "utf8",
  );
  payloadFiles.set("payload-manifest.json", payloadManifestBytes);
  payloadFiles.set("SHA256SUMS", checksumManifestBytes);
  for (const [path, bytes] of payloadFiles) {
    const destination = join(root, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
  }
  return {
    acceptanceLedgerSha256: sha256(ledgerBytes),
    checksumManifestSha256: sha256(checksumManifestBytes),
    nativeComponentsSha256: sha256(nativeComponentsBytes),
    payloadManifestSha256: sha256(payloadManifestBytes),
    platformAuthenticitySha256: sha256(platformAuthenticityBytes),
    releaseMetadataSha256: sha256(payloadFiles.get("release-metadata.json")!),
    root,
  };
}

export interface CandidateFixtureOptions {
  readonly addThirdPartyComponent?: boolean;
  readonly addUndeclaredNativePayload?: boolean;
  readonly addUnknownNativeSuffixPayload?: boolean;
  readonly auditedSourceCommit?: string;
  readonly buildCommit?: string;
  readonly candidateAttestationId?: string;
  readonly collideRuntimeIdentity?: boolean;
  readonly corruptMetadataLedgerBinding?: boolean;
  readonly corruptRuntimeInputDigest?: boolean;
  readonly corruptThirdPartyDigest?: boolean;
  readonly corruptThirdPartyVerification?: boolean;
  readonly nonCanonicalMetadata?: boolean;
  readonly omitRuntimePayload?: boolean;
  readonly omitThirdPartyComponent?: boolean;
  readonly productVersion?: string;
  readonly supportStatus?:
    "internal-preview-blocked" | "internal-preview-complete" | "release-candidate";
}

export function createSmokeEvidence(
  target: Readonly<{ platform: string; architecture: string }>,
  buildId: string,
  productVersion: string,
): object {
  return {
    schemaVersion: 1,
    platform: target.platform,
    architecture: target.architecture,
    bundledNodeVersion: "24.18.0",
    buildId,
    productVersion,
    checks: {
      cliHelp: "passed",
      backupCliHelp: "passed",
      serviceCliHelp: "passed",
      workerCliHelp: "passed",
      workerCliVersion: "passed",
      workerUnenrolledStatus: "passed",
      cleanHomeInitialization: "passed",
      mainHealth: "passed",
      adminStaticApp: "passed",
      loopbackOwnerClaim: "passed",
      ownerLogin: "passed",
      ownerSessionCookieContract: "passed",
      ownerSessionRoundTrip: "passed",
      recoveryCredentialsIssued: 10,
      cleanShutdown: {
        status: "passed",
        markerObserved: true,
        naturalExit: true,
        exitCode: 0,
        signal: null,
        shutdownTimedOut: false,
        forcedTermination: false,
      },
    },
  };
}

export function expectedComponents(
  platform: "darwin" | "linux" | "win32",
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

export function nativeFixtureBinary(platform: "darwin" | "linux" | "win32", label: string): Buffer {
  const body = Buffer.from(`fixture:${label}\n`, "utf8");
  if (platform === "linux") {
    return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), body]);
  }
  if (platform === "darwin") {
    return Buffer.concat([Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), body]);
  }
  const header = Buffer.alloc(0x80);
  header[0] = 0x4d;
  header[1] = 0x5a;
  header.writeUInt32LE(0x40, 0x3c);
  header[0x40] = 0x50;
  header[0x41] = 0x45;
  return Buffer.concat([header, body]);
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
