import { DISCORD_NATIVE_ATTACHMENT_MAX_BYTES } from "./contracts.ts";

/**
 * Components v2 attachment references use the filename as part of an
 * `attachment://` URL. Keep that reference deliberately narrower than the
 * Artifact Store's cross-platform basename contract.
 */
export function isDiscordNativeAttachmentFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    new TextEncoder().encode(value).byteLength <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

export function isDiscordNativeAttachmentMediaType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 127 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value)
  );
}

export function isDiscordNativeAttachmentSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= DISCORD_NATIVE_ATTACHMENT_MAX_BYTES
  );
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
