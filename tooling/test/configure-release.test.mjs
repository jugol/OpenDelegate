import assert from "node:assert/strict";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  composeReleaseConfiguration,
  parseReleaseConfigurationArguments,
} from "../configure-release.mjs";
import { createPromotionToolFixture, sha256File } from "./support/release-promotion-fixture.mjs";

const supportsTypeStripping =
  process.versions.node.startsWith("24.") ||
  process.execArgv.includes("--experimental-strip-types");

test("release configuration CLI requires a new destination and a canonical pinned plan", () => {
  const root = process.cwd();
  assert.deepEqual(
    parseReleaseConfigurationArguments([
      "--",
      "--repository",
      root,
      "--plan",
      join(root, "configuration-plan.json"),
      "--plan-sha256",
      "a".repeat(64),
      "--destination-root",
      join(root, "configuration-output"),
      "--runner-executable-sha256",
      "b".repeat(64),
    ]),
    {
      destinationRoot: join(root, "configuration-output"),
      planPath: join(root, "configuration-plan.json"),
      planSha256: "a".repeat(64),
      repositoryRoot: root,
      runnerExecutableSha256: "b".repeat(64),
    },
  );
  assert.throws(
    () =>
      parseReleaseConfigurationArguments([
        "--repository",
        root,
        "--plan",
        "relative.json",
        "--plan-sha256",
        "a".repeat(64),
        "--destination-root",
        join(root, "configuration-output"),
        "--runner-executable-sha256",
        "b".repeat(64),
      ]),
    /absolute/u,
  );
  assert.deepEqual(parseReleaseConfigurationArguments(["--help"]), { help: true });
});

test(
  "configuration composer emits a verified publisher-only digest-addressed bundle",
  { skip: !supportsTypeStripping },
  async (t) => {
    const fixture = await createPromotionToolFixture(t);
    const planned = await fixture.createConfigurationInput({ mode: "publisher-only" });
    const result = await composeReleaseConfiguration(planned.input, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      now: () => new Date("2026-07-26T04:00:00.000Z"),
      readSourceIdentity: async () => fixture.sourceIdentity,
    });

    assert.equal(result.externalStatus, "publisher-verified");
    assert.equal(result.effectiveChannel, "release-candidate");
    assert.equal(result.configuration.sha256, await sha256File(result.configuration.path));
    const resolution = await fixture.integrity.resolveConfiguredRelease({
      root: planned.configurationPlan.candidate.root,
      expectedTarget: planned.configurationPlan.candidate.target,
      expectedManifestSha256: planned.configurationPlan.candidate.expectedManifestSha256,
      stateRoot: result.destinationRoot,
    });
    assert.equal(resolution.external.status, "publisher-verified");
    const runnerText = await readFile(result.runnerRecord.path, "utf8");
    assert.equal(runnerText.includes(fixture.root), false);
    assert.equal(runnerText.includes("PRIVATE KEY"), false);
  },
);

test(
  "configuration composer emits a fully promoted bundle that resolves released",
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
      readSourceIdentity: async () => fixture.sourceIdentity,
    });
    const readBack = await fixture.createReadBackInput(promotion);
    const receipt = await createSupportedChannelReceipt(readBack.input, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      readSourceIdentity: async () => fixture.sourceIdentity,
    });
    const planned = await fixture.createConfigurationInput({
      mode: "released",
      promotionResult: promotion,
      receiptResult: receipt,
    });
    const result = await composeReleaseConfiguration(planned.input, {
      ...fixture.runnerDependencies,
      integrity: fixture.integrity,
      readSourceIdentity: async () => fixture.sourceIdentity,
    });

    assert.equal(result.externalStatus, "released");
    assert.equal(result.effectiveChannel, "released");
    const resolution = await fixture.integrity.resolveConfiguredRelease({
      root: planned.configurationPlan.candidate.root,
      expectedTarget: planned.configurationPlan.candidate.target,
      expectedManifestSha256: planned.configurationPlan.candidate.expectedManifestSha256,
      stateRoot: result.destinationRoot,
    });
    assert.equal(resolution.external.status, "released");
    assert.equal(resolution.effectiveChannel, "released");
  },
);

