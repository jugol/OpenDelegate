import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { LocalArtifactStore, type ArtifactIndexSnapshot } from "@opendelegate/artifact-store";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlStorageError } from "../src/errors.ts";
import { SqlArtifactIndexRepository } from "../src/sql-artifact-index-repository.ts";
import type { SqlMigrationMode } from "../src/sql-event-store.ts";

interface ArtifactIndexFixture {
  readonly rootDirectory: string;
  open(migrationMode: SqlMigrationMode): Promise<SqlArtifactIndexRepository>;
  corruptDigest(): Promise<void>;
  deleteSingleton(): Promise<void>;
  cleanup(): Promise<void>;
}

type ArtifactIndexFixtureFactory = () => Promise<ArtifactIndexFixture>;

function registerArtifactIndexRepositoryContract(
  backend: string,
  createFixture: ArtifactIndexFixtureFactory,
): void {
  test(`${backend}: Artifact index initialization, restart, and compare-and-set are atomic`, async () => {
    const fixture = await createFixture();
    let first: SqlArtifactIndexRepository | undefined;
    let second: SqlArtifactIndexRepository | undefined;
    try {
      first = await fixture.open("apply");
      const initial = snapshot(0);
      assert.deepEqual(await first.load(), initial);
      assert.deepEqual(await first.initialize(snapshot(7)), initial);
      second = await fixture.open("verify");
      assert.deepEqual(await second.load(), initial);

      assert.equal(await first.compareAndSet(0, snapshot(1)), true);
      assert.equal(await second.compareAndSet(0, snapshot(1, "stale")), false);
      assert.deepEqual(await second.load(), snapshot(1));

      await assert.rejects(
        first.compareAndSet(1, snapshot(3)),
        (error: unknown) =>
          error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
      );
    } finally {
      await Promise.all([first?.close(), second?.close()]);
      await fixture.cleanup();
    }
  });

  test(`${backend}: SQL owns Artifact metadata, signed tokens, and audit while bytes remain local`, async () => {
    const fixture = await createFixture();
    const signingKey = Buffer.alloc(32, 9);
    const clock = { nowMs: () => 1_000 };
    let store: LocalArtifactStore | undefined;
    let restarted: LocalArtifactStore | undefined;
    try {
      store = await LocalArtifactStore.open({
        rootDirectory: fixture.rootDirectory,
        maxArtifactBytes: 1_024,
        clock,
        signingKey,
        indexRepository: await fixture.open("apply"),
      });
      const bytes = Buffer.from("database-backed Artifact metadata", "utf8");
      await store.put({
        artifactId: "artifact-sql-contract",
        taskId: "task-sql-contract",
        producingRunId: "run-sql-contract",
        mediaType: "text/plain",
        originalFilename: "report.txt",
        bytes,
        expectedChecksum: { algorithm: "sha256", value: digest(bytes) },
        createdAtMs: 1_000,
        retentionPolicy: { kind: "task" },
        exposurePolicy: { mode: "signed-link" },
        provenance: { deviceId: "device-worker", source: "worker-upload" },
        context: {
          actor: { type: "worker-agent", id: "worker-contract" },
          correlationId: "artifact-sql-store",
        },
      });
      const token = await store.issueSignedToken({
        artifactId: "artifact-sql-contract",
        expiresAtMs: 5_000,
        context: {
          actor: { type: "owner", id: "owner-contract" },
          correlationId: "artifact-sql-token",
        },
      });
      await store.verifySignedToken({
        artifactId: "artifact-sql-contract",
        token: token.token,
        context: {
          actor: { type: "owner", id: "owner-contract" },
          correlationId: "artifact-sql-access",
        },
      });
      await assert.rejects(readFile(join(fixture.rootDirectory, "index.json"), "utf8"), {
        code: "ENOENT",
      });
      await store.close();
      store = undefined;

      restarted = await LocalArtifactStore.open({
        rootDirectory: fixture.rootDirectory,
        maxArtifactBytes: 1_024,
        clock,
        signingKey,
        indexRepository: await fixture.open("verify"),
      });
      assert.deepEqual(Buffer.from((await restarted.read("artifact-sql-contract")).bytes), bytes);
      await restarted.verifySignedToken({
        artifactId: "artifact-sql-contract",
        token: token.token,
        context: {
          actor: { type: "owner", id: "owner-contract" },
          correlationId: "artifact-sql-restart-access",
        },
      });
      assert.deepEqual(
        (await restarted.listAuditEvents("artifact-sql-contract")).map((event) => event.eventType),
        [
          "artifact.stored",
          "artifact.signed-token-issued",
          "artifact.access-granted",
          "artifact.access-granted",
        ],
      );
    } finally {
      await store?.close();
      await restarted?.close();
      await fixture.cleanup();
    }
  });

  test(`${backend}: corrupt Artifact index integrity fails closed`, async () => {
    const fixture = await createFixture();
    let repository: SqlArtifactIndexRepository | undefined;
    try {
      repository = await fixture.open("apply");
      await repository.initialize(snapshot(0));
      await repository.close();
      repository = undefined;
      await fixture.corruptDigest();
      await assert.rejects(
        fixture.open("verify"),
        (error: unknown) => error instanceof SqlStorageError && error.code === "DATA_CORRUPT",
      );
    } finally {
      await repository?.close();
      await fixture.cleanup();
    }
  });

  test(`${backend}: a missing Artifact index singleton blocks repository startup`, async () => {
    const fixture = await createFixture();
    let repository: SqlArtifactIndexRepository | undefined;
    try {
      repository = await fixture.open("apply");
      await repository.close();
      repository = undefined;
      await fixture.deleteSingleton();
      await assert.rejects(
        fixture.open("verify"),
        (error: unknown) => error instanceof SqlStorageError && error.code === "DATA_CORRUPT",
      );
    } finally {
      await repository?.close();
      await fixture.cleanup();
    }
  });
}

