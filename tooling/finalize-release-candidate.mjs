import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_RELEASE_NODE_VERSION } from "./build-release.mjs";
import { createDeterministicReleaseArchive } from "./create-release-archive.mjs";
import { authorizeCredentialUse } from "./release-credential-authorization.mjs";
import {
  assertPinnedReleaseGitFilesMatchCommit,
  pinReleaseGitProvenance,
  readPinnedReleaseSourceIdentity,
  revalidatePinnedReleaseGitProvenance,
} from "./release-git-provenance.mjs";
import {
  pinReleaseRunnerIdentity,
  revalidateReleaseRunnerIdentity,
} from "./release-runner-identity.mjs";
import {
  assertPinnedReleaseSigningPolicyExternal,
  describePinnedReleaseSigningPolicy,
  getPinnedReleaseSigningTrust,
  readPinnedReleaseSigningPolicy,
  signWithPinnedReleasePolicy,
} from "./release-signing-policy.mjs";
import {
  assertNoLinkedPathComponents,
  removePinnedDirectoryTree,
  requireCanonicalDirectory,
  revalidatePinnedDirectory,
} from "./release-tooling-io.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(currentFile), "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TARGETS = new Map([
  ["darwin-arm64", Object.freeze({ platform: "darwin", architecture: "arm64" })],
  ["linux-x64", Object.freeze({ platform: "linux", architecture: "x64" })],
  ["win32-x64", Object.freeze({ platform: "win32", architecture: "x64" })],
]);
const METADATA_LIMIT = 1024 * 1024;

export function parseReleaseFinalizationArguments(values) {
  if (values.includes("--help") || values.includes("-h")) {
    return { help: true };
  }
  const parsed = new Map();
  const supported = new Set([
    "--candidate",
    "--destination",
    "--git-executable",
    "--git-executable-sha256",
    "--target",
    "--expected-manifest-sha256",
    "--expected-candidate-digest",
    "--signing-policy",
    "--signing-policy-sha256",
    "--runner-executable-sha256",
  ]);
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!supported.has(name) || value === undefined || value.startsWith("--") || parsed.has(name)) {
      throw new Error(`Invalid or duplicate release-finalization option: ${String(name)}.`);
    }
    parsed.set(name, value);
  }
  for (const name of supported) {
    if (!parsed.has(name)) {
      throw new Error(`${name} is required.`);
    }
  }
  for (const name of ["--candidate", "--destination", "--git-executable", "--signing-policy"]) {
    if (!isAbsolute(parsed.get(name))) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
  for (const name of [
    "--expected-manifest-sha256",
    "--expected-candidate-digest",
    "--git-executable-sha256",
    "--runner-executable-sha256",
    "--signing-policy-sha256",
  ]) {
    if (!SHA256_PATTERN.test(parsed.get(name))) {
      throw new Error(`${name} must be a lowercase SHA-256 digest.`);
    }
  }
  const target = TARGETS.get(parsed.get("--target"));
  if (target === undefined) {
    throw new Error("--target must name a first-milestone platform target.");
  }
  return {
    candidateRoot: resolve(parsed.get("--candidate")),
    destinationDirectory: resolve(parsed.get("--destination")),
    expectedCandidateDigest: parsed.get("--expected-candidate-digest"),
    expectedManifestSha256: parsed.get("--expected-manifest-sha256"),
    gitExecutablePath: resolve(parsed.get("--git-executable")),
    gitExecutableSha256: parsed.get("--git-executable-sha256"),
    help: false,
    runnerExecutableSha256: parsed.get("--runner-executable-sha256"),
    signingPolicyPath: resolve(parsed.get("--signing-policy")),
    signingPolicySha256: parsed.get("--signing-policy-sha256"),
    target: { ...target },
  };
}

