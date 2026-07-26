import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
} from "@opendelegate/device-identity";

import { SqlDeviceIdentityRepository } from "../src/index.ts";

test("the real Device identity authority completes enrollment, rotation, and revocation on SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-sql-identity-authority-"));
  const filename = join(directory, "main.sqlite3");
  const now = Date.UTC(2026, 6, 24, 0, 0, 0);
  const clock = { now: () => now };
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const workerSecrets = new InMemoryDeviceIdentitySecretStore();
  let repository;

  try {
    repository = await SqlDeviceIdentityRepository.openSqlite({
      filename,
      migrationMode: "apply",
    });
    const authority = new DeviceIdentityAuthority({
      clock,
      repository,
      secrets: mainSecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({
      instanceId: "instance-sql-integration",
    });
    const grant = await authority.createEnrollmentGrant({
      allowedBootstrapRoles: ["worker"],
      deviceId: "device-sql-integration",
      expiresInMs: 5 * 60_000,
      protocolRange: { maximum: 1, minimum: 1 },
    });
    const worker = new WorkerDeviceIdentity({
      clock,
      secrets: workerSecrets,
    });
    const originalRequest = await worker.createEnrollmentRequest({
      deviceId: grant.deviceId,
      expectedMainSpkiSha256: certificateAuthority.spkiSha256,
    });
    const original = await authority.enrollDevice({
      certificateRequestPem: originalRequest.certificateRequestPem,
      deviceId: grant.deviceId,
      discovery: {
        architecture: "x64",
        hostname: "sql-integration-private",
        osFamily: "linux",
      },
      grantId: grant.grantId,
      protocolVersion: 1,
      token: grant.secret.reveal(),
    });

    await repository.close();
    repository = await SqlDeviceIdentityRepository.openSqlite({
      filename,
      migrationMode: "verify",
    });
    const restartedAuthority = new DeviceIdentityAuthority({
      clock,
      repository,
      secrets: mainSecrets,
    });
    const nextRequest = await worker.createEnrollmentRequest({
      deviceId: grant.deviceId,
      expectedMainSpkiSha256: certificateAuthority.spkiSha256,
    });
    const pending = await restartedAuthority.issueCertificateRotation({
      currentCertificatePem: original.certificatePem,
      deviceId: grant.deviceId,
      newCertificateRequestPem: nextRequest.certificateRequestPem,
    });
    const signature = await worker.createRotationProof({
      activationChallenge: pending.activationChallenge,
      certificateSerial: pending.serialNumber,
      deviceId: grant.deviceId,
      keyId: nextRequest.keyId,
    });
    await restartedAuthority.confirmCertificateRotation({
      activationChallenge: pending.activationChallenge,
      certificatePem: pending.certificatePem,
      deviceId: grant.deviceId,
      signature,
    });
    await restartedAuthority.revokeDevice({ deviceId: grant.deviceId });

    const snapshot = await repository.snapshot();
    assert.equal(snapshot.devices[0]?.identityGeneration, 2);
    assert.equal(snapshot.devices[0]?.status, "revoked");
    assert.equal(snapshot.certificates.length, 2);
    assert.equal(
      snapshot.certificates.every((certificate) => certificate.status === "revoked"),
      true,
    );
    assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
    assert.equal(JSON.stringify(snapshot).includes(grant.secret.reveal()), false);
  } finally {
    await repository?.close();
    await rm(directory, { force: true, recursive: true });
  }
});
