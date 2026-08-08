import "reflect-metadata";

import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  Pkcs10CertificateRequest,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";

import type {
  DeviceIdentityRepository,
  DeviceIdentitySecretStore,
  DeviceDiscoveryBootstrap,
  EnrollmentGrantIntent,
  IdentityClock,
  IdentityRandomSource,
  PersistedDeviceCertificate,
  PersistedDeviceIdentity,
  PersistedEnrollmentGrant,
  ProtocolCompatibilityRange,
  PublicCertificateAuthority,
} from "./contracts.ts";
import { identityWebCrypto, NodeIdentityRandomSource } from "./crypto.ts";
import { EnrollmentGrantSecret } from "./enrollment-grant-secret.ts";
import { DeviceIdentityError } from "./error.ts";

const CA_VALIDITY_MS = 3_650 * 24 * 60 * 60 * 1_000;
const DEVICE_CERTIFICATE_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const MAIN_SERVER_CERTIFICATE_VALIDITY_MS = 90 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;
const MINIMUM_GRANT_TTL_MS = 30_000;
const MAXIMUM_GRANT_TTL_MS = 30 * 60_000;
const DEFAULT_ROTATION_OVERLAP_MS = 5 * 60_000;
const DEFAULT_ROTATION_ACTIVATION_TTL_MS = 2 * 60_000;
const MAXIMUM_ROTATION_WINDOW_MS = 30 * 60_000;
const MAXIMUM_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const ECDSA_SHA256 = Object.freeze({
  name: "ECDSA",
  hash: "SHA-256",
});

export interface DeviceIdentityAuthorityOptions {
  readonly clock: IdentityClock;
  readonly repository: DeviceIdentityRepository;
  readonly secrets: DeviceIdentitySecretStore;
  readonly random?: IdentityRandomSource;
  readonly rotationOverlapMs?: number;
  readonly rotationActivationTtlMs?: number;
}

export interface BootstrapCertificateAuthority {
  readonly instanceId: string;
}

export interface IssueMainServerCertificate {
  readonly publicKey: CryptoKey;
  readonly hostnames: readonly string[];
}

export interface IssuedMainServerCertificate {
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly serialNumber: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface CreateEnrollmentGrant {
  readonly deviceId: string;
  readonly allowedBootstrapRoles: readonly string[];
  readonly expiresInMs: number;
  readonly protocolRange: ProtocolCompatibilityRange;
  /** Defaults to `enroll`, so re-credentialing is never reached by omission. */
  readonly intent?: EnrollmentGrantIntent;
}

export interface IssuedEnrollmentGrant {
  readonly grantId: string;
  readonly deviceId: string;
  readonly intent: EnrollmentGrantIntent;
  readonly allowedBootstrapRoles: readonly string[];
  readonly protocolRange: ProtocolCompatibilityRange;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly expectedMainSpkiSha256: string;
  readonly secret: EnrollmentGrantSecret;
}

export interface EnrollDevice {
  readonly grantId: string;
  readonly token: string;
  readonly deviceId: string;
  readonly protocolVersion: number;
  readonly certificateRequestPem: string;
  readonly discovery: DeviceDiscoveryBootstrap;
}

export interface IssuedDeviceIdentity {
  readonly deviceId: string;
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly serialNumber: string;
  readonly publicKeySpkiSha256: string;
  readonly generation: number;
  readonly status: "active";
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface ValidatePeerIdentity {
  readonly certificatePem: string;
  readonly claimedDeviceId: string;
}

export interface AuthenticatedDevicePeer {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly certificateGeneration: number;
  readonly publicKeySpkiSha256: string;
}

export interface IssueCertificateRotation {
  readonly deviceId: string;
  readonly currentCertificatePem: string;
  readonly newCertificateRequestPem: string;
}

export interface IssuedPendingDeviceIdentity {
  readonly deviceId: string;
  readonly certificatePem: string;
  readonly certificateAuthorityPem: string;
  readonly serialNumber: string;
  readonly publicKeySpkiSha256: string;
  readonly generation: number;
  readonly status: "pending";
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly activationChallenge: string;
  readonly activationExpiresAt: number;
}

export interface ConfirmCertificateRotation {
  readonly deviceId: string;
  readonly certificatePem: string;
  readonly activationChallenge: string;
  readonly signature: string;
}

export interface ConfirmedDeviceIdentity {
  readonly deviceId: string;
  readonly certificatePem: string;
  readonly serialNumber: string;
  readonly publicKeySpkiSha256: string;
  readonly generation: number;
  readonly status: "active";
  readonly overlapEndsAt: number;
}

export interface RevokeDevice {
  readonly deviceId: string;
}

export interface RevokedDeviceIdentity {
  readonly deviceId: string;
  readonly status: "revoked";
  readonly revokedAt: number;
  readonly certificateSerials: readonly string[];
}

export class DeviceIdentityAuthority {
  private readonly clock: IdentityClock;
  private readonly repository: DeviceIdentityRepository;
  private readonly secrets: DeviceIdentitySecretStore;
  private readonly random: IdentityRandomSource;
  private readonly rotationOverlapMs: number;
  private readonly rotationActivationTtlMs: number;

  public constructor(options: DeviceIdentityAuthorityOptions) {
    this.clock = options.clock;
    this.repository = options.repository;
    this.secrets = options.secrets;
    this.random = options.random ?? new NodeIdentityRandomSource();
    this.rotationOverlapMs = validateRotationWindow(
      options.rotationOverlapMs ?? DEFAULT_ROTATION_OVERLAP_MS,
      "rotation overlap",
    );
    this.rotationActivationTtlMs = validateRotationWindow(
      options.rotationActivationTtlMs ?? DEFAULT_ROTATION_ACTIVATION_TTL_MS,
      "rotation activation lifetime",
    );
  }

