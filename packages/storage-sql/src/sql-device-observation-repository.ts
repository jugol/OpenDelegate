import { createHash } from "node:crypto";

import { validateWorkerHeartbeat, type WorkerHeartbeatV1 } from "@opendelegate/device-channel";
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
import type { DeviceObservationEventTable, SqlStorageSchema } from "./schema.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

const MAXIMUM_OBSERVATION_PAYLOAD_BYTES = 1_048_576;
const MAXIMUM_DEVICE_COUNT = 10_000;
const MAXIMUM_EVENT_PAGE_SIZE = 1_000;
const MAXIMUM_TIMESTAMP_MS = 8_640_000_000_000_000;

interface SqlDeviceObservationRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteDeviceObservationRepositoryOptions
  extends SqlDeviceObservationRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresDeviceObservationRepositoryOptions
  extends SqlDeviceObservationRepositoryOptions, PostgresDialectOptions {}

export interface AcceptDeviceObservationInput {
  readonly authenticatedDeviceId: string;
  readonly acceptedAtMs: number;
  readonly heartbeat: WorkerHeartbeatV1;
}

export interface AcceptDeviceObservationResult {
  readonly disposition: "accepted" | "duplicate" | "stale";
  readonly observationSequence: number;
}

export interface DurableDeviceObservation {
  readonly deviceId: string;
  readonly observationSequence: number;
  readonly observedAtMs: number;
  readonly acceptedAtMs: number;
  readonly heartbeat: WorkerHeartbeatV1;
}

type EventRow = Selectable<DeviceObservationEventTable>;

/**
 * Main-owned accepted Device observations. The event table is append-only and
 * the latest table is only a materialized pointer. It never stores Worker
 * Knowledge, local paths, raw probe output, or Secret values because the
 * heartbeat is revalidated against the bounded Device-channel schema.
 */
export class SqlDeviceObservationRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactions: SqlTransactionRunner;
  #closed = false;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactions = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
      context.writeCoordinator,
    );
  }

  public static async openSqlite(
    options: OpenSqliteDeviceObservationRepositoryOptions,
  ): Promise<SqlDeviceObservationRepository> {
    const context = await createSqliteDatabase(options);
    return this.#open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresDeviceObservationRepositoryOptions,
  ): Promise<SqlDeviceObservationRepository> {
    const context = await createPostgresDatabase(options);
    return this.#open(context, options);
  }

  public async accept(input: AcceptDeviceObservationInput): Promise<AcceptDeviceObservationResult> {
    this.#assertOpen();
    const deviceId = validateDeviceId(input.authenticatedDeviceId);
    const heartbeat = validateHeartbeat(input.heartbeat, deviceId);
    const acceptedAtMs = validateTimestamp(input.acceptedAtMs, "accepted observation time");
    const payloadJson = encodeCanonicalJson(heartbeat);
    if (Buffer.byteLength(payloadJson, "utf8") > MAXIMUM_OBSERVATION_PAYLOAD_BYTES) {
      throw configurationError("The Device observation exceeds its durable payload bound.");
    }
    const payloadSha256 = sha256(payloadJson);

    return await this.#transactions.write(async (transaction) => {
      const latest = await readLatestEvent(transaction, deviceId);
      if (latest !== undefined) {
        const decoded = decodeEvent(latest);
        if (heartbeat.observedAtMs < decoded.observedAtMs) {
          return deepFreeze({
            disposition: "stale" as const,
            observationSequence: decoded.observationSequence,
          });
        }
        if (heartbeat.observedAtMs === decoded.observedAtMs) {
          if (latest.payload_sha256 !== payloadSha256 || latest.payload_json !== payloadJson) {
            throw configurationError(
              "One Device observation time was reused with different heartbeat content.",
            );
          }
          return deepFreeze({
            disposition: "duplicate" as const,
            observationSequence: decoded.observationSequence,
          });
        }
      }

      const observationSequence =
        latest === undefined
          ? 1
          : parsePositiveSequence(latest.observation_sequence, "Device observation sequence") + 1;
      if (!Number.isSafeInteger(observationSequence)) {
        throw corruptData("The Device observation sequence exhausted its supported range.");
      }
      await transaction
        .insertInto("od_device_observation_events")
        .values({
          device_id: deviceId,
          observation_sequence: observationSequence,
          observed_at_ms: heartbeat.observedAtMs,
          accepted_at_ms: acceptedAtMs,
          payload_json: payloadJson,
          payload_sha256: payloadSha256,
        })
        .execute();
      await transaction
        .insertInto("od_device_observation_latest")
        .values({
          device_id: deviceId,
          observation_sequence: observationSequence,
        })
        .onConflict((conflict) =>
          conflict.column("device_id").doUpdateSet({
            observation_sequence: observationSequence,
          }),
        )
        .execute();
      return deepFreeze({
        disposition: "accepted" as const,
        observationSequence,
      });
    });
  }

  public async latest(deviceIdInput: string): Promise<DurableDeviceObservation | undefined> {
    this.#assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    const row = await this.#context.database
      .selectFrom("od_device_observation_latest as latest")
      .innerJoin("od_device_observation_events as event", (join) =>
        join
          .onRef("event.device_id", "=", "latest.device_id")
          .onRef("event.observation_sequence", "=", "latest.observation_sequence"),
      )
      .select([
        "event.device_id",
        "event.observation_sequence",
        "event.observed_at_ms",
        "event.accepted_at_ms",
        "event.payload_json",
        "event.payload_sha256",
      ])
      .where("latest.device_id", "=", deviceId)
      .executeTakeFirst();
    return row === undefined ? undefined : decodeEvent(row);
  }

  public async listLatest(): Promise<readonly DurableDeviceObservation[]> {
    this.#assertOpen();
    const rows = await this.#context.database
      .selectFrom("od_device_observation_latest as latest")
      .innerJoin("od_device_observation_events as event", (join) =>
        join
          .onRef("event.device_id", "=", "latest.device_id")
          .onRef("event.observation_sequence", "=", "latest.observation_sequence"),
      )
      .select([
        "event.device_id",
        "event.observation_sequence",
        "event.observed_at_ms",
        "event.accepted_at_ms",
        "event.payload_json",
        "event.payload_sha256",
      ])
      .orderBy("event.device_id")
      .limit(MAXIMUM_DEVICE_COUNT + 1)
      .execute();
    if (rows.length > MAXIMUM_DEVICE_COUNT) {
      throw corruptData("The durable Device fleet exceeds its supported personal-instance bound.");
    }
    return deepFreeze(rows.map(decodeEvent));
  }

  public async listEvents(
    deviceIdInput: string,
    limit = 100,
  ): Promise<readonly DurableDeviceObservation[]> {
    this.#assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_EVENT_PAGE_SIZE) {
      throw configurationError("The Device observation event page size is invalid.");
    }
    const rows = await this.#context.database
      .selectFrom("od_device_observation_events")
      .selectAll()
      .where("device_id", "=", deviceId)
      .orderBy("observation_sequence", "desc")
      .limit(limit)
      .execute();
    return deepFreeze(rows.reverse().map(decodeEvent));
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#context.close();
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlDeviceObservationRepositoryOptions,
  ): Promise<SqlDeviceObservationRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlDeviceObservationRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SqlStorageError(
        "STORAGE_UNAVAILABLE",
        "The Device observation repository is closed.",
      );
    }
  }
}

