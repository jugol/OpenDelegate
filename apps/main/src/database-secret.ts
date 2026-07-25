import { TextDecoder } from "node:util";

import type { ManagedSecretStore } from "@opendelegate/secrets";

const MAIN_SECRET_REFERENCE = /^secret:\/\/main\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/u;

export class MainDatabaseSecretError extends Error {
  public readonly code = "DATABASE_SECRET_UNAVAILABLE";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainDatabaseSecretError";
  }
}

export function validateMainSecretReference(input: unknown): string {
  if (typeof input !== "string" || !MAIN_SECRET_REFERENCE.test(input)) {
    throw new MainDatabaseSecretError("A canonical secret://main/<alias> reference is required.");
  }
  return input;
}

export function mainSecretAlias(reference: string): string {
  const match = MAIN_SECRET_REFERENCE.exec(validateMainSecretReference(reference));
  if (match?.[1] === undefined) {
    throw new MainDatabaseSecretError("The Main Secret reference is invalid.");
  }
  return match[1];
}

/**
 * Resolves a PostgreSQL credential only within the ManagedSecretStore callback.
 * The callback cannot return the URI, and the copied byte buffer is always
 * zeroed before this method completes.
 */
export async function executeWithPostgresUri(
  store: ManagedSecretStore,
  reference: string,
  executor: (uri: string) => void | Promise<void>,
): Promise<void> {
  const alias = mainSecretAlias(reference);
  if (
    store === null ||
    typeof store !== "object" ||
    typeof store.executeWithSecretBytes !== "function"
  ) {
    throw new MainDatabaseSecretError("The Main managed Secret Store is unavailable.");
  }
  const availability = await store.availability(alias).catch(() => undefined);
  if (availability?.ready !== true || availability.alias !== alias) {
    throw new MainDatabaseSecretError(
      `The PostgreSQL Secret reference ${reference} is not provisioned on this Main Device.`,
    );
  }
  try {
    await store.executeWithSecretBytes(alias, async (secret) => {
      const material = Buffer.from(secret);
      try {
        let uri: string;
        try {
          uri = new TextDecoder("utf-8", { fatal: true }).decode(material);
        } catch {
          throw new MainDatabaseSecretError(
            `The PostgreSQL Secret reference ${reference} does not contain valid UTF-8.`,
          );
        }
        validatePostgresUri(uri, reference);
        await executor(uri);
      } finally {
        material.fill(0);
      }
    });
  } catch (error) {
    if (error instanceof MainDatabaseSecretError) {
      throw error;
    }
    throw new MainDatabaseSecretError(
      `The PostgreSQL Secret reference ${reference} could not be resolved.`,
      { cause: error },
    );
  }
}

export function validatePostgresSecretMaterial(value: Uint8Array): void {
  const material = Buffer.from(value);
  try {
    let uri: string;
    try {
      uri = new TextDecoder("utf-8", { fatal: true }).decode(material);
    } catch {
      throw new MainDatabaseSecretError("The PostgreSQL credential must be valid UTF-8.");
    }
    validatePostgresUri(uri, "the supplied Secret");
  } finally {
    material.fill(0);
  }
}

function validatePostgresUri(uri: string, label: string): void {
  if (
    uri.length < 1 ||
    uri.length > 8 * 1024 ||
    uri !== uri.trim() ||
    uri.includes("\0") ||
    uri.includes("\r") ||
    uri.includes("\n")
  ) {
    throw new MainDatabaseSecretError(`${label} is not a valid PostgreSQL URI.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new MainDatabaseSecretError(`${label} is not a valid PostgreSQL URI.`);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.length === 0
  ) {
    throw new MainDatabaseSecretError(`${label} is not a valid PostgreSQL URI.`);
  }
}
