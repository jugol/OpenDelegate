import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { parseReleasePromotionArguments } from "../promote-release.mjs";
import { parseSupportedChannelReceiptArguments } from "../create-supported-channel-receipt.mjs";
import {
  createPromotionToolFixture,
  createSigningPolicy,
  sha256File,
  writeCanonical,
} from "./support/release-promotion-fixture.mjs";
import {
  hashStableRegularFile,
  publishNewFileSet,
  readPinnedBytes,
  requireCanonicalDirectory,
} from "../release-tooling-io.mjs";
import { hashPromotionReleaseLogic } from "../release-promotion-plan.mjs";
import {
  pinReleaseRunnerIdentity,
  revalidateReleaseRunnerIdentity,
} from "../release-runner-identity.mjs";

const supportsTypeStripping =
  process.versions.node.startsWith("24.") ||
  process.execArgv.includes("--experimental-strip-types");

test("promotion and receipt CLIs require exact absolute hash-pinned inputs", () => {
  const root = process.cwd();
  assert.deepEqual(
    parseReleasePromotionArguments([
      "--",
      "--repository",
      root,
      "--plan",
      join(root, "promotion-plan.json"),
      "--plan-sha256",
      "a".repeat(64),
      "--signing-policy",
      join(root, "promotion-policy.json"),
      "--signing-policy-sha256",
      "b".repeat(64),
      "--attestation-destination",
      join(root, "promotion.json"),
      "--runner-record-destination",
      join(root, "promotion-runner.json"),
      "--runner-executable-sha256",
      "d".repeat(64),
    ]),
    {
      attestationDestination: join(root, "promotion.json"),
      planPath: join(root, "promotion-plan.json"),
      planSha256: "a".repeat(64),
      repositoryRoot: root,
      runnerExecutableSha256: "d".repeat(64),
      runnerRecordDestination: join(root, "promotion-runner.json"),
      signingPolicyPath: join(root, "promotion-policy.json"),
      signingPolicySha256: "b".repeat(64),
    },
  );
  assert.deepEqual(
    parseSupportedChannelReceiptArguments([
      "--",
      "--repository",
      root,
      "--promotion-plan",
      join(root, "promotion-plan.json"),
      "--promotion-plan-sha256",
      "a".repeat(64),
      "--read-back-plan",
      join(root, "read-back-plan.json"),
      "--read-back-plan-sha256",
      "b".repeat(64),
      "--signing-policy",
      join(root, "promotion-policy.json"),
      "--signing-policy-sha256",
      "c".repeat(64),
      "--receipt-destination",
      join(root, "receipt.json"),
      "--runner-record-destination",
      join(root, "receipt-runner.json"),
      "--runner-executable-sha256",
      "d".repeat(64),
    ]),
    {
      promotionPlanPath: join(root, "promotion-plan.json"),
      promotionPlanSha256: "a".repeat(64),
      readBackPlanPath: join(root, "read-back-plan.json"),
      readBackPlanSha256: "b".repeat(64),
      receiptDestination: join(root, "receipt.json"),
      repositoryRoot: root,
      runnerExecutableSha256: "d".repeat(64),
      runnerRecordDestination: join(root, "receipt-runner.json"),
      signingPolicyPath: join(root, "promotion-policy.json"),
      signingPolicySha256: "c".repeat(64),
    },
  );

  assert.throws(
    () =>
      parseReleasePromotionArguments([
        "--repository",
        root,
        "--plan",
        "relative.json",
        "--plan-sha256",
        "a".repeat(64),
        "--signing-policy",
        join(root, "promotion-policy.json"),
        "--signing-policy-sha256",
        "b".repeat(64),
        "--attestation-destination",
        join(root, "promotion.json"),
        "--runner-record-destination",
        join(root, "promotion-runner.json"),
        "--runner-executable-sha256",
        "d".repeat(64),
      ]),
    /absolute/u,
  );
  assert.throws(
    () =>
      parseSupportedChannelReceiptArguments([
        "--repository",
        root,
        "--promotion-plan",
        join(root, "promotion-plan.json"),
        "--promotion-plan-sha256",
        "not-a-digest",
        "--read-back-plan",
        join(root, "read-back-plan.json"),
        "--read-back-plan-sha256",
        "b".repeat(64),
        "--signing-policy",
        join(root, "promotion-policy.json"),
        "--signing-policy-sha256",
        "c".repeat(64),
        "--receipt-destination",
        join(root, "receipt.json"),
        "--runner-record-destination",
        join(root, "receipt-runner.json"),
        "--runner-executable-sha256",
        "d".repeat(64),
      ]),
    /SHA-256/u,
  );
  assert.throws(
    () => parseReleasePromotionArguments(["--private-key", join(root, "secret.pem")]),
    /Invalid or duplicate/u,
  );
  assert.deepEqual(parseReleasePromotionArguments(["--help"]), { help: true });
  assert.deepEqual(parseSupportedChannelReceiptArguments(["-h"]), { help: true });
});