export async function finalizeReleaseCandidate(input, dependencies = {}) {
  validateFinalizationInput(input);
  const stableFileDependencies = dependencies.stableFile ?? {};
  const runner = dependencies.runner ?? {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.versions.node,
  };
  if (
    runner.platform !== input.target.platform ||
    runner.architecture !== input.target.architecture ||
    runner.nodeVersion !== REQUIRED_RELEASE_NODE_VERSION
  ) {
    throw new Error(
      `Release candidates must be finalized on their target-native Node.js ${REQUIRED_RELEASE_NODE_VERSION} runner.`,
    );
  }
  let runtimeExecutableHasher = dependencies.hashRuntimeExecutable;
  if (runtimeExecutableHasher === undefined) {
    const runtimeExecutablePath = await realpath(process.execPath);
    const runtimeExecutableRoot = await requireCanonicalDirectory(
      dirname(runtimeExecutablePath),
      "release runtime executable parent",
    );
    runtimeExecutableHasher = () =>
      hashStableRegularFile(runtimeExecutablePath, runtimeExecutableRoot, stableFileDependencies);
  }
  const runnerIdentity = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: input.runnerExecutableSha256,
    hashRuntimeExecutable: runtimeExecutableHasher,
    runner: {
      architecture: runner.architecture,
      nodeVersion: runner.nodeVersion,
      platform: runner.platform,
    },
  });
  const gitProvenance = await (dependencies.pinGitProvenance ?? pinReleaseGitProvenance)({
    expectedExecutableSha256: input.gitExecutableSha256,
    executablePath: input.gitExecutablePath,
    repositoryRoot,
  });
  const sourceIdentityReader =
    dependencies.readSourceIdentity ?? (() => readPinnedReleaseSourceIdentity(gitProvenance));
  const revalidateGit =
    dependencies.revalidateGitProvenance ?? revalidatePinnedReleaseGitProvenance;
  const assertGitFiles =
    dependencies.assertGitFilesMatchCommit ?? assertPinnedReleaseGitFilesMatchCommit;
  const integrity =
    dependencies.integrity ?? (await import("../packages/release-integrity/src/index.ts"));
  requireIntegrityBoundary(integrity);

  const candidateRoot = await requireCanonicalDirectory(input.candidateRoot, "candidate root");
  const destinationDirectory = await requireCanonicalDirectory(
    input.destinationDirectory,
    "release output directory",
  );
  const destinationIdentity = await lstat(destinationDirectory, { bigint: true });
  if (
    isSameOrDescendant(candidateRoot, destinationDirectory) ||
    isSameOrDescendant(destinationDirectory, candidateRoot)
  ) {
    throw new Error("The release candidate and output directory must be disjoint.");
  }
  if (
    isSameOrDescendant(repositoryRoot, candidateRoot) ||
    isSameOrDescendant(repositoryRoot, destinationDirectory)
  ) {
    throw new Error("Release candidates and generated outputs must remain outside the checkout.");
  }

  const firstCandidate = await integrity.inspectCandidate({
    expectedManifestSha256: input.expectedManifestSha256,
    expectedTarget: input.target,
    root: candidateRoot,
  });
  assertCandidateDigest(firstCandidate, input.expectedCandidateDigest);
  const sourceBefore = await sourceIdentityReader();
  assertCleanFinalizationSource(sourceBefore, firstCandidate.buildCommit);
  const releaseLogicBefore = await hashReleaseLogic(stableFileDependencies);
  await assertGitFiles(
    gitProvenance,
    releaseLogicBefore.map(({ path }) => path),
  );
  await revalidateGit(gitProvenance);
  const archiveName = releaseArchiveName(firstCandidate);
  const finalPaths = Object.freeze({
    archive: join(destinationDirectory, archiveName),
    attestation: join(destinationDirectory, `${archiveName}.publisher-attestation.json`),
    runnerRecord: join(destinationDirectory, `${archiveName}.publisher-runner.json`),
  });
  await Promise.all(
    Object.values(finalPaths).map((path) =>
      assertPathAbsent(path, "A release-finalization output"),
    ),
  );

  const signingPolicy = await readPinnedReleaseSigningPolicy({
    expectedRole: "publisher",
    path: input.signingPolicyPath,
    sha256: input.signingPolicySha256,
  });
  assertPinnedReleaseSigningPolicyExternal(signingPolicy, [candidateRoot, destinationDirectory]);
  const signingTrust = getPinnedReleaseSigningTrust(signingPolicy);
  const policyDescription = describePinnedReleaseSigningPolicy(signingPolicy);
  if (signingTrust.role !== "publisher" || policyDescription.role !== "publisher") {
    throw new Error("Release candidate finalization requires a publisher signing authority.");
  }

  const metadataBytes = await integrity.nodeReleaseFileReader.read(
    join(candidateRoot, "release-metadata.json"),
    METADATA_LIMIT,
  );
  const releaseMetadata = releaseMetadataForFinalization(metadataBytes);
  const runnerExecutableBefore = await runtimeExecutableHasher();
  if (runnerExecutableBefore.sha256 !== releaseMetadata.runtimeExecutableSha256) {
    throw new Error("The finalization runtime does not match the candidate's pinned Node.js.");
  }
  const temporaryDirectory = await mkdtemp(join(destinationDirectory, ".opendelegate-finalize-"));
  const temporaryIdentity = await lstat(temporaryDirectory, { bigint: true });
  const temporaryPaths = Object.freeze({
    archive: join(temporaryDirectory, archiveName),
    attestation: join(temporaryDirectory, `${archiveName}.publisher-attestation.json`),
    runnerRecord: join(temporaryDirectory, `${archiveName}.publisher-runner.json`),
  });
  const temporaryEntries = [];
  const published = [];
  try {
    let archiveResult;
    try {
      archiveResult = await (dependencies.createArchive ?? createDeterministicReleaseArchive)({
        destination: temporaryPaths.archive,
        sourceDirectory: candidateRoot,
        timestamp: releaseMetadata.archiveTimestamp,
      });
    } catch (error) {
      const partialArchive = await pinTemporaryFileIfPresent(
        temporaryPaths.archive,
        temporaryDirectory,
        "partial release archive",
      );
      if (partialArchive !== undefined) {
        temporaryEntries.push(partialArchive);
      }
      throw error;
    }
    temporaryEntries.push(
      await pinTemporaryFile(temporaryPaths.archive, temporaryDirectory, "release archive"),
    );
    const secondCandidate = await integrity.inspectCandidate({
      expectedManifestSha256: input.expectedManifestSha256,
      expectedTarget: input.target,
      root: candidateRoot,
    });
    if (secondCandidate.publisherStatement.sha256 !== input.expectedCandidateDigest) {
      throw new Error("The candidate changed while its final archive was created.");
    }
    const archive = Object.freeze({
      path: archiveName,
      size: archiveResult.size,
      sha256: archiveResult.sha256,
    });
    const composed = integrity.composePublisherAttestationStatement({
      archive,
      candidate: secondCandidate,
    });
    const revalidateCredentialUse = async () => {
      const currentCandidate = await integrity.inspectCandidate({
        expectedManifestSha256: input.expectedManifestSha256,
        expectedTarget: input.target,
        root: candidateRoot,
      });
      assertCandidateDigest(currentCandidate, input.expectedCandidateDigest);
      if (
        currentCandidate.buildCommit !== secondCandidate.buildCommit ||
        currentCandidate.publisherStatement.sha256 !== secondCandidate.publisherStatement.sha256
      ) {
        throw new Error("The release candidate changed before publisher credential use.");
      }
      const currentSource = await sourceIdentityReader();
      assertCleanFinalizationSource(currentSource, secondCandidate.buildCommit);
      if (
        currentSource.commit !== sourceBefore.commit ||
        JSON.stringify(await hashReleaseLogic(stableFileDependencies)) !==
          JSON.stringify(releaseLogicBefore)
      ) {
        throw new Error("The committed release finalization logic changed before signing.");
      }
      await assertGitFiles(
        gitProvenance,
        releaseLogicBefore.map(({ path }) => path),
      );
      await revalidateGit(gitProvenance);
      await revalidateReleaseRunnerIdentity(runnerIdentity);
      if ((await runtimeExecutableHasher()).sha256 !== runnerExecutableBefore.sha256) {
        throw new Error("The release runtime changed before publisher credential use.");
      }
      const currentPolicy = await readPinnedReleaseSigningPolicy({
        expectedRole: "publisher",
        path: input.signingPolicyPath,
        sha256: input.signingPolicySha256,
      });
      assertPinnedReleaseSigningPolicyExternal(currentPolicy, [
        candidateRoot,
        destinationDirectory,
      ]);
      if (
        JSON.stringify(describePinnedReleaseSigningPolicy(currentPolicy)) !==
        JSON.stringify(policyDescription)
      ) {
        throw new Error("The publisher signing policy changed before credential use.");
      }
      await Promise.all(
        Object.values(finalPaths).map((path) =>
          assertPathAbsent(path, "A release-finalization output"),
        ),
      );
      const currentArchive = await hashStableRegularFile(
        temporaryPaths.archive,
        destinationDirectory,
        stableFileDependencies,
      );
      if (currentArchive.sha256 !== archive.sha256 || currentArchive.size !== archive.size) {
        throw new Error("The release archive changed before publisher credential use.");
      }
    };
    const signingInputSha256 = sha256(composed.signingBytes);
    const authorization = await (dependencies.authorizeCredentialUse ?? authorizeCredentialUse)({
      domain: "publisher-attestation-v2",
      inputSha256: signingInputSha256,
      revalidate: revalidateCredentialUse,
      role: "publisher",
      snapshot: {
        archiveSha256: archive.sha256,
        candidateDigest: input.expectedCandidateDigest,
        gitExecutableSha256: gitProvenance.description.gitExecutableSha256,
        policySha256: policyDescription.policySha256,
        publisherKeyId: signingTrust.keyId,
        releaseLogicSha256: sha256(Buffer.from(JSON.stringify(releaseLogicBefore), "utf8")),
        runtimeExecutableSha256: runnerIdentity.description.runtimeExecutableSha256,
        sourceCommit: sourceBefore.commit,
      },
    });
    const signed = await (dependencies.signWithPolicy ?? signWithPinnedReleasePolicy)({
      authorization,
      policy: signingPolicy,
      signingBytes: composed.signingBytes,
    });
    await revalidateCredentialUse();
    const envelope = integrity.composeSignedReleaseEnvelope({
      composed,
      keyId: signed.keyId,
      signature: signed.signature,
    });
    const attestationIdentity = await writeNewSyncedFile(
      temporaryPaths.attestation,
      envelope.canonicalBytes,
      0o644,
      {
        identity: temporaryIdentity,
        label: "release finalization temporary directory",
        path: temporaryDirectory,
      },
    );
    temporaryEntries.push(
      Object.freeze({
        identity: attestationIdentity,
        path: basename(temporaryPaths.attestation),
        type: "file",
      }),
    );

    const verified = await integrity.verifyRelease({
      candidatePublisherEvidence: {
        archivePath: temporaryPaths.archive,
        attestationPath: temporaryPaths.attestation,
      },
      expectedCandidateDigest: input.expectedCandidateDigest,
      expectedManifestSha256: input.expectedManifestSha256,
      expectedTarget: input.target,
      publisherTrust: {
        publicKeyPem: signingTrust.publicKeyPem,
      },
      root: candidateRoot,
    });
    assertVerifiedPublisherResult(verified, archive, envelope.sha256, signed.keyId);
    const sourceAfter = await sourceIdentityReader();
    assertCleanFinalizationSource(sourceAfter, secondCandidate.buildCommit);
    await assertGitFiles(
      gitProvenance,
      releaseLogicBefore.map(({ path }) => path),
    );
    await revalidateGit(gitProvenance);
    await revalidateReleaseRunnerIdentity(runnerIdentity);
    if (
      sourceAfter.commit !== sourceBefore.commit ||
      JSON.stringify(await hashReleaseLogic(stableFileDependencies)) !==
        JSON.stringify(releaseLogicBefore) ||
      (await runtimeExecutableHasher()).sha256 !== runnerExecutableBefore.sha256
    ) {
      throw new Error("The committed release finalization logic changed while signing.");
    }

    const recordedAt = (dependencies.now?.() ?? new Date()).toISOString();
    const runnerRecord = {
      schemaVersion: 1,
      product: "OpenDelegate",
      role: "publisher",
      recordedAt,
      target: {
        platform: input.target.platform,
        architecture: input.target.architecture,
      },
      source: {
        auditedSourceCommit: secondCandidate.auditedSourceCommit,
        buildCommit: secondCandidate.buildCommit,
        buildId: secondCandidate.buildId,
        releaseLogic: releaseLogicBefore,
      },
      candidate: {
        checksumManifestSha256: secondCandidate.checksumManifestSha256,
        publisherStatementSha256: secondCandidate.publisherStatement.sha256,
      },
      policy: {
        policySha256: policyDescription.policySha256,
        publicKeySha256: policyDescription.publicKeySha256,
        keyId: policyDescription.keyId,
      },
      runner: {
        platform: runnerIdentity.description.platform,
        architecture: runnerIdentity.description.architecture,
        nodeVersion: runnerIdentity.description.nodeVersion,
        runtimeExecutableSha256: runnerIdentity.description.runtimeExecutableSha256,
        gitExecutableSha256: gitProvenance.description.gitExecutableSha256,
        signingInputSha256: signed.inputSha256,
        brokerEndpointSha256: signed.runner.brokerEndpointSha256,
        brokerProtocol: signed.runner.brokerProtocol,
        brokerTransportKeyId: signed.runner.brokerTransportKeyId,
      },
      outputs: {
        archive,
        publisherAttestation: {
          path: basename(finalPaths.attestation),
          sha256: envelope.sha256,
        },
      },
    };
    const runnerBytes = Buffer.from(`${JSON.stringify(runnerRecord, null, 2)}\n`, "utf8");
    const runnerRecordIdentity = await writeNewSyncedFile(
      temporaryPaths.runnerRecord,
      runnerBytes,
      0o644,
      {
        identity: temporaryIdentity,
        label: "release finalization temporary directory",
        path: temporaryDirectory,
      },
    );
    temporaryEntries.push(
      Object.freeze({
        identity: runnerRecordIdentity,
        path: basename(temporaryPaths.runnerRecord),
        type: "file",
      }),
    );

    for (const name of ["archive", "attestation", "runnerRecord"]) {
      const temporaryPath = temporaryPaths[name];
      const finalPath = finalPaths[name];
      await link(temporaryPath, finalPath);
      const [temporaryIdentity, finalIdentity] = await Promise.all([
        lstat(temporaryPath, { bigint: true }),
        lstat(finalPath, { bigint: true }),
      ]);
      if (!sameFile(temporaryIdentity, finalIdentity)) {
        throw new Error("A release output changed during atomic publication.");
      }
      published.push({ finalPath, temporaryIdentity, temporaryPath });
    }

    const runnerSha256 = sha256(runnerBytes);
    const verifiedOutputs = await Promise.all([
      hashStableRegularFile(finalPaths.archive, destinationDirectory, stableFileDependencies),
      hashStableRegularFile(finalPaths.attestation, destinationDirectory, stableFileDependencies),
      hashStableRegularFile(finalPaths.runnerRecord, destinationDirectory, stableFileDependencies),
    ]);
    if (
      verifiedOutputs[0].sha256 !== archive.sha256 ||
      verifiedOutputs[0].size !== archive.size ||
      verifiedOutputs[1].sha256 !== envelope.sha256 ||
      verifiedOutputs[1].size !== envelope.canonicalBytes.byteLength ||
      verifiedOutputs[2].sha256 !== runnerSha256 ||
      verifiedOutputs[2].size !== runnerBytes.byteLength
    ) {
      throw new Error("A release output failed final digest verification.");
    }

    await syncDirectory(destinationDirectory);
    await removePinnedDirectoryTree({
      entries: temporaryEntries,
      identity: temporaryIdentity,
      label: "release finalization temporary directory",
      path: temporaryDirectory,
    });
    await syncDirectory(destinationDirectory);
    return Object.freeze({
      archive: Object.freeze({ ...archive, path: finalPaths.archive }),
      candidateDigest: input.expectedCandidateDigest,
      publisherAttestation: Object.freeze({
        path: finalPaths.attestation,
        sha256: envelope.sha256,
      }),
      publisherKeyId: signed.keyId,
      runnerRecord: Object.freeze({
        path: finalPaths.runnerRecord,
        sha256: runnerSha256,
      }),
    });
  } catch (error) {
    await cleanupPublishedOutputs(published, destinationDirectory, destinationIdentity);
    await removePinnedDirectoryTree({
      entries: temporaryEntries,
      identity: temporaryIdentity,
      label: "release finalization temporary directory",
      path: temporaryDirectory,
    });
    if (isNodeError(error, "EEXIST")) {
      throw new Error("A release-finalization output already exists; nothing was overwritten.", {
        cause: error,
      });
    }
    throw error;
  }
}

