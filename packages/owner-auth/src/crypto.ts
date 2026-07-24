import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { OwnerAuthError } from "./error.ts";
import type { SecureRandomSource } from "./contracts.ts";

const CSRF_DOMAIN = "OpenDelegate Admin CSRF v1";

export class NodeCryptoRandomSource implements SecureRandomSource {
  public bytes(length: number): Uint8Array {
    return randomBytes(length);
  }
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function versionedRecoveryDigest(value: string): string {
  return `v1:${sha256Digest(value)}`;
}

export function deriveCsrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken).update(CSRF_DOMAIN, "utf8").digest("base64url");
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function randomToken(random: SecureRandomSource, byteLength: number): string {
  const bytes = random.bytes(byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== byteLength) {
    throw new OwnerAuthError(
      "AUTHENTICATION_UNAVAILABLE",
      "The secure random source returned an invalid result.",
    );
  }
  return Buffer.from(bytes).toString("base64url");
}
