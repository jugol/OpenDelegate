import { isDeepStrictEqual } from "node:util";

import {
  DiscordAdapterError,
  type DiscordGatewayCursor,
  type DiscordInboundRecord,
  type DiscordOutboxAction,
  type DiscordOutboxItem,
  type DiscordStateRepository,
  type DiscordTaskBinding,
  type DiscordTaskState,
  type TaskChannelProjection,
} from "@opendelegate/discord-adapter";
import { type Selectable, type Transaction } from "kysely";

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
  DiscordInboundTable,
  DiscordOutboxTable,
  DiscordTaskBindingsTable,
  SqlStorageSchema,
} from "./schema.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";

interface SqlDiscordStateRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteDiscordStateRepositoryOptions
  extends SqlDiscordStateRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresDiscordStateRepositoryOptions
  extends SqlDiscordStateRepositoryOptions, PostgresDialectOptions {}

export class SqlDiscordStateRepository implements DiscordStateRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactions: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactions = new SqlTransactionRunner(context.database, context.backend, retryPolicy);
  }

  public static async openSqlite(
    options: OpenSqliteDiscordStateRepositoryOptions,
  ): Promise<SqlDiscordStateRepository> {
    return this.#open(await createSqliteDatabase(options), options);
  }

  public static async openPostgres(
    options: OpenPostgresDiscordStateRepositoryOptions,
  ): Promise<SqlDiscordStateRepository> {
    return this.#open(await createPostgresDatabase(options), options);
  }

  public async close(): Promise<void> {
    await this.#context.close();
  }

  public async getGatewayCursor(): Promise<DiscordGatewayCursor | undefined> {
    const row = await this.#context.database
      .selectFrom("od_discord_gateway_cursor")
      .selectAll()
      .where("singleton_id", "=", 1)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const cursor = {
      sessionId: row.session_id,
      resumeGatewayUrl: row.resume_gateway_url,
      sequence: parseSafeNonNegativeInteger(row.sequence, "Discord Gateway sequence"),
      updatedAtMs: parseSafeNonNegativeInteger(
        row.updated_at_ms,
        "Discord Gateway cursor timestamp",
      ),
    };
    try {
      validateCursor(cursor);
      return deepFreeze(cursor);
    } catch (error) {
      throw dataCorrupt("The Discord Gateway cursor row is invalid.", error);
    }
  }

  public async saveGatewayCursor(cursor: DiscordGatewayCursor): Promise<void> {
    validateCursor(cursor);
    await this.#transactions.write(async (transaction) => {
      const current = await transaction
        .selectFrom("od_discord_gateway_cursor")
        .selectAll()
        .where("singleton_id", "=", 1)
        .executeTakeFirst();
      if (current === undefined) {
        await transaction
          .insertInto("od_discord_gateway_cursor")
          .values({
            singleton_id: 1,
            session_id: cursor.sessionId,
            resume_gateway_url: cursor.resumeGatewayUrl,
            sequence: cursor.sequence,
            updated_at_ms: cursor.updatedAtMs,
          })
          .execute();
        return;
      }
      const currentSequence = parseSafeNonNegativeInteger(
        current.sequence,
        "Discord Gateway sequence",
      );
      const currentUpdatedAtMs = parseSafeNonNegativeInteger(
        current.updated_at_ms,
        "Discord Gateway cursor timestamp",
      );
      if (
        (current.session_id === cursor.sessionId && cursor.sequence < currentSequence) ||
        (current.session_id !== cursor.sessionId && cursor.updatedAtMs <= currentUpdatedAtMs) ||
        (current.session_id === cursor.sessionId &&
          cursor.sequence === currentSequence &&
          cursor.updatedAtMs < currentUpdatedAtMs)
      ) {
        return;
      }
      await transaction
        .updateTable("od_discord_gateway_cursor")
        .set({
          session_id: cursor.sessionId,
          resume_gateway_url: cursor.resumeGatewayUrl,
          sequence: cursor.sequence,
          updated_at_ms: cursor.updatedAtMs,
        })
        .where("singleton_id", "=", 1)
        .executeTakeFirstOrThrow();
    });
  }

  public async claimInbound(input: { key: string; digest: string; nowMs: number }): Promise<{
    readonly outcome: "new" | "pending" | "completed";
    readonly record: DiscordInboundRecord;
  }> {
    assertKey(input.key, "Discord inbound key");
    assertDigest(input.digest);
    assertTimestamp(input.nowMs, "Discord inbound timestamp");
    return this.#transactions.write(async (transaction) => {
      const current = await this.#findInbound(transaction, input.key);
      if (current !== undefined) {
        if (current.digest !== input.digest) {
          throw new DiscordAdapterError(
            "IDEMPOTENCY_CONFLICT",
            "A Discord inbound key was reused with different content.",
          );
        }
        return deepFreeze({ outcome: current.state, record: current });
      }
      await transaction
        .insertInto("od_discord_inbound")
        .values({
          inbound_key: input.key,
          digest: input.digest,
          state: "pending",
          acknowledged: this.#dbBoolean(false),
          response_ref: null,
          created_at_ms: input.nowMs,
          updated_at_ms: input.nowMs,
        })
        .execute();
      const created = await this.#findInbound(transaction, input.key);
      if (created === undefined) {
        throw dataCorrupt("The Discord inbound insert was not visible.");
      }
      return deepFreeze({ outcome: "new" as const, record: created });
    });
  }

  public async acknowledgeInbound(input: {
    key: string;
    responseRef: string;
    nowMs: number;
  }): Promise<DiscordInboundRecord> {
    assertKey(input.key, "Discord inbound key");
    assertOpaqueResponseReference(input.responseRef, "discord");
    assertTimestamp(input.nowMs, "Discord inbound timestamp");
    return this.#transactions.write(async (transaction) => {
      const current = await this.#requiredInbound(transaction, input.key);
      if (current.acknowledged) {
        if (current.responseRef !== input.responseRef) {
          throw persistenceConflict();
        }
        return current;
      }
      if (input.nowMs < current.updatedAtMs) {
        throw persistenceConflict();
      }
      await transaction
        .updateTable("od_discord_inbound")
        .set({
          acknowledged: this.#dbBoolean(true),
          response_ref: input.responseRef,
          updated_at_ms: input.nowMs,
        })
        .where("inbound_key", "=", input.key)
        .executeTakeFirstOrThrow();
      return this.#requiredInbound(transaction, input.key);
    });
  }

  public async completeInbound(input: { key: string; nowMs: number }): Promise<void> {
    assertKey(input.key, "Discord inbound key");
    assertTimestamp(input.nowMs, "Discord inbound timestamp");
    await this.#transactions.write(async (transaction) => {
      const current = await this.#requiredInbound(transaction, input.key);
      if (current.state === "completed") {
        return;
      }
      if (input.nowMs < current.updatedAtMs) {
        throw persistenceConflict();
      }
      await transaction
        .updateTable("od_discord_inbound")
        .set({ state: "completed", updated_at_ms: input.nowMs })
        .where("inbound_key", "=", input.key)
        .executeTakeFirstOrThrow();
    });
  }

  public async getBindingByThread(threadId: string): Promise<DiscordTaskBinding | undefined> {
    assertSnowflake(threadId, "Discord thread ID");
    const row = await this.#context.database
      .selectFrom("od_discord_task_bindings")
      .selectAll()
      .where("thread_id", "=", threadId)
      .executeTakeFirst();
    return row === undefined ? undefined : decodeBinding(row);
  }

  public async getBindingByTask(taskId: string): Promise<DiscordTaskBinding | undefined> {
    assertKey(taskId, "Task ID");
    const row = await this.#context.database
      .selectFrom("od_discord_task_bindings")
      .selectAll()
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    return row === undefined ? undefined : decodeBinding(row);
  }

  public async listBindings(): Promise<readonly DiscordTaskBinding[]> {
    const rows = await this.#context.database
      .selectFrom("od_discord_task_bindings")
      .selectAll()
      .orderBy("thread_id")
      .execute();
    return Object.freeze(rows.map(decodeBinding));
  }

  public async bindTask(
    binding: Omit<DiscordTaskBinding, "revision">,
  ): Promise<DiscordTaskBinding> {
    validateNewBinding(binding);
    return this.#transactions.write(async (transaction) => {
      const byThread = await transaction
        .selectFrom("od_discord_task_bindings")
        .selectAll()
        .where("thread_id", "=", binding.threadId)
        .executeTakeFirst();
      if (byThread !== undefined) {
        const existing = decodeBinding(byThread);
        if (!sameBindingIdentity(existing, binding)) {
          throw persistenceConflict();
        }
        return existing;
      }
      const byTask = await transaction
        .selectFrom("od_discord_task_bindings")
        .select("thread_id")
        .where("task_id", "=", binding.taskId)
        .executeTakeFirst();
      if (byTask !== undefined) {
        throw persistenceConflict();
      }
      await transaction
        .insertInto("od_discord_task_bindings")
        .values({
          thread_id: binding.threadId,
          guild_id: binding.guildId,
          forum_channel_id: binding.forumChannelId,
          starter_message_id: binding.starterMessageId,
          task_id: binding.taskId,
          status_panel_message_id: binding.statusPanelMessageId ?? null,
          last_reconciled_message_id: binding.lastReconciledMessageId ?? null,
          external_state: binding.externalState,
          archived: this.#dbBoolean(binding.archived),
          locked: this.#dbBoolean(binding.locked),
          revision: 1,
        })
        .execute();
      return deepFreeze({ ...binding, revision: 1 });
    });
  }

  public async updateBinding(
    threadId: string,
    patch: Partial<
      Pick<
        DiscordTaskBinding,
        "statusPanelMessageId" | "lastReconciledMessageId" | "externalState" | "archived" | "locked"
      >
    >,
  ): Promise<DiscordTaskBinding> {
    assertSnowflake(threadId, "Discord thread ID");
    validateBindingPatch(patch);
    return this.#transactions.write(async (transaction) => {
      const row = await transaction
        .selectFrom("od_discord_task_bindings")
        .selectAll()
        .where("thread_id", "=", threadId)
        .executeTakeFirst();
      if (row === undefined) {
        throw persistenceConflict();
      }
      const current = decodeBinding(row);
      const updated = applyBindingPatch(current, patch);
      if (isDeepStrictEqual(current, updated)) {
        return current;
      }
      if (current.externalState === "deleted") {
        throw persistenceConflict();
      }
      if (
        current.lastReconciledMessageId !== undefined &&
        updated.lastReconciledMessageId !== undefined &&
        compareSnowflakes(updated.lastReconciledMessageId, current.lastReconciledMessageId) < 0
      ) {
        throw persistenceConflict();
      }
      const revision = current.revision + 1;
      if (!Number.isSafeInteger(revision)) {
        throw dataCorrupt("The Discord Task binding revision exhausted safe integers.");
      }
      await transaction
        .updateTable("od_discord_task_bindings")
        .set({
          status_panel_message_id: updated.statusPanelMessageId ?? null,
          last_reconciled_message_id: updated.lastReconciledMessageId ?? null,
          external_state: updated.externalState,
          archived: this.#dbBoolean(updated.archived),
          locked: this.#dbBoolean(updated.locked),
          revision,
        })
        .where("thread_id", "=", threadId)
        .where("revision", "=", current.revision)
        .executeTakeFirstOrThrow();
      return deepFreeze({ ...updated, revision });
    });
  }

  public async enqueueOutbox(
    item: Omit<DiscordOutboxItem, "attempts" | "delivered">,
  ): Promise<void> {
    assertKey(item.id, "Discord outbox ID");
    assertTimestamp(item.createdAtMs, "Discord outbox creation timestamp");
    assertTimestamp(item.notBeforeMs, "Discord outbox availability timestamp");
    if (item.leaseOwner !== undefined || item.leaseExpiresAtMs !== undefined) {
      throw persistenceConflict();
    }
    const actionJson = encodeAndValidateAction(item.action);
    await this.#transactions.write(async (transaction) => {
      const current = await transaction
        .selectFrom("od_discord_outbox")
        .select(["action_json"])
        .where("outbox_id", "=", item.id)
        .executeTakeFirst();
      if (current !== undefined) {
        if (current.action_json !== actionJson) {
          throw new DiscordAdapterError(
            "IDEMPOTENCY_CONFLICT",
            "A Discord outbox key was reused with different work.",
          );
        }
        return;
      }
      await transaction
        .insertInto("od_discord_outbox")
        .values({
          outbox_id: item.id,
          action_json: actionJson,
          created_at_ms: item.createdAtMs,
          not_before_ms: item.notBeforeMs,
          attempts: 0,
          delivered: this.#dbBoolean(false),
          lease_owner: null,
          lease_expires_at_ms: null,
          last_error_code: item.lastErrorCode ?? null,
          last_transition_kind: null,
          last_transition_owner: null,
          last_transition_not_before_ms: null,
          last_transition_error_code: null,
        })
        .execute();
    });
  }

  public async claimReadyOutbox(input: {
    owner: string;
    nowMs: number;
    leaseMs: number;
    limit: number;
  }): Promise<readonly DiscordOutboxItem[]> {
    assertKey(input.owner, "Discord outbox lease owner");
    assertTimestamp(input.nowMs, "Discord outbox claim timestamp");
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1 ||
      input.leaseMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isSafeInteger(input.nowMs + input.leaseMs)
    ) {
      throw persistenceConflict();
    }
    return this.#transactions.write(async (transaction) => {
      const baseQuery = transaction
        .selectFrom("od_discord_outbox")
        .selectAll()
        .where("delivered", "=", this.#dbBoolean(false))
        .where("not_before_ms", "<=", input.nowMs)
        .where((expression) =>
          expression.or([
            expression("lease_expires_at_ms", "is", null),
            expression("lease_expires_at_ms", "<=", input.nowMs),
          ]),
        )
        .orderBy("created_at_ms")
        .orderBy("outbox_id")
        .limit(input.limit);
      const rows =
        this.#context.backend === "postgres"
          ? await baseQuery.forUpdate().skipLocked().execute()
          : await baseQuery.execute();
      const leaseExpiresAtMs = input.nowMs + input.leaseMs;
      for (const row of rows) {
        const result = await transaction
          .updateTable("od_discord_outbox")
          .set({
            lease_owner: input.owner,
            lease_expires_at_ms: leaseExpiresAtMs,
            last_transition_kind: null,
            last_transition_owner: null,
            last_transition_not_before_ms: null,
            last_transition_error_code: null,
          })
          .where("outbox_id", "=", row.outbox_id)
          .where("delivered", "=", this.#dbBoolean(false))
          .executeTakeFirst();
        if (result.numUpdatedRows !== 1n) {
          throw persistenceConflict();
        }
      }
      return Object.freeze(
        rows.map((row) =>
          decodeOutbox({
            ...row,
            lease_owner: input.owner,
            lease_expires_at_ms: leaseExpiresAtMs,
            last_transition_kind: null,
            last_transition_owner: null,
            last_transition_not_before_ms: null,
            last_transition_error_code: null,
          }),
        ),
      );
    });
  }

  public async completeOutbox(input: { id: string; owner: string }): Promise<void> {
    assertKey(input.id, "Discord outbox ID");
    assertKey(input.owner, "Discord outbox lease owner");
    await this.#transactions.write(async (transaction) => {
      const row = await this.#requiredOutboxRow(transaction, input.id);
      if (
        isTrue(row.delivered) &&
        row.last_transition_kind === "complete" &&
        row.last_transition_owner === input.owner
      ) {
        return;
      }
      if (isTrue(row.delivered) || row.lease_owner !== input.owner) {
        throw persistenceConflict();
      }
      const attempts = nextAttempts(row.attempts);
      await transaction
        .updateTable("od_discord_outbox")
        .set({
          attempts,
          delivered: this.#dbBoolean(true),
          lease_owner: null,
          lease_expires_at_ms: null,
          last_transition_kind: "complete",
          last_transition_owner: input.owner,
          last_transition_not_before_ms: null,
          last_transition_error_code: null,
        })
        .where("outbox_id", "=", input.id)
        .executeTakeFirstOrThrow();
    });
  }

  public async retryOutbox(input: {
    id: string;
    owner: string;
    notBeforeMs: number;
    errorCode: string;
  }): Promise<void> {
    assertKey(input.id, "Discord outbox ID");
    assertKey(input.owner, "Discord outbox lease owner");
    assertTimestamp(input.notBeforeMs, "Discord outbox retry timestamp");
    assertKey(input.errorCode, "Discord outbox error code");
    await this.#transactions.write(async (transaction) => {
      const row = await this.#requiredOutboxRow(transaction, input.id);
      const transitionTimestamp =
        row.last_transition_not_before_ms === null
          ? undefined
          : parseSafeNonNegativeInteger(
              row.last_transition_not_before_ms,
              "Discord outbox transition timestamp",
            );
      if (
        !isTrue(row.delivered) &&
        row.last_transition_kind === "retry" &&
        row.last_transition_owner === input.owner &&
        transitionTimestamp === input.notBeforeMs &&
        row.last_transition_error_code === input.errorCode
      ) {
        return;
      }
      if (isTrue(row.delivered) || row.lease_owner !== input.owner) {
        throw persistenceConflict();
      }
      const attempts = nextAttempts(row.attempts);
      await transaction
        .updateTable("od_discord_outbox")
        .set({
          attempts,
          delivered: this.#dbBoolean(false),
          not_before_ms: input.notBeforeMs,
          lease_owner: null,
          lease_expires_at_ms: null,
          last_error_code: input.errorCode,
          last_transition_kind: "retry",
          last_transition_owner: input.owner,
          last_transition_not_before_ms: input.notBeforeMs,
          last_transition_error_code: input.errorCode,
        })
        .where("outbox_id", "=", input.id)
        .executeTakeFirstOrThrow();
    });
  }

  public async listOutbox(): Promise<readonly DiscordOutboxItem[]> {
    const rows = await this.#context.database
      .selectFrom("od_discord_outbox")
      .selectAll()
      .orderBy("created_at_ms")
      .orderBy("outbox_id")
      .execute();
    return Object.freeze(rows.map(decodeOutbox));
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlDiscordStateRepositoryOptions,
  ): Promise<SqlDiscordStateRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      return new SqlDiscordStateRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async #findInbound(
    transaction: Transaction<SqlStorageSchema>,
    key: string,
  ): Promise<DiscordInboundRecord | undefined> {
    const row = await transaction
      .selectFrom("od_discord_inbound")
      .selectAll()
      .where("inbound_key", "=", key)
      .executeTakeFirst();
    return row === undefined ? undefined : decodeInbound(row);
  }

  async #requiredInbound(
    transaction: Transaction<SqlStorageSchema>,
    key: string,
  ): Promise<DiscordInboundRecord> {
    const record = await this.#findInbound(transaction, key);
    if (record === undefined) {
      throw persistenceConflict();
    }
    return record;
  }

  async #requiredOutboxRow(
    transaction: Transaction<SqlStorageSchema>,
    id: string,
  ): Promise<Selectable<DiscordOutboxTable>> {
    const row = await transaction
      .selectFrom("od_discord_outbox")
      .selectAll()
      .where("outbox_id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw persistenceConflict();
    }
    return row;
  }

  #dbBoolean(value: boolean): boolean | number {
    return this.#context.backend === "sqlite" ? (value ? 1 : 0) : value;
  }
}

