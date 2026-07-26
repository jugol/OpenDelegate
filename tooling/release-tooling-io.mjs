import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_MAXIMUM_BYTES = 4 * 1024 * 1024;

export async function readPinnedCanonicalJson(input) {
  const file = await readPinnedBytes(input);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (error) {
    throw new Error(`The ${input.label} is not valid UTF-8.`, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The ${input.label} is not canonical JSON.`, { cause: error });
  }
  const serialized = input.indent === 2 ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const expectedText = input.trailingNewline === false ? serialized : `${serialized}\n`;
  if (expectedText !== text) {
    throw new Error(`The ${input.label} is not canonical JSON.`);
  }
  return Object.freeze({ ...file, value });
}

export async function readPinnedBytes({
  label,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  path,
  sha256,
}) {
  assertAbsolutePath(path, label);
  assertSha256(sha256, `${label} pin`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error(`The ${label} size limit is invalid.`);
  }
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error(`The ${label} is not a bounded regular file.`);
  }
  await assertNoLinkedPathComponents(path, label);
  const canonicalPath = await realpath(path);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error(`The ${label} changed before it could be read.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameFile(opened, after) ||
      after.size !== BigInt(bytes.byteLength) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maximumBytes
    ) {
      bytes.fill(0);
      throw new Error(`The ${label} changed while it was being read.`);
    }
    const digest = digestBytes(bytes);
    if (digest !== sha256) {
      bytes.fill(0);
      throw new Error(`The ${label} SHA-256 does not match its required pin.`);
    }
    return Object.freeze({
      get bytes() {
        return Uint8Array.from(bytes);
      },
      path: canonicalPath,
      sha256: digest,
      size: bytes.byteLength,
    });
  } finally {
    await handle.close();
  }
}

export async function requireCanonicalDirectory(path, label, dependencies = {}) {
  assertAbsolutePath(path, label);
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a regular, non-linked directory.`);
  }
  await assertNoLinkedPathComponents(path, label);
  const canonicalPath = await (dependencies.realPath ?? realpath)(path);
  const canonicalMetadata = await (dependencies.canonicalLstat ?? lstat)(canonicalPath, {
    bigint: true,
  });
  if (!sameFile(metadata, canonicalMetadata)) {
    throw new Error(`The ${label} changed while its canonical path was resolved.`);
  }
  return canonicalPath;
}

export async function requireCanonicalNewPath(path, label) {
  assertAbsolutePath(path, label);
  const parent = await requireCanonicalDirectory(dirname(path), `${label} parent`);
  return join(parent, basename(path));
}

export function assertPathOutsideRoots(path, roots, label) {
  assertAbsolutePath(path, label);
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`The ${label} requires at least one prohibited root.`);
  }
  if (roots.some((root) => isSameOrDescendant(root, path))) {
    throw new Error(`The ${label} must remain outside the checkout and generated inputs.`);
  }
}

export function assertDisjointPaths(paths, label) {
  if (
    !Array.isArray(paths) ||
    paths.length < 2 ||
    paths.some((path) => typeof path !== "string" || !isAbsolute(path))
  ) {
    throw new Error(`The ${label} paths are invalid.`);
  }
  const comparable = paths.map(comparablePath);
  if (new Set(comparable).size !== comparable.length) {
    throw new Error(`The ${label} paths must be distinct.`);
  }
}

export async function assertPathAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists; nothing was overwritten.`);
}