test("create-new release output sets roll back every linked file after a partial failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-output-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await assert.rejects(
    publishNewFileSet(
      [
        { path: first, bytes: Buffer.from("first\n", "utf8"), mode: 0o644 },
        { path: second, bytes: Buffer.from("second\n", "utf8"), mode: 0o644 },
      ],
      {
        afterPublish(index) {
          if (index === 0) {
            throw new Error("fixture interruption");
          }
        },
      },
    ),
    /fixture interruption/u,
  );
  assert.deepEqual(await readdir(root), []);
});

test("release-security paths reject regular files, directories, and outputs behind linked ancestors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-linked-release-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = join(root, "canonical");
  const canonicalChild = join(canonicalRoot, "child");
  const aliasRoot = join(root, "alias");
  await mkdir(canonicalChild, { recursive: true });
  const inputPath = join(canonicalChild, "input.json");
  await writeFile(inputPath, "{}\n", "utf8");
  await createDirectoryAlias(aliasRoot, canonicalRoot);
  const aliasedInput = join(aliasRoot, "child", "input.json");

  await assert.rejects(
    readPinnedBytes({
      label: "linked-ancestor fixture",
      path: aliasedInput,
      sha256: await sha256File(inputPath),
    }),
    /canonical path|linked ancestor/iu,
  );
  await assert.rejects(hashStableRegularFile(aliasedInput), /canonical path|linked ancestor/iu);
  await assert.rejects(
    requireCanonicalDirectory(join(aliasRoot, "child"), "linked-ancestor fixture directory"),
    /canonical path|linked ancestor/iu,
  );
  await assert.rejects(
    publishNewFileSet([
      {
        path: join(aliasRoot, "child", "output.json"),
        bytes: Buffer.from("{}\n", "utf8"),
        mode: 0o644,
      },
      {
        path: join(aliasRoot, "child", "runner.json"),
        bytes: Buffer.from("{}\n", "utf8"),
        mode: 0o644,
      },
    ]),
    /canonical path|linked ancestor/iu,
  );

  const canonicalMetadata = await lstat(canonicalChild, { bigint: true });
  const alternateCanonicalSpelling = join(root, "RUNNER~1", "child");
  assert.equal(
    await requireCanonicalDirectory(canonicalChild, "Windows alias fixture", {
      canonicalLstat: async () => canonicalMetadata,
      realPath: async () => alternateCanonicalSpelling,
    }),
    alternateCanonicalSpelling,
  );
});

test("the promotion runner hash inventory covers every executable authorization module", async () => {
  const paths = new Set((await hashPromotionReleaseLogic()).map(({ path }) => path));
  for (const path of [
    "packages/release-integrity/src/configured-release.ts",
    "packages/release-integrity/src/index.ts",
    "packages/release-integrity/src/stable-node-file-read.ts",
    "tooling/build-release.mjs",
    "tooling/configure-release.mjs",
    "tooling/create-supported-channel-receipt.mjs",
    "tooling/external-release-signer.mjs",
    "tooling/promote-release.mjs",
    "tooling/release-promotion-plan.mjs",
    "tooling/release-read-back-plan.mjs",
    "tooling/release-runner-identity.mjs",
    "tooling/release-signing-policy.mjs",
    "tooling/release-tooling-io.mjs",
  ]) {
    assert.equal(paths.has(path), true, `${path} is missing from the runner hash inventory`);
  }
});

