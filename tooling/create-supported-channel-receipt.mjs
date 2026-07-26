import { createPublicKey, verify as verifySignature } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSourceIdentity } from "./build-release.mjs";
import {
  preparePromotionAuthorization,
  promotionPreparationEvidence,
  promotionPreparationExternalRoots,
  revalidatePreparedPromotion,
} from "./release-promotion-plan.mjs";
import {
  readPinnedReleaseReadBackPlan,
  revalidatePinnedReleaseReadBackPlan,
} from "./release-read-back-plan.mjs";
import {
  assertDisjointPaths,
  assertPathAbsent,
  digestBytes,
  publishNewFileSet,
  readPinnedCanonicalJson,
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
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const currentFile = fileURLToPath(import.meta.url);

export function parseSupportedChannelReceiptArguments(values) {
  const arguments_ = values[0] === "--" ? values.slice(1) : values;
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    return { help: true };
  }
  const names = new Set([
    "--repository",
    "--promotion-plan",
    "--promotion-plan-sha256",
    "--read-back-plan",
    "--read-back-plan-sha256",
    "--signing-policy",
    "--signing-policy-sha256",
    "--receipt-destination",
    "--runner-record-destination",
    "--runner-executable-sha256",
  ]);
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!names.has(name) || value === undefined || value.startsWith("--") || parsed.has(name)) {
      throw new Error(`Invalid or duplicate supported-channel-receipt option: ${String(name)}.`);
    }
    parsed.set(name, value);
  }
  for (const name of names) {
    if (!parsed.has(name)) {
      throw new Error(`${name} is required.`);
    }
  }
  for (const name of [
    "--repository",
    "--promotion-plan",
    "--read-back-plan",
    "--signing-policy",
    "--receipt-destination",
    "--runner-record-destination",
  ]) {
    if (!isAbsolute(parsed.get(name)) || parsed.get(name).includes("\0")) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
  for (const name of [
    "--promotion-plan-sha256",
    "--read-back-plan-sha256",
    "--runner-executable-sha256",
    "--signing-policy-sha256",
  ]) {
    if (!SHA256_PATTERN.test(parsed.get(name))) {
      throw new Error(`${name} must be a lowercase SHA-256 digest.`);
    }
  }
  return {
    promotionPlanPath: resolve(parsed.get("--promotion-plan")),
    promotionPlanSha256: parsed.get("--promotion-plan-sha256"),
    readBackPlanPath: resolve(parsed.get("--read-back-plan")),
    readBackPlanSha256: parsed.get("--read-back-plan-sha256"),
    receiptDestination: resolve(parsed.get("--receipt-destination")),
    repositoryRoot: resolve(parsed.get("--repository")),
    runnerExecutableSha256: parsed.get("--runner-executable-sha256"),
    runnerRecordDestination: resolve(parsed.get("--runner-record-destination")),
    signingPolicyPath: resolve(parsed.get("--signing-policy")),
    signingPolicySha256: parsed.get("--signing-policy-sha256"),
  };
}

