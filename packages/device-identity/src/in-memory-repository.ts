import type {
  DeviceIdentityAuditRecord,
  DeviceIdentityRepository,
  DeviceIdentityRepositorySnapshot,
  DeviceIdentityTransaction,
  PersistedDeviceCertificate,
  PersistedDeviceIdentity,
  PersistedEnrollmentGrant,
  PublicCertificateAuthority,
} from "./contracts.ts";
import { DeviceIdentityError } from "./error.ts";

interface MutableState {
  certificateAuthority: PublicCertificateAuthority | null;
  enrollmentGrants: Map<string, PersistedEnrollmentGrant>;
  devices: Map<string, PersistedDeviceIdentity>;
  certificates: Map<string, PersistedDeviceCertificate>;
  auditRecords: Map<string, DeviceIdentityAuditRecord>;
}

export class InMemoryDeviceIdentityRepository implements DeviceIdentityRepository {
  private state: MutableState;
  private transactionTail: Promise<void> = Promise.resolve();

  public constructor(snapshot?: DeviceIdentityRepositorySnapshot) {
    this.state = {
      certificateAuthority: clone(snapshot?.certificateAuthority ?? null),
      enrollmentGrants: toMap(snapshot?.enrollmentGrants ?? [], "grantId"),
      devices: toMap(snapshot?.devices ?? [], "deviceId"),
      certificates: toMap(snapshot?.certificates ?? [], "serialNumber"),
      auditRecords: toMap(snapshot?.auditRecords ?? [], "auditId"),
    };
  }

  public async transaction<TResult>(
    operation: (transaction: DeviceIdentityTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.transactionTail;
    let release = (): void => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const working: MutableState = {
      certificateAuthority: clone(this.state.certificateAuthority),
      enrollmentGrants: cloneMap(this.state.enrollmentGrants),
      devices: cloneMap(this.state.devices),
      certificates: cloneMap(this.state.certificates),
      auditRecords: cloneMap(this.state.auditRecords),
    };
    try {
      const result = await operation(new InMemoryDeviceIdentityTransaction(working));
      this.state = working;
      return result;
    } finally {
      release();
    }
  }

  public async snapshot(): Promise<DeviceIdentityRepositorySnapshot> {
    return this.transaction(async (transaction) =>
      deepFreeze({
        certificateAuthority: await transaction.getCertificateAuthority(),
        enrollmentGrants: sortBy(this.state.enrollmentGrants.values(), "grantId"),
        devices: sortBy(this.state.devices.values(), "deviceId"),
        certificates: sortBy(this.state.certificates.values(), "serialNumber"),
        auditRecords: await transaction.listAuditRecords(),
      }),
    );
  }
}

class InMemoryDeviceIdentityTransaction implements DeviceIdentityTransaction {
  private readonly state: MutableState;

  public constructor(state: MutableState) {
    this.state = state;
  }

  public async getCertificateAuthority(): Promise<PublicCertificateAuthority | null> {
    return clone(this.state.certificateAuthority);
  }

  public async setCertificateAuthority(
    certificateAuthority: PublicCertificateAuthority,
  ): Promise<void> {
    if (this.state.certificateAuthority !== null) {
      throw new DeviceIdentityError(
        "IDENTITY_REPOSITORY_CONFLICT",
        "The certificate authority record already exists.",
      );
    }
    this.state.certificateAuthority = clone(certificateAuthority);
  }

  public async getEnrollmentGrant(grantId: string): Promise<PersistedEnrollmentGrant | null> {
    return clone(this.state.enrollmentGrants.get(grantId) ?? null);
  }

  public async saveEnrollmentGrant(grant: PersistedEnrollmentGrant): Promise<void> {
    this.state.enrollmentGrants.set(grant.grantId, clone(grant));
  }

  public async getDevice(deviceId: string): Promise<PersistedDeviceIdentity | null> {
    return clone(this.state.devices.get(deviceId) ?? null);
  }

  public async saveDevice(device: PersistedDeviceIdentity): Promise<void> {
    this.state.devices.set(device.deviceId, clone(device));
  }

  public async getCertificateBySerial(
    serialNumber: string,
  ): Promise<PersistedDeviceCertificate | null> {
    return clone(this.state.certificates.get(serialNumber) ?? null);
  }

  public async listDeviceCertificates(
    deviceId: string,
  ): Promise<readonly PersistedDeviceCertificate[]> {
    return sortBy(
      [...this.state.certificates.values()].filter(
        (certificate) => certificate.deviceId === deviceId,
      ),
      "generation",
    );
  }

  public async saveCertificate(certificate: PersistedDeviceCertificate): Promise<void> {
    this.state.certificates.set(certificate.serialNumber, clone(certificate));
  }

  public async appendAuditRecord(record: DeviceIdentityAuditRecord): Promise<void> {
    if (this.state.auditRecords.has(record.auditId)) {
      throw new DeviceIdentityError(
        "IDENTITY_REPOSITORY_CONFLICT",
        "The Device identity audit identifier already exists.",
      );
    }
    this.state.auditRecords.set(record.auditId, clone(record));
  }

  public async listAuditRecords(): Promise<readonly DeviceIdentityAuditRecord[]> {
    return Object.freeze(
      [...this.state.auditRecords.values()].map((record) => deepFreeze(clone(record))),
    );
  }
}

function clone<TValue>(value: TValue): TValue {
  return value === null ? value : structuredClone(value);
}

function cloneMap<TKey, TValue>(source: ReadonlyMap<TKey, TValue>): Map<TKey, TValue> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function toMap<TRecord>(records: readonly TRecord[], key: keyof TRecord): Map<string, TRecord> {
  const result = new Map<string, TRecord>();
  for (const record of records) {
    const identifier = String(record[key]);
    if (result.has(identifier)) {
      throw new DeviceIdentityError(
        "IDENTITY_REPOSITORY_CONFLICT",
        "The Device identity snapshot contains duplicate identifiers.",
      );
    }
    result.set(identifier, clone(record));
  }
  return result;
}

function sortBy<TRecord>(records: Iterable<TRecord>, key: keyof TRecord): readonly TRecord[] {
  return Object.freeze(
    [...records]
      .map((record) => deepFreeze(clone(record)))
      .sort((left, right) => {
        const leftValue = left[key];
        const rightValue = right[key];
        if (typeof leftValue === "number" && typeof rightValue === "number") {
          return leftValue - rightValue;
        }
        return String(leftValue).localeCompare(String(rightValue));
      }),
  );
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