  public async bootstrapCertificateAuthority(
    request: BootstrapCertificateAuthority,
  ): Promise<PublicCertificateAuthority> {
    const instanceId = validateIdentifier(request.instanceId, "Instance ID");
    return this.repository.transaction(async (transaction) => {
      const now = readClock(this.clock);
      const existing = await transaction.getCertificateAuthority();
      if (existing !== null) {
        if (existing.instanceId !== instanceId) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_CONFLICT",
            "A certificate authority already belongs to another Instance.",
          );
        }
        let certificate: X509Certificate;
        try {
          certificate = new X509Certificate(existing.certificatePem);
        } catch {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_CONFLICT",
            "The persisted certificate authority identity is invalid.",
          );
        }
        if (!(await isValidCertificateAuthority(existing, certificate, now))) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_CONFLICT",
            "The persisted certificate authority identity is invalid.",
          );
        }
        if (!(await this.secrets.has(existing.keyId))) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority signing key is unavailable.",
          );
        }
        return deepFreeze(existing);
      }

      const keyId = `ca_${base64Url(this.random.bytes(16))}`;
      const serialNumber = nextCertificateSerial(this.random);
      const keys = await this.secrets.createP256KeyPair(keyId);
      const certificate = await X509CertificateGenerator.createSelfSigned(
        {
          serialNumber,
          name: `CN=OpenDelegate instance ${escapeDistinguishedName(instanceId)}`,
          notBefore: new Date(now - CLOCK_SKEW_MS),
          notAfter: new Date(safeTimestampAfter(now, CA_VALIDITY_MS)),
          signingAlgorithm: ECDSA_SHA256,
          keys,
          extensions: [
            new BasicConstraintsExtension(true, 0, true),
            new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
            await SubjectKeyIdentifierExtension.create(keys.publicKey, false, identityWebCrypto),
          ],
        },
        identityWebCrypto,
      );
      const record = deepFreeze({
        instanceId,
        keyId,
        certificatePem: certificate.toString("pem"),
        spkiSha256: await certificateSpkiFingerprint(certificate),
        status: "active" as const,
        createdAt: now,
        notBefore: certificate.notBefore.getTime(),
        notAfter: certificate.notAfter.getTime(),
      });
      await transaction.setCertificateAuthority(record);
      return record;
    });
  }

  public async issueMainServerCertificate(
    request: IssueMainServerCertificate,
  ): Promise<IssuedMainServerCertificate> {
    const hostnames = validateServerHostnames(request.hostnames);
    validateServerPublicKey(request.publicKey);
    return this.repository.transaction(async (transaction) => {
      const now = readClock(this.clock);
      const certificateAuthority = await transaction.getCertificateAuthority();
      if (certificateAuthority === null) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority has not been bootstrapped.",
        );
      }
      let issuer: X509Certificate;
      try {
        issuer = new X509Certificate(certificateAuthority.certificatePem);
      } catch {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority public identity is invalid.",
        );
      }
      const signingKey = await this.secrets.getPrivateKey(certificateAuthority.keyId);
      if (
        signingKey === null ||
        !(await isValidCertificateAuthority(certificateAuthority, issuer, now))
      ) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority is unavailable for Main listener issuance.",
        );
      }
      const notBefore = now - CLOCK_SKEW_MS;
      const notAfter = Math.min(
        safeTimestampAfter(now, MAIN_SERVER_CERTIFICATE_VALIDITY_MS),
        certificateAuthority.notAfter,
      );
      if (notAfter <= now) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority is no longer valid for Main listener issuance.",
        );
      }
      const serialNumber = nextCertificateSerial(this.random);
      const certificate = await X509CertificateGenerator.create(
        {
          serialNumber,
          subject: "CN=OpenDelegate Main Device listener",
          issuer: issuer.subject,
          notBefore: new Date(notBefore),
          notAfter: new Date(notAfter),
          publicKey: request.publicKey,
          signingKey,
          signingAlgorithm: ECDSA_SHA256,
          extensions: [
            new BasicConstraintsExtension(false, undefined, true),
            new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
            new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
            new SubjectAlternativeNameExtension(
              hostnames.map((hostname) => ({
                type: isIP(hostname) === 0 ? ("dns" as const) : ("ip" as const),
                value: hostname,
              })),
              false,
            ),
            await SubjectKeyIdentifierExtension.create(request.publicKey, false, identityWebCrypto),
            await AuthorityKeyIdentifierExtension.create(
              issuer.publicKey,
              false,
              identityWebCrypto,
            ),
          ],
        },
        identityWebCrypto,
      );
      if (
        !(await certificate.verify(
          {
            publicKey: issuer.publicKey,
            date: new Date(now),
          },
          identityWebCrypto,
        ))
      ) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority signing key does not match its public identity.",
        );
      }
      return deepFreeze({
        certificatePem: certificate.toString("pem"),
        certificateAuthorityPem: certificateAuthority.certificatePem,
        serialNumber,
        issuedAt: now,
        notBefore: certificate.notBefore.getTime(),
        notAfter: certificate.notAfter.getTime(),
      });
    });
  }

  public async createEnrollmentGrant(
    request: CreateEnrollmentGrant,
  ): Promise<IssuedEnrollmentGrant> {
    const deviceId = validateDeviceId(request.deviceId);
    const allowedBootstrapRoles = validateBootstrapRoles(request.allowedBootstrapRoles);
    const protocolRange = validateProtocolRange(request.protocolRange);
    const intent = validateGrantIntent(request.intent);
    if (
      !Number.isSafeInteger(request.expiresInMs) ||
      request.expiresInMs < MINIMUM_GRANT_TTL_MS ||
      request.expiresInMs > MAXIMUM_GRANT_TTL_MS
    ) {
      throw new DeviceIdentityError(
        "IDENTITY_CONFIGURATION_INVALID",
        "Enrollment Grant lifetime must be between 30 seconds and 30 minutes.",
      );
    }
    const now = readClock(this.clock);
    const grantId = `grant_${base64Url(this.random.bytes(16))}`;
    const rawToken = base64Url(this.random.bytes(32));
    const tokenDigest = await sha256Hex(new TextEncoder().encode(rawToken));

    return this.repository.transaction(async (transaction) => {
      const certificateAuthority = await transaction.getCertificateAuthority();
      if (certificateAuthority === null) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority has not been bootstrapped.",
        );
      }
      let issuer: X509Certificate;
      try {
        issuer = new X509Certificate(certificateAuthority.certificatePem);
      } catch {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority public identity is invalid.",
        );
      }
      if (
        !(await isValidCertificateAuthority(certificateAuthority, issuer, now)) ||
        !(await this.secrets.has(certificateAuthority.keyId))
      ) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority is unavailable for enrollment.",
        );
      }
      if ((await transaction.getEnrollmentGrant(grantId)) !== null) {
        throw new DeviceIdentityError(
          "IDENTITY_REPOSITORY_CONFLICT",
          "The generated Enrollment Grant identifier already exists.",
        );
      }
      const existing = await transaction.getDevice(deviceId);
      if (intent === "enroll" && existing !== null) {
        throw new DeviceIdentityError(
          "DEVICE_ALREADY_ENROLLED",
          "The intended Device identity already exists.",
        );
      }
      if (intent === "recredential") {
        if (existing === null) {
          throw new DeviceIdentityError(
            "DEVICE_IDENTITY_NOT_FOUND",
            "Only an existing Device identity can be re-credentialed.",
          );
        }
        if (existing.status !== "active") {
          throw new DeviceIdentityError(
            "DEVICE_IDENTITY_NOT_FOUND",
            "A revoked Device identity cannot be re-credentialed.",
          );
        }
      }

      const expiresAt = safeTimestampAfter(now, request.expiresInMs);
      const persisted: PersistedEnrollmentGrant = deepFreeze({
        grantId,
        tokenDigest,
        deviceId,
        intent,
        allowedBootstrapRoles,
        protocolRange,
        status: "active" as const,
        createdAt: now,
        expiresAt,
      });
      await transaction.saveEnrollmentGrant(persisted);
      await transaction.appendAuditRecord({
        auditId: nextAuditId(this.random),
        event: "device.enrollment-grant-issued",
        occurredAt: now,
        deviceId,
        grantId,
      });

      return deepFreeze({
        grantId,
        deviceId,
        intent,
        allowedBootstrapRoles,
        protocolRange,
        createdAt: now,
        expiresAt,
        expectedMainSpkiSha256: certificateAuthority.spkiSha256,
        secret: new EnrollmentGrantSecret(rawToken),
      });
    });
  }

  public async enrollDevice(request: EnrollDevice): Promise<IssuedDeviceIdentity> {
    const grantId = validateGrantId(request.grantId);
    const deviceId = validateDeviceId(request.deviceId);
    const token = validateEnrollmentToken(request.token);
    const protocolVersion = validateProtocolVersion(request.protocolVersion);
    const discovery = validateDiscovery(request.discovery);
    const certificateRequest = await validateCertificateRequest(
      request.certificateRequestPem,
      deviceId,
    );
    const tokenDigest = await sha256Hex(new TextEncoder().encode(token));

    const outcome:
      | { readonly ok: true; readonly identity: IssuedDeviceIdentity }
      | { readonly ok: false; readonly error: DeviceIdentityError } =
      await this.repository.transaction(async (transaction) => {
        const now = readClock(this.clock);
        const grant = await transaction.getEnrollmentGrant(grantId);
        if (
          grant === null ||
          grant.status !== "active" ||
          !digestsEqual(grant.tokenDigest, tokenDigest) ||
          grant.deviceId !== deviceId
        ) {
          await transaction.appendAuditRecord({
            auditId: nextAuditId(this.random),
            event: "device.enrollment-rejected",
            occurredAt: now,
            deviceId,
            grantId,
            rejectionCode: "invalid-or-consumed",
          });
          return {
            ok: false as const,
            error: enrollmentGrantInvalid(),
          };
        }
        if (now >= grant.expiresAt) {
          await transaction.saveEnrollmentGrant({
            ...grant,
            status: "expired",
          });
          await transaction.appendAuditRecord({
            auditId: nextAuditId(this.random),
            event: "device.enrollment-rejected",
            occurredAt: now,
            deviceId,
            grantId,
            rejectionCode: "expired",
          });
          return {
            ok: false as const,
            error: enrollmentGrantInvalid(),
          };
        }
        if (
          protocolVersion < grant.protocolRange.minimum ||
          protocolVersion > grant.protocolRange.maximum
        ) {
          await transaction.appendAuditRecord({
            auditId: nextAuditId(this.random),
            event: "device.enrollment-rejected",
            occurredAt: now,
            deviceId,
            grantId,
            rejectionCode: "protocol-incompatible",
          });
          return {
            ok: false as const,
            error: new DeviceIdentityError(
              "ENROLLMENT_PROTOCOL_INCOMPATIBLE",
              "The Worker protocol version is outside the Enrollment Grant range.",
            ),
          };
        }
        const existingDevice = await transaction.getDevice(deviceId);
        if (grant.intent === "enroll" && existingDevice !== null) {
          await transaction.appendAuditRecord({
            auditId: nextAuditId(this.random),
            event: "device.enrollment-rejected",
            occurredAt: now,
            deviceId,
            grantId,
            rejectionCode: "device-already-enrolled",
          });
          return {
            ok: false as const,
            error: new DeviceIdentityError(
              "DEVICE_ALREADY_ENROLLED",
              "The intended Device identity already exists.",
            ),
          };
        }
        if (grant.intent === "recredential" && existingDevice?.status !== "active") {
          await transaction.appendAuditRecord({
            auditId: nextAuditId(this.random),
            event: "device.enrollment-rejected",
            occurredAt: now,
            deviceId,
            grantId,
            rejectionCode:
              existingDevice === null ? "device-not-enrolled" : "device-identity-revoked",
          });
          return {
            ok: false as const,
            error: new DeviceIdentityError(
              "DEVICE_IDENTITY_NOT_FOUND",
              "The Device identity cannot be re-credentialed.",
            ),
          };
        }
        const generation = (existingDevice?.identityGeneration ?? 0) + 1;

        const certificateAuthority = await transaction.getCertificateAuthority();
        if (certificateAuthority === null) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority record is unavailable.",
          );
        }
        const signingKey = await this.secrets.getPrivateKey(certificateAuthority.keyId);
        if (signingKey === null) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority signing key is unavailable.",
          );
        }

        const serialNumber = nextCertificateSerial(this.random);
        if ((await transaction.getCertificateBySerial(serialNumber)) !== null) {
          throw new DeviceIdentityError(
            "IDENTITY_REPOSITORY_CONFLICT",
            "The generated Device certificate serial already exists.",
          );
        }
        let issuerCertificate: X509Certificate;
        try {
          issuerCertificate = new X509Certificate(certificateAuthority.certificatePem);
        } catch {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority public identity is invalid.",
          );
        }
        if (!(await isValidCertificateAuthority(certificateAuthority, issuerCertificate, now))) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority is unavailable for enrollment.",
          );
        }
        const notBefore = now - CLOCK_SKEW_MS;
        const notAfter = Math.min(
          safeTimestampAfter(now, DEVICE_CERTIFICATE_VALIDITY_MS),
          certificateAuthority.notAfter,
        );
        if (notAfter <= now) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority is no longer valid for issuance.",
          );
        }
        const certificate = await issueDeviceCertificate({
          certificateAuthority: issuerCertificate,
          certificateRequest,
          deviceId,
          notAfter,
          notBefore,
          serialNumber,
          signingKey,
        });
        if (
          !(await certificate.verify(
            { publicKey: issuerCertificate.publicKey, date: new Date(now) },
            identityWebCrypto,
          ))
        ) {
          throw new DeviceIdentityError(
            "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
            "The certificate authority signing key does not match its public identity.",
          );
        }
        const publicKeySpkiSha256 = await publicKeyFingerprint(certificate.publicKey.rawData);
        const certificateNotBefore = certificate.notBefore.getTime();
        const certificateNotAfter = certificate.notAfter.getTime();
        const certificateRecord: PersistedDeviceCertificate = deepFreeze({
          deviceId,
          serialNumber,
          generation,
          certificatePem: certificate.toString("pem"),
          publicKeySpkiSha256,
          status: "active" as const,
          notBefore: certificateNotBefore,
          notAfter: certificateNotAfter,
          issuedAt: now,
        });
        // Re-credentialing replaces the credential, so every earlier generation is
        // revoked rather than left to expire. A lost or exposed key must not keep
        // working alongside the replacement the owner just authorized.
        for (const superseded of existingDevice === null
          ? []
          : await transaction.listDeviceCertificates(deviceId)) {
          if (superseded.status === "revoked") {
            continue;
          }
          await transaction.saveCertificate({
            ...superseded,
            status: "revoked",
            revokedAt: now,
          });
        }
        const deviceRecord: PersistedDeviceIdentity = deepFreeze({
          deviceId,
          status: "active" as const,
          identityGeneration: generation,
          allowedBootstrapRoles: grant.allowedBootstrapRoles,
          discovery,
          createdAt: existingDevice?.createdAt ?? now,
        });
        await transaction.saveCertificate(certificateRecord);
        await transaction.saveDevice(deviceRecord);
        await transaction.saveEnrollmentGrant({
          ...grant,
          status: "consumed",
          consumedAt: now,
          issuedCertificateSerial: serialNumber,
        });
        await transaction.appendAuditRecord({
          auditId: nextAuditId(this.random),
          event: existingDevice === null ? "device.enrolled" : "device.recredentialed",
          occurredAt: now,
          deviceId,
          grantId,
          certificateSerial: serialNumber,
          certificateGeneration: generation,
        });

        return {
          ok: true as const,
          identity: deepFreeze({
            deviceId,
            certificatePem: certificateRecord.certificatePem,
            certificateAuthorityPem: certificateAuthority.certificatePem,
            serialNumber,
            publicKeySpkiSha256,
            generation,
            status: "active" as const,
            issuedAt: now,
            notBefore: certificateNotBefore,
            notAfter: certificateNotAfter,
          }),
        };
      });
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.identity;
  }

  public async issueCertificateRotation(
    request: IssueCertificateRotation,
  ): Promise<IssuedPendingDeviceIdentity> {
    const deviceId = validateDeviceId(request.deviceId);
    const currentPeer = await this.validatePeerIdentity({
      certificatePem: request.currentCertificatePem,
      claimedDeviceId: deviceId,
    });
    const certificateRequest = await validateCertificateRequest(
      request.newCertificateRequestPem,
      deviceId,
    );

    return this.repository.transaction(async (transaction) => {
      const now = readClock(this.clock);
      const device = await transaction.getDevice(deviceId);
      const currentCertificate = await transaction.getCertificateBySerial(currentPeer.serialNumber);
      if (
        device === null ||
        device.status !== "active" ||
        currentCertificate === null ||
        currentCertificate.status !== "active" ||
        currentCertificate.generation !== device.identityGeneration ||
        currentCertificate.generation !== currentPeer.certificateGeneration ||
        now >= currentCertificate.notAfter
      ) {
        throw new DeviceIdentityError(
          "ROTATION_INVALID",
          "The current Device certificate cannot authorize rotation.",
        );
      }
      const certificates = await transaction.listDeviceCertificates(deviceId);
      const livePending = certificates.find(
        (certificate) =>
          certificate.status === "pending" &&
          certificate.activationExpiresAt !== undefined &&
          now < certificate.activationExpiresAt,
      );
      if (livePending !== undefined) {
        throw new DeviceIdentityError(
          "ROTATION_ALREADY_PENDING",
          "A Device certificate rotation is already awaiting proof.",
        );
      }
      for (const certificate of certificates) {
        if (
          certificate.status === "pending" &&
          (certificate.activationExpiresAt === undefined || now >= certificate.activationExpiresAt)
        ) {
          await transaction.saveCertificate({
            ...certificate,
            status: "retired",
            retiredAt: now,
          });
        }
      }

      const certificateAuthority = await transaction.getCertificateAuthority();
      if (certificateAuthority === null) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority record is unavailable.",
        );
      }
      const signingKey = await this.secrets.getPrivateKey(certificateAuthority.keyId);
      if (signingKey === null) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority signing key is unavailable.",
        );
      }
      let issuerCertificate: X509Certificate;
      try {
        issuerCertificate = new X509Certificate(certificateAuthority.certificatePem);
      } catch {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority public identity is invalid.",
        );
      }
      if (!(await isValidCertificateAuthority(certificateAuthority, issuerCertificate, now))) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority is unavailable for rotation.",
        );
      }
      const serialNumber = nextCertificateSerial(this.random);
      if ((await transaction.getCertificateBySerial(serialNumber)) !== null) {
        throw new DeviceIdentityError(
          "IDENTITY_REPOSITORY_CONFLICT",
          "The generated Device certificate serial already exists.",
        );
      }
      const generation = device.identityGeneration + 1;
      const notBefore = now - CLOCK_SKEW_MS;
      const notAfter = Math.min(
        safeTimestampAfter(now, DEVICE_CERTIFICATE_VALIDITY_MS),
        certificateAuthority.notAfter,
      );
      if (notAfter <= now) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority is no longer valid for issuance.",
        );
      }
      const certificate = await issueDeviceCertificate({
        certificateAuthority: issuerCertificate,
        certificateRequest,
        deviceId,
        notAfter,
        notBefore,
        serialNumber,
        signingKey,
      });
      if (
        !(await certificate.verify(
          { publicKey: issuerCertificate.publicKey, date: new Date(now) },
          identityWebCrypto,
        ))
      ) {
        throw new DeviceIdentityError(
          "CERTIFICATE_AUTHORITY_KEY_UNAVAILABLE",
          "The certificate authority signing key does not match its public identity.",
        );
      }
      const activationChallenge = base64Url(this.random.bytes(32));
      const activationExpiresAt = safeTimestampAfter(now, this.rotationActivationTtlMs);
      const publicKeySpkiSha256 = await publicKeyFingerprint(certificate.publicKey.rawData);
      const certificateNotBefore = certificate.notBefore.getTime();
      const certificateNotAfter = certificate.notAfter.getTime();
      const certificateRecord: PersistedDeviceCertificate = deepFreeze({
        deviceId,
        serialNumber,
        generation,
        certificatePem: certificate.toString("pem"),
        publicKeySpkiSha256,
        status: "pending" as const,
        notBefore: certificateNotBefore,
        notAfter: certificateNotAfter,
        issuedAt: now,
        activationChallengeDigest: await sha256Hex(new TextEncoder().encode(activationChallenge)),
        activationExpiresAt,
      });
      await transaction.saveCertificate(certificateRecord);
      await transaction.appendAuditRecord({
        auditId: nextAuditId(this.random),
        event: "device.rotation-issued",
        occurredAt: now,
        deviceId,
        certificateSerial: serialNumber,
        certificateGeneration: generation,
      });

      return deepFreeze({
        deviceId,
        certificatePem: certificateRecord.certificatePem,
        certificateAuthorityPem: certificateAuthority.certificatePem,
        serialNumber,
        publicKeySpkiSha256,
        generation,
        status: "pending" as const,
        issuedAt: now,
        notBefore: certificateNotBefore,
        notAfter: certificateNotAfter,
        activationChallenge,
        activationExpiresAt,
      });
    });
  }

  public async confirmCertificateRotation(
    request: ConfirmCertificateRotation,
  ): Promise<ConfirmedDeviceIdentity> {
    const deviceId = validateDeviceId(request.deviceId);
    const activationChallenge = validateActivationChallenge(request.activationChallenge);
    const signature = validateRotationSignature(request.signature);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(request.certificatePem);
    } catch {
      throw rotationInvalid();
    }
    if (
      readCertificateDeviceId(certificate) !== deviceId ||
      !hasDeviceCertificateProfile(certificate, deviceId)
    ) {
      throw rotationInvalid();
    }
    const certificateSerial = normalizeParsedCertificateSerial(certificate.serialNumber);
    if (certificateSerial === null) {
      throw rotationInvalid();
    }

    return this.repository.transaction(async (transaction) => {
      const now = readClock(this.clock);
      const certificateAuthority = await transaction.getCertificateAuthority();
      if (certificateAuthority === null) {
        throw rotationInvalid();
      }
      const issuer = new X509Certificate(certificateAuthority.certificatePem);
      if (!(await isValidCertificateAuthority(certificateAuthority, issuer, now))) {
        throw rotationInvalid();
      }
      let certificateSignatureValid: boolean;
      try {
        certificateSignatureValid = await certificate.verify(
          { publicKey: issuer.publicKey, date: new Date(now) },
          identityWebCrypto,
        );
      } catch {
        throw rotationInvalid();
      }
      const device = await transaction.getDevice(deviceId);
      const pending = await transaction.getCertificateBySerial(certificateSerial);
      if (
        !certificateSignatureValid ||
        certificate.issuer !== issuer.subject ||
        device === null ||
        device.status !== "active" ||
        pending === null ||
        pending.deviceId !== deviceId ||
        pending.status !== "pending" ||
        pending.generation !== device.identityGeneration + 1 ||
        pending.activationChallengeDigest === undefined ||
        pending.activationExpiresAt === undefined ||
        now >= pending.activationExpiresAt ||
        now < pending.notBefore ||
        now >= pending.notAfter ||
        !certificateBytesEqual(certificate, pending.certificatePem)
      ) {
        throw rotationInvalid();
      }
      const challengeDigest = await sha256Hex(new TextEncoder().encode(activationChallenge));
      if (!digestsEqual(pending.activationChallengeDigest, challengeDigest)) {
        throw rotationInvalid();
      }
      const publicKey = await certificate.publicKey.export(identityWebCrypto);
      const proofValid = await identityWebCrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        rotationProofPayload({
          activationChallenge,
          certificateSerial,
          deviceId,
        }),
      );
      if (!proofValid) {
        throw rotationInvalid();
      }
      const certificates = await transaction.listDeviceCertificates(deviceId);
      const previous = certificates.find(
        (candidate) =>
          candidate.generation === device.identityGeneration && candidate.status === "active",
      );
      if (previous === undefined || now >= previous.notAfter) {
        throw rotationInvalid();
      }
      const overlapEndsAt = Math.min(
        safeTimestampAfter(now, this.rotationOverlapMs),
        previous.notAfter,
      );
      if (overlapEndsAt <= now) {
        throw rotationInvalid();
      }

      await transaction.saveCertificate({
        ...previous,
        status: "overlap",
        overlapEndsAt,
      });
      await transaction.saveCertificate({
        ...pending,
        status: "active",
      });
      await transaction.saveDevice({
        ...device,
        identityGeneration: pending.generation,
      });
      await transaction.appendAuditRecord({
        auditId: nextAuditId(this.random),
        event: "device.rotation-confirmed",
        occurredAt: now,
        deviceId,
        certificateSerial: pending.serialNumber,
        certificateGeneration: pending.generation,
      });

      return deepFreeze({
        deviceId,
        certificatePem: pending.certificatePem,
        serialNumber: pending.serialNumber,
        publicKeySpkiSha256: pending.publicKeySpkiSha256,
        generation: pending.generation,
        status: "active" as const,
        overlapEndsAt,
      });
    });
  }

  public async revokeDevice(request: RevokeDevice): Promise<RevokedDeviceIdentity> {
    const deviceId = validateDeviceId(request.deviceId);
    return this.repository.transaction(async (transaction) => {
      const device = await transaction.getDevice(deviceId);
      if (device === null) {
        throw new DeviceIdentityError(
          "DEVICE_IDENTITY_NOT_FOUND",
          "The Device identity does not exist.",
        );
      }
      const certificates = await transaction.listDeviceCertificates(deviceId);
      const certificateSerials = Object.freeze(
        certificates.map((certificate) => certificate.serialNumber),
      );
      if (device.status === "revoked") {
        if (device.revokedAt === undefined) {
          throw new DeviceIdentityError(
            "IDENTITY_REPOSITORY_CONFLICT",
            "The revoked Device identity is missing its revocation time.",
          );
        }
        return deepFreeze({
          deviceId,
          status: "revoked" as const,
          revokedAt: device.revokedAt,
          certificateSerials,
        });
      }

      const now = readClock(this.clock);
      await transaction.saveDevice({
        ...device,
        status: "revoked",
        revokedAt: now,
      });
      for (const certificate of certificates) {
        await transaction.saveCertificate({
          ...certificate,
          status: "revoked",
          revokedAt: now,
        });
      }
      await transaction.appendAuditRecord({
        auditId: nextAuditId(this.random),
        event: "device.revoked",
        occurredAt: now,
        deviceId,
      });
      return deepFreeze({
        deviceId,
        status: "revoked" as const,
        revokedAt: now,
        certificateSerials,
      });
    });
  }

  public async validatePeerIdentity(
    request: ValidatePeerIdentity,
  ): Promise<AuthenticatedDevicePeer> {
    const claimedDeviceId = validateDeviceId(request.claimedDeviceId);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(request.certificatePem);
    } catch {
      throw peerCertificateError("PEER_CERTIFICATE_INVALID", "The peer certificate is malformed.");
    }
    const certificateSerial = normalizeParsedCertificateSerial(certificate.serialNumber);
    if (certificateSerial === null) {
      throw peerCertificateError(
        "PEER_CERTIFICATE_INVALID",
        "The peer certificate serial is invalid.",
      );
    }

    return this.repository.transaction(async (transaction) => {
      const now = readClock(this.clock);
      const certificateAuthority = await transaction.getCertificateAuthority();
      if (certificateAuthority === null) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate trust anchor is unavailable.",
        );
      }
      let issuer: X509Certificate;
      try {
        issuer = new X509Certificate(certificateAuthority.certificatePem);
      } catch {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate trust anchor is invalid.",
        );
      }
      if (!(await isValidCertificateAuthority(certificateAuthority, issuer, now))) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate trust anchor is invalid.",
        );
      }
      let signatureValid: boolean;
      try {
        signatureValid = await certificate.verify(
          {
            publicKey: issuer.publicKey,
            date: certificateSignatureVerificationDate(certificate),
          },
          identityWebCrypto,
        );
      } catch {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate signature is invalid.",
        );
      }
      const certificateDeviceId = readCertificateDeviceId(certificate);
      if (
        !signatureValid ||
        certificate.issuer !== issuer.subject ||
        !hasDeviceCertificateProfile(certificate, certificateDeviceId)
      ) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate does not match the Device certificate profile.",
        );
      }
      if (certificateDeviceId !== claimedDeviceId) {
        throw new DeviceIdentityError(
          "PEER_IDENTITY_MISMATCH",
          "The protocol sender Device ID does not match the authenticated peer.",
        );
      }
      if (now < certificate.notBefore.getTime()) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_NOT_YET_VALID",
          "The peer certificate is not yet valid.",
        );
      }
      if (now >= certificate.notAfter.getTime()) {
        throw peerCertificateError("PEER_CERTIFICATE_EXPIRED", "The peer certificate has expired.");
      }

      const device = await transaction.getDevice(certificateDeviceId);
      const persisted = await transaction.getCertificateBySerial(certificateSerial);
      if (device === null || persisted === null) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_UNKNOWN",
          "The peer certificate is not registered.",
        );
      }
      if (
        persisted.deviceId !== certificateDeviceId ||
        persisted.publicKeySpkiSha256 !==
          (await publicKeyFingerprint(certificate.publicKey.rawData)) ||
        !certificateBytesEqual(certificate, persisted.certificatePem) ||
        persisted.notBefore !== certificate.notBefore.getTime() ||
        persisted.notAfter !== certificate.notAfter.getTime()
      ) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_INVALID",
          "The peer certificate does not match its durable registration.",
        );
      }
      if (device.status === "revoked" || persisted.status === "revoked") {
        throw peerCertificateError(
          "PEER_CERTIFICATE_REVOKED",
          "The peer Device identity is revoked.",
        );
      }
      if (
        persisted.status === "pending" ||
        persisted.status === "retired" ||
        (persisted.status === "active" && persisted.generation !== device.identityGeneration)
      ) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_STALE",
          "The peer certificate generation is not active.",
        );
      }
      if (
        persisted.status === "overlap" &&
        (persisted.generation !== device.identityGeneration - 1 ||
          persisted.overlapEndsAt === undefined ||
          now >= persisted.overlapEndsAt)
      ) {
        throw peerCertificateError(
          "PEER_CERTIFICATE_STALE",
          "The peer certificate rotation overlap has ended.",
        );
      }

      return deepFreeze({
        deviceId: certificateDeviceId,
        serialNumber: persisted.serialNumber,
        certificateGeneration: persisted.generation,
        publicKeySpkiSha256: persisted.publicKeySpkiSha256,
      });
    });
  }
}

