import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDisjointPaths,
  assertPathOutsideRoots,
  assertSha256,
  hashStableRegularFile,
  isSameOrDescendant,
  readPinnedBytes,
  readPinnedCanonicalJson,
  requireCanonicalDirectory,
  requireExactKeys,
} from "./release-tooling-io.mjs";

const currentFile = fileURLToPath(import.meta.url);
const moduleRepositoryRoot = resolve(dirname(currentFile), "..");
const FIRST_MILESTONE_TARGETS = Object.freeze([
  Object.freeze({ platform: "darwin", architecture: "arm64" }),
  Object.freeze({ platform: "linux", architecture: "x64" }),
  Object.freeze({ platform: "win32", architecture: "x64" }),
]);
const KEY_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{1,31}$/u;
const MAXIMUM_PLAN_BYTES = 4 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_TRUST_ROOT_BYTES = 64 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const preparationDetails = new WeakMap();

export async function preparePromotionAuthorization(input, dependencies = {}) {
  requireExactKeys(
    input,
    ["repositoryRoot", "planPath", "planSha256", "outputPaths"],
    "promotion preparation input",
  );
  assertPromotionPreparationPaths(input);
  const runningRepositoryRoot = await requireCanonicalDirectory(
    dependencies.runningRepositoryRoot ?? moduleRepositoryRoot,
    "running release-tool repository",
  );
  const requestedRepositoryRoot = await requireCanonicalDirectory(
    input.repositoryRoot,
    "release repository",
  );
  if (comparablePath(runningRepositoryRoot) !== comparablePath(requestedRepositoryRoot)) {
    throw new Error("Promotion must execute from the exact clean repository named by the runner.");
  }
  const outputRoot = await requireSharedOutputRoot(input.outputPaths);
  const canonicalOutputPaths = input.outputPaths.map((path) => join(outputRoot, basename(path)));
  assertDisjointPaths(canonicalOutputPaths, "promotion output");
  const planFile = await readPinnedCanonicalJson({
    label: "promotion plan",
    maximumBytes: MAXIMUM_PLAN_BYTES,
    path: input.planPath,
    sha256: input.planSha256,
  });
  const plan = parsePromotionPlan(planFile.value);
  const candidateRoots = await Promise.all(
    plan.candidates.map(({ root }) => requireCanonicalDirectory(root, "release candidate root")),
  );
  assertDisjointCandidateRoots(candidateRoots);
  assertPathOutsideRoots(
    planFile.path,
    [requestedRepositoryRoot, outputRoot, ...candidateRoots],
    "promotion plan",
  );
  for (const file of allPromotionPlanFiles(plan)) {
    assertPathOutsideRoots(file.path, [outputRoot, ...candidateRoots], "promotion evidence input");
    if (comparablePath(file.path) === comparablePath(planFile.path)) {
      throw new Error("The promotion plan and evidence inputs must be distinct.");
    }
  }
  for (const candidate of plan.candidates) {
    for (const file of [
      candidate.archive,
      candidate.publisherAttestation,
      candidate.publisherTrustRoot,
    ]) {
      assertPathOutsideRoots(file.path, [requestedRepositoryRoot], "external publisher authority");
    }
  }
  for (const root of candidateRoots) {
    assertPathOutsideRoots(root, [requestedRepositoryRoot, outputRoot], "release candidate root");
  }
  for (const path of canonicalOutputPaths) {
    assertPathOutsideRoots(
      path,
      [requestedRepositoryRoot, dirname(planFile.path), ...candidateRoots],
      "promotion output",
    );
  }

  const sourceReader = dependencies.readSourceIdentity;
  if (typeof sourceReader !== "function") {
    throw new Error("Promotion requires an explicitly pinned Git source-identity reader.");
  }
  const sourceBefore = await sourceReader(requestedRepositoryRoot);
  assertCleanPromotionSource(sourceBefore, plan.source.buildCommit);
  const logicHasher = dependencies.hashReleaseLogic ?? hashPromotionReleaseLogic;
  const releaseLogicBefore = await logicHasher(runningRepositoryRoot);
  const integrity =
    dependencies.integrity ?? (await import("../packages/release-integrity/src/index.ts"));
  requireIntegrityBoundary(integrity);
  const loaded = await loadPromotionInputs(plan, candidateRoots, integrity);
  assertLoadedPromotionInputBoundaries({
    candidateRoots,
    loaded,
    outputRoot,
    planFile,
    repositoryRoot: requestedRepositoryRoot,
  });
  const composed = integrity.composePromotionStatement({
    channel: plan.channel,
    issuedAt: plan.issuedAt,
    liveEvidence: loaded.liveEvidence,
    notarizationReceipt: loaded.notarizationReceipt,
    platformAuthenticityEvidence: loaded.platformAuthenticityEvidence,
    releaseId: plan.releaseId,
    statementId: plan.statementId,
    supportMatrix: loaded.supportMatrix,
    verifiedCandidates: loaded.verifiedCandidates,
  });
  assertPlanRevocations(plan.revocations, loaded.verifiedCandidates, plan.statementId);

  const sourceAfter = await sourceReader(requestedRepositoryRoot);
  assertCleanPromotionSource(sourceAfter, plan.source.buildCommit);
  const releaseLogicAfter = await logicHasher(runningRepositoryRoot);
  if (
    sourceBefore.commit !== sourceAfter.commit ||
    JSON.stringify(releaseLogicBefore) !== JSON.stringify(releaseLogicAfter)
  ) {
    throw new Error("The committed release-promotion logic changed during verification.");
  }
  await revalidatePinnedPromotionInputs(
    planFile,
    plan,
    loaded,
    integrity,
    candidateRoots,
    outputRoot,
    requestedRepositoryRoot,
  );

  const prepared = Object.freeze({
    composed,
    planSha256: planFile.sha256,
    releaseId: plan.releaseId,
    channel: plan.channel,
    statementId: plan.statementId,
    source: Object.freeze({
      buildCommit: sourceBefore.commit,
    }),
    releaseLogic: releaseLogicBefore,
    revocations: plan.revocations,
    verifiedCandidates: loaded.verifiedCandidates,
  });
  preparationDetails.set(
    prepared,
    Object.freeze({
      candidateRoots,
      integrity,
      loaded,
      logicHasher,
      outputRoot,
      plan,
      planFile,
      requestedRepositoryRoot,
      runningRepositoryRoot,
      sourceReader,
    }),
  );
  return prepared;
}