test("credential-bearing tools require the exact pinned Node runner before and after work", async () => {
  const expected = "a".repeat(64);
  const handle = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: expected,
    hashRuntimeExecutable: async () => ({ sha256: expected, size: 123 }),
    runner: {
      architecture: "x64",
      nodeVersion: "24.18.0",
      platform: "linux",
    },
  });
  assert.deepEqual(handle.description, {
    architecture: "x64",
    nodeVersion: "24.18.0",
    platform: "linux",
    runtimeExecutableSha256: expected,
  });
  await revalidateReleaseRunnerIdentity(handle);

  await assert.rejects(
    pinReleaseRunnerIdentity({
      expectedExecutableSha256: expected,
      hashRuntimeExecutable: async () => ({ sha256: expected, size: 123 }),
      runner: {
        architecture: "x64",
        nodeVersion: "22.14.0",
        platform: "linux",
      },
    }),
    /Node.js 24.18.0/u,
  );
  await assert.rejects(
    pinReleaseRunnerIdentity({
      expectedExecutableSha256: expected,
      hashRuntimeExecutable: async () => ({ sha256: "b".repeat(64), size: 123 }),
      runner: {
        architecture: "x64",
        nodeVersion: "24.18.0",
        platform: "linux",
      },
    }),
    /executable.*pin/u,
  );

  let mutableDigest = expected;
  const mutableHandle = await pinReleaseRunnerIdentity({
    expectedExecutableSha256: expected,
    hashRuntimeExecutable: async () => ({ sha256: mutableDigest, size: 123 }),
    runner: {
      architecture: "x64",
      nodeVersion: "24.18.0",
      platform: "linux",
    },
  });
  mutableDigest = "c".repeat(64);
  await assert.rejects(revalidateReleaseRunnerIdentity(mutableHandle), /executable.*pin/u);
});

test(
  "release authorization CLIs fail closed on an unsupported Node runner",
  { skip: process.versions.node === "24.18.0" },
  () => {
    const root = process.cwd();
    const digest = "a".repeat(64);
    const cases = [
      {
        script: join(root, "tooling", "promote-release.mjs"),
        arguments: [
          "--repository",
          root,
          "--plan",
          join(root, "promotion-plan.json"),
          "--plan-sha256",
          digest,
          "--signing-policy",
          join(root, "promotion-policy.json"),
          "--signing-policy-sha256",
          digest,
          "--attestation-destination",
          join(root, "promotion.json"),
          "--runner-record-destination",
          join(root, "promotion-runner.json"),
          "--runner-executable-sha256",
          digest,
        ],
      },
      {
        script: join(root, "tooling", "configure-release.mjs"),
        arguments: [
          "--repository",
          root,
          "--plan",
          join(root, "configuration-plan.json"),
          "--plan-sha256",
          digest,
          "--destination-root",
          join(root, "configuration-output"),
          "--runner-executable-sha256",
          digest,
        ],
      },
      {
        script: join(root, "tooling", "create-supported-channel-receipt.mjs"),
        arguments: [
          "--repository",
          root,
          "--promotion-plan",
          join(root, "promotion-plan.json"),
          "--promotion-plan-sha256",
          digest,
          "--read-back-plan",
          join(root, "read-back-plan.json"),
          "--read-back-plan-sha256",
          digest,
          "--signing-policy",
          join(root, "promotion-policy.json"),
          "--signing-policy-sha256",
          digest,
          "--receipt-destination",
          join(root, "receipt.json"),
          "--runner-record-destination",
          join(root, "receipt-runner.json"),
          "--runner-executable-sha256",
          digest,
        ],
      },
    ];

    for (const entry of cases) {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", entry.script, ...entry.arguments],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pinned Node\.js 24\.18\.0 runner/u);
    }
  },
);

