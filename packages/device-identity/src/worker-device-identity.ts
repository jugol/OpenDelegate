import "reflect-metadata";

import { timingSafeEqual } from "node:crypto";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  Pkcs10CertificateRequestGenerator,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";

import type {
  DeviceIdentitySecretStore,
  IdentityClock,
  IdentityRandomSource,
} from "./contracts.ts";
import { identityWebCrypto, NodeIdentityRandomSource } from "./crypto.ts";
import { DeviceIdentityError } from "./error.ts";

const ECDSA_SHA256 = Object.freeze({
  name: "ECDSA",
  hash: "SHA-256",
});

export interface WorkerDeviceIdentityOptions {
  readonly clock: IdentityClock;
  readonly secrets: DeviceIdentitySecretStore;
  readonly random?: IdentityRandomSource;
}

export interface CreateEnrollmentRequest {
  readonly deviceId: string;
  readonly expectedMainSpkiSha256: string;
}

export interface WorkerEnrollmentRequest {
  readonly deviceId: string;
  readonly keyId: string;
  readonly certificateRequestPem: string;
  readonly expectedMainSpkiSha256: string;
}

export interface VerifyMainIdentity {
  readonly certificatePem: string;
  readonly expectedSpkiSha256: string;
}

export interface VerifiedMainIdentity {
  readonly verified: true;
  readonly spkiSha256: string;
}

export interface CreateRotationProof {
  readonly keyId: string;
  readonly deviceId: string;
  readonly certificateSerial: string;
  readonly activationChallenge: string;
}

export interface VerifyIssuedDeviceIdentity {
  readonly keyId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly certificateRequestPem: string;
  readonly expectedMainSpkiSha256: string;
}

export interface VerifiedIssuedDeviceIdentity {
  readonly keyId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly serialNumber: string;
  readonly notBefore: number;
  readonly notAfter: number;
}

export class WorkerDeviceIdentity {
  private readonly clock: IdentityClock;
  private readonly secrets: DeviceIdentitySecretStore;
  private readonly random: IdentityRandomSource;

  public constructor(options: WorkerDeviceIdentityOptions) {
    this.clock = options.clock;
    this.secrets = options.secrets;
    this.random = options.random ?? new NodeIdentityRandomSource();
  }

  public async createEnrollmentRequest(
    request: CreateEnrollmentRequest,
  ): Promise<WorkerEnrollmentRequest> {
    const deviceId = validateDeviceId(request.deviceId);
    const expectedMainSpkiSha256 = validateFingerprint(request.expectedMainSpkiSha256);
    const keyId = `device-key_${base64Url(this.random.bytes(16))}`;
    const keys = await this.secrets.createP256KeyPair(keyId);
    const certificateRequest = await Pkcs10CertificateRequestGenerator.create(
      {
        name: `CN=${deviceId}`,
        keys,
        signingAlgorithm: ECDSA_SHA256,
        extensions: [
          new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
          new SubjectAlternativeNameExtension([{ type: "url", value: deviceUri(deviceId) }], false),
        ],
      },
      identityWebCrypto,
    );

    return deepFreeze({
      deviceId,
      keyId,
      certificateRequestPem: certificateRequest.toString("pem"),
      expectedMainSpkiSha256,
    });
  }

  public async verifyMainIdentity(request: VerifyMainIdentity): Promise<VerifiedMainIdentity> {
    const expected = validateFingerprint(request.expectedSpkiSha256);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(request.certificatePem);
    } catch {
      throw invalidMainIdentity();
    }

    const now = readClock(this.clock);
    const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
    const keyUsages = certificate.getExtension(KeyUsagesExtension);
    const algorithm = certificate.publicKey.algorithm;
    let selfSignatureValid: boolean;
    try {
      selfSignatureValid = await certificate.verify(
        { publicKey: certificate.publicKey, date: new Date(now) },
        identityWebCrypto,
      );
    } catch {
      throw invalidMainIdentity();
    }
    if (
      !selfSignatureValid ||
      certificate.subject !== certificate.issuer ||
      certificate.signatureAlgorithm.name !== "ECDSA" ||
      certificate.signatureAlgorithm.hash.name !== "SHA-256" ||
      algorithm.name !== "ECDSA" ||
      !("namedCurve" in algorithm) ||
      algorithm.namedCurve !== "P-256" ||
      basicConstraints?.ca !== true ||
      basicConstraints.pathLength !== 0 ||
      keyUsages === null ||
      keyUsages.usages !== (KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign) ||
      now < certificate.notBefore.getTime() ||
      now >= certificate.notAfter.getTime()
    ) {
      throw invalidMainIdentity();
    }