async function certificateSpkiFingerprint(certificate: X509Certificate): Promise<string> {
  return publicKeyFingerprint(certificate.publicKey.rawData);
}

async function issueDeviceCertificate(request: {
  readonly certificateAuthority: X509Certificate;
  readonly certificateRequest: Pkcs10CertificateRequest;
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly signingKey: CryptoKey;
}): Promise<X509Certificate> {
  return X509CertificateGenerator.create(
    {
      serialNumber: request.serialNumber,
      subject: request.certificateRequest.subject,
      issuer: request.certificateAuthority.subject,
      notBefore: new Date(request.notBefore),
      notAfter: new Date(request.notAfter),
      publicKey: request.certificateRequest.publicKey,
      signingKey: request.signingKey,
      signingAlgorithm: ECDSA_SHA256,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth], true),
        new SubjectAlternativeNameExtension(
          [{ type: "url", value: deviceUri(request.deviceId) }],
          false,
        ),
        await SubjectKeyIdentifierExtension.create(
          request.certificateRequest.publicKey,
          false,
          identityWebCrypto,
        ),
        await AuthorityKeyIdentifierExtension.create(
          request.certificateAuthority.publicKey,
          false,
          identityWebCrypto,
        ),
      ],
    },
    identityWebCrypto,
  );
}

