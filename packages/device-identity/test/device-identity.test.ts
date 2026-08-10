import "reflect-metadata";

import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";

import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  DeviceIdentityError,
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

class LeadingZeroRandomSource implements IdentityRandomSource {
  private next = 1;

  public bytes(length: number): Uint8Array {
    const result = new Uint8Array(length);
    for (let index = 1; index < result.length; index += 1) {
      result[index] = this.next % 256;
      this.next += 1;
    }
    return result;
  }
}

class AllZeroRandomSource implements IdentityRandomSource {
  public bytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }
}

test("Main bootstraps one durable public certificate authority without persisting its private key", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const secrets = new InMemoryDeviceIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository,
    secrets,
  });

  const first = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const second = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });

  assert.deepEqual(second, first);
  assert.match(first.keyId, /^ca_[A-Za-z0-9_-]{22}$/);
  assert.match(first.spkiSha256, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(first.instanceId, "instance-personal");
  assert.equal(first.status, "active");
  assert.equal(first.createdAt, now);
  assert.equal(first.notBefore, now - 60_000);
  assert.equal(first.notAfter, Date.UTC(2036, 6, 21, 0, 0, 0));

  const certificate = new X509Certificate(first.certificatePem);
  assert.equal(certificate.subject, "CN=OpenDelegate instance instance-personal");
  assert.equal(certificate.issuer, certificate.subject);
  assert.equal(
    await certificate.verify({ publicKey: certificate.publicKey, date: new Date(now) }),
    true,
  );

  const snapshot = await repository.snapshot();
  assert.deepEqual(snapshot.certificateAuthority, first);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("pkcs8"), false);
  assert.equal(await secrets.has(first.keyId), true);
  assert.equal((await secrets.getPrivateKey(first.keyId))?.extractable, false);
});

test("certificate issuance rejects an invalid all-zero random serial before persisting authority", async () => {
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock: new MutableClock(Date.UTC(2026, 6, 24, 0, 0, 0)),
    random: new AllZeroRandomSource(),
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });

  await assert.rejects(
    () => authority.bootstrapCertificateAuthority({ instanceId: "instance-personal" }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "IDENTITY_CONFIGURATION_INVALID");
      return true;
    },
  );
  assert.equal((await repository.snapshot()).certificateAuthority, null);
});

test("a Worker creates a Device-bound P-256 CSR locally and verifies the explicit Main pin", async () => {
  const clock = new MutableClock(Date.UTC(2026, 6, 24, 0, 0, 0));
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: mainSecrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const workerSecrets = new InMemoryDeviceIdentitySecretStore();
  const worker = new WorkerDeviceIdentity({
    clock,
    secrets: workerSecrets,
  });

  const enrollmentRequest = await worker.createEnrollmentRequest({
    deviceId: "device-windows-builder",
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });

  assert.match(enrollmentRequest.keyId, /^device-key_[A-Za-z0-9_-]{22}$/);
  assert.equal(enrollmentRequest.deviceId, "device-windows-builder");
  assert.equal(enrollmentRequest.expectedMainSpkiSha256, certificateAuthority.spkiSha256);
  assert.equal(await workerSecrets.has(enrollmentRequest.keyId), true);
  assert.equal((await workerSecrets.getPrivateKey(enrollmentRequest.keyId))?.extractable, false);
  assert.equal(JSON.stringify(enrollmentRequest).includes("private"), false);

  const csr = new Pkcs10CertificateRequest(enrollmentRequest.certificateRequestPem);
  assert.equal(csr.subject, "CN=device-windows-builder");
  assert.equal(await csr.verify(), true);
  const subjectAlternativeName = csr.getExtension(
    "2.5.29.17",
  ) as SubjectAlternativeNameExtension | null;
  assert.deepEqual(
    subjectAlternativeName?.names.items.map((name) => name.toJSON()),
    [{ type: "url", value: "urn:opendelegate:device:device-windows-builder" }],
  );
  assert.deepEqual(
    await worker.verifyMainIdentity({
      certificatePem: certificateAuthority.certificatePem,
      expectedSpkiSha256: certificateAuthority.spkiSha256,
    }),
    {
      spkiSha256: certificateAuthority.spkiSha256,
      verified: true,
    },
  );

  await assert.rejects(
    () =>
      worker.verifyMainIdentity({
        certificatePem: certificateAuthority.certificatePem,
        expectedSpkiSha256: `sha256:${"A".repeat(43)}`,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "MAIN_IDENTITY_PIN_MISMATCH");
      return true;
    },
  );
});

