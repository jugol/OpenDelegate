import type {
  DeviceCertificateStatus,
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
  PublicCertificateAuthority,
} from "@opendelegate/device-identity/repository";
import { DeviceIdentityError } from "@opendelegate/device-identity/repository";
import type { Selectable, Transaction } from "kysely";

import {
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  parseSafeNonNegativeInteger,
} from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type {
  DeviceCertificateAuthorityTable,
  DeviceCertificatesTable,
  DeviceEnrollmentGrantsTable,
  DeviceIdentitiesTable,
  DeviceIdentityAuditTable,
  SqlStorageSchema,
} from "./schema.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

interface SqlDeviceIdentityRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteDeviceIdentityRepositoryOptions
  extends SqlDeviceIdentityRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresDeviceIdentityRepositoryOptions
  extends SqlDeviceIdentityRepositoryOptions, PostgresDialectOptions {}

export class SqlDeviceIdentityRepository implements DeviceIdentityRepository {
  private readonly context: SqlDatabaseContext;
  private readonly transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.context = context;
    this.transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
    );
  }

  public static async openSqlite(
    options: OpenSqliteDeviceIdentityRepositoryOptions,
  ): Promise<SqlDeviceIdentityRepository> {
    const context = await createSqliteDatabase(options);
    return this.open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresDeviceIdentityRepositoryOptions,
  ): Promise<SqlDeviceIdentityRepository> {
    const context = await createPostgresDatabase(options);
    return this.open(context, options);
  }

  public async transaction<TResult>(
    operation: (transaction: DeviceIdentityTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.transactionRunner.write((transaction) =>
      operation(new SqlDeviceIdentityTransaction(transaction)),
    );
  }

  public async snapshot(): Promise<DeviceIdentityRepositorySnapshot> {
    return this.transactionRunner.write((transaction) =>
      new SqlDeviceIdentityTransaction(transaction).snapshot(),
    );
  }

  public async close(): Promise<void> {
    await this.context.close();
  }

  private static async open(
    context: SqlDatabaseContext,
    options: SqlDeviceIdentityRepositoryOptions,
  ): Promise<SqlDeviceIdentityRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlDeviceIdentityRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

class SqlDeviceIdentityTransaction implements DeviceIdentityTransaction {
  private readonly transaction: Transaction<SqlStorageSchema>;

  public constructor(transaction: Transaction<SqlStorageSchema>) {
    this.transaction = transaction;
  }

  public async getCertificateAuthority(): Promise<PublicCertificateAuthority | null> {
    const row = await this.transaction
      .selectFrom("od_device_certificate_authority")
      .selectAll()
      .where("singleton_id", "=", 1)
      .executeTakeFirst();
    return row === undefined ? null : decodeCertificateAuthority(row);
  }

  public async setCertificateAuthority(
    certificateAuthority: PublicCertificateAuthority,
  ): Promise<void> {
    const values = encodeCertificateAuthority(certificateAuthority);
    if ((await this.getCertificateAuthority()) !== null) {
      throw repositoryConflict("The certificate authority record already exists.");
    }
    await this.transaction.insertInto("od_device_certificate_authority").values(values).execute();
  }

  public async getEnrollmentGrant(grantId: string): Promise<PersistedEnrollmentGrant | null> {
    assertGrantId(grantId, "write");
    const row = await this.transaction
      .selectFrom("od_device_enrollment_grants")
      .selectAll()
      .where("grant_id", "=", grantId)
      .executeTakeFirst();
    return row === undefined ? null : decodeEnrollmentGrant(row);
  }

  public async saveEnrollmentGrant(grant: PersistedEnrollmentGrant): Promise<void> {
    const values = encodeEnrollmentGrant(grant);
    const existing = await this.transaction
      .selectFrom("od_device_enrollment_grants")
      .selectAll()
      .where("grant_id", "=", grant.grantId)
      .executeTakeFirst();
    if (existing !== undefined) {
      assertEnrollmentGrantImmutableFields(decodeEnrollmentGrant(existing), grant);
    }
    await this.transaction
      .insertInto("od_device_enrollment_grants")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("grant_id").doUpdateSet({
          consumed_at_ms: values.consumed_at_ms,
          issued_certificate_serial: values.issued_certificate_serial,
          status: values.status,
        }),
      )
      .execute();
  }

  public async getDevice(deviceId: string): Promise<PersistedDeviceIdentity | null> {
    assertDeviceId(deviceId, "write");
    const row = await this.transaction
      .selectFrom("od_device_identities")
      .selectAll()
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    return row === undefined ? null : decodeDevice(row);
  }

  public async saveDevice(device: PersistedDeviceIdentity): Promise<void> {
    const values = encodeDevice(device);
    const existing = await this.transaction
      .selectFrom("od_device_identities")
      .selectAll()
      .where("device_id", "=", device.deviceId)
      .executeTakeFirst();
    if (existing !== undefined) {
      assertDeviceImmutableFields(decodeDevice(existing), device);
    }
    await this.transaction
      .insertInto("od_device_identities")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("device_id").doUpdateSet({
          identity_generation: values.identity_generation,
          revoked_at_ms: values.revoked_at_ms,
          status: values.status,
        }),
      )
      .execute();
  }

  public async getCertificateBySerial(
    serialNumber: string,
  ): Promise<PersistedDeviceCertificate | null> {
    assertCertificateSerial(serialNumber, "write");
    const row = await this.transaction
      .selectFrom("od_device_certificates")
      .selectAll()
      .where("serial_number", "=", serialNumber)
      .executeTakeFirst();
    return row === undefined ? null : decodeCertificate(row);
  }

  public async listDeviceCertificates(
    deviceId: string,
  ): Promise<readonly PersistedDeviceCertificate[]> {
    assertDeviceId(deviceId, "write");
    const rows = await this.transaction
      .selectFrom("od_device_certificates")
      .selectAll()
      .where("device_id", "=", deviceId)
      .orderBy("generation")
      .orderBy("issued_at_ms")
      .orderBy("serial_number")
      .execute();
    return Object.freeze(rows.map(decodeCertificate));
  }

  public async saveCertificate(certificate: PersistedDeviceCertificate): Promise<void> {
    const values = encodeCertificate(certificate);
    const existing = await this.transaction
      .selectFrom("od_device_certificates")
      .selectAll()
      .where("serial_number", "=", certificate.serialNumber)
      .executeTakeFirst();
    if (existing !== undefined) {
      assertCertificateImmutableFields(decodeCertificate(existing), certificate);
    }
    await this.transaction
      .insertInto("od_device_certificates")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("serial_number").doUpdateSet({
          overlap_ends_at_ms: values.overlap_ends_at_ms,
          retired_at_ms: values.retired_at_ms,
          revoked_at_ms: values.revoked_at_ms,
          status: values.status,
        }),
      )
      .execute();
  }

  public async appendAuditRecord(record: DeviceIdentityAuditRecord): Promise<void> {
    const values = encodeAuditRecord(record);
    const existing = await this.transaction
      .selectFrom("od_device_identity_audit")
      .select("audit_id")
      .where("audit_id", "=", record.auditId)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw repositoryConflict("The Device identity audit identifier already exists.");
    }
    await this.transaction.insertInto("od_device_identity_audit").values(values).execute();
  }

  public async listAuditRecords(): Promise<readonly DeviceIdentityAuditRecord[]> {
    const rows = await this.transaction
      .selectFrom("od_device_identity_audit")
      .selectAll()
      .orderBy("occurred_at_ms")
      .orderBy("audit_id")
      .execute();
    return Object.freeze(rows.map(decodeAuditRecord));
  }

  public async snapshot(): Promise<DeviceIdentityRepositorySnapshot> {
    const [certificateAuthority, enrollmentGrants, devices, certificates, auditRecords] =
      await Promise.all([
        this.getCertificateAuthority(),
        this.transaction
          .selectFrom("od_device_enrollment_grants")
          .selectAll()
          .orderBy("grant_id")
          .execute(),
        this.transaction
          .selectFrom("od_device_identities")
          .selectAll()
          .orderBy("device_id")
          .execute(),
        this.transaction
          .selectFrom("od_device_certificates")
          .selectAll()
          .orderBy("serial_number")
          .execute(),
        this.listAuditRecords(),
      ]);
    return deepFreeze({
      auditRecords,
      certificateAuthority,
      certificates: certificates.map(decodeCertificate),
      devices: devices.map(decodeDevice),
      enrollmentGrants: enrollmentGrants.map(decodeEnrollmentGrant),
    });
  }
}

