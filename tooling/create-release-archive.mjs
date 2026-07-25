import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_NAME_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const ZIP_MAXIMUM_UINT16 = 0xffff;
const ZIP_MAXIMUM_UINT32 = 0xffffffff;
const MAXIMUM_ENTRY_BYTES = 1024 * 1024 * 1024;

export async function createDeterministicReleaseArchive(input) {
  const sourceDirectory = await requireCanonicalDirectory(
    input?.sourceDirectory,
    "release source directory",
  );
  const destination = await canonicalizeNewDestination(input?.destination, sourceDirectory);
  const timestamp = parseZipTimestamp(input?.timestamp);
  const entries = await discoverEntries(sourceDirectory);
  if (entries.length === 0) {
    throw new Error("The release source directory has no regular files.");
  }
  if (entries.length > ZIP_MAXIMUM_UINT16) {
    throw new Error("The release archive exceeds the ZIP32 entry limit.");
  }

  let archive;
  let created = false;
  try {
    archive = await open(destination, "wx", 0o644);
    created = true;
    const centralDirectory = [];
    let offset = 0;
    for (const entry of entries) {
      const stable = await readStableRegularFile(entry.absolutePath, sourceDirectory);
      if (stable.bytes.byteLength > MAXIMUM_ENTRY_BYTES) {
        stable.bytes.fill(0);
        throw new Error(`The release archive entry is oversized: ${entry.path}.`);
      }
      const compressed = deflateRawSync(stable.bytes, { level: 9 });
      const checksum = crc32(stable.bytes) >>> 0;
      const name = Buffer.from(entry.path, "utf8");
      if (
        name.byteLength === 0 ||
        name.byteLength > ZIP_MAXIMUM_UINT16 ||
        stable.bytes.byteLength > ZIP_MAXIMUM_UINT32 ||
        compressed.byteLength > ZIP_MAXIMUM_UINT32
      ) {
        stable.bytes.fill(0);
        compressed.fill(0);
        throw new Error(`The release archive entry exceeds ZIP32 limits: ${entry.path}.`);
      }
      const localHeader = createLocalHeader({
        checksum,
        compressedSize: compressed.byteLength,
        nameLength: name.byteLength,
        timestamp,
        uncompressedSize: stable.bytes.byteLength,
      });
      if (
        offset + localHeader.byteLength + name.byteLength + compressed.byteLength >
        ZIP_MAXIMUM_UINT32
      ) {
        stable.bytes.fill(0);
        compressed.fill(0);
        throw new Error("The release archive exceeds the ZIP32 byte limit.");
      }
      await writeAll(archive, localHeader);
      await writeAll(archive, name);
      await writeAll(archive, compressed);
      centralDirectory.push(
        createCentralDirectoryHeader({
          checksum,
          compressedSize: compressed.byteLength,
          localHeaderOffset: offset,
          mode: stable.mode,
          name,
          timestamp,
          uncompressedSize: stable.bytes.byteLength,
        }),
      );
      offset += localHeader.byteLength + name.byteLength + compressed.byteLength;
      stable.bytes.fill(0);
      compressed.fill(0);
    }

    const centralDirectoryOffset = offset;
    for (const record of centralDirectory) {
      if (offset + record.byteLength > ZIP_MAXIMUM_UINT32) {
        throw new Error("The release archive central directory exceeds ZIP32 limits.");
      }
      await writeAll(archive, record);
      offset += record.byteLength;
    }
    const centralDirectorySize = offset - centralDirectoryOffset;
    const end = createEndOfCentralDirectory({
      centralDirectoryOffset,
      centralDirectorySize,
      entryCount: entries.length,
    });
    await writeAll(archive, end);
    offset += end.byteLength;
    await archive.sync();
    await archive.close();
    archive = undefined;

    return Object.freeze({
      destination,
      entries: Object.freeze(entries.map((entry) => entry.path)),
      entryCount: entries.length,
      sha256: await sha256File(destination),
      size: offset,
    });
  } catch (error) {
    await archive?.close().catch(() => undefined);
    archive = undefined;
    if (created) {
      await unlink(destination).catch(() => undefined);
    }
    if (isNodeError(error, "EEXIST")) {
      throw new Error("The release archive destination already exists; nothing was overwritten.", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await archive?.close().catch(() => undefined);
  }
}

async function discoverEntries(root) {
  const entries = [];
  const caseFolded = new Map();
  const visit = async (directory, relativeDirectory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const path = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      assertPortablePath(path);
      const folded = path.normalize("NFC").toLowerCase();
      const collision = caseFolded.get(folded);
      if (collision !== undefined) {
        throw new Error(
          `The release archive contains case-colliding paths: ${collision}, ${path}.`,
        );
      }
      caseFolded.set(folded, path);
      const absolutePath = resolve(directory, child.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`The release archive contains a symbolic link or junction: ${path}.`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, path);
      } else if (metadata.isFile()) {
        entries.push({ absolutePath, path });
      } else {
        throw new Error(`The release archive contains a special payload entry: ${path}.`);
      }
    }
  };
  await visit(root, "");
  return entries.sort((left, right) => compareCodeUnits(left.path, right.path));
}

