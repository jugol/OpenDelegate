import assert from "node:assert/strict";
import {
  lchmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { NativeBoundaryError, createNodeNativeServiceBoundaries } from "../src/index.ts";
import { windowsOwnerSessionProbeSucceeded } from "../src/native-service-boundaries.ts";

test("localized Windows query output recognizes the matching owner session", () => {
  assert.equal(
    windowsOwnerSessionProbeSucceeded(String.raw`WORKSTATION\solom`, {
      exitCode: 1,
      stdout:
        " USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME\r\n" +
        ">solom                 console             1  Active      none   2026-08-07 1:04\r\n",
      timedOut: false,
    }),
    true,
  );
});

test("localized Windows missing-user output is not a logged-in session", () => {
  assert.equal(
    windowsOwnerSessionProbeSucceeded(String.raw`WORKSTATION\solom`, {
      exitCode: 1,
      stdout: "No User exists for solom\r\n",
      timedOut: false,
    }),
    false,
  );
});

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

test(
  "the Windows native filesystem boundary replaces an existing activation junction",
  { skip: process.platform !== "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-native-junction-"));
    context.after(async () => {
      await rm(root, { force: true, recursive: true });
    });
    const previous = join(root, "previous");
    const next = join(root, "next");
    const current = join(root, "current");
    await mkdir(previous);
    await mkdir(next);
    await symlink(previous, current, "junction");
    const fileSystem = createNodeNativeServiceBoundaries().fileSystem;

    assert.equal(await fileSystem.createDirectoryLinkAtomic(next, current, "windows"), "changed");
    assert.equal(resolve(root, await readlink(current)), resolve(next));
    assert.deepEqual((await readdir(root)).sort(), ["current", "next", "previous"]);
    assert.equal(await fileSystem.createDirectoryLinkAtomic(next, current, "windows"), "unchanged");
  },
);

test(
  "the macOS activation link repairs service-group traversal on an unchanged target",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-native-activation-link-"));
    context.after(async () => {
      await rm(root, { force: true, recursive: true });
    });
    const release = join(root, "release");
    const current = join(root, "current");
    await mkdir(release);
    await symlink(release, current, "dir");
    await lchmod(current, 0o700);

    const fileSystem = createNodeNativeServiceBoundaries().fileSystem;
    assert.equal(await fileSystem.createDirectoryLinkAtomic(release, current, "macos"), "changed");
    assert.equal((await lstat(current)).mode & 0o777, 0o750);
    assert.equal(resolve(root, await readlink(current)), resolve(release));
  },
);
