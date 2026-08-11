import { win32 } from "node:path";

const WINDOWS_DEVICE_COMPONENT = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;

/**
 * Accepts a canonical, non-root local DOS-drive path. Win32 silently strips
 * trailing spaces and periods from components and interprets reserved device
 * names even below an ordinary drive path, so those aliases are rejected too.
 */
export function isCanonicalLocalWindowsPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.endsWith("\\") ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f) ||
    !/^[A-Za-z]:\\[^<>:"|?*]+$/u.test(value) ||
    !win32.isAbsolute(value) ||
    win32.normalize(value) !== value
  ) {
    return false;
  }
  return value
    .slice(3)
    .split("\\")
    .every(
      (component) =>
        component.length > 0 &&
        !/[ .]$/u.test(component) &&
        !WINDOWS_DEVICE_COMPONENT.test(component),
    );
}

/**
 * Accepts only the canonical, non-root Windows profile path carried by a
 * service document. Callers decide whether absence is optional or fatal.
 */
export function parseWindowsOwnerHome(value: unknown): string | undefined {
  if (!isCanonicalLocalWindowsPath(value) || win32.dirname(value) === value) {
    return undefined;
  }
  return value;
}
