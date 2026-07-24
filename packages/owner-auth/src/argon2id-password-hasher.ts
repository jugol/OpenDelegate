import { hash, verify } from "@node-rs/argon2";

import { NodeCryptoRandomSource } from "./crypto.ts";
import { OwnerAuthError } from "./error.ts";
import type { PasswordHasher, SecureRandomSource } from "./contracts.ts";

const MINIMUM_MEMORY_COST_KIB = 65_536;
const MINIMUM_TIME_COST = 3;
const MINIMUM_PARALLELISM = 4;
const MINIMUM_SALT_LENGTH = 16;
const MINIMUM_OUTPUT_LENGTH = 32;

export interface Argon2idPasswordHasherOptions {
  readonly memoryCostKiB?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
  readonly saltLength?: number;
  readonly outputLength?: number;
  readonly random?: SecureRandomSource;
}

export class Argon2idPasswordHasher implements PasswordHasher {
  private readonly memoryCostKiB: number;
  private readonly timeCost: number;
  private readonly parallelism: number;
  private readonly saltLength: number;
  private readonly outputLength: number;
  private readonly random: SecureRandomSource;

  public constructor(options: Argon2idPasswordHasherOptions = {}) {
    this.memoryCostKiB = options.memoryCostKiB ?? MINIMUM_MEMORY_COST_KIB;
    this.timeCost = options.timeCost ?? MINIMUM_TIME_COST;
    this.parallelism = options.parallelism ?? MINIMUM_PARALLELISM;
    this.saltLength = options.saltLength ?? MINIMUM_SALT_LENGTH;
    this.outputLength = options.outputLength ?? MINIMUM_OUTPUT_LENGTH;
    this.random = options.random ?? new NodeCryptoRandomSource();

    assertFloor(this.memoryCostKiB, MINIMUM_MEMORY_COST_KIB, "memory cost");
    assertFloor(this.timeCost, MINIMUM_TIME_COST, "time cost");
    assertFloor(this.parallelism, MINIMUM_PARALLELISM, "parallelism");
    assertFloor(this.saltLength, MINIMUM_SALT_LENGTH, "salt length");
    assertFloor(this.outputLength, MINIMUM_OUTPUT_LENGTH, "output length");
  }

  public async hash(passphrase: string): Promise<string> {
    const salt = this.random.bytes(this.saltLength);
    if (!(salt instanceof Uint8Array) || salt.byteLength !== this.saltLength) {
      throw new OwnerAuthError(
        "AUTHENTICATION_UNAVAILABLE",
        "The Argon2id salt source returned an invalid result.",
      );
    }

    return hash(passphrase, {
      algorithm: 2,
      version: 1,
      memoryCost: this.memoryCostKiB,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
      outputLen: this.outputLength,
      salt,
    });
  }

  public async verify(encodedPhc: string, passphrase: string): Promise<boolean> {
    return verify(encodedPhc, passphrase);
  }

  public needsRehash(encodedPhc: string): boolean {
    const parameters = parseArgon2idPhc(encodedPhc);
    return (
      parameters === null ||
      parameters.version !== 19 ||
      parameters.memoryCostKiB < this.memoryCostKiB ||
      parameters.timeCost < this.timeCost ||
      parameters.parallelism < this.parallelism ||
      parameters.saltLength < this.saltLength ||
      parameters.outputLength < this.outputLength
    );
  }
}

interface Argon2idPhcParameters {
  readonly version: number;
  readonly memoryCostKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly saltLength: number;
  readonly outputLength: number;
}

function parseArgon2idPhc(encodedPhc: string): Argon2idPhcParameters | null {
  const match =
    /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      encodedPhc,
    );
  if (match === null) {
    return null;
  }

  const [, version, memoryCostKiB, timeCost, parallelism, salt, output] = match;
  if (
    version === undefined ||
    memoryCostKiB === undefined ||
    timeCost === undefined ||
    parallelism === undefined ||
    salt === undefined ||
    output === undefined
  ) {
    return null;
  }

  return {
    version: Number(version),
    memoryCostKiB: Number(memoryCostKiB),
    timeCost: Number(timeCost),
    parallelism: Number(parallelism),
    saltLength: decodeUnpaddedBase64Length(salt),
    outputLength: decodeUnpaddedBase64Length(output),
  };
}

function decodeUnpaddedBase64Length(value: string): number {
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return 0;
  }
}

function assertFloor(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new OwnerAuthError(
      "AUTHENTICATION_UNAVAILABLE",
      `Argon2id ${label} must be an integer at or above the accepted security floor.`,
    );
  }
}