function validateFinalizationInput(input) {
  requireExactKeys(
    input,
    [
      "candidateRoot",
      "destinationDirectory",
      "expectedCandidateDigest",
      "expectedManifestSha256",
      "gitExecutablePath",
      "gitExecutableSha256",
      "runnerExecutableSha256",
      "signingPolicyPath",
      "signingPolicySha256",
      "target",
    ],
    "release finalization input",
  );
  for (const [value, label] of [
    [input.candidateRoot, "candidate root"],
    [input.destinationDirectory, "release output directory"],
    [input.gitExecutablePath, "Git executable"],
    [input.signingPolicyPath, "release signing policy"],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new Error(`The ${label} path must be absolute.`);
    }
  }
  for (const [value, label] of [
    [input.expectedCandidateDigest, "expected candidate digest"],
    [input.expectedManifestSha256, "expected manifest digest"],
    [input.gitExecutableSha256, "Git executable digest"],
    [input.runnerExecutableSha256, "release-runner executable digest"],
    [input.signingPolicySha256, "release signing policy digest"],
  ]) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`The ${label} must be a lowercase SHA-256 value.`);
    }
  }
  requireExactKeys(input.target, ["platform", "architecture"], "release target");
  if (!TARGETS.has(`${input.target.platform}-${input.target.architecture}`)) {
    throw new Error("The release target is not a first-milestone platform target.");
  }
}