function readClock(clock: IdentityClock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAXIMUM_DATE_TIMESTAMP_MS) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The identity clock must return a non-negative safe-integer timestamp.",
    );
  }
  return now;
}

function safeTimestampAfter(now: number, durationMs: number): number {
  const result = now + durationMs;
  if (!Number.isSafeInteger(result) || result > MAXIMUM_DATE_TIMESTAMP_MS) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The identity timestamp is outside the supported date range.",
    );
  }
  return result;
}

function validateRotationWindow(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_ROTATION_WINDOW_MS) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      `The ${label} must be a positive duration no longer than 30 minutes.`,
    );
  }
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      `${label} must be a trimmed value without control characters.`,
    );
  }
  return value;
}

function validateServerHostnames(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Main listener certificate hosts must contain between 1 and 16 entries.",
    );
  }
  const hostnames = values.map((value) => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 253 ||
      value !== value.trim() ||
      hasControlCharacter(value)
    ) {
      throw new DeviceIdentityError(
        "IDENTITY_CONFIGURATION_INVALID",
        "A Main listener certificate host is invalid.",
      );
    }
    if (isIP(value) !== 0) {
      return value;
    }
    const labels = value.split(".");
    if (
      labels.some(
        (label) =>
          label.length < 1 ||
          label.length > 63 ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label),
      )
    ) {
      throw new DeviceIdentityError(
        "IDENTITY_CONFIGURATION_INVALID",
        "A Main listener certificate host is invalid.",
      );
    }
    return value.toLowerCase();
  });
  if (new Set(hostnames).size !== hostnames.length) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Main listener certificate hosts must be unique.",
    );
  }
  return Object.freeze(hostnames);
}

