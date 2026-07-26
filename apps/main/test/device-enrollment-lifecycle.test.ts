import "reflect-metadata";

import assert from "node:assert/strict";
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseEnrollmentGrantFile } from "@opendelegate/device-channel";
import { InMemoryDeviceIdentitySecretStore } from "@opendelegate/device-identity";
import { SqlDeviceIdentityRepository } from "@opendelegate/storage-sql";

import {
  issueDeviceEnrollmentGrantFile,
  provisionMainDeviceListenerTls,
} from "../src/device-enrollment-lifecycle.ts";

test("Main provisions and idempotently retains CA-chained TLS outside the checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-listener-tls-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime)]);
  const filename = join(runtime, "main.sqlite3");
  const configuration = listenerConfiguration(runtime);
  const secrets = new InMemoryDeviceIdentitySecretStore();
  const first = await provisionMainDeviceListenerTls({
    configuration,
    database: { adapter: "sqlite", filename },
    identitySecrets: secrets,
    instanceId: "instance-listener-tls",
    sourceCheckout: checkout,
  });

  assert.equal(first.status, "provisioned");
  const certificateBytes = await readFile(configuration.enrollment.tlsCertificatePath);
  const privateKeyBytes = await readFile(configuration.enrollment.tlsPrivateKeyPath);
  const certificate = new X509Certificate(certificateBytes);
  const certificateAuthority = new X509Certificate(first.certificateAuthorityPem);
  assert.equal(certificate.verify(certificateAuthority.publicKey), true);
  assert.equal(certificate.checkHost("main.example.test"), "main.example.test");
  assert.deepEqual(
    createPublicKey(createPrivateKey(privateKeyBytes)).export({ format: "der", type: "spki" }),
    certificate.publicKey.export({ format: "der", type: "spki" }),
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(configuration.enrollment.tlsPrivateKeyPath)).mode & 0o077, 0);
  }

  const second = await provisionMainDeviceListenerTls({
    configuration,
    database: { adapter: "sqlite", filename },
    identitySecrets: secrets,
    instanceId: "instance-listener-tls",
    sourceCheckout: checkout,
  });
  assert.equal(second.status, "current");
  assert.deepEqual(await readFile(configuration.enrollment.tlsCertificatePath), certificateBytes);
});

test("owner grant issuance writes one exclusive redacted result and a valid 0600 grant file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-device-grant-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const checkout = join(root, "checkout");
  const runtime = join(root, "runtime");
  await Promise.all([mkdir(checkout), mkdir(runtime)]);
  const filename = join(runtime, "main.sqlite3");
  const configuration = listenerConfiguration(runtime);
  const secrets = new InMemoryDeviceIdentitySecretStore();
  await provisionMainDeviceListenerTls({
    configuration,
    database: { adapter: "sqlite", filename },
    identitySecrets: secrets,
    instanceId: "instance-grant",
    sourceCheckout: checkout,
  });
  const output = join(runtime, "worker-nas.enrollment.json");

  const result = await issueDeviceEnrollmentGrantFile({
    configuration,
    database: { adapter: "sqlite", filename },
    identitySecrets: secrets,
    instanceId: "instance-grant",
    mainDeviceId: "device-main",
    deviceId: "device-worker-nas",
    allowedBootstrapRoles: ["worker", "storage"],
    expiresInMs: 5 * 60_000,
    outputPath: output,
    sourceCheckout: checkout,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    "deviceId",
    "expiresAt",
    "grantFile",
    "grantId",
    "status",
  ]);
  assert.doesNotMatch(JSON.stringify(result), /token|BEGIN CERTIFICATE/u);
  const bytes = await readFile(output);
  const grant = parseEnrollmentGrantFile(bytes, Date.now());
  assert.equal(grant.deviceId, "device-worker-nas");
  assert.equal(grant.mainDeviceId, "device-main");
  assert.equal(grant.enrollmentUrl, configuration.enrollment.advertisedUrl);
  assert.deepEqual(grant.channelEndpoints, [
    {
      endpointId: "main-worker-channel",
      label: "Main Worker channel",
      kind: "wss",
      url: configuration.workerChannel.advertisedUrl,
    },
  ]);
  assert.match(grant.expectedMainSpkiSha256, /^sha256:/u);
  assert.match(grant.certificateAuthorityPem, /BEGIN CERTIFICATE/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(output)).mode & 0o077, 0);
  }

  await assert.rejects(
    issueDeviceEnrollmentGrantFile({
      configuration,
      database: { adapter: "sqlite", filename },
      identitySecrets: secrets,
      instanceId: "instance-grant",
      mainDeviceId: "device-main",
      deviceId: "device-another-worker",
      allowedBootstrapRoles: ["worker"],
      expiresInMs: 30_000,
      outputPath: output,
      sourceCheckout: checkout,
    }),
    /already exists/u,
  );
  assert.deepEqual(await readFile(output), bytes);

  const repository = await SqlDeviceIdentityRepository.openSqlite({
    filename,
    migrationMode: "verify",
  });
  const snapshot = await repository.snapshot();
  await repository.close();
  assert.equal(snapshot.enrollmentGrants.length, 1);
  assert.equal(snapshot.enrollmentGrants[0]?.tokenDigest.length, 64);
  assert.equal(JSON.stringify(snapshot).includes(grant.token), false);
});

function listenerConfiguration(runtime: string) {
  return {
    enrollment: {
      advertisedUrl: "https://main.example.test:45443/api/v1/device/enroll",
      host: "127.0.0.1",
      port: 45_443,
      tlsCertificatePath: resolve(runtime, "tls", "main-certificate.pem"),
      tlsPrivateKeyPath: resolve(runtime, "tls", "main-private-key.pem"),
    },
    workerChannel: {
      advertisedUrl: "wss://main.example.test:45444/api/v1/device/channel",
      host: "127.0.0.1",
      port: 45_444,
      path: "/api/v1/device/channel",
      tlsCertificatePath: resolve(runtime, "tls", "main-certificate.pem"),
      tlsPrivateKeyPath: resolve(runtime, "tls", "main-private-key.pem"),
    },
  } as const;
}