function requireIntegrityBoundary(value) {
  for (const name of [
    "composePublisherAttestationStatement",
    "composeSignedReleaseEnvelope",
    "inspectCandidate",
    "verifyRelease",
  ]) {
    if (typeof value?.[name] !== "function") {
      throw new Error("The trusted release-integrity boundary is unavailable.");
    }
  }
  if (typeof value.nodeReleaseFileReader?.read !== "function") {
    throw new Error("The stable release-integrity file reader is unavailable.");
  }
}

function assertCandidateDigest(candidate, expected) {
  if (candidate?.publisherStatement?.sha256 !== expected) {
    throw new Error("The candidate does not match its pre-pinned description digest.");
  }
}

function assertCleanFinalizationSource(source, expectedCommit) {
  if (
    typeof source !== "object" ||
    source === null ||
    source.dirty !== false ||
    source.commit !== expectedCommit ||
    !/^[0-9a-f]{40}$/u.test(source.commit)
  ) {
    throw new Error(
      "Release finalization requires the clean committed build source named by the candidate.",
    );
  }
}

async function hashReleaseLogic(stableFileDependencies) {
  const files = [
    "pnpm-lock.yaml",
    "packages/release-integrity/src/index.ts",
    "packages/release-integrity/src/stable-node-file-read.ts",
    "tooling/build-release.mjs",
    "tooling/create-release-archive.mjs",
    "tooling/external-release-signer.mjs",
    "tooling/finalize-release-candidate.mjs",
    "tooling/release-credential-authorization.mjs",
    "tooling/release-git-provenance.mjs",
    "tooling/release-runner-identity.mjs",
    "tooling/release-signing-policy.mjs",
    "tooling/release-tooling-io.mjs",
  ];
  return Promise.all(
    files.map(async (path) =>
      Object.freeze({
        path,
        sha256: (
          await hashStableRegularFile(
            join(repositoryRoot, ...path.split("/")),
            repositoryRoot,
            stableFileDependencies,
          )
        ).sha256,
      }),
    ),
  );
}