export async function createSupportedChannelReceipt(input, dependencies = {}) {
  validateReceiptInput(input);
  const runnerIdentity = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: input.runnerExecutableSha256,
    hashRuntimeExecutable: dependencies.hashRuntimeExecutable ?? hashCurrentNodeExecutable,
    runner: dependencies.runner ?? {
      architecture: process.arch,
      nodeVersion: process.versions.node,
      platform: process.platform,
    },
  });
  assertDisjointPaths(
    [input.receiptDestination, input.runnerRecordDestination],
    "supported-channel receipt output",
  );
  if (dirname(input.receiptDestination) !== dirname(input.runnerRecordDestination)) {
    throw new Error("Supported-channel receipt outputs must share one directory.");
  }
  await Promise.all([
    assertPathAbsent(input.receiptDestination, "A supported-channel receipt output"),
    assertPathAbsent(input.runnerRecordDestination, "A supported-channel receipt output"),
  ]);
  const integrity =
    dependencies.integrity ?? (await import("../packages/release-integrity/src/index.ts"));
  requireReceiptIntegrityBoundary(integrity);
  const prepared = await preparePromotionAuthorization(
    {
      repositoryRoot: input.repositoryRoot,
      planPath: input.promotionPlanPath,
      planSha256: input.promotionPlanSha256,
      outputPaths: [input.receiptDestination, input.runnerRecordDestination],
    },
    {
      hashReleaseLogic: dependencies.hashReleaseLogic,
      integrity,
      readSourceIdentity: dependencies.readSourceIdentity ?? readSourceIdentity,
      runningRepositoryRoot: dependencies.runningRepositoryRoot,
    },
  );
  const evidence = promotionPreparationEvidence(prepared);
  const readBack = await readPinnedReleaseReadBackPlan({
    path: input.readBackPlanPath,
    sha256: input.readBackPlanSha256,
    preparedPromotion: prepared,
    outputPaths: [input.receiptDestination, input.runnerRecordDestination],
    repositoryRoot: input.repositoryRoot,
    candidateRoots: evidence.candidates.map(({ candidateRoot }) => candidateRoot),
  });
  const promotionAttestation = await readPinnedCanonicalJson({
    label: "promotion attestation",
    maximumBytes: 4 * 1024 * 1024,
    path: readBack.promotionAttestationPath,
    sha256: readBack.promotionAttestationSha256,
    indent: 2,
  });

  const policy = await readPinnedReleaseSigningPolicy({
    expectedRole: "promotion",
    path: input.signingPolicyPath,
    sha256: input.signingPolicySha256,
  });
  assertPinnedReleaseSigningPolicyExternal(policy, promotionPreparationExternalRoots(prepared));
  const trust = getPinnedReleaseSigningTrust(policy);
  const policyDescription = describePinnedReleaseSigningPolicy(policy);
  if (trust.role !== "promotion" || policyDescription.role !== "promotion") {
    throw new Error("A supported-channel receipt requires the promotion authority.");
  }
  if (prepared.verifiedCandidates.some(({ publisherKeyId }) => publisherKeyId === trust.keyId)) {
    throw new Error("The promotion key must be distinct from every publisher key.");
  }
  if (prepared.revocations.revokedPromotionKeyIds.includes(trust.keyId)) {
    throw new Error("The promotion trust root is revoked by release policy.");
  }
  verifyExactPromotionAttestation(promotionAttestation, prepared, trust);

  await revalidateReleaseRunnerIdentity(runnerIdentity);
  const composed = integrity.composeSupportedChannelReceiptStatement({
    promotion: prepared.composed,
    promotionAttestationSha256: promotionAttestation.sha256,
    publishedAssetReadBacks: readBack.publishedAssetReadBacks,
    receiptId: readBack.receiptId,
    observedAt: readBack.observedAt,
  });
  const signed = await signWithPinnedReleasePolicy({
    policy,
    signingBytes: composed.signingBytes,
  });
  if (signed.role !== "promotion" || signed.keyId !== trust.keyId) {
    throw new Error("The external signer did not preserve the promotion authority.");
  }
  await revalidateReleaseRunnerIdentity(runnerIdentity);
  const envelope = integrity.composeSignedReleaseEnvelope({
    composed,
    keyId: signed.keyId,
    signature: signed.signature,
  });
  await verifyCompleteReleaseSetBeforeReceiptPublication({
    envelope,
    evidence,
    integrity,
    prepared,
    promotionAttestationPath: promotionAttestation.path,
    promotionTrust: trust.publicKeyPem,
    receiptPath: input.receiptDestination,
  });
  await Promise.all([
    revalidatePreparedPromotion(prepared),
    revalidatePinnedReleaseReadBackPlan(readBack),
    readPinnedCanonicalJson({
      label: "promotion attestation",
      maximumBytes: 4 * 1024 * 1024,
      path: promotionAttestation.path,
      sha256: promotionAttestation.sha256,
      indent: 2,
    }),
  ]);

  const recordedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const runnerRecord = createReceiptRunnerRecord({
    envelope,
    policyDescription,
    prepared,
    promotionAttestation,
    readBack,
    recordedAt,
    runnerIdentity,
    signed,
  });
  const runnerBytes = Buffer.from(`${JSON.stringify(runnerRecord, null, 2)}\n`, "utf8");
  const published = await (dependencies.publishOutputs ?? publishNewFileSet)(
    [
      {
        path: input.receiptDestination,
        bytes: envelope.canonicalBytes,
        mode: 0o644,
      },
      {
        path: input.runnerRecordDestination,
        bytes: runnerBytes,
        mode: 0o644,
      },
    ],
    {
      async verifyPublished() {
        await Promise.all([
          revalidatePreparedPromotion(prepared),
          revalidatePinnedReleaseReadBackPlan(readBack),
          revalidateReleaseRunnerIdentity(runnerIdentity),
          readPinnedCanonicalJson({
            label: "promotion attestation",
            maximumBytes: 4 * 1024 * 1024,
            path: promotionAttestation.path,
            sha256: promotionAttestation.sha256,
            indent: 2,
          }),
        ]);
        const currentPolicy = await readPinnedReleaseSigningPolicy({
          expectedRole: "promotion",
          path: input.signingPolicyPath,
          sha256: input.signingPolicySha256,
        });
        if (
          JSON.stringify(describePinnedReleaseSigningPolicy(currentPolicy)) !==
          JSON.stringify(policyDescription)
        ) {
          throw new Error("The receipt signing policy changed during publication.");
        }
      },
    },
  );
  if (published[0].sha256 !== envelope.sha256 || published[1].sha256 !== digestBytes(runnerBytes)) {
    throw new Error("The published supported-channel receipt outputs failed verification.");
  }
  return Object.freeze({
    promotionKeyId: signed.keyId,
    receiptId: readBack.receiptId,
    runnerRecord: Object.freeze({
      path: published[1].path,
      sha256: published[1].sha256,
    }),
    supportedChannelReceipt: Object.freeze({
      path: published[0].path,
      sha256: published[0].sha256,
    }),
  });
}

