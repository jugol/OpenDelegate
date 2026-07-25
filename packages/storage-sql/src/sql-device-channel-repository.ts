import { createHash } from "node:crypto";

import {
  DeviceChannelRepositoryError,
  decodeDeviceChannelFrame,
  encodeDeviceChannelFrame,
  type AcknowledgeOutboundInput,
  type CommitInboundResult,
  type DeviceChannelRepository,
  type DeviceChannelResumeState,
  type InboundEffectClaimResult,
  type InboundEffectCompletionResult,
  type MainToWorkerFrameV1,
  type ObserveDeviceChannelConnection,
  type WorkerToMainFrameV1,
} from "@opendelegate/device-channel";
import type { Selectable, Transaction } from "kysely";

import { parseSafeNonNegativeInteger } from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type {
  DeviceChannelInboxTable,
  DeviceChannelInboundEffectTable,
  DeviceChannelOutboxTable,
  DeviceChannelStateTable,
  SqlStorageSchema,
} from "./schema.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";

interface SqlDeviceChannelRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteDeviceChannelRepositoryOptions
  extends SqlDeviceChannelRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresDeviceChannelRepositoryOptions
  extends SqlDeviceChannelRepositoryOptions, PostgresDialectOptions {}

type StateRow = Selectable<DeviceChannelStateTable>;
type InboxRow = Selectable<DeviceChannelInboxTable>;
type InboundEffectRow = Selectable<DeviceChannelInboundEffectTable>;
type OutboxRow = Selectable<DeviceChannelOutboxTable>;

/**
 * Main-owned Device channel durability using the same selected SQL backend and
 * migration manifest as the rest of the Control Plane. Workers never receive this
 * repository or its database configuration.
 */
