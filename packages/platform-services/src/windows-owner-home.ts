import { win32 } from "node:path";

/**
 * Accepts only the canonical, non-root Windows profile path carried by a
 * service document. Callers decide whether absence is optional or fatal.
 */
export function parseWindowsOwnerHome(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\n") ||
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    win32.dirname(value) === value
  ) {
    return undefined;
  }
  return value;
}
