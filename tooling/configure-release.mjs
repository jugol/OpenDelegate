import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertPinnedReleaseGitFilesMatchCommit,
  pinReleaseGitProvenance,
  readPinnedReleaseSourceIdentity,
  revalidatePinnedReleaseGitProvenance,
} from "./release-git-provenance.mjs";
import { hashPromotionReleaseLogic } from "./release-promotion-plan.mjs";
import {
  hashCurrentNodeExecutable,
  pinReleaseRunnerIdentity,
  revalidateReleaseRunnerIdentity,
} from "./release-runner-identity.mjs";
import {
  assertDisjointPaths,
  assertPathAbsent,
  assertPathOutsideRoots,
  assertSha256,
  digestBytes,
  isSameOrDescendant,
  publishNewDirectoryTree,
  readPinnedBytes,
  readPinnedCanonicalJson,
  requireCanonicalDirectory,
  requireCanonicalNewPath,
  requireExactKeys,
} from "./release-tooling-io.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUALIFIED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,255}$/u;
const MAXIMUM_PLAN_BYTES = 4 * 1024 * 1024;
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_ATTESTATION_BYTES = 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const currentFile = fileURLToPath(import.meta.url);
const moduleRepositoryRoot = resolve(dirname(currentFile), "..");

export function parseReleaseConfigurationArguments(values) {
  const arguments_ = values[0] === "--" ? values.slice(1) : values;
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { help: true };
  }
  const supported = new Set([
    "--repository",
    "--git-executable",
    "--git-executable-sha256",
    "--plan",
    "--plan-sha256",
    "--destination-root",
    "--runner-executable-sha256",
  ]);
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!supported.has(name) || value === undefined || value.startsWith("--") || parsed.has(name)) {
      throw new Error(`Invalid or duplicate release-configuration option: ${String(name)}.`);
    }
    parsed.set(name, value);
  }
  for (const name of supported) {
    if (!parsed.has(name)) {
      throw new Error(`${name} is required.`);
    }
  }
  for (const name of ["--repository", "--git-executable", "--plan", "--destination-root"]) {
    if (!isAbsolute(parsed.get(name)) || parsed.get(name).includes("\0")) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
  if (!SHA256_PATTERN.test(parsed.get("--plan-sha256"))) {
    throw new Error("--plan-sha256 must be a lowercase SHA-256 digest.");
  }
  if (!SHA256_PATTERN.test(parsed.get("--git-executable-sha256"))) {
    throw new Error("--git-executable-sha256 must be a lowercase SHA-256 digest.");
  }
  if (!SHA256_PATTERN.test(parsed.get("--runner-executable-sha256"))) {
    throw new Error("--runner-executable-sha256 must be a lowercase SHA-256 digest.");
  }
  return {
    destinationRoot: resolve(parsed.get("--destination-root")),
    gitExecutablePath: resolve(parsed.get("--git-executable")),
    gitExecutableSha256: parsed.get("--git-executable-sha256"),
    planPath: resolve(parsed.get("--plan")),
    planSha256: parsed.get("--plan-sha256"),
    repositoryRoot: resolve(parsed.get("--repository")),
    runnerExecutableSha256: parsed.get("--runner-executable-sha256"),
  };
}