test(
  "promotion verifies the complete real target set and emits only a signed envelope and sanitized record",
  { skip: !supportsTypeStripping },
  async (t) => {
    const fixture = await createPromotionToolFixture(t);
    const { promoteRelease } = await import("../promote-release.mjs");
    const result = await promoteRelease(fixture.promotionInput, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      now: () => new Date("2026-07-26T02:30:00.000Z"),
      readSourceIdentity: async () => fixture.sourceIdentity,
    });

    assert.equal(result.promotionKeyId, fixture.signing.keyId);
    assert.equal(
      fixture.releaseSet.publishers.some(({ keyId }) => keyId === result.promotionKeyId),
      false,
    );
    assert.equal(
      result.promotionAttestation.sha256,
      await sha256File(result.promotionAttestation.path),
    );
    const envelope = JSON.parse(await readFile(result.promotionAttestation.path, "utf8"));
    assert.equal(envelope.role, "promotion");
    assert.equal(envelope.statement.domain, "opendelegate.release.promotion-authorization.v1");
    assert.deepEqual(
      envelope.statement.targets.map(({ target }) => target),
      [
        { platform: "darwin", architecture: "arm64" },
        { platform: "linux", architecture: "x64" },
        { platform: "win32", architecture: "x64" },
      ],
    );
    assert.equal(envelope.statement.liveEvidence.length, 36);

    const recordText = await readFile(result.runnerRecord.path, "utf8");
    const runnerRecord = JSON.parse(recordText);
    assert.equal(runnerRecord.role, "promotion");
    assert.equal(runnerRecord.source.buildCommit, fixture.sourceIdentity.commit);
    assert.equal(runnerRecord.inputs.planSha256, fixture.promotionInput.planSha256);
    assert.equal(
      runnerRecord.outputs.promotionAttestation.sha256,
      result.promotionAttestation.sha256,
    );
    assert.equal(recordText.includes(fixture.root), false);
    assert.equal(recordText.includes("PRIVATE KEY"), false);
    assert.deepEqual(
      (await readdir(fixture.outputRoot)).sort(),
      ["promotion-attestation.json", "promotion-runner.json"].sort(),
    );
  },
);