function encodeCertificateAuthority(value: PublicCertificateAuthority): {
  readonly certificate_pem: string;
  readonly created_at_ms: number;
  readonly instance_id: string;
  readonly key_id: string;
  readonly not_after_ms: number;
  readonly not_before_ms: number;
  readonly singleton_id: number;
  readonly spki_sha256: string;
  readonly status: string;
} {
  validateCertificateAuthority(value, "write");
  return {
    certificate_pem: value.certificatePem,
    created_at_ms: value.createdAt,
    instance_id: value.instanceId,
    key_id: value.keyId,
    not_after_ms: value.notAfter,
    not_before_ms: value.notBefore,
    singleton_id: 1,
    spki_sha256: value.spkiSha256,
    status: value.status,
  };
}

function encodeEnrollmentGrant(value: PersistedEnrollmentGrant): {
  readonly allowed_bootstrap_roles_json: string;
  readonly consumed_at_ms: number | null;
  readonly created_at_ms: number;
  readonly device_id: string;
  readonly expires_at_ms: number;
  readonly grant_id: string;
  readonly intent: string;
  readonly issued_certificate_serial: string | null;
  readonly protocol_maximum: number;
  readonly protocol_minimum: number;
  readonly status: string;
  readonly token_digest: string;
} {
  validateEnrollmentGrant(value, "write");
  return {
    allowed_bootstrap_roles_json: encodeCanonicalJson(value.allowedBootstrapRoles),
    consumed_at_ms: value.consumedAt ?? null,
    created_at_ms: value.createdAt,
    device_id: value.deviceId,
    expires_at_ms: value.expiresAt,
    grant_id: value.grantId,
    intent: value.intent,
    issued_certificate_serial: value.issuedCertificateSerial ?? null,
    protocol_maximum: value.protocolRange.maximum,
    protocol_minimum: value.protocolRange.minimum,
    status: value.status,
    token_digest: value.tokenDigest,
  };
}

