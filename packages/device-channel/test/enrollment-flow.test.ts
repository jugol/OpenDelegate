import "reflect-metadata";

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:https";
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
import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  WorkerDeviceIdentity,
  type IdentityClock,
} from "@opendelegate/device-identity";

import {
  EnrollmentClientError,
  createEnrollmentRequestHandler,
  enrollWorkerDevice,
  type EnrollmentGrantFileDocument,
} from "../src/index.ts";

test("pinned TLS 1.3 enrollment consumes one grant and binds the issued identity to the local key", async () => {
  const now = Date.now();
  const clock: IdentityClock = { now: () => now };
  const repository = new InMemoryDeviceIdentityRepository();
  const mainSecrets = new InMemoryDeviceIdentitySecretStore();
  const authority = new DeviceIdentityAuthority({
    clock,
    repository,
    secrets: mainSecrets,
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const issuedGrant = await authority.createEnrollmentGrant({
    allowedBootstrapRoles: ["coding"],
    deviceId: "device-worker-1",
    expiresInMs: 5 * 60_000,
    protocolRange: { minimum: 1, maximum: 1 },
  });
  const serverIdentity = await issueServerIdentity(
    certificateAuthority.certificatePem,
    await mainSecrets.getPrivateKey(certificateAuthority.keyId),
    now,
  );
  const server = createServer(
    {
      ca: certificateAuthority.certificatePem,
      cert: serverIdentity.certificatePem,
      key: serverIdentity.privateKeyPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    },
    createEnrollmentRequestHandler({ authority }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const rawToken = issuedGrant.secret.reveal();
    const grant: EnrollmentGrantFileDocument = {
      schemaVersion: 1,
      grantId: issuedGrant.grantId,
      token: rawToken,
      deviceId: issuedGrant.deviceId,
      mainDeviceId: "device-main-1",
      expectedMainSpkiSha256: issuedGrant.expectedMainSpkiSha256,
      certificateAuthorityPem: certificateAuthority.certificatePem,
      enrollmentUrl: `https://127.0.0.1:${port}/api/v1/device/enroll`,
      channelEndpoints: [
        {
          endpointId: "private-route",
          label: "Private route",
          kind: "wss",
          url: `wss://127.0.0.1:${port}/api/v1/device/channel`,
        },
      ],
      protocolRange: issuedGrant.protocolRange,
      expiresAt: issuedGrant.expiresAt,
    };
    const worker = new WorkerDeviceIdentity({
      clock,
      secrets: new InMemoryDeviceIdentitySecretStore(),
    });

    const enrolled = await enrollWorkerDevice({
      clock,
      discovery: {
        architecture: "x64",
        hostname: "worker-private",
        osFamily: "windows",
      },
      grant,
      identity: worker,
    });

    assert.equal(enrolled.deviceId, "device-worker-1");
    assert.equal(enrolled.generation, 1);
    assert.equal(enrolled.mainDeviceId, "device-main-1");
    assert.equal(enrolled.channelEndpoints[0]?.endpointId, "private-route");
    assert.equal(JSON.stringify(enrolled).includes(rawToken), false);
    assert.equal(JSON.stringify(await repository.snapshot()).includes(rawToken), false);

    await assert.rejects(
      enrollWorkerDevice({
        clock,
        discovery: {
          architecture: "x64",
          hostname: "worker-private",
          osFamily: "windows",
        },
        grant,
        identity: new WorkerDeviceIdentity({
          clock,
          secrets: new InMemoryDeviceIdentitySecretStore(),
        }),
      }),
      (error: unknown) =>
        error instanceof EnrollmentClientError &&
        error.code === "ENROLLMENT_REJECTED" &&
        !error.message.includes(rawToken),
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

async function issueServerIdentity(
  certificateAuthorityPem: string,
  certificateAuthorityPrivateKey: CryptoKey | null,
  now: number,
): Promise<{ readonly certificatePem: string; readonly privateKeyPem: string }> {
  assert.notEqual(certificateAuthorityPrivateKey, null);
  const certificateAuthority = new X509Certificate(certificateAuthorityPem);
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.create({
    serialNumber: "0102030405060708090a0b0c0d0e0f10",
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
}