function releaseArchiveName(candidate) {
  if (
    typeof candidate.productVersion !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(candidate.productVersion)
  ) {
    throw new Error("The candidate product version is not archive-safe.");
  }
  return `opendelegate-v${candidate.productVersion}-${candidate.target.platform}-${candidate.target.architecture}.zip`;
}

function releaseMetadataForFinalization(metadataBytes) {
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
  } catch (error) {
    throw new Error("The verified release metadata has no usable finalization provenance.", {
      cause: error,
    });
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata.createdAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    typeof metadata.bundledRuntime !== "object" ||
    metadata.bundledRuntime === null ||
    Array.isArray(metadata.bundledRuntime) ||
    typeof metadata.bundledRuntime.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(metadata.bundledRuntime.executableSha256)
  ) {
    throw new Error("The verified release metadata has no usable finalization provenance.");
  }
  return {
    archiveTimestamp: metadata.createdAt,
    runtimeExecutableSha256: metadata.bundledRuntime.executableSha256,
  };
}

function assertVerifiedPublisherResult(verified, archive, attestationSha256, keyId) {
  if (
    verified?.effectiveChannel !== "release-candidate" ||
    verified.publisherKeyId !== keyId ||
    verified.publisherAttestationSha256 !== attestationSha256 ||
    verified.archive?.path !== archive.path ||
    verified.archive?.size !== archive.size ||
    verified.archive?.sha256 !== archive.sha256
  ) {
    throw new Error("The trusted verifier did not reproduce the finalized publisher binding.");
  }
}

