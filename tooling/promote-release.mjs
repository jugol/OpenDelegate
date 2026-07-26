import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSourceIdentity } from "./build-release.mjs";
import {
  preparePromotionAuthorization,
  promotionPreparationExternalRoots,
  revalidatePreparedPromotion,
} from "./release-promotion-plan.mjs";
import {
  assertDisjointPaths,
  assertPathAbsent,
  digestBytes,
  publishNewFileSet,
  requireCanonicalDirectory,
  requireCanonicalNewPath,
  requireExactKeys,
} from "./release-tooling-io.mjs";
import {
  assertPinnedReleaseSigningPolicyExternal,
  describePinnedReleaseSigningPolicy,
  getPinnedReleaseSigningTrust,
  readPinnedReleaseSigningPolicy,
  signWithPinnedReleasePolicy,
} from "./release-signing-policy.mjs";
import {
  hashCurrentNodeExecutable,
  pinReleaseRunnerIdentity,
  revalidateReleaseRunnerIdentity,
} from "./release-runner-identity.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const currentFile = fileURLToPath(import.meta.url);

export function parseReleasePromotionArguments(values) {
  const arguments_ = values[0] === "--" ? values.slice(1) : values;
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { help: true };
  }
  const names = new Set([
    "--repository",
    "--plan",
    "--plan-sha256",
    "--signing-policy",
    "--signing-policy-sha256",
    "--attestation-destination",
    "--runner-record-destination",
    "--runner-executable-sha256",
  ]);
  const parsed = parseExactOptions(arguments_, names, "release-promotion");
  assertAbsoluteOptions(parsed, [
    "--repository",
    "--plan",
    "--signing-policy",
    "--attestation-destination",
    "--runner-record-destination",
  ]);
  assertDigestOptions(parsed, [
    "--plan-sha256",
    "--runner-executable-sha256",
    "--signing-policy-sha256",
  ]);
  return {
    attestationDestination: resolve(parsed.get("--attestation-destination")),
    planPath: resolve(parsed.get("--plan")),
    planSha256: parsed.get("--plan-sha256"),
    repositoryRoot: resolve(parsed.get("--repository")),
    runnerExecutableSha256: parsed.get("--runner-executable-sha256"),
    runnerRecordDestination: resolve(parsed.get("--runner-record-destination")),
    signingPolicyPath: resolve(parsed.get("--signing-policy")),
    signingPolicySha256: parsed.get("--signing-policy-sha256"),
  };
}