test("a single-use enrollment grant issues one Device-bound client certificate and persists no raw secret", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new CounterRandomSource(),
    repository,
    secrets: mainSecrets,
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
    allowedBootstrapRoles: ["coding", "artifact-rendering"],
    deviceId: "device-linux-nas",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const rawToken = grant.secret.reveal();
  const enrollmentRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
  });
  await worker.verifyMainIdentity({
    certificatePem: certificateAuthority.certificatePem,
    expectedSpkiSha256: grant.expectedMainSpkiSha256,
  });

  const identity = await authority.enrollDevice({
    certificateRequestPem: enrollmentRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "x64",
      hostname: "nas-private",
      osFamily: "linux",
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: rawToken,
  });
  const verifiedIdentity = await worker.verifyIssuedDeviceIdentity({
    certificateAuthorityPem: identity.certificateAuthorityPem,
    certificatePem: identity.certificatePem,
    certificateRequestPem: enrollmentRequest.certificateRequestPem,
    deviceId: identity.deviceId,
    expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
    generation: identity.generation,
    keyId: enrollmentRequest.keyId,
  });

  assert.equal(identity.deviceId, "device-linux-nas");
  assert.equal(identity.generation, 1);
  assert.equal(identity.status, "active");
  assert.equal(identity.notBefore, now - 60_000);
  assert.equal(identity.notAfter, now + 24 * 60 * 60_000);
  assert.match(identity.serialNumber, /^[0-9a-f]{32}$/);
  assert.match(identity.publicKeySpkiSha256, /^sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(identity.certificateAuthorityPem, certificateAuthority.certificatePem);
  assert.deepEqual(verifiedIdentity, {
    deviceId: "device-linux-nas",
    generation: 1,
    keyId: enrollmentRequest.keyId,
    certificatePem: identity.certificatePem,
    certificateAuthorityPem: identity.certificateAuthorityPem,
    serialNumber: identity.serialNumber,
    notBefore: identity.notBefore,
    notAfter: identity.notAfter,
  });

  const certificate = new X509Certificate(identity.certificatePem);
  const issuer = new X509Certificate(identity.certificateAuthorityPem);
  assert.equal(
    await certificate.verify({ publicKey: issuer.publicKey, date: new Date(now) }),
    true,
  );
  assert.equal(certificate.subject, "CN=device-linux-nas");
  assert.equal(certificate.issuer, issuer.subject);
  assert.equal(certificate.getExtension(BasicConstraintsExtension)?.ca, false);
  assert.equal(
    certificate.getExtension(KeyUsagesExtension)?.usages,
    KeyUsageFlags.digitalSignature,
  );
  assert.deepEqual(
    [...(certificate.getExtension(ExtendedKeyUsageExtension)?.usages ?? [])],
    [ExtendedKeyUsage.clientAuth],
  );
  assert.deepEqual(
    certificate
      .getExtension(SubjectAlternativeNameExtension)
      ?.names.items.map((name) => name.toJSON()),
    [{ type: "url", value: "urn:opendelegate:device:device-linux-nas" }],
  );

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.enrollmentGrants.length, 1);
  assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
  assert.match(snapshot.enrollmentGrants[0]?.tokenDigest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(snapshot.devices[0]?.deviceId, "device-linux-nas");
  assert.equal(snapshot.certificates[0]?.serialNumber, identity.serialNumber);
  assert.deepEqual(
    snapshot.auditRecords.map((record) => record.event),
    ["device.enrollment-grant-issued", "device.enrolled"],
  );

  const serialized = JSON.stringify({
    grant,
    identity,
    snapshot,
  });
  assert.equal(serialized.includes(rawToken), false);
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes("pkcs8"), false);
  assert.equal(inspect(grant).includes(rawToken), false);
  assert.equal(String(grant.secret), "[REDACTED]");
});

