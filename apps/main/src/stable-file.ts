import { constants as fileConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

const DEFAULT_MAXIMUM_BYTES = 512 * 1024 * 1024;

export type StableFileErrorCode = "CHANGED" | "NOT_REGULAR" | "TOO_LARGE";

export class StableFileError extends Error {
  readonly code: StableFileErrorCode;

  constructor(code: StableFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StableFileError";
    this.code = code;
  }
}

export async function readStableRegularFile(
  path: string,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new StableFileError("TOO_LARGE", "The stable-file byte limit is invalid.");
  }

  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new StableFileError("NOT_REGULAR", "The path is not a regular file.");
  }

  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  const handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking);
  try {
    const opened = await handle.stat({ bigint: true });
    const openedPath = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      openedPath.isSymbolicLink() ||
      !sameFile(before, opened) ||
      !sameFile(opened, openedPath)
    ) {
      throw new StableFileError("CHANGED", "The regular file changed while it was opened.");
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw new StableFileError("TOO_LARGE", "The regular file exceeds its byte limit.");
    }

    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new StableFileError("CHANGED", "The regular file shrank while it was read.");
      }
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(overflowProbe, 0, 1, offset)).bytesRead !== 0) {
      throw new StableFileError("TOO_LARGE", "The regular file grew beyond its byte limit.");
    }

    const afterRead = await handle.stat({ bigint: true });
    const afterReadPath = await lstat(path, { bigint: true });
    if (
      afterReadPath.isSymbolicLink() ||
      !sameSnapshot(opened, afterRead) ||
      !sameSnapshot(afterRead, afterReadPath)
    ) {
      throw new StableFileError("CHANGED", "The regular file changed while it was read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.ino === right.ino &&
    (left.dev === right.dev ||
      (process.platform === "win32" &&
        (left.dev === 0n || right.dev === 0n) &&
        left.birthtimeNs === right.birthtimeNs))
  );
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
