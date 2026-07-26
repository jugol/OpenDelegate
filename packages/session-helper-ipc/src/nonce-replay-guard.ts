import { createHash } from "node:crypto";

import type { SessionHelperBinding, SessionHelperIpcNonceReplayGuard } from "./contracts.ts";

const DEFAULT_MAX_ENTRIES = 65_536;

export interface InMemoryNonceReplayGuardOptions {
  readonly maxEntries?: number;
}

export class InMemoryNonceReplayGuard implements SessionHelperIpcNonceReplayGuard {
  readonly #claims = new Set<string>();
  readonly #maxEntries: number;

  public constructor(options: InMemoryNonceReplayGuardOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 1_000_000) {
      throw new TypeError("The nonce replay guard capacity is invalid.");
    }
    this.#maxEntries = maxEntries;
  }

  public claim(role: "core" | "helper", binding: SessionHelperBinding, nonce: Buffer): boolean {
    if (!Buffer.isBuffer(nonce) || nonce.length !== 32) {
      return false;
    }
    const claim = createHash("sha256")
      .update(role)
      .update("\0")
      .update(binding.deviceId)
      .update("\0")
      .update(binding.helperId)
      .update("\0")
      .update(binding.sessionId)
      .update("\0")
      .update(String(binding.serviceEpoch))
      .update("\0")
      .update(binding.releaseVersion)
      .update("\0")
      .update(nonce)
      .digest("base64url");
    if (this.#claims.has(claim) || this.#claims.size >= this.#maxEntries) {
      return false;
    }
    this.#claims.add(claim);
    return true;
  }
}
