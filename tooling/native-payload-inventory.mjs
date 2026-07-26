import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const maximumNativeFileBytes = 512 * 1024 * 1024;
const maximumHeaderBytes = 1024 * 1024;
const nativeSuffixPattern = /\.(?:dll|dylib|exe|node|so(?:\.[0-9]+)*)$/iu;
const machMagic = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca,
]);

export async function discoverThirdPartyNativeComponents(options) {
  const platform = options.platform;
  if (!supportedPlatforms.has(platform)) {
    throw new Error("Third-party native discovery uses an unsupported platform.");
  }
  const root = await requireRegularDirectory(options.stagingRoot);
  if (!Array.isArray(options.ownedPaths)) {
    throw new Error("Third-party native discovery requires the exact owned path inventory.");
  }
  const ownedPaths = new Set(options.ownedPaths);
  if (
    ownedPaths.size !== options.ownedPaths.length ||
    [...ownedPaths].some((path) => !isPortablePath(path))
  ) {
    throw new Error("The owned native path inventory is not canonical.");
  }

  const discovered = [];
  const runtimePath = platform === "win32" ? "runtime/node.exe" : "runtime/node";
  await visit(root, "");
  if (!discovered.some(({ path }) => path === runtimePath)) {
    throw new Error(`The bundled Node runtime is missing from native discovery: ${runtimePath}.`);
  }
  discovered.sort((left, right) => compareCodeUnits(left.path, right.path));
  return Object.freeze(discovered.map((entry) => Object.freeze(entry)));

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const portablePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (!isPortablePath(portablePath)) {
        throw new Error("The release payload contains a non-portable native discovery path.");
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Third-party native discovery rejects symbolic links and junctions.");
      }
      if (metadata.isDirectory()) {
        await visit(path, portablePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Third-party native discovery rejects special payload entries.");
      }
      if (ownedPaths.has(portablePath)) {
        continue;
      }
      const format = await detectStableNativeFormat(path, root);
      if (format === null) {
        if (nativeSuffixPattern.test(portablePath)) {
          throw new Error(
            `Native-looking payload file has unsupported executable magic: ${portablePath}.`,
          );
        }
        continue;
      }
      if (
        (platform === "win32" && format !== "pe") ||
        (platform === "linux" && format !== "elf") ||
        (platform === "darwin" && format !== "mach-o")
      ) {
        throw new Error(`Payload native format does not match ${platform}: ${portablePath}.`);
      }
      discovered.push({
        kind: portablePath === runtimePath ? "bundled-node-runtime" : "bundled-native-library",
        path: portablePath,
      });
    }
  }
}

async function detectStableNativeFormat(path, root) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumNativeFileBytes)) {
    throw new Error("A native discovery candidate is not one bounded regular file.");
  }
  const canonicalPath = await realpath(path);
  if (!isStrictDescendant(root, canonicalPath)) {
    throw new Error("A native discovery candidate escaped the payload root.");
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error("A native discovery candidate changed before inspection.");
    }
    const bytes = Buffer.alloc(Math.min(Number(opened.size), maximumHeaderBytes));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        Math.min(64 * 1024, bytes.length - position),
        position,
      );
      if (bytesRead <= 0) {
        throw new Error("A native discovery candidate ended before its declared size.");
      }
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error("A native discovery candidate changed during inspection.");
    }
    return detectNativeFormat(bytes, Number(opened.size));
  } finally {
    await handle.close();
  }
}

function detectNativeFormat(bytes, size) {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x7f &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    return "elf";
  }
  if (bytes.length >= 4 && isMachMagic(bytes.readUInt32BE(0))) {
    return "mach-o";
  }
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset <= size - 4 &&
      peOffset + 4 <= bytes.length &&
      bytes[peOffset] === 0x50 &&
      bytes[peOffset + 1] === 0x45 &&
      bytes[peOffset + 2] === 0 &&
      bytes[peOffset + 3] === 0
    ) {
      return "pe";
    }
  }
  return null;
}

function isMachMagic(value) {
  return machMagic.has(value);
}

async function requireRegularDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error("Third-party native discovery requires an absolute payload root.");
  }
  const lexicalPath = resolve(path);
  const [metadata, canonicalPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Third-party native discovery requires a regular payload directory.");
  }
  return canonicalPath;
}

function isPortablePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
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