export async function promoteRelease(input, dependencies = {}) {
  validatePromotionInput(input);
  const runnerIdentity = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: input.runnerExecutableSha256,
    hashRuntimeExecutable: dependencies.hashRuntimeExecutable ?? hashCurrentNodeExecutable,
    runner: dependencies.runner ?? {
      architecture: process.arch,
      nodeVersion: process.versions.node,
      platform: process.platform,
    },
  });
  const [attestationDestination, runnerRecordDestination, repositoryRoot] = await Promise.all([
    requireCanonicalNewPath(input.attestationDestination, "promotion attestation destination"),
    requireCanonicalNewPath(input.runnerRecordDestination, "promotion runner-record destination"),
    requireCanonicalDirectory(input.repositoryRoot, "release repository"),
  ]);
  assertDisjointPaths([attestationDestination, runnerRecordDestination], "promotion output");
  if (dirname(attestationDestination) !== dirname(runnerRecordDestination)) {
    throw new Error("Promotion outputs must share one directory.");
  }
  await Promise.all([
    assertPathAbsent(attestationDestination, "A release-promotion output"),
    assertPathAbsent(runnerRecordDestination, "A release-promotion output"),
  ]);
  const integrity =
    dependencies.integrity ?? (await import("../packages/release-integrity/src/index.ts"));
  requirePromotionIntegrityBoundary(integrity);
  const prepared = await preparePromotionAuthorization(
    {
      repositoryRoot,
      planPath: input.planPath,
      planSha256: input.planSha256,
      outputPaths: [attestationDestination, runnerRecordDestination],
    },
    {
      hashReleaseLogic: dependencies.hashReleaseLogic,
      integrity,
      readSourceIdentity: dependencies.readSourceIdentity ?? readSourceIdentity,
      runningRepositoryRoot: dependencies.runningRepositoryRoot,
    },
  );

  const policy = await readPinnedReleaseSigningPolicy({
    expectedRole: "promotion",
    path: input.signingPolicyPath,
    sha256: input.signingPolicySha256,
  });
  assertPinnedReleaseSigningPolicyExternal(policy, promotionPreparationExternalRoots(prepared));
  const trust = getPinnedReleaseSigningTrust(policy);
  const policyDescription = describePinnedReleaseSigningPolicy(policy);
  if (trust.role !== "promotion" || policyDescription.role !== "promotion") {
    throw new Error("Release promotion requires the dedicated promotion authority.");
  }
  if (prepared.verifiedCandidates.some(({ publisherKeyId }) => publisherKeyId === trust.keyId)) {
    throw new Error("The promotion key must be distinct from every publisher key.");
  }
  if (prepared.revocations.revokedPromotionKeyIds.includes(trust.keyId)) {
    throw new Error("The promotion trust root is revoked by release policy.");
  }

  await revalidateReleaseRunnerIdentity(runnerIdentity);
  const signed = await signWithPinnedReleasePolicy({
    policy,
    signingBytes: prepared.composed.signingBytes,
  });
  if (signed.role !== "promotion" || signed.keyId !== trust.keyId) {
    throw new Error("The external signer did not preserve the promotion authority.");
  }
  await revalidateReleaseRunnerIdentity(runnerIdentity);
  const envelope = integrity.composeSignedReleaseEnvelope({
    composed: prepared.composed,
    keyId: signed.keyId,
    signature: signed.signature,
  });
  await revalidatePreparedPromotion(prepared);
  const recordedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const runnerRecord = createPromotionRunnerRecord({
    envelope,
    policyDescription,
    prepared,
    recordedAt,
    runnerIdentity,
    signed,
  });
  const runnerBytes = Buffer.from(`${JSON.stringify(runnerRecord, null, 2)}\n`, "utf8");
  const published = await (dependencies.publishOutputs ?? publishNewFileSet)(
    [
      {
        path: attestationDestination,
        bytes: envelope.canonicalBytes,
        mode: 0o644,
      },
      {
        path: runnerRecordDestination,
        bytes: runnerBytes,
        mode: 0o644,
      },
    ],
    {
      async verifyPublished() {
        await revalidatePreparedPromotion(prepared);
        await revalidateReleaseRunnerIdentity(runnerIdentity);
        const currentPolicy = await readPinnedReleaseSigningPolicy({
          expectedRole: "promotion",
          path: input.signingPolicyPath,
          sha256: input.signingPolicySha256,
        });
        if (
          JSON.stringify(describePinnedReleaseSigningPolicy(currentPolicy)) !==
          JSON.stringify(policyDescription)
        ) {
          throw new Error("The promotion signing policy changed during publication.");
        }
      },
    },
  );
  const attestationOutput = published[0];
  const runnerOutput = published[1];
  if (
    attestationOutput.sha256 !== envelope.sha256 ||
    runnerOutput.sha256 !== digestBytes(runnerBytes)
  ) {
    throw new Error("The published release-promotion outputs failed digest verification.");
  }
  return Object.freeze({
    planSha256: prepared.planSha256,
    promotionAttestation: Object.freeze({
      path: attestationOutput.path,
      sha256: attestationOutput.sha256,
    }),
    promotionKeyId: signed.keyId,
    runnerRecord: Object.freeze({
      path: runnerOutput.path,
      sha256: runnerOutput.sha256,
    }),
    statementId: prepared.statementId,
  });
}