export async function composeReleaseConfiguration(input, dependencies = {}) {
  validateConfigurationInput(input);
  const runnerIdentity = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: input.runnerExecutableSha256,
    hashRuntimeExecutable: dependencies.hashRuntimeExecutable ?? hashCurrentNodeExecutable,
    runner: dependencies.runner ?? {
      architecture: process.arch,
      nodeVersion: process.versions.node,
      platform: process.platform,
    },
  });
  const gitProvenance = await (dependencies.pinGitProvenance ?? pinReleaseGitProvenance)({
    expectedExecutableSha256: input.gitExecutableSha256,
    executablePath: input.gitExecutablePath,
    repositoryRoot: input.repositoryRoot,
  });
  const sourceReader =
    dependencies.readSourceIdentity ?? (() => readPinnedReleaseSourceIdentity(gitProvenance));
  const revalidateGit =
    dependencies.revalidateGitProvenance ?? revalidatePinnedReleaseGitProvenance;
  const assertGitFiles =
    dependencies.assertGitFilesMatchCommit ?? assertPinnedReleaseGitFilesMatchCommit;
  const [destinationRoot, repositoryRoot] = await Promise.all([
    requireCanonicalNewPath(input.destinationRoot, "release configuration destination"),
    requireCanonicalDirectory(input.repositoryRoot, "release repository"),
  ]);
  await assertPathAbsent(destinationRoot, "The release configuration output");
  const runningRepositoryRoot = await requireCanonicalDirectory(
    dependencies.runningRepositoryRoot ?? moduleRepositoryRoot,
    "running release-tool repository",
  );
  if (comparablePath(repositoryRoot) !== comparablePath(runningRepositoryRoot)) {
    throw new Error(
      "Release configuration must execute from the exact clean repository named by the runner.",
    );
  }
  const destinationParent = await requireCanonicalDirectory(
    dirname(destinationRoot),
    "release configuration output parent",
  );
  if (comparablePath(destinationParent) !== comparablePath(dirname(destinationRoot))) {
    throw new Error("The release configuration output parent must not be linked.");
  }
  const planFile = await readPinnedCanonicalJson({
    label: "release configuration plan",
    maximumBytes: MAXIMUM_PLAN_BYTES,
    path: input.planPath,
    sha256: input.planSha256,
  });
  const plan = parseConfigurationPlan(planFile.value);
  const candidateRoot = await requireCanonicalDirectory(
    plan.candidate.root,
    "release candidate root",
  );
  assertPathOutsideRoots(
    planFile.path,
    [repositoryRoot, candidateRoot],
    "release configuration plan",
  );
  assertPathOutsideRoots(
    destinationRoot,
    [repositoryRoot, candidateRoot, dirname(planFile.path)],
    "release configuration output",
  );
  if (isSameOrDescendant(destinationRoot, candidateRoot)) {
    throw new Error("The release configuration output cannot contain the candidate.");
  }

  const logicHasher = dependencies.hashReleaseLogic ?? hashPromotionReleaseLogic;
  const sourceBefore = await sourceReader(repositoryRoot);
  assertCleanConfigurationSource(sourceBefore, plan.source.buildCommit);
  const releaseLogic = await logicHasher(runningRepositoryRoot);
  await assertGitFiles(
    gitProvenance,
    releaseLogic.map(({ path }) => path),
  );
  await revalidateGit(gitProvenance);
  const integrity =
    dependencies.integrity ?? (await import("../packages/release-integrity/src/index.ts"));
  requireConfigurationIntegrityBoundary(integrity);
  const loaded = await loadConfigurationInputs(plan, {
    candidateRoot,
    repositoryRoot,
  });
  const verified = await verifyConfigurationSource(integrity, plan, loaded, candidateRoot);
  await revalidateReleaseRunnerIdentity(runnerIdentity);
  const prepared = createConfigurationTree({
    integrity,
    loaded,
    plan,
    planSha256: planFile.sha256,
    releaseLogic,
    recordedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    runnerIdentity,
    gitProvenance,
    verified,
  });

  const revalidate = async () => {
    const source = await sourceReader(repositoryRoot);
    assertCleanConfigurationSource(source, plan.source.buildCommit);
    if (JSON.stringify(await logicHasher(runningRepositoryRoot)) !== JSON.stringify(releaseLogic)) {
      throw new Error("The committed release-configuration logic changed during composition.");
    }
    await assertGitFiles(
      gitProvenance,
      releaseLogic.map(({ path }) => path),
    );
    await revalidateGit(gitProvenance);
    await revalidateConfigurationInputs(planFile, plan, loaded);
    await revalidateReleaseRunnerIdentity(runnerIdentity);
  };
  await revalidate();
  const expectedStatus = plan.mode === "released" ? "released" : "publisher-verified";
  const verifyTree = async (stateRoot) => {
    const resolution = await integrity.resolveConfiguredRelease({
      root: candidateRoot,
      expectedTarget: plan.candidate.target,
      expectedManifestSha256: plan.candidate.expectedManifestSha256,
      stateRoot,
    });
    if (
      resolution.external.status !== expectedStatus ||
      resolution.effectiveChannel !== (plan.mode === "released" ? "released" : "release-candidate")
    ) {
      throw new Error(
        `The composed release authority did not resolve as the required ${expectedStatus} configuration.`,
      );
    }
    return resolution;
  };

  const published = await (dependencies.publishDirectory ?? publishNewDirectoryTree)(
    destinationRoot,
    prepared.entries,
    {
      async verifyStaged(stagingRoot) {
        await verifyTree(stagingRoot);
        await revalidate();
      },
      async verifyPublished(destinationRoot) {
        await verifyTree(destinationRoot);
        await revalidate();
        await dependencies.verifyPublished?.(destinationRoot);
      },
    },
  );
  const configurationPath = join(published.path, ...prepared.configurationRelativePath.split("/"));
  const runnerRecordPath = join(published.path, prepared.runnerRecordRelativePath);
  return Object.freeze({
    configuration: Object.freeze({
      path: configurationPath,
      sha256: prepared.configurationSha256,
    }),
    destinationRoot: published.path,
    effectiveChannel: plan.mode === "released" ? "released" : "release-candidate",
    externalStatus: expectedStatus,
    runnerRecord: Object.freeze({
      path: runnerRecordPath,
      sha256: prepared.runnerRecordSha256,
    }),
    target: plan.candidate.target,
  });
}