export class SqlDeviceChannelRepository implements DeviceChannelRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactions: SqlTransactionRunner;
  #closed = false;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactions = new SqlTransactionRunner(context.database, context.backend, retryPolicy);
  }

  public static async openSqlite(
    options: OpenSqliteDeviceChannelRepositoryOptions,
  ): Promise<SqlDeviceChannelRepository> {
    const context = await createSqliteDatabase(options);
    return this.#open(context, options);
  }

  public static async openPostgres(
    options: OpenPostgresDeviceChannelRepositoryOptions,
  ): Promise<SqlDeviceChannelRepository> {
    const context = await createPostgresDatabase(options);
    return this.#open(context, options);
  }

  public async observeConnection(input: ObserveDeviceChannelConnection): Promise<void> {
    this.#assertOpen();
    const deviceId = validateDeviceId(input.deviceId);
    const generation = readPositiveInteger(input.certificateGeneration, "certificate generation");
    await this.#transactions.write(async (transaction) => {
      const existing = await readState(transaction, deviceId);
      if (existing === undefined) {
        await transaction
          .insertInto("od_device_channel_state")
          .values({
            device_id: deviceId,
            certificate_generation: generation,
            last_worker_sequence: 0,
            acknowledged_main_sequence: 0,
            next_main_sequence: 1,
          })
          .execute();
        return;
      }
      const state = decodeState(existing);
      if (generation < state.certificateGeneration) {
        throw repositoryError(
          "CHANNEL_GENERATION_STALE",
          "A stale Device certificate generation cannot resume the channel.",
        );
      }
      if (generation > state.certificateGeneration) {
        const result = await transaction
          .updateTable("od_device_channel_state")
          .set({ certificate_generation: generation })
          .where("device_id", "=", deviceId)
          .where("certificate_generation", "=", state.certificateGeneration)
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw corruptState();
        }
      }
    });
  }

  public async commitInbound(frame: WorkerToMainFrameV1): Promise<CommitInboundResult> {
    this.#assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const encoded = encodeDeviceChannelFrame(parsed);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    return this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, parsed.senderDeviceId));
      const matches = await transaction
        .selectFrom("od_device_channel_inbox")
        .selectAll()
        .where("device_id", "=", parsed.senderDeviceId)
        .where((expression) =>
          expression.or([
            expression("message_id", "=", parsed.messageId),
            expression("idempotency_key", "=", parsed.idempotencyKey),
          ]),
        )
        .orderBy("sequence")
        .execute();
      if (matches.length > 0) {
        if (matches.length !== 1 || !sameInboundIdentity(matches[0]!, parsed, fingerprint)) {
          throw repositoryError(
            "CHANNEL_IDEMPOTENCY_CONFLICT",
            "A Device channel message identity was reused with different content.",
          );
        }
        return Object.freeze({
          disposition: "duplicate" as const,
          acknowledgedWorkerSequence: await readAcknowledgedWorkerSequence(
            transaction,
            parsed.senderDeviceId,
            state.lastWorkerSequence,
          ),
        });
      }
      if (parsed.sequence !== state.lastWorkerSequence + 1) {
        throw repositoryError(
          "CHANNEL_SEQUENCE_GAP",
          "The Worker channel sequence is not the next durable value.",
        );
      }
      try {
        await transaction
          .insertInto("od_device_channel_inbox")
          .values({
            device_id: parsed.senderDeviceId,
            sequence: parsed.sequence,
            message_id: parsed.messageId,
            idempotency_key: parsed.idempotencyKey,
            fingerprint,
            frame_json: encoded.toString("utf8"),
          })
          .execute();
        await transaction
          .insertInto("od_device_channel_inbound_effect")
          .values({
            device_id: parsed.senderDeviceId,
            sequence: parsed.sequence,
            status: "received",
            claim_id: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw repositoryError(
            "CHANNEL_IDEMPOTENCY_CONFLICT",
            "A Device channel message identity is already in use.",
          );
        }
        throw error;
      }
      const result = await transaction
        .updateTable("od_device_channel_state")
        .set({ last_worker_sequence: parsed.sequence })
        .where("device_id", "=", parsed.senderDeviceId)
        .where("last_worker_sequence", "=", state.lastWorkerSequence)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw corruptState();
      }
      return Object.freeze({
        disposition: "accepted" as const,
        acknowledgedWorkerSequence: await readAcknowledgedWorkerSequence(
          transaction,
          parsed.senderDeviceId,
          parsed.sequence,
        ),
      });
    });
  }

  public async claimInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectClaimResult> {
    this.#assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    return this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, parsed.senderDeviceId));
      await requireInboundIdentity(transaction, parsed, fingerprint);
      const effect = await requireInboundEffect(
        transaction,
        parsed.senderDeviceId,
        parsed.sequence,
      );
      const acknowledgedSequence = await readAcknowledgedWorkerSequence(
        transaction,
        parsed.senderDeviceId,
        state.lastWorkerSequence,
      );
      if (effect.status === "handled") {
        return Object.freeze({
          disposition: "handled" as const,
          acknowledgedSequence,
        });
      }
      if (effect.status === "processing") {
        return Object.freeze({
          disposition: "processing" as const,
          acknowledgedSequence,
        });
      }
      const result = await transaction
        .updateTable("od_device_channel_inbound_effect")
        .set({ status: "processing", claim_id: claimId })
        .where("device_id", "=", parsed.senderDeviceId)
        .where("sequence", "=", parsed.sequence)
        .where("status", "=", "received")
        .where("claim_id", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw corruptState();
      }
      return Object.freeze({
        disposition: "claimed" as const,
        acknowledgedSequence,
      });
    });
  }

  public async completeInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectCompletionResult> {
    this.#assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    return this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, parsed.senderDeviceId));
      await requireInboundIdentity(transaction, parsed, fingerprint);
      const effect = await requireInboundEffect(
        transaction,
        parsed.senderDeviceId,
        parsed.sequence,
      );
      if (effect.status === "handled") {
        return Object.freeze({
          acknowledgedSequence: await readAcknowledgedWorkerSequence(
            transaction,
            parsed.senderDeviceId,
            state.lastWorkerSequence,
          ),
        });
      }
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = await transaction
        .updateTable("od_device_channel_inbound_effect")
        .set({ status: "handled", claim_id: null })
        .where("device_id", "=", parsed.senderDeviceId)
        .where("sequence", "=", parsed.sequence)
        .where("status", "=", "processing")
        .where("claim_id", "=", claimId)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw invalidEffectClaim();
      }
      return Object.freeze({
        acknowledgedSequence: await readAcknowledgedWorkerSequence(
          transaction,
          parsed.senderDeviceId,
          state.lastWorkerSequence,
        ),
      });
    });
  }

  public async releaseInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<void> {
    this.#assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    await this.#transactions.write(async (transaction) => {
      await requireState(transaction, parsed.senderDeviceId);
      await requireInboundIdentity(transaction, parsed, fingerprint);
      const effect = await requireInboundEffect(
        transaction,
        parsed.senderDeviceId,
        parsed.sequence,
      );
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = await transaction
        .updateTable("od_device_channel_inbound_effect")
        .set({ status: "received", claim_id: null })
        .where("device_id", "=", parsed.senderDeviceId)
        .where("sequence", "=", parsed.sequence)
        .where("status", "=", "processing")
        .where("claim_id", "=", claimId)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw invalidEffectClaim();
      }
    });
  }

  public async enqueueOutbound(
    deviceIdInput: string,
    createFrame: (sequence: number) => MainToWorkerFrameV1,
  ): Promise<MainToWorkerFrameV1> {
    this.#assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    return this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, deviceId));
      let created: MainToWorkerFrameV1;
      try {
        created = createFrame(state.nextMainSequence);
      } catch {
        throw repositoryError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Device channel frame could not be created.",
        );
      }
      if (created.sequence !== state.nextMainSequence) {
        throw repositoryError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Device channel frame used the wrong durable sequence.",
        );
      }
      const parsed = normalizeMainFrame(created);
      const encoded = encodeDeviceChannelFrame(parsed).toString("utf8");
      const collision = await transaction
        .selectFrom("od_device_channel_outbox")
        .select(["sequence"])
        .where("device_id", "=", deviceId)
        .where((expression) =>
          expression.or([
            expression("sequence", "=", parsed.sequence),
            expression("message_id", "=", parsed.messageId),
            expression("idempotency_key", "=", parsed.idempotencyKey),
          ]),
        )
        .executeTakeFirst();
      if (collision !== undefined) {
        throw repositoryError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "The outbound Device channel identity is already in use.",
        );
      }
      try {
        await transaction
          .insertInto("od_device_channel_outbox")
          .values({
            device_id: deviceId,
            sequence: parsed.sequence,
            message_id: parsed.messageId,
            idempotency_key: parsed.idempotencyKey,
            frame_json: encoded,
          })
          .execute();
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw repositoryError(
            "CHANNEL_IDEMPOTENCY_CONFLICT",
            "The outbound Device channel identity is already in use.",
          );
        }
        throw error;
      }
      const result = await transaction
        .updateTable("od_device_channel_state")
        .set({ next_main_sequence: parsed.sequence + 1 })
        .where("device_id", "=", deviceId)
        .where("next_main_sequence", "=", state.nextMainSequence)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw corruptState();
      }
      return deepFreeze(parsed);
    });
  }

  public async acknowledgeOutbound(input: AcknowledgeOutboundInput): Promise<void> {
    this.#assertOpen();
    const deviceId = validateDeviceId(input.deviceId);
    const acknowledgedSequence = readNonNegativeInteger(
      input.acknowledgedMainSequence,
      "Main acknowledgment",
    );
    const messageIds = validateMessageIds(input.acknowledgedMessageIds);
    await this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, deviceId));
      if (acknowledgedSequence <= state.acknowledgedMainSequence) {
        return;
      }
      if (acknowledgedSequence >= state.nextMainSequence) {
        throw invalidAck();
      }
      const rows = await transaction
        .selectFrom("od_device_channel_outbox")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("sequence", ">", state.acknowledgedMainSequence)
        .where("sequence", "<=", acknowledgedSequence)
        .orderBy("sequence")
        .execute();
      if (
        rows.length !== acknowledgedSequence - state.acknowledgedMainSequence ||
        rows.length !== messageIds.length ||
        rows.some(
          (row, index) =>
            parseSafeSequence(row.sequence) !== state.acknowledgedMainSequence + index + 1 ||
            row.message_id !== messageIds[index],
        )
      ) {
        throw invalidAck();
      }
      const updated = await transaction
        .updateTable("od_device_channel_state")
        .set({ acknowledged_main_sequence: acknowledgedSequence })
        .where("device_id", "=", deviceId)
        .where("acknowledged_main_sequence", "=", state.acknowledgedMainSequence)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw corruptState();
      }
      const disposableSequences = rows
        .filter((row) => !isDurableCommandFrame(decodeOutboundFrame(row)))
        .map((row) => row.sequence);
      if (disposableSequences.length > 0) {
        await transaction
          .deleteFrom("od_device_channel_outbox")
          .where("device_id", "=", deviceId)
          .where("sequence", "in", disposableSequences)
          .execute();
      }
    });
  }

  public async outboundByIdempotencyKey(
    deviceIdInput: string,
    idempotencyKeyInput: string,
  ): Promise<MainToWorkerFrameV1 | undefined> {
    this.#assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    const idempotencyKey = validateFrameIdentity(idempotencyKeyInput, "idempotency key");
    return this.#transactions.write(async (transaction) => {
      await requireState(transaction, deviceId);
      const row = await transaction
        .selectFrom("od_device_channel_outbox")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      return row === undefined ? undefined : deepFreeze(decodeOutboundFrame(row));
    });
  }

  public async resume(deviceIdInput: string): Promise<DeviceChannelResumeState> {
    this.#assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    return this.#transactions.write(async (transaction) => {
      const state = decodeState(await requireState(transaction, deviceId));
      const rows = await transaction
        .selectFrom("od_device_channel_outbox")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("sequence", ">", state.acknowledgedMainSequence)
        .orderBy("sequence")
        .execute();
      const expectedCount = state.nextMainSequence - state.acknowledgedMainSequence - 1;
      if (
        rows.length !== expectedCount ||
        rows.some(
          (row, index) =>
            parseSafeSequence(row.sequence) !== state.acknowledgedMainSequence + index + 1,
        )
      ) {
        throw corruptState();
      }
      const pendingOutbound = rows.map(decodeOutboundFrame);
      return deepFreeze({
        acknowledgedWorkerSequence: await readAcknowledgedWorkerSequence(
          transaction,
          deviceId,
          state.lastWorkerSequence,
        ),
        acknowledgedMainSequence: state.acknowledgedMainSequence,
        nextMainSequence: state.nextMainSequence,
        pendingOutbound,
      });
    });
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
    options: SqlDeviceChannelRepositoryOptions,
  ): Promise<SqlDeviceChannelRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      const repository = new SqlDeviceChannelRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
      await repository.#recoverInterruptedInboundEffects();
      return repository;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw repositoryError(
        "CHANNEL_REPOSITORY_CLOSED",
        "The Device channel repository is closed.",
      );
    }
  }

  async #recoverInterruptedInboundEffects(): Promise<void> {
    await this.#transactions.write(async (transaction) => {
      await transaction
        .updateTable("od_device_channel_inbound_effect")
        .set({ status: "received", claim_id: null })
        .where("status", "=", "processing")
        .execute();
    });
  }
}

