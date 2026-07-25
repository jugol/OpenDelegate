import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createDeterministicReleaseArchive } from "../create-release-archive.mjs";

const execFileAsync = promisify(execFile);
const fixedTimestamp = "2026-07-24T12:34:56.000Z";

test("the final release archive is deterministic, extractable, and source preserving", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-archive-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const source = join(root, "bundle");
  const firstArchive = join(root, "first.zip");
  const secondArchive = join(root, "second.zip");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "bin", "opendelegate"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(join(source, "docs", "README.md"), "OpenDelegate\n", "utf8");
  if (process.platform !== "win32") {
    await chmod(join(source, "bin", "opendelegate"), 0o755);
  }
  const sourceBefore = await Promise.all([
    readFile(join(source, "bin", "opendelegate")),
    readFile(join(source, "docs", "README.md")),
  ]);

  const first = await createDeterministicReleaseArchive({
    destination: firstArchive,
    sourceDirectory: source,
    timestamp: fixedTimestamp,
  });
  await Promise.all([
    utimes(join(source, "bin", "opendelegate"), new Date(), new Date()),
    utimes(join(source, "docs", "README.md"), new Date(0), new Date(0)),
  ]);
  const second = await createDeterministicReleaseArchive({
    destination: secondArchive,
    sourceDirectory: source,
    timestamp: fixedTimestamp,
  });

  assert.deepEqual(await readFile(firstArchive), await readFile(secondArchive));
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.size, second.size);
  assert.equal(first.entryCount, 2);
  assert.deepEqual(first.entries, ["bin/opendelegate", "docs/README.md"]);
  assert.match(first.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.destination, firstArchive);

  const listed = (await execFileAsync("tar", ["-tf", firstArchive])).stdout.trim().split(/\r?\n/u);
  assert.deepEqual(listed, ["bin/opendelegate", "docs/README.md"]);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  await execFileAsync("tar", ["-xf", firstArchive, "-C", extracted]);
  assert.deepEqual(await readFile(join(extracted, "bin", "opendelegate")), sourceBefore[0]);
  assert.deepEqual(await readFile(join(extracted, "docs", "README.md")), sourceBefore[1]);
  if (process.platform !== "win32") {
    assert.notEqual((await stat(join(extracted, "bin", "opendelegate"))).mode & 0o111, 0);
  }
  assert.deepEqual(await readFile(join(source, "bin", "opendelegate")), sourceBefore[0]);
  assert.deepEqual(await readFile(join(source, "docs", "README.md")), sourceBefore[1]);
});

test("archive creation rejects mutable destinations, linked payloads, and unsafe timestamps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-archive-reject-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const source = join(root, "bundle");
  const target = join(root, "target");
  await Promise.all([mkdir(source), mkdir(target)]);
  await writeFile(join(source, "payload.txt"), "payload", "utf8");
  const existing = join(root, "existing.zip");
  await writeFile(existing, "do not overwrite", "utf8");

  await assert.rejects(
    createDeterministicReleaseArchive({
      destination: existing,
      sourceDirectory: source,
      timestamp: fixedTimestamp,
    }),
    /already exists/u,
  );
  assert.equal(await readFile(existing, "utf8"), "do not overwrite");
  await assert.rejects(
    createDeterministicReleaseArchive({
      destination: join(source, "nested.zip"),
      sourceDirectory: source,
      timestamp: fixedTimestamp,
    }),
    /outside the source directory/u,
  );
  await assert.rejects(
    createDeterministicReleaseArchive({
      destination: join(root, "invalid-time.zip"),
      sourceDirectory: source,
      timestamp: "1970-01-01T00:00:00.000Z",
    }),
    /ZIP timestamp/u,
  );

  const linkedSource = join(root, "linked-bundle");
  await mkdir(linkedSource);
  await symlink(
    target,
    join(linkedSource, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    createDeterministicReleaseArchive({
      destination: join(root, "linked.zip"),
      sourceDirectory: linkedSource,
      timestamp: fixedTimestamp,
    }),
    /symbolic link or junction/u,
  );
});