export async function revalidatePreparedPromotion(prepared) {
  const details = preparationDetails.get(prepared);
  if (details === undefined) {
    throw new Error("An opaque prepared promotion is required.");
  }
  const source = await details.sourceReader(details.requestedRepositoryRoot);
  assertCleanPromotionSource(source, details.plan.source.buildCommit);
  const releaseLogic = await details.logicHasher(details.runningRepositoryRoot);
  if (JSON.stringify(releaseLogic) !== JSON.stringify(prepared.releaseLogic)) {
    throw new Error("The committed release-promotion logic changed before output publication.");
  }
  await revalidatePinnedPromotionInputs(
    details.planFile,
    details.plan,
    details.loaded,
    details.integrity,
    details.candidateRoots,
    details.outputRoot,
    details.requestedRepositoryRoot,
  );
}

export function promotionPreparationExternalRoots(prepared) {
  const details = preparationDetails.get(prepared);
  if (details === undefined) {
    throw new Error("An opaque prepared promotion is required.");
  }
  return Object.freeze([
    details.requestedRepositoryRoot,
    details.outputRoot,
    dirname(details.planFile.path),
    ...details.candidateRoots,
  ]);
}

export function promotionPreparationEvidence(prepared) {
  const details = preparationDetails.get(prepared);
  if (details === undefined) {
    throw new Error("An opaque prepared promotion is required.");
  }
  return Object.freeze({
    liveEvidence: Object.freeze(
      details.loaded.liveEvidence.map((item) =>
        Object.freeze({
          criterionId: item.criterionId,
          path: item.path,
          get bytes() {
            return Uint8Array.from(item.bytes);
          },
        }),
      ),
    ),
    notarizationReceiptPath: details.plan.notarizationReceipt.file.path,
    supportMatrix: Object.freeze({
      path: details.loaded.supportMatrix.path,
      get bytes() {
        return Uint8Array.from(details.loaded.supportMatrix.bytes);
      },
    }),
    candidates: Object.freeze(
      details.plan.candidates.map((candidate, index) =>
        Object.freeze({
          archivePath: candidate.archive.path,
          attestationPath: candidate.publisherAttestation.path,
          candidateRoot: details.candidateRoots[index],
          expectedCandidateDigest: candidate.expectedCandidateDigest,
          expectedManifestSha256: candidate.expectedManifestSha256,
          get publisherTrustRoot() {
            return details.loaded.publisherFiles[index].trust.bytes;
          },
          publisherTrustRootPath: candidate.publisherTrustRoot.path,
          target: candidate.target,
        }),
      ),
    ),
  });
}