test("concurrent and post-restart Enrollment Grant replay creates exactly one identity", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const random = new CounterRandomSource();
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    random,
    repository,
    secrets: mainSecrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: "device-macos-studio",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandomSource(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const request = {
    certificateRequestPem: certificateRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "arm64",
      hostname: "studio-private",
      osFamily: "macos" as const,
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  };

  const concurrent = await Promise.allSettled([
    authority.enrollDevice(request),
    authority.enrollDevice(request),
  ]);

  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const concurrentRejection = concurrent.find((result) => result.status === "rejected");
  assert.equal(concurrentRejection?.status, "rejected");
  if (concurrentRejection?.status === "rejected") {
    assert.ok(concurrentRejection.reason instanceof DeviceIdentityError);
    assert.equal(
      (concurrentRejection.reason as DeviceIdentityError).code,
      "ENROLLMENT_GRANT_INVALID",
    );
  }

  const restartedRepository = new InMemoryDeviceIdentityRepository(await repository.snapshot());
  const restartedAuthority = new DeviceIdentityAuthority({
    clock,
    random,
    repository: restartedRepository,
    secrets: mainSecrets,
  });
  await assert.rejects(
    () => restartedAuthority.enrollDevice(request),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "ENROLLMENT_GRANT_INVALID");
      return true;
    },
  );

  const snapshot = await restartedRepository.snapshot();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.certificates.length, 1);
  assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
  assert.equal(
    snapshot.auditRecords.filter((record) => record.event === "device.enrollment-rejected").length,
    2,
  );
});

test("an Enrollment Grant expires at its exact deadline without creating a Device", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
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
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: [],
    deviceId: "device-expired-grant",
    expiresInMs: 30_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandomSource(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  clock.set(grant.expiresAt);

  await assert.rejects(
    () =>
      authority.enrollDevice({
        certificateRequestPem: certificateRequest.certificateRequestPem,
        deviceId: grant.deviceId,
        discovery: {
          architecture: "x64",
          hostname: "expired-private",
          osFamily: "linux",
        },
        grantId: grant.grantId,
        protocolVersion: 1,
        token: grant.secret.reveal(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "ENROLLMENT_GRANT_INVALID");
      return true;
    },
  );

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.enrollmentGrants[0]?.status, "expired");
  assert.equal(snapshot.devices.length, 0);
  assert.equal(snapshot.certificates.length, 0);
  assert.equal(snapshot.auditRecords.at(-1)?.rejectionCode, "expired");
});