function decodeInbound(row: Selectable<DiscordInboundTable>): DiscordInboundRecord {
  try {
    if (row.state !== "pending" && row.state !== "completed") {
      throw dataCorrupt("A Discord inbound row has an invalid state.");
    }
    const acknowledged = parseBoolean(row.acknowledged, "Discord inbound acknowledgement");
    if (acknowledged !== (row.response_ref !== null)) {
      throw dataCorrupt("A Discord inbound acknowledgement is inconsistent.");
    }
    assertKey(row.inbound_key, "Discord inbound key");
    assertDigestStored(row.digest);
    if (row.response_ref !== null) {
      assertOpaqueResponseReference(row.response_ref, "discord");
    }
    const createdAtMs = parseSafeNonNegativeInteger(
      row.created_at_ms,
      "Discord inbound creation timestamp",
    );
    const updatedAtMs = parseSafeNonNegativeInteger(
      row.updated_at_ms,
      "Discord inbound update timestamp",
    );
    if (updatedAtMs < createdAtMs) {
      throw dataCorrupt("A Discord inbound timestamp regressed.");
    }
    return deepFreeze({
      key: row.inbound_key,
      digest: row.digest,
      state: row.state,
      acknowledged,
      ...(row.response_ref === null ? {} : { responseRef: row.response_ref }),
      createdAtMs,
      updatedAtMs,
    });
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw error;
    }
    throw dataCorrupt("A Discord inbound row is invalid.", error);
  }
}