async function readStableRegularFile(path, root) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("A release archive entry stopped being a regular file.");
  }
  const canonical = await realpath(path);
  if (!isDescendant(root, canonical)) {
    throw new Error("A release archive entry escaped its canonical source root.");
  }
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  let bytes;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || opened.size > BigInt(MAXIMUM_ENTRY_BYTES)) {
      throw new Error("A release archive entry changed before it could be read.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || after.size !== BigInt(bytes.byteLength)) {
      bytes.fill(0);
      throw new Error("A release archive entry changed while it was being read.");
    }
    return { bytes, mode: Number(after.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

function sameFile(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function createLocalHeader(input) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_NAME_FLAG, 6);
  header.writeUInt16LE(DEFLATE_METHOD, 8);
  header.writeUInt16LE(input.timestamp.time, 10);
  header.writeUInt16LE(input.timestamp.date, 12);
  header.writeUInt32LE(input.checksum, 14);
  header.writeUInt32LE(input.compressedSize, 18);
  header.writeUInt32LE(input.uncompressedSize, 22);
  header.writeUInt16LE(input.nameLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function createCentralDirectoryHeader(input) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(ZIP_UNIX_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(UTF8_NAME_FLAG, 8);
  header.writeUInt16LE(DEFLATE_METHOD, 10);
  header.writeUInt16LE(input.timestamp.time, 12);
  header.writeUInt16LE(input.timestamp.date, 14);
  header.writeUInt32LE(input.checksum, 16);
  header.writeUInt32LE(input.compressedSize, 20);
  header.writeUInt32LE(input.uncompressedSize, 24);
  header.writeUInt16LE(input.name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const unixMode = 0o100000 | (input.mode & 0o777);
  header.writeUInt32LE((unixMode << 16) >>> 0, 38);
  header.writeUInt32LE(input.localHeaderOffset, 42);
  return Buffer.concat([header, input.name]);
}

function createEndOfCentralDirectory(input) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(input.entryCount, 8);
  record.writeUInt16LE(input.entryCount, 10);
  record.writeUInt32LE(input.centralDirectorySize, 12);
  record.writeUInt32LE(input.centralDirectoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function parseZipTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new Error("The release archive requires a canonical UTC ZIP timestamp.");
  }
  const instant = new Date(value);
  const year = instant.getUTCFullYear();
  if (!Number.isFinite(instant.getTime()) || year < 1980 || year > 2107) {
    throw new Error("The release archive ZIP timestamp is outside 1980-2107.");
  }
  return {
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
    time:
      (instant.getUTCHours() << 11) |
      (instant.getUTCMinutes() << 5) |
      Math.floor(instant.getUTCSeconds() / 2),
  };
}

async function requireCanonicalDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`The ${label} must be an absolute path.`);
  }
  const metadata = await lstat(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular, non-linked directory.`);
  }
  return realpath(value);
}

async function canonicalizeNewDestination(value, sourceDirectory) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error("The release archive destination must be an absolute path.");
  }
  const parent = await realpath(dirname(value));
  const destination = resolve(parent, basename(value));
  if (destination === parent) {
    throw new Error("The release archive destination must include a file name.");
  }
  if (destination === sourceDirectory || isDescendant(sourceDirectory, destination)) {
    throw new Error("The release archive destination must remain outside the source directory.");
  }
  try {
    await lstat(destination);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return destination;
    }
    throw error;
  }
  throw new Error("The release archive destination already exists; nothing was overwritten.");
}

function assertPortablePath(path) {
  const segments = path.split("/");
  if (
    path === "" ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("The release archive contains an unsafe portable path.");
  }
}

function isDescendant(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new Error("The release archive could not make forward write progress.");
    }
    offset += result.bytesWritten;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