interface DecodedState {
  readonly acknowledgedMainSequence: number;
  readonly certificateGeneration: number;
  readonly lastWorkerSequence: number;
  readonly nextMainSequence: number;
}

async function readState(
  transaction: Transaction<SqlStorageSchema>,
  deviceId: string,
): Promise<StateRow | undefined> {
  return transaction
    .selectFrom("od_device_channel_state")
    .selectAll()
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
}

async function requireState(
  transaction: Transaction<SqlStorageSchema>,
  deviceId: string,
): Promise<StateRow> {
  const state = await readState(transaction, deviceId);
  if (state === undefined) {
    throw repositoryError(
      "CHANNEL_NOT_REGISTERED",
      "The Device channel has no authenticated connection state.",
    );
  }
  return state;
}

async function requireInboundIdentity(
  transaction: Transaction<SqlStorageSchema>,
  frame: WorkerToMainFrameV1,
  fingerprint: string,
): Promise<InboxRow> {
  const rows = await transaction
    .selectFrom("od_device_channel_inbox")
    .selectAll()
    .where("device_id", "=", frame.senderDeviceId)
    .where((expression) =>
      expression.or([
        expression("sequence", "=", frame.sequence),
        expression("message_id", "=", frame.messageId),
        expression("idempotency_key", "=", frame.idempotencyKey),
      ]),
    )
    .orderBy("sequence")
    .execute();
  if (rows.length !== 1 || !sameInboundIdentity(rows[0]!, frame, fingerprint)) {
    throw repositoryError(
      "CHANNEL_IDEMPOTENCY_CONFLICT",
      "The inbound Device channel effect does not match its durable frame.",
    );
  }
  return rows[0]!;
}