function decodeBinding(row: Selectable<DiscordTaskBindingsTable>): DiscordTaskBinding {
  if (
    row.external_state !== "available" &&
    row.external_state !== "deleted" &&
    row.external_state !== "inaccessible"
  ) {
    throw dataCorrupt("A Discord Task binding has an invalid external state.");
  }
  const externalState: DiscordTaskBinding["externalState"] = row.external_state;
  const binding: DiscordTaskBinding = {
    guildId: row.guild_id,
    forumChannelId: row.forum_channel_id,
    threadId: row.thread_id,
    starterMessageId: row.starter_message_id,
    taskId: row.task_id,
    ...(row.status_panel_message_id === null
      ? {}
      : { statusPanelMessageId: row.status_panel_message_id }),
    ...(row.last_reconciled_message_id === null
      ? {}
      : { lastReconciledMessageId: row.last_reconciled_message_id }),
    externalState,
    archived: parseBoolean(row.archived, "Discord Task archived flag"),
    locked: parseBoolean(row.locked, "Discord Task locked flag"),
    revision: parseSafeNonNegativeInteger(row.revision, "Discord Task binding revision"),
  };
  try {
    validateNewBinding(binding);
  } catch (error) {
    throw dataCorrupt("A Discord Task binding row is invalid.", error);
  }
  if (binding.revision < 1) {
    throw dataCorrupt("A Discord Task binding revision must be positive.");
  }
  return deepFreeze(binding);
}

