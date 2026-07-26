import { constants } from "node:fs";
import { lstat as nodeLstat, open as nodeOpen, realpath as nodeRealpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface StableNodeFileStat {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface StableNodeFileHandle {
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  stat(): Promise<StableNodeFileStat>;
}

export interface StableNodeFileSystem {
  readonly noFollowFlag: number;
  readonly platform: NodeJS.Platform;
  lstat(path: string): Promise<StableNodeFileStat>;
  open(path: string, flags: number): Promise<StableNodeFileHandle>;
  realpath(path: string): Promise<string>;
}

const nativeFileSystem: StableNodeFileSystem = {
  noFollowFlag: typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0,
  platform: process.platform,
  async lstat(path) {
    return nodeLstat(path, { bigint: true });
  },
  async open(path, flags) {
    const handle = await nodeOpen(path, flags);
    return {
      async close() {
        await handle.close();
      },
      async read(buffer, offset, length, position) {
        const { bytesRead } = await handle.read(buffer, offset, length, position);
        return { bytesRead };
      },
      async stat() {
        return handle.stat({ bigint: true });
      },
    };
  },
  realpath: nodeRealpath,
};

export function createStableNodeFileRead(
  fileSystem: StableNodeFileSystem = nativeFileSystem,
): (path: string, maximumBytes: number) => Promise<Uint8Array> {
  return async (path: string, maximumBytes: number): Promise<Uint8Array> => {
    if (
      typeof path !== "string" ||
      path === "" ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      (fileSystem.platform !== "win32" &&
        (!Number.isSafeInteger(fileSystem.noFollowFlag) || fileSystem.noFollowFlag <= 0))
    ) {
      throw new Error("unsafe stable file input");
    }

    const pathBefore = await fileSystem.realpath(path);
    const pathnameBefore = await fileSystem.lstat(path);
    assertRegularBoundedFile(pathnameBefore, maximumBytes);

    const flags =
      constants.O_RDONLY | (fileSystem.platform === "win32" ? 0 : fileSystem.noFollowFlag);
    const handle = await fileSystem.open(path, flags);
    try {
      const descriptorBefore = await handle.stat();
      assertRegularBoundedFile(descriptorBefore, maximumBytes);
      if (!sameFileIdentity(pathnameBefore, descriptorBefore, fileSystem.platform)) {
        throw new Error("unsafe stable file identity");
      }

      const bytes = await readBounded(handle, maximumBytes);
      const descriptorAfter = await handle.stat();
      const pathnameAfter = await fileSystem.lstat(path);
      const pathAfter = await fileSystem.realpath(path);
      if (
        BigInt(bytes.byteLength) !== descriptorBefore.size ||
        !sameFileIdentity(descriptorBefore, descriptorAfter, fileSystem.platform) ||
        !sameFileIdentity(descriptorBefore, pathnameAfter, fileSystem.platform) ||
        !sameCanonicalPath(pathBefore, pathAfter, fileSystem.platform)
      ) {
        throw new Error("unsafe stable file mutation");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  };
}

export const readStableNodeFile = createStableNodeFileRead();

function assertRegularBoundedFile(stat: StableNodeFileStat, maximumBytes: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 0n ||
    stat.size > BigInt(maximumBytes)
  ) {
    throw new Error("unsafe stable file metadata");
  }
}

async function readBounded(
  handle: StableNodeFileHandle,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (position <= maximumBytes) {
    const remaining = maximumBytes - position + 1;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
      throw new Error("unsafe stable file read result");
    }
    if (bytesRead === 0) {
      break;
    }
    position += bytesRead;
    if (position > maximumBytes) {
      throw new Error("unsafe stable file size");
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

function sameFileIdentity(
  left: StableNodeFileStat,
  right: StableNodeFileStat,
  platform: NodeJS.Platform,
): boolean {
  const stableInode = left.ino !== 0n && left.ino === right.ino;
  const stableDevice =
    left.dev === right.dev ||
    (platform === "win32" && stableInode && (left.dev === 0n || right.dev === 0n));
  return (
    stableDevice &&
    stableInode &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameCanonicalPath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