function snapshot(generation: number, marker?: string): ArtifactIndexSnapshot {
  const stateJson = JSON.stringify({
    schemaVersion: 1,
    generation,
    artifacts: {},
    signedTokens: {},
    auditEvents: [],
    nextAuditSequence: 1,
    ...(marker === undefined ? {} : { marker }),
  });
  return Object.freeze({
    schemaVersion: 1,
    generation,
    stateJson,
    stateSha256: digest(stateJson),
  });
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createSqliteFixture(): Promise<ArtifactIndexFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-artifact-index-sql-"));
  const rootDirectory = join(directory, "artifacts");
  const filename = join(directory, "main.sqlite3");
  return {
    rootDirectory,
    open: (migrationMode) =>
      SqlArtifactIndexRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
    corruptDigest: async () => {
      const sqlite = new Database(filename);
      try {
        sqlite
          .prepare(
            `UPDATE od_artifact_index_state
             SET state_sha256 = ? WHERE singleton_id = 1`,
          )
          .run("0".repeat(64));
      } finally {
        sqlite.close();
      }
    },
    deleteSingleton: async () => {
      const sqlite = new Database(filename);
      try {
        sqlite.prepare("DELETE FROM od_artifact_index_state WHERE singleton_id = 1").run();
      } finally {
        sqlite.close();
      }
    },
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

registerArtifactIndexRepositoryContract("SQLite", createSqliteFixture);

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerArtifactIndexRepositoryContract("PostgreSQL", async () => {
    const schema = `od_artifact_${randomUUID().replaceAll("-", "")}`;
    const rootDirectory = await mkdtemp(join(tmpdir(), "opendelegate-artifact-index-pg-"));
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      rootDirectory,
      open: (migrationMode) =>
        SqlArtifactIndexRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      corruptDigest: async () => {
        await postgresAdminPool?.query(
          `UPDATE "${schema}".od_artifact_index_state
           SET state_sha256 = $1 WHERE singleton_id = 1`,
          ["0".repeat(64)],
        );
      },
      deleteSingleton: async () => {
        await postgresAdminPool?.query(
          `DELETE FROM "${schema}".od_artifact_index_state WHERE singleton_id = 1`,
        );
      },
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await rm(rootDirectory, { force: true, recursive: true });
      },
    };
  });
}
