import "reflect-metadata";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeviceIdentityAuthority,
  DeviceIdentityError,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  type IdentityClock,
  type IdentityRandomSource,
} from "../src/index.ts";

const DEVICE_ID = "Windows_5090";
const CERTIFICATE_VALIDITY_MS = 24 * 60 * 60_000;

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

async function enrolledDevice(now: number): Promise<{
  readonly authority: DeviceIdentityAuthority;
  readonly clock: MutableClock;
  readonly repository: InMemoryDeviceIdentityRepository;
  readonly worker: WorkerDeviceIdentity;
  readonly certificateAuthoritySpki: string;
  readonly originalCertificatePem: string;
  readonly originalSerial: string;
}> {
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new CounterRandomSource(),
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandomSource(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: DEVICE_ID,
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  assert.equal(grant.intent, "enroll");
  const request = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const identity = await authority.enrollDevice({
    certificateRequestPem: request.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: { architecture: "x64", hostname: "workstation", osFamily: "windows" },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });
  assert.equal(identity.generation, 1);
  return {
    authority,
    clock,
    repository,
    worker,
    certificateAuthoritySpki: certificateAuthority.spkiSha256,
    originalCertificatePem: identity.certificatePem,
    originalSerial: identity.serialNumber,
  };
}

test("a Device whose certificate expired offline is re-credentialed under its own identity", async () => {
  const enrolledAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const context = await enrolledDevice(enrolledAt);
  // The Device slept past its certificate. Rotation needs a live certificate to
  // authorize itself, so this is the only route that does not rename the Device.
  const afterExpiry = enrolledAt + CERTIFICATE_VALIDITY_MS + 4 * 60 * 60_000;
  context.clock.set(afterExpiry);

  await assert.rejects(
    context.authority.issueCertificateRotation({
      currentCertificatePem: context.originalCertificatePem,
      deviceId: DEVICE_ID,
      newCertificateRequestPem: (
        await context.worker.createEnrollmentRequest({
          deviceId: DEVICE_ID,
          expectedMainSpkiSha256: context.certificateAuthoritySpki,
        })
      ).certificateRequestPem,
    }),
    (error: unknown) => error instanceof DeviceIdentityError,
  );

  const grant = await context.authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: DEVICE_ID,
    expiresInMs: 5 * 60_000,
    intent: "recredential",
    protocolRange: { minimum: 1, maximum: 1 },
  });
  assert.equal(grant.intent, "recredential");
  const request = await context.worker.createEnrollmentRequest({
    deviceId: DEVICE_ID,
    expectedMainSpkiSha256: context.certificateAuthoritySpki,
  });
  const renewed = await context.authority.enrollDevice({
    certificateRequestPem: request.certificateRequestPem,
    deviceId: DEVICE_ID,
    discovery: { architecture: "x64", hostname: "workstation", osFamily: "windows" },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });

  assert.equal(renewed.deviceId, DEVICE_ID);
  assert.equal(renewed.generation, 2);
  assert.equal(renewed.status, "active");
  assert.equal(renewed.notAfter, afterExpiry + CERTIFICATE_VALIDITY_MS);
  assert.notEqual(renewed.serialNumber, context.originalSerial);
  assert.equal(
    await context.authority.generationWasRecredentialed({
      deviceId: DEVICE_ID,
      certificateGeneration: 2,
    }),
    true,
  );
  assert.equal(
    await context.authority.generationWasRecredentialed({
      deviceId: DEVICE_ID,
      certificateGeneration: 1,
    }),
    false,
    "initial enrollment and routine generations must not request a channel reset",
  );

  const snapshot = await context.repository.snapshot();
  const device = snapshot.devices.find((candidate) => candidate.deviceId === DEVICE_ID);
  assert.equal(device?.identityGeneration, 2);
  assert.equal(device?.status, "active");
  assert.equal(
    device?.createdAt,
    enrolledAt,
    "re-credentialing keeps the Device's original identity rather than creating a new one",
  );
  assert.deepEqual(
    snapshot.certificates
      .filter((certificate) => certificate.deviceId === DEVICE_ID)
      .sort((left, right) => left.generation - right.generation)
      .map((certificate) => ({ generation: certificate.generation, status: certificate.status })),
    [
      { generation: 1, status: "revoked" },
      { generation: 2, status: "active" },
    ],
  );
  assert.deepEqual(
    snapshot.auditRecords.map((record) => record.event),
    [
      "device.enrollment-grant-issued",
      "device.enrolled",
      "device.enrollment-grant-issued",
      "device.recredentialed",
    ],
  );
});

