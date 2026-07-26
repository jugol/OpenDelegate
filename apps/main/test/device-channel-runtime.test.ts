import "reflect-metadata";

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import type { CreateMainDeviceChannelServerOptions } from "@opendelegate/device-channel";
import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentitySecretStore,
} from "@opendelegate/device-identity";
import { SqlDeviceChannelRepository, SqlDeviceIdentityRepository } from "@opendelegate/storage-sql";

import {
  MainDeviceChannelRuntimeError,
  createProductionMainDeviceChannelRuntime,
  openMainDeviceChannelRepository,
  type MainDeviceChannelListenerFactory,
} from "../src/device-channel-runtime.ts";

test("production Device channel composition owns separate enrollment and mTLS listeners on shared SQLite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-main-device-channel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "main.sqlite3");
  const clock = { now: () => Date.now() };
  const secrets = new InMemoryDeviceIdentitySecretStore();
  const migrations = await SqlDeviceChannelRepository.openSqlite({
    filename,
    migrationMode: "apply",
  });
  await migrations.close();
  const identityRepository = await SqlDeviceIdentityRepository.openSqlite({
    filename,
    migrationMode: "verify",
  });
  const authority = new DeviceIdentityAuthority({
    clock,
    repository: identityRepository,
    secrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-device-channel-test",
  });
  const serverIdentity = await issueServerIdentity(
    certificateAuthority.certificatePem,
    await secrets.getPrivateKey(certificateAuthority.keyId),
  );
  await identityRepository.close();
  const certificatePath = join(directory, "server-certificate.pem");
  const privateKeyPath = join(directory, "server-private-key.pem");
  await Promise.all([
    writeFile(certificatePath, serverIdentity.certificatePem, { mode: 0o600 }),
    writeFile(privateKeyPath, serverIdentity.privateKeyPem, { mode: 0o600 }),
  ]);

  const calls: string[] = [];
  let enrollmentClosed = false;
  let channelClosed = false;
  const onRouteIncident = async (): Promise<void> => undefined;
  const listenerFactory: MainDeviceChannelListenerFactory = {
    async listenEnrollment(input) {
      calls.push("enrollment");
      assert.equal(input.host, "127.0.0.1");
      assert.equal(input.port, 45_443);
      assert.match(input.certificate.toString("utf8"), /BEGIN CERTIFICATE/u);
      assert.match(input.privateKey.toString("utf8"), /BEGIN PRIVATE KEY/u);
      assert.equal(typeof input.requestListener, "function");
      return {
        address: () => ({
          host: "127.0.0.1",
          port: 45_443,
          url: "https://127.0.0.1:45443/api/v1/device/enroll",
        }),
        close: async () => {
          enrollmentClosed = true;
        },
      };
    },
    async listenWorkerChannel(input: CreateMainDeviceChannelServerOptions) {
      calls.push("worker-channel");
      assert.equal(input.host, "127.0.0.1");
      assert.equal(input.port, 45_444);
      assert.equal(input.path, "/api/v1/device/channel");
      assert.equal(input.mainDeviceId, "device-main-1");
      assert.equal(input.authority instanceof DeviceIdentityAuthority, true);
      assert.equal(input.repository.constructor.name, "SqlDeviceChannelRepository");
      assert.match(input.tls.certificateAuthorityPem, /BEGIN CERTIFICATE/u);
      assert.match(String(input.tls.certificate), /BEGIN CERTIFICATE/u);
      assert.match(String(input.tls.privateKey), /BEGIN PRIVATE KEY/u);
      assert.equal(input.onRouteIncident, onRouteIncident);
      return {
        address: () => ({
          host: "127.0.0.1",
          port: 45_444,
          url: "wss://127.0.0.1:45444/api/v1/device/channel",
        }),
        close: async () => {
          channelClosed = true;
        },
        dispatch: async () => {
          throw new Error("Dispatch is not exercised by this listener composition test.");
        },
        control: async () => {
          throw new Error("Control is not exercised by this listener composition test.");
        },
        steerRun: async () => {
          throw new Error("Steering is not exercised by this listener composition test.");
        },
      };
    },
  };

  const runtime = await createProductionMainDeviceChannelRuntime({
    clock,
    configuration: {
      enrollment: {
        advertisedUrl: "https://127.0.0.1:45443/api/v1/device/enroll",
        host: "127.0.0.1",
        port: 45_443,
        tlsCertificatePath: certificatePath,
        tlsPrivateKeyPath: privateKeyPath,
      },
      workerChannel: {
        advertisedUrl: "wss://127.0.0.1:45444/api/v1/device/channel",
        host: "127.0.0.1",
        port: 45_444,
        tlsCertificatePath: certificatePath,
        tlsPrivateKeyPath: privateKeyPath,
      },
    },
    database: { adapter: "sqlite", filename },
    identitySecrets: secrets,
    instanceId: "instance-device-channel-test",
    listenerFactory,
    mainDeviceId: "device-main-1",
    onRouteIncident,
    sourceCheckout: resolve("."),
  });
  assert.deepEqual(calls, ["enrollment", "worker-channel"]);
  assert.equal(runtime.enrollmentAddress.port, 45_443);
  assert.equal(runtime.workerChannel.address().port, 45_444);
  assert.equal(runtime.authority instanceof DeviceIdentityAuthority, true);
  assert.match(runtime.certificateAuthorityPem, /BEGIN CERTIFICATE/u);
  assert.deepEqual(await runtime.listDeviceIdentities(), []);

  await runtime.close();
  await runtime.close();
  assert.equal(channelClosed, true);
  assert.equal(enrollmentClosed, true);

  const reopened = await openMainDeviceChannelRepository({
    adapter: "sqlite",
    filename,
  });
  await assert.rejects(
    reopened.resume("device-never-connected"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CHANNEL_NOT_REGISTERED",
  );
  await reopened.close();
});