test("malformed or differently scoped certificate requests fail without consuming the grant", async () => {
  const clock = new MutableClock(Date.UTC(2026, 6, 24, 0, 0, 0));
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: [],
    deviceId: "device-csr-target",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const wrongScope = await worker.createEnrollmentRequest({
    deviceId: "device-csr-imposter",
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const baseRequest = {
    deviceId: grant.deviceId,
    discovery: {
      architecture: "x64",
      hostname: "csr-private",
      osFamily: "windows" as const,
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  };

  for (const certificateRequestPem of [
    "not a certificate request",
    wrongScope.certificateRequestPem,
  ]) {
    await assert.rejects(
      () =>
        authority.enrollDevice({
          ...baseRequest,
          certificateRequestPem,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DeviceIdentityError);
        assert.equal(error.code, "CERTIFICATE_REQUEST_INVALID");
        return true;
      },
    );
  }

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.enrollmentGrants[0]?.status, "active");
  assert.equal(snapshot.devices.length, 0);
  assert.equal(snapshot.certificates.length, 0);

  await assert.rejects(
    () =>
      worker.verifyMainIdentity({
        certificatePem: "not a certificate",
        expectedSpkiSha256: certificateAuthority.spkiSha256,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "MAIN_IDENTITY_INVALID");
      return true;
    },
  );
});

test("mTLS peer validation binds the trusted certificate, durable serial, and envelope Device ID", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new LeadingZeroRandomSource(),
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: "device-peer",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const identity = await authority.enrollDevice({
    certificateRequestPem: certificateRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "x64",
      hostname: "peer-private",
      osFamily: "linux",
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });
  assert.match(identity.serialNumber, /^00[0-9a-f]{30}$/u);

  assert.deepEqual(
    await authority.validatePeerIdentity({
      certificatePem: identity.certificatePem,
      claimedDeviceId: "device-peer",
    }),
    {
      certificateGeneration: 1,
      deviceId: "device-peer",
      publicKeySpkiSha256: identity.publicKeySpkiSha256,
      serialNumber: identity.serialNumber,
    },
  );

  await assert.rejects(
    () =>
      authority.validatePeerIdentity({
        certificatePem: identity.certificatePem,
        claimedDeviceId: "device-other",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "PEER_IDENTITY_MISMATCH");
      return true;
    },
  );

  clock.set(identity.notAfter);
  await assert.rejects(
    () =>
      authority.validatePeerIdentity({
        certificatePem: identity.certificatePem,
        claimedDeviceId: "device-peer",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "PEER_CERTIFICATE_EXPIRED");
      return true;
    },
  );
});

test("certificate rotation requires new-key proof and gives the old generation one bounded overlap", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    random: new LeadingZeroRandomSource(),
    repository,
    secrets: mainSecrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const workerSecrets = new InMemoryDeviceIdentitySecretStore();
  const worker = new WorkerDeviceIdentity({
    clock,
    random: new CounterRandomSource(),
    secrets: workerSecrets,
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: [],
    deviceId: "device-rotation",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const originalRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const original = await authority.enrollDevice({
    certificateRequestPem: originalRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "arm64",
      hostname: "rotation-private",
      osFamily: "macos",
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });
  const nextRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });

  const pending = await authority.issueCertificateRotation({
    currentCertificatePem: original.certificatePem,
    deviceId: grant.deviceId,
    newCertificateRequestPem: nextRequest.certificateRequestPem,
  });

  assert.equal(pending.generation, 2);
  assert.equal(pending.status, "pending");
  assert.match(pending.activationChallenge, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(
    () =>
      authority.validatePeerIdentity({
        certificatePem: pending.certificatePem,
        claimedDeviceId: grant.deviceId,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "PEER_CERTIFICATE_STALE");
      return true;
    },
  );

  const signature = await worker.createRotationProof({
    activationChallenge: pending.activationChallenge,
    certificateSerial: pending.serialNumber,
    deviceId: grant.deviceId,
    keyId: nextRequest.keyId,
  });
  const wrongKeySignature = await worker.createRotationProof({
    activationChallenge: pending.activationChallenge,
    certificateSerial: pending.serialNumber,
    deviceId: grant.deviceId,
    keyId: originalRequest.keyId,
  });
  await assert.rejects(
    () =>
      authority.confirmCertificateRotation({
        activationChallenge: pending.activationChallenge,
        certificatePem: pending.certificatePem,
        deviceId: grant.deviceId,
        signature: wrongKeySignature,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "ROTATION_INVALID");
      return true;
    },
  );
  const confirmed = await authority.confirmCertificateRotation({
    activationChallenge: pending.activationChallenge,
    certificatePem: pending.certificatePem,
    deviceId: grant.deviceId,
    signature,
  });

  assert.equal(confirmed.generation, 2);
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.overlapEndsAt, now + 5 * 60_000);
  assert.equal(
    (
      await authority.validatePeerIdentity({
        certificatePem: original.certificatePem,
        claimedDeviceId: grant.deviceId,
      })
    ).certificateGeneration,
    1,
  );
  assert.equal(
    (
      await authority.validatePeerIdentity({
        certificatePem: pending.certificatePem,
        claimedDeviceId: grant.deviceId,
      })
    ).certificateGeneration,
    2,
  );

  clock.set(confirmed.overlapEndsAt);
  await assert.rejects(
    () =>
      authority.validatePeerIdentity({
        certificatePem: original.certificatePem,
        claimedDeviceId: grant.deviceId,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "PEER_CERTIFICATE_STALE");
      return true;
    },
  );
  assert.equal(
    (
      await authority.validatePeerIdentity({
        certificatePem: pending.certificatePem,
        claimedDeviceId: grant.deviceId,
      })
    ).certificateGeneration,
    2,
  );

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.devices[0]?.identityGeneration, 2);
  assert.deepEqual(
    [...snapshot.certificates]
      .sort((left, right) => left.generation - right.generation)
      .map((certificate) => ({
        generation: certificate.generation,
        status: certificate.status,
      })),
    [
      { generation: 1, status: "overlap" },
      { generation: 2, status: "active" },
    ],
  );
});