    const actual = await certificateSpkiFingerprint(certificate);
    if (!fingerprintsEqual(actual, expected)) {
      throw new DeviceIdentityError(
        "MAIN_IDENTITY_PIN_MISMATCH",
        "The presented Main identity did not match the enrollment pin.",
      );
    }
    return deepFreeze({
      verified: true as const,
      spkiSha256: actual,
    });
  }

  public async createRotationProof(request: CreateRotationProof): Promise<string> {
    const keyId = validateKeyId(request.keyId);
    const deviceId = validateDeviceId(request.deviceId);
    const certificateSerial = validateCertificateSerial(request.certificateSerial);
    const activationChallenge = validateActivationChallenge(request.activationChallenge);
    const signature = await this.secrets.signP256(
      keyId,
      rotationProofPayload({
        activationChallenge,
        certificateSerial,
        deviceId,
      }),
    );
    return base64Url(signature);
  }

  public async verifyIssuedDeviceIdentity(
    request: VerifyIssuedDeviceIdentity,
  ): Promise<VerifiedIssuedDeviceIdentity> {
    const keyId = validateKeyId(request.keyId);
    const deviceId = validateDeviceId(request.deviceId);
    const generation = validateGeneration(request.generation);
    await this.verifyMainIdentity({
      certificatePem: request.certificateAuthorityPem,
      expectedSpkiSha256: request.expectedMainSpkiSha256,
    });
    if (!(await this.secrets.has(keyId))) {
      throw invalidIssuedIdentity();
    }

    let certificateAuthority: X509Certificate;
    let certificate: X509Certificate;
    let certificateRequest: Pkcs10CertificateRequest;
    try {
      certificateAuthority = new X509Certificate(request.certificateAuthorityPem);
      certificate = new X509Certificate(request.certificatePem);
      certificateRequest = new Pkcs10CertificateRequest(request.certificateRequestPem);
    } catch {
      throw invalidIssuedIdentity();
    }
    const serialNumber = normalizeCertificateSerial(certificate.serialNumber);
    const algorithm = certificate.publicKey.algorithm;
    const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
    const keyUsages = certificate.getExtension(KeyUsagesExtension);
    const extendedKeyUsages = certificate.getExtension(ExtendedKeyUsageExtension);
    const subjectAlternativeName = certificate.getExtension(SubjectAlternativeNameExtension);
    const names = subjectAlternativeName?.names.items.map((name) => name.toJSON());
    const now = readClock(this.clock);
    let certificateSignatureValid: boolean;
    let certificateRequestSignatureValid: boolean;
    try {
      [certificateSignatureValid, certificateRequestSignatureValid] = await Promise.all([
        certificate.verify(
          { publicKey: certificateAuthority.publicKey, date: new Date(now) },
          identityWebCrypto,
        ),
        certificateRequest.verify(identityWebCrypto),
      ]);
    } catch {
      throw invalidIssuedIdentity();
    }
    if (
      serialNumber === null ||
      !certificateSignatureValid ||
      !certificateRequestSignatureValid ||
      certificate.issuer !== certificateAuthority.subject ||
      certificate.subject !== `CN=${deviceId}` ||
      certificateRequest.subject !== `CN=${deviceId}` ||
      certificate.signatureAlgorithm.name !== "ECDSA" ||
      certificate.signatureAlgorithm.hash.name !== "SHA-256" ||
      algorithm.name !== "ECDSA" ||
      !("namedCurve" in algorithm) ||
      algorithm.namedCurve !== "P-256" ||
      basicConstraints?.ca !== false ||
      keyUsages?.usages !== KeyUsageFlags.digitalSignature ||
      extendedKeyUsages?.usages.length !== 1 ||
      extendedKeyUsages.usages[0] !== ExtendedKeyUsage.clientAuth ||
      names?.length !== 1 ||
      names[0]?.type !== "url" ||
      names[0].value !== deviceUri(deviceId) ||
      !bufferSourcesEqual(certificate.publicKey.rawData, certificateRequest.publicKey.rawData) ||
      now < certificate.notBefore.getTime() ||
      now >= certificate.notAfter.getTime()
    ) {
      throw invalidIssuedIdentity();
    }

    const proofPayload = new TextEncoder().encode(
      ["OpenDelegate issued Device key proof v1", deviceId, serialNumber].join("\n"),
    );
    const signature = await this.secrets.signP256(keyId, proofPayload);
    const signatureCopy = new Uint8Array(signature.byteLength);
    signatureCopy.set(signature);
    let proofValid: boolean;
    try {
      const publicKey = await certificate.publicKey.export(identityWebCrypto);
      proofValid = await identityWebCrypto.subtle.verify(
        ECDSA_SHA256,
        publicKey,
        signatureCopy,
        proofPayload,
      );
    } catch {
      throw invalidIssuedIdentity();
    } finally {
      proofPayload.fill(0);
      signature.fill(0);
      signatureCopy.fill(0);
    }
    if (!proofValid) {
      throw invalidIssuedIdentity();
    }

    return deepFreeze({
      keyId,
      deviceId,
      generation,
      certificatePem: request.certificatePem,
      certificateAuthorityPem: request.certificateAuthorityPem,
      serialNumber,
      notBefore: certificate.notBefore.getTime(),
      notAfter: certificate.notAfter.getTime(),
    });
  }
}

