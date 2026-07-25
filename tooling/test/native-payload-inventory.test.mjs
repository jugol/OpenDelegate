import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { discoverThirdPartyNativeComponents } from "../native-payload-inventory.mjs";

test("native payload discovery finds runtime, versioned libraries, and extensionless magic", async (t) => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-native-inventory-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const runtimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
    const ownedPath =
      platform === "win32" ? "bin/opendelegate-service-host.exe" : "bin/opendelegate-service-host";
    const nativePaths =
      platform === "darwin"
        ? ["apps/main/native/addon.node", "apps/main/native/extensionless"]
        : platform === "linux"
          ? ["apps/main/native/addon.node", "apps/main/native/libexample.so.1"]
          : ["apps/main/native/addon.node", "apps/main/native/example.dll"];
    for (const path of [runtimePath, ownedPath, ...nativePaths]) {
      await writeNativeFile(root, path, platform);
    }
    await writePortableFile(root, "docs/not-native.md", "portable text\n");

    const discovered = await discoverThirdPartyNativeComponents({
      ownedPaths: [ownedPath],
      platform,
      stagingRoot: root,
    });

    assert.deepEqual(
      discovered,
      [runtimePath, ...nativePaths].sort().map((path) => ({
        kind: path === runtimePath ? "bundled-node-runtime" : "bundled-native-library",
        path,
      })),
    );
  }
});

test("native-looking suffixes with unknown magic fail instead of disappearing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-inventory-invalid-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeNativeFile(root, "runtime/node", "linux");
  await writePortableFile(root, "apps/main/native/opaque.node", "not an ELF binary\n");

  await assert.rejects(
    discoverThirdPartyNativeComponents({
      ownedPaths: [],
      platform: "linux",
      stagingRoot: root,
    }),
    /unsupported executable magic/u,
  );
});

test("native discovery fails when the mandatory bundled runtime is omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-native-inventory-missing-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeNativeFile(root, "apps/main/native/addon.node", "linux");

  await assert.rejects(
    discoverThirdPartyNativeComponents({
      ownedPaths: [],
      platform: "linux",
      stagingRoot: root,
    }),
    /bundled Node runtime is missing/u,
  );
});

async function writeNativeFile(root, portablePath, platform) {
  const bytes =
    platform === "win32"
      ? createPeFixture()
      : platform === "darwin"
        ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
  const path = join(root, ...portablePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function writePortableFile(root, portablePath, value) {
  const path = join(root, ...portablePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function createPeFixture() {
  const bytes = Buffer.alloc(132);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128, "binary");
  return bytes;
}