export async function hashPromotionReleaseLogic(repositoryRoot = moduleRepositoryRoot) {
  const fixed = [
    "pnpm-lock.yaml",
    "tooling/build-release.mjs",
    "tooling/configure-release.mjs",
    "tooling/create-supported-channel-receipt.mjs",
    "tooling/external-release-signer.mjs",
    "tooling/promote-release.mjs",
    "tooling/release-credential-authorization.mjs",
    "tooling/release-git-provenance.mjs",
    "tooling/release-promotion-plan.mjs",
    "tooling/release-read-back-plan.mjs",
    "tooling/release-runner-identity.mjs",
    "tooling/release-signing-policy.mjs",
    "tooling/release-tooling-io.mjs",
  ];
  const integrityDirectory = join(repositoryRoot, "packages", "release-integrity", "src");
  const integrityFiles = (await readdir(integrityDirectory))
    .filter((name) => name.endsWith(".ts"))
    .sort(compareCodeUnits)
    .map((name) => `packages/release-integrity/src/${name}`);
  return Object.freeze(
    await Promise.all(
      [...integrityFiles, ...fixed].sort(compareCodeUnits).map(async (path) =>
        Object.freeze({
          path,
          sha256: (await hashStableRegularFile(join(repositoryRoot, ...path.split("/")))).sha256,
        }),
      ),
    ),
  );
}

async function loadPromotionInputs(plan, candidateRoots, integrity) {
  const verifiedCandidates = [];
  const publisherFiles = [];
  for (let index = 0; index < plan.candidates.length; index += 1) {
    const candidate = plan.candidates[index];
    const [archive, attestation, trust] = await Promise.all([
      readPinnedBytes({
        ...candidate.archive,
        label: "release archive",
        maximumBytes: MAXIMUM_ARCHIVE_BYTES,
      }),
      readPinnedBytes({ ...candidate.publisherAttestation, label: "publisher attestation" }),
      readPinnedBytes({
        ...candidate.publisherTrustRoot,
        label: "publisher trust root",
        maximumBytes: MAXIMUM_TRUST_ROOT_BYTES,
      }),
    ]);
    const verified = await integrity.verifyRelease({
      root: candidateRoots[index],
      expectedTarget: candidate.target,
      expectedManifestSha256: candidate.expectedManifestSha256,
      expectedCandidateDigest: candidate.expectedCandidateDigest,
      candidatePublisherEvidence: {
        archivePath: archive.path,
        attestationPath: attestation.path,
      },
      publisherTrust: { publicKeyPem: trust.bytes },
      policy: plan.revocations,
    });
    if (
      verified.effectiveChannel !== "release-candidate" ||
      verified.candidate.buildCommit !== plan.source.buildCommit ||
      verified.archive.sha256 !== archive.sha256 ||
      verified.publisherAttestationSha256 !== attestation.sha256
    ) {
      throw new Error("A publisher-verified candidate does not match the promotion plan.");
    }
    verifiedCandidates.push(verified);
    publisherFiles.push({ archive, attestation, trust });
  }

  const supportMatrixFile = await readPinnedBytes({
    ...plan.supportMatrix.file,
    label: "support matrix",
    maximumBytes: MAXIMUM_EVIDENCE_BYTES,
  });
  const notarizationFile = await readPinnedBytes({
    ...plan.notarizationReceipt.file,
    label: "macOS notarization receipt",
    maximumBytes: MAXIMUM_EVIDENCE_BYTES,
  });
  const supportMatrix = Object.freeze({
    path: plan.supportMatrix.statementPath,
    get bytes() {
      return supportMatrixFile.bytes;
    },
  });
  const notarizationReceipt = Object.freeze({
    path: plan.notarizationReceipt.statementPath,
    get bytes() {
      return notarizationFile.bytes;
    },
  });
  const liveEvidenceFiles = await Promise.all(
    plan.liveEvidence.map(({ criterionId, file, statementPath }) =>
      readPinnedBytes({
        ...file,
        label: `live evidence criterion ${String(criterionId)}`,
        maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      }).then((loaded) => ({ criterionId, loaded, statementPath })),
    ),
  );
  const liveEvidence = Object.freeze(
    liveEvidenceFiles.map(({ criterionId, loaded, statementPath }) =>
      Object.freeze({
        criterionId,
        path: statementPath,
        get bytes() {
          return loaded.bytes;
        },
      }),
    ),
  );
  const platformFiles = [];
  const platformAuthenticityEvidence = [];
  for (let index = 0; index < plan.candidates.length; index += 1) {
    const candidate = plan.candidates[index];
    const files = await Promise.all(
      candidate.platformAuthenticity.verificationEvidence.map(({ file, statementPath }) =>
        readPinnedBytes({
          ...file,
          label: "platform authenticity evidence",
          maximumBytes: MAXIMUM_EVIDENCE_BYTES,
        }).then((loaded) => ({ loaded, statementPath })),
      ),
    );
    platformFiles.push(files);
    platformAuthenticityEvidence.push(
      Object.freeze({
        target: candidate.target,
        recordSha256: candidate.platformAuthenticity.recordSha256,
        certificateIdentities: candidate.platformAuthenticity.certificateIdentities,
        productCertificateIdentity: candidate.platformAuthenticity.productCertificateIdentity,
        verificationEvidence: Object.freeze(
          files.map(({ loaded, statementPath }) =>
            Object.freeze({
              path: statementPath,
              get bytes() {
                return loaded.bytes;
              },
            }),
          ),
        ),
      }),
    );
  }
  return Object.freeze({
    liveEvidence,
    liveEvidenceFiles,
    notarizationFile,
    notarizationReceipt,
    platformAuthenticityEvidence: Object.freeze(platformAuthenticityEvidence),
    platformFiles,
    publisherFiles,
    supportMatrix,
    supportMatrixFile,
    verifiedCandidates: Object.freeze(verifiedCandidates),
  });
}

