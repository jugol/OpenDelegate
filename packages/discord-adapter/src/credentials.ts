import { randomBytes } from "node:crypto";

import { DiscordApiError } from "./errors.ts";

/**
 * The caller owns the Device-local Secret Store or vault entry. The callback scope
 * prevents the Discord credential from becoming configuration or a long-lived
 * property on the HTTP or Gateway driver.
 */
export interface DiscordBotCredentialProvider {
  withBotToken<TResult>(operation: (botToken: string) => Promise<TResult>): Promise<TResult>;
}

export interface DiscordInteractionTokenVaultEntry {
  readonly applicationId: string;
  readonly interactionToken: string;
}

export interface DiscordInteractionTokenVault {
  store(input: DiscordInteractionTokenVaultEntry & { readonly lifetimeMs: number }): Promise<{
    readonly responseRef: string;
  }>;
  use<TResult>(
    responseRef: string,
    operation: (entry: DiscordInteractionTokenVaultEntry) => Promise<TResult>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: TResult }>;
}

export interface InMemoryDiscordInteractionTokenVaultOptions {
  readonly nowMs?: () => number;
  readonly createReference?: () => string;
}

interface StoredInteractionToken extends DiscordInteractionTokenVaultEntry {
  readonly expiresAtMs: number;
}

/**
 * A process-local implementation suitable for one live Main process. The opaque
 * reference may be persisted; the token map cannot be serialized and expires
 * lazily. A host that needs restart-spanning interaction follow-up can inject an
 * OS-vault-backed implementation of the same callback contract.
 */
export class InMemoryDiscordInteractionTokenVault implements DiscordInteractionTokenVault {
  readonly #entries = new Map<string, StoredInteractionToken>();
  readonly #nowMs: () => number;
  readonly #createReference: () => string;

  public constructor(options: InMemoryDiscordInteractionTokenVaultOptions = {}) {
    this.#nowMs = options.nowMs ?? Date.now;
    this.#createReference =
      options.createReference ??
      (() => `discord-interaction-ref:${randomBytes(24).toString("base64url")}`);
  }

  public async store(
    input: DiscordInteractionTokenVaultEntry & { readonly lifetimeMs: number },
  ): Promise<{ readonly responseRef: string }> {
    assertSnowflake(input.applicationId, "Discord Application ID");
    assertSecret(input.interactionToken);
    if (
      !Number.isSafeInteger(input.lifetimeMs) ||
      input.lifetimeMs < 1 ||
      input.lifetimeMs > 15 * 60_000
    ) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The interaction token lifetime is outside the supported bound.",
      );
    }

    const nowMs = this.#nowMs();
    assertTimestamp(nowMs);
    this.#prune(nowMs);
    const responseRef = this.#createReference();
    assertResponseReference(responseRef);
    if (this.#entries.has(responseRef)) {
      throw new DiscordApiError(
        "INVALID_RESPONSE",
        "The interaction token vault generated a duplicate opaque reference.",
      );
    }
    this.#entries.set(responseRef, {
      applicationId: input.applicationId,
      interactionToken: input.interactionToken,
      expiresAtMs: nowMs + input.lifetimeMs,
    });
    return Object.freeze({ responseRef });
  }

  public async use<TResult>(
    responseRef: string,
    operation: (entry: DiscordInteractionTokenVaultEntry) => Promise<TResult>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: TResult }> {
    assertResponseReference(responseRef);
    const nowMs = this.#nowMs();
    assertTimestamp(nowMs);
    this.#prune(nowMs);
    const entry = this.#entries.get(responseRef);
    if (entry === undefined) {
      return Object.freeze({ found: false as const });
    }
    const value = await operation({
      applicationId: entry.applicationId,
      interactionToken: entry.interactionToken,
    });
    return Object.freeze({ found: true as const, value });
  }

  #prune(nowMs: number): void {
    for (const [reference, entry] of this.#entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.#entries.delete(reference);
      }
    }
  }
}

export function assertResponseReference(value: string): void {
  if (!/^discord-interaction-ref:[A-Za-z0-9_-]{1,128}$/u.test(value) || value.length > 160) {
    throw new DiscordApiError(
      "INVALID_RESPONSE",
      "The interaction token vault returned an invalid opaque reference.",
    );
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^[0-9]{17,20}$/u.test(value)) {
    throw new DiscordApiError("INVALID_RESPONSE", `${label} is invalid.`);
  }
}

function assertSecret(value: string): void {
  if (
    value.length < 1 ||
    value.length > 4096 ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new DiscordApiError("INVALID_RESPONSE", "The Discord credential is invalid.");
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DiscordApiError("INVALID_RESPONSE", "The token vault clock is invalid.");
  }
}
