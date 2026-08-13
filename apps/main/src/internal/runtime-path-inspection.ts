import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

export type RuntimePathLstat = (path: string) => Promise<Stats>;

/**
 * Runtime-owned transient files may be removed after their parent directory was
 * enumerated. A vanished path is safe to skip; every other inspection failure
 * remains fail-closed.
 */
export async function inspectExistingRuntimePath(
  path: string,
  inspect: RuntimePathLstat = (candidate) => lstat(candidate),
): Promise<Stats | undefined> {
  try {
    return await inspect(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