function validateServerPublicKey(publicKey: CryptoKey): void {
  const algorithm = publicKey?.algorithm;
  if (
    publicKey?.type !== "public" ||
    algorithm?.name !== "ECDSA" ||
    !("namedCurve" in algorithm) ||
    algorithm.namedCurve !== "P-256"
  ) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The Main listener public key must be ECDSA P-256.",
    );
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
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

function validateGrantId(value: string): string {
  if (typeof value !== "string" || !/^grant_[A-Za-z0-9_-]{22}$/u.test(value)) {
    throw enrollmentGrantInvalid();
  }
  return value;
}

function validateEnrollmentToken(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw enrollmentGrantInvalid();
  }
  return value;
}

function validateActivationChallenge(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw rotationInvalid();
  }
  return value;
}

function validateRotationSignature(value: string): ArrayBuffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(value)) {
    throw rotationInvalid();
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (bytes.length !== 64) {
    throw rotationInvalid();
  }
  return bytes.buffer;
}

function validateBootstrapRoles(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 32) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Bootstrap roles must be an array with at most 32 entries.",
    );
  }
  const roles = values.map((value) => validateIdentifier(value, "Bootstrap role"));
  if (new Set(roles).size !== roles.length) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Bootstrap roles must be unique.",
    );
  }
  return Object.freeze([...roles]);
}