function decodeOutbox(row: Selectable<DiscordOutboxTable>): DiscordOutboxItem {
  try {
    const action = decodeCanonicalJson(row.action_json);
    validateOutboxAction(action);
    const delivered = parseBoolean(row.delivered, "Discord outbox delivered flag");
    if (
      (row.lease_owner === null) !== (row.lease_expires_at_ms === null) ||
      (delivered && row.lease_owner !== null)
    ) {
      throw dataCorrupt("A Discord outbox lease is inconsistent.");
    }
    assertKey(row.outbox_id, "Discord outbox ID");
    if (row.lease_owner !== null) {
      assertKey(row.lease_owner, "Discord outbox lease owner");
    }
    if (row.last_error_code !== null) {
      assertKey(row.last_error_code, "Discord outbox error code");
    }
    return deepFreeze({
      id: row.outbox_id,
      action,
      createdAtMs: parseSafeNonNegativeInteger(
        row.created_at_ms,
        "Discord outbox creation timestamp",
      ),
      notBeforeMs: parseSafeNonNegativeInteger(
        row.not_before_ms,
        "Discord outbox availability timestamp",
      ),
      attempts: parseSafeNonNegativeInteger(row.attempts, "Discord outbox attempts"),
      delivered,
      ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
      ...(row.lease_expires_at_ms === null
        ? {}
        : {
            leaseExpiresAtMs: parseSafeNonNegativeInteger(
              row.lease_expires_at_ms,
              "Discord outbox lease expiry",
            ),
          }),
      ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    });
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw error;
    }
    throw dataCorrupt("A Discord outbox row is invalid.", error);
  }
}

