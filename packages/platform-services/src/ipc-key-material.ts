import { createHash, generateKeyPairSync } from "node:crypto";

import { PlatformServiceError, type LocalIpcPublicKeyPin } from "./types.ts";

export interface LocalIpcKeyMaterial {
  /**
   * The private half, PKCS#8 DER. It belongs in the Device Secret Store under the
   * plane's `secretReferences` entry and must never reach the configuration
   * document, which is written in the clear.
   */
  readonly privateKeyPkcs8: Buffer;
  readonly pin: LocalIpcPublicKeyPin;
}

/**
 * Mints one signing identity for a local IPC plane.
 *
 * The pin is what an owner cannot produce by hand: `keyId` is the SHA-256 of the
 * exact SPKI DER bytes that `publicKeySpkiBase64Url` encodes, and the two are
 * cross-checked wherever the document is read. Deriving both from one generated
 * key is the only way they agree by construction rather than by luck.
 */
export function createLocalIpcKeyMaterial(): LocalIpcKeyMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }),
    pin: Object.freeze({
      keyId: `sha256:${createHash("sha256").update(spki).digest("hex")}` as const,
      publicKeySpkiBase64Url: spki.toString("base64url"),
    }),
  });
}

/**
 * Mints the pair of identities one host needs, one per plane.
 *
 * Core and helper must be distinct: a shared key would let either plane forge the
 * other's frames, and the configuration reader rejects it outright. Generating
 * both here keeps that guarantee at the point of creation.
 */
export function createLocalIpcTrustMaterial(): {
  readonly core: LocalIpcKeyMaterial;
  readonly helper: LocalIpcKeyMaterial;
} {
  const core = createLocalIpcKeyMaterial();
  const helper = createLocalIpcKeyMaterial();
  if (core.pin.keyId === helper.pin.keyId) {
    throw new PlatformServiceError(
      "INVALID_IDENTITY",
      "The generated core and helper IPC signing identities collided.",
    );
  }
  return Object.freeze({ core, helper });
}
