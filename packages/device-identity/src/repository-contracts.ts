export interface PublicCertificateAuthority {
  readonly instanceId: string;
  readonly keyId: string;
  readonly certificatePem: string;
  readonly spkiSha256: string;
  readonly status: "active";
  readonly createdAt: number;
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface ProtocolCompatibilityRange {
  readonly minimum: number;
  readonly maximum: number;
}

export type EnrollmentGrantStatus = "active" | "consumed" | "expired" | "revoked";

export interface PersistedEnrollmentGrant {
  readonly grantId: string;
  readonly tokenDigest: string;
  readonly deviceId: string;
  readonly allowedBootstrapRoles: readonly string[];
  readonly protocolRange: ProtocolCompatibilityRange;
  readonly status: EnrollmentGrantStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt?: number;
  readonly issuedCertificateSerial?: string;
}

export interface DeviceDiscoveryBootstrap {
  readonly osFamily: "linux" | "macos" | "windows";
  readonly architecture: string;
  readonly hostname: string;
}

export type PersistedDeviceIdentityStatus = "active" | "revoked";

export interface PersistedDeviceIdentity {
  readonly deviceId: string;
  readonly status: PersistedDeviceIdentityStatus;
  readonly identityGeneration: number;
  readonly allowedBootstrapRoles: readonly string[];
  readonly discovery: DeviceDiscoveryBootstrap;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export type DeviceCertificateStatus = "active" | "overlap" | "pending" | "retired" | "revoked";

export interface PersistedDeviceCertificate {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly generation: number;
  readonly certificatePem: string;
  readonly publicKeySpkiSha256: string;
  readonly status: DeviceCertificateStatus;
  readonly notBefore: number;
  readonly notAfter: number;
  readonly issuedAt: number;
  readonly activationChallengeDigest?: string;
  readonly activationExpiresAt?: number;
  readonly overlapEndsAt?: number;
  readonly retiredAt?: number;
  readonly revokedAt?: number;
}

export type DeviceIdentityAuditEventName =
  | "device.enrolled"
  | "device.enrollment-grant-issued"
  | "device.enrollment-rejected"
  | "device.revoked"
  | "device.rotation-confirmed"
  | "device.rotation-issued";

export interface DeviceIdentityAuditRecord {
  readonly auditId: string;
  readonly event: DeviceIdentityAuditEventName;
  readonly occurredAt: number;
  readonly deviceId: string;
  readonly grantId?: string;
  readonly certificateSerial?: string;
  readonly certificateGeneration?: number;
  readonly rejectionCode?: string;
}

export interface DeviceIdentityTransaction {
  getCertificateAuthority(): Promise<PublicCertificateAuthority | null>;
  setCertificateAuthority(certificateAuthority: PublicCertificateAuthority): Promise<void>;
  getEnrollmentGrant(grantId: string): Promise<PersistedEnrollmentGrant | null>;
  saveEnrollmentGrant(grant: PersistedEnrollmentGrant): Promise<void>;
  getDevice(deviceId: string): Promise<PersistedDeviceIdentity | null>;
  saveDevice(device: PersistedDeviceIdentity): Promise<void>;
  getCertificateBySerial(serialNumber: string): Promise<PersistedDeviceCertificate | null>;
  listDeviceCertificates(deviceId: string): Promise<readonly PersistedDeviceCertificate[]>;
  saveCertificate(certificate: PersistedDeviceCertificate): Promise<void>;
  appendAuditRecord(record: DeviceIdentityAuditRecord): Promise<void>;
  listAuditRecords(): Promise<readonly DeviceIdentityAuditRecord[]>;
}

export interface DeviceIdentityRepository {
  transaction<TResult>(
    operation: (transaction: DeviceIdentityTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface DeviceIdentityRepositorySnapshot {
  readonly certificateAuthority: PublicCertificateAuthority | null;
  readonly enrollmentGrants: readonly PersistedEnrollmentGrant[];
  readonly devices: readonly PersistedDeviceIdentity[];
  readonly certificates: readonly PersistedDeviceCertificate[];
  readonly auditRecords: readonly DeviceIdentityAuditRecord[];
}
