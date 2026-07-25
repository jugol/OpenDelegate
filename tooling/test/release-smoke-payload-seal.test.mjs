import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { captureFrozenPayload, verifyFrozenPayload } from "../release-smoke-payload-seal.mjs";

test("packaged smoke may not mutate or add regular payload files", async (t) => {
  const root = await createPayloadFixture(t);
  const snapshot = await captureFrozenPayload(root);
  await verifyFrozenPayload(root, snapshot);

  await appendFile(join(root, "apps", "main.mjs"), "changed\n", "utf8");
  await assert.rejects(verifyFrozenPayload(root, snapshot), /changed the frozen release payload/u);

  const secondRoot = await createPayloadFixture(t);
  const secondSnapshot = await captureFrozenPayload(secondRoot);
  await writeFile(join(secondRoot, "smoke-created.txt"), "unexpected\n", "utf8");
  await assert.rejects(
    verifyFrozenPayload(secondRoot, secondSnapshot),
    /changed the frozen release payload/u,
  );
});

test("integrity manifests are the only intentionally mutable snapshot exclusions", async (t) => {
  const root = await createPayloadFixture(t);
  const snapshot = await captureFrozenPayload(root);
  await writeFile(join(root, "payload-manifest.json"), '{"regenerated":true}\n', "utf8");
  await writeFile(join(root, "SHA256SUMS"), "regenerated\n", "utf8");
  await verifyFrozenPayload(root, snapshot);
});

test("packaged smoke cannot leave a symlink or junction outside payload hashing", async (t) => {
  const root = await createPayloadFixture(t);
  const snapshot = await captureFrozenPayload(root);
  const external = join(root, "..", `od-smoke-external-${process.pid}.txt`);
  await writeFile(external, "external\n", "utf8");
  t.after(() => rm(external, { force: true }));
  try {
    await symlink(external, join(root, "smoke-link"));
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("This Windows host does not allow an unprivileged symlink fixture.");
      return;
    }
    throw error;
  }
  await assert.rejects(verifyFrozenPayload(root, snapshot), /symbolic link or junction/u);
});

async function createPayloadFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-smoke-payload-seal-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "apps"), { recursive: true });
  await writeFile(join(root, "apps", "main.mjs"), "main\n", "utf8");
  await writeFile(join(root, "payload-manifest.json"), '{"schemaVersion":1}\n', "utf8");
  await writeFile(join(root, "SHA256SUMS"), "initial\n", "utf8");
  return root;
}
