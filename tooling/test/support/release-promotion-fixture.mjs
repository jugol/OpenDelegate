import { createHash, generateKeyPairSync, sign as createSignature } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  authorizeCredentialUse,
  describeCredentialAuthorization,
} from "../../release-credential-authorization.mjs";
import { createReleaseSignerBrokerFixture } from "./release-signer-broker-fixture.mjs";

export async function createPromotionToolFixture(t) {
  const [integrity, fixtures] = await Promise.all([
    import("../../../packages/release-integrity/src/index.ts"),
    import("../../../packages/release-integrity/test/support/release-fixture.ts"),
  ]);
  const releaseSet = await fixtures.createVerifiedReleaseSet();
  const root = await mkdtemp(join(tmpdir(), "opendelegate-promotion-tool-"));
  t.after(() => Promise.all([releaseSet.cleanup(), rm(root, { recursive: true, force: true })]));
  const repositoryRoot = resolve(process.cwd());
  const inputRoot = join(root, "external-input");
  const outputRoot = join(root, "output");
  await Promise.all([
    mkdir(inputRoot, { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
  ]);

  const composition = fixtures.promotionCompositionInput(releaseSet);
  const supportMatrixFile = join(inputRoot, "support-matrix.md");
  const notarizationReceiptFile = join(inputRoot, "macos-notarization.json");
  await Promise.all([
    writeFile(supportMatrixFile, composition.supportMatrix.bytes),
    writeFile(notarizationReceiptFile, composition.notarizationReceipt.bytes),
  ]);

  const liveEvidence = [];
  for (const evidence of composition.liveEvidence) {
    const file = join(inputRoot, `live-${String(evidence.criterionId).padStart(2, "0")}.json`);
    await writeFile(file, evidence.bytes);
    liveEvidence.push({
      criterionId: evidence.criterionId,
      statementPath: evidence.path,
      file: await pinnedFile(file),
    });
  }

  const candidates = [];
  for (let index = 0; index < releaseSet.releases.length; index += 1) {
    const release = releaseSet.releases[index];
    const publisher = releaseSet.publishers[index];
    const fixture = releaseSet.fixtures[index];
    const platformEvidence = composition.platformAuthenticityEvidence.find(
      ({ target }) => target.platform === release.candidate.target.platform,
    );
    const publisherTrustPath = join(
      inputRoot,
      `${release.candidate.target.platform}-publisher-public.pem`,
    );
    await writeFile(publisherTrustPath, publisher.publicKeyPem);
    const verificationEvidence = [];
    for (const evidence of platformEvidence.verificationEvidence) {
      const file = join(
        inputRoot,
        `${release.candidate.target.platform}-${evidence.path.split("/").at(-1)}`,
      );
      await writeFile(file, evidence.bytes);
      verificationEvidence.push({
        statementPath: evidence.path,
        file: await pinnedFile(file),
      });
    }
    candidates.push({
      target: release.candidate.target,
      root: fixture.root,
      expectedManifestSha256: release.candidate.checksumManifestSha256,
      expectedCandidateDigest: release.candidate.publisherStatement.sha256,
      archive: await pinnedFile(publisher.archivePath),
      publisherAttestation: await pinnedFile(publisher.attestationPath),
      publisherTrustRoot: await pinnedFile(publisherTrustPath),
      platformAuthenticity: {
        recordSha256: platformEvidence.recordSha256,
        certificateIdentities: [...platformEvidence.certificateIdentities],
        productCertificateIdentity: platformEvidence.productCertificateIdentity,
        verificationEvidence,
      },
    });
  }

  const promotionPlan = {
    schemaVersion: 1,
    product: "OpenDelegate",
    releaseId: composition.releaseId,
    channel: composition.channel,
    issuedAt: composition.issuedAt,
    statementId: composition.statementId,
    source: {
      buildCommit: releaseSet.releases[0].candidate.buildCommit,
    },
    candidates,
    supportMatrix: {
      statementPath: composition.supportMatrix.path,
      file: await pinnedFile(supportMatrixFile),
    },
    notarizationReceipt: {
      statementPath: composition.notarizationReceipt.path,
      file: await pinnedFile(notarizationReceiptFile),
    },
    liveEvidence,
    revocations: {
      revokedCertificateIdentities: [],
      revokedObserverKeyIds: [],
      revokedPromotionKeyIds: [],
      revokedPublisherKeyIds: [],
      revokedStatementIds: [],
    },
  };
  const promotionPlanPath = join(inputRoot, "promotion-plan.json");
  await writeCanonical(promotionPlanPath, promotionPlan);
  const signingKeys = generateKeyPairSync("ed25519");
  const signing = await createSigningPolicy(
    join(root, "promotion-authority"),
    "promotion",
    signingKeys,
    t,
    "promotion-authorization-v1",
  );
  const receiptSigning = await createSigningPolicy(
    join(root, "receipt-authority"),
    "promotion",
    signingKeys,
    t,
    "supported-channel-receipt-v2",
  );
  const observerKeyPair = generateKeyPairSync("ed25519");
  const observerAuthorityRoot = join(root, "observer-authority");
  const observerPublicKeyPath = join(observerAuthorityRoot, "public.pem");
  await mkdir(observerAuthorityRoot, { recursive: true });
  await writeFile(
    observerPublicKeyPath,
    observerKeyPair.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o644 },
  );
  const observerKeyId = `sha256:${sha256(
    observerKeyPair.publicKey.export({ format: "der", type: "spki" }),
  )}`;
  const runnerExecutableSha256 = await sha256File(process.execPath);
  const sourceIdentity = {
    commit: promotionPlan.source.buildCommit,
    commitEpoch: 1_753_315_324,
    dirty: false,
  };
  const gitProvenance = Object.freeze({
    description: Object.freeze({
      gitExecutableSha256: runnerExecutableSha256,
      source: Object.freeze({ ...sourceIdentity }),
    }),
  });
  const runnerDependencies = {
    async authorizeCredentialUse(input) {
      const authorization = await authorizeCredentialUse(input);
      const description = describeCredentialAuthorization(authorization);
      const authority = input.domain === "supported-channel-receipt-v2" ? receiptSigning : signing;
      authority.broker.approve(description);
      return authorization;
    },
    assertGitFilesMatchCommit: async () => {},
    hashRuntimeExecutable: async () => ({
      sha256: runnerExecutableSha256,
      size: 1,
    }),
    pinGitProvenance: async () => gitProvenance,
    revalidateGitProvenance: async () => sourceIdentity,
    runner: {
      architecture: process.arch,
      nodeVersion: "24.18.0",
      platform: process.platform,
    },
  };
  const promotionInput = {
    attestationDestination: join(outputRoot, "promotion-attestation.json"),
    gitExecutablePath: process.execPath,
    gitExecutableSha256: runnerExecutableSha256,
    planPath: promotionPlanPath,
    planSha256: await sha256File(promotionPlanPath),
    repositoryRoot,
    runnerExecutableSha256,
    runnerRecordDestination: join(outputRoot, "promotion-runner.json"),
    signingPolicyPath: signing.policyPath,
    signingPolicySha256: await sha256File(signing.policyPath),
  };

  return {
    candidates,
    composition,
    inputRoot,
    integrity,
    outputRoot,
    promotionInput,
    promotionPlan,
    promotionPlanPath,
    releaseSet,
    repositoryRoot,
    root,
    runnerDependencies,
    receiptSigning,
    signing,
    observer: {
      keyId: observerKeyId,
      keyPair: observerKeyPair,
      publicKeyPath: observerPublicKeyPath,
    },
    sourceIdentity,
    async rewritePromotionPlan(mutator) {
      const value = structuredClone(promotionPlan);
      mutator(value);
      await writeCanonical(promotionPlanPath, value);
      promotionInput.planSha256 = await sha256File(promotionPlanPath);
      return value;
    },
    async createReadBackInput(promotionResult, mutator = () => {}, observationMutator = () => {}) {
      const readBackRoot = join(inputRoot, "remote-read-back");
      await mkdir(readBackRoot, { recursive: true });
      const readBackRecords = [];
      const observationEnvelopes = [];
      for (let index = 0; index < releaseSet.releases.length; index += 1) {
        const release = releaseSet.releases[index];
        const targetName = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
        const expectedSource = {
          provider: "fixture-channel",
          immutableObjectId: `fixture/releases/${composition.releaseId}/${release.archive.path}`,
          immutableObjectVersion: `fixture-version-${targetName}`,
        };
        const observationInput = {
          archive: release.archive,
          channel: composition.channel,
          immutableObjectId: expectedSource.immutableObjectId,
          immutableObjectVersion: expectedSource.immutableObjectVersion,
          observedAt: "2026-07-26T03:00:00.000Z",
          observedStreamSha256: release.archive.sha256,
          observerAuthorityKeyId: observerKeyId,
          provider: expectedSource.provider,
          releaseId: composition.releaseId,
          tag: `v${release.candidate.productVersion}`,
          target: release.candidate.target,
          uploaderAuthorityKeyId: signing.keyId,
        };
        observationMutator(observationInput, index);
        const composedObservation =
          integrity.composeRemoteReadBackObservationStatement(observationInput);
        const observationSignature = createSignature(
          null,
          composedObservation.signingBytes,
          observerKeyPair.privateKey,
        ).toString("base64url");
        const envelope = integrity.composeSignedReleaseEnvelope({
          composed: composedObservation,
          keyId: observerKeyId,
          signature: observationSignature,
        });
        const path = join(readBackRoot, `${targetName}.json`);
        await writeFile(path, envelope.canonicalBytes);
        readBackRecords.push({
          target: release.candidate.target,
          expectedSource,
          envelope: await pinnedFile(path),
        });
        observationEnvelopes.push({ envelope, path });
      }
      const readBackPlan = {
        schemaVersion: 1,
        product: "OpenDelegate",
        releaseId: composition.releaseId,
        channel: composition.channel,
        tag: `v${releaseSet.releases[0].candidate.productVersion}`,
        receiptId: "receipt:opendelegate-v0.1.0-alpha.1:tool-0001",
        observedAt: "2026-07-26T03:01:00.000Z",
        publication: {
          uploaderAuthorityKeyId: signing.keyId,
          immutable: true,
        },
        promotion: {
          planSha256: promotionInput.planSha256,
          attestation: await pinnedFile(promotionResult.promotionAttestation.path),
        },
        readBackRecords,
      };
      mutator(readBackPlan);
      const readBackPlanPath = join(inputRoot, "read-back-plan.json");
      await writeCanonical(readBackPlanPath, readBackPlan);
      return {
        readBackPlan,
        readBackPlanPath,
        observationEnvelopes,
        input: {
          gitExecutablePath: process.execPath,
          gitExecutableSha256: runnerExecutableSha256,
          promotionPlanPath,
          promotionPlanSha256: promotionInput.planSha256,
          observerTrustRootPath: observerPublicKeyPath,
          observerTrustRootSha256: await sha256File(observerPublicKeyPath),
          readBackPlanPath,
          readBackPlanSha256: await sha256File(readBackPlanPath),
          receiptDestination: join(outputRoot, "supported-channel-receipt.json"),
          repositoryRoot,
          runnerExecutableSha256,
          runnerRecordDestination: join(outputRoot, "receipt-runner.json"),
          signingPolicyPath: receiptSigning.policyPath,
          signingPolicySha256: await sha256File(receiptSigning.policyPath),
        },
      };
    },
    async createConfigurationInput({
      mode,
      promotionResult,
      receiptResult,
      platform = "linux",
      mutator = () => {},
    }) {
      const index = releaseSet.releases.findIndex(
        (release) => release.candidate.target.platform === platform,
      );
      if (index < 0) {
        throw new Error("fixture target unavailable");
      }
      const candidate = candidates[index];
      const promotion =
        mode === "publisher-only"
          ? null
          : {
              promotionAttestation: await pinnedFile(promotionResult.promotionAttestation.path),
              supportedChannelReceipt: await pinnedFile(receiptResult.supportedChannelReceipt.path),
              promotionTrustRoot: await pinnedFile(signing.publicKeyPath),
              observerTrustRoot: await pinnedFile(receiptResult.observerTrustRoot.path),
              readBackObservations: receiptResult.readBackObservations.map(
                ({ envelopePath, envelopeSha256, target }) => ({
                  target,
                  envelope: {
                    path: envelopePath,
                    sha256: envelopeSha256,
                  },
                }),
              ),
              supportMatrix: structuredClone(promotionPlan.supportMatrix),
              notarizationReceipt: structuredClone(promotionPlan.notarizationReceipt),
              liveEvidence: structuredClone(promotionPlan.liveEvidence),
            };
      const configurationPlan = {
        schemaVersion: 1,
        product: "OpenDelegate",
        mode,
        source: {
          buildCommit: sourceIdentity.commit,
        },
        candidate: {
          target: structuredClone(candidate.target),
          root: candidate.root,
          expectedManifestSha256: candidate.expectedManifestSha256,
          expectedCandidateDigest: candidate.expectedCandidateDigest,
          archive: structuredClone(candidate.archive),
          publisherAttestation: structuredClone(candidate.publisherAttestation),
          publisherTrustRoot: structuredClone(candidate.publisherTrustRoot),
        },
        promotion,
        policy: structuredClone(promotionPlan.revocations),
      };
      mutator(configurationPlan);
      const planPath = join(inputRoot, `configuration-${mode}-${platform}.json`);
      await writeCanonical(planPath, configurationPlan);
      return {
        configurationPlan,
        planPath,
        input: {
          destinationRoot: join(root, `configured-${mode}-${platform}`),
          gitExecutablePath: process.execPath,
          gitExecutableSha256: runnerExecutableSha256,
          planPath,
          planSha256: await sha256File(planPath),
          repositoryRoot,
          runnerExecutableSha256,
        },
      };
    },
  };
}

export async function createSigningPolicy(
  root,
  role,
  keyPair = generateKeyPairSync("ed25519"),
  t,
  domain = role === "promotion" ? "promotion-authorization-v1" : "publisher-attestation-v2",
) {
  if (typeof t?.after !== "function") {
    throw new Error("The release-signing fixture requires a test cleanup context.");
  }
  await mkdir(root, { recursive: true });
  const broker = await createReleaseSignerBrokerFixture(t, {
    domain,
    releaseKeys: keyPair,
    role,
  });
  const publicKeyPath = join(root, "public.pem");
  const transportPublicKeyPath = join(root, "transport-public.pem");
  const policyPath = join(root, "policy.json");
  await Promise.all([
    writeFile(publicKeyPath, broker.releasePublicKeyPem, { mode: 0o644 }),
    writeFile(transportPublicKeyPath, broker.transportPublicKeyPem, { mode: 0o644 }),
  ]);
  const policy = {
    schemaVersion: 2,
    product: "OpenDelegate",
    role,
    publicKey: {
      path: publicKeyPath,
      sha256: await sha256File(publicKeyPath),
    },
    broker: {
      protocol: "opendelegate.release.signer-broker.v1",
      endpoint: broker.endpoint,
      transportPublicKey: {
        path: transportPublicKeyPath,
        sha256: await sha256File(transportPublicKeyPath),
      },
      timeoutMs: 30_000,
    },
  };
  await writeCanonical(policyPath, policy);
  broker.setPolicySha256(await sha256File(policyPath));
  return {
    broker,
    endpoint: broker.endpoint,
    keyId: broker.releaseKeyId,
    policyPath,
    publicKeyPath,
    get requests() {
      return [...broker.authorizationRequests, ...broker.signRequests];
    },
    root,
    transportKeyId: broker.transportKeyId,
    transportPublicKeyPath,
  };
}

export async function pinnedFile(path) {
  return { path, sha256: await sha256File(path) };
}

export async function writeCanonical(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
