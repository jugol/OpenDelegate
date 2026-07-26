import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  lstat,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";

import { createDeterministicReleaseArchive } from "../create-release-archive.mjs";

const execFileAsync = promisify(execFile);
const fixedTimestamp = "2026-07-24T12:34:56.000Z";
const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
const localFileHeaderSignature = 0x04034b50;
const maximumTestArchiveBytes = 1024 * 1024;
const maximumTestEntries = 128;
const maximumTestEntryBytes = 256 * 1024;
const utf8NameFlag = 0x0800;

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

  const firstArchiveBytes = await readFile(firstArchive);
  assert.deepEqual(firstArchiveBytes, await readFile(secondArchive));
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.size, second.size);
  assert.equal(first.entryCount, 2);
  assert.deepEqual(first.entries, ["bin/opendelegate", "docs/README.md"]);
  assert.match(first.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(first.destination, firstArchive);

  const inspected = inspectDeterministicZip(firstArchiveBytes);
  assert.deepEqual(
    inspected.map(({ path }) => path),
    ["bin/opendelegate", "docs/README.md"],
  );
  assert.deepEqual(inspected[0]?.bytes, sourceBefore[0]);
  assert.deepEqual(inspected[1]?.bytes, sourceBefore[1]);
  if (process.platform !== "win32") {
    assert.notEqual((inspected[0]?.mode ?? 0) & 0o111, 0);
  }
  await verifyWithAvailableNativeConsumer(firstArchive, root, sourceBefore);
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

test("archive creation rejects an entry replaced after its file handle opens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-release-archive-race-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  const source = join(root, "bundle");
  const payload = join(source, "payload.txt");
  const replacement = join(source, "replacement.txt");
  const destination = join(root, "raced.zip");
  await mkdir(source);
  await writeFile(payload, "trusted payload\n", "utf8");
  await writeFile(replacement, "replacement payload\n", "utf8");
  const replacementMetadata = await lstat(replacement, { bigint: true });
  // Windows forbids the reliable rename of an open file, so model the same
  // pathname-to-inode swap at the injected lstat boundary.
  let hookCalls = 0;
  let raced = false;

  await assert.rejects(
    createDeterministicReleaseArchive(
      {
        destination,
        sourceDirectory: source,
        timestamp: fixedTimestamp,
      },
      {
        async afterEntryOpen(path) {
          if (path !== payload || hookCalls > 0) {
            return;
          }
          hookCalls += 1;
          raced = true;
        },
        async lstat(path, options) {
          if (path === payload && raced) {
            return replacementMetadata;
          }
          return lstat(path, options);
        },
      },
    ),
    /changed/u,
  );
  assert.equal(hookCalls, 1);
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

function inspectDeterministicZip(bytes) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.byteLength >= 22 && bytes.byteLength <= maximumTestArchiveBytes,
  );
  const endOffset = bytes.byteLength - 22;
  assert.equal(bytes.readUInt32LE(endOffset), endOfCentralDirectorySignature);
  assert.equal(bytes.readUInt16LE(endOffset + 4), 0);
  assert.equal(bytes.readUInt16LE(endOffset + 6), 0);
  const entryCount = bytes.readUInt16LE(endOffset + 8);
  assert.equal(bytes.readUInt16LE(endOffset + 10), entryCount);
  assert.ok(entryCount > 0 && entryCount <= maximumTestEntries);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  assert.equal(bytes.readUInt16LE(endOffset + 20), 0);
  assert.equal(centralOffset + centralSize, endOffset);

  const entries = [];
  const localRanges = [];
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.ok(centralCursor + 46 <= endOffset);
    assert.equal(bytes.readUInt32LE(centralCursor), centralDirectorySignature);
    assert.equal(bytes.readUInt16LE(centralCursor + 4) >>> 8, 3);
    assert.equal(bytes.readUInt16LE(centralCursor + 8), utf8NameFlag);
    assert.equal(bytes.readUInt16LE(centralCursor + 10), 8);
    const checksum = bytes.readUInt32LE(centralCursor + 16);
    const compressedSize = bytes.readUInt32LE(centralCursor + 20);
    const uncompressedSize = bytes.readUInt32LE(centralCursor + 24);
    const nameLength = bytes.readUInt16LE(centralCursor + 28);
    const extraLength = bytes.readUInt16LE(centralCursor + 30);
    const commentLength = bytes.readUInt16LE(centralCursor + 32);
    assert.equal(bytes.readUInt16LE(centralCursor + 34), 0);
    assert.equal(extraLength, 0);
    assert.equal(commentLength, 0);
    assert.ok(
      nameLength > 0 &&
        compressedSize <= maximumTestArchiveBytes &&
        uncompressedSize <= maximumTestEntryBytes,
    );
    const centralEnd = centralCursor + 46 + nameLength;
    assert.ok(centralEnd <= endOffset);
    const nameBytes = bytes.subarray(centralCursor + 46, centralEnd);
    const path = nameBytes.toString("utf8");
    assert.deepEqual(Buffer.from(path, "utf8"), nameBytes);
    assertPortableArchivePath(path);

    const externalAttributes = bytes.readUInt32LE(centralCursor + 38);
    const unixMode = externalAttributes >>> 16;
    assert.equal(unixMode & 0o170000, 0o100000);
    const mode = unixMode & 0o777;
    const localOffset = bytes.readUInt32LE(centralCursor + 42);
    assert.ok(localOffset + 30 <= centralOffset);
    assert.equal(bytes.readUInt32LE(localOffset), localFileHeaderSignature);
    assert.equal(bytes.readUInt16LE(localOffset + 6), utf8NameFlag);
    assert.equal(bytes.readUInt16LE(localOffset + 8), 8);
    assert.equal(bytes.readUInt32LE(localOffset + 14), checksum);
    assert.equal(bytes.readUInt32LE(localOffset + 18), compressedSize);
    assert.equal(bytes.readUInt32LE(localOffset + 22), uncompressedSize);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    assert.equal(localNameLength, nameLength);
    assert.equal(localExtraLength, 0);
    const localNameStart = localOffset + 30;
    const compressedStart = localNameStart + localNameLength;
    const compressedEnd = compressedStart + compressedSize;
    assert.ok(compressedEnd <= centralOffset);
    assert.deepEqual(bytes.subarray(localNameStart, compressedStart), nameBytes);
    const output = inflateRawSync(bytes.subarray(compressedStart, compressedEnd), {
      maxOutputLength: maximumTestEntryBytes,
    });
    assert.equal(output.byteLength, uncompressedSize);
    assert.equal(crc32(output) >>> 0, checksum);
    entries.push({ bytes: output, mode, path });
    localRanges.push({ end: compressedEnd, start: localOffset });
    centralCursor = centralEnd;
  }
  assert.equal(centralCursor, endOffset);
  assert.deepEqual(
    entries.map(({ path }) => path),
    entries.map(({ path }) => path).toSorted(compareCodeUnits),
  );
  localRanges.sort((left, right) => left.start - right.start);
  let localCursor = 0;
  for (const range of localRanges) {
    assert.equal(range.start, localCursor);
    localCursor = range.end;
  }
  assert.equal(localCursor, centralOffset);
  return entries;
}

async function verifyWithAvailableNativeConsumer(archive, root, sourceBefore) {
  const command =
    process.platform === "linux"
      ? { executable: "unzip", extract: ["-q", archive, "-d"], list: ["-Z1", archive] }
      : { executable: "tar", extract: ["-xf", archive, "-C"], list: ["-tf", archive] };
  let listed;
  try {
    listed = await execFileAsync(command.executable, command.list);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/u), ["bin/opendelegate", "docs/README.md"]);
  const extracted = join(root, "native-extracted");
  await mkdir(extracted);
  await execFileAsync(command.executable, [...command.extract, extracted]);
  assert.deepEqual(await readFile(join(extracted, "bin", "opendelegate")), sourceBefore[0]);
  assert.deepEqual(await readFile(join(extracted, "docs", "README.md")), sourceBefore[1]);
  if (process.platform !== "win32") {
    assert.notEqual((await stat(join(extracted, "bin", "opendelegate"))).mode & 0o111, 0);
  }
}

function assertPortableArchivePath(path) {
  const segments = path.split("/");
  assert.ok(
    path !== "" &&
      path === path.normalize("NFC") &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