function verifyExactPromotionAttestation(attestation, prepared, trust) {
  const envelope = attestation.value;
  requireExactKeys(
    envelope,
    ["schemaVersion", "product", "role", "algorithm", "keyId", "statement", "signature"],
    "promotion attestation",
  );
  if (
    envelope.schemaVersion !== 1 ||
    envelope.product !== "OpenDelegate" ||
    envelope.role !== "promotion" ||
    envelope.algorithm !== "ed25519" ||
    envelope.keyId !== trust.keyId ||
    typeof envelope.signature !== "string" ||
    !SIGNATURE_PATTERN.test(envelope.signature) ||
    JSON.stringify(envelope.statement) !== JSON.stringify(prepared.composed.statement)
  ) {
    throw new Error("The promotion attestation does not reproduce the exact pinned promotion.");
  }
  let key;
  try {
    key = createPublicKey(trust.publicKeyPem);
  } catch (error) {
    throw new Error("The promotion trust root cannot verify the pinned attestation.", {
      cause: error,
    });
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verifySignature(
      null,
      prepared.composed.signingBytes,
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  ) {
    throw new Error("The pinned promotion attestation signature is invalid.");
  }
}

async function verifyCompleteReleaseSetBeforeReceiptPublication({
  envelope,
  evidence,
  integrity,
  prepared,
  promotionAttestationPath,
  promotionTrust,
  receiptPath,
}) {
  const reader = createOverlayReleaseReader(
    integrity.nodeReleaseFileReader,
    receiptPath,
    envelope.canonicalBytes,
  );
  for (let index = 0; index < evidence.candidates.length; index += 1) {
    const candidate = evidence.candidates[index];
    const expected = prepared.verifiedCandidates[index];
    const verified = await integrity.verifyRelease({
      reader,
      root: candidate.candidateRoot,
      expectedTarget: candidate.target,
      expectedManifestSha256: candidate.expectedManifestSha256,
      expectedCandidateDigest: candidate.expectedCandidateDigest,
      candidatePublisherEvidence: {
        archivePath: candidate.archivePath,
        attestationPath: candidate.attestationPath,
      },
      publisherTrust: { publicKeyPem: candidate.publisherTrustRoot },
      promotionAttestation: {
        attestationPath: promotionAttestationPath,
        liveEvidence: evidence.liveEvidence,
        notarizationReceiptPath: evidence.notarizationReceiptPath,
        supportMatrix: evidence.supportMatrix,
      },
      promotionReceipt: { receiptPath },
      promotionTrust: { publicKeyPem: promotionTrust },
      policy: prepared.revocations,
    });
    if (
      verified.effectiveChannel !== "released" ||
      verified.promotionStatementId !== prepared.statementId ||
      verified.receiptId !== envelope.envelope.statement.receiptId ||
      verified.archive.sha256 !== expected.archive.sha256
    ) {
      throw new Error("The trusted verifier did not reproduce the complete released target set.");
    }
  }
}

function createOverlayReleaseReader(base, overlayPath, overlayBytes) {
  if (
    typeof base?.inspect !== "function" ||
    typeof base?.inspectIfPresent !== "function" ||
    typeof base?.list !== "function" ||
    typeof base?.read !== "function" ||
    typeof base?.realPath !== "function"
  ) {
    throw new Error("The stable release-integrity file reader is unavailable.");
  }
  const matches = (path) => comparablePath(path) === comparablePath(overlayPath);
  return Object.freeze({
    async inspect(path) {
      return matches(path) ? { kind: "file", size: overlayBytes.byteLength } : base.inspect(path);
    },
    async inspectIfPresent(path) {
      return matches(path)
        ? { kind: "file", size: overlayBytes.byteLength }
        : base.inspectIfPresent(path);
    },
    async list(path) {
      return base.list(path);
    },
    async read(path, maximumBytes) {
      if (!matches(path)) {
        return base.read(path, maximumBytes);
      }
      if (overlayBytes.byteLength > maximumBytes) {
        throw new Error("The in-memory supported-channel receipt exceeds its verifier bound.");
      }
      return Uint8Array.from(overlayBytes);
    },
    async realPath(path) {
      return matches(path) ? resolve(path) : base.realPath(path);
    },
  });
}

function createReceiptRunnerRecord({
  envelope,
  policyDescription,
  prepared,
  promotionAttestation,
  readBack,
  recordedAt,
  runnerIdentity,
  signed,
}) {
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("The supported-channel receipt runner time is invalid.");
  }
  return {
    schemaVersion: 1,
    product: "OpenDelegate",
    role: "promotion",
    operation: "supported-channel-receipt",
    recordedAt,
    release: {
      releaseId: prepared.releaseId,
      channel: prepared.channel,
      tag: readBack.tag,
      promotionStatementId: prepared.statementId,
      receiptId: readBack.receiptId,
    },
    source: {
      buildCommit: prepared.source.buildCommit,
      releaseLogic: prepared.releaseLogic,
    },
    inputs: {
      promotionPlanSha256: prepared.planSha256,
      readBackPlanSha256: readBack.planSha256,
      promotionAttestationSha256: promotionAttestation.sha256,
      publication: {
        uploaderId: readBack.uploaderId,
        immutable: true,
      },
      remoteReadBacks: readBack.records,
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
      supportedChannelReceipt: {
        sha256: envelope.sha256,
      },
    },
  };
}

