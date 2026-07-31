import "reflect-metadata";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  readDeviceCertificateLifecycle,
} from "@opendelegate/device-identity";

import {
  DeviceCertificateUnusableError,
  WorkerDeviceChannelClient,
  type SqliteWorkerChannelState,
} from "../src/index.ts";

class MutableClock {
  private current: number;

  public constructor(current: number) {
    this.current = current;
  }

  public now(): number {
    return this.current;
  }

  public set(now: number): void {
    this.current = now;
  }
}

async function enrolledWorkerIdentity(now: number): Promise<{
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly deviceId: string;
  readonly generation: number;
}> {
  const clock = new MutableClock(now);
  const authority = new DeviceIdentityAuthority({
    clock,
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  await authority.bootstrapCertificateAuthority({ instanceId: "instance-expiry" });
  const grant = await authority.createEnrollmentGrant({
    deviceId: "worker-expiry-1",
    allowedBootstrapRoles: ["coding"],
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const workerIdentity = new WorkerDeviceIdentity({
    clock,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const enrollment = await workerIdentity.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const issued = await authority.enrollDevice({
    grantId: grant.grantId,
    token: grant.secret.reveal(),
    deviceId: grant.deviceId,
    protocolVersion: 1,
    certificateRequestPem: enrollment.certificateRequestPem,
    discovery: {
      architecture: "x64",
      hostname: "worker-expiry",
      osFamily: "windows",
    },
  });
  return {
    certificatePem: issued.certificatePem,
    certificateAuthorityPem: issued.certificateAuthorityPem,
    deviceId: issued.deviceId,
    generation: issued.generation,
  };
}

test("connecting with an expired Device certificate names the expiry instead of leasing the private key", async () => {
  const issuedAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const identity = await enrolledWorkerIdentity(issuedAt);
  const lifecycle = readDeviceCertificateLifecycle(identity.certificatePem, issuedAt);
  let privateKeyLeased = false;

  const failure = await WorkerDeviceChannelClient.connect({
    endpointUrl: "wss://main.invalid/device",
    deviceId: identity.deviceId,
    workerId: "worker-runtime-1",
    mainDeviceId: "main-device-1",
    clock: { now: () => lifecycle.notAfter },
    identity: {
      certificatePem: identity.certificatePem,
      certificateAuthorityPem: identity.certificateAuthorityPem,
      certificateGeneration: identity.generation,
      executeWithPrivateKeyBytes: async () => {
        privateKeyLeased = true;
      },
    },
    state: undefined as unknown as SqliteWorkerChannelState,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(
    failure instanceof DeviceCertificateUnusableError,
    `expected a certificate error, received ${String(failure)}`,
  );
  assert.equal(failure.code, "DEVICE_CERTIFICATE_UNUSABLE");
  assert.equal(failure.state, "expired");
  assert.equal(failure.deviceId, identity.deviceId);
  assert.equal(failure.certificateGeneration, identity.generation);
  assert.equal(failure.notAfter, lifecycle.notAfter);
  assert.match(failure.message, /expired at 2026-07-31T15:47:12\.000Z/u);
  assert.match(failure.message, /re-enrol this Device/u);
  assert.equal(
    privateKeyLeased,
    false,
    "an unusable certificate must not reach the private-key lease",
  );
});

test("a Device certificate that has not taken effect reports the clock rather than an expiry", async () => {
  const issuedAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const identity = await enrolledWorkerIdentity(issuedAt);
  const lifecycle = readDeviceCertificateLifecycle(identity.certificatePem, issuedAt);

  const failure = await WorkerDeviceChannelClient.connect({
    endpointUrl: "wss://main.invalid/device",
    deviceId: identity.deviceId,
    workerId: "worker-runtime-1",
    mainDeviceId: "main-device-1",
    clock: { now: () => lifecycle.notBefore - 1 },
    identity: {
      certificatePem: identity.certificatePem,
      certificateAuthorityPem: identity.certificateAuthorityPem,
      certificateGeneration: identity.generation,
      executeWithPrivateKeyBytes: async () => undefined,
    },
    state: undefined as unknown as SqliteWorkerChannelState,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof DeviceCertificateUnusableError);
  assert.equal(failure.state, "not-yet-valid");
  assert.match(failure.message, /Check this Device's clock/u);
});

test("a certificate still inside its renewal window connects past the credential check", async () => {
  const issuedAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const identity = await enrolledWorkerIdentity(issuedAt);
  const lifecycle = readDeviceCertificateLifecycle(identity.certificatePem, issuedAt);
  let privateKeyLeased = false;

  const failure = await WorkerDeviceChannelClient.connect({
    endpointUrl: "wss://main.invalid/device",
    deviceId: identity.deviceId,
    workerId: "worker-runtime-1",
    mainDeviceId: "main-device-1",
    clock: { now: () => lifecycle.notAfter - 1 },
    identity: {
      certificatePem: identity.certificatePem,
      certificateAuthorityPem: identity.certificateAuthorityPem,
      certificateGeneration: identity.generation,
      executeWithPrivateKeyBytes: async (executor) => {
        privateKeyLeased = true;
        await executor(new Uint8Array(0));
      },
    },
    state: undefined as unknown as SqliteWorkerChannelState,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.equal(
    failure instanceof DeviceCertificateUnusableError,
    false,
    "a usable certificate must not be refused",
  );
  assert.equal(privateKeyLeased, true);
});
