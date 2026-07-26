import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
      revokedPromotionKeyIds: [],
      revokedPublisherKeyIds: [],
      revokedStatementIds: [],
    },
  };
  const promotionPlanPath = join(inputRoot, "promotion-plan.json");
  await writeCanonical(promotionPlanPath, promotionPlan);
  const signing = await createSigningPolicy(join(root, "promotion-authority"), "promotion");
  const runnerExecutableSha256 = await sha256File(process.execPath);
  const runnerDependencies = {
    hashRuntimeExecutable: async () => ({
      sha256: runnerExecutableSha256,
      size: 1,
    }),
    runner: {
      architecture: process.arch,
      nodeVersion: "24.18.0",
      platform: process.platform,
    },
  };
  const sourceIdentity = {
    commit: promotionPlan.source.buildCommit,
    commitEpoch: 1_753_315_324,
    dirty: false,
  };
  const promotionInput = {
    attestationDestination: join(outputRoot, "promotion-attestation.json"),
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
    signing,
    sourceIdentity,
    async rewritePromotionPlan(mutator) {
      const value = structuredClone(promotionPlan);
      mutator(value);
      await writeCanonical(promotionPlanPath, value);
      promotionInput.planSha256 = await sha256File(promotionPlanPath);
      return value;
    },
    async createReadBackInput(promotionResult, mutator = () => {}) {
      const readBackRoot = join(inputRoot, "remote-read-back");
      await mkdir(readBackRoot, { recursive: true });
      const readBackRecords = [];
      for (const release of releaseSet.releases) {
        const targetName = `${release.candidate.target.platform}-${release.candidate.target.architecture}`;
        const record = {
          schemaVersion: 1,
          product: "OpenDelegate",
          type: "independent-remote-read-back",
          releaseId: composition.releaseId,
          channel: composition.channel,
          tag: `v${release.candidate.productVersion}`,
          target: release.candidate.target,
          asset: release.archive,
          source: {
            provider: "fixture-channel",
            immutableObjectId: `fixture/releases/${composition.releaseId}/${release.archive.path}`,
            readerId: `fixture-read-back-${targetName}`,
          },
          readBackSha256: release.archive.sha256,
          observedAt: "2026-07-26T03:00:00.000Z",
        };
        const path = join(readBackRoot, `${targetName}.json`);
        await writeCanonical(path, record);
        readBackRecords.push({
          target: release.candidate.target,
          file: await pinnedFile(path),
        });
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
          uploaderId: "fixture-uploader",
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
        input: {
          promotionPlanPath,
          promotionPlanSha256: promotionInput.planSha256,
          readBackPlanPath,
          readBackPlanSha256: await sha256File(readBackPlanPath),
          receiptDestination: join(outputRoot, "supported-channel-receipt.json"),
          repositoryRoot,
          runnerExecutableSha256,
          runnerRecordDestination: join(outputRoot, "receipt-runner.json"),
          signingPolicyPath: signing.policyPath,
          signingPolicySha256: await sha256File(signing.policyPath),
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
          planPath,
          planSha256: await sha256File(planPath),
          repositoryRoot,
          runnerExecutableSha256,
        },
      };
    },
  };
}

export async function createSigningPolicy(root, role, keyPair = generateKeyPairSync("ed25519")) {
  await mkdir(root, { recursive: true });
  const privateKeyPath = join(root, "external-private.pem");
  const publicKeyPath = join(root, "public.pem");
  const helperPath = join(root, "signer-helper.mjs");
  const policyPath = join(root, "policy.json");
  await writeFile(privateKeyPath, keyPair.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyPath, keyPair.publicKey.export({ format: "pem", type: "spki" }), {
    mode: 0o644,
  });
  await writeFile(
    helperPath,
    `import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const chunks = [];
let total = 0;
for await (const chunk of process.stdin) {
  total += chunk.byteLength;
  if (total > 4 * 1024 * 1024) throw new Error("oversized");
  chunks.push(chunk);
}
const privateKey = createPrivateKey(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "external-private.pem")),
);
const publicKey = createPublicKey(privateKey);
process.stdout.write(\`\${JSON.stringify({
  schemaVersion: 1,
  algorithm: "ed25519",
  keyId: \`sha256:\${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex")}\`,
  signature: sign(null, Buffer.concat(chunks, total), privateKey).toString("base64url"),
})}\\n\`);
`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") {
    await Promise.all([
      chmod(privateKeyPath, 0o600),
      chmod(publicKeyPath, 0o644),
      chmod(helperPath, 0o700),
    ]);
  }
  const policy = {
    schemaVersion: 1,
    product: "OpenDelegate",
    role,
    publicKey: {
      path: publicKeyPath,
      sha256: await sha256File(publicKeyPath),
    },
    signer: {
      executable: {
        path: process.execPath,
        sha256: await sha256File(process.execPath),
      },
      invocationArtifacts: [
        {
          path: helperPath,
          sha256: await sha256File(helperPath),
        },
      ],
      timeoutMs: 30_000,
    },
  };
  await writeCanonical(policyPath, policy);
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  return {
    helperPath,
    keyId: `sha256:${sha256(publicKeyDer)}`,
    policyPath,
    privateKeyPath,
    publicKeyPath,
    root,
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
