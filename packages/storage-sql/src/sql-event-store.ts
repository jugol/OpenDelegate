import { isDeepStrictEqual } from "node:util";

import {
  EventStoreError,
  type AppendEvents,
  type EventClock,
  type EventStore,
  type StoredEvent,
} from "@opendelegate/event-store";
import { type Selectable, type Transaction } from "kysely";

import {
  assertRfc3339Instant,
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
import type { EventsTable, SqlStorageSchema } from "./schema.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

export type SqlMigrationMode = "apply" | "verify";

interface SqlEventStoreOptions {
  readonly clock: EventClock;
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteEventStoreOptions extends SqlEventStoreOptions, SqliteDialectOptions {}

export interface OpenPostgresEventStoreOptions
  extends SqlEventStoreOptions, PostgresDialectOptions {}

export class SqlEventStore implements EventStore {
  private readonly clock: EventClock;
  private readonly context: SqlDatabaseContext;
  private readonly transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, clock: EventClock, retryPolicy: SqlRetryPolicy) {
    this.context = context;
    this.clock = clock;
    this.transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
      context.writeCoordinator,
    );
  }

  public static async openSqlite(options: OpenSqliteEventStoreOptions): Promise<SqlEventStore> {
    const context = await createSqliteDatabase(options);
    return this.open(context, options);
  }

  public static async openPostgres(options: OpenPostgresEventStoreOptions): Promise<SqlEventStore> {
    const context = await createPostgresDatabase(options);
    return this.open(context, options);
  }

  public async append(input: AppendEvents): Promise<readonly StoredEvent[]> {
    validateAppend(input);
    const canonicalPayloads = input.events.map((event) => encodeCanonicalJson(event.payload));

    return this.transactionRunner.write(async (transaction) => {
      const replay = await this.findReplay(transaction, input);
      if (replay !== undefined) {
        return replay;
      }

      const stream = await transaction
        .selectFrom("od_event_streams")
        .select("version")
        .where("stream_id", "=", input.streamId)
        .executeTakeFirst();
      const currentVersion =
        stream === undefined ? 0 : parseSafeNonNegativeInteger(stream.version, "Stream version");

      if (currentVersion !== input.expectedVersion) {
        throw new EventStoreError(
          "STREAM_VERSION_CONFLICT",
          `Stream ${input.streamId} is at version ${currentVersion}, not expected version ${input.expectedVersion}.`,
        );
      }

      const occurredAt = input.occurredAt ?? this.clock.now();
      assertClockInstant(occurredAt);

      if (stream === undefined) {
        await transaction
          .insertInto("od_event_streams")
          .values({ stream_id: input.streamId, version: 0 })
          .execute();
      }

      const gate = await transaction
        .selectFrom("od_write_gate")
        .select("next_global_position")
        .where("singleton_id", "=", 1)
        .executeTakeFirstOrThrow();
      const firstGlobalPosition = parseSafeNonNegativeInteger(
        gate.next_global_position,
        "Next global event position",
      );
      const nextGlobalPosition = firstGlobalPosition + input.events.length;
      if (!Number.isSafeInteger(nextGlobalPosition)) {
        throw new SqlStorageError(
          "DATA_CORRUPT",
          "The global event position exhausted the supported safe integer range.",
        );
      }

      const storedEvents = input.events.map((event, index) =>
        deepFreeze({
          eventId: event.eventId,
          streamId: input.streamId,
          streamVersion: currentVersion + index + 1,
          globalPosition: firstGlobalPosition + index,
          type: event.type,
          occurredAt,
          payload: decodeCanonicalJson(canonicalPayloads[index] ?? "null"),
        }),
      );

      await transaction
        .insertInto("od_events")
        .values(
          storedEvents.map((event, index) => ({
            event_id: event.eventId,
            event_type: event.type,
            global_position: event.globalPosition,
            occurred_at: event.occurredAt,
            payload_json: canonicalPayloads[index] ?? "null",
            stream_id: event.streamId,
            stream_version: event.streamVersion,
          })),
        )
        .execute();

      const streamUpdate = await transaction
        .updateTable("od_event_streams")
        .set({ version: currentVersion + storedEvents.length })
        .where("stream_id", "=", input.streamId)
        .where("version", "=", currentVersion)
        .executeTakeFirst();
      if (streamUpdate.numUpdatedRows !== 1n) {
        throw new EventStoreError(
          "STREAM_VERSION_CONFLICT",
          `Stream ${input.streamId} changed during append.`,
        );
      }

      await transaction
        .updateTable("od_write_gate")
        .set({ next_global_position: nextGlobalPosition })
        .where("singleton_id", "=", 1)
        .execute();

      return Object.freeze(storedEvents);
    });
  }

  public async readStream(streamId: string): Promise<readonly StoredEvent[]> {
    const rows = await this.context.database
      .selectFrom("od_events")
      .selectAll()
      .where("stream_id", "=", streamId)
      .orderBy("stream_version")
      .execute();
    return Object.freeze(rows.map(decodeStoredEvent));
  }

  public async readAll(): Promise<readonly StoredEvent[]> {
    const rows = await this.context.database
      .selectFrom("od_events")
      .selectAll()
      .orderBy("global_position")
      .execute();
    return Object.freeze(rows.map(decodeStoredEvent));
  }

  public async streamVersion(streamId: string): Promise<number> {
    const row = await this.context.database
      .selectFrom("od_event_streams")
      .select("version")
      .where("stream_id", "=", streamId)
      .executeTakeFirst();
    return row === undefined ? 0 : parseSafeNonNegativeInteger(row.version, "Stream version");
  }

  public async replay<TProjection>(
    streamId: string,
    initial: TProjection,
    apply: (projection: TProjection, event: StoredEvent) => TProjection,
  ): Promise<TProjection> {
    return (await this.readStream(streamId)).reduce(apply, initial);
  }

  public async close(): Promise<void> {
    await this.context.close();
  }

  private static async open(
    context: SqlDatabaseContext,
    options: SqlEventStoreOptions,
  ): Promise<SqlEventStore> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlEventStore(
        context,
        options.clock,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  private async findReplay(
    transaction: Transaction<SqlStorageSchema>,
    input: AppendEvents,
  ): Promise<readonly StoredEvent[] | undefined> {
    const eventIds = input.events.map((event) => event.eventId);
    const rows = await transaction
      .selectFrom("od_events")
      .selectAll()
      .where("event_id", "in", eventIds)
      .execute();

    if (rows.length === 0) {
      return undefined;
    }
    if (rows.length !== input.events.length) {
      throw new EventStoreError(
        "EVENT_BATCH_PARTIAL_REPLAY",
        "An append batch cannot mix replayed and new event identifiers.",
      );
    }

    const storedById = new Map(
      rows.map((row) => {
        const event = decodeStoredEvent(row);
        return [event.eventId, event] as const;
      }),
    );

    return Object.freeze(
      input.events.map((draft, index) => {
        const storedEvent = storedById.get(draft.eventId);
        if (
          storedEvent === undefined ||
          storedEvent.streamId !== input.streamId ||
          (input.events.length > 1 &&
            storedEvent.streamVersion !== input.expectedVersion + index + 1) ||
          storedEvent.type !== draft.type ||
          !isDeepStrictEqual(storedEvent.payload, draft.payload)
        ) {
          throw new EventStoreError(
            storedEvent?.eventId === draft.eventId &&
              storedEvent?.streamId === input.streamId &&
              storedEvent?.type === draft.type &&
              isDeepStrictEqual(storedEvent?.payload, draft.payload)
              ? "EVENT_BATCH_REPLAY_MISMATCH"
              : "EVENT_ID_CONFLICT",
            `Event ID ${draft.eventId} does not match this append position and content.`,
          );
        }
        return storedEvent;
      }),
    );
  }
}

function decodeStoredEvent(row: Selectable<EventsTable>): StoredEvent {
  const streamVersion = parseSafeNonNegativeInteger(row.stream_version, "Stream version");
  const globalPosition = parseSafeNonNegativeInteger(row.global_position, "Global event position");
  if (streamVersion === 0 || globalPosition === 0) {
    throw new SqlStorageError("DATA_CORRUPT", "Stored event positions must be greater than zero.");
  }
  assertRfc3339Instant(row.occurred_at);

  return deepFreeze({
    eventId: row.event_id,
    streamId: row.stream_id,
    streamVersion,
    globalPosition,
    type: row.event_type,
    occurredAt: row.occurred_at,
    payload: decodeCanonicalJson(row.payload_json),
  });
}

function validateAppend(input: AppendEvents): void {
  assertNonBlank(input.streamId, "Stream ID");
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.events.length === 0
  ) {
    throw new EventStoreError(
      "EVENT_INPUT_INVALID",
      "An append requires a non-negative expected version and at least one event.",
    );
  }

  const batchIds = new Set<string>();
  for (const event of input.events) {
    assertNonBlank(event.eventId, "Event ID");
    assertNonBlank(event.type, "Event type");
    if (batchIds.has(event.eventId)) {
      throw new EventStoreError(
        "EVENT_ID_CONFLICT",
        `Event ID ${event.eventId} appears more than once in one append batch.`,
      );
    }
    batchIds.add(event.eventId);
    try {
      encodeCanonicalJson(event.payload);
    } catch {
      throw new EventStoreError(
        "EVENT_PAYLOAD_UNSERIALIZABLE",
        "Event payloads must be finite JSON-compatible values without cycles or accessors.",
      );
    }
  }
}

function assertNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventStoreError("EVENT_INPUT_INVALID", `${label} must be a non-blank string.`);
  }
}

function assertClockInstant(value: string): void {
  try {
    assertRfc3339Instant(value);
  } catch {
    throw new EventStoreError(
      "CLOCK_VALUE_INVALID",
      "The event clock must return a valid RFC 3339 instant.",
    );
  }
}