function validateCursor(cursor: DiscordGatewayCursor): void {
  assertKey(cursor.sessionId, "Discord Gateway session ID");
  if (cursor.sessionId.length > 512 || !isSecureGatewayUrl(cursor.resumeGatewayUrl)) {
    throw persistenceConflict();
  }
  assertTimestamp(cursor.sequence, "Discord Gateway sequence");
  assertTimestamp(cursor.updatedAtMs, "Discord Gateway cursor timestamp");
}

function validateNewBinding(
  binding: Omit<DiscordTaskBinding, "revision"> | DiscordTaskBinding,
): void {
  assertSnowflake(binding.guildId, "Discord guild ID");
  assertSnowflake(binding.forumChannelId, "Discord Forum channel ID");
  assertSnowflake(binding.threadId, "Discord thread ID");
  assertSnowflake(binding.starterMessageId, "Discord starter message ID");
  assertKey(binding.taskId, "Task ID");
  if (binding.statusPanelMessageId !== undefined) {
    assertSnowflake(binding.statusPanelMessageId, "Discord status panel message ID");
  }
  if (binding.lastReconciledMessageId !== undefined) {
    assertSnowflake(binding.lastReconciledMessageId, "Discord reconciled message ID");
  }
  if (
    !["available", "deleted", "inaccessible"].includes(binding.externalState) ||
    typeof binding.archived !== "boolean" ||
    typeof binding.locked !== "boolean"
  ) {
    throw persistenceConflict();
  }
}

