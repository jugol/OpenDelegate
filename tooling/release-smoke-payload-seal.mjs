import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const excludedMutableManifests = new Set(["SHA256SUMS", "payload-manifest.json"]);
const maximumPayloadFileBytes = 512 * 1024 * 1024;

export async function captureFrozenPayload(root) {
  const canonicalRoot = await requireRegularDirectory(root);
  const entries = [];
  await visit(canonicalRoot, "");
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });

  async function visit(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const child of children) {
      const portablePath =
        relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      assertPortablePath(portablePath);
      const path = join(directory, child.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("The frozen release payload contains a symbolic link or junction.");
      }
      if (metadata.isDirectory()) {
        entries.push({ path: portablePath, type: "directory" });
        await visit(path, portablePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("The frozen release payload contains a special filesystem entry.");
      }
      if (excludedMutableManifests.has(portablePath)) {
        continue;
      }
      const inspected = await inspectStableFile(path, canonicalRoot);
      entries.push({
        path: portablePath,
        type: "file",
        size: inspected.size,
        sha256: inspected.sha256,
      });
    }
  }
}

export async function verifyFrozenPayload(root, expected) {
  if (expected === null || typeof expected !== "object" || !Array.isArray(expected.entries)) {
    throw new Error("The packaged smoke payload snapshot is invalid.");
  }
  const actual = await captureFrozenPayload(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Packaged smoke changed the frozen release payload.");
  }
}

async function inspectStableFile(path, root) {
  const before = await lstat(path, { bigint: true });
  const canonicalPath = await realpath(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(maximumPayloadFileBytes) ||
    !isStrictDescendant(root, canonicalPath)
  ) {
    throw new Error("A frozen payload file is not one bounded regular file.");
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error("A frozen payload file changed before hashing.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    const size = Number(opened.size);
    while (position < size) {
      const requested = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) {
        buffer.fill(0);
        throw new Error("A frozen payload file ended before its declared size.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    buffer.fill(0);
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error("A frozen payload file changed while hashing.");
    }
    return {
      size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function requireRegularDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("The frozen payload root must be an absolute directory.");
  }
  const lexicalPath = resolve(path);
  const [metadata, canonicalPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The frozen payload root must be a regular directory.");
  }
  return canonicalPath;
}

function assertPortablePath(value) {
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("The frozen release payload contains a non-portable path.");
  }
}

function isStrictDescendant(parent, candidate) {
  const relationship = relative(resolve(parent), resolve(candidate));
  return (
    relationship !== "" &&
    !isAbsolute(relationship) &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`)
  );
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

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