async function loadConfigurationInputs(plan, roots) {
  for (const file of allPinnedPlanFiles(plan)) {
    assertPathOutsideRoots(file.path, [roots.candidateRoot], "release authority input");
  }
  for (const file of [
    plan.candidate.archive,
    plan.candidate.publisherAttestation,
    plan.candidate.publisherTrustRoot,
    ...(plan.promotion === null
      ? []
      : [
          plan.promotion.promotionAttestation,
          plan.promotion.supportedChannelReceipt,
          plan.promotion.promotionTrustRoot,
          plan.promotion.observerTrustRoot,
          ...plan.promotion.readBackObservations.map(({ envelope }) => envelope),
        ]),
  ]) {
    assertPathOutsideRoots(
      file.path,
      [roots.repositoryRoot, roots.candidateRoot],
      "external release authority",
    );
  }
  const candidate = {
    archive: await readPinnedBytes({
      ...plan.candidate.archive,
      label: "release archive",
      maximumBytes: MAXIMUM_ARCHIVE_BYTES,
    }),
    publisherAttestation: await readPinnedBytes({
      ...plan.candidate.publisherAttestation,
      label: "publisher attestation",
      maximumBytes: MAXIMUM_ATTESTATION_BYTES,
    }),
    publisherTrustRoot: await readPinnedBytes({
      ...plan.candidate.publisherTrustRoot,
      label: "publisher trust root",
      maximumBytes: MAXIMUM_KEY_BYTES,
    }),
  };
  let promotion = null;
  if (plan.promotion !== null) {
    promotion = {
      promotionAttestation: await readPinnedBytes({
        ...plan.promotion.promotionAttestation,
        label: "promotion attestation",
        maximumBytes: MAXIMUM_ATTESTATION_BYTES,
      }),
      supportedChannelReceipt: await readPinnedBytes({
        ...plan.promotion.supportedChannelReceipt,
        label: "supported-channel receipt",
        maximumBytes: MAXIMUM_ATTESTATION_BYTES,
      }),
      promotionTrustRoot: await readPinnedBytes({
        ...plan.promotion.promotionTrustRoot,
        label: "promotion trust root",
        maximumBytes: MAXIMUM_KEY_BYTES,
      }),
      observerTrustRoot: await readPinnedBytes({
        ...plan.promotion.observerTrustRoot,
        label: "remote read-back observer trust root",
        maximumBytes: MAXIMUM_KEY_BYTES,
      }),
      readBackObservations: await Promise.all(
        plan.promotion.readBackObservations.map(({ target, envelope }) =>
          readPinnedBytes({
            ...envelope,
            label: `remote read-back observation ${target.platform}-${target.architecture}`,
            maximumBytes: MAXIMUM_ATTESTATION_BYTES,
          }),
        ),
      ),
      supportMatrix: await readPinnedBytes({
        ...plan.promotion.supportMatrix.file,
        label: "support matrix",
        maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      }),
      notarizationReceipt: await readPinnedBytes({
        ...plan.promotion.notarizationReceipt.file,
        label: "macOS notarization receipt",
        maximumBytes: MAXIMUM_ATTESTATION_BYTES,
      }),
      liveEvidence: await Promise.all(
        plan.promotion.liveEvidence.map(({ criterionId, file }) =>
          readPinnedBytes({
            ...file,
            label: `live evidence criterion ${String(criterionId)}`,
            maximumBytes: MAXIMUM_EVIDENCE_BYTES,
          }),
        ),
      ),
    };
  }
  const canonicalPaths = [
    candidate.archive.path,
    candidate.publisherAttestation.path,
    candidate.publisherTrustRoot.path,
    ...(promotion === null
      ? []
      : [
          promotion.promotionAttestation.path,
          promotion.supportedChannelReceipt.path,
          promotion.promotionTrustRoot.path,
          promotion.observerTrustRoot.path,
          ...promotion.readBackObservations.map(({ path }) => path),
          promotion.supportMatrix.path,
          promotion.notarizationReceipt.path,
          ...promotion.liveEvidence.map(({ path }) => path),
        ]),
  ].map(comparablePath);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    throw new Error("Release configuration inputs overlap or alias one another.");
  }
  assertConfigurationInputBoundaries({ candidate, promotion }, roots);
  return Object.freeze({ candidate: Object.freeze(candidate), promotion });
}

function assertConfigurationInputBoundaries(loaded, roots) {
  const allFiles = [
    loaded.candidate.archive,
    loaded.candidate.publisherAttestation,
    loaded.candidate.publisherTrustRoot,
    ...(loaded.promotion === null
      ? []
      : [
          loaded.promotion.promotionAttestation,
          loaded.promotion.supportedChannelReceipt,
          loaded.promotion.promotionTrustRoot,
          loaded.promotion.observerTrustRoot,
          ...loaded.promotion.readBackObservations,
          loaded.promotion.supportMatrix,
          loaded.promotion.notarizationReceipt,
          ...loaded.promotion.liveEvidence,
        ]),
  ];
  for (const file of allFiles) {
    assertPathOutsideRoots(file.path, [roots.candidateRoot], "release authority input");
  }
  const authorityFiles = [
    loaded.candidate.archive,
    loaded.candidate.publisherAttestation,
    loaded.candidate.publisherTrustRoot,
    ...(loaded.promotion === null
      ? []
      : [
          loaded.promotion.promotionAttestation,
          loaded.promotion.supportedChannelReceipt,
          loaded.promotion.promotionTrustRoot,
          loaded.promotion.observerTrustRoot,
          ...loaded.promotion.readBackObservations,
        ]),
  ];
  for (const file of authorityFiles) {
    assertPathOutsideRoots(
      file.path,
      [roots.repositoryRoot, roots.candidateRoot],
      "external release authority",
    );
  }
}

