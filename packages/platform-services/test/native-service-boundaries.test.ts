import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NativeBoundaryError, createNodeNativeServiceBoundaries } from "../src/index.ts";

test("the Node native filesystem boundary reads only bounded regular files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-boundary-"));
  context.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const file = join(root, "payload.bin");
  await writeFile(file, Buffer.from("verified", "utf8"));
  const boundaries = createNodeNativeServiceBoundaries();

  assert.equal((await boundaries.fileSystem.read(file, 8)).toString("utf8"), "verified");
  await assert.rejects(
    boundaries.fileSystem.read(file, 7),
    (error: unknown) =>
      error instanceof NativeBoundaryError && error.code === "NATIVE_FILESYSTEM_UNSAFE",
  );
});

test("native executable discovery rejects directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-executable-"));
  context.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const directory = join(root, "not-a-tool");
  await mkdir(directory);

  assert.equal(await createNodeNativeServiceBoundaries().process.isExecutable(directory), false);
});

test("native subprocess timeout terminates a stuck argv-only process", async () => {
  const startedAt = Date.now();
  const result = await createNodeNativeServiceBoundaries().process.run({
    executable: process.execPath,
    arguments: ["-e", "setInterval(() => undefined, 1000)"],
    timeoutMs: 1_000,
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 7_000);
});