test("Device channel configuration fails closed when the listeners are not separate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-main-device-channel-invalid-"));
  try {
    await assert.rejects(
      createProductionMainDeviceChannelRuntime({
        clock: { now: () => Date.now() },
        configuration: {
          enrollment: {
            advertisedUrl: "https://127.0.0.1:45443/api/v1/device/enroll",
            host: "127.0.0.1",
            port: 45_443,
            tlsCertificatePath: join(directory, "certificate.pem"),
            tlsPrivateKeyPath: join(directory, "private-key.pem"),
          },
          workerChannel: {
            advertisedUrl: "wss://127.0.0.1:45443/api/v1/device/channel",
            host: "127.0.0.1",
            port: 45_443,
            tlsCertificatePath: join(directory, "certificate.pem"),
            tlsPrivateKeyPath: join(directory, "private-key.pem"),
          },
        },
        database: { adapter: "sqlite", filename: join(directory, "main.sqlite3") },
        identitySecrets: new InMemoryDeviceIdentitySecretStore(),
        instanceId: "instance-invalid",
        mainDeviceId: "device-main-1",
        sourceCheckout: resolve("."),
      }),
      (error: unknown) =>
        error instanceof MainDeviceChannelRuntimeError &&
        error.code === "DEVICE_CHANNEL_CONFIGURATION_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function issueServerIdentity(
  certificateAuthorityPem: string,
  certificateAuthorityPrivateKey: CryptoKey | null,
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  assert.notEqual(certificateAuthorityPrivateKey, null);
  const now = Date.now();
  const certificateAuthority = new X509Certificate(certificateAuthorityPem);
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.create({
    serialNumber: "11223344556677889900aabbccddeeff",
    subject: "CN=127.0.0.1",
    issuer: certificateAuthority.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 60 * 60_000),
    publicKey: keys.publicKey,
    signingKey: certificateAuthorityPrivateKey ?? keys.privateKey,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }], false),
      await SubjectKeyIdentifierExtension.create(keys.publicKey),
      await AuthorityKeyIdentifierExtension.create(certificateAuthority.publicKey),
    ],
  });
  const pkcs8 = Buffer.from(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  try {
    return {
      certificatePem: certificate.toString("pem"),
      privateKeyPem: [
        "-----BEGIN PRIVATE KEY-----",
        pkcs8
          .toString("base64")
          .match(/.{1,64}/gu)
          ?.join("\n") ?? "",
        "-----END PRIVATE KEY-----",
        "",
      ].join("\n"),
    };
  } finally {
    pkcs8.fill(0);
  }
}
