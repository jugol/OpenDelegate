import "reflect-metadata";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";

import {
  DeviceIdentityAuthority,
  InMemoryDeviceIdentityRepository,
  InMemoryDeviceIdentitySecretStore,
  type IdentityClock,
} from "../src/index.ts";

const NOW = Date.UTC(2026, 6, 25, 0, 0, 0);

test("Main issues a CA-chained server certificate for explicit Device listener hosts", async () => {
  const authority = new DeviceIdentityAuthority({
    clock: new FixedClock(NOW),
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  const certificateAuthority = await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const issued = await authority.issueMainServerCertificate({
    publicKey: keys.publicKey,
    hostnames: ["main.internal.example", "127.0.0.1"],
  });

  assert.equal(issued.certificateAuthorityPem, certificateAuthority.certificatePem);
  assert.equal(issued.issuedAt, NOW);
  assert.equal(issued.notBefore, NOW - 60_000);
  assert.ok(issued.notAfter > NOW);
  const certificate = new X509Certificate(issued.certificatePem);
  const issuer = new X509Certificate(issued.certificateAuthorityPem);
  assert.equal(
    await certificate.verify({ publicKey: issuer.publicKey, date: new Date(NOW) }),
    true,
  );
  assert.equal(certificate.getExtension(BasicConstraintsExtension)?.ca, false);
  assert.equal(
    certificate.getExtension(KeyUsagesExtension)?.usages,
    KeyUsageFlags.digitalSignature,
  );
  assert.deepEqual(
    [...(certificate.getExtension(ExtendedKeyUsageExtension)?.usages ?? [])],
    [ExtendedKeyUsage.serverAuth],
  );
  assert.deepEqual(
    certificate
      .getExtension(SubjectAlternativeNameExtension)
      ?.names.items.map((name) => name.toJSON()),
    [
      { type: "dns", value: "main.internal.example" },
      { type: "ip", value: "127.0.0.1" },
    ],
  );
});

test("Main server certificate issuance rejects ambiguous or non-P-256 identities", async () => {
  const authority = new DeviceIdentityAuthority({
    clock: new FixedClock(NOW),
    repository: new InMemoryDeviceIdentityRepository(),
    secrets: new InMemoryDeviceIdentitySecretStore(),
  });
  await authority.bootstrapCertificateAuthority({
    instanceId: "instance-personal",
  });
  const p256 = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const p384 = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" },
    true,
    ["sign", "verify"],
  );

  await assert.rejects(
    () =>
      authority.issueMainServerCertificate({
        publicKey: p256.publicKey,
        hostnames: ["127.0.0.1", "127.0.0.1"],
      }),
    { code: "IDENTITY_CONFIGURATION_INVALID" },
  );
  await assert.rejects(
    () =>
      authority.issueMainServerCertificate({
        publicKey: p384.publicKey,
        hostnames: ["main.internal.example"],
      }),
    { code: "IDENTITY_CONFIGURATION_INVALID" },
  );
});

class FixedClock implements IdentityClock {
  readonly #value: number;

  public constructor(value: number) {
    this.#value = value;
  }

  public now(): number {
    return this.#value;
  }
}