async function verifyConfigurationSource(integrity, plan, loaded, candidateRoot) {
  const base = {
    root: candidateRoot,
    expectedTarget: plan.candidate.target,
    expectedManifestSha256: plan.candidate.expectedManifestSha256,
    expectedCandidateDigest: plan.candidate.expectedCandidateDigest,
    candidatePublisherEvidence: {
      archivePath: loaded.candidate.archive.path,
      attestationPath: loaded.candidate.publisherAttestation.path,
    },
    publisherTrust: { publicKeyPem: loaded.candidate.publisherTrustRoot.bytes },
    policy: plan.policy,
  };
  const verified =
    plan.promotion === null
      ? await integrity.verifyRelease(base)
      : await integrity.verifyRelease({
          ...base,
          promotionAttestation: {
            attestationPath: loaded.promotion.promotionAttestation.path,
            liveEvidence: plan.promotion.liveEvidence.map((evidence, index) => ({
              criterionId: evidence.criterionId,
              path: evidence.statementPath,
              bytes: loaded.promotion.liveEvidence[index].bytes,
            })),
            notarizationReceiptPath: loaded.promotion.notarizationReceipt.path,
            supportMatrix: {
              path: plan.promotion.supportMatrix.statementPath,
              bytes: loaded.promotion.supportMatrix.bytes,
            },
          },
          promotionReceipt: {
            observerTrust: {
              publicKeyPem: loaded.promotion.observerTrustRoot.bytes,
            },
            readBackObservations: plan.promotion.readBackObservations.map(({ target }, index) => ({
              envelopePath: loaded.promotion.readBackObservations[index].path,
              target,
            })),
            receiptPath: loaded.promotion.supportedChannelReceipt.path,
          },
          promotionTrust: {
            publicKeyPem: loaded.promotion.promotionTrustRoot.bytes,
          },
        });
  if (
    (plan.mode === "publisher-only" && verified.effectiveChannel !== "release-candidate") ||
    (plan.mode === "released" && verified.effectiveChannel !== "released")
  ) {
    throw new Error(`The inputs do not satisfy the required ${plan.mode} configuration mode.`);
  }
  return verified;
}