function validateReceiptInput(input) {
  requireExactKeys(
    input,
    [
      "promotionPlanPath",
      "promotionPlanSha256",
      "readBackPlanPath",
      "readBackPlanSha256",
      "receiptDestination",
      "repositoryRoot",
      "runnerExecutableSha256",
      "runnerRecordDestination",
      "signingPolicyPath",
      "signingPolicySha256",
    ],
    "supported-channel receipt input",
  );
  for (const [value, label] of [
    [input.promotionPlanPath, "promotion plan"],
    [input.readBackPlanPath, "read-back plan"],
    [input.receiptDestination, "supported-channel receipt destination"],
    [input.repositoryRoot, "release repository"],
    [input.runnerRecordDestination, "receipt runner-record destination"],
    [input.signingPolicyPath, "promotion signing policy"],
  ]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
      throw new Error(`The ${label} path must be absolute.`);
    }
  }
  for (const [value, label] of [
    [input.promotionPlanSha256, "promotion plan"],
    [input.readBackPlanSha256, "read-back plan"],
    [input.runnerExecutableSha256, "release-runner executable"],
    [input.signingPolicySha256, "promotion signing policy"],
  ]) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`The ${label} must have a lowercase SHA-256 pin.`);
    }
  }
}

function requireReceiptIntegrityBoundary(value) {
  for (const name of [
    "composePromotionStatement",
    "composeSignedReleaseEnvelope",
    "composeSupportedChannelReceiptStatement",
    "verifyRelease",
  ]) {
    if (typeof value?.[name] !== "function") {
      throw new Error("The trusted release-integrity receipt boundary is unavailable.");
    }
  }
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function renderHelp() {
  return `OpenDelegate supported-channel release receipt

Usage:
  pnpm release:receipt -- \\
    --repository <absolute-clean-checkout> \\
    --promotion-plan <absolute-plan> --promotion-plan-sha256 <sha256> \\
    --read-back-plan <absolute-plan> --read-back-plan-sha256 <sha256> \\
    --signing-policy <absolute-policy> --signing-policy-sha256 <sha256> \\
    --receipt-destination <absolute-new-file> \\
    --runner-record-destination <absolute-new-file> \\
    --runner-executable-sha256 <sha256>
`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(currentFile)) {
  try {
    const parsed = parseSupportedChannelReceiptArguments(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(renderHelp());
    } else {
      const result = await createSupportedChannelReceipt(parsed);
      process.stdout.write(
        `${JSON.stringify({
          promotionKeyId: result.promotionKeyId,
          receiptId: result.receiptId,
          runnerRecordSha256: result.runnerRecord.sha256,
          supportedChannelReceiptSha256: result.supportedChannelReceipt.sha256,
        })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `Supported-channel receipt failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