function encodeDevice(value: PersistedDeviceIdentity): {
  readonly allowed_bootstrap_roles_json: string;
  readonly architecture: string;
  readonly created_at_ms: number;
  readonly device_id: string;
  readonly hostname: string;
  readonly identity_generation: number;
  readonly os_family: string;
  readonly revoked_at_ms: number | null;
  readonly status: string;
} {
  validateDevice(value, "write");
  return {
    allowed_bootstrap_roles_json: encodeCanonicalJson(value.allowedBootstrapRoles),
    architecture: value.discovery.architecture,
    created_at_ms: value.createdAt,
    device_id: value.deviceId,
    hostname: value.discovery.hostname,
    identity_generation: value.identityGeneration,
    os_family: value.discovery.osFamily,
    revoked_at_ms: value.revokedAt ?? null,
    status: value.status,
  };
}

function encodeCertificate(value: PersistedDeviceCertificate): {
  readonly activation_challenge_digest: string | null;
  readonly activation_expires_at_ms: number | null;
  readonly certificate_pem: string;
  readonly device_id: string;
  readonly generation: number;
  readonly issued_at_ms: number;
  readonly not_after_ms: number;
  readonly not_before_ms: number;
  readonly overlap_ends_at_ms: number | null;
  readonly public_key_spki_sha256: string;
  readonly retired_at_ms: number | null;
  readonly revoked_at_ms: number | null;
  readonly serial_number: string;
  readonly status: string;
} {
  validateCertificate(value, "write");
  return {
    activation_challenge_digest: value.activationChallengeDigest ?? null,
    activation_expires_at_ms: value.activationExpiresAt ?? null,
    certificate_pem: value.certificatePem,
    device_id: value.deviceId,
    generation: value.generation,
    issued_at_ms: value.issuedAt,
    not_after_ms: value.notAfter,
    not_before_ms: value.notBefore,
    overlap_ends_at_ms: value.overlapEndsAt ?? null,
    public_key_spki_sha256: value.publicKeySpkiSha256,
    retired_at_ms: value.retiredAt ?? null,
    revoked_at_ms: value.revokedAt ?? null,
    serial_number: value.serialNumber,
    status: value.status,
  };
}

function encodeAuditRecord(value: DeviceIdentityAuditRecord): {
  readonly audit_id: string;
  readonly certificate_generation: number | null;
  readonly certificate_serial: string | null;
  readonly device_id: string;
  readonly event_name: string;
  readonly grant_id: string | null;
  readonly occurred_at_ms: number;
  readonly rejection_code: string | null;
} {
  validateAuditRecord(value, "write");
  return {
    audit_id: value.auditId,
    certificate_generation: value.certificateGeneration ?? null,
    certificate_serial: value.certificateSerial ?? null,
    device_id: value.deviceId,
    event_name: value.event,
    grant_id: value.grantId ?? null,
    occurred_at_ms: value.occurredAt,
    rejection_code: value.rejectionCode ?? null,
  };
}

function decodeCertificateAuthority(
  row: Selectable<DeviceCertificateAuthorityTable>,
): PublicCertificateAuthority {
  const value: PublicCertificateAuthority = {
    certificatePem: row.certificate_pem,
    createdAt: parseInstant(row.created_at_ms, "Certificate authority creation time"),
    instanceId: row.instance_id,
    keyId: row.key_id,
    notAfter: parseInstant(row.not_after_ms, "Certificate authority expiry"),
    notBefore: parseSignedSafeInteger(row.not_before_ms, "Certificate authority not-before time"),
    spkiSha256: row.spki_sha256,
    status: row.status as PublicCertificateAuthority["status"],
  };
  validateCertificateAuthority(value, "read");
  return deepFreeze(value);
}

