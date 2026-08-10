import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

import {
  DeviceIdentityError,
  type DeviceIdentityAuditRecord,
  type DeviceIdentityRepositorySnapshot,
  type PersistedDeviceCertificate,
  type PersistedDeviceIdentity,
  type PersistedEnrollmentGrant,
  type PublicCertificateAuthority,
} from "@opendelegate/device-identity/repository";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlDeviceIdentityRepository, type SqlMigrationMode } from "../src/index.ts";

interface DeviceIdentityFixture {
  readonly filename?: string;
  open(mode: SqlMigrationMode): Promise<SqlDeviceIdentityRepository>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<DeviceIdentityFixture>;

function registerDeviceIdentityRepositoryContract(
  label: string,
  createFixture: FixtureFactory,
): void {
  describe(`${label} Device identity repository contract`, () => {
    test("persists public CA metadata and grant digests across restart", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await repository.transaction(async (transaction) => {
          await transaction.setCertificateAuthority(CERTIFICATE_AUTHORITY);
          await transaction.saveEnrollmentGrant(ACTIVE_GRANT);
          await transaction.appendAuditRecord(GRANT_ISSUED_AUDIT);
        });
        const beforeRestart = await repository.snapshot();

        await repository.close();
        repository = await fixture.open("verify");

        assert.deepEqual(await repository.snapshot(), beforeRestart);
        assert.deepEqual(beforeRestart.certificateAuthority, CERTIFICATE_AUTHORITY);
        assert.equal(beforeRestart.enrollmentGrants[0]?.tokenDigest, ACTIVE_GRANT.tokenDigest);
        assert.deepEqual(beforeRestart.auditRecords, [GRANT_ISSUED_AUDIT]);
        assert.equal(JSON.stringify(beforeRestart).includes(RAW_ENROLLMENT_SECRET), false);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("persists enrollment, certificate rotation, and revocation atomically across restarts", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await seedGrant(repository);
        await enrollDevice(repository, CERTIFICATE_GENERATION_1, ENROLLED_AUDIT);

        await repository.close();
        repository = await fixture.open("verify");
        assertEnrollmentSnapshot(await repository.snapshot());

        await repository.transaction(async (transaction) => {
          const device = await transaction.getDevice(DEVICE_ID);
          assert.notEqual(device, null);
          await transaction.saveCertificate(CERTIFICATE_GENERATION_2_PENDING);
          await transaction.appendAuditRecord(ROTATION_ISSUED_AUDIT);
        });

        await repository.close();
        repository = await fixture.open("verify");
        assert.deepEqual(
          (await repository.snapshot()).certificates.map(({ generation, status }) => ({
            generation,
            status,
          })),
          [
            { generation: 1, status: "active" },
            { generation: 2, status: "pending" },
          ],
        );

        await repository.transaction(async (transaction) => {
          await transaction.saveCertificate(CERTIFICATE_GENERATION_1_OVERLAP);
          await transaction.saveCertificate(CERTIFICATE_GENERATION_2_ACTIVE);
          await transaction.saveDevice(DEVICE_GENERATION_2);
          await transaction.appendAuditRecord(ROTATION_CONFIRMED_AUDIT);
        });

        await repository.close();
        repository = await fixture.open("verify");
        assert.equal((await repository.snapshot()).devices[0]?.identityGeneration, 2);

        await repository.transaction(async (transaction) => {
          await transaction.saveCertificate(CERTIFICATE_GENERATION_1_REVOKED);
          await transaction.saveCertificate(CERTIFICATE_GENERATION_2_REVOKED);
          await transaction.saveDevice(DEVICE_REVOKED);
          await transaction.appendAuditRecord(REVOKED_AUDIT);
        });

        await repository.close();
        repository = await fixture.open("verify");
        const revoked = await repository.snapshot();
        assert.equal(revoked.devices[0]?.status, "revoked");
        assert.deepEqual(
          revoked.certificates.map(({ generation, status }) => ({ generation, status })),
          [
            { generation: 1, status: "revoked" },
            { generation: 2, status: "revoked" },
          ],
        );
        assert.deepEqual(
          revoked.auditRecords.map((record) => record.event),
          [
            "device.enrollment-grant-issued",
            "device.enrolled",
            "device.rotation-issued",
            "device.rotation-confirmed",
            "device.revoked",
          ],
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("serializes concurrent single-use enrollment across independent repository instances", async () => {
      const fixture = await createFixture();
      const first = await fixture.open("apply");
      let second: SqlDeviceIdentityRepository | undefined;

      try {
        await seedGrant(first);
        second = await fixture.open("verify");
        const results = await Promise.all([
          consumeEnrollment(first, CERTIFICATE_GENERATION_1, ENROLLED_AUDIT),
          consumeEnrollment(
            second,
            {
              ...CERTIFICATE_GENERATION_1,
              certificatePem: publicCertificatePem("concurrent-loser"),
              publicKeySpkiSha256: fingerprint("C"),
              serialNumber: certificateSerial("0c"),
            },
            {
              ...ENROLLED_AUDIT,
              auditId: "identity-audit_concurrent-second",
              certificateSerial: certificateSerial("0c"),
            },
          ),
        ]);

        assert.equal(results.filter(Boolean).length, 1);
        const snapshot = await first.snapshot();
        assert.equal(snapshot.devices.length, 1);
        assert.equal(snapshot.certificates.length, 1);
        assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
        assert.equal(
          snapshot.auditRecords.filter((record) => record.event === "device.enrolled").length,
          1,
        );
        assert.equal(
          snapshot.auditRecords.filter((record) => record.event === "device.enrollment-rejected")
            .length,
          1,
        );
      } finally {
        await Promise.all([first.close(), second?.close()]);
        await fixture.cleanup();
      }
    });

    test("rolls back identity state when its append-only audit write conflicts", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await assert.rejects(
          repository.transaction(async (transaction) => {
            await transaction.saveEnrollmentGrant(ACTIVE_GRANT);
            await transaction.appendAuditRecord(GRANT_ISSUED_AUDIT);
            await transaction.appendAuditRecord(GRANT_ISSUED_AUDIT);
          }),
          (error: unknown) =>
            error instanceof DeviceIdentityError && error.code === "IDENTITY_REPOSITORY_CONFLICT",
        );
        assert.deepEqual(await repository.snapshot(), emptySnapshot());
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("preserves immutable grant identity and transaction semantics after restart", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await repository.transaction((transaction) =>
          transaction.saveEnrollmentGrant(ACTIVE_GRANT),
        );
        await repository.close();
        repository = await fixture.open("verify");

        await assert.rejects(
          repository.transaction((transaction) =>
            transaction.saveEnrollmentGrant({
              ...ACTIVE_GRANT,
              tokenDigest: "f".repeat(64),
            }),
          ),
          (error: unknown) =>
            error instanceof DeviceIdentityError && error.code === "IDENTITY_REPOSITORY_CONFLICT",
        );
        assert.deepEqual((await repository.snapshot()).enrollmentGrants, [ACTIVE_GRANT]);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects single-use, Device, and certificate lifecycle regression after restart", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await seedGrant(repository);
        await enrollDevice(repository, CERTIFICATE_GENERATION_1, ENROLLED_AUDIT);
        await repository.transaction(async (transaction) => {
          await transaction.saveCertificate({
            ...CERTIFICATE_GENERATION_1,
            revokedAt: NOW + 4_000,
            status: "revoked",
          });
          await transaction.saveDevice({
            ...DEVICE_GENERATION_1,
            revokedAt: NOW + 4_000,
            status: "revoked",
          });
          await transaction.appendAuditRecord(REVOKED_AUDIT);
        });
        await repository.close();
        repository = await fixture.open("verify");

        for (const attempt of [
          () =>
            repository?.transaction((transaction) => transaction.saveEnrollmentGrant(ACTIVE_GRANT)),
          () =>
            repository?.transaction((transaction) => transaction.saveDevice(DEVICE_GENERATION_1)),
          () =>
            repository?.transaction((transaction) =>
              transaction.saveCertificate(CERTIFICATE_GENERATION_1),
            ),
        ]) {
          await assert.rejects(
            attempt() ?? Promise.reject(new Error("Repository is unavailable.")),
            (error: unknown) =>
              error instanceof DeviceIdentityError && error.code === "IDENTITY_REPOSITORY_CONFLICT",
          );
        }

        const snapshot = await repository.snapshot();
        assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
        assert.equal(snapshot.devices[0]?.status, "revoked");
        assert.equal(snapshot.certificates[0]?.status, "revoked");
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("reissues an expired unactivated rotation without advancing Device identity", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceIdentityRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await seedGrant(repository);
        await enrollDevice(repository, CERTIFICATE_GENERATION_1, ENROLLED_AUDIT);
        await repository.transaction((transaction) =>
          transaction.saveCertificate(CERTIFICATE_GENERATION_2_PENDING),
        );
        await repository.transaction(async (transaction) => {
          await transaction.saveCertificate(CERTIFICATE_GENERATION_2_RETIRED);
          await transaction.saveCertificate(CERTIFICATE_GENERATION_2_RETRY_PENDING);
        });

        await repository.close();
        repository = await fixture.open("verify");
        const snapshot = await repository.snapshot();
        assert.equal(snapshot.devices[0]?.identityGeneration, 1);
        assert.deepEqual(
          (
            await repository.transaction((transaction) =>
              transaction.listDeviceCertificates(DEVICE_ID),
            )
          ).map(({ generation, status }) => ({ generation, status })),
          [
            { generation: 1, status: "active" },
            { generation: 2, status: "retired" },
            { generation: 2, status: "pending" },
          ],
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

async function createSqliteFixture(): Promise<DeviceIdentityFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-device-identity-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    filename,
    open: (migrationMode) =>
      SqlDeviceIdentityRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
  };
}

registerDeviceIdentityRepositoryContract("SQLite", createSqliteFixture);

test("SQLite schema 0 applies every migration and schema 2 upgrades safely through Device channel state", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDeviceIdentityRepository | undefined;

  try {
    repository = await fixture.open("apply");
    assert.deepEqual(await repository.snapshot(), emptySnapshot());
    const filename = sqliteFilenameFromRepositoryFixture(fixture);
    await repository.close();
    repository = undefined;

    const sqlite = new Database(filename);
    try {
      sqlite.exec(`
        DROP TABLE od_device_observation_latest;
        DROP TABLE od_device_observation_events;
        DROP TABLE od_artifact_index_state;
        DROP TABLE od_action_authorizations;
        DROP TABLE od_approval_state;
        DROP TABLE od_configuration_state;
        DROP TABLE od_device_channel_inbound_effect;
        DROP TABLE od_device_channel_outbox;
        DROP TABLE od_device_channel_inbox;
        DROP TABLE od_device_channel_state;
        DROP TABLE od_discord_outbox;
        DROP TABLE od_discord_task_bindings;
        DROP TABLE od_discord_inbound;
        DROP TABLE od_discord_gateway_cursor;
        DROP TRIGGER od_device_identity_audit_no_delete;
        DROP TRIGGER od_device_identity_audit_no_update;
        DROP TABLE od_device_identity_audit;
        DROP TABLE od_device_enrollment_grants;
        DROP TABLE od_device_certificates;
        DROP TABLE od_device_identities;
        DROP TABLE od_device_certificate_authority;
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0016_discord_owner_prompt_surface';
        DELETE FROM od_kysely_migration
          WHERE name = '0016_discord_owner_prompt_surface';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0015_discord_failure_surface';
        DELETE FROM od_kysely_migration
          WHERE name = '0015_discord_failure_surface';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0014_discord_live_task_activity';
        DELETE FROM od_kysely_migration
          WHERE name = '0014_discord_live_task_activity';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0013_device_recredentialing';
        DELETE FROM od_kysely_migration
          WHERE name = '0013_device_recredentialing';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0012_owner_claim_replacement_audit';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0011_device_observations';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0010_artifact_index_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0009_action_authorizations';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0008_approval_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0007_configuration_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0006_device_channel_inbound_effect';
        DELETE FROM od_migration_manifest WHERE migration_name = '0005_device_channel';
        DELETE FROM od_migration_manifest WHERE migration_name = '0004_discord_state';
        DELETE FROM od_migration_manifest WHERE migration_name = '0003_device_identity';
        DELETE FROM od_kysely_migration
          WHERE name = '0012_owner_claim_replacement_audit';
        DELETE FROM od_kysely_migration
          WHERE name = '0011_device_observations';
        DELETE FROM od_kysely_migration
          WHERE name = '0010_artifact_index_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0009_action_authorizations';
        DELETE FROM od_kysely_migration
          WHERE name = '0008_approval_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0007_configuration_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0006_device_channel_inbound_effect';
        DELETE FROM od_kysely_migration WHERE name = '0005_device_channel';
        DELETE FROM od_kysely_migration WHERE name = '0004_discord_state';
        DELETE FROM od_kysely_migration WHERE name = '0003_device_identity';
      `);
    } finally {
      sqlite.close();
    }

    await assert.rejects(fixture.open("verify"), hasSqlStorageCode("MIGRATION_PENDING"));
    repository = await fixture.open("apply");
    assert.deepEqual(await repository.snapshot(), emptySnapshot());
    await repository.close();
    repository = await fixture.open("verify");
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

test("SQLite rejects corrupt durable identity data at the repository boundary", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDeviceIdentityRepository | undefined;

  try {
    repository = await fixture.open("apply");
    await repository.transaction((transaction) => transaction.saveEnrollmentGrant(ACTIVE_GRANT));
    const filename = sqliteFilenameFromRepositoryFixture(fixture);
    await repository.close();
    repository = undefined;

    const sqlite = new Database(filename);
    try {
      sqlite.pragma("ignore_check_constraints = ON");
      sqlite
        .prepare(
          `UPDATE od_device_enrollment_grants
           SET allowed_bootstrap_roles_json = ?
           WHERE grant_id = ?`,
        )
        .run('["worker",]', ACTIVE_GRANT.grantId);
    } finally {
      sqlite.close();
    }

    repository = await fixture.open("verify");
    await assert.rejects(repository.snapshot(), hasSqlStorageCode("DATA_CORRUPT"));
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

test("SQLite enforces Device identity audit records as append-only", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDeviceIdentityRepository | undefined;

  try {
    repository = await fixture.open("apply");
    await seedGrant(repository);
    const filename = sqliteFilenameFromRepositoryFixture(fixture);
    await repository.close();
    repository = undefined;

    const sqlite = new Database(filename);
    try {
      assert.throws(
        () =>
          sqlite
            .prepare(
              `UPDATE od_device_identity_audit
               SET occurred_at_ms = ?
               WHERE audit_id = ?`,
            )
            .run(NOW + 1, GRANT_ISSUED_AUDIT.auditId),
        /append-only/u,
      );
      assert.throws(
        () =>
          sqlite
            .prepare("DELETE FROM od_device_identity_audit WHERE audit_id = ?")
            .run(GRANT_ISSUED_AUDIT.auditId),
        /append-only/u,
      );
    } finally {
      sqlite.close();
    }
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

test("SQLite persists neither raw enrollment secrets nor private keys, even on extra input fields", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDeviceIdentityRepository | undefined;

  try {
    repository = await fixture.open("apply");
    const certificateAuthorityWithPrivateKey = {
      ...CERTIFICATE_AUTHORITY,
      privateKeyPem: PRIVATE_KEY_SENTINEL,
    };
    const grantWithRawSecret = {
      ...ACTIVE_GRANT,
      rawEnrollmentGrantSecret: RAW_ENROLLMENT_SECRET,
    };
    await repository.transaction(async (transaction) => {
      await transaction.setCertificateAuthority(certificateAuthorityWithPrivateKey);
      await transaction.saveEnrollmentGrant(grantWithRawSecret);
    });
    const snapshot = await repository.snapshot();
    assertNoSecretSentinels(JSON.stringify(snapshot));

    const filename = sqliteFilenameFromRepositoryFixture(fixture);
    await repository.close();
    repository = undefined;
    const directory = dirname(filename);
    const databaseBytes = Buffer.concat(
      await Promise.all(
        (await readdir(directory)).map((entry) => readFile(join(directory, entry))),
      ),
    ).toString("latin1");
    assertNoSecretSentinels(databaseBytes);

    const sqlite = new Database(filename, { readonly: true });
    try {
      const columns = (
        sqlite
          .prepare(
            `SELECT m.name AS table_name, p.name AS column_name
             FROM sqlite_schema AS m
             JOIN pragma_table_info(m.name) AS p
             WHERE m.type = 'table' AND m.name LIKE 'od_device_%'
             ORDER BY m.name, p.cid`,
          )
          .all() as readonly { column_name: string; table_name: string }[]
      ).map((row) => `${row.table_name}.${row.column_name}`);
      for (const column of columns) {
        assert.doesNotMatch(column, /private|raw|secret(?!_serial)/iu);
      }
      assert.equal(columns.includes("od_device_enrollment_grants.token_digest"), true);
    } finally {
      sqlite.close();
    }
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

test("SQLite rejects malformed repository writes before they become durable", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDeviceIdentityRepository | undefined;

  try {
    repository = await fixture.open("apply");
    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.saveEnrollmentGrant({
          ...ACTIVE_GRANT,
          tokenDigest: RAW_ENROLLMENT_SECRET,
        }),
      ),
      hasSqlStorageCode("STORAGE_CONFIGURATION_INVALID"),
    );
    await assert.rejects(
      repository.transaction((transaction) =>
        transaction.setCertificateAuthority({
          ...CERTIFICATE_AUTHORITY,
          certificatePem: PRIVATE_KEY_SENTINEL,
        }),
      ),
      hasSqlStorageCode("STORAGE_CONFIGURATION_INVALID"),
    );
    assert.deepEqual(await repository.snapshot(), emptySnapshot());
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerDeviceIdentityRepositoryContract("PostgreSQL", async () => {
    const schema = `od_device_identity_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
      open: (migrationMode) =>
        SqlDeviceIdentityRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
    };
  });
}

const NOW = Date.UTC(2026, 6, 24, 0, 0, 0);
const DEVICE_ID = "device-linux-nas";
const RAW_ENROLLMENT_SECRET = "raw-enrollment-grant-secret-must-not-persist";
const PRIVATE_KEY_SENTINEL =
  "-----BEGIN PRIVATE KEY-----\nprivate-key-must-not-persist\n-----END PRIVATE KEY-----";

const CERTIFICATE_AUTHORITY: PublicCertificateAuthority = Object.freeze({
  certificatePem: publicCertificatePem("instance-ca"),
  createdAt: NOW,
  instanceId: "instance-personal",
  keyId: "ca_public-reference-only",
  notAfter: NOW + 365 * 24 * 60 * 60_000,
  notBefore: NOW - 60_000,
  spkiSha256: fingerprint("A"),
  status: "active",
});

const ACTIVE_GRANT: PersistedEnrollmentGrant = Object.freeze({
  allowedBootstrapRoles: Object.freeze(["worker", "nas"]),
  createdAt: NOW,
  deviceId: DEVICE_ID,
  expiresAt: NOW + 5 * 60_000,
  grantId: "grant_AAAAAAAAAAAAAAAAAAAAAA",
  intent: "enroll",
  protocolRange: Object.freeze({ maximum: 3, minimum: 1 }),
  status: "active",
  tokenDigest: createHash("sha256").update(RAW_ENROLLMENT_SECRET).digest("hex"),
});

const DEVICE_GENERATION_1: PersistedDeviceIdentity = Object.freeze({
  allowedBootstrapRoles: ACTIVE_GRANT.allowedBootstrapRoles,
  createdAt: NOW + 1_000,
  deviceId: DEVICE_ID,
  discovery: Object.freeze({
    architecture: "x64",
    hostname: "nas-private",
    osFamily: "linux",
  }),
  identityGeneration: 1,
  status: "active",
});

const DEVICE_GENERATION_2: PersistedDeviceIdentity = Object.freeze({
  ...DEVICE_GENERATION_1,
  identityGeneration: 2,
});

const DEVICE_REVOKED: PersistedDeviceIdentity = Object.freeze({
  ...DEVICE_GENERATION_2,
  revokedAt: NOW + 4_000,
  status: "revoked",
});

const CERTIFICATE_GENERATION_1: PersistedDeviceCertificate = Object.freeze({
  certificatePem: publicCertificatePem("device-generation-1"),
  deviceId: DEVICE_ID,
  generation: 1,
  issuedAt: NOW + 1_000,
  notAfter: NOW + 24 * 60 * 60_000,
  notBefore: NOW - 59_000,
  publicKeySpkiSha256: fingerprint("B"),
  serialNumber: certificateSerial("01"),
  status: "active",
});

const CERTIFICATE_GENERATION_1_OVERLAP: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_1,
  overlapEndsAt: NOW + 5 * 60_000,
  status: "overlap",
});

const CERTIFICATE_GENERATION_1_REVOKED: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_1_OVERLAP,
  revokedAt: NOW + 4_000,
  status: "revoked",
});

const CERTIFICATE_GENERATION_2_PENDING: PersistedDeviceCertificate = Object.freeze({
  activationChallengeDigest: "c".repeat(64),
  activationExpiresAt: NOW + 2 * 60_000,
  certificatePem: publicCertificatePem("device-generation-2"),
  deviceId: DEVICE_ID,
  generation: 2,
  issuedAt: NOW + 2_000,
  notAfter: NOW + 24 * 60 * 60_000,
  notBefore: NOW - 58_000,
  publicKeySpkiSha256: fingerprint("D"),
  serialNumber: certificateSerial("02"),
  status: "pending",
});

const CERTIFICATE_GENERATION_2_ACTIVE: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_2_PENDING,
  status: "active",
});

const CERTIFICATE_GENERATION_2_RETIRED: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_2_PENDING,
  retiredAt: NOW + 2 * 60_000,
  status: "retired",
});

const CERTIFICATE_GENERATION_2_RETRY_PENDING: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_2_PENDING,
  activationChallengeDigest: "d".repeat(64),
  certificatePem: publicCertificatePem("device-generation-2-retry"),
  publicKeySpkiSha256: fingerprint("E"),
  serialNumber: certificateSerial("03"),
});

const CERTIFICATE_GENERATION_2_REVOKED: PersistedDeviceCertificate = Object.freeze({
  ...CERTIFICATE_GENERATION_2_ACTIVE,
  revokedAt: NOW + 4_000,
  status: "revoked",
});

const GRANT_ISSUED_AUDIT: DeviceIdentityAuditRecord = Object.freeze({
  auditId: "identity-audit_grant-issued",
  deviceId: DEVICE_ID,
  event: "device.enrollment-grant-issued",
  grantId: ACTIVE_GRANT.grantId,
  occurredAt: NOW,
});

const ENROLLED_AUDIT: DeviceIdentityAuditRecord = Object.freeze({
  auditId: "identity-audit_enrolled",
  certificateGeneration: 1,
  certificateSerial: CERTIFICATE_GENERATION_1.serialNumber,
  deviceId: DEVICE_ID,
  event: "device.enrolled",
  grantId: ACTIVE_GRANT.grantId,
  occurredAt: NOW + 1_000,
});

const ROTATION_ISSUED_AUDIT: DeviceIdentityAuditRecord = Object.freeze({
  auditId: "identity-audit_rotation-issued",
  certificateGeneration: 2,
  certificateSerial: CERTIFICATE_GENERATION_2_PENDING.serialNumber,
  deviceId: DEVICE_ID,
  event: "device.rotation-issued",
  occurredAt: NOW + 2_000,
});

const ROTATION_CONFIRMED_AUDIT: DeviceIdentityAuditRecord = Object.freeze({
  auditId: "identity-audit_rotation-confirmed",
  certificateGeneration: 2,
  certificateSerial: CERTIFICATE_GENERATION_2_PENDING.serialNumber,
  deviceId: DEVICE_ID,
  event: "device.rotation-confirmed",
  occurredAt: NOW + 3_000,
});

const REVOKED_AUDIT: DeviceIdentityAuditRecord = Object.freeze({
  auditId: "identity-audit_revoked",
  deviceId: DEVICE_ID,
  event: "device.revoked",
  occurredAt: NOW + 4_000,
});

async function seedGrant(repository: SqlDeviceIdentityRepository): Promise<void> {
  await repository.transaction(async (transaction) => {
    await transaction.setCertificateAuthority(CERTIFICATE_AUTHORITY);
    await transaction.saveEnrollmentGrant(ACTIVE_GRANT);
    await transaction.appendAuditRecord(GRANT_ISSUED_AUDIT);
  });
}

async function enrollDevice(
  repository: SqlDeviceIdentityRepository,
  certificate: PersistedDeviceCertificate,
  audit: DeviceIdentityAuditRecord,
): Promise<void> {
  const consumedGrant: PersistedEnrollmentGrant = {
    ...ACTIVE_GRANT,
    consumedAt: NOW + 1_000,
    issuedCertificateSerial: certificate.serialNumber,
    status: "consumed",
  };
  await repository.transaction(async (transaction) => {
    await transaction.saveCertificate(certificate);
    await transaction.saveDevice(DEVICE_GENERATION_1);
    await transaction.saveEnrollmentGrant(consumedGrant);
    await transaction.appendAuditRecord(audit);
  });
}

async function consumeEnrollment(
  repository: SqlDeviceIdentityRepository,
  certificate: PersistedDeviceCertificate,
  audit: DeviceIdentityAuditRecord,
): Promise<boolean> {
  return repository.transaction(async (transaction) => {
    const grant = await transaction.getEnrollmentGrant(ACTIVE_GRANT.grantId);
    if (grant?.status !== "active") {
      await transaction.appendAuditRecord({
        auditId: `${audit.auditId}-rejected`,
        deviceId: DEVICE_ID,
        event: "device.enrollment-rejected",
        grantId: ACTIVE_GRANT.grantId,
        occurredAt: NOW + 1_000,
        rejectionCode: "invalid-or-consumed",
      });
      return false;
    }
    await transaction.saveCertificate(certificate);
    await transaction.saveDevice(DEVICE_GENERATION_1);
    await transaction.saveEnrollmentGrant({
      ...grant,
      consumedAt: NOW + 1_000,
      issuedCertificateSerial: certificate.serialNumber,
      status: "consumed",
    });
    await transaction.appendAuditRecord(audit);
    return true;
  });
}

function assertEnrollmentSnapshot(snapshot: DeviceIdentityRepositorySnapshot): void {
  assert.equal(snapshot.devices[0]?.identityGeneration, 1);
  assert.equal(snapshot.certificates[0]?.status, "active");
  assert.equal(snapshot.enrollmentGrants[0]?.status, "consumed");
  assert.equal(snapshot.auditRecords[1]?.event, "device.enrolled");
}

function emptySnapshot(): DeviceIdentityRepositorySnapshot {
  return {
    auditRecords: [],
    certificateAuthority: null,
    certificates: [],
    devices: [],
    enrollmentGrants: [],
  };
}

function publicCertificatePem(label: string): string {
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(label).toString("base64")}\n-----END CERTIFICATE-----`;
}

function fingerprint(character: string): string {
  return `sha256:${character.repeat(43)}`;
}

function certificateSerial(value: string): string {
  return value.padStart(32, "0");
}

function hasSqlStorageCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function assertNoSecretSentinels(value: string): void {
  assert.equal(value.includes(RAW_ENROLLMENT_SECRET), false);
  assert.equal(value.includes(PRIVATE_KEY_SENTINEL), false);
  assert.equal(value.includes("private-key-must-not-persist"), false);
}

function sqliteFilenameFromRepositoryFixture(fixture: DeviceIdentityFixture): string {
  const filename = fixture.filename;
  if (filename === undefined) {
    throw new Error("The SQLite fixture did not expose its database filename.");
  }
  return filename;
}