function validateGrantIntent(value: EnrollmentGrantIntent | undefined): EnrollmentGrantIntent {
  if (value === undefined || value === "enroll") {
    return "enroll";
  }
  if (value === "recredential") {
    return "recredential";
  }
  throw new DeviceIdentityError(
    "IDENTITY_CONFIGURATION_INVALID",
    "The Enrollment Grant intent must be 'enroll' or 'recredential'.",
  );
}

function validateProtocolRange(value: ProtocolCompatibilityRange): ProtocolCompatibilityRange {
  const minimum = validateProtocolVersion(value.minimum);
  const maximum = validateProtocolVersion(value.maximum);
  if (minimum > maximum) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Protocol range minimum cannot exceed its maximum.",
    );
  }
  return Object.freeze({ minimum, maximum });
}

function validateProtocolVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Protocol versions must be positive 16-bit integers.",
    );
  }
  return value;
}

function validateDiscovery(value: DeviceDiscoveryBootstrap): DeviceDiscoveryBootstrap {
  if (value.osFamily !== "linux" && value.osFamily !== "macos" && value.osFamily !== "windows") {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "Discovery OS family must be linux, macos, or windows.",
    );
  }
  return deepFreeze({
    osFamily: value.osFamily,
    architecture: validateIdentifier(value.architecture, "Architecture"),
    hostname: validateIdentifier(value.hostname, "Hostname"),
  });
}

