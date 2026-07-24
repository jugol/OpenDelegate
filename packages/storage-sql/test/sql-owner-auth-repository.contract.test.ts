import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  OwnerAuth,
  OwnerAuthError,
  type OwnerAuthClock,
  type OwnerAuthRepositorySnapshot,
  type PasswordHasher,
  type SecureRandomSource,
} from "@opendelegate/owner-auth";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlOwnerAuthRepository, type SqlMigrationMode } from "../src/index.ts";

interface OwnerAuthFixture {
  open(mode: SqlMigrationMode): Promise<SqlOwnerAuthRepository>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<OwnerAuthFixture>;

function registerOwnerAuthRepositoryContract(label: string, createFixture: FixtureFactory): void {
  describe(`${label} owner-auth repository contract`, () => {
    test("persists the claim, owner, sessions, login limits, and audit across restart", async () => {
      const fixture = await createFixture();
      const clock = new MutableClock(NOW);
      const random = new DeterministicRandomSource(`${label}-restart`);
      const passwordHasher = new FakePasswordHasher();
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        let auth = createAuth(repository, clock, random, passwordHasher);
        const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });

        await repository.close();
        repository = await fixture.open("verify");
        auth = createAuth(repository, clock, random, passwordHasher);
        const owner = await auth.claimOwner({
          channel: "local-bootstrap",
          claimToken: claim.claimToken,
          passphrase: PASSPHRASE,
        });
        const login = await auth.login({
          passphrase: PASSPHRASE,
          sourceKey: "restart-source-address",
        });

        for (let attempt = 0; attempt < 5; attempt += 1) {
          await assert.rejects(
            auth.login({
              passphrase: "an incorrect passphrase",
              sourceKey: "durable-rate-limit-source",
            }),
            isAuthError("AUTHENTICATION_FAILED"),
          );
        }
        const beforeRestart = await repository.snapshot();

        await repository.close();
        repository = await fixture.open("verify");
        auth = createAuth(repository, clock, random, passwordHasher);

        assert.deepEqual(await repository.snapshot(), beforeRestart);
        assert.equal((await auth.validateSession(login.sessionToken)).ownerId, owner.ownerId);
        await assert.rejects(
          auth.login({
            passphrase: PASSPHRASE,
            sourceKey: "durable-rate-limit-source",
          }),
          isAuthError("RATE_LIMITED"),
        );

        clock.value += 15 * 60_000;
        assert.equal(
          (
            await auth.login({
              passphrase: PASSPHRASE,
              sourceKey: "durable-rate-limit-source",
            })
          ).session.ownerId,
          owner.ownerId,
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("permits exactly one concurrent claim and one recovery-code consumption", async () => {
      const fixture = await createFixture();
      const clock = new MutableClock(NOW);
      const random = new DeterministicRandomSource(`${label}-single-use`);
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        const auth = createAuth(repository, clock, random, new FakePasswordHasher());
        const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });
        const claims = await Promise.allSettled(
          Array.from({ length: 10 }, () =>
            auth.claimOwner({
              channel: "local-bootstrap",
              claimToken: claim.claimToken,
              passphrase: PASSPHRASE,
            }),
          ),
        );
        const claimed = claims.filter(
          (
            result,
          ): result is PromiseFulfilledResult<Awaited<ReturnType<OwnerAuth["claimOwner"]>>> =>
            result.status === "fulfilled",
        );

        assert.equal(claimed.length, 1);
        assert.equal(
          claims.filter(
            (result) =>
              result.status === "rejected" &&
              result.reason instanceof OwnerAuthError &&
              result.reason.code === "CLAIM_INVALID",
          ).length,
          9,
        );

        const recoveryCode = claimed[0]?.value.recoveryCodes[0];
        assert.notEqual(recoveryCode, undefined);
        const recoveries = await Promise.allSettled(
          Array.from({ length: 12 }, () =>
            auth.beginRecovery({ recoveryCode: recoveryCode ?? "" }),
          ),
        );

        assert.equal(recoveries.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(
          recoveries.filter(
            (result) =>
              result.status === "rejected" &&
              result.reason instanceof OwnerAuthError &&
              result.reason.code === "RECOVERY_INVALID",
          ).length,
          11,
        );
        const snapshot = await repository.snapshot();
        assert.equal(
          snapshot.recoveryCodes.filter((record) => record.consumedAt === NOW).length,
          1,
        );
        assert.equal(snapshot.recoveryStates.length, 1);
        assert.equal(
          snapshot.auditRecords.filter((record) => record.event === "owner.auth.recovery-begun")
            .length,
          1,
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("evaluates claim, recovery, and session expiry at the serialized acceptance instant", async () => {
      const fixture = await createFixture();
      const clock = new MutableClock(NOW);
      const random = new DeterministicRandomSource(`${label}-expiry`);
      const passwordHasher = new FakePasswordHasher();
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        let auth = createAuth(repository, clock, random, passwordHasher);
        const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });
        passwordHasher.onHash = () => {
          clock.value = claim.expiresAt;
        };
        await assert.rejects(
          auth.claimOwner({
            channel: "local-bootstrap",
            claimToken: claim.claimToken,
            passphrase: PASSPHRASE,
          }),
          isAuthError("CLAIM_INVALID"),
        );
        assert.equal((await repository.snapshot()).owner, null);

        passwordHasher.onHash = undefined;
        clock.value = claim.expiresAt + 1;
        const replacementClaim = await auth.issueInitialClaim({
          channel: "local-bootstrap",
        });
        const claimed = await auth.claimOwner({
          channel: "local-bootstrap",
          claimToken: replacementClaim.claimToken,
          passphrase: PASSPHRASE,
        });
        const recovery = await auth.beginRecovery({
          recoveryCode: claimed.recoveryCodes[0] ?? "",
        });
        passwordHasher.onHash = () => {
          clock.value = recovery.expiresAt;
        };
        await assert.rejects(
          auth.completeRecovery({
            recoveryToken: recovery.recoveryToken,
            newPassphrase: REPLACEMENT_PASSPHRASE,
          }),
          isAuthError("RECOVERY_INVALID"),
        );
        assert.equal((await repository.snapshot()).owner?.credentialVersion, 1);

        passwordHasher.onHash = undefined;
        const login = await auth.login({
          passphrase: PASSPHRASE,
          sourceKey: "expiry-source",
        });
        clock.value = login.session.absoluteExpiresAt;
        await assert.rejects(
          auth.validateSession(login.sessionToken),
          isAuthError("SESSION_INVALID"),
        );

        await repository.close();
        repository = await fixture.open("verify");
        auth = createAuth(repository, clock, random, passwordHasher);
        await assert.rejects(
          auth.validateSession(login.sessionToken),
          isAuthError("SESSION_INVALID"),
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("recovery revokes every browser session atomically and remains revoked after restart", async () => {
      const fixture = await createFixture();
      const clock = new MutableClock(NOW);
      const random = new DeterministicRandomSource(`${label}-revoke-all`);
      const passwordHasher = new FakePasswordHasher();
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        let auth = createAuth(repository, clock, random, passwordHasher);
        const recoveryCodes = await initializeOwner(auth);
        const sessions = await Promise.all(
          ["session-source-a", "session-source-b", "session-source-c"].map((sourceKey) =>
            auth.login({ passphrase: PASSPHRASE, sourceKey }),
          ),
        );
        const recovery = await auth.beginRecovery({
          recoveryCode: recoveryCodes[0] ?? "",
        });
        await auth.completeRecovery({
          recoveryToken: recovery.recoveryToken,
          newPassphrase: REPLACEMENT_PASSPHRASE,
        });

        const snapshot = await repository.snapshot();
        assert.equal(snapshot.owner?.credentialVersion, 2);
        assert.equal(snapshot.sessions.length, 3);
        assert.equal(
          snapshot.sessions.every((session) => session.revokedAt === NOW),
          true,
        );
        assert.equal(
          snapshot.auditRecords.filter((record) => record.event === "owner.auth.recovered").length,
          1,
        );

        await repository.close();
        repository = await fixture.open("verify");
        auth = createAuth(repository, clock, random, passwordHasher);
        for (const session of sessions) {
          await assert.rejects(
            auth.validateSession(session.sessionToken),
            isAuthError("SESSION_INVALID"),
          );
        }
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rolls back state mutation when its append-only audit write fails", async () => {
      const fixture = await createFixture();
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        const audit = {
          auditId: "owner-auth-audit_atomicity",
          event: "owner.auth.claim-issued",
          occurredAt: NOW,
        } as const;

        await assert.rejects(
          repository.transaction(async (transaction) => {
            await transaction.setInitialClaim({
              tokenDigest: sha256("claim-that-must-roll-back"),
              createdAt: NOW,
              expiresAt: NOW + 60_000,
            });
            await transaction.appendAuditRecord(audit);
            await transaction.appendAuditRecord(audit);
          }),
        );

        const snapshot = await repository.snapshot();
        assert.equal(snapshot.claim, null);
        assert.deepEqual(snapshot.auditRecords, []);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("stores only PHC or digest forms and never exposes raw bearers in snapshots", async () => {
      const fixture = await createFixture();
      const clock = new MutableClock(NOW);
      const random = new DeterministicRandomSource(`${label}-credential-leak`);
      let repository: SqlOwnerAuthRepository | undefined;

      try {
        repository = await fixture.open("apply");
        const auth = createAuth(repository, clock, random, new FakePasswordHasher());
        const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });
        const claimed = await auth.claimOwner({
          channel: "local-bootstrap",
          claimToken: claim.claimToken,
          passphrase: PASSPHRASE,
        });
        const login = await auth.login({
          passphrase: PASSPHRASE,
          sourceKey: RAW_SOURCE_KEY,
        });
        const recovery = await auth.beginRecovery({
          recoveryCode: claimed.recoveryCodes[0] ?? "",
        });
        const snapshot = await repository.snapshot();
        assertSnapshotHasNoRawCredentials(snapshot, [
          claim.claimToken,
          PASSPHRASE,
          login.sessionToken,
          login.csrfToken,
          recovery.recoveryToken,
          RAW_SOURCE_KEY,
          ...claimed.recoveryCodes,
        ]);

        assert.match(snapshot.owner?.passwordPhc ?? "", /^\$fake\$[0-9a-f]{64}$/u);
        assert.match(snapshot.sessions[0]?.tokenDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
        assert.match(snapshot.recoveryCodes[0]?.digest ?? "", /^v1:sha256:[0-9a-f]{64}$/u);
        assert.match(snapshot.recoveryStates[0]?.tokenDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

async function createSqliteFixture(): Promise<OwnerAuthFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-owner-auth-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    open: (migrationMode) =>
      SqlOwnerAuthRepository.openSqlite({
        filename,
        migrationMode,
      }),
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

registerOwnerAuthRepositoryContract("SQLite", createSqliteFixture);

test("SQLite schema denies raw credential columns and enforces append-only auth audit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-owner-auth-schema-"));
  const filename = join(directory, "main.sqlite3");
  const repository = await SqlOwnerAuthRepository.openSqlite({
    filename,
    migrationMode: "apply",
  });
  const clock = new MutableClock(NOW);
  const auth = createAuth(
    repository,
    clock,
    new DeterministicRandomSource("sqlite-schema"),
    new FakePasswordHasher(),
  );

  try {
    await initializeOwner(auth);
  } finally {
    await repository.close();
  }

  const sqlite = new Database(filename);
  try {
    const schemaRows = sqlite
      .prepare(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'od_owner_%'
         ORDER BY name`,
      )
      .all() as readonly { name: string; sql: string }[];
    assert.deepEqual(
      schemaRows.map((row) => row.name),
      [
        "od_owner_auth_audit",
        "od_owner_claim",
        "od_owner_credential",
        "od_owner_login_attempts",
        "od_owner_recovery_credentials",
        "od_owner_recovery_states",
        "od_owner_sessions",
      ],
    );

    const forbiddenColumns = new Set([
      "claim_token",
      "code",
      "credential_value",
      "knowledge",
      "passphrase",
      "raw_value",
      "recovery_code",
      "secret",
      "session_token",
      "token",
    ]);
    for (const table of schemaRows) {
      assert.match(table.sql, /\bCHECK\b/u);
      const columns = sqlite.pragma(`table_info(${table.name})`) as readonly {
        name: string;
      }[];
      for (const column of columns) {
        assert.equal(
          forbiddenColumns.has(column.name),
          false,
          `${table.name}.${column.name} could store a raw credential`,
        );
      }
    }

    const auditId = (
      sqlite
        .prepare("SELECT audit_id FROM od_owner_auth_audit ORDER BY audit_id LIMIT 1")
        .get() as { audit_id: string }
    ).audit_id;
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE od_owner_auth_audit SET occurred_at_ms = ? WHERE audit_id = ?")
          .run(NOW + 1, auditId),
      /append-only/u,
    );
    assert.throws(
      () => sqlite.prepare("DELETE FROM od_owner_auth_audit WHERE audit_id = ?").run(auditId),
      /append-only/u,
    );
  } finally {
    sqlite.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("migration 0002 upgrades the released event-store schema and remains checksum-verifiable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-owner-auth-upgrade-"));
  const filename = join(directory, "main.sqlite3");
  const initialized = await SqlOwnerAuthRepository.openSqlite({
    filename,
    migrationMode: "apply",
  });
  await initialized.close();

  const sqlite = new Database(filename);
  try {
    sqlite.exec(`
      DROP TABLE od_owner_sessions;
      DROP TABLE od_owner_recovery_states;
      DROP TABLE od_owner_recovery_credentials;
      DROP TABLE od_owner_login_attempts;
      DROP TABLE od_owner_auth_audit;
      DROP TABLE od_owner_credential;
      DROP TABLE od_owner_claim;
      DELETE FROM od_migration_manifest WHERE migration_name = '0002_owner_auth';
      DELETE FROM od_kysely_migration WHERE name = '0002_owner_auth';
    `);
  } finally {
    sqlite.close();
  }

  let upgraded: SqlOwnerAuthRepository | undefined;
  try {
    await assert.rejects(
      SqlOwnerAuthRepository.openSqlite({
        filename,
        migrationMode: "verify",
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "MIGRATION_PENDING",
    );

    upgraded = await SqlOwnerAuthRepository.openSqlite({
      filename,
      migrationMode: "apply",
    });
    assert.deepEqual(await upgraded.snapshot(), {
      auditRecords: [],
      claim: null,
      loginAttempts: [],
      owner: null,
      recoveryCodes: [],
      recoveryStates: [],
      sessions: [],
    });
    await upgraded.close();
    upgraded = await SqlOwnerAuthRepository.openSqlite({
      filename,
      migrationMode: "verify",
    });
  } finally {
    await upgraded?.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("independent SQLite connections still permit exactly one initial-owner claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-owner-auth-gate-"));
  const filename = join(directory, "main.sqlite3");
  const first = await SqlOwnerAuthRepository.openSqlite({
    busyTimeoutMs: 100,
    filename,
    migrationMode: "apply",
  });
  const clock = new MutableClock(NOW);
  const firstAuth = createAuth(
    first,
    clock,
    new DeterministicRandomSource("sqlite-gate-first"),
    new FakePasswordHasher(),
  );
  const claim = await firstAuth.issueInitialClaim({ channel: "local-bootstrap" });
  const second = await SqlOwnerAuthRepository.openSqlite({
    busyTimeoutMs: 100,
    filename,
    migrationMode: "verify",
  });
  const secondAuth = createAuth(
    second,
    clock,
    new DeterministicRandomSource("sqlite-gate-second"),
    new FakePasswordHasher(),
  );

  try {
    const attempts = await Promise.allSettled(
      [firstAuth, secondAuth].map((auth) =>
        auth.claimOwner({
          channel: "local-bootstrap",
          claimToken: claim.claimToken,
          passphrase: PASSPHRASE,
        }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      attempts.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof OwnerAuthError &&
          result.reason.code === "CLAIM_INVALID",
      ).length,
      1,
    );
    assert.deepEqual(await second.snapshot(), await first.snapshot());
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { force: true, recursive: true });
  }
});

test("SQLite database bytes never contain raw owner-auth bearer values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-owner-auth-bytes-"));
  const filename = join(directory, "main.sqlite3");
  const repository = await SqlOwnerAuthRepository.openSqlite({
    filename,
    migrationMode: "apply",
  });
  const auth = createAuth(
    repository,
    new MutableClock(NOW),
    new DeterministicRandomSource("sqlite-byte-leak"),
    new FakePasswordHasher(),
  );
  let credentials: readonly string[];

  try {
    const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });
    const claimed = await auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: claim.claimToken,
      passphrase: PASSPHRASE,
    });
    const login = await auth.login({
      passphrase: PASSPHRASE,
      sourceKey: RAW_SOURCE_KEY,
    });
    const recovery = await auth.beginRecovery({
      recoveryCode: claimed.recoveryCodes[0] ?? "",
    });
    credentials = [
      claim.claimToken,
      PASSPHRASE,
      login.sessionToken,
      login.csrfToken,
      recovery.recoveryToken,
      RAW_SOURCE_KEY,
      ...claimed.recoveryCodes,
    ];
  } finally {
    await repository.close();
  }

  try {
    const databaseBytes = Buffer.concat(
      await Promise.all(
        (await readdir(directory)).map((entry) => readFile(join(directory, entry))),
      ),
    ).toString("latin1");
    for (const credential of credentials) {
      assert.equal(
        databaseBytes.includes(credential),
        false,
        `SQLite retained raw credential ${credential.slice(0, 8)}…`,
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerOwnerAuthRepositoryContract("PostgreSQL", async () => {
    const schema = `od_owner_auth_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      open: (migrationMode) =>
        SqlOwnerAuthRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  });
}

const NOW = Date.parse("2026-07-24T08:00:00.000Z");
const PASSPHRASE = "correct horse battery staple";
const REPLACEMENT_PASSPHRASE = "a new and independent passphrase";
const RAW_SOURCE_KEY = "raw-client-address-that-must-never-be-persisted";

function createAuth(
  repository: SqlOwnerAuthRepository,
  clock: MutableClock,
  random: SecureRandomSource,
  passwordHasher: PasswordHasher,
): OwnerAuth {
  return new OwnerAuth({
    allowedOrigins: ["https://admin.example.test"],
    clock,
    passwordHasher,
    random,
    repository,
  });
}

async function initializeOwner(auth: OwnerAuth): Promise<readonly string[]> {
  const claim = await auth.issueInitialClaim({ channel: "local-bootstrap" });
  return (
    await auth.claimOwner({
      channel: "local-bootstrap",
      claimToken: claim.claimToken,
      passphrase: PASSPHRASE,
    })
  ).recoveryCodes;
}

function assertSnapshotHasNoRawCredentials(
  snapshot: OwnerAuthRepositorySnapshot,
  credentials: readonly string[],
): void {
  const serialized = JSON.stringify(snapshot);
  for (const credential of credentials) {
    assert.equal(
      serialized.includes(credential),
      false,
      `Snapshot retained raw credential ${credential.slice(0, 8)}…`,
    );
  }
}

class MutableClock implements OwnerAuthClock {
  public value: number;

  public constructor(value: number) {
    this.value = value;
  }

  public now(): number {
    return this.value;
  }
}

class DeterministicRandomSource implements SecureRandomSource {
  private counter = 0;
  private readonly seed: string;

  public constructor(seed: string) {
    this.seed = seed;
  }

  public bytes(length: number): Uint8Array {
    const result = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      this.counter += 1;
      const block = createHash("sha256").update(`${this.seed}:${this.counter}`).digest();
      offset += block.copy(result, offset);
    }
    return result;
  }
}

class FakePasswordHasher implements PasswordHasher {
  public onHash: (() => void) | undefined;

  public async hash(passphrase: string): Promise<string> {
    this.onHash?.();
    return `$fake$${createHash("sha256").update(passphrase).digest("hex")}`;
  }

  public async verify(encodedPhc: string, passphrase: string): Promise<boolean> {
    return encodedPhc === `$fake$${createHash("sha256").update(passphrase).digest("hex")}`;
  }

  public needsRehash(_encodedPhc: string): boolean {
    return false;
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isAuthError(code: OwnerAuthError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof OwnerAuthError && error.code === code;
}