async function certificateSpkiFingerprint(certificate: X509Certificate): Promise<string> {
  const digest = await identityWebCrypto.subtle.digest("SHA-256", certificate.publicKey.rawData);
  return `sha256:${base64Url(new Uint8Array(digest))}`;
}

function fingerprintsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left.slice("sha256:".length), "base64url");
  const rightBytes = Buffer.from(right.slice("sha256:".length), "base64url");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateDeviceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Device ID must use 1-128 URI-safe identifier characters.",
    );
  }
  return value;
}

function validateFingerprint(value: string): string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "A SHA-256 SPKI fingerprint is required.",
    );
  }
  return value;
}

function validateKeyId(value: string): string {
  if (typeof value !== "string" || !/^device-key_[A-Za-z0-9_-]{22}$/u.test(value)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "A valid Device key identifier is required.",
    );
  }
  return value;
}

function validateCertificateSerial(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "A 128-bit Device certificate serial is required.",
    );
  }
  return value;
}

function normalizeCertificateSerial(value: string): string | null {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{1,32}$/u.test(normalized)) {
    return null;
  }
  return normalized.padStart(32, "0");
}

function validateGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The Device certificate generation must be a positive safe integer.",
    );
  }
  return value;
}

function validateActivationChallenge(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "A valid certificate activation challenge is required.",
    );
  }
  return value;
}

function deviceUri(deviceId: string): string {
  return `urn:opendelegate:device:${deviceId}`;
}

function rotationProofPayload(request: {
  readonly activationChallenge: string;
  readonly certificateSerial: string;
  readonly deviceId: string;
}): ArrayBuffer {
  return new TextEncoder().encode(
    [
      "OpenDelegate device certificate rotation v1",
      request.deviceId,
      request.certificateSerial,
      request.activationChallenge,
    ].join("\n"),
  ).buffer;
}

function readClock(clock: IdentityClock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The identity clock must return a non-negative safe-integer timestamp.",
    );
  }
  return now;
}

function invalidMainIdentity(): DeviceIdentityError {
  return new DeviceIdentityError(
    "MAIN_IDENTITY_INVALID",
    "The presented Main identity certificate is invalid.",
  );
}

function invalidIssuedIdentity(): DeviceIdentityError {
  return new DeviceIdentityError(
    "PEER_CERTIFICATE_INVALID",
    "The issued Device certificate did not match the local key and enrollment request.",
  );
}

function bufferSourcesEqual(left: BufferSource, right: BufferSource): boolean {
  const leftBytes = Buffer.from(
    left instanceof ArrayBuffer ? left : left.buffer,
    left instanceof ArrayBuffer ? 0 : left.byteOffset,
    left instanceof ArrayBuffer ? left.byteLength : left.byteLength,
  );
  const rightBytes = Buffer.from(
    right instanceof ArrayBuffer ? right : right.buffer,
    right instanceof ArrayBuffer ? 0 : right.byteOffset,
    right instanceof ArrayBuffer ? right.byteLength : right.byteLength,
  );
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