function validateBindingPatch(
  patch: Partial<
    Pick<
      DiscordTaskBinding,
      "statusPanelMessageId" | "lastReconciledMessageId" | "externalState" | "archived" | "locked"
    >
  >,
): void {
  assertPlainRecord(patch, "Discord Task binding patch");
  assertOnlyKeys(patch, [
    "statusPanelMessageId",
    "lastReconciledMessageId",
    "externalState",
    "archived",
    "locked",
  ]);
  if (hasOwn(patch, "statusPanelMessageId")) {
    assertSnowflake(patch.statusPanelMessageId, "Discord status panel message ID");
  }
  if (hasOwn(patch, "lastReconciledMessageId")) {
    assertSnowflake(patch.lastReconciledMessageId, "Discord reconciled message ID");
  }
  if (
    hasOwn(patch, "externalState") &&
    !["available", "deleted", "inaccessible"].includes(patch.externalState ?? "")
  ) {
    throw persistenceConflict();
  }
  if (
    (hasOwn(patch, "archived") && typeof patch.archived !== "boolean") ||
    (hasOwn(patch, "locked") && typeof patch.locked !== "boolean")
  ) {
    throw persistenceConflict();
  }
}

function applyBindingPatch(
  current: DiscordTaskBinding,
  patch: Partial<
    Pick<
      DiscordTaskBinding,
      "statusPanelMessageId" | "lastReconciledMessageId" | "externalState" | "archived" | "locked"
    >
  >,
): DiscordTaskBinding {
  return deepFreeze({
    ...current,
    ...(hasOwn(patch, "statusPanelMessageId")
      ? { statusPanelMessageId: patch.statusPanelMessageId }
      : {}),
    ...(hasOwn(patch, "lastReconciledMessageId")
      ? { lastReconciledMessageId: patch.lastReconciledMessageId }
      : {}),
    ...(hasOwn(patch, "externalState") ? { externalState: patch.externalState } : {}),
    ...(hasOwn(patch, "archived") ? { archived: patch.archived } : {}),
    ...(hasOwn(patch, "locked") ? { locked: patch.locked } : {}),
  }) as DiscordTaskBinding;
}