async function revalidatePinnedPromotionInputs(
  planFile,
  plan,
  loaded,
  integrity,
  candidateRoots,
  outputRoot,
  repositoryRoot,
) {
  const currentPlan = await readPinnedCanonicalJson({
    label: "promotion plan",
    maximumBytes: MAXIMUM_PLAN_BYTES,
    path: planFile.path,
    sha256: planFile.sha256,
  });
  assertSamePinnedFile(currentPlan, planFile, "promotion plan");
  const currentPublisherFiles = await Promise.all(
    plan.candidates.map((candidate) =>
      Promise.all([
        readPinnedBytes({
          ...candidate.archive,
          label: "release archive",
          maximumBytes: MAXIMUM_ARCHIVE_BYTES,
        }),
        readPinnedBytes({ ...candidate.publisherAttestation, label: "publisher attestation" }),
        readPinnedBytes({
          ...candidate.publisherTrustRoot,
          label: "publisher trust root",
          maximumBytes: MAXIMUM_TRUST_ROOT_BYTES,
        }),
      ]).then(([archive, attestation, trust]) => ({ archive, attestation, trust })),
    ),
  );
  const [supportMatrixFile, notarizationFile, liveEvidenceFiles, platformFiles] = await Promise.all(
    [
      readPinnedBytes({
        ...plan.supportMatrix.file,
        label: "support matrix",
        maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      }),
      readPinnedBytes({
        ...plan.notarizationReceipt.file,
        label: "macOS notarization receipt",
        maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      }),
      Promise.all(
        plan.liveEvidence.map(({ criterionId, file }) =>
          readPinnedBytes({
            ...file,
            label: `live evidence criterion ${String(criterionId)}`,
            maximumBytes: MAXIMUM_EVIDENCE_BYTES,
          }),
        ),
      ),
      Promise.all(
        plan.candidates.map((candidate) =>
          Promise.all(
            candidate.platformAuthenticity.verificationEvidence.map(({ file }) =>
              readPinnedBytes({
                ...file,
                label: "platform authenticity evidence",
                maximumBytes: MAXIMUM_EVIDENCE_BYTES,
              }),
            ),
          ),
        ),
      ),
    ],
  );
  for (let index = 0; index < currentPublisherFiles.length; index += 1) {
    const current = currentPublisherFiles[index];
    const original = loaded.publisherFiles[index];
    assertSamePinnedFile(current.archive, original.archive, "release archive");
    assertSamePinnedFile(current.attestation, original.attestation, "publisher attestation");
    assertSamePinnedFile(current.trust, original.trust, "publisher trust root");
  }
  assertSamePinnedFile(supportMatrixFile, loaded.supportMatrixFile, "support matrix");
  assertSamePinnedFile(notarizationFile, loaded.notarizationFile, "macOS notarization receipt");
  for (let index = 0; index < liveEvidenceFiles.length; index += 1) {
    assertSamePinnedFile(
      liveEvidenceFiles[index],
      loaded.liveEvidenceFiles[index].loaded,
      `live evidence criterion ${String(index + 1)}`,
    );
  }
  for (let candidateIndex = 0; candidateIndex < platformFiles.length; candidateIndex += 1) {
    for (
      let evidenceIndex = 0;
      evidenceIndex < platformFiles[candidateIndex].length;
      evidenceIndex += 1
    ) {
      assertSamePinnedFile(
        platformFiles[candidateIndex][evidenceIndex],
        loaded.platformFiles[candidateIndex][evidenceIndex].loaded,
        "platform authenticity evidence",
      );
    }
  }
  assertLoadedPromotionInputBoundaries({
    candidateRoots,
    loaded: {
      ...loaded,
      liveEvidenceFiles: liveEvidenceFiles.map((file) => ({ loaded: file })),
      notarizationFile,
      platformFiles: platformFiles.map((files) => files.map((file) => ({ loaded: file }))),
      publisherFiles: currentPublisherFiles,
      supportMatrixFile,
    },
    outputRoot,
    planFile: currentPlan,
    repositoryRoot,
  });
  for (let index = 0; index < plan.candidates.length; index += 1) {
    const candidate = plan.candidates[index];
    const verified = await integrity.verifyRelease({
      root: candidateRoots[index],
      expectedTarget: candidate.target,
      expectedManifestSha256: candidate.expectedManifestSha256,
      expectedCandidateDigest: candidate.expectedCandidateDigest,
      candidatePublisherEvidence: {
        archivePath: currentPublisherFiles[index].archive.path,
        attestationPath: currentPublisherFiles[index].attestation.path,
      },
      publisherTrust: { publicKeyPem: currentPublisherFiles[index].trust.bytes },
      policy: plan.revocations,
    });
    if (
      verified.archive.sha256 !== loaded.verifiedCandidates[index].archive.sha256 ||
      verified.publisherAttestationSha256 !==
        loaded.verifiedCandidates[index].publisherAttestationSha256
    ) {
      throw new Error("A promotion candidate changed during verification.");
    }
  }
}