async function requireInboundEffect(
  transaction: Transaction<SqlStorageSchema>,
  deviceId: string,
  sequence: number,
): Promise<InboundEffectRow & { readonly status: "handled" | "processing" | "received" }> {
  const effect = await transaction
    .selectFrom("od_device_channel_inbound_effect")
    .selectAll()
    .where("device_id", "=", deviceId)
    .where("sequence", "=", sequence)
    .executeTakeFirst();
  if (
    effect === undefined ||
    !isInboundEffectStatus(effect.status) ||
    (effect.status === "processing") !== (effect.claim_id !== null)
  ) {
    throw corruptState();
  }
  return effect as InboundEffectRow & {
    readonly status: "handled" | "processing" | "received";
  };
}

async function readAcknowledgedWorkerSequence(
  transaction: Transaction<SqlStorageSchema>,
  deviceId: string,
  lastWorkerSequence: number,
): Promise<number> {
  const rows = await transaction
    .selectFrom("od_device_channel_inbox as inbox")
    .leftJoin("od_device_channel_inbound_effect as effect", (join) =>
      join
        .onRef("effect.device_id", "=", "inbox.device_id")
        .onRef("effect.sequence", "=", "inbox.sequence"),
    )
    .select(["inbox.sequence as sequence", "effect.status as status"])
    .where("inbox.device_id", "=", deviceId)
    .orderBy("inbox.sequence")
    .execute();
  if (
    rows.length !== lastWorkerSequence ||
    rows.some(
      (row, index) =>
        parseSafeSequence(row.sequence) !== index + 1 || !isInboundEffectStatus(row.status),
    )
  ) {
    throw corruptState();
  }
  let acknowledgedSequence = 0;
  for (const row of rows) {
    if (row.status !== "handled") {
      break;
    }
    acknowledgedSequence = parseSafeSequence(row.sequence);
  }
  return acknowledgedSequence;
}