function sameBindingIdentity(
  left: DiscordTaskBinding,
  right: Omit<DiscordTaskBinding, "revision">,
): boolean {
  return (
    left.guildId === right.guildId &&
    left.forumChannelId === right.forumChannelId &&
    left.threadId === right.threadId &&
    left.starterMessageId === right.starterMessageId &&
    left.taskId === right.taskId
  );
}

function encodeAndValidateAction(action: DiscordOutboxAction): string {
  try {
    validateOutboxAction(action);
    return encodeCanonicalJson(action);
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID") {
      throw error;
    }
    throw new SqlStorageError(
      "STORAGE_CONFIGURATION_INVALID",
      "Discord outbox work is outside the durable action contract.",
      { cause: error },
    );
  }
}

function validateOutboxAction(value: unknown): asserts value is DiscordOutboxAction {
  const action = assertPlainRecord(value, "Discord outbox action");
  const kind = requireBoundedString(action["kind"], "Discord outbox action kind", 64);
  if (kind === "acknowledge-owner-message") {
    assertOnlyKeys(action, ["kind", "taskId", "messageId"]);
    requireTaskId(action["taskId"]);
    assertSnowflake(action["messageId"], "Discord owner message ID");
    return;
  }
  if (kind === "sync-tags") {
    assertOnlyKeys(action, ["kind", "taskId", "state"]);
    requireTaskId(action["taskId"]);
    requireTaskState(action["state"]);
    return;
  }
  if (kind === "upsert-status-panel" || kind === "post-task-update") {
    assertOnlyKeys(action, ["kind", "taskId", "projection"]);
    requireTaskId(action["taskId"]);
    validateProjection(action["projection"]);
    return;
  }
  if (kind === "resolve-owner-prompt") {
    assertOnlyKeys(action, ["kind", "taskId", "promptRequestKey", "projection"]);
    requireTaskId(action["taskId"]);
    requireBoundedString(action["promptRequestKey"], "Discord prompt request key", 512);
    validateProjection(action["projection"]);
    return;
  }
  if (kind === "complete-owner-message") {
    assertOnlyKeys(action, ["kind", "taskId", "completion", "afterRequestKey"]);
    requireTaskId(action["taskId"]);
    validateOwnerMessageCompletion(action["completion"]);
    requireBoundedString(action["afterRequestKey"], "Discord prerequisite request key", 512);
    return;
  }
  if (kind === "task-command") {
    assertOnlyKeys(action, [
      "kind",
      "taskId",
      "principalId",
      "command",
      "idempotencyKey",
      "responseRef",
    ]);
    requireTaskId(action["taskId"]);
    requireBoundedString(action["principalId"], "Discord principal ID", 512);
    requireOneOf(action["command"], ["pause", "resume", "cancel", "retry"]);
    requireBoundedString(action["idempotencyKey"], "Discord idempotency key", 512);
    assertOpaqueResponseReference(action["responseRef"], "storage");
    return;
  }
  if (kind === "approval-decision") {
    assertOnlyKeys(action, [
      "kind",
      "taskId",
      "principalId",
      "approvalId",
      "decision",
      "idempotencyKey",
      "responseRef",
    ]);
    requireTaskId(action["taskId"]);
    requireBoundedString(action["principalId"], "Discord principal ID", 512);
    requireBoundedString(action["approvalId"], "Approval ID", 512);
    requireOneOf(action["decision"], ["approve", "reject"]);
    requireBoundedString(action["idempotencyKey"], "Discord idempotency key", 512);
    assertOpaqueResponseReference(action["responseRef"], "storage");
    return;
  }
  throw persistenceConflict();
}

function validateOwnerMessageCompletion(value: unknown): void {
  const completion = assertPlainRecord(value, "Discord owner-message completion");
  assertOnlyKeys(completion, ["messageId", "outcome"]);
  assertSnowflake(completion["messageId"], "Discord owner message ID");
  requireOneOf(completion["outcome"], ["success", "failure"]);
}

