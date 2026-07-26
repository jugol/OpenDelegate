const WINDOWS_RESERVED_DEVICE_NAME = /^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export function isPortableArtifactRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    containsControl(value)
  ) {
    return false;
  }
  return value.split("/").every(isPortableArtifactPathSegment);
}

export function isPortableArtifactFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !containsControl(value) &&
    isPortableArtifactPathSegment(value)
  );
}

/**
 * A conservative cross-platform identity for collision checks. Accepted path
 * segments are NFC, so this also rejects case-equivalent destinations on
 * case-insensitive Windows and default macOS filesystems.
 */
export function portableArtifactPathKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isPortableArtifactPathSegment(segment: string): boolean {
  return (
    segment.length >= 1 &&
    segment.length <= 255 &&
    Buffer.byteLength(segment, "utf8") <= 255 &&
    segment !== "." &&
    segment !== ".." &&
    segment.trim() === segment &&
    !segment.endsWith(".") &&
    segment.normalize("NFC") === segment &&
    !WINDOWS_RESERVED_DEVICE_NAME.test(segment)
  );
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point === undefined || point < 32 || point === 127;
  });
}
