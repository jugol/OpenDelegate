import "reflect-metadata";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeviceIdentityAuthority,
  DeviceIdentityError,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  deviceCertificateIsUsable,
  readDeviceCertificateLifecycle,
  type IdentityClock,
  type IdentityRandomSource,
} from "../src/index.ts";

class MutableClock implements IdentityClock {
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

class CounterRandomSource implements IdentityRandomSource {
  private next = 1;

  public bytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let index = 0; index < result.length; index += 1) {
      result[index] = this.next % 256;
      this.next += 1;
    }
    return result;
  }
}

async function enrollDeviceCertificate(now: number): Promise<{
  readonly certificatePem: string;
  readonly serialNumber: string;
}> {
  const clock = new MutableClock(now);
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new CounterRandomSource(),
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  await authority.bootstrapCertificateAuthority({ instanceId: "instance-personal" });
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandomSource(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: "device-windows-workstation",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const rawToken = grant.secret.reveal();
  const enrollmentRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  const identity = await authority.enrollDevice({
    certificateRequestPem: enrollmentRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "x64",
      hostname: "workstation",
      osFamily: "windows",
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: rawToken,
  });
  return { certificatePem: identity.certificatePem, serialNumber: identity.serialNumber };
}

test("an issued Device certificate reports a renewal deadline well before it expires", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const { certificatePem, serialNumber } = await enrollDeviceCertificate(now);

  const lifecycle = readDeviceCertificateLifecycle(certificatePem, now);

  assert.equal(lifecycle.state, "valid");
  assert.equal(lifecycle.serialNumber, serialNumber);
  assert.equal(lifecycle.notBefore, now - 60_000);
  assert.equal(lifecycle.notAfter, now + 24 * 60 * 60_000);
  assert.equal(lifecycle.expiresInMs, 24 * 60 * 60_000);
  assert.equal(
    lifecycle.renewAfter,
    lifecycle.notBefore + Math.floor((lifecycle.notAfter - lifecycle.notBefore) / 2),
  );
  assert.ok(deviceCertificateIsUsable(lifecycle));
  assert.ok(
    lifecycle.notAfter - lifecycle.renewAfter >= 11 * 60 * 60_000,
    "renewal must leave hours of retry budget before lockout",
  );
});

test("a Device certificate becomes renewable at its halfway point and stays usable until it expires", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const { certificatePem } = await enrollDeviceCertificate(now);
  const issued = readDeviceCertificateLifecycle(certificatePem, now);

  const justBefore = readDeviceCertificateLifecycle(certificatePem, issued.renewAfter - 1);
  assert.equal(justBefore.state, "valid");

  const atDeadline = readDeviceCertificateLifecycle(certificatePem, issued.renewAfter);
  assert.equal(atDeadline.state, "renewable");
  assert.ok(deviceCertificateIsUsable(atDeadline));

  const lastUsableInstant = readDeviceCertificateLifecycle(certificatePem, issued.notAfter - 1);
  assert.equal(lastUsableInstant.state, "renewable");
  assert.equal(lastUsableInstant.expiresInMs, 1);
  assert.ok(deviceCertificateIsUsable(lastUsableInstant));
});

test("a Device certificate expires at its exact deadline and reports no remaining lifetime", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const { certificatePem } = await enrollDeviceCertificate(now);
  const issued = readDeviceCertificateLifecycle(certificatePem, now);

  const expired = readDeviceCertificateLifecycle(certificatePem, issued.notAfter);

  assert.equal(expired.state, "expired");
  assert.equal(expired.expiresInMs, 0);
  assert.equal(deviceCertificateIsUsable(expired), false);

  const longExpired = readDeviceCertificateLifecycle(certificatePem, issued.notAfter + 86_400_000);
  assert.equal(longExpired.state, "expired");
  assert.equal(longExpired.expiresInMs, 0);
});

test("a Device certificate that has not yet taken effect is reported as unusable rather than expired", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const { certificatePem } = await enrollDeviceCertificate(now);
  const issued = readDeviceCertificateLifecycle(certificatePem, now);

  const early = readDeviceCertificateLifecycle(certificatePem, issued.notBefore - 1);

  assert.equal(early.state, "not-yet-valid");
  assert.equal(deviceCertificateIsUsable(early), false);
});

test("an unparseable certificate or an invalid clock fails with an identity error", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const { certificatePem } = await enrollDeviceCertificate(now);

  assert.throws(
    () => readDeviceCertificateLifecycle("-----BEGIN CERTIFICATE-----\nnot-a-certificate\n", now),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "PEER_CERTIFICATE_INVALID",
  );
  assert.throws(
    () => readDeviceCertificateLifecycle(certificatePem, Number.NaN),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "IDENTITY_CONFIGURATION_INVALID",
  );
});