function validateProjection(value: unknown): asserts value is TaskChannelProjection {
  const projection = assertPlainRecord(value, "Discord Task projection");
  assertOnlyKeys(projection, [
    "taskId",
    "sourceEventId",
    "state",
    "objective",
    "summary",
    "significance",
    "progress",
    "approval",
    "artifact",
    "inspectUrl",
  ]);
  requireTaskId(projection["taskId"]);
  if (projection["sourceEventId"] !== undefined) {
    requireBoundedString(projection["sourceEventId"], "Task source event ID", 160);
  }
  requireTaskState(projection["state"]);
  requireBoundedString(projection["objective"], "Task objective", 16_384);
  requireBoundedString(projection["summary"], "Task summary", 16_384, true);
  requireOneOf(projection["significance"], ["status", "question", "decision", "failure", "final"]);
  if (projection["significance"] !== "status" && projection["sourceEventId"] === undefined) {
    throw persistenceConflict();
  }
  if (projection["progress"] !== undefined) {
    const progress = assertPlainRecord(projection["progress"], "Task progress");
    assertOnlyKeys(progress, ["completed", "total"]);
    const completed = requireSafeNonNegative(progress["completed"], "Completed work");
    const total = requireSafeNonNegative(progress["total"], "Total work");
    if (completed > total) {
      throw persistenceConflict();
    }
  }
  if (projection["approval"] !== undefined) {
    const approval = assertPlainRecord(projection["approval"], "Task approval");
    assertOnlyKeys(approval, ["approvalId", "description"]);
    requireBoundedString(approval["approvalId"], "Approval ID", 512);
    requireBoundedString(approval["description"], "Approval description", 16_384);
  }
  if (projection["artifact"] !== undefined) {
    const artifact = assertPlainRecord(projection["artifact"], "Task artifact");
    assertOnlyKeys(artifact, ["label", "url"]);
    requireBoundedString(artifact["label"], "Artifact label", 512);
    requireSafeHttpUrl(artifact["url"], "Artifact URL");
  }
  if (projection["inspectUrl"] !== undefined) {
    requireSafeHttpUrl(projection["inspectUrl"], "Task inspection URL");
  }
}

function requireTaskState(value: unknown): DiscordTaskState {
  return requireOneOf(value, [
    "intake",
    "queued",
    "running",
    "waiting_user",
    "waiting_resource",
    "review",
    "completed",
    "failed",
    "paused",
    "cancelled",
  ]) as DiscordTaskState;
}

function requireTaskId(value: unknown): string {
  return requireBoundedString(value, "Task ID", 512);
}

function requireSafeHttpUrl(value: unknown, label: string): string {
  const text = requireBoundedString(value, label, 2_048);
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("Unsupported URL.");
    }
  } catch {
    throw persistenceConflict();
  }
  return text;
}

function requireOneOf(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw persistenceConflict();
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes("\u0000")
  ) {
    throw new DiscordAdapterError(
      "PERSISTENCE_CONFLICT",
      `${label} is outside the durable contract.`,
    );
  }
  return value;
}

function requireSafeNonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DiscordAdapterError(
      "PERSISTENCE_CONFLICT",
      `${label} is outside the durable contract.`,
    );
  }
  return value as number;
}

function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new DiscordAdapterError("PERSISTENCE_CONFLICT", `${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw persistenceConflict();
  }
}

function assertOpaqueResponseReference(
  value: unknown,
  errorKind: "discord" | "storage",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^discord-interaction-ref:[A-Za-z0-9_-]{1,128}$/u.test(value) ||
    value.length > 160
  ) {
    if (errorKind === "storage") {
      throw new SqlStorageError(
        "STORAGE_CONFIGURATION_INVALID",
        "Discord interaction work may persist only an opaque token-vault reference.",
      );
    }
    throw persistenceConflict();
  }
}

function assertSnowflake(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9]{17,20}$/u.test(value)) {
    throw new DiscordAdapterError("PERSISTENCE_CONFLICT", `${label} is invalid.`);
  }
}

function assertDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw persistenceConflict();
  }
}

function assertDigestStored(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw dataCorrupt("A Discord inbound digest is invalid.");
  }
}

function assertKey(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes("\u0000")
  ) {
    throw new DiscordAdapterError("PERSISTENCE_CONFLICT", `${label} is invalid.`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DiscordAdapterError("PERSISTENCE_CONFLICT", `${label} is invalid.`);
  }
}

function parseBoolean(value: boolean | number, label: string): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  throw dataCorrupt(`${label} is invalid.`);
}

function isTrue(value: boolean | number): boolean {
  return value === true || value === 1;
}

function nextAttempts(value: number | string | bigint): number {
  const attempts = parseSafeNonNegativeInteger(value, "Discord outbox attempts") + 1;
  if (!Number.isSafeInteger(attempts)) {
    throw dataCorrupt("Discord outbox attempts exhausted safe integers.");
  }
  return attempts;
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isSecureGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.endsWith(".discord.gg") &&
      (url.port === "" || url.port === "443") &&
      value.length <= 2_048
    );
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function persistenceConflict(): DiscordAdapterError {
  return new DiscordAdapterError(
    "PERSISTENCE_CONFLICT",
    "Persisted Discord adapter state is inconsistent.",
  );
}

function dataCorrupt(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("DATA_CORRUPT", message, cause === undefined ? undefined : { cause });
}