test(
  "configuration composer rejects tamper, revocation, existing output, and leaves no partial tree",
  { skip: !supportsTypeStripping },
  async (t) => {
    const tampered = await createPromotionToolFixture(t);
    const tamperedPlan = await tampered.createConfigurationInput({
      mode: "publisher-only",
    });
    await writeFile(
      tamperedPlan.configurationPlan.candidate.publisherAttestation.path,
      "tampered\n",
      "utf8",
    );
    await assert.rejects(
      composeReleaseConfiguration(tamperedPlan.input, {
        ...tampered.runnerDependencies,
        integrity: tampered.integrity,
        readSourceIdentity: async () => tampered.sourceIdentity,
      }),
      /SHA-256.*pin/u,
    );

    const revoked = await createPromotionToolFixture(t);
    const revokedPlan = await revoked.createConfigurationInput({
      mode: "publisher-only",
      mutator(plan) {
        plan.policy.revokedPublisherKeyIds.push(
          revoked.releaseSet.publishers.find(
            (_, index) => revoked.releaseSet.releases[index].candidate.target.platform === "linux",
          ).keyId,
        );
      },
    });
    await assert.rejects(
      composeReleaseConfiguration(revokedPlan.input, {
        ...revoked.runnerDependencies,
        integrity: revoked.integrity,
        readSourceIdentity: async () => revoked.sourceIdentity,
      }),
      /publisher-verified configuration|revoked/u,
    );

    const occupied = await createPromotionToolFixture(t);
    const occupiedPlan = await occupied.createConfigurationInput({
      mode: "publisher-only",
    });
    await writeFile(occupiedPlan.input.destinationRoot, "owner data\n", "utf8");
    await assert.rejects(
      composeReleaseConfiguration(occupiedPlan.input, {
        ...occupied.runnerDependencies,
        integrity: occupied.integrity,
        readSourceIdentity: async () => occupied.sourceIdentity,
      }),
      /already exists; nothing was overwritten/u,
    );
    assert.equal(await readFile(occupiedPlan.input.destinationRoot, "utf8"), "owner data\n");

    const interrupted = await createPromotionToolFixture(t);
    const interruptedPlan = await interrupted.createConfigurationInput({
      mode: "publisher-only",
    });
    await assert.rejects(
      composeReleaseConfiguration(interruptedPlan.input, {
        ...interrupted.runnerDependencies,
        integrity: interrupted.integrity,
        readSourceIdentity: async () => interrupted.sourceIdentity,
        verifyPublished: async () => {
          throw new Error("fixture publication interruption");
        },
      }),
      /fixture publication interruption/u,
    );
    assert.equal(
      (await readdir(interrupted.root)).includes("configured-publisher-only-linux"),
      false,
    );

    const linkedTrust = await createPromotionToolFixture(t);
    const linkedTrustPlan = await linkedTrust.createConfigurationInput({
      mode: "publisher-only",
    });
    const candidateRoot = linkedTrustPlan.configurationPlan.candidate.root;
    const masqueradingTrust = join(candidateRoot, "masquerading-configuration-trust.pem");
    await writeFile(
      masqueradingTrust,
      await readFile(linkedTrustPlan.configurationPlan.candidate.publisherTrustRoot.path),
    );
    const aliasRoot = join(linkedTrust.root, "linked-configuration-trust");
    await symlink(
      resolve(candidateRoot),
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    linkedTrustPlan.configurationPlan.candidate.publisherTrustRoot.path = join(
      aliasRoot,
      "masquerading-configuration-trust.pem",
    );
    await writeFile(
      linkedTrustPlan.planPath,
      `${JSON.stringify(linkedTrustPlan.configurationPlan)}\n`,
      "utf8",
    );
    linkedTrustPlan.input.planSha256 = await sha256File(linkedTrustPlan.planPath);
    await assert.rejects(
      composeReleaseConfiguration(linkedTrustPlan.input, {
        ...linkedTrust.runnerDependencies,
        integrity: linkedTrust.integrity,
        readSourceIdentity: async () => linkedTrust.sourceIdentity,
      }),
      /canonical path|linked ancestor/iu,
    );
  },
);
