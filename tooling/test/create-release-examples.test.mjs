import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  RELEASE_EXAMPLE_PATHS,
  createReleaseExamples,
  parseReleaseExamplesArguments,
  renderReleaseExamplesHelp,
  validateReleaseExampleSet,
} from "../create-release-examples.mjs";

test("release example arguments accept one absolute new destination and nothing else", () => {
  const destination = resolve("release-examples");
  assert.deepEqual(parseReleaseExamplesArguments(["--", "--destination", destination]), {
    destination,
  });
  assert.deepEqual(parseReleaseExamplesArguments(["--help"]), { help: true });
  assert.deepEqual(parseReleaseExamplesArguments(["-h"]), { help: true });
  assert.throws(() => parseReleaseExamplesArguments([]), /--destination is required/u);
  assert.throws(
    () => parseReleaseExamplesArguments(["--destination", "relative"]),
    /absolute path/u,
  );
  assert.throws(
    () =>
      parseReleaseExamplesArguments(["--destination", destination, "--destination", destination]),
    /Invalid or duplicate/u,
  );
  assert.throws(
    () => parseReleaseExamplesArguments(["--output", destination]),
    /Invalid or duplicate/u,
  );
});

test("release examples are canonical credential-free skeletons with exact cross-file bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-examples-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const destination = join(root, "generated");

  const result = await createReleaseExamples({ destination });
  assert.equal(result.path, destination);
  assert.deepEqual(
    result.files.map(({ path }) => path),
    RELEASE_EXAMPLE_PATHS,
  );
  await validateReleaseExampleSet({
    expectedDestination: destination,
    root: destination,
  });

  const readJson = async (path) => JSON.parse(await readFile(join(destination, path), "utf8"));
  const promotion = await readJson("plans/promotion-plan.json");
  const readBack = await readJson("plans/read-back-plan.json");
  const publisherOnly = await readJson("plans/configuration-publisher-only-plan.json");
  const released = await readJson("plans/configuration-released-plan.json");
  const publisherPolicy = await readJson("signing/publisher-policy.json");
  const promotionPolicy = await readJson("signing/promotion-policy.json");
  const readme = await readFile(join(destination, "README.md"), "utf8");

  assert.deepEqual(
    promotion.candidates.map(({ target }) => target),
    [
      { platform: "darwin", architecture: "arm64" },
      { platform: "linux", architecture: "x64" },
      { platform: "win32", architecture: "x64" },
    ],
  );
  assert.equal(promotion.liveEvidence.length, 36);
  assert.equal(readBack.promotion.planSha256, result.promotionPlanSha256);
  assert.equal(readBack.readBackRecords.length, 3);
  assert.equal(publisherOnly.mode, "publisher-only");
  assert.equal(publisherOnly.promotion, null);
  assert.equal(released.mode, "released");
  assert.equal(released.promotion.liveEvidence.length, 36);
  assert.equal(released.promotion.readBackObservations.length, 3);
  assert.equal(publisherPolicy.role, "publisher");
  assert.equal(promotionPolicy.role, "promotion");
  assert.equal(Object.hasOwn(publisherPolicy, "signer"), false);
  assert.match(readme, /NOT-A-RELEASE/u);
  assert.match(readme, /PLACEHOLDER/u);

  for (const path of RELEASE_EXAMPLE_PATHS) {
    const text = await readFile(join(destination, path), "utf8");
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u);
    if (path.endsWith(".json")) {
      assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`);
      assert.match(text, /PLACEHOLDER/u);
    }
  }
});

test("release examples never overwrite an existing destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-examples-existing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const destination = join(root, "generated");
  await writeFile(destination, "owner data\n", "utf8");

  await assert.rejects(
    createReleaseExamples({ destination }),
    /already exists|regular.*directory|destination/u,
  );
  assert.equal(await readFile(destination, "utf8"), "owner data\n");
});

test("release example publication rolls back the complete directory after final verification fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-examples-rollback-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const destination = join(root, "generated");

  await assert.rejects(
    createReleaseExamples(
      { destination },
      {
        async verifyPublished() {
          throw new Error("fixture rejected published examples");
        },
      },
    ),
    /fixture rejected published examples/u,
  );
  await assert.rejects(access(destination), (error) => error?.code === "ENOENT");
});

test("release example validation rejects schema drift and removed placeholder safeguards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-examples-invalid-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const destination = join(root, "generated");
  await createReleaseExamples({ destination });
  const promotionPath = join(destination, "plans", "promotion-plan.json");
  const promotion = JSON.parse(await readFile(promotionPath, "utf8"));
  promotion.unexpected = true;
  await writeFile(promotionPath, `${JSON.stringify(promotion)}\n`, "utf8");
  await assert.rejects(
    validateReleaseExampleSet({
      expectedDestination: destination,
      root: destination,
    }),
    /promotion plan fields/u,
  );

  const secondDestination = join(root, "generated-without-marker");
  await createReleaseExamples({ destination: secondDestination });
  const policyPath = join(secondDestination, "signing", "publisher-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.publicKey.path = policy.publicKey.path.replace("PLACEHOLDER-", "");
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, "utf8");
  await assert.rejects(
    validateReleaseExampleSet({
      expectedDestination: secondDestination,
      root: secondDestination,
    }),
    /PLACEHOLDER/u,
  );
});

test("release example help identifies the safe create-new workflow", () => {
  const help = renderReleaseExamplesHelp();
  assert.match(help, /pnpm release:examples -- --destination ABSOLUTE_NEW_DIRECTORY/u);
  assert.match(help, /NOT-A-RELEASE/u);
  assert.match(help, /never writes credentials/u);
});