test(
  "promotion rejects tamper, revoked authority, reused publisher authority, dirty B, and partial output",
  { skip: !supportsTypeStripping },
  async (t) => {
    const { promoteRelease } = await import("../promote-release.mjs");

    const tampered = await createPromotionToolFixture(t);
    await writeFile(tampered.promotionPlan.supportMatrix.file.path, "changed\n", "utf8");
    await assert.rejects(
      promoteRelease(tampered.promotionInput, {
        ...tampered.runnerDependencies,
        integrity: tampered.integrity,
        readSourceIdentity: async () => tampered.sourceIdentity,
      }),
      /SHA-256.*pin|digest.*pin/iu,
    );
    assert.deepEqual(await readdir(tampered.outputRoot), []);

    const revoked = await createPromotionToolFixture(t);
    await revoked.rewritePromotionPlan((plan) => {
      plan.revocations.revokedPromotionKeyIds.push(revoked.signing.keyId);
    });
    await assert.rejects(
      promoteRelease(revoked.promotionInput, {
        ...revoked.runnerDependencies,
        integrity: revoked.integrity,
        readSourceIdentity: async () => revoked.sourceIdentity,
      }),
      /revoked/u,
    );
    assert.deepEqual(await readdir(revoked.outputRoot), []);

    const reused = await createPromotionToolFixture(t);
    const publisher = reused.releaseSet.publishers[0];
    const signing = await createSigningPolicy(join(reused.root, "reused-authority"), "promotion", {
      privateKey: publisher.privateKey,
      publicKey: createPublicKey(publisher.privateKey),
    });
    reused.promotionInput.signingPolicyPath = signing.policyPath;
    reused.promotionInput.signingPolicySha256 = await sha256File(signing.policyPath);
    await assert.rejects(
      promoteRelease(reused.promotionInput, {
        ...reused.runnerDependencies,
        integrity: reused.integrity,
        readSourceIdentity: async () => reused.sourceIdentity,
      }),
      /distinct from every publisher/u,
    );
    assert.deepEqual(await readdir(reused.outputRoot), []);

    const dirty = await createPromotionToolFixture(t);
    await assert.rejects(
      promoteRelease(dirty.promotionInput, {
        ...dirty.runnerDependencies,
        integrity: dirty.integrity,
        readSourceIdentity: async () => ({ ...dirty.sourceIdentity, dirty: true }),
      }),
      /clean committed build source/u,
    );
    assert.deepEqual(await readdir(dirty.outputRoot), []);

    const changedLogic = await createPromotionToolFixture(t);
    let logicReads = 0;
    await assert.rejects(
      promoteRelease(changedLogic.promotionInput, {
        ...changedLogic.runnerDependencies,
        hashReleaseLogic: async () => [
          {
            path: "tooling/promote-release.mjs",
            sha256: `${String(logicReads++).padStart(64, "0")}`,
          },
        ],
        integrity: changedLogic.integrity,
        readSourceIdentity: async () => changedLogic.sourceIdentity,
      }),
      /release-promotion logic changed/u,
    );
    assert.deepEqual(await readdir(changedLogic.outputRoot), []);

    const wrongRole = await createPromotionToolFixture(t);
    const publisherPolicy = await createSigningPolicy(
      join(wrongRole.root, "wrong-role-authority"),
      "publisher",
    );
    wrongRole.promotionInput.signingPolicyPath = publisherPolicy.policyPath;
    wrongRole.promotionInput.signingPolicySha256 = await sha256File(publisherPolicy.policyPath);
    await assert.rejects(
      promoteRelease(wrongRole.promotionInput, {
        ...wrongRole.runnerDependencies,
        integrity: wrongRole.integrity,
        readSourceIdentity: async () => wrongRole.sourceIdentity,
      }),
      /role does not match/u,
    );
    assert.deepEqual(await readdir(wrongRole.outputRoot), []);

    const incomplete = await createPromotionToolFixture(t);
    await incomplete.rewritePromotionPlan((plan) => {
      plan.candidates.pop();
    });
    await assert.rejects(
      promoteRelease(incomplete.promotionInput, {
        ...incomplete.runnerDependencies,
        integrity: incomplete.integrity,
        readSourceIdentity: async () => incomplete.sourceIdentity,
      }),
      /exact first-milestone target set/u,
    );
    assert.deepEqual(await readdir(incomplete.outputRoot), []);

    const occupied = await createPromotionToolFixture(t);
    await mkdir(dirname(occupied.promotionInput.runnerRecordDestination), { recursive: true });
    await writeFile(occupied.promotionInput.runnerRecordDestination, "owner data\n", "utf8");
    await assert.rejects(
      promoteRelease(occupied.promotionInput, {
        ...occupied.runnerDependencies,
        integrity: occupied.integrity,
        readSourceIdentity: async () => occupied.sourceIdentity,
      }),
      /already exists; nothing was overwritten/u,
    );
    assert.equal(
      await readFile(occupied.promotionInput.runnerRecordDestination, "utf8"),
      "owner data\n",
    );
    assert.equal(
      (await readdir(occupied.outputRoot)).includes("promotion-attestation.json"),
      false,
    );

    const linkedTrust = await createPromotionToolFixture(t);
    const firstCandidateRoot = linkedTrust.candidates[0].root;
    const masqueradingTrust = join(firstCandidateRoot, "masquerading-publisher-public.pem");
    await writeFile(
      masqueradingTrust,
      await readFile(linkedTrust.promotionPlan.candidates[0].publisherTrustRoot.path),
    );
    const linkedTrustRoot = join(linkedTrust.root, "linked-trust-root");
    await createDirectoryAlias(linkedTrustRoot, firstCandidateRoot);
    await linkedTrust.rewritePromotionPlan((plan) => {
      plan.candidates[0].publisherTrustRoot = {
        path: join(linkedTrustRoot, "masquerading-publisher-public.pem"),
        sha256: plan.candidates[0].publisherTrustRoot.sha256,
      };
    });
    await assert.rejects(
      promoteRelease(linkedTrust.promotionInput, {
        ...linkedTrust.runnerDependencies,
        integrity: linkedTrust.integrity,
        readSourceIdentity: async () => linkedTrust.sourceIdentity,
      }),
      /canonical path|linked ancestor/iu,
    );
    assert.deepEqual(await readdir(linkedTrust.outputRoot), []);
  },
);