function assertLoadedPromotionInputBoundaries({
  candidateRoots,
  loaded,
  outputRoot,
  planFile,
  repositoryRoot,
}) {
  const allFiles = [
    ...loaded.publisherFiles.flatMap(({ archive, attestation, trust }) => [
      archive,
      attestation,
      trust,
    ]),
    loaded.supportMatrixFile,
    loaded.notarizationFile,
    ...loaded.liveEvidenceFiles.map(({ loaded: file }) => file),
    ...loaded.platformFiles.flatMap((files) => files.map(({ loaded: file }) => file)),
  ];
  const prohibitedEvidenceRoots = [
    ...(outputRoot === undefined ? [] : [outputRoot]),
    ...candidateRoots,
  ];
  for (const file of allFiles) {
    if (prohibitedEvidenceRoots.length > 0) {
      assertPathOutsideRoots(file.path, prohibitedEvidenceRoots, "promotion evidence input");
    }
  }
  if (repositoryRoot !== undefined) {
    for (const { archive, attestation, trust } of loaded.publisherFiles) {
      for (const file of [archive, attestation, trust]) {
        assertPathOutsideRoots(file.path, [repositoryRoot], "external publisher authority");
      }
    }
  }
  const paths = [planFile.path, ...allFiles.map(({ path }) => path)].map(comparablePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Promotion inputs must remain canonically distinct.");
  }
}

function assertSamePinnedFile(current, original, label) {
  if (
    comparablePath(current.path) !== comparablePath(original.path) ||
    current.sha256 !== original.sha256 ||
    current.size !== original.size
  ) {
    throw new Error(`The pinned ${label} identity changed during release authorization.`);
  }
}

