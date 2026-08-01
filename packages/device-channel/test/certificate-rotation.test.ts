import "reflect-metadata";

import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  readDeviceCertificateLifecycle,
  type DeviceIdentitySecretStore,
} from "@opendelegate/device-identity";

import {
  IdentityRotationRejectedError,
  MainDeviceChannelServer,
  SqliteDeviceChannelRepository,
  SqliteWorkerChannelState,
  WorkerDeviceChannelClient,
} from "../src/index.ts";

const DEVICE_ID = "worker-rotation-1";
const MAIN_DEVICE_ID = "main-device-1";

class ExtractableTestIdentitySecretStore implements DeviceIdentitySecretStore {
  readonly #keys = new Map<string, CryptoKeyPair>();

  async createP256KeyPair(keyId: string): Promise<CryptoKeyPair> {
    const keys = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    this.#keys.set(keyId, keys);
    return keys;
  }

  async getPrivateKey(keyId: string): Promise<CryptoKey | null> {
    return this.#keys.get(keyId)?.privateKey ?? null;
  }

  async signP256(keyId: string, value: BufferSource): Promise<Uint8Array> {
    const key = this.#keys.get(keyId)?.privateKey;
    assert.notEqual(key, undefined);
    return new Uint8Array(
      await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key!, value),
    );
  }

  async has(keyId: string): Promise<boolean> {
    return this.#keys.has(keyId);
  }

  async exportPkcs8(keyId: string): Promise<Uint8Array> {
    const key = this.#keys.get(keyId)?.privateKey;
    assert.notEqual(key, undefined);
    return new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", key!));
  }
}