function createConfigurationTree({
  gitProvenance,
  integrity,
  loaded,
  plan,
  planSha256,
  releaseLogic,
  recordedAt,
  runnerIdentity,
  verified,
}) {
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("The release-configuration runner time is invalid.");
  }
  const virtualRoot = resolve(moduleRepositoryRoot, ".opendelegate-configuration-layout");
  const configurationAbsolutePath = integrity.externalReleaseVerificationPath({
    stateRoot: virtualRoot,
    productVersion: verified.candidate.productVersion,
    target: verified.candidate.target,
    checksumManifestSha256: verified.candidate.checksumManifestSha256,
  });
  const configurationRelativePath = portableRelative(virtualRoot, configurationAbsolutePath);
  const configurationDirectory = posix.dirname(configurationRelativePath);
  if (!configurationDirectory.startsWith("trust/releases/")) {
    throw new Error("The trusted resolver produced an unexpected configuration layout.");
  }
  const materialRoot = `${configurationDirectory}/files`;
  const materialTrustRoot = materialRoot.slice("trust/".length);
  const archiveOutputPath = `${materialRoot}/candidate/${verified.archive.path}`;
  const publisherAttestationOutputPath = `${materialRoot}/candidate/publisher-attestation.json`;
  const publisherTrustOutputPath = `${materialRoot}/candidate/publisher-public.pem`;
  const configuration = {
    schemaVersion: 1,
    product: "OpenDelegate",
    target: verified.candidate.target,
    candidate: {
      expectedManifestSha256: verified.candidate.checksumManifestSha256,
      expectedCandidateDigest: verified.candidate.publisherStatement.sha256,
      archiveFile: archiveOutputPath.slice("trust/".length),
      publisherAttestationFile: publisherAttestationOutputPath.slice("trust/".length),
      publisherTrustRootFile: publisherTrustOutputPath.slice("trust/".length),
    },
    promotion:
      plan.promotion === null
        ? null
        : {
            promotionAttestationFile: `${materialTrustRoot}/promotion/promotion-attestation.json`,
            supportedChannelReceiptFile: `${materialTrustRoot}/promotion/supported-channel-receipt.json`,
            promotionTrustRootFile: `${materialTrustRoot}/promotion/promotion-public.pem`,
            observerTrustRootFile: `${materialTrustRoot}/promotion/observer-public.pem`,
            readBackObservations: plan.promotion.readBackObservations.map(({ target }) => ({
              target,
              file:
                `${materialTrustRoot}/promotion/read-back/` +
                `${target.platform}-${target.architecture}.json`,
            })),
            supportMatrix: {
              statementPath: plan.promotion.supportMatrix.statementPath,
              file: `${materialTrustRoot}/promotion/support-matrix.md`,
            },
            notarizationReceiptFile: `${materialTrustRoot}/promotion/macos-notarization.json`,
            liveEvidence: plan.promotion.liveEvidence.map((evidence) => ({
              criterionId: evidence.criterionId,
              statementPath: evidence.statementPath,
              file: `${materialTrustRoot}/promotion/live/${String(evidence.criterionId).padStart(2, "0")}.json`,
            })),
          },
    policy: plan.policy,
  };
  const configurationBytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`, "utf8");
  const materialEntries = [
    {
      path: archiveOutputPath,
      bytes: loaded.candidate.archive.bytes,
      mode: 0o644,
      role: "release-archive",
    },
    {
      path: publisherAttestationOutputPath,
      bytes: loaded.candidate.publisherAttestation.bytes,
      mode: 0o644,
      role: "publisher-attestation",
    },
    {
      path: publisherTrustOutputPath,
      bytes: loaded.candidate.publisherTrustRoot.bytes,
      mode: 0o644,
      role: "publisher-trust-root",
    },
  ];
  if (plan.promotion !== null) {
    materialEntries.push(
      {
        path: `${materialRoot}/promotion/promotion-attestation.json`,
        bytes: loaded.promotion.promotionAttestation.bytes,
        mode: 0o644,
        role: "promotion-attestation",
      },
      {
        path: `${materialRoot}/promotion/supported-channel-receipt.json`,
        bytes: loaded.promotion.supportedChannelReceipt.bytes,
        mode: 0o644,
        role: "supported-channel-receipt",
      },
      {
        path: `${materialRoot}/promotion/promotion-public.pem`,
        bytes: loaded.promotion.promotionTrustRoot.bytes,
        mode: 0o644,
        role: "promotion-trust-root",
      },
      {
        path: `${materialRoot}/promotion/observer-public.pem`,
        bytes: loaded.promotion.observerTrustRoot.bytes,
        mode: 0o644,
        role: "read-back-observer-trust-root",
      },
      ...loaded.promotion.readBackObservations.map((file, index) => {
        const target = plan.promotion.readBackObservations[index].target;
        return {
          path:
            `${materialRoot}/promotion/read-back/` +
            `${target.platform}-${target.architecture}.json`,
          bytes: file.bytes,
          mode: 0o644,
          role: `read-back-observation-${target.platform}-${target.architecture}`,
        };
      }),
      {
        path: `${materialRoot}/promotion/support-matrix.md`,
        bytes: loaded.promotion.supportMatrix.bytes,
        mode: 0o644,
        role: "support-matrix",
      },
      {
        path: `${materialRoot}/promotion/macos-notarization.json`,
        bytes: loaded.promotion.notarizationReceipt.bytes,
        mode: 0o644,
        role: "macos-notarization",
      },
      ...loaded.promotion.liveEvidence.map((file, index) => ({
        path: `${materialRoot}/promotion/live/${String(index + 1).padStart(2, "0")}.json`,
        bytes: file.bytes,
        mode: 0o644,
        role: `live-evidence-${String(index + 1).padStart(2, "0")}`,
      })),
    );
  }
  const runnerRecordRelativePath = "release-configuration-runner.json";
  const runnerRecord = {
    schemaVersion: 1,
    product: "OpenDelegate",
    operation: "release-authority-configuration",
    mode: plan.mode,
    recordedAt,
    source: {
      buildCommit: plan.source.buildCommit,
      releaseLogic,
    },
    inputs: {
      planSha256,
      target: verified.candidate.target,
      candidateDigest: verified.candidate.publisherStatement.sha256,
      checksumManifestSha256: verified.candidate.checksumManifestSha256,
      archiveSha256: verified.archive.sha256,
      publisherAttestationSha256: verified.publisherAttestationSha256,
      publisherKeyId: verified.publisherKeyId,
      policySha256: digestBytes(Buffer.from(`${JSON.stringify(plan.policy)}\n`, "utf8")),
      ...(plan.mode === "released"
        ? {
            promotionStatementId: verified.promotionStatementId,
            receiptId: verified.receiptId,
          }
        : {}),
    },
    runner: {
      platform: runnerIdentity.description.platform,
      architecture: runnerIdentity.description.architecture,
      nodeVersion: runnerIdentity.description.nodeVersion,
      runtimeExecutableSha256: runnerIdentity.description.runtimeExecutableSha256,
      gitExecutableSha256: gitProvenance.description.gitExecutableSha256,
    },
    outputs: {
      configuration: {
        relativePath: configurationRelativePath,
        sha256: digestBytes(configurationBytes),
      },
      materials: materialEntries.map(({ bytes, role }) => ({
        role,
        sha256: digestBytes(bytes),
      })),
    },
  };
  const runnerRecordBytes = Buffer.from(`${JSON.stringify(runnerRecord, null, 2)}\n`, "utf8");
  return Object.freeze({
    configurationRelativePath,
    configurationSha256: digestBytes(configurationBytes),
    entries: Object.freeze([
      ...materialEntries.map(({ path, bytes, mode }) => ({ path, bytes, mode })),
      {
        path: configurationRelativePath,
        bytes: configurationBytes,
        mode: 0o644,
      },
      {
        path: runnerRecordRelativePath,
        bytes: runnerRecordBytes,
        mode: 0o644,
      },
    ]),
    runnerRecordRelativePath,
    runnerRecordSha256: digestBytes(runnerRecordBytes),
  });
}

async function revalidateConfigurationInputs(planFile, plan, loaded) {
  const currentPlan = await readPinnedCanonicalJson({
    label: "release configuration plan",
    maximumBytes: MAXIMUM_PLAN_BYTES,
    path: planFile.path,
    sha256: planFile.sha256,
  });
  if (
    currentPlan.sha256 !== planFile.sha256 ||
    currentPlan.size !== planFile.size ||
    comparablePath(currentPlan.path) !== comparablePath(planFile.path)
  ) {
    throw new Error("The release configuration plan identity changed during composition.");
  }
  const expectations = [
    [plan.candidate.archive, loaded.candidate.archive, "release archive", MAXIMUM_ARCHIVE_BYTES],
    [
      plan.candidate.publisherAttestation,
      loaded.candidate.publisherAttestation,
      "publisher attestation",
      MAXIMUM_ATTESTATION_BYTES,
    ],
    [
      plan.candidate.publisherTrustRoot,
      loaded.candidate.publisherTrustRoot,
      "publisher trust root",
      MAXIMUM_KEY_BYTES,
    ],
  ];
  if (plan.promotion !== null) {
    expectations.push(
      [
        plan.promotion.promotionAttestation,
        loaded.promotion.promotionAttestation,
        "promotion attestation",
        MAXIMUM_ATTESTATION_BYTES,
      ],
      [
        plan.promotion.supportedChannelReceipt,
        loaded.promotion.supportedChannelReceipt,
        "supported-channel receipt",
        MAXIMUM_ATTESTATION_BYTES,
      ],
      [
        plan.promotion.promotionTrustRoot,
        loaded.promotion.promotionTrustRoot,
        "promotion trust root",
        MAXIMUM_KEY_BYTES,
      ],
      [
        plan.promotion.observerTrustRoot,
        loaded.promotion.observerTrustRoot,
        "remote read-back observer trust root",
        MAXIMUM_KEY_BYTES,
      ],
      ...plan.promotion.readBackObservations.map((observation, index) => [
        observation.envelope,
        loaded.promotion.readBackObservations[index],
        `remote read-back observation ${observation.target.platform}-${observation.target.architecture}`,
        MAXIMUM_ATTESTATION_BYTES,
      ]),
      [
        plan.promotion.supportMatrix.file,
        loaded.promotion.supportMatrix,
        "support matrix",
        MAXIMUM_EVIDENCE_BYTES,
      ],
      [
        plan.promotion.notarizationReceipt.file,
        loaded.promotion.notarizationReceipt,
        "macOS notarization receipt",
        MAXIMUM_ATTESTATION_BYTES,
      ],
      ...plan.promotion.liveEvidence.map((evidence, index) => [
        evidence.file,
        loaded.promotion.liveEvidence[index],
        `live evidence criterion ${String(evidence.criterionId)}`,
        MAXIMUM_EVIDENCE_BYTES,
      ]),
    );
  }
  await Promise.all(
    expectations.map(async ([descriptor, original, label, maximumBytes]) => {
      const current = await readPinnedBytes({ ...descriptor, label, maximumBytes });
      if (
        current.sha256 !== original.sha256 ||
        current.size !== original.size ||
        comparablePath(current.path) !== comparablePath(original.path)
      ) {
        throw new Error("A release configuration input changed during composition.");
      }
    }),
  );
}

function parseConfigurationPlan(value) {
  requireExactKeys(
    value,
    ["schemaVersion", "product", "mode", "source", "candidate", "promotion", "policy"],
    "release configuration plan",
  );
  if (
    value.schemaVersion !== 1 ||
    value.product !== "OpenDelegate" ||
    (value.mode !== "publisher-only" && value.mode !== "released")
  ) {
    throw new Error("The release configuration plan identity or mode is invalid.");
  }
  requireExactKeys(value.source, ["buildCommit"], "release configuration source");
  if (!COMMIT_PATTERN.test(value.source.buildCommit)) {
    throw new Error("The release configuration build commit is invalid.");
  }
  const candidate = parseCandidate(value.candidate);
  const promotion = value.promotion === null ? null : parsePromotion(value.promotion);
  if (
    (value.mode === "publisher-only" && promotion !== null) ||
    (value.mode === "released" && promotion === null)
  ) {
    throw new Error("The release configuration mode and promotion inputs disagree.");
  }
  const policy = parsePolicy(value.policy);
  const plan = Object.freeze({
    schemaVersion: 1,
    product: "OpenDelegate",
    mode: value.mode,
    source: Object.freeze({ buildCommit: value.source.buildCommit }),
    candidate,
    promotion,
    policy,
  });
  const paths = allPinnedPlanFiles(plan).map(({ path }) => comparablePath(path));
  if (new Set(paths).size !== paths.length) {
    throw new Error("Release configuration plan file paths must be distinct.");
  }
  return plan;
}

function parseCandidate(value) {
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
    ],
    "release configuration candidate",
  );
  const target = parseTarget(value.target);
  if (typeof value.root !== "string" || !isAbsolute(value.root) || value.root.includes("\0")) {
    throw new Error("The release configuration candidate root must be absolute.");
  }
  assertSha256(value.expectedManifestSha256, "expected manifest digest");
  assertSha256(value.expectedCandidateDigest, "expected candidate digest");
  return Object.freeze({
    target,
    root: resolve(value.root),
    expectedManifestSha256: value.expectedManifestSha256,
    expectedCandidateDigest: value.expectedCandidateDigest,
    archive: parsePinnedFile(value.archive, "release archive"),
    publisherAttestation: parsePinnedFile(value.publisherAttestation, "publisher attestation"),
    publisherTrustRoot: parsePinnedFile(value.publisherTrustRoot, "publisher trust root"),
  });
}

function parsePromotion(value) {
  requireExactKeys(
    value,
    [
      "promotionAttestation",
      "supportedChannelReceipt",
      "promotionTrustRoot",
      "observerTrustRoot",
      "readBackObservations",
      "supportMatrix",
      "notarizationReceipt",
      "liveEvidence",
    ],
    "release configuration promotion",
  );
  const supportMatrix = parseEvidence(value.supportMatrix, "support matrix");
  if (supportMatrix.statementPath !== "docs/release/SUPPORT_MATRIX.md") {
    throw new Error("The release configuration support matrix path is invalid.");
  }
  const notarizationReceipt = parseEvidence(
    value.notarizationReceipt,
    "macOS notarization receipt",
  );
  if (notarizationReceipt.statementPath !== "docs/release/evidence/macos-notarization.json") {
    throw new Error("The release configuration notarization path is invalid.");
  }
  if (!Array.isArray(value.liveEvidence) || value.liveEvidence.length !== 36) {
    throw new Error("Released configuration requires all 36 live-evidence criteria.");
  }
  if (!Array.isArray(value.readBackObservations) || value.readBackObservations.length !== 3) {
    throw new Error("Released configuration requires the exact three-target read-back set.");
  }
  const expectedReadBackTargets = ["darwin-arm64", "linux-x64", "win32-x64"];
  const readBackObservations = value.readBackObservations.map((observation, index) => {
    requireExactKeys(
      observation,
      ["target", "envelope"],
      "release configuration read-back observation",
    );
    const target = parseTarget(observation.target);
    if (`${target.platform}-${target.architecture}` !== expectedReadBackTargets[index]) {
      throw new Error(
        "Release configuration read-back observations must be the exact ordered target set.",
      );
    }
    return Object.freeze({
      target,
      envelope: parsePinnedFile(
        observation.envelope,
        `read-back observation ${target.platform}-${target.architecture}`,
      ),
    });
  });
  const liveEvidence = value.liveEvidence.map((evidence, index) => {
    requireExactKeys(
      evidence,
      ["criterionId", "statementPath", "file"],
      "release configuration live evidence",
    );
    if (evidence.criterionId !== index + 1) {
      throw new Error("Release configuration live evidence must be the ordered 1-36 set.");
    }
    assertPortablePath(evidence.statementPath, "live evidence statement path");
    return Object.freeze({
      criterionId: evidence.criterionId,
      statementPath: evidence.statementPath,
      file: parsePinnedFile(evidence.file, "live evidence file"),
    });
  });
  return Object.freeze({
    promotionAttestation: parsePinnedFile(value.promotionAttestation, "promotion attestation"),
    supportedChannelReceipt: parsePinnedFile(
      value.supportedChannelReceipt,
      "supported-channel receipt",
    ),
    promotionTrustRoot: parsePinnedFile(value.promotionTrustRoot, "promotion trust root"),
    observerTrustRoot: parsePinnedFile(
      value.observerTrustRoot,
      "remote read-back observer trust root",
    ),
    readBackObservations: Object.freeze(readBackObservations),
    supportMatrix,
    notarizationReceipt,
    liveEvidence: Object.freeze(liveEvidence),
  });
}

function parseEvidence(value, label) {
  requireExactKeys(value, ["statementPath", "file"], `${label} evidence`);
  assertPortablePath(value.statementPath, `${label} statement path`);
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

function parsePolicy(value) {
  requireExactKeys(
    value,
    [
      "revokedCertificateIdentities",
      "revokedObserverKeyIds",
      "revokedPromotionKeyIds",
      "revokedPublisherKeyIds",
      "revokedStatementIds",
    ],
    "release configuration policy",
  );
  const output = {};
  for (const name of [
    "revokedCertificateIdentities",
    "revokedObserverKeyIds",
    "revokedPromotionKeyIds",
    "revokedPublisherKeyIds",
    "revokedStatementIds",
  ]) {
    const entries = value[name];
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 512)
    ) {
      throw new Error(`The ${name} release configuration policy is invalid.`);
    }
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1] >= entries[index]) {
        throw new Error(`The ${name} release configuration policy must be sorted and unique.`);
      }
    }
    if (
      (name === "revokedObserverKeyIds" ||
        name === "revokedPromotionKeyIds" ||
        name === "revokedPublisherKeyIds") &&
      entries.some((entry) => !QUALIFIED_SHA256_PATTERN.test(entry))
    ) {
      throw new Error(`The ${name} release configuration key is invalid.`);
    }
    if (
      name === "revokedStatementIds" &&
      entries.some((entry) => !EXTERNAL_ID_PATTERN.test(entry))
    ) {
      throw new Error(`The ${name} release configuration statement is invalid.`);
    }
    output[name] = Object.freeze([...entries]);
  }
  return Object.freeze(output);
}

function parseTarget(value) {
  requireExactKeys(value, ["platform", "architecture"], "release configuration target");
  if (!(
    (value.platform === "darwin" && value.architecture === "arm64") ||
    (value.platform === "linux" && value.architecture === "x64") ||
    (value.platform === "win32" && value.architecture === "x64")
  )) {
    throw new Error("The release configuration target is unsupported.");
  }
  return Object.freeze({ platform: value.platform, architecture: value.architecture });
}

function allPinnedPlanFiles(plan) {
  return [
    plan.candidate.archive,
    plan.candidate.publisherAttestation,
    plan.candidate.publisherTrustRoot,
    ...(plan.promotion === null
      ? []
      : [
          plan.promotion.promotionAttestation,
          plan.promotion.supportedChannelReceipt,
          plan.promotion.promotionTrustRoot,
          plan.promotion.observerTrustRoot,
          ...plan.promotion.readBackObservations.map(({ envelope }) => envelope),
          plan.promotion.supportMatrix.file,
          plan.promotion.notarizationReceipt.file,
          ...plan.promotion.liveEvidence.map(({ file }) => file),
        ]),
  ];
}

function validateConfigurationInput(input) {
  requireExactKeys(
    input,
    [
      "destinationRoot",
      "gitExecutablePath",
      "gitExecutableSha256",
      "planPath",
      "planSha256",
      "repositoryRoot",
      "runnerExecutableSha256",
    ],
    "release configuration input",
  );
  for (const [value, label] of [
    [input.destinationRoot, "release configuration destination"],
    [input.gitExecutablePath, "Git executable"],
    [input.planPath, "release configuration plan"],
    [input.repositoryRoot, "release repository"],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new Error(`The ${label} path must be absolute.`);
    }
  }
  assertSha256(input.gitExecutableSha256, "Git executable");
  if (typeof input.planSha256 !== "string" || !SHA256_PATTERN.test(input.planSha256)) {
    throw new Error("The release configuration plan must have a lowercase SHA-256 pin.");
  }
  assertSha256(input.runnerExecutableSha256, "release-runner executable");
  assertDisjointPaths(
    [input.destinationRoot, input.planPath, input.repositoryRoot],
    "release configuration",
  );
}

function assertCleanConfigurationSource(source, expectedCommit) {
  if (
    typeof source !== "object" ||
    source === null ||
    source.dirty !== false ||
    source.commit !== expectedCommit ||
    !COMMIT_PATTERN.test(source.commit)
  ) {
    throw new Error(
      "Release configuration requires the clean committed build source B named by the plan.",
    );
  }
}

function requireConfigurationIntegrityBoundary(value) {
  for (const name of [
    "externalReleaseVerificationPath",
    "resolveConfiguredRelease",
    "verifyRelease",
  ]) {
    if (typeof value?.[name] !== "function") {
      throw new Error("The trusted configured-release verification boundary is unavailable.");
    }
  }
}

function assertPortablePath(value, label) {
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

function portableRelative(root, path) {
  const output = relative(root, path).replaceAll("\\", "/");
  assertPortablePath(output, "configured release output");
  return output;
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function renderHelp() {
  return `OpenDelegate release authority configuration composer

This command creates a standalone external bundle. It never installs into a Device state root.

Usage:
  pnpm release:configure -- \\
    --repository <absolute-clean-checkout> \\
    --git-executable <absolute-unlinked-git> --git-executable-sha256 <sha256> \\
    --plan <absolute-canonical-plan> --plan-sha256 <sha256> \\
    --destination-root <absolute-new-directory> \\
    --runner-executable-sha256 <sha256>
`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentFile)) {
  try {
    const parsed = parseReleaseConfigurationArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(renderHelp());
    } else {
      const result = await composeReleaseConfiguration(parsed);
      process.stdout.write(
        `${JSON.stringify({
          configurationSha256: result.configuration.sha256,
          effectiveChannel: result.effectiveChannel,
          externalStatus: result.externalStatus,
          runnerRecordSha256: result.runnerRecord.sha256,
          target: result.target,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `Release configuration failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