function parsePromotionPlan(value) {
  requireExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "releaseId",
      "channel",
      "issuedAt",
      "statementId",
      "source",
      "candidates",
      "supportMatrix",
      "notarizationReceipt",
      "liveEvidence",
      "revocations",
    ],
    "promotion plan",
  );
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    !EXTERNAL_ID_PATTERN.test(value.releaseId) ||
    !CHANNEL_PATTERN.test(value.channel) ||
    value.channel === "release-candidate" ||
    value.channel.includes("preview") ||
    !isRfc3339Instant(value.issuedAt) ||
    !EXTERNAL_ID_PATTERN.test(value.statementId)
  ) {
    throw new Error("The promotion plan identity is invalid.");
  }
  requireExactKeys(value.source, ["buildCommit"], "promotion source");
  if (!COMMIT_PATTERN.test(value.source.buildCommit)) {
    throw new Error("The promotion build commit is invalid.");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length !== 3) {
    throw new Error("The promotion plan requires the exact first-milestone target set.");
  }
  const candidates = value.candidates.map((candidate, index) =>
    parseCandidatePlan(candidate, FIRST_MILESTONE_TARGETS[index]),
  );
  const supportMatrix = parseEvidencePlan(value.supportMatrix, "support matrix");
  if (supportMatrix.statementPath !== "docs/release/SUPPORT_MATRIX.md") {
    throw new Error("The promotion support matrix path is invalid.");
  }
  const notarizationReceipt = parseEvidencePlan(
    value.notarizationReceipt,
    "macOS notarization receipt",
  );
  if (notarizationReceipt.statementPath !== "docs/release/evidence/macos-notarization.json") {
    throw new Error("The macOS notarization statement path is invalid.");
  }
  if (!Array.isArray(value.liveEvidence) || value.liveEvidence.length !== 36) {
    throw new Error("The promotion plan requires all 36 live-evidence criteria.");
  }
  const liveEvidence = value.liveEvidence.map((item, index) => {
    requireExactKeys(item, ["criterionId", "statementPath", "file"], "live evidence plan");
    if (item.criterionId !== index + 1) {
      throw new Error("The live-evidence criteria must be the exact ordered 1-36 set.");
    }
    assertPortableStatementPath(item.statementPath, "live evidence statement path");
    return Object.freeze({
      criterionId: item.criterionId,
      statementPath: item.statementPath,
      file: parsePinnedFile(item.file, "live evidence file"),
    });
  });
  const revocations = parseRevocations(value.revocations);
  assertDistinctPinnedInputPaths(candidates, supportMatrix, notarizationReceipt, liveEvidence);
  return Object.freeze({
    schemaVersion: 1,
    product: "OpenDelegate",
    releaseId: value.releaseId,
    channel: value.channel,
    issuedAt: value.issuedAt,
    statementId: value.statementId,
    source: Object.freeze({ buildCommit: value.source.buildCommit }),
    candidates: Object.freeze(candidates),
    supportMatrix,
    notarizationReceipt,
    liveEvidence: Object.freeze(liveEvidence),
    revocations,
  });
}

