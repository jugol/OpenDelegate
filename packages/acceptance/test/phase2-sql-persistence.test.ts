import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { type EventClock, type EventStore } from "@opendelegate/event-store";
import { SqlEventStore, type SqlMigrationMode } from "@opendelegate/storage-sql";
import { Pool } from "pg";

import {
  createRichPhase1Harness,
  type RichPhase1EventStoreLifecycle,
} from "../src/phase1-public-contract-harness.ts";

interface SqlJourneyFixture extends RichPhase1EventStoreLifecycle {
  inspect(clock: EventClock): Promise<SqlEventStore>;
  cleanup(): Promise<void>;
}

test("the unchanged rich Task journey survives two real SQLite process-store restarts", async (t) => {
  const fixture = await createSqliteFixture();
  await provePersistentRichJourney(t, fixture);
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
if (postgresUri !== undefined) {
  test("the unchanged rich Task journey survives two real PostgreSQL connection restarts", async (t) => {
    const fixture = await createPostgresFixture(postgresUri);
    await provePersistentRichJourney(t, fixture);
  });
}

async function provePersistentRichJourney(
  t: TestContext,
  fixture: SqlJourneyFixture,
): Promise<void> {
  const knowledgeRoot = await mkdtemp(join(tmpdir(), "opendelegate-phase2-knowledge-"));
  t.after(async () => {
    await Promise.all([rm(knowledgeRoot, { force: true, recursive: true }), fixture.cleanup()]);
  });

  const harness = await createRichPhase1Harness({
    eventStoreLifecycle: fixture,
    knowledgeRoot,
    scenario: "allowed",
  });
  const result = await harness.execute();

  assert.equal(result.task.state, "completed");
  assert.equal(result.evidence.restartCount, 2);
  assert.equal(result.evidence.replayMatched, true);

  const inspection = await fixture.inspect(fixedClock());
  try {
    assert.deepEqual(
      (await inspection.readAll()).map((event) => event.type),
      result.journalEventTypes,
    );
    assert.equal((await inspection.readAll()).at(-1)?.type, "task.completed");
  } finally {
    await inspection.close();
  }
}

async function createSqliteFixture(): Promise<SqlJourneyFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-phase2-sqlite-"));
  const filename = join(directory, "main.sqlite3");
  let migrated = false;

  const open = async (clock: EventClock): Promise<SqlEventStore> => {
    const migrationMode: SqlMigrationMode = migrated ? "verify" : "apply";
    const store = await SqlEventStore.openSqlite({
      clock,
      filename,
      migrationMode,
    });
    migrated = true;
    return store;
  };

  return {
    open,
    restart: async (current, clock) => {
      await closeSqlEventStore(current);
      return open(clock);
    },
    close: closeSqlEventStore,
    inspect: (clock) =>
      SqlEventStore.openSqlite({
        clock,
        filename,
        migrationMode: "verify",
      }),
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

async function createPostgresFixture(connectionString: string): Promise<SqlJourneyFixture> {
  const schema = `od_acceptance_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  let migrated = false;

  const open = async (clock: EventClock): Promise<SqlEventStore> => {
    const migrationMode: SqlMigrationMode = migrated ? "verify" : "apply";
    const store = await SqlEventStore.openPostgres({
      clock,
      connectionString,
      migrationMode,
      schema,
    });
    migrated = true;
    return store;
  };

  return {
    open,
    restart: async (current, clock) => {
      await closeSqlEventStore(current);
      return open(clock);
    },
    close: closeSqlEventStore,
    inspect: (clock) =>
      SqlEventStore.openPostgres({
        clock,
        connectionString,
        migrationMode: "verify",
        schema,
      }),
    cleanup: async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

async function closeSqlEventStore(store: EventStore): Promise<void> {
  if (!(store instanceof SqlEventStore)) {
    throw new Error("The SQL acceptance lifecycle received an unexpected EventStore.");
  }
  await store.close();
}

function fixedClock(): EventClock {
  return {
    now: () => "2026-07-24T12:00:00.000Z",
  };
}