test("certificate rotation selects the active credential after an expired rotation and recredential", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-recredential-rotation",
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const discovery = {
    architecture: "x64",
    hostname: "recredential-rotation",
    osFamily: "windows" as const,
  };

  const enrollmentGrant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["worker"],
    deviceId: "device-recredential-rotation",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const enrollmentRequest = await worker.createEnrollmentRequest({
    deviceId: enrollmentGrant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const original = await authority.enrollDevice({
    certificateRequestPem: enrollmentRequest.certificateRequestPem,
    deviceId: enrollmentGrant.deviceId,
    discovery,
    grantId: enrollmentGrant.grantId,
    protocolVersion: 1,
    token: enrollmentGrant.secret.reveal(),
  });

  const abandonedRequest = await worker.createEnrollmentRequest({
    deviceId: enrollmentGrant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const abandoned = await authority.issueCertificateRotation({
    currentCertificatePem: original.certificatePem,
    deviceId: enrollmentGrant.deviceId,
    newCertificateRequestPem: abandonedRequest.certificateRequestPem,
  });
  clock.set(abandoned.activationExpiresAt);

  const recredentialGrant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["worker"],
    deviceId: enrollmentGrant.deviceId,
    expiresInMs: 5 * 60_000,
    intent: "recredential",
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const recredentialRequest = await worker.createEnrollmentRequest({
    deviceId: enrollmentGrant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const recredentialed = await authority.enrollDevice({
    certificateRequestPem: recredentialRequest.certificateRequestPem,
    deviceId: enrollmentGrant.deviceId,
    discovery,
    grantId: recredentialGrant.grantId,
    protocolVersion: 1,
    token: recredentialGrant.secret.reveal(),
  });
  assert.equal(recredentialed.generation, 2);

  const nextRequest = await worker.createEnrollmentRequest({
    deviceId: enrollmentGrant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const pending = await authority.issueCertificateRotation({
    currentCertificatePem: recredentialed.certificatePem,
    deviceId: enrollmentGrant.deviceId,
    newCertificateRequestPem: nextRequest.certificateRequestPem,
  });
  const confirmed = await authority.confirmCertificateRotation({
    activationChallenge: pending.activationChallenge,
    certificatePem: pending.certificatePem,
    deviceId: enrollmentGrant.deviceId,
    signature: await worker.createRotationProof({
      activationChallenge: pending.activationChallenge,
      certificateSerial: pending.serialNumber,
      deviceId: enrollmentGrant.deviceId,
      keyId: nextRequest.keyId,
    }),
  });

  assert.equal(confirmed.generation, 3);
  assert.equal(confirmed.status, "active");
  const generationTwo = (await repository.snapshot()).certificates.filter(
    (certificate) => certificate.generation === 2,
  );
  assert.deepEqual(generationTwo.map((certificate) => certificate.status).sort(), [
    "overlap",
    "revoked",
  ]);
});

test("Device revocation atomically rejects every certificate generation and is idempotent", async () => {
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = new MutableClock(now);
  const repository = new InMemoryDeviceIdentityRepository();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const grant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: [],
    deviceId: "device-revoked",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const worker = new WorkerDeviceIdentity({
    clock,
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateRequest = await worker.createEnrollmentRequest({
    deviceId: grant.deviceId,
    expectedMainSpkiSha256: certificateAuthority.spkiSha256,
  });
  const identity = await authority.enrollDevice({
    certificateRequestPem: certificateRequest.certificateRequestPem,
    deviceId: grant.deviceId,
    discovery: {
      architecture: "x64",
      hostname: "revoked-private",
      osFamily: "windows",
    },
    grantId: grant.grantId,
    protocolVersion: 1,
    token: grant.secret.reveal(),
  });

  const first = await authority.revokeDevice({
    deviceId: grant.deviceId,
  });
  clock.set(now + 60_000);
  const replay = await authority.revokeDevice({
    deviceId: grant.deviceId,
  });

  assert.deepEqual(replay, first);
  assert.deepEqual(first, {
    certificateSerials: [identity.serialNumber],
    deviceId: grant.deviceId,
    revokedAt: now,
    status: "revoked",
  });
  await assert.rejects(
    () =>
      authority.validatePeerIdentity({
        certificatePem: identity.certificatePem,
        claimedDeviceId: grant.deviceId,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceIdentityError);
      assert.equal(error.code, "PEER_CERTIFICATE_REVOKED");
      return true;
    },
  );

  const snapshot = await repository.snapshot();
  assert.equal(snapshot.devices[0]?.status, "revoked");
  assert.equal(snapshot.certificates[0]?.status, "revoked");
  assert.equal(
    snapshot.auditRecords.filter((record) => record.event === "device.revoked").length,
    1,
  );
});