function parseCandidatePlan(value, expectedTarget) {
  requireExactKeys(
    value,
    [
      "target",
      "root",
      "expectedManifestSha256",
      "expectedCandidateDigest",
      "archive",
      "publisherAttestation",
      "publisherTrustRoot",
      "platformAuthenticity",
    ],
    "promotion candidate",
  );
  const target = parseTarget(value.target, "promotion candidate target");
  if (
    target.platform !== expectedTarget.platform ||
    target.architecture !== expectedTarget.architecture
  ) {
    throw new Error("The promotion plan requires the exact ordered first-milestone target set.");
  }
  if (typeof value.root !== "string" || !isAbsolute(value.root) || value.root.includes("\0")) {
    throw new Error("The promotion candidate root must be absolute.");
  }
  assertSha256(value.expectedManifestSha256, "expected manifest digest");
  assertSha256(value.expectedCandidateDigest, "expected candidate digest");
  const archive = parsePinnedFile(value.archive, "release archive");
  const publisherAttestation = parsePinnedFile(value.publisherAttestation, "publisher attestation");
  const publisherTrustRoot = parsePinnedFile(value.publisherTrustRoot, "publisher trust root");
  requireExactKeys(
    value.platformAuthenticity,
    ["recordSha256", "certificateIdentities", "productCertificateIdentity", "verificationEvidence"],
    "platform authenticity plan",
  );
  assertSha256(value.platformAuthenticity.recordSha256, "platform authenticity record digest");
  if (
    !Array.isArray(value.platformAuthenticity.certificateIdentities) ||
    value.platformAuthenticity.certificateIdentities.some(
      (identity) => typeof identity !== "string" || identity.length < 1 || identity.length > 512,
    ) ||
    new Set(value.platformAuthenticity.certificateIdentities).size !==
      value.platformAuthenticity.certificateIdentities.length
  ) {
    throw new Error("The platform certificate identity set is invalid.");
  }
  if (
    value.platformAuthenticity.productCertificateIdentity !== null &&
    (typeof value.platformAuthenticity.productCertificateIdentity !== "string" ||
      !value.platformAuthenticity.certificateIdentities.includes(
        value.platformAuthenticity.productCertificateIdentity,
      ))
  ) {
    throw new Error("The platform product certificate identity is invalid.");
  }
  if (
    !Array.isArray(value.platformAuthenticity.verificationEvidence) ||
    value.platformAuthenticity.verificationEvidence.length < 1
  ) {
    throw new Error("Platform authenticity requires pinned verification evidence.");
  }
  const verificationEvidence = value.platformAuthenticity.verificationEvidence.map((item) =>
    parseEvidencePlan(item, "platform authenticity evidence"),
  );
  assertStrictlySorted(
    verificationEvidence.map(({ statementPath }) => statementPath),
    "platform authenticity evidence paths",
  );
  return Object.freeze({
    target,
    root: resolve(value.root),
    expectedManifestSha256: value.expectedManifestSha256,
    expectedCandidateDigest: value.expectedCandidateDigest,
    archive,
    publisherAttestation,
    publisherTrustRoot,
    platformAuthenticity: Object.freeze({
      recordSha256: value.platformAuthenticity.recordSha256,
      certificateIdentities: Object.freeze([...value.platformAuthenticity.certificateIdentities]),
      productCertificateIdentity: value.platformAuthenticity.productCertificateIdentity,
      verificationEvidence: Object.freeze(verificationEvidence),
    }),
  });
}

function parseEvidencePlan(value, label) {
  requireExactKeys(value, ["statementPath", "file"], `${label} plan`);
  assertPortableStatementPath(value.statementPath, `${label} statement path`);
  return Object.freeze({
    statementPath: value.statementPath,
    file: parsePinnedFile(value.file, `${label} file`),
  });
}

function parsePinnedFile(value, label) {
  requireExactKeys(value, ["path", "sha256"], label);
  if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.includes("\0")) {
    throw new Error(`The ${label} path must be absolute.`);
  }
  assertSha256(value.sha256, `${label} pin`);
  return Object.freeze({ path: resolve(value.path), sha256: value.sha256 });
}