async function readLatestEvent(
  transaction: Transaction<SqlStorageSchema>,
  deviceId: string,
): Promise<EventRow | undefined> {
  return await transaction
    .selectFrom("od_device_observation_latest as latest")
    .innerJoin("od_device_observation_events as event", (join) =>
      join
        .onRef("event.device_id", "=", "latest.device_id")
        .onRef("event.observation_sequence", "=", "latest.observation_sequence"),
    )
    .select([
      "event.device_id",
      "event.observation_sequence",
      "event.observed_at_ms",
      "event.accepted_at_ms",
      "event.payload_json",
      "event.payload_sha256",
    ])
    .where("latest.device_id", "=", deviceId)
    .executeTakeFirst();
}

function decodeEvent(row: EventRow): DurableDeviceObservation {
  const observationSequence = parsePositiveSequence(
    row.observation_sequence,
    "Device observation sequence",
  );
  const observedAtMs = parseTimestamp(row.observed_at_ms, "Device observation time");
  const acceptedAtMs = parseTimestamp(row.accepted_at_ms, "Device observation acceptance time");
  if (sha256(row.payload_json) !== row.payload_sha256) {
    throw corruptData("A durable Device observation failed its integrity check.");
  }
  let heartbeat: WorkerHeartbeatV1;
  try {
    heartbeat = validateWorkerHeartbeat(decodeCanonicalJson(row.payload_json));
  } catch (error) {
    throw corruptData("A durable Device observation is outside the heartbeat contract.", error);
  }
  if (heartbeat.deviceId !== row.device_id || heartbeat.observedAtMs !== observedAtMs) {
    throw corruptData("A durable Device observation does not match its indexed identity.");
  }
  return deepFreeze({
    deviceId: row.device_id,
    observationSequence,
    observedAtMs,
    acceptedAtMs,
    heartbeat,
  });
}

function validateHeartbeat(value: unknown, authenticatedDeviceId: string): WorkerHeartbeatV1 {
  let heartbeat: WorkerHeartbeatV1;
  try {
    heartbeat = validateWorkerHeartbeat(value);
  } catch (error) {
    throw configurationError("The accepted Device heartbeat is invalid.", error);
  }
  if (heartbeat.deviceId !== authenticatedDeviceId) {
    throw configurationError("The heartbeat identity does not match the authenticated Device.");
  }
  return heartbeat;
}

function validateDeviceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw configurationError("The Device observation Device ID is invalid.");
  }
  return value;
}

function validateTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAXIMUM_TIMESTAMP_MS) {
    throw configurationError(`The ${label} is invalid.`);
  }
  return value;
}

function parseTimestamp(value: number | string | bigint, label: string): number {
  const parsed = parseSafeNonNegativeInteger(value, label);
  if (parsed > MAXIMUM_TIMESTAMP_MS) {
    throw corruptData(`The ${label} is outside the supported range.`);
  }
  return parsed;
}

function parsePositiveSequence(value: number | string | bigint, label: string): number {
  const parsed = parseSafeNonNegativeInteger(value, label);
  if (parsed < 1) {
    throw corruptData(`The ${label} is invalid.`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function configurationError(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError(
    "STORAGE_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function corruptData(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("DATA_CORRUPT", message, cause === undefined ? undefined : { cause });
}
