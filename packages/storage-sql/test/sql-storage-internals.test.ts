import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { createSqliteDatabase } from "../src/dialects.ts";
import { SqlStorageError } from "../src/errors.ts";
import { SqlEventStore } from "../src/sql-event-store.ts";
import { executeWithSqlRetry } from "../src/transactions.ts";

const clock = {
  now: () => "2026-07-24T05:00:00.000Z",
};

test("the SQLite dialect applies every required connection PRAGMA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-sql-pragmas-"));
  const filename = join(directory, "main.sqlite3");
  const context = await createSqliteDatabase({
    busyTimeoutMs: 3_210,
    filename,
  });

  try {
    assert.deepEqual(context.inspectSqlitePragmas?.(), {
      busyTimeoutMs: 3_210,
      foreignKeys: true,
      journalMode: "wal",
      synchronous: 2,
    });
  } finally {
    await context.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("two independent SQLite connections serialize the same expected-version race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-sql-gate-"));
  const filename = join(directory, "main.sqlite3");
  const first = await SqlEventStore.openSqlite({
    busyTimeoutMs: 25,
    clock,
    filename,
    migrationMode: "apply",
  });
  const second = await SqlEventStore.openSqlite({
    busyTimeoutMs: 25,
    clock,
    filename,
    migrationMode: "verify",
  });

  try {
    const results = await Promise.allSettled([
      first.append({
        streamId: "task:cross-connection-race",
        expectedVersion: 0,
        events: [{ eventId: "event:connection:a", type: "task.created", payload: "a" }],
      }),
      second.append({
        streamId: "task:cross-connection-race",
        expectedVersion: 0,
        events: [{ eventId: "event:connection:b", type: "task.created", payload: "b" }],
      }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await first.readAll()).length, 1);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(directory, { force: true, recursive: true });
  }
});

test("startup rejects a changed migration checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-sql-checksum-"));
  const filename = join(directory, "main.sqlite3");
  const store = await SqlEventStore.openSqlite({
    clock,
    filename,
    migrationMode: "apply",
  });
  await store.close();

  const sqlite = new Database(filename);
  sqlite
    .prepare(
      `UPDATE od_migration_manifest
       SET checksum_sha256 = ?
       WHERE migration_name = ?`,
    )
    .run("0".repeat(64), "0001_event_store");
  sqlite.close();

  try {
    await assert.rejects(
      SqlEventStore.openSqlite({
        clock,
        filename,
        migrationMode: "verify",
      }),
      (error: unknown) =>
        error instanceof SqlStorageError && error.code === "MIGRATION_CHECKSUM_MISMATCH",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the PostgreSQL retry seam retries only serializable transaction failures", async () => {
  const backoffAttempts: number[] = [];
  let operationAttempts = 0;

  const result = await executeWithSqlRetry(
    "postgres",
    {
      maximumAttempts: 3,
      backoff: async (attempt) => {
        backoffAttempts.push(attempt);
      },
    },
    async () => {
      operationAttempts += 1;
      if (operationAttempts < 3) {
        throw Object.assign(new Error("serialization failure"), { code: "40001" });
      }
      return "committed";
    },
  );

  assert.equal(result, "committed");
  assert.equal(operationAttempts, 3);
  assert.deepEqual(backoffAttempts, [1, 2]);

  let nonRetryableAttempts = 0;
  await assert.rejects(
    executeWithSqlRetry(
      "postgres",
      {
        maximumAttempts: 3,
        backoff: async () => undefined,
      },
      async () => {
        nonRetryableAttempts += 1;
        throw Object.assign(new Error("unique violation"), { code: "23505" });
      },
    ),
    /unique violation/u,
  );
  assert.equal(nonRetryableAttempts, 1);
});