test("re-credentialing revokes a still-valid certificate so a lost key cannot keep working", async () => {
  const enrolledAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const context = await enrolledDevice(enrolledAt);
  context.clock.set(enrolledAt + 60_000);

  const grant = await context.authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: DEVICE_ID,
    expiresInMs: 5 * 60_000,
    intent: "recredential",
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const request = await context.worker.createEnrollmentRequest({
    deviceId: DEVICE_ID,
    expectedMainSpkiSha256: context.certificateAuthoritySpki,
  });
  await context.authority.enrollDevice({
    certificateRequestPem: request.certificateRequestPem,
    deviceId: DEVICE_ID,
    discovery: { architecture: "x64", hostname: "workstation", osFamily: "windows" },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });

  await assert.rejects(
    context.authority.validatePeerIdentity({
      certificatePem: context.originalCertificatePem,
      claimedDeviceId: DEVICE_ID,
    }),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "PEER_CERTIFICATE_REVOKED",
  );
});

test("an enroll grant still refuses an existing Device and a recredential grant refuses an unknown one", async () => {
  const enrolledAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const context = await enrolledDevice(enrolledAt);

  await assert.rejects(
    context.authority.createEnrollmentGrant({
      allowedBootstrapRoles: ["coding"],
      deviceId: DEVICE_ID,
      expiresInMs: 5 * 60_000,
      protocolRange: { minimum: 1, maximum: 1 },
    }),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "DEVICE_ALREADY_ENROLLED",
  );
  await assert.rejects(
    context.authority.createEnrollmentGrant({
      allowedBootstrapRoles: ["coding"],
      deviceId: "Windows_unknown",
      expiresInMs: 5 * 60_000,
      intent: "recredential",
      protocolRange: { minimum: 1, maximum: 1 },
    }),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "DEVICE_IDENTITY_NOT_FOUND",
  );
});

test("a revoked Device is never re-credentialed back into service", async () => {
  const enrolledAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const context = await enrolledDevice(enrolledAt);
  const grant = await context.authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: DEVICE_ID,
    expiresInMs: 5 * 60_000,
    intent: "recredential",
    protocolRange: { minimum: 1, maximum: 1 },
  });
  await context.authority.revokeDevice({ deviceId: DEVICE_ID });

  const request = await context.worker.createEnrollmentRequest({
    deviceId: DEVICE_ID,
    expectedMainSpkiSha256: context.certificateAuthoritySpki,
  });
  await assert.rejects(
    context.authority.enrollDevice({
      certificateRequestPem: request.certificateRequestPem,
      deviceId: DEVICE_ID,
      discovery: { architecture: "x64", hostname: "workstation", osFamily: "windows" },
      grantId: grant.grantId,
      protocolVersion: 1,
      token: grant.secret.reveal(),
    }),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "DEVICE_IDENTITY_NOT_FOUND",
  );

  const snapshot = await context.repository.snapshot();
  const rejection = snapshot.auditRecords.at(-1);
  assert.equal(rejection?.event, "device.enrollment-rejected");
  assert.equal(rejection?.rejectionCode, "device-identity-revoked");
});

test("a recredential grant is single use and cannot be replayed into a third generation", async () => {
  const enrolledAt = Date.UTC(2026, 6, 30, 15, 47, 12);
  const context = await enrolledDevice(enrolledAt);
  const grant = await context.authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: DEVICE_ID,
    expiresInMs: 5 * 60_000,
    intent: "recredential",
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const enroll = async (): Promise<void> => {
    const request = await context.worker.createEnrollmentRequest({
      deviceId: DEVICE_ID,
      expectedMainSpkiSha256: context.certificateAuthoritySpki,
    });
    await context.authority.enrollDevice({
      certificateRequestPem: request.certificateRequestPem,
      deviceId: DEVICE_ID,
      discovery: { architecture: "x64", hostname: "workstation", osFamily: "windows" },
      grantId: grant.grantId,
      protocolVersion: 1,
      token: grant.secret.reveal(),
    });
  };

  await enroll();
  await assert.rejects(
    enroll(),
    (error: unknown) =>
      error instanceof DeviceIdentityError && error.code === "ENROLLMENT_GRANT_INVALID",
  );

  const snapshot = await context.repository.snapshot();
  assert.equal(
    snapshot.devices.find((candidate) => candidate.deviceId === DEVICE_ID)?.identityGeneration,
    2,
  );
});