async function assertPathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists; nothing was overwritten.`);
}

async function writeNewSyncedFile(path, bytes, mode, boundary) {
  const handle = await open(path, "wx", mode);
  let identity;
  let operationError;
  try {
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    operationError ??= error;
  }
  if (operationError !== undefined) {
    if (identity !== undefined) {
      try {
        await removePinnedCreatedFile(path, identity, boundary);
      } catch (cleanupError) {
        throw new AggregateError(
          [operationError, cleanupError],
          "A release file write failed and its partial output could not be removed.",
          { cause: cleanupError },
        );
      }
    }
    throw operationError;
  }
  return identity;
}

async function removePinnedCreatedFile(path, identity, boundary) {
  if (!isStrictDescendant(boundary.path, path)) {
    throw new Error("A partial release file escaped its pinned staging root.");
  }
  await revalidatePinnedDirectory(boundary.path, boundary.identity, boundary.label);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !sameFileIdentity(before, identity)) {
    throw new Error("A partial release file changed before cleanup.");
  }
  await assertNoLinkedPathComponents(path, "partial release file");
  const after = await lstat(path, { bigint: true });
  if (!sameFileIdentity(before, after) || !sameFileIdentity(after, identity)) {
    throw new Error("A partial release file changed before cleanup.");
  }
  await unlink(path);
}

async function pinTemporaryFile(path, root, label) {
  if (comparablePath(dirname(path)) !== comparablePath(root)) {
    throw new Error(`The ${label} escaped its temporary directory.`);
  }
  await assertNoLinkedPathComponents(path, label);
  const identity = await lstat(path, { bigint: true });
  if (!identity.isFile() || identity.isSymbolicLink()) {
    throw new Error(`The ${label} is not a regular temporary file.`);
  }
  return Object.freeze({ identity, path: basename(path), type: "file" });
}

async function pinTemporaryFileIfPresent(path, root, label) {
  try {
    return await pinTemporaryFile(path, root, label);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashStableRegularFile(path, root, dependencies = {}) {
  if (!isStrictDescendant(root, path)) {
    throw new Error("A finalized release output escaped its trusted root.");
  }
  const pathLstat = dependencies.lstat ?? lstat;
  const pathRealpath = dependencies.realpath ?? realpath;
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.size <= 0n ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("A finalized release output is not a bounded regular file.");
    }
    const canonical = await verifyOpenedFinalizedPath({
      errorMessage: "A finalized release output changed before verification.",
      opened,
      path,
      pathLstat,
      pathRealpath,
      root,
    });
    await dependencies.afterOpen?.(path);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = Number(opened.size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("A finalized release output ended during verification.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error("A finalized release output changed during verification.");
    }
    await verifyOpenedFinalizedPath({
      canonical,
      errorMessage: "A finalized release output changed during verification.",
      opened: after,
      path,
      pathLstat,
      pathRealpath,
      root,
    });
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}

async function verifyOpenedFinalizedPath({
  canonical,
  errorMessage,
  opened,
  path,
  pathLstat,
  pathRealpath,
  root,
}) {
  await assertNoLinkedPathComponents(path, "finalized release output", {
    lstat: pathLstat,
  });
  const named = await pathLstat(path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || !sameFile(opened, named)) {
    throw new Error(errorMessage);
  }
  const currentCanonical = await pathRealpath(path);
  if (!isStrictDescendant(root, currentCanonical)) {
    throw new Error("A finalized release output escaped its trusted root.");
  }
  if (canonical !== undefined && comparablePath(canonical) !== comparablePath(currentCanonical)) {
    throw new Error(errorMessage);
  }
  const canonicalMetadata = await pathLstat(currentCanonical, { bigint: true });
  if (
    !canonicalMetadata.isFile() ||
    canonicalMetadata.isSymbolicLink() ||
    !sameFile(opened, canonicalMetadata)
  ) {
    throw new Error(errorMessage);
  }
  return currentCanonical;
}

async function cleanupPublishedOutputs(published, destinationDirectory, destinationIdentity) {
  for (const output of [...published].reverse()) {
    await revalidatePinnedDirectory(
      destinationDirectory,
      destinationIdentity,
      "release output directory",
    );
    if (comparablePath(dirname(output.finalPath)) !== comparablePath(destinationDirectory)) {
      throw new Error("A published release output escaped its pinned output directory.");
    }
    try {
      const before = await lstat(output.finalPath, { bigint: true });
      if (before.isSymbolicLink()) {
        throw new Error("A published release output changed into a linked path.");
      }
      if (!sameFile(before, output.temporaryIdentity)) {
        continue;
      }
      await assertNoLinkedPathComponents(output.finalPath, "published release output");
      const current = await lstat(output.finalPath, { bigint: true });
      if (sameFile(before, current) && sameFile(current, output.temporaryIdentity)) {
        await unlink(output.finalPath);
      } else {
        throw new Error("A published release output changed before cleanup.");
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
  await revalidatePinnedDirectory(
    destinationDirectory,
    destinationIdentity,
    "release output directory",
  );
}

function sameFile(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino !== 0n &&
    left.ino === right.ino
  );
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(root, candidate) {
  const difference = relative(resolve(root), resolve(candidate));
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function isStrictDescendant(root, candidate) {
  const difference = relative(resolve(root), resolve(candidate));
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function requireExactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`The ${label} fields do not match the strict schema.`);
  }
}

function isNodeError(error, code) {
  return error !== null && typeof error === "object" && error.code === code;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function printHelp() {
  process.stdout.write(`Finalize one target-native OpenDelegate release candidate.

Usage:
  node --experimental-strip-types tooling/finalize-release-candidate.mjs \\
    --candidate ABSOLUTE_CANDIDATE_DIRECTORY \\
    --destination ABSOLUTE_OUTPUT_DIRECTORY \\
    --git-executable ABSOLUTE_UNLINKED_GIT --git-executable-sha256 LOWERCASE_SHA256 \\
    --runner-executable-sha256 LOWERCASE_SHA256 \\
    --target darwin-arm64|linux-x64|win32-x64 \\
    --expected-manifest-sha256 LOWERCASE_SHA256 \\
    --expected-candidate-digest LOWERCASE_SHA256 \\
    --signing-policy ABSOLUTE_PINNED_PUBLISHER_POLICY \\
    --signing-policy-sha256 LOWERCASE_SHA256

The command creates a deterministic ZIP, detached publisher attestation, and
sanitized runner record. It never overwrites an output and never accepts a private
key through arguments, environment variables, source, or candidate contents.
`);
}

if (resolve(process.argv[1] ?? "") === resolve(currentFile)) {
  try {
    const options = parseReleaseFinalizationArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      const result = await finalizeReleaseCandidate(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