function decodeState(row: StateRow): DecodedState {
  try {
    const certificateGeneration = parseSafeNonNegativeInteger(
      row.certificate_generation,
      "Device channel certificate generation",
    );
    const lastWorkerSequence = parseSafeNonNegativeInteger(
      row.last_worker_sequence,
      "Device channel Worker sequence",
    );
    const acknowledgedMainSequence = parseSafeNonNegativeInteger(
      row.acknowledged_main_sequence,
      "Device channel Main acknowledgment",
    );
    const nextMainSequence = parseSafeNonNegativeInteger(
      row.next_main_sequence,
      "Device channel next Main sequence",
    );
    if (
      certificateGeneration < 1 ||
      nextMainSequence < 1 ||
      acknowledgedMainSequence >= nextMainSequence
    ) {
      throw corruptState();
    }
    return {
      certificateGeneration,
      lastWorkerSequence,
      acknowledgedMainSequence,
      nextMainSequence,
    };
  } catch (error) {
    if (error instanceof DeviceChannelRepositoryError) {
      throw error;
    }
    throw corruptState();
  }
}

function decodeOutboundFrame(row: OutboxRow): MainToWorkerFrameV1 {
  const sequence = parseSafeSequence(row.sequence);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.frame_json);
  } catch {
    throw corruptState();
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { sequence?: unknown }).sequence !== sequence ||
    (parsed as { messageId?: unknown }).messageId !== row.message_id ||
    (parsed as { idempotencyKey?: unknown }).idempotencyKey !== row.idempotency_key
  ) {
    throw corruptState();
  }
  try {
    const senderDeviceId = (parsed as { senderDeviceId?: unknown }).senderDeviceId;
    if (typeof senderDeviceId !== "string") {
      throw corruptState();
    }
    return decodeDeviceChannelFrame(
      Buffer.from(row.frame_json, "utf8"),
      senderDeviceId,
      "main-to-worker",
    ) as MainToWorkerFrameV1;
  } catch {
    throw corruptState();
  }
}

