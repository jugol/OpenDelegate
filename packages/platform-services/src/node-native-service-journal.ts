import { randomUUID } from "node:crypto";
import { constants as fileConstants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  NativeServiceCommandJournalError,
  type NativeServiceJournalAtomicBoundary,
} from "./native-service-journal.ts";

export function createNodeNativeServiceJournalAtomicBoundary(): NativeServiceJournalAtomicBoundary {
  return {
    async ensureDirectory(path, mode) {
      const before = await safeLstat(path);
      if (before !== undefined && (!before.isDirectory() || before.isSymbolicLink())) {
        throw unavailable("The native service journal directory is not a regular directory.");
      }
      await mkdir(path, { recursive: true, mode });
      const after = await lstat(path);
      if (!after.isDirectory() || after.isSymbolicLink()) {
        throw unavailable("The native service journal directory changed during creation.");
      }
      await chmod(path, mode);
    },

    async withExclusiveLock<Result>(
      lockPath: string,
      operation: () => Promise<Result>,
    ): Promise<Result> {
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.writeFile(
          `${JSON.stringify({
            schemaVersion: 1,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await lock.sync();
      } catch (error) {
        await lock?.close().catch(() => undefined);
        throw unavailable(
          "The native service journal is already locked or its lock cannot be created. A stale lock requires explicit inspection; it is never stolen automatically.",
          error,
        );
      }
      try {
        return await operation();
      } finally {
        await lock.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    },

    async readFile(path, maximumBytes) {
      const before = await safeLstat(path);
      if (before === undefined) {
        return undefined;
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        throw unavailable("The native service journal is linked, special, empty, or oversized.");
      }
      const bytes = await readStableRegularFile(path, maximumBytes);
      if (bytes.length === 0) {
        throw unavailable("The native service journal is linked, special, empty, or oversized.");
      }
      return bytes;
    },

    async writeFileAtomic(path, bytes, mode) {
      const existing = await safeLstat(path);
      if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
        throw unavailable("The native service journal path is occupied by a link or special file.");
      }
      const temporary = join(dirname(path), `.${randomUUID()}.native-service-journal.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", mode);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, path);
        await chmod(path, mode);
        await syncDirectory(dirname(path));
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}

async function readStableRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw unavailable("The native service journal byte limit is invalid.");
  }
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const nonBlocking = fileConstants.O_NONBLOCK ?? 0;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fileConstants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    throw unavailable("The native service journal could not be opened safely.", error);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const openedPath = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      !sameFile(opened, openedPath)
    ) {
      throw unavailable("The native service journal is not a stable regular file.");
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw unavailable("The native service journal is oversized.");
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        throw unavailable("The native service journal shrank during a stable read.");
      }
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(overflowProbe, 0, 1, offset)).bytesRead !== 0) {
      throw unavailable("The native service journal grew beyond its byte limit.");
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameSnapshot(opened, after) ||
      !sameSnapshot(after, afterPath)
    ) {
      throw unavailable("The native service journal changed during a stable read.");
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

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== "win32" &&
      !isErrorCode(error, "EINVAL") &&
      !isErrorCode(error, "EISDIR")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function unavailable(message: string, cause?: unknown): NativeServiceCommandJournalError {
  return new NativeServiceCommandJournalError(
    "NATIVE_SERVICE_JOURNAL_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