function decodeEnrollmentGrant(
  row: Selectable<DeviceEnrollmentGrantsTable>,
): PersistedEnrollmentGrant {
  const consumedAt = parseOptionalInstant(row.consumed_at_ms, "Enrollment consumption time");
  const value: PersistedEnrollmentGrant = {
    allowedBootstrapRoles: decodeRoles(row.allowed_bootstrap_roles_json),
    createdAt: parseInstant(row.created_at_ms, "Enrollment Grant creation time"),
    deviceId: row.device_id,
    expiresAt: parseInstant(row.expires_at_ms, "Enrollment Grant expiry"),
    grantId: row.grant_id,
    intent: row.intent as EnrollmentGrantIntent,
    protocolRange: {
      maximum: parseProtocolVersion(row.protocol_maximum, "Protocol maximum"),
      minimum: parseProtocolVersion(row.protocol_minimum, "Protocol minimum"),
    },
    status: row.status as EnrollmentGrantStatus,
    tokenDigest: row.token_digest,
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(row.issued_certificate_serial === null
      ? {}
      : { issuedCertificateSerial: row.issued_certificate_serial }),
  };
  validateEnrollmentGrant(value, "read");
  return deepFreeze(value);
}

function decodeDevice(row: Selectable<DeviceIdentitiesTable>): PersistedDeviceIdentity {
  const revokedAt = parseOptionalInstant(row.revoked_at_ms, "Device revocation time");
  const value: PersistedDeviceIdentity = {
    allowedBootstrapRoles: decodeRoles(row.allowed_bootstrap_roles_json),
    createdAt: parseInstant(row.created_at_ms, "Device identity creation time"),
    deviceId: row.device_id,
    discovery: {
      architecture: row.architecture,
      hostname: row.hostname,
      osFamily: row.os_family as PersistedDeviceIdentity["discovery"]["osFamily"],
    },
    identityGeneration: parsePositiveInteger(row.identity_generation, "Device identity generation"),
    status: row.status as PersistedDeviceIdentityStatus,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
  validateDevice(value, "read");
  return deepFreeze(value);
}

function decodeCertificate(row: Selectable<DeviceCertificatesTable>): PersistedDeviceCertificate {
  const activationExpiresAt = parseOptionalInstant(
    row.activation_expires_at_ms,
    "Certificate activation expiry",
  );
  const overlapEndsAt = parseOptionalInstant(row.overlap_ends_at_ms, "Certificate overlap expiry");
  const retiredAt = parseOptionalInstant(row.retired_at_ms, "Certificate retirement time");
  const revokedAt = parseOptionalInstant(row.revoked_at_ms, "Certificate revocation time");
  const value: PersistedDeviceCertificate = {
    certificatePem: row.certificate_pem,
    deviceId: row.device_id,
    generation: parsePositiveInteger(row.generation, "Certificate generation"),
    issuedAt: parseInstant(row.issued_at_ms, "Certificate issue time"),
    notAfter: parseInstant(row.not_after_ms, "Certificate expiry"),
    notBefore: parseSignedSafeInteger(row.not_before_ms, "Certificate not-before time"),
    publicKeySpkiSha256: row.public_key_spki_sha256,
    serialNumber: row.serial_number,
    status: row.status as DeviceCertificateStatus,
    ...(row.activation_challenge_digest === null
      ? {}
      : { activationChallengeDigest: row.activation_challenge_digest }),
    ...(activationExpiresAt === undefined ? {} : { activationExpiresAt }),
    ...(overlapEndsAt === undefined ? {} : { overlapEndsAt }),
    ...(retiredAt === undefined ? {} : { retiredAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
  validateCertificate(value, "read");
  return deepFreeze(value);
}

function decodeAuditRecord(row: Selectable<DeviceIdentityAuditTable>): DeviceIdentityAuditRecord {
  const certificateGeneration =
    row.certificate_generation === null
      ? undefined
      : parsePositiveInteger(row.certificate_generation, "Audit certificate generation");
  const value: DeviceIdentityAuditRecord = {
    auditId: row.audit_id,
    deviceId: row.device_id,
    event: row.event_name as DeviceIdentityAuditEventName,
    occurredAt: parseInstant(row.occurred_at_ms, "Device identity audit time"),
    ...(row.certificate_serial === null ? {} : { certificateSerial: row.certificate_serial }),
    ...(certificateGeneration === undefined ? {} : { certificateGeneration }),
    ...(row.grant_id === null ? {} : { grantId: row.grant_id }),
    ...(row.rejection_code === null ? {} : { rejectionCode: row.rejection_code }),
  };
  validateAuditRecord(value, "read");
  return deepFreeze(value);
}

type ValidationSource = "read" | "write";

function validateCertificateAuthority(
  value: PublicCertificateAuthority,
  source: ValidationSource,
): void {
  assertIdentifier(value.instanceId, "Certificate authority Instance ID", source);
  assertIdentifier(value.keyId, "Certificate authority key ID", source, 200);
  assertCertificatePem(value.certificatePem, "Certificate authority certificate", source);
  assertSpkiFingerprint(value.spkiSha256, "Certificate authority SPKI fingerprint", source);
  assertEnum(value.status, ["active"], "Certificate authority status", source);
  assertInstant(value.createdAt, "Certificate authority creation time", source);
  assertSignedSafeInteger(value.notBefore, "Certificate authority not-before time", source);
  assertInstant(value.notAfter, "Certificate authority expiry", source);
  if (value.notBefore > value.createdAt || value.notAfter <= value.createdAt) {
    invalid(source, "Certificate authority validity metadata is inconsistent.");
  }
}

function validateEnrollmentGrant(value: PersistedEnrollmentGrant, source: ValidationSource): void {
  assertGrantId(value.grantId, source);
  assertHexDigest(value.tokenDigest, "Enrollment Grant token digest", source);
  assertDeviceId(value.deviceId, source);
  assertRoles(value.allowedBootstrapRoles, source);
  assertProtocolVersion(value.protocolRange.minimum, "Protocol minimum", source);
  assertProtocolVersion(value.protocolRange.maximum, "Protocol maximum", source);
  if (value.protocolRange.minimum > value.protocolRange.maximum) {
    invalid(source, "Enrollment Grant protocol range is inconsistent.");
  }
  assertEnum(
    value.status,
    ["active", "consumed", "expired", "revoked"],
    "Enrollment Grant status",
    source,
  );
  assertInstant(value.createdAt, "Enrollment Grant creation time", source);
  assertInstant(value.expiresAt, "Enrollment Grant expiry", source);
  if (value.expiresAt <= value.createdAt) {
    invalid(source, "Enrollment Grant expiry must follow its creation time.");
  }
  if (value.status === "consumed") {
    if (
      value.consumedAt === undefined ||
      value.issuedCertificateSerial === undefined ||
      value.consumedAt < value.createdAt ||
      value.consumedAt >= value.expiresAt
    ) {
      invalid(source, "Consumed Enrollment Grant metadata is incomplete.");
    }
    assertCertificateSerial(value.issuedCertificateSerial, source);
  } else if (value.consumedAt !== undefined || value.issuedCertificateSerial !== undefined) {
    invalid(source, "Only a consumed Enrollment Grant may reference an issued certificate.");
  }
}

function validateDevice(value: PersistedDeviceIdentity, source: ValidationSource): void {
  assertDeviceId(value.deviceId, source);
  assertEnum(value.status, ["active", "revoked"], "Device identity status", source);
  assertPositiveInteger(value.identityGeneration, "Device identity generation", source);
  assertRoles(value.allowedBootstrapRoles, source);
  assertEnum(
    value.discovery.osFamily,
    ["linux", "macos", "windows"],
    "Device discovery OS family",
    source,
  );
  assertIdentifier(value.discovery.architecture, "Device architecture", source);
  assertIdentifier(value.discovery.hostname, "Device hostname", source);
  assertInstant(value.createdAt, "Device identity creation time", source);
  if (value.status === "revoked") {
    if (value.revokedAt === undefined || value.revokedAt < value.createdAt) {
      invalid(source, "Revoked Device identity metadata is incomplete.");
    }
  } else if (value.revokedAt !== undefined) {
    invalid(source, "An active Device identity cannot have a revocation time.");
  }
}

function validateCertificate(value: PersistedDeviceCertificate, source: ValidationSource): void {
  assertDeviceId(value.deviceId, source);
  assertCertificateSerial(value.serialNumber, source);
  assertPositiveInteger(value.generation, "Certificate generation", source);
  assertCertificatePem(value.certificatePem, "Device certificate", source);
  assertSpkiFingerprint(value.publicKeySpkiSha256, "Device certificate SPKI fingerprint", source);
  assertEnum(
    value.status,
    ["active", "overlap", "pending", "retired", "revoked"],
    "Device certificate status",
    source,
  );
  assertSignedSafeInteger(value.notBefore, "Certificate not-before time", source);
  assertInstant(value.notAfter, "Certificate expiry", source);
  assertInstant(value.issuedAt, "Certificate issue time", source);
  if (value.notBefore > value.issuedAt || value.notAfter <= value.issuedAt) {
    invalid(source, "Device certificate validity metadata is inconsistent.");
  }
  if (
    (value.activationChallengeDigest === undefined) !==
    (value.activationExpiresAt === undefined)
  ) {
    invalid(source, "Certificate activation metadata must be stored as one complete pair.");
  }
  if (value.activationChallengeDigest !== undefined) {
    assertHexDigest(value.activationChallengeDigest, "Certificate activation digest", source);
    assertInstant(value.activationExpiresAt, "Certificate activation expiry", source);
    if ((value.activationExpiresAt ?? 0) <= value.issuedAt) {
      invalid(source, "Certificate activation expiry must follow issuance.");
    }
  }
  if (value.status === "pending" && value.activationChallengeDigest === undefined) {
    invalid(source, "A pending Device certificate requires activation metadata.");
  }
  validateOptionalStatusInstant(value.overlapEndsAt, "Certificate overlap expiry", value, source);
  validateOptionalStatusInstant(value.retiredAt, "Certificate retirement time", value, source);
  validateOptionalStatusInstant(value.revokedAt, "Certificate revocation time", value, source);
  if (value.status === "overlap" && (value.overlapEndsAt ?? 0) <= value.issuedAt) {
    invalid(source, "An overlapping Device certificate requires a future overlap expiry.");
  }
  if (value.status === "retired" && (value.retiredAt ?? -1) < value.issuedAt) {
    invalid(source, "A retired Device certificate requires a retirement time.");
  }
  if (value.status === "revoked" && (value.revokedAt ?? -1) < value.issuedAt) {
    invalid(source, "A revoked Device certificate requires a revocation time.");
  }
}

function validateAuditRecord(value: DeviceIdentityAuditRecord, source: ValidationSource): void {
  assertIdentifier(value.auditId, "Device identity audit ID", source, 200);
  assertEnum(
    value.event,
    [
      "device.enrolled",
      "device.enrollment-grant-issued",
      "device.enrollment-rejected",
      "device.recredentialed",
      "device.revoked",
      "device.rotation-confirmed",
      "device.rotation-issued",
    ],
    "Device identity audit event",
    source,
  );
  assertInstant(value.occurredAt, "Device identity audit time", source);
  assertDeviceId(value.deviceId, source);
  if (value.grantId !== undefined) {
    assertGrantId(value.grantId, source);
  }
  if (value.certificateSerial !== undefined) {
    assertCertificateSerial(value.certificateSerial, source);
  }
  if (value.certificateGeneration !== undefined) {
    assertPositiveInteger(value.certificateGeneration, "Audit certificate generation", source);
  }
  if (value.rejectionCode !== undefined) {
    assertIdentifier(value.rejectionCode, "Enrollment rejection code", source);
  }
  if (value.event === "device.enrollment-grant-issued" && value.grantId === undefined) {
    invalid(source, "Enrollment Grant issuance audit metadata is incomplete.");
  }
  if (
    value.event === "device.enrollment-rejected" &&
    (value.grantId === undefined || value.rejectionCode === undefined)
  ) {
    invalid(source, "Enrollment rejection audit metadata is incomplete.");
  }
  if (
    (value.event === "device.enrolled" || value.event === "device.recredentialed") &&
    (value.grantId === undefined ||
      value.certificateSerial === undefined ||
      value.certificateGeneration === undefined)
  ) {
    invalid(source, "Device enrollment audit metadata is incomplete.");
  }
  if (
    (value.event === "device.rotation-issued" || value.event === "device.rotation-confirmed") &&
    (value.certificateSerial === undefined || value.certificateGeneration === undefined)
  ) {
    invalid(source, "Device certificate rotation audit metadata is incomplete.");
  }
  const allowedOptionalFields: Readonly<
    Record<
      DeviceIdentityAuditEventName,
      ReadonlySet<"certificateGeneration" | "certificateSerial" | "grantId" | "rejectionCode">
    >
  > = {
    "device.enrolled": new Set(["certificateGeneration", "certificateSerial", "grantId"]),
    "device.enrollment-grant-issued": new Set(["grantId"]),
    "device.enrollment-rejected": new Set(["grantId", "rejectionCode"]),
    "device.recredentialed": new Set(["certificateGeneration", "certificateSerial", "grantId"]),
    "device.revoked": new Set(),
    "device.rotation-confirmed": new Set(["certificateGeneration", "certificateSerial"]),
    "device.rotation-issued": new Set(["certificateGeneration", "certificateSerial"]),
  };
  const presentFields = [
    ["certificateGeneration", value.certificateGeneration],
    ["certificateSerial", value.certificateSerial],
    ["grantId", value.grantId],
    ["rejectionCode", value.rejectionCode],
  ] as const;
  for (const [field, fieldValue] of presentFields) {
    if (fieldValue !== undefined && !allowedOptionalFields[value.event].has(field)) {
      invalid(source, `Device identity audit event ${value.event} contains unexpected metadata.`);
    }
  }
}

function assertEnrollmentGrantImmutableFields(
  existing: PersistedEnrollmentGrant,
  replacement: PersistedEnrollmentGrant,
): void {
  if (
    existing.tokenDigest !== replacement.tokenDigest ||
    existing.deviceId !== replacement.deviceId ||
    encodeCanonicalJson(existing.allowedBootstrapRoles) !==
      encodeCanonicalJson(replacement.allowedBootstrapRoles) ||
    existing.protocolRange.minimum !== replacement.protocolRange.minimum ||
    existing.protocolRange.maximum !== replacement.protocolRange.maximum ||
    existing.createdAt !== replacement.createdAt ||
    existing.expiresAt !== replacement.expiresAt
  ) {
    throw repositoryConflict("Immutable Enrollment Grant metadata cannot be replaced.");
  }
  const allowedTransitions: Readonly<
    Record<EnrollmentGrantStatus, readonly EnrollmentGrantStatus[]>
  > = {
    active: ["active", "consumed", "expired", "revoked"],
    consumed: ["consumed"],
    expired: ["expired"],
    revoked: ["revoked"],
  };
  if (!allowedTransitions[existing.status].includes(replacement.status)) {
    throw repositoryConflict("A terminal Enrollment Grant cannot become usable again.");
  }
  if (
    existing.status === "consumed" &&
    (existing.consumedAt !== replacement.consumedAt ||
      existing.issuedCertificateSerial !== replacement.issuedCertificateSerial)
  ) {
    throw repositoryConflict("A consumed Enrollment Grant outcome is immutable.");
  }
}

function assertDeviceImmutableFields(
  existing: PersistedDeviceIdentity,
  replacement: PersistedDeviceIdentity,
): void {
  if (
    existing.createdAt !== replacement.createdAt ||
    encodeCanonicalJson(existing.allowedBootstrapRoles) !==
      encodeCanonicalJson(replacement.allowedBootstrapRoles) ||
    encodeCanonicalJson(existing.discovery) !== encodeCanonicalJson(replacement.discovery)
  ) {
    throw repositoryConflict("Immutable Device identity metadata cannot be replaced.");
  }
  if (existing.status === "revoked") {
    if (
      replacement.status !== "revoked" ||
      replacement.identityGeneration !== existing.identityGeneration ||
      replacement.revokedAt !== existing.revokedAt
    ) {
      throw repositoryConflict("A revoked Device identity is terminal.");
    }
    return;
  }
  if (
    replacement.identityGeneration < existing.identityGeneration ||
    replacement.identityGeneration > existing.identityGeneration + 1 ||
    (replacement.status === "revoked" &&
      replacement.identityGeneration !== existing.identityGeneration)
  ) {
    throw repositoryConflict("Device identity generation cannot regress or skip a rotation.");
  }
}

function assertCertificateImmutableFields(
  existing: PersistedDeviceCertificate,
  replacement: PersistedDeviceCertificate,
): void {
  if (
    existing.deviceId !== replacement.deviceId ||
    existing.generation !== replacement.generation ||
    existing.certificatePem !== replacement.certificatePem ||
    existing.publicKeySpkiSha256 !== replacement.publicKeySpkiSha256 ||
    existing.notBefore !== replacement.notBefore ||
    existing.notAfter !== replacement.notAfter ||
    existing.issuedAt !== replacement.issuedAt ||
    existing.activationChallengeDigest !== replacement.activationChallengeDigest ||
    existing.activationExpiresAt !== replacement.activationExpiresAt
  ) {
    throw repositoryConflict("Immutable Device certificate metadata cannot be replaced.");
  }
  const allowedTransitions: Readonly<
    Record<DeviceCertificateStatus, readonly DeviceCertificateStatus[]>
  > = {
    active: ["active", "overlap", "revoked"],
    overlap: ["overlap", "revoked"],
    pending: ["pending", "active", "retired", "revoked"],
    retired: ["retired", "revoked"],
    revoked: ["revoked"],
  };
  if (!allowedTransitions[existing.status].includes(replacement.status)) {
    throw repositoryConflict("A Device certificate lifecycle cannot regress.");
  }
  if (
    (existing.overlapEndsAt !== undefined &&
      existing.overlapEndsAt !== replacement.overlapEndsAt) ||
    (existing.retiredAt !== undefined && existing.retiredAt !== replacement.retiredAt) ||
    (existing.revokedAt !== undefined && existing.revokedAt !== replacement.revokedAt)
  ) {
    throw repositoryConflict("A Device certificate lifecycle outcome is immutable.");
  }
}

function decodeRoles(value: string): readonly string[] {
  const decoded = decodeCanonicalJson(value);
  if (!Array.isArray(decoded)) {
    throw new SqlStorageError("DATA_CORRUPT", "Stored bootstrap roles are not an array.");
  }
  assertRoles(decoded, "read");
  return Object.freeze([...decoded]);
}

function assertRoles(value: unknown, source: ValidationSource): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    invalid(source, "Bootstrap roles must be an array with at most 32 entries.");
  }
  const seen = new Set<string>();
  for (const role of value) {
    if (typeof role !== "string") {
      invalid(source, "Every bootstrap role must be a string.");
    }
    assertIdentifier(role, "Bootstrap role", source);
    if (seen.has(role)) {
      invalid(source, "Bootstrap roles must be unique.");
    }
    seen.add(role);
  }
}

function assertCertificatePem(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 65_536 ||
    !value.startsWith("-----BEGIN CERTIFICATE-----\n") ||
    !value.trimEnd().endsWith("-----END CERTIFICATE-----") ||
    value.includes("PRIVATE KEY")
  ) {
    invalid(source, `${label} is not a bounded public PEM certificate.`);
  }
}

function assertSpkiFingerprint(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(value)) {
    invalid(source, `${label} is invalid.`);
  }
}