test(
  "receipt recomposes the exact promotion, accepts independent read-back records, and proves released",
  { skip: !supportsTypeStripping },
  async (t) => {
    const fixture = await createPromotionToolFixture(t);
    const [{ promoteRelease }, { createSupportedChannelReceipt }] = await Promise.all([
      import("../promote-release.mjs"),
      import("../create-supported-channel-receipt.mjs"),
    ]);
    const promotion = await promoteRelease(fixture.promotionInput, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      now: () => new Date("2026-07-26T02:30:00.000Z"),
      readSourceIdentity: async () => fixture.sourceIdentity,
    });
    const readBack = await fixture.createReadBackInput(promotion);
    const receipt = await createSupportedChannelReceipt(readBack.input, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      now: () => new Date("2026-07-26T03:02:00.000Z"),
      readSourceIdentity: async () => fixture.sourceIdentity,
    });

    assert.equal(receipt.promotionKeyId, fixture.signing.keyId);
    assert.equal(
      receipt.supportedChannelReceipt.sha256,
      await sha256File(receipt.supportedChannelReceipt.path),
    );
    const envelope = JSON.parse(await readFile(receipt.supportedChannelReceipt.path, "utf8"));
    assert.equal(envelope.statement.domain, "opendelegate.release.supported-channel-receipt.v1");
    assert.equal(envelope.statement.channel, fixture.composition.channel);
    assert.equal(envelope.statement.tag, "v0.1.0-alpha.1");
    assert.equal(envelope.statement.publishedAssets.length, 3);

    for (let index = 0; index < fixture.releaseSet.releases.length; index += 1) {
      const release = fixture.releaseSet.releases[index];
      const publisher = fixture.releaseSet.publishers[index];
      const candidateFixture = fixture.releaseSet.fixtures[index];
      const verified = await fixture.integrity.verifyRelease({
        root: candidateFixture.root,
        expectedTarget: release.candidate.target,
        expectedManifestSha256: release.candidate.checksumManifestSha256,
        expectedCandidateDigest: release.candidate.publisherStatement.sha256,
        candidatePublisherEvidence: {
          archivePath: publisher.archivePath,
          attestationPath: publisher.attestationPath,
        },
        publisherTrust: { publicKeyPem: publisher.publicKeyPem },
        promotionAttestation: {
          attestationPath: promotion.promotionAttestation.path,
          liveEvidence: fixture.composition.liveEvidence,
          notarizationReceiptPath: fixture.promotionPlan.notarizationReceipt.file.path,
          supportMatrix: fixture.composition.supportMatrix,
        },
        promotionReceipt: { receiptPath: receipt.supportedChannelReceipt.path },
        promotionTrust: { publicKeyPem: await readFile(fixture.signing.publicKeyPath) },
      });
      assert.equal(verified.effectiveChannel, "released");
    }

    const recordText = await readFile(receipt.runnerRecord.path, "utf8");
    assert.equal(recordText.includes(fixture.root), false);
    assert.equal(recordText.includes("PRIVATE KEY"), false);
  },
);