function createPromotionRunnerRecord({
  envelope,
  policyDescription,
  prepared,
  recordedAt,
  runnerIdentity,
  signed,
}) {
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("The promotion runner observation time is invalid.");
  }
  return {
    schemaVersion: 1,
    product: "OpenDelegate",
    role: "promotion",
    recordedAt,
    release: {
      releaseId: prepared.releaseId,
      channel: prepared.channel,
      statementId: prepared.statementId,
    },
    source: {
      buildCommit: prepared.source.buildCommit,
      releaseLogic: prepared.releaseLogic,
    },
    inputs: {
      planSha256: prepared.planSha256,
      targets: prepared.verifiedCandidates.map((release) => ({
        target: release.candidate.target,
        candidateDigest: release.candidate.publisherStatement.sha256,
        checksumManifestSha256: release.candidate.checksumManifestSha256,
        archiveSha256: release.archive.sha256,
        publisherAttestationSha256: release.publisherAttestationSha256,
        publisherKeyId: release.publisherKeyId,
      })),
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
      signingInputSha256: signed.inputSha256,
      signerExecutableSha256: signed.runner.executableSha256,
      invocationArtifactSha256: signed.runner.invocationArtifactSha256,
    },
    outputs: {
      promotionAttestation: {
        sha256: envelope.sha256,
      },
    },
  };
}

function validatePromotionInput(input) {
  requireExactKeys(
    input,
    [
      "attestationDestination",
      "planPath",
      "planSha256",
      "repositoryRoot",
      "runnerExecutableSha256",
      "runnerRecordDestination",
      "signingPolicyPath",
      "signingPolicySha256",
    ],
    "release-promotion input",
  );
  for (const [value, label] of [
    [input.attestationDestination, "promotion attestation destination"],
    [input.planPath, "promotion plan"],
    [input.repositoryRoot, "release repository"],
    [input.runnerRecordDestination, "promotion runner-record destination"],
    [input.signingPolicyPath, "promotion signing policy"],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new Error(`The ${label} path must be absolute.`);
    }
  }
  for (const [value, label] of [
    [input.planSha256, "promotion plan"],
    [input.runnerExecutableSha256, "release-runner executable"],
    [input.signingPolicySha256, "promotion signing policy"],
  ]) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`The ${label} must have a lowercase SHA-256 pin.`);
    }
  }
}

function requirePromotionIntegrityBoundary(value) {
  for (const name of [
    "composeSignedReleaseEnvelope",
    "composePromotionStatement",
    "verifyRelease",
  ]) {
    if (typeof value?.[name] !== "function") {
      throw new Error("The trusted release-integrity promotion boundary is unavailable.");
    }
  }
}

function parseExactOptions(values, supported, label) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!supported.has(name) || value === undefined || value.startsWith("--") || parsed.has(name)) {
      throw new Error(`Invalid or duplicate ${label} option: ${String(name)}.`);
    }
    parsed.set(name, value);
  }
  for (const name of supported) {
    if (!parsed.has(name)) {
      throw new Error(`${name} is required.`);
    }
  }
  return parsed;
}

function assertAbsoluteOptions(parsed, names) {
  for (const name of names) {
    if (!isAbsolute(parsed.get(name)) || parsed.get(name).includes("\0")) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
}

function assertDigestOptions(parsed, names) {
  for (const name of names) {
    if (!SHA256_PATTERN.test(parsed.get(name))) {
      throw new Error(`${name} must be a lowercase SHA-256 digest.`);
    }
  }
}

function renderHelp() {
  return `OpenDelegate cross-platform release promotion

Usage:
  pnpm release:promote -- \\
    --repository <absolute-clean-checkout> \\
    --plan <absolute-canonical-plan> --plan-sha256 <sha256> \\
    --signing-policy <absolute-policy> --signing-policy-sha256 <sha256> \\
    --attestation-destination <absolute-new-file> \\
    --runner-record-destination <absolute-new-file> \\
    --runner-executable-sha256 <sha256>
`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentFile)) {
  try {
    const parsed = parseReleasePromotionArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(renderHelp());
    } else {
      const result = await promoteRelease(parsed);
      process.stdout.write(
        `${JSON.stringify({
          planSha256: result.planSha256,
          promotionAttestationSha256: result.promotionAttestation.sha256,
          promotionKeyId: result.promotionKeyId,
          runnerRecordSha256: result.runnerRecord.sha256,
          statementId: result.statementId,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `Release promotion failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