async function validateCertificateRequest(
  value: string,
  deviceId: string,
): Promise<Pkcs10CertificateRequest> {
  let certificateRequest: Pkcs10CertificateRequest;
  try {
    certificateRequest = new Pkcs10CertificateRequest(value);
  } catch {
    throw certificateRequestInvalid();
  }
  let signatureValid: boolean;
  try {
    signatureValid = await certificateRequest.verify(identityWebCrypto);
  } catch {
    throw certificateRequestInvalid();
  }
  const algorithm = certificateRequest.publicKey.algorithm;
  const subjectAlternativeName = certificateRequest.getExtension(
    "2.5.29.17",
  ) as SubjectAlternativeNameExtension | null;
  const keyUsages = certificateRequest.getExtension("2.5.29.15") as KeyUsagesExtension | null;
  const names = subjectAlternativeName?.names.items.map((name) => name.toJSON());
  if (
    !signatureValid ||
    certificateRequest.subject !== `CN=${deviceId}` ||
    certificateRequest.signatureAlgorithm.name !== "ECDSA" ||
    certificateRequest.signatureAlgorithm.hash.name !== "SHA-256" ||
    algorithm.name !== "ECDSA" ||
    !("namedCurve" in algorithm) ||
    algorithm.namedCurve !== "P-256" ||
    keyUsages?.usages !== KeyUsageFlags.digitalSignature ||
    names?.length !== 1 ||
    names[0]?.type !== "url" ||
    names[0].value !== deviceUri(deviceId)
  ) {
    throw certificateRequestInvalid();
  }
  return certificateRequest;
}

