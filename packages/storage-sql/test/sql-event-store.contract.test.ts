import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { EventStoreError, type EventClock } from "@opendelegate/event-store";
import { Pool } from "pg";

import { SqlEventStore, SqlStorageError, type SqlMigrationMode } from "../src/index.ts";

const clock: EventClock = {
  now: () => "2026-07-24T05:00:00.000Z",
};

interface EventStoreFixture {
  open(mode: SqlMigrationMode): Promise<SqlEventStore>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<EventStoreFixture>;

function registerEventStoreContract(label: string, createFixture: FixtureFactory): void {
  describe(`${label} event store contract`, () => {
    test("appends, replays idempotently, and survives reopen", async () => {
      const fixture = await createFixture();
      let store: SqlEventStore | undefined;

      try {
        store = await fixture.open("apply");
        const draft = {
          streamId: "task:alpha",
          expectedVersion: 0,
          occurredAt: "2026-07-24T05:01:02.003Z",
          events: [
            {
              eventId: "event:alpha:1",
              type: "task.created",
              payload: {
                objective: "Keep the durable Task context isolated.",
                nested: { enabled: true, value: -0 },
              },
            },
          ],
        } as const;

        const first = await store.append(draft);
        const replayedAppend = await store.append(draft);

        assert.deepEqual(replayedAppend, first);
        assert.equal(first[0]?.occurredAt, draft.occurredAt);
        assert.equal(await store.streamVersion(draft.streamId), 1);
        assert.deepEqual(await store.readStream(draft.streamId), first);
        assert.deepEqual(
          await store.replay(draft.streamId, [] as string[], (types, event) => [
            ...types,
            event.type,
          ]),
          ["task.created"],
        );
        assert.equal(
          Object.is((first[0]?.payload as { nested: { value: number } }).nested.value, -0),
          true,
        );

        await store.close();
        store = await fixture.open("verify");

        assert.deepEqual(await store.readStream(draft.streamId), first);
      } finally {
        await store?.close();
        await fixture.cleanup();
      }
    });

    test("preserves global order and rejects stale writers or conflicting event IDs", async () => {
      const fixture = await createFixture();
      const store = await fixture.open("apply");

      try {
        await store.append({
          streamId: "task:first",
          expectedVersion: 0,
          events: [
            { eventId: "event:1", type: "task.created", payload: { order: 1 } },
            { eventId: "event:2", type: "task.queued", payload: { order: 2 } },
          ],
        });
        await store.append({
          streamId: "task:second",
          expectedVersion: 0,
          events: [{ eventId: "event:3", type: "task.created", payload: { order: 3 } }],
        });

        assert.deepEqual(
          (await store.readAll()).map((event) => [event.globalPosition, event.eventId]),
          [
            [1, "event:1"],
            [2, "event:2"],
            [3, "event:3"],
          ],
        );

        await assert.rejects(
          store.append({
            streamId: "task:first",
            expectedVersion: 0,
            events: [{ eventId: "event:4", type: "task.failed", payload: { order: 4 } }],
          }),
          (error: unknown) =>
            error instanceof EventStoreError && error.code === "STREAM_VERSION_CONFLICT",
        );

        await assert.rejects(
          store.append({
            streamId: "task:other",
            expectedVersion: 0,
            events: [
              {
                eventId: "event:1",
                type: "task.created",
                payload: { order: "different" },
              },
            ],
          }),
          (error: unknown) =>
            error instanceof EventStoreError && error.code === "EVENT_ID_CONFLICT",
        );
      } finally {
        await store.close();
        await fixture.cleanup();
      }
    });

    test("allows exactly one concurrent writer for the same expected version", async () => {
      const fixture = await createFixture();
      const store = await fixture.open("apply");

      try {
        const results = await Promise.allSettled([
          store.append({
            streamId: "task:race",
            expectedVersion: 0,
            events: [{ eventId: "event:race:a", type: "task.created", payload: "a" }],
          }),
          store.append({
            streamId: "task:race",
            expectedVersion: 0,
            events: [{ eventId: "event:race:b", type: "task.created", payload: "b" }],
          }),
        ]);

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );

        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0]?.reason instanceof EventStoreError, true);
        assert.equal((rejected[0]?.reason as EventStoreError).code, "STREAM_VERSION_CONFLICT");
        assert.equal((await store.readAll()).length, 1);
      } finally {
        await store.close();
        await fixture.cleanup();
      }
    });
  });
}

async function createSqliteFixture(): Promise<EventStoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-storage-sql-"));
  const filename = join(directory, "main.sqlite3");

  return {
    open: (migrationMode) =>
      SqlEventStore.openSqlite({
        clock,
        filename,
        migrationMode,
      }),
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

registerEventStoreContract("SQLite", createSqliteFixture);

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });
const postgresSchemas: string[] = [];

after(async () => {
  if (postgresAdminPool === undefined) {
    return;
  }

  for (const schema of postgresSchemas) {
    await postgresAdminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
  await postgresAdminPool.end();
});

if (postgresUri !== undefined) {
  registerEventStoreContract("PostgreSQL", async () => {
    const schema = `od_test_${randomUUID().replaceAll("-", "")}`;
    postgresSchemas.push(schema);
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);

    return {
      open: (migrationMode) =>
        SqlEventStore.openPostgres({
          clock,
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      cleanup: async () => undefined,
    };
  });
}

test("a fresh database refuses normal startup while migration 0001 is pending", async () => {
  const fixture = await createSqliteFixture();

  try {
    await assert.rejects(
      fixture.open("verify"),
      (error: unknown) => error instanceof SqlStorageError && error.code === "MIGRATION_PENDING",
    );
  } finally {
    await fixture.cleanup();
  }
});
