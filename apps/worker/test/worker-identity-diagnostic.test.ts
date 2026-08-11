import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  type DeviceIdentitySecretStore,
  type IdentityClock,
  type IdentityRandomSource,
} from "@opendelegate/device-identity";
import { SecretError, type ManagedSecretStore } from "@opendelegate/secrets";

import { inspectWorkerIdentityKey } from "../src/worker-app.ts";

const NOW = Date.UTC(2026, 7, 11, 0, 0, 0);

class FixedClock implements IdentityClock {
  public now(): number {
    return NOW;
  }
}

class CounterRandom implements IdentityRandomSource {
  private value = 1;

  public bytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      result[index] = this.value % 256;
      this.value += 1;
    }
    return result;
  }
}

class CapturingIdentityStore implements DeviceIdentitySecretStore {
  readonly #keys = new Map<string, CryptoKeyPair>();
  #pkcs8: Uint8Array | undefined;

  public async createP256KeyPair(keyId: string): Promise<CryptoKeyPair> {
    const keys = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    this.#keys.set(keyId, keys);
    this.#pkcs8 = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey),
    );
    return keys;
  }

  public async getPrivateKey(keyId: string): Promise<CryptoKey | null> {
    return this.#keys.get(keyId)?.privateKey ?? null;
  }

  public async signP256(keyId: string, value: BufferSource): Promise<Uint8Array> {
    const key = this.#keys.get(keyId)?.privateKey;
    assert.ok(key);
    return new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, value),
    );
  }

  public async has(keyId: string): Promise<boolean> {
    return this.#keys.has(keyId);
  }

  public privateBytes(): Uint8Array {
    assert.ok(this.#pkcs8);
    return new Uint8Array(this.#pkcs8);
  }
}

async function identityFixture(): Promise<{ certificatePem: string; privateBytes: Uint8Array }> {
  const clock = new FixedClock();
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new CounterRandom(),
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  await authority.bootstrapCertificateAuthority({ instanceId: "identity-diagnostic" });
  const workerSecrets = new CapturingIdentityStore();
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandom(),
    secrets: workerSecrets,
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: "diagnostic-worker",
    expiresInMs: 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const enrollment = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const identity = await authority.enrollDevice({
    certificateRequestPem: enrollment.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: { architecture: "arm64", hostname: "mac", osFamily: "macos" },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });
  return { certificatePem: identity.certificatePem, privateBytes: workerSecrets.privateBytes() };
}

function managedStore(
  execute: ManagedSecretStore["executeWithSecretBytes"],
): Pick<ManagedSecretStore, "executeWithSecretBytes"> {
  return { executeWithSecretBytes: execute };
}

describe("Worker identity-key diagnostics", () => {
  it("proves that the readable private key matches the enrolled certificate", async () => {
    const fixture = await identityFixture();
    assert.equal(
      await inspectWorkerIdentityKey(
        managedStore(async (_alias, executor) => {
          await executor(fixture.privateBytes);
        }),
        "identity-p256.test",
        fixture.certificatePem,
      ),
      "ready",
    );
  });

  it("distinguishes unavailable, invalid, and mismatched identity keys", async () => {
    const fixture = await identityFixture();
    const other = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const otherBytes = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("pkcs8", other.privateKey),
    );

    assert.equal(
      await inspectWorkerIdentityKey(
        managedStore(async () => {
          throw new SecretError("SECRET_STORE_ACCESS_FAILED", "unavailable");
        }),
        "identity-p256.test",
        fixture.certificatePem,
      ),
      "unavailable",
    );
    assert.equal(
      await inspectWorkerIdentityKey(
        managedStore(async (_alias, executor) => {
          await executor(new Uint8Array([1, 2, 3]));
        }),
        "identity-p256.test",
        fixture.certificatePem,
      ),
      "invalid",
    );
    assert.equal(
      await inspectWorkerIdentityKey(
        managedStore(async (_alias, executor) => {
          await executor(otherBytes);
        }),
        "identity-p256.test",
        fixture.certificatePem,
      ),
      "mismatch",
    );
  });
});