test(
  "a Worker renews its Device certificate over the authenticated channel",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opendelegate-rotation-"));
    const clock = { now: () => Date.now() };
    const mainSecrets = new InMemoryDeviceIdentitySecretStore();
    const workerSecrets = new ExtractableTestIdentitySecretStore();
    const authority = new DeviceIdentityAuthority({
      clock,
      repository: new InMemoryDeviceIdentityRepository(),
      secrets: mainSecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({
      instanceId: "instance-rotation",
    });
    const workerIdentity = new WorkerDeviceIdentity({ clock, secrets: workerSecrets });
    const grant = await authority.createEnrollmentGrant({
      deviceId: DEVICE_ID,
      allowedBootstrapRoles: ["worker"],
      expiresInMs: 5 * 60_000,
      protocolRange: { minimum: 1, maximum: 1 },
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
      discovery: { architecture: "x64", hostname: "rotation", osFamily: "linux" },
    });
    const serverIdentity = await issueServerIdentity(
      certificateAuthority.certificatePem,
      await mainSecrets.getPrivateKey(certificateAuthority.keyId),
    );

    let server: MainDeviceChannelServer | undefined;
    let client: WorkerDeviceChannelClient | undefined;
    let mainState: SqliteDeviceChannelRepository | undefined;
    let workerState: SqliteWorkerChannelState | undefined;
    try {
      mainState = await SqliteDeviceChannelRepository.open({
        filename: join(directory, "main-channel.sqlite"),
        sourceCheckoutRoot: process.cwd(),
      });
      workerState = await SqliteWorkerChannelState.open({
        filename: join(directory, "worker-channel.sqlite"),
        sourceCheckoutRoot: process.cwd(),
        deviceId: issued.deviceId,
        mainDeviceId: MAIN_DEVICE_ID,
        certificateGeneration: issued.generation,
      });
      server = await MainDeviceChannelServer.listen({
        mainDeviceId: MAIN_DEVICE_ID,
        authority,
        repository: mainState,
        tls: {
          certificateAuthorityPem: certificateAuthority.certificatePem,
          certificate: serverIdentity.certificatePem,
          privateKey: serverIdentity.privateKeyPem,
        },
      });
      client = await WorkerDeviceChannelClient.connect({
        endpointUrl: server.address().url,
        deviceId: issued.deviceId,
        workerId: "worker-runtime-1",
        mainDeviceId: MAIN_DEVICE_ID,
        connectTimeoutMs: 5_000,
        identity: {
          certificatePem: issued.certificatePem,
          certificateAuthorityPem: issued.certificateAuthorityPem,
          certificateGeneration: issued.generation,
          executeWithPrivateKeyBytes: async (executor) => {
            const pkcs8 = await workerSecrets.exportPkcs8(enrollment.keyId);
            try {
              await executor(pkcs8);
            } finally {
              pkcs8.fill(0);
            }
          },
        },
        state: workerState,
      });

      // The Worker generates a brand-new key. Renewal must never reuse the key it
      // is replacing, or a compromised key would survive its own rotation.
      const renewal = await workerIdentity.createEnrollmentRequest({
        deviceId: issued.deviceId,
        expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      });
      assert.notEqual(renewal.keyId, enrollment.keyId);

      const pending = await client.rotateIdentity(renewal.certificateRequestPem);
      assert.equal(pending.deviceId, issued.deviceId);
      assert.equal(pending.generation, issued.generation + 1);
      assert.notEqual(pending.serialNumber, issued.serialNumber);
      assert.ok(pending.activationExpiresAtMs > Date.now());

      // The pending certificate is not yet an identity: Main still rejects it.
      await assert.rejects(
        authority.validatePeerIdentity({
          certificatePem: pending.certificatePem,
          claimedDeviceId: issued.deviceId,
        }),
        /pending|not|invalid/iu,
      );

      const verified = await workerIdentity.verifyIssuedDeviceIdentity({
        keyId: renewal.keyId,
        deviceId: issued.deviceId,
        generation: pending.generation,
        certificatePem: pending.certificatePem,
        certificateAuthorityPem: pending.certificateAuthorityPem,
        certificateRequestPem: renewal.certificateRequestPem,
        expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      });
      assert.equal(verified.serialNumber, pending.serialNumber);

      const renewed = await client.activateIdentity({
        certificatePem: pending.certificatePem,
        activationChallenge: pending.activationChallenge,
        signature: await workerIdentity.createRotationProof({
          keyId: renewal.keyId,
          deviceId: issued.deviceId,
          certificateSerial: verified.serialNumber,
          activationChallenge: pending.activationChallenge,
        }),
      });
      assert.equal(renewed.generation, pending.generation);
      assert.equal(renewed.serialNumber, pending.serialNumber);
      assert.ok(renewed.overlapEndsAtMs > Date.now());

      // The renewed certificate now authenticates, and it outlives the one it replaced.
      const peer = await authority.validatePeerIdentity({
        certificatePem: pending.certificatePem,
        claimedDeviceId: issued.deviceId,
      });
      assert.equal(peer.certificateGeneration, pending.generation);
      assert.equal(peer.serialNumber, pending.serialNumber);
      const renewedLifecycle = readDeviceCertificateLifecycle(pending.certificatePem, Date.now());
      assert.equal(
        renewedLifecycle.state,
        "valid",
        "renewal must return the Device to a full validity window, not leave it due again",
      );
      assert.ok(
        renewedLifecycle.notAfter >=
          readDeviceCertificateLifecycle(issued.certificatePem, Date.now()).notAfter,
      );
    } finally {
      await client?.close();
      await server?.close();
      await workerState?.close();
      await mainState?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a second renewal offer is refused while one is still awaiting proof",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opendelegate-rotation-pending-"));
    const clock = { now: () => Date.now() };
    const mainSecrets = new InMemoryDeviceIdentitySecretStore();
    const workerSecrets = new ExtractableTestIdentitySecretStore();
    const authority = new DeviceIdentityAuthority({
      clock,
      repository: new InMemoryDeviceIdentityRepository(),
      secrets: mainSecrets,
    });
    const certificateAuthority = await authority.bootstrapCertificateAuthority({
      instanceId: "instance-rotation-pending",
    });
    const workerIdentity = new WorkerDeviceIdentity({ clock, secrets: workerSecrets });
    const grant = await authority.createEnrollmentGrant({
      deviceId: DEVICE_ID,
      allowedBootstrapRoles: ["worker"],
      expiresInMs: 5 * 60_000,
      protocolRange: { minimum: 1, maximum: 1 },
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
      discovery: { architecture: "x64", hostname: "rotation", osFamily: "linux" },
    });
    const serverIdentity = await issueServerIdentity(
      certificateAuthority.certificatePem,
      await mainSecrets.getPrivateKey(certificateAuthority.keyId),
    );

    let server: MainDeviceChannelServer | undefined;
    let client: WorkerDeviceChannelClient | undefined;
    let mainState: SqliteDeviceChannelRepository | undefined;
    let workerState: SqliteWorkerChannelState | undefined;
    try {
      mainState = await SqliteDeviceChannelRepository.open({
        filename: join(directory, "main-channel.sqlite"),
        sourceCheckoutRoot: process.cwd(),
      });
      workerState = await SqliteWorkerChannelState.open({
        filename: join(directory, "worker-channel.sqlite"),
        sourceCheckoutRoot: process.cwd(),
        deviceId: issued.deviceId,
        mainDeviceId: MAIN_DEVICE_ID,
        certificateGeneration: issued.generation,
      });
      server = await MainDeviceChannelServer.listen({
        mainDeviceId: MAIN_DEVICE_ID,
        authority,
        repository: mainState,
        tls: {
          certificateAuthorityPem: certificateAuthority.certificatePem,
          certificate: serverIdentity.certificatePem,
          privateKey: serverIdentity.privateKeyPem,
        },
      });
      client = await WorkerDeviceChannelClient.connect({
        endpointUrl: server.address().url,
        deviceId: issued.deviceId,
        workerId: "worker-runtime-1",
        mainDeviceId: MAIN_DEVICE_ID,
        connectTimeoutMs: 5_000,
        identity: {
          certificatePem: issued.certificatePem,
          certificateAuthorityPem: issued.certificateAuthorityPem,
          certificateGeneration: issued.generation,
          executeWithPrivateKeyBytes: async (executor) => {
            const pkcs8 = await workerSecrets.exportPkcs8(enrollment.keyId);
            try {
              await executor(pkcs8);
            } finally {
              pkcs8.fill(0);
            }
          },
        },
        state: workerState,
      });

      const first = await workerIdentity.createEnrollmentRequest({
        deviceId: issued.deviceId,
        expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      });
      await client.rotateIdentity(first.certificateRequestPem);

      const second = await workerIdentity.createEnrollmentRequest({
        deviceId: issued.deviceId,
        expectedMainSpkiSha256: grant.expectedMainSpkiSha256,
      });
      const rejection = await client.rotateIdentity(second.certificateRequestPem).then(
        () => undefined,
        (error: unknown) => error,
      );

      assert.ok(rejection instanceof IdentityRotationRejectedError, String(rejection));
      assert.equal(rejection.code, "ROTATION_ALREADY_PENDING");
      assert.equal(
        rejection.retryable,
        false,
        "an already-pending rotation is not repaired by asking again",
      );

      // An activation that names a certificate Main never left pending, carrying a
      // challenge and signature the Worker made up, is refused rather than accepted.
      const forged = await client
        .activateIdentity({
          certificatePem: issued.certificatePem,
          activationChallenge: "A".repeat(43),
          signature: "AAAA",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      assert.ok(forged instanceof IdentityRotationRejectedError, String(forged));
      assert.equal(forged.code, "ROTATION_INVALID");
    } finally {
      await client?.close();
      await server?.close();
      await workerState?.close();
      await mainState?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
      // Let Node encode the PEM rather than assembling the armour by hand, so the
      // fixture holds no key-shaped literal for a secret scanner to trip over.
      privateKeyPem: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
  } finally {
    pkcs8.fill(0);
  }
}
