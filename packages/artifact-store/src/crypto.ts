import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { ArtifactRandomSource } from "./contracts.ts";
import { ArtifactStoreError } from "./error.ts";

export class NodeArtifactRandomSource implements ArtifactRandomSource {
  public bytes(length: number): Uint8Array {
    return randomBytes(length);
  }
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Base64Url(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function secureRandomBase64Url(random: ArtifactRandomSource, byteLength: number): string {
  const value = random.bytes(byteLength);
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    throw new ArtifactStoreError(
      "ARTIFACT_STORAGE_UNAVAILABLE",
      "The Artifact random source returned an invalid result.",
    );
  }
  return Buffer.from(value).toString("base64url");
}