export async function publishNewFileSet(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error("At least one release output is required.");
  }
  for (const entry of entries) {
    requireExactKeys(entry, ["path", "bytes", "mode"], "release output");
    assertAbsolutePath(entry.path, "release output");
    if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
      throw new Error("A release output has no bytes.");
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("A release output mode is invalid.");
    }
  }
  const canonicalEntries = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      path: await requireCanonicalNewPath(entry.path, "release output"),
    })),
  );
  assertDisjointPaths(
    canonicalEntries.map(({ path }) => path),
    "release output",
  );
  const parent = await requireCanonicalDirectory(
    dirname(canonicalEntries[0].path),
    "release output directory",
  );
  if (
    canonicalEntries.some(({ path }) => comparablePath(dirname(path)) !== comparablePath(parent))
  ) {
    throw new Error("A release output set must share one canonical directory.");
  }
  await Promise.all(canonicalEntries.map(({ path }) => assertPathAbsent(path, "A release output")));

  const temporaryDirectory = await mkdtemp(join(parent, ".opendelegate-release-output-"));
  const staged = [];
  const published = [];
  try {
    for (let index = 0; index < canonicalEntries.length; index += 1) {
      const entry = canonicalEntries[index];
      const temporaryPath = join(temporaryDirectory, String(index));
      await writeNewSyncedFile(temporaryPath, entry.bytes, entry.mode);
      const identity = await lstat(temporaryPath, { bigint: true });
      staged.push({ entry, identity, temporaryPath });
    }
    for (let index = 0; index < staged.length; index += 1) {
      const item = staged[index];
      await link(item.temporaryPath, item.entry.path);
      const [temporaryIdentity, finalIdentity] = await Promise.all([
        lstat(item.temporaryPath, { bigint: true }),
        lstat(item.entry.path, { bigint: true }),
      ]);
      if (!sameFile(temporaryIdentity, finalIdentity)) {
        throw new Error("A release output changed during atomic publication.");
      }
      published.push({ ...item, identity: temporaryIdentity });
      await options.afterPublish?.(index, item.entry.path);
    }
    const verified = [];
    for (const item of published) {
      const final = await hashStableRegularFile(item.entry.path);
      if (
        final.sha256 !== digestBytes(item.entry.bytes) ||
        final.size !== item.entry.bytes.byteLength
      ) {
        throw new Error("A release output failed final digest verification.");
      }
      verified.push(
        Object.freeze({
          path: item.entry.path,
          sha256: final.sha256,
          size: final.size,
        }),
      );
    }
    await options.verifyPublished?.(Object.freeze([...verified]));
    await syncDirectory(parent);
    await Promise.all(staged.map(({ temporaryPath }) => unlink(temporaryPath)));
    await rmdir(temporaryDirectory);
    await syncDirectory(parent);
    return Object.freeze(verified);
  } catch (error) {
    await cleanupPublishedOutputs(published);
    await removePrivateTemporaryDirectory(temporaryDirectory, parent);
    if (isNodeError(error, "EEXIST")) {
      throw new Error("A release output already exists; nothing was overwritten.", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function publishNewDirectoryTree(destination, entries, options = {}) {
  assertAbsolutePath(destination, "release configuration destination");
  if (!Array.isArray(entries) || entries.length < 1) {
    throw new Error("At least one release configuration file is required.");
  }
  const paths = new Set();
  for (const entry of entries) {
    requireExactKeys(entry, ["path", "bytes", "mode"], "release configuration file");
    assertPortableRelativePath(entry.path, "release configuration file");
    const comparable = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
    if (paths.has(comparable)) {
      throw new Error("Release configuration file paths must be distinct.");
    }
    paths.add(comparable);
    if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
      throw new Error("A release configuration file has no bytes.");
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("A release configuration file mode is invalid.");
    }
  }
  destination = await requireCanonicalNewPath(destination, "release configuration destination");
  const parent = await requireCanonicalDirectory(
    dirname(destination),
    "release configuration output parent",
  );
  if (comparablePath(dirname(destination)) !== comparablePath(parent)) {
    throw new Error("The release configuration destination parent must not be linked.");
  }
  await assertPathAbsent(destination, "The release configuration output");
  const temporaryDirectory = await mkdtemp(join(parent, ".opendelegate-release-configure-"));
  let publishedIdentity;
  try {
    for (const entry of entries) {
      const outputPath = join(temporaryDirectory, ...entry.path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeNewSyncedFile(outputPath, entry.bytes, entry.mode);
      const verified = await hashStableRegularFile(outputPath);
      if (
        verified.sha256 !== digestBytes(entry.bytes) ||
        verified.size !== entry.bytes.byteLength
      ) {
        throw new Error("A staged release configuration file failed verification.");
      }
    }
    await options.verifyStaged?.(temporaryDirectory);
    await mkdir(destination, { mode: 0o700 });
    publishedIdentity = await lstat(destination, { bigint: true });
    const topLevelEntries = new Set(entries.map(({ path }) => path.split("/")[0]));
    for (const name of topLevelEntries) {
      await rename(join(temporaryDirectory, name), join(destination, name));
    }
    await rmdir(temporaryDirectory);
    await options.verifyPublished?.(destination);
    await syncDirectory(destination);
    await syncDirectory(parent);
    return Object.freeze({
      path: destination,
      files: Object.freeze(
        entries.map((entry) =>
          Object.freeze({
            path: entry.path,
            sha256: digestBytes(entry.bytes),
            size: entry.bytes.byteLength,
          }),
        ),
      ),
    });
  } catch (error) {
    if (publishedIdentity !== undefined) {
      try {
        const current = await lstat(destination, { bigint: true });
        if (sameFileIdentity(current, publishedIdentity)) {
          await rm(destination, { force: true, recursive: true });
        }
      } catch (cleanupError) {
        if (!isNodeError(cleanupError, "ENOENT")) {
          throw cleanupError;
        }
      }
    }
    await removePrivateTemporaryDirectory(temporaryDirectory, parent);
    if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
      throw new Error("The release configuration output already exists; nothing was overwritten.", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function hashStableRegularFile(path, maximumBytes = Number.MAX_SAFE_INTEGER) {
  assertAbsolutePath(path, "release file");
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes) ||
    before.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("A release file is not a bounded regular file.");
  }
  await assertNoLinkedPathComponents(path, "release file");
  const canonicalPath = await realpath(path);
  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error("A release file changed before verification.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = Number(opened.size);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, size - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("A release file ended during verification.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error("A release file changed during verification.");
    }
    return Object.freeze({ sha256: hash.digest("hex"), size });
  } finally {
    await handle.close();
  }
}

export function requireExactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`The ${label} fields do not match the strict canonical schema.`);
  }
}

