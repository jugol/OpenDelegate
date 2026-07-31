export interface IdentityClock {
  now(): number;
}

export type {
  DeviceCertificateStatus,
  DeviceDiscoveryBootstrap,
  DeviceIdentityAuditEventName,
  DeviceIdentityAuditRecord,
  DeviceIdentityRepository,
  DeviceIdentityRepositorySnapshot,
  DeviceIdentityTransaction,
  EnrollmentGrantIntent,
  EnrollmentGrantStatus,
  PersistedDeviceCertificate,
  PersistedDeviceIdentity,
  PersistedDeviceIdentityStatus,
  PersistedEnrollmentGrant,
  ProtocolCompatibilityRange,
  PublicCertificateAuthority,
} from "./repository-contracts.ts";

export interface DeviceIdentitySecretStore {
  createP256KeyPair(keyId: string): Promise<CryptoKeyPair>;
  getPrivateKey(keyId: string): Promise<CryptoKey | null>;
  signP256(keyId: string, value: BufferSource): Promise<Uint8Array>;
  has(keyId: string): Promise<boolean>;
}

export interface IdentityRandomSource {
  bytes(length: number): Uint8Array;
}