function sameInboundIdentity(
  row: InboxRow,
  frame: WorkerToMainFrameV1,
  fingerprint: string,
): boolean {
  return (
    parseSafeSequence(row.sequence) === frame.sequence &&
    row.message_id === frame.messageId &&
    row.idempotency_key === frame.idempotencyKey &&
    row.fingerprint === fingerprint
  );
}

function normalizeWorkerFrame(frame: WorkerToMainFrameV1): WorkerToMainFrameV1 {
  try {
    return decodeDeviceChannelFrame(
      encodeDeviceChannelFrame(frame),
      frame.senderDeviceId,
      "worker-to-main",
    ) as WorkerToMainFrameV1;
  } catch {
    throw repositoryError(
      "CHANNEL_CONFIGURATION_INVALID",
      "The inbound Device channel frame is invalid.",
    );
  }
}

function normalizeMainFrame(frame: MainToWorkerFrameV1): MainToWorkerFrameV1 {
  try {
    return decodeDeviceChannelFrame(
      encodeDeviceChannelFrame(frame),
      frame.senderDeviceId,
      "main-to-worker",
    ) as MainToWorkerFrameV1;
  } catch {
    throw repositoryError(
      "CHANNEL_CONFIGURATION_INVALID",
      "The outbound Device channel frame is invalid.",
    );
  }
}

function validateDeviceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw repositoryError(
      "CHANNEL_CONFIGURATION_INVALID",
      "The Device channel Device ID is invalid.",
    );
  }
  return value;
}

function validateMessageIds(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (entry, index) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > 256 ||
        entry !== entry.trim() ||
        value.indexOf(entry) !== index,
    )
  ) {
    throw invalidAck();
  }
  return value;
}

function validateFrameIdentity(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw repositoryError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function isInboundEffectStatus(value: unknown): value is "handled" | "processing" | "received" {
  return value === "handled" || value === "processing" || value === "received";
}

function isDurableCommandFrame(frame: MainToWorkerFrameV1): boolean {
  return (
    frame.type === "main.control" || frame.type === "main.dispatch" || frame.type === "main.revoked"
  );
}

function readPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw repositoryError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function readNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function parseSafeSequence(value: number | string | bigint): number {
  try {
    return parseSafeNonNegativeInteger(value, "Device channel sequence");
  } catch {
    throw corruptState();
  }
}

function invalidAck(): DeviceChannelRepositoryError {
  return repositoryError(
    "CHANNEL_ACK_INVALID",
    "The Worker acknowledgment is not an exact ordered prefix of the Main outbox.",
  );
}

function invalidEffectClaim(): DeviceChannelRepositoryError {
  return repositoryError(
    "CHANNEL_EFFECT_CLAIM_INVALID",
    "The inbound Device channel effect claim is no longer current.",
  );
}

function corruptState(): DeviceChannelRepositoryError {
  return repositoryError("CHANNEL_STATE_CORRUPT", "The durable Device channel state is invalid.");
}

function repositoryError(
  code: DeviceChannelRepositoryError["code"],
  message: string,
): DeviceChannelRepositoryError {
  return new DeviceChannelRepositoryError(code, message);
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = Reflect.get(error, "code");
  return code === "23505" || (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"));
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