export function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`The ${label} path must be absolute.`);
  }
}

export async function assertNoLinkedPathComponents(path, label) {
  assertAbsolutePath(path, label);
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const suffix = relative(root, absolutePath);
  let current = root;
  for (const segment of suffix.split(sep).filter((value) => value !== "")) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`The ${label} must not use a symlink, junction, or linked ancestor.`);
    }
  }
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
}

export function assertPortableRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value ||
    value
      .split("/")
      .some(
        (segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"),
      )
  ) {
    throw new Error(`The ${label} path must be safe and portable.`);
  }
}

export function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isSameOrDescendant(root, path) {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

async function writeNewSyncedFile(path, bytes, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupPublishedOutputs(published) {
  for (const item of [...published].reverse()) {
    try {
      const current = await lstat(item.entry.path, { bigint: true });
      if (sameFileIdentity(current, item.identity)) {
        await unlink(item.entry.path);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

async function removePrivateTemporaryDirectory(path, parent) {
  try {
    const [canonicalParent, canonicalPath] = await Promise.all([realpath(parent), realpath(path)]);
    if (!isStrictDescendant(canonicalParent, canonicalPath)) {
      throw new Error("The release temporary directory escaped its output root.");
    }
    await rm(canonicalPath, { force: true, recursive: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function sameFile(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left, right) {
  return (
    (left.dev === 0n || right.dev === 0n || left.dev === right.dev) &&
    left.ino !== 0n &&
    left.ino === right.ino
  );
}

function isStrictDescendant(root, path) {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function comparablePath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeError(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