test(
  "receipt rejects non-independent, tampered, revoked, mismatched, and partial read-back output",
  { skip: !supportsTypeStripping },
  async (t) => {
    const [{ promoteRelease }, { createSupportedChannelReceipt }] = await Promise.all([
      import("../promote-release.mjs"),
      import("../create-supported-channel-receipt.mjs"),
    ]);

    const independent = await createPromotionToolFixture(t);
    const firstPromotion = await promoteRelease(independent.promotionInput, {
      ...independent.runnerDependencies,
      integrity: independent.integrity,
      readSourceIdentity: async () => independent.sourceIdentity,
    });
    const nonIndependent = await independent.createReadBackInput(firstPromotion, (plan) => {
      plan.publication.uploaderId = "fixture-read-back-darwin-arm64";
    });
    await assert.rejects(
      createSupportedChannelReceipt(nonIndependent.input, {
        ...independent.runnerDependencies,
        integrity: independent.integrity,
        readSourceIdentity: async () => independent.sourceIdentity,
      }),
      /independent/u,
    );
    assert.equal(
      (await readdir(independent.outputRoot)).includes("supported-channel-receipt.json"),
      false,
    );

    const revoked = await createPromotionToolFixture(t);
    await revoked.rewritePromotionPlan((plan) => {
      plan.revocations.revokedStatementIds.push("receipt:opendelegate-v0.1.0-alpha.1:tool-0001");
    });
    const revokedPromotion = await promoteRelease(revoked.promotionInput, {
      ...revoked.runnerDependencies,
      integrity: revoked.integrity,
      readSourceIdentity: async () => revoked.sourceIdentity,
    });
    const revokedReadBack = await revoked.createReadBackInput(revokedPromotion);
    await assert.rejects(
      createSupportedChannelReceipt(revokedReadBack.input, {
        ...revoked.runnerDependencies,
        integrity: revoked.integrity,
        readSourceIdentity: async () => revoked.sourceIdentity,
      }),
      /revoked/u,
    );
    assert.equal(
      (await readdir(revoked.outputRoot)).includes("supported-channel-receipt.json"),
      false,
    );

    const tampered = await createPromotionToolFixture(t);
    const tamperedPromotion = await promoteRelease(tampered.promotionInput, {
      ...tampered.runnerDependencies,
      integrity: tampered.integrity,
      readSourceIdentity: async () => tampered.sourceIdentity,
    });
    const tamperedReadBack = await tampered.createReadBackInput(tamperedPromotion);
    const firstRecord = tamperedReadBack.readBackPlan.readBackRecords[0].file.path;
    const record = JSON.parse(await readFile(firstRecord, "utf8"));
    record.readBackSha256 = "0".repeat(64);
    await writeFile(firstRecord, `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(
      createSupportedChannelReceipt(tamperedReadBack.input, {
        ...tampered.runnerDependencies,
        integrity: tampered.integrity,
        readSourceIdentity: async () => tampered.sourceIdentity,
      }),
      /SHA-256.*pin|digest.*pin/iu,
    );

    const recomposed = await createPromotionToolFixture(t);
    const recomposedPromotion = await promoteRelease(recomposed.promotionInput, {
      ...recomposed.runnerDependencies,
      integrity: recomposed.integrity,
      readSourceIdentity: async () => recomposed.sourceIdentity,
    });
    const recomposedReadBack = await recomposed.createReadBackInput(recomposedPromotion);
    const promotionEnvelope = JSON.parse(
      await readFile(recomposedPromotion.promotionAttestation.path, "utf8"),
    );
    promotionEnvelope.statement.channel = "beta";
    await writeFile(
      recomposedPromotion.promotionAttestation.path,
      `${JSON.stringify(promotionEnvelope, null, 2)}\n`,
      "utf8",
    );
    recomposedReadBack.readBackPlan.promotion.attestation.sha256 = await sha256File(
      recomposedPromotion.promotionAttestation.path,
    );
    await writeCanonical(recomposedReadBack.readBackPlanPath, recomposedReadBack.readBackPlan);
    recomposedReadBack.input.readBackPlanSha256 = await sha256File(
      recomposedReadBack.readBackPlanPath,
    );
    await assert.rejects(
      createSupportedChannelReceipt(recomposedReadBack.input, {
        ...recomposed.runnerDependencies,
        integrity: recomposed.integrity,
        readSourceIdentity: async () => recomposed.sourceIdentity,
      }),
      /exact pinned promotion/u,
    );

    const occupied = await createPromotionToolFixture(t);
    const occupiedPromotion = await promoteRelease(occupied.promotionInput, {
      ...occupied.runnerDependencies,
      integrity: occupied.integrity,
      readSourceIdentity: async () => occupied.sourceIdentity,
    });
    const occupiedReadBack = await occupied.createReadBackInput(occupiedPromotion);
    await writeFile(occupiedReadBack.input.runnerRecordDestination, "owner data\n", "utf8");
    await assert.rejects(
      createSupportedChannelReceipt(occupiedReadBack.input, {
        ...occupied.runnerDependencies,
        integrity: occupied.integrity,
        readSourceIdentity: async () => occupied.sourceIdentity,
      }),
      /already exists; nothing was overwritten/u,
    );
    assert.equal(
      await readFile(occupiedReadBack.input.runnerRecordDestination, "utf8"),
      "owner data\n",
    );
    assert.equal(
      (await readdir(occupied.outputRoot)).includes("supported-channel-receipt.json"),
      false,
    );

    const linkedReadBack = await createPromotionToolFixture(t);
    const linkedPromotion = await promoteRelease(linkedReadBack.promotionInput, {
      ...linkedReadBack.runnerDependencies,
      integrity: linkedReadBack.integrity,
      readSourceIdentity: async () => linkedReadBack.sourceIdentity,
    });
    const linkedReadBackInput = await linkedReadBack.createReadBackInput(linkedPromotion);
    const originalRecord = linkedReadBackInput.readBackPlan.readBackRecords[0].file.path;
    const masqueradingRecord = join(linkedReadBack.outputRoot, "masquerading-read-back.json");
    await writeFile(masqueradingRecord, await readFile(originalRecord));
    const linkedOutputRoot = join(linkedReadBack.root, "linked-output-root");
    await createDirectoryAlias(linkedOutputRoot, linkedReadBack.outputRoot);
    linkedReadBackInput.readBackPlan.readBackRecords[0].file = {
      path: join(linkedOutputRoot, "masquerading-read-back.json"),
      sha256: await sha256File(masqueradingRecord),
    };
    await writeCanonical(linkedReadBackInput.readBackPlanPath, linkedReadBackInput.readBackPlan);
    linkedReadBackInput.input.readBackPlanSha256 = await sha256File(
      linkedReadBackInput.readBackPlanPath,
    );
    await assert.rejects(
      createSupportedChannelReceipt(linkedReadBackInput.input, {
        ...linkedReadBack.runnerDependencies,
        integrity: linkedReadBack.integrity,
        readSourceIdentity: async () => linkedReadBack.sourceIdentity,
      }),
      /canonical path|linked ancestor/iu,
    );
    assert.equal(
      (await readdir(linkedReadBack.outputRoot)).includes("supported-channel-receipt.json"),
      false,
    );

    const linkedAttestation = await createPromotionToolFixture(t);
    const attestationPromotion = await promoteRelease(linkedAttestation.promotionInput, {
      ...linkedAttestation.runnerDependencies,
      integrity: linkedAttestation.integrity,
      readSourceIdentity: async () => linkedAttestation.sourceIdentity,
    });
    const linkedAttestationInput =
      await linkedAttestation.createReadBackInput(attestationPromotion);
    const linkedAttestationRoot = join(linkedAttestation.root, "linked-attestation-root");
    await createDirectoryAlias(linkedAttestationRoot, linkedAttestation.outputRoot);
    linkedAttestationInput.readBackPlan.promotion.attestation.path = join(
      linkedAttestationRoot,
      "promotion-attestation.json",
    );
    await writeCanonical(
      linkedAttestationInput.readBackPlanPath,
      linkedAttestationInput.readBackPlan,
    );
    linkedAttestationInput.input.readBackPlanSha256 = await sha256File(
      linkedAttestationInput.readBackPlanPath,
    );
    await assert.rejects(
      createSupportedChannelReceipt(linkedAttestationInput.input, {
        ...linkedAttestation.runnerDependencies,
        integrity: linkedAttestation.integrity,
        readSourceIdentity: async () => linkedAttestation.sourceIdentity,
      }),
      /canonical path|linked ancestor/iu,
    );
  },
);

async function createDirectoryAlias(aliasPath, targetPath) {
  await symlink(resolve(targetPath), aliasPath, process.platform === "win32" ? "junction" : "dir");
}