function parseRevocations(value) {
  requireExactKeys(
    value,
    [
      "revokedCertificateIdentities",
      "revokedObserverKeyIds",
      "revokedPromotionKeyIds",
      "revokedPublisherKeyIds",
      "revokedStatementIds",
    ],
    "promotion revocation policy",
  );
  const entries = {};
  for (const name of [
    "revokedCertificateIdentities",
    "revokedObserverKeyIds",
    "revokedPromotionKeyIds",
    "revokedPublisherKeyIds",
    "revokedStatementIds",
  ]) {
    if (
      !Array.isArray(value[name]) ||
      value[name].some(
        (entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 512,
      )
    ) {
      throw new Error(`The ${name} release revocation set is invalid.`);
    }
    assertStrictlySorted(value[name], `${name} release revocation set`);
    if (
      (name === "revokedObserverKeyIds" ||
        name === "revokedPromotionKeyIds" ||
        name === "revokedPublisherKeyIds") &&
      value[name].some((entry) => !KEY_ID_PATTERN.test(entry))
    ) {
      throw new Error(`The ${name} release revocation key is invalid.`);
    }
    entries[name] = Object.freeze([...value[name]]);
  }
  return Object.freeze(entries);
}

function assertPlanRevocations(revocations, releases, statementId) {
  if (revocations.revokedStatementIds.includes(statementId)) {
    throw new Error("The promotion statement is revoked by release policy.");
  }
  for (const release of releases) {
    if (revocations.revokedPublisherKeyIds.includes(release.publisherKeyId)) {
      throw new Error("A publisher trust root is revoked by release policy.");
    }
    if (
      release.candidate.platformCertificateIdentities.some((identity) =>
        revocations.revokedCertificateIdentities.includes(identity),
      )
    ) {
      throw new Error("A native signing identity is revoked by release policy.");
    }
  }
}

function assertDistinctPinnedInputPaths(candidates, supportMatrix, notarization, liveEvidence) {
  const paths = [
    supportMatrix.file.path,
    notarization.file.path,
    ...liveEvidence.map(({ file }) => file.path),
    ...candidates.flatMap((candidate) => [
      candidate.archive.path,
      candidate.publisherAttestation.path,
      candidate.publisherTrustRoot.path,
      ...candidate.platformAuthenticity.verificationEvidence.map(({ file }) => file.path),
    ]),
  ].map(comparablePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("The promotion plan contains duplicated pinned input paths.");
  }
}

function allPromotionPlanFiles(plan) {
  return [
    plan.supportMatrix.file,
    plan.notarizationReceipt.file,
    ...plan.liveEvidence.map(({ file }) => file),
    ...plan.candidates.flatMap((candidate) => [
      candidate.archive,
      candidate.publisherAttestation,
      candidate.publisherTrustRoot,
      ...candidate.platformAuthenticity.verificationEvidence.map(({ file }) => file),
    ]),
  ];
}

function assertPromotionPreparationPaths(input) {
  if (
    typeof input.repositoryRoot !== "string" ||
    !isAbsolute(input.repositoryRoot) ||
    typeof input.planPath !== "string" ||
    !isAbsolute(input.planPath)
  ) {
    throw new Error("Promotion repository and plan paths must be absolute.");
  }
  assertSha256(input.planSha256, "promotion plan pin");
  if (
    !Array.isArray(input.outputPaths) ||
    input.outputPaths.length !== 2 ||
    input.outputPaths.some((path) => typeof path !== "string" || !isAbsolute(path))
  ) {
    throw new Error("Promotion requires exactly two absolute output paths.");
  }
  assertDisjointPaths(input.outputPaths, "promotion output");
}

async function requireSharedOutputRoot(paths) {
  const parents = await Promise.all(
    paths.map((path) => requireCanonicalDirectory(dirname(path), "promotion output directory")),
  );
  const parent = parents[0];
  if (parents.some((value) => comparablePath(value) !== comparablePath(parent))) {
    throw new Error("Promotion outputs must share one canonical directory.");
  }
  return parent;
}

function assertCleanPromotionSource(source, buildCommit) {
  if (
    typeof source !== "object" ||
    source === null ||
    source.dirty !== false ||
    source.commit !== buildCommit ||
    !COMMIT_PATTERN.test(source.commit)
  ) {
    throw new Error("Promotion requires the clean committed build source B named by the plan.");
  }
}

function requireIntegrityBoundary(value) {
  for (const name of ["composePromotionStatement", "verifyRelease"]) {
    if (typeof value?.[name] !== "function") {
      throw new Error("The trusted release-integrity promotion boundary is unavailable.");
    }
  }
}

function parseTarget(value, label) {
  requireExactKeys(value, ["platform", "architecture"], label);
  if (
    !FIRST_MILESTONE_TARGETS.some(
      (target) => target.platform === value.platform && target.architecture === value.architecture,
    )
  ) {
    throw new Error(`The ${label} is not in the first-milestone target matrix.`);
  }
  return Object.freeze({ platform: value.platform, architecture: value.architecture });
}

function assertPortableStatementPath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`The ${label} is not a safe portable path.`);
  }
}

function assertStrictlySorted(values, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(values[index - 1], values[index]) >= 0) {
      throw new Error(`The ${label} must be strictly sorted and unique.`);
    }
  }
}

function assertDisjointCandidateRoots(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        isSameOrDescendant(roots[left], roots[right]) ||
        isSameOrDescendant(roots[right], roots[left])
      ) {
        throw new Error("Promotion candidate roots must be pairwise disjoint.");
      }
    }
  }
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRfc3339Instant(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