function assertHexDigest(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    invalid(source, `${label} must be a SHA-256 hex digest.`);
  }
}

function assertDeviceId(value: unknown, source: ValidationSource): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    invalid(source, "Device ID is outside the durable identity contract.");
  }
}

function assertGrantId(value: unknown, source: ValidationSource): asserts value is string {
  if (typeof value !== "string" || !/^grant_[A-Za-z0-9_-]{22}$/u.test(value)) {
    invalid(source, "Enrollment Grant ID is outside the durable identity contract.");
  }
}

function assertCertificateSerial(
  value: unknown,
  source: ValidationSource,
): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
    invalid(source, "Device certificate serial is outside the durable identity contract.");
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
  source: ValidationSource,
  maximumLength = 128,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    invalid(source, `${label} must be a bounded, trimmed value without control characters.`);
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

function assertEnum<TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
  source: ValidationSource,
): asserts value is TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    invalid(source, `${label} is unknown.`);
  }
}

function assertInstant(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(source, `${label} is outside the supported safe integer range.`);
  }
}

function assertSignedSafeInteger(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalid(source, `${label} is outside the supported safe integer range.`);
  }
}

function assertPositiveInteger(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is number {
  assertInstant(value, label, source);
  if (value === 0) {
    invalid(source, `${label} must be greater than zero.`);
  }
}

function assertProtocolVersion(
  value: unknown,
  label: string,
  source: ValidationSource,
): asserts value is number {
  assertPositiveInteger(value, label, source);
  if (value > 65_535) {
    invalid(source, `${label} must fit in an unsigned 16-bit integer.`);
  }
}

function validateOptionalStatusInstant(
  value: number | undefined,
  label: string,
  certificate: PersistedDeviceCertificate,
  source: ValidationSource,
): void {
  if (value === undefined) {
    return;
  }
  assertInstant(value, label, source);
  if (value < certificate.issuedAt) {
    invalid(source, `${label} cannot precede certificate issuance.`);
  }
}

function parseInstant(value: number | string | bigint, label: string): number {
  return parseSafeNonNegativeInteger(value, label);
}

function parseSignedSafeInteger(value: number | string | bigint, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new SqlStorageError(
      "DATA_CORRUPT",
      `${label} is outside the supported safe integer range.`,
    );
  }
  return parsed;
}

function parsePositiveInteger(value: number | string | bigint, label: string): number {
  const parsed = parseSafeNonNegativeInteger(value, label);
  if (parsed === 0) {
    throw new SqlStorageError("DATA_CORRUPT", `${label} must be greater than zero.`);
  }
  return parsed;
}

function parseProtocolVersion(value: number | string | bigint, label: string): number {
  const parsed = parsePositiveInteger(value, label);
  if (parsed > 65_535) {
    throw new SqlStorageError("DATA_CORRUPT", `${label} exceeds the protocol range.`);
  }
  return parsed;
}

function parseOptionalInstant(
  value: number | string | bigint | null,
  label: string,
): number | undefined {
  return value === null ? undefined : parseInstant(value, label);
}

function repositoryConflict(message: string): DeviceIdentityError {
  return new DeviceIdentityError("IDENTITY_REPOSITORY_CONFLICT", message);
}

function invalid(source: ValidationSource, message: string): never {
  throw new SqlStorageError(
    source === "read" ? "DATA_CORRUPT" : "STORAGE_CONFIGURATION_INVALID",
    message,
  );
}