function certificateRequestInvalid(): DeviceIdentityError {
  return new DeviceIdentityError(
    "CERTIFICATE_REQUEST_INVALID",
    "The Device certificate request is invalid.",
  );
}

function enrollmentGrantInvalid(): DeviceIdentityError {
  return new DeviceIdentityError(
    "ENROLLMENT_GRANT_INVALID",
    "The Enrollment Grant is invalid or no longer usable.",
  );
}

function rotationInvalid(): DeviceIdentityError {
  return new DeviceIdentityError(
    "ROTATION_INVALID",
    "The Device certificate rotation proof is invalid or expired.",
  );
}

function digestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function publicKeyFingerprint(value: BufferSource): Promise<string> {
  const digest = await identityWebCrypto.subtle.digest("SHA-256", value);
  return `sha256:${base64Url(new Uint8Array(digest))}`;
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await identityWebCrypto.subtle.digest("SHA-256", value);
  return Buffer.from(digest).toString("hex");
}

function nextAuditId(random: IdentityRandomSource): string {
  return `identity-audit_${base64Url(random.bytes(16))}`;
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

async function isValidCertificateAuthority(
  record: PublicCertificateAuthority,
  certificate: X509Certificate,
  now: number,
): Promise<boolean> {
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
    return false;
  }
  return (
    record.status === "active" &&
    record.notBefore === certificate.notBefore.getTime() &&
    record.notAfter === certificate.notAfter.getTime() &&
    record.spkiSha256 === (await certificateSpkiFingerprint(certificate)) &&
    selfSignatureValid &&
    certificate.subject === certificate.issuer &&
    certificate.signatureAlgorithm.name === "ECDSA" &&
    certificate.signatureAlgorithm.hash.name === "SHA-256" &&
    algorithm.name === "ECDSA" &&
    "namedCurve" in algorithm &&
    algorithm.namedCurve === "P-256" &&
    basicConstraints?.ca === true &&
    basicConstraints.pathLength === 0 &&
    keyUsages?.usages === (KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign) &&
    now >= certificate.notBefore.getTime() &&
    now < certificate.notAfter.getTime()
  );
}

function certificateSignatureVerificationDate(certificate: X509Certificate): Date {
  const notBefore = certificate.notBefore.getTime();
  const notAfter = certificate.notAfter.getTime();
  if (
    !Number.isSafeInteger(notBefore) ||
    !Number.isSafeInteger(notAfter) ||
    notAfter <= notBefore
  ) {
    return new Date(0);
  }
  return new Date(notBefore + Math.floor((notAfter - notBefore) / 2));
}

function readCertificateDeviceId(certificate: X509Certificate): string {
  const subjectAlternativeName = certificate.getExtension(SubjectAlternativeNameExtension);
  const names = subjectAlternativeName?.names.items.map((name) => name.toJSON());
  if (
    names?.length !== 1 ||
    names[0]?.type !== "url" ||
    !names[0].value.startsWith("urn:opendelegate:device:")
  ) {
    throw peerCertificateError(
      "PEER_CERTIFICATE_INVALID",
      "The peer certificate Device identity is invalid.",
    );
  }
  try {
    return validateDeviceId(names[0].value.slice("urn:opendelegate:device:".length));
  } catch {
    throw peerCertificateError(
      "PEER_CERTIFICATE_INVALID",
      "The peer certificate Device identity is invalid.",
    );
  }
}

function hasDeviceCertificateProfile(certificate: X509Certificate, deviceId: string): boolean {
  const algorithm = certificate.publicKey.algorithm;
  const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
  const keyUsages = certificate.getExtension(KeyUsagesExtension);
  const extendedKeyUsages = certificate.getExtension(ExtendedKeyUsageExtension);
  return (
    certificate.subject === `CN=${deviceId}` &&
    certificate.signatureAlgorithm.name === "ECDSA" &&
    certificate.signatureAlgorithm.hash.name === "SHA-256" &&
    algorithm.name === "ECDSA" &&
    "namedCurve" in algorithm &&
    algorithm.namedCurve === "P-256" &&
    basicConstraints?.ca === false &&
    keyUsages?.usages === KeyUsageFlags.digitalSignature &&
    extendedKeyUsages?.usages.length === 1 &&
    extendedKeyUsages.usages[0] === ExtendedKeyUsage.clientAuth
  );
}

function certificateBytesEqual(
  certificate: X509Certificate,
  persistedCertificatePem: string,
): boolean {
  let persisted: X509Certificate;
  try {
    persisted = new X509Certificate(persistedCertificatePem);
  } catch {
    return false;
  }
  const left = Buffer.from(certificate.rawData);
  const right = Buffer.from(persisted.rawData);
  return left.length === right.length && timingSafeEqual(left, right);
}

function peerCertificateError(
  code:
    | "PEER_CERTIFICATE_EXPIRED"
    | "PEER_CERTIFICATE_INVALID"
    | "PEER_CERTIFICATE_NOT_YET_VALID"
    | "PEER_CERTIFICATE_REVOKED"
    | "PEER_CERTIFICATE_STALE"
    | "PEER_CERTIFICATE_UNKNOWN",
  message: string,
): DeviceIdentityError {
  return new DeviceIdentityError(code, message);
}

function escapeDistinguishedName(value: string): string {
  return value.replace(/([,+"\\<>;=])/gu, "\\$1");
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function nextCertificateSerial(random: IdentityRandomSource): string {
  const bytes = random.bytes(16);
  if (bytes.byteLength !== 16 || bytes.every((value) => value === 0)) {
    throw new DeviceIdentityError(
      "IDENTITY_CONFIGURATION_INVALID",
      "The identity random source produced an invalid certificate serial.",
    );
  }
  return hex(bytes);
}

function normalizeParsedCertificateSerial(value: string): string | null {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{1,32}$/u.test(normalized)) {
    return null;
  }
  return normalized.padStart(32, "0");
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
