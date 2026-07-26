import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  decodeDeviceChannelFrame,
  encodeDeviceChannelFrame,
  type MainToWorkerFrameV1,
  type WorkerToMainFrameV1,
} from "./protocol.ts";

export interface ObserveDeviceChannelConnection {
  readonly deviceId: string;
  readonly certificateGeneration: number;
}

export interface CommitInboundResult {
  readonly disposition: "accepted" | "duplicate";
  readonly acknowledgedWorkerSequence: number;
}

export interface InboundEffectClaimResult {
  readonly disposition: "claimed" | "handled" | "processing";
  readonly acknowledgedSequence: number;
}

export interface InboundEffectCompletionResult {
  readonly acknowledgedSequence: number;
}

export interface AcknowledgeOutboundInput {
  readonly deviceId: string;
  readonly acknowledgedMainSequence: number;
  readonly acknowledgedMessageIds: readonly string[];
}

export interface DeviceChannelResumeState {
  readonly acknowledgedWorkerSequence: number;
  readonly acknowledgedMainSequence: number;
  readonly nextMainSequence: number;
  readonly pendingOutbound: readonly MainToWorkerFrameV1[];
}

export interface DeviceChannelRepository {
  observeConnection(input: ObserveDeviceChannelConnection): Promise<void>;
  commitInbound(frame: WorkerToMainFrameV1): Promise<CommitInboundResult>;
  claimInboundEffect(
    frame: WorkerToMainFrameV1,
    claimId: string,
  ): Promise<InboundEffectClaimResult>;
  completeInboundEffect(
    frame: WorkerToMainFrameV1,
    claimId: string,
  ): Promise<InboundEffectCompletionResult>;
  releaseInboundEffect(frame: WorkerToMainFrameV1, claimId: string): Promise<void>;
  enqueueOutbound(
    deviceId: string,
    createFrame: (sequence: number) => MainToWorkerFrameV1,
  ): Promise<MainToWorkerFrameV1>;
  outboundByIdempotencyKey(
    deviceId: string,
    idempotencyKey: string,
  ): Promise<MainToWorkerFrameV1 | undefined>;
  acknowledgeOutbound(input: AcknowledgeOutboundInput): Promise<void>;
  resume(deviceId: string): Promise<DeviceChannelResumeState>;
  close(): Promise<void>;
}

export interface OpenSqliteDeviceChannelRepositoryOptions {
  readonly filename: string;
  readonly sourceCheckoutRoot: string;
  readonly busyTimeoutMs?: number;
}

export type DeviceChannelRepositoryErrorCode =
  | "CHANNEL_ACK_INVALID"
  | "CHANNEL_CONFIGURATION_INVALID"
  | "CHANNEL_EFFECT_CLAIM_INVALID"
  | "CHANNEL_GENERATION_STALE"
  | "CHANNEL_IDEMPOTENCY_CONFLICT"
  | "CHANNEL_NOT_REGISTERED"
  | "CHANNEL_REPOSITORY_CLOSED"
  | "CHANNEL_SEQUENCE_GAP"
  | "CHANNEL_STATE_CORRUPT"
  | "CHANNEL_STORAGE_UNAVAILABLE";

export class DeviceChannelRepositoryError extends Error {
  public readonly code: DeviceChannelRepositoryErrorCode;

  public constructor(code: DeviceChannelRepositoryErrorCode, message: string) {
    super(message);
    this.name = "DeviceChannelRepositoryError";
    this.code = code;
  }
}

interface ChannelStateRow {
  readonly acknowledged_main_sequence: number;
  readonly certificate_generation: number;
  readonly device_id: string;
  readonly last_worker_sequence: number;
  readonly next_main_sequence: number;
}

interface InboundIdentityRow {
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly message_id: string;
  readonly sequence: number;
}

interface InboundEffectRow {
  readonly claim_id: string | null;
  readonly status: "handled" | "processing" | "received";
}

interface InboundEffectSequenceRow {
  readonly sequence: number;
  readonly status: "handled" | "processing" | "received" | null;
}

interface OutboundFrameRow {
  readonly frame_json: string;
  readonly idempotency_key: string;
  readonly message_id: string;
  readonly sequence: number;
}

export class SqliteDeviceChannelRepository implements DeviceChannelRepository {
  private readonly database: Database.Database;
  private closed = false;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  public static async open(
    options: OpenSqliteDeviceChannelRepositoryOptions,
  ): Promise<SqliteDeviceChannelRepository> {
    const filename = validateDatabasePath(options.filename, options.sourceCheckoutRoot);
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
      throw repositoryError(
        "CHANNEL_CONFIGURATION_INVALID",
        "The Device channel SQLite busy timeout is invalid.",
      );
    }
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    let database: Database.Database | undefined;
    try {
      database = new Database(filename);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);
      database.exec(SQLITE_SCHEMA);
      if (process.platform !== "win32") {
        await chmod(filename, 0o600);
      }
      return new SqliteDeviceChannelRepository(database);
    } catch {
      database?.close();
      throw repositoryError(
        "CHANNEL_STORAGE_UNAVAILABLE",
        "The Device channel SQLite repository is unavailable.",
      );
    }
  }

  public async observeConnection(input: ObserveDeviceChannelConnection): Promise<void> {
    this.assertOpen();
    const deviceId = validateDeviceId(input.deviceId);
    const generation = readPositiveInteger(input.certificateGeneration, "certificate generation");
    this.transaction(() => {
      const existing = this.readState(deviceId);
      if (existing === undefined) {
        this.database
          .prepare(
            `INSERT INTO od_device_channel_state (
               device_id, certificate_generation, last_worker_sequence,
               acknowledged_main_sequence, next_main_sequence
             ) VALUES (?, ?, 0, 0, 1)`,
          )
          .run(deviceId, generation);
        return;
      }
      if (generation < existing.certificate_generation) {
        throw repositoryError(
          "CHANNEL_GENERATION_STALE",
          "A stale Device certificate generation cannot resume the channel.",
        );
      }
      if (generation > existing.certificate_generation) {
        this.database
          .prepare(
            `UPDATE od_device_channel_state
             SET certificate_generation = ?
             WHERE device_id = ?`,
          )
          .run(generation, deviceId);
      }
    });
  }

  public async commitInbound(frame: WorkerToMainFrameV1): Promise<CommitInboundResult> {
    this.assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const encoded = encodeDeviceChannelFrame(parsed);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    return this.transaction(() => {
      const state = this.requireState(parsed.senderDeviceId);
      const duplicates = this.database
        .prepare(
          `SELECT sequence, message_id, idempotency_key, fingerprint
           FROM od_device_channel_inbox
           WHERE device_id = ? AND (message_id = ? OR idempotency_key = ?)
           ORDER BY sequence`,
        )
        .all(
          parsed.senderDeviceId,
          parsed.messageId,
          parsed.idempotencyKey,
        ) as InboundIdentityRow[];
      if (duplicates.length > 0) {
        const duplicate = duplicates[0];
        if (
          duplicates.length !== 1 ||
          duplicate === undefined ||
          duplicate.message_id !== parsed.messageId ||
          duplicate.idempotency_key !== parsed.idempotencyKey ||
          duplicate.fingerprint !== fingerprint ||
          duplicate.sequence !== parsed.sequence
        ) {
          throw repositoryError(
            "CHANNEL_IDEMPOTENCY_CONFLICT",
            "A Device channel message identity was reused with different content.",
          );
        }
        return {
          disposition: "duplicate" as const,
          acknowledgedWorkerSequence: this.readAcknowledgedWorkerSequence(
            parsed.senderDeviceId,
            state,
          ),
        };
      }
      if (parsed.sequence !== state.last_worker_sequence + 1) {
        throw repositoryError(
          "CHANNEL_SEQUENCE_GAP",
          "The Worker channel sequence is not the next durable value.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO od_device_channel_inbox (
             device_id, sequence, message_id, idempotency_key, fingerprint, frame_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.senderDeviceId,
          parsed.sequence,
          parsed.messageId,
          parsed.idempotencyKey,
          fingerprint,
          encoded.toString("utf8"),
        );
      this.database
        .prepare(
          `INSERT INTO od_device_channel_inbound_effect (
             device_id, sequence, status, claim_id
           ) VALUES (?, ?, 'received', NULL)`,
        )
        .run(parsed.senderDeviceId, parsed.sequence);
      this.database
        .prepare(
          `UPDATE od_device_channel_state
           SET last_worker_sequence = ?
           WHERE device_id = ?`,
        )
        .run(parsed.sequence, parsed.senderDeviceId);
      return {
        disposition: "accepted" as const,
        acknowledgedWorkerSequence: this.readAcknowledgedWorkerSequence(parsed.senderDeviceId, {
          ...state,
          last_worker_sequence: parsed.sequence,
        }),
      };
    });
  }

  public async claimInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectClaimResult> {
    this.assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    return this.transaction(() => {
      const state = this.requireState(parsed.senderDeviceId);
      this.requireInboundIdentity(parsed, fingerprint);
      const effect = this.requireInboundEffect(parsed.senderDeviceId, parsed.sequence);
      const acknowledgedSequence = this.readAcknowledgedWorkerSequence(
        parsed.senderDeviceId,
        state,
      );
      if (effect.status === "handled") {
        return {
          disposition: "handled" as const,
          acknowledgedSequence,
        };
      }
      if (effect.status === "processing") {
        return {
          disposition: "processing" as const,
          acknowledgedSequence,
        };
      }
      const result = this.database
        .prepare(
          `UPDATE od_device_channel_inbound_effect
           SET status = 'processing', claim_id = ?
           WHERE device_id = ? AND sequence = ? AND status = 'received' AND claim_id IS NULL`,
        )
        .run(claimId, parsed.senderDeviceId, parsed.sequence);
      if (result.changes !== 1) {
        throw corruptState();
      }
      return {
        disposition: "claimed" as const,
        acknowledgedSequence,
      };
    });
  }

  public async completeInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectCompletionResult> {
    this.assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    return this.transaction(() => {
      const state = this.requireState(parsed.senderDeviceId);
      this.requireInboundIdentity(parsed, fingerprint);
      const effect = this.requireInboundEffect(parsed.senderDeviceId, parsed.sequence);
      if (effect.status === "handled") {
        return {
          acknowledgedSequence: this.readAcknowledgedWorkerSequence(parsed.senderDeviceId, state),
        };
      }
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = this.database
        .prepare(
          `UPDATE od_device_channel_inbound_effect
           SET status = 'handled', claim_id = NULL
           WHERE device_id = ? AND sequence = ? AND status = 'processing' AND claim_id = ?`,
        )
        .run(parsed.senderDeviceId, parsed.sequence, claimId);
      if (result.changes !== 1) {
        throw invalidEffectClaim();
      }
      return {
        acknowledgedSequence: this.readAcknowledgedWorkerSequence(parsed.senderDeviceId, state),
      };
    });
  }

  public async releaseInboundEffect(
    frame: WorkerToMainFrameV1,
    claimIdInput: string,
  ): Promise<void> {
    this.assertOpen();
    const parsed = normalizeWorkerFrame(frame);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(parsed)).digest("hex");
    this.transaction(() => {
      this.requireState(parsed.senderDeviceId);
      this.requireInboundIdentity(parsed, fingerprint);
      const effect = this.requireInboundEffect(parsed.senderDeviceId, parsed.sequence);
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = this.database
        .prepare(
          `UPDATE od_device_channel_inbound_effect
           SET status = 'received', claim_id = NULL
           WHERE device_id = ? AND sequence = ? AND status = 'processing' AND claim_id = ?`,
        )
        .run(parsed.senderDeviceId, parsed.sequence, claimId);
      if (result.changes !== 1) {
        throw invalidEffectClaim();
      }
    });
  }

  public async enqueueOutbound(
    deviceIdInput: string,
    createFrame: (sequence: number) => MainToWorkerFrameV1,
  ): Promise<MainToWorkerFrameV1> {
    this.assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    return this.transaction(() => {
      const state = this.requireState(deviceId);
      let frame: MainToWorkerFrameV1;
      try {
        frame = createFrame(state.next_main_sequence);
      } catch {
        throw repositoryError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Device channel frame could not be created.",
        );
      }
      if (frame.sequence !== state.next_main_sequence) {
        throw repositoryError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Device channel frame used the wrong durable sequence.",
        );
      }
      const parsed = decodeDeviceChannelFrame(
        encodeDeviceChannelFrame(frame),
        frame.senderDeviceId,
        "main-to-worker",
      ) as MainToWorkerFrameV1;
      const encoded = encodeDeviceChannelFrame(parsed).toString("utf8");
      const collision = this.database
        .prepare(
          `SELECT sequence
           FROM od_device_channel_outbox
           WHERE device_id = ?
             AND (sequence = ? OR message_id = ? OR idempotency_key = ?)
           LIMIT 1`,
        )
        .get(deviceId, parsed.sequence, parsed.messageId, parsed.idempotencyKey) as
        { readonly sequence: number } | undefined;
      if (collision !== undefined) {
        throw repositoryError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "The outbound Device channel identity is already in use.",
        );
      }
      try {
        this.database
          .prepare(
            `INSERT INTO od_device_channel_outbox (
               device_id, sequence, message_id, idempotency_key, frame_json
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(deviceId, parsed.sequence, parsed.messageId, parsed.idempotencyKey, encoded);
        this.database
          .prepare(
            `UPDATE od_device_channel_state
             SET next_main_sequence = ?
             WHERE device_id = ?`,
          )
          .run(parsed.sequence + 1, deviceId);
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        throw repositoryError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "The outbound Device channel identity is already in use.",
        );
      }
      return deepFreeze(parsed);
    });
  }

  public async acknowledgeOutbound(input: AcknowledgeOutboundInput): Promise<void> {
    this.assertOpen();
    const deviceId = validateDeviceId(input.deviceId);
    const acknowledgedSequence = readNonNegativeInteger(
      input.acknowledgedMainSequence,
      "Main acknowledgment",
    );
    const messageIds = validateMessageIds(input.acknowledgedMessageIds);
    this.transaction(() => {
      const state = this.requireState(deviceId);
      if (acknowledgedSequence <= state.acknowledged_main_sequence) {
        return;
      }
      if (acknowledgedSequence >= state.next_main_sequence) {
        throw invalidAck();
      }
      const rows = this.database
        .prepare(
          `SELECT sequence, message_id, idempotency_key, frame_json
           FROM od_device_channel_outbox
           WHERE device_id = ? AND sequence > ? AND sequence <= ?
           ORDER BY sequence`,
        )
        .all(
          deviceId,
          state.acknowledged_main_sequence,
          acknowledgedSequence,
        ) as OutboundFrameRow[];
      if (
        rows.length !== acknowledgedSequence - state.acknowledged_main_sequence ||
        rows.length !== messageIds.length ||
        rows.some(
          (row, index) =>
            row.sequence !== state.acknowledged_main_sequence + index + 1 ||
            row.message_id !== messageIds[index],
        )
      ) {
        throw invalidAck();
      }
      if (acknowledgedSequence > state.acknowledged_main_sequence) {
        this.database
          .prepare(
            `UPDATE od_device_channel_state
             SET acknowledged_main_sequence = ?
             WHERE device_id = ?`,
          )
          .run(acknowledgedSequence, deviceId);
        const deleteFrame = this.database.prepare(
          `DELETE FROM od_device_channel_outbox
           WHERE device_id = ? AND sequence = ?`,
        );
        for (const row of rows) {
          if (!isDurableCommandFrame(decodeOutboundRow(row))) {
            deleteFrame.run(deviceId, row.sequence);
          }
        }
      }
    });
  }

  public async outboundByIdempotencyKey(
    deviceIdInput: string,
    idempotencyKeyInput: string,
  ): Promise<MainToWorkerFrameV1 | undefined> {
    this.assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    const idempotencyKey = validateFrameIdentity(idempotencyKeyInput, "idempotency key");
    this.requireState(deviceId);
    const row = this.database
      .prepare(
        `SELECT sequence, message_id, idempotency_key, frame_json
         FROM od_device_channel_outbox
         WHERE device_id = ? AND idempotency_key = ?`,
      )
      .get(deviceId, idempotencyKey) as OutboundFrameRow | undefined;
    return row === undefined ? undefined : deepFreeze(decodeOutboundRow(row));
  }

  public async resume(deviceIdInput: string): Promise<DeviceChannelResumeState> {
    this.assertOpen();
    const deviceId = validateDeviceId(deviceIdInput);
    const state = this.requireState(deviceId);
    const rows = this.database
      .prepare(
        `SELECT sequence, message_id, idempotency_key, frame_json
         FROM od_device_channel_outbox
         WHERE device_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(deviceId, state.acknowledged_main_sequence) as OutboundFrameRow[];
    const expectedCount = state.next_main_sequence - state.acknowledged_main_sequence - 1;
    if (
      rows.length !== expectedCount ||
      rows.some((row, index) => row.sequence !== state.acknowledged_main_sequence + index + 1)
    ) {
      throw corruptState();
    }
    const pendingOutbound = rows.map((row) => {
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
        (parsed as { sequence?: unknown }).sequence !== row.sequence ||
        (parsed as { messageId?: unknown }).messageId !== row.message_id ||
        (parsed as { idempotencyKey?: unknown }).idempotencyKey !== row.idempotency_key
      ) {
        throw corruptState();
      }
      try {
        return decodeDeviceChannelFrame(
          Buffer.from(row.frame_json, "utf8"),
          (parsed as { senderDeviceId: string }).senderDeviceId,
          "main-to-worker",
        ) as MainToWorkerFrameV1;
      } catch {
        throw corruptState();
      }
    });
    return deepFreeze({
      acknowledgedWorkerSequence: this.readAcknowledgedWorkerSequence(deviceId, state),
      acknowledgedMainSequence: state.acknowledged_main_sequence,
      nextMainSequence: state.next_main_sequence,
      pendingOutbound,
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  private transaction<TResult>(operation: () => TResult): TResult {
    try {
      return this.database.transaction(operation)();
    } catch (error) {
      if (error instanceof DeviceChannelRepositoryError) {
        throw error;
      }
      throw repositoryError(
        "CHANNEL_STORAGE_UNAVAILABLE",
        "The Device channel repository transaction failed.",
      );
    }
  }

  private readState(deviceId: string): ChannelStateRow | undefined {
    return this.database
      .prepare(
        `SELECT device_id, certificate_generation, last_worker_sequence,
                acknowledged_main_sequence, next_main_sequence
         FROM od_device_channel_state
         WHERE device_id = ?`,
      )
      .get(deviceId) as ChannelStateRow | undefined;
  }

  private requireState(deviceId: string): ChannelStateRow {
    const state = this.readState(deviceId);
    if (state === undefined) {
      throw repositoryError(
        "CHANNEL_NOT_REGISTERED",
        "The Device channel has no authenticated connection state.",
      );
    }
    for (const value of [
      state.certificate_generation,
      state.last_worker_sequence,
      state.acknowledged_main_sequence,
      state.next_main_sequence,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw corruptState();
      }
    }
    if (
      state.certificate_generation <= 0 ||
      state.next_main_sequence <= 0 ||
      state.acknowledged_main_sequence >= state.next_main_sequence
    ) {
      throw corruptState();
    }
    return state;
  }

  private requireInboundIdentity(
    frame: WorkerToMainFrameV1,
    fingerprint: string,
  ): InboundIdentityRow {
    const rows = this.database
      .prepare(
        `SELECT sequence, message_id, idempotency_key, fingerprint
         FROM od_device_channel_inbox
         WHERE device_id = ? AND (sequence = ? OR message_id = ? OR idempotency_key = ?)
         ORDER BY sequence`,
      )
      .all(
        frame.senderDeviceId,
        frame.sequence,
        frame.messageId,
        frame.idempotencyKey,
      ) as InboundIdentityRow[];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.sequence !== frame.sequence ||
      row.message_id !== frame.messageId ||
      row.idempotency_key !== frame.idempotencyKey ||
      row.fingerprint !== fingerprint
    ) {
      throw repositoryError(
        "CHANNEL_IDEMPOTENCY_CONFLICT",
        "The inbound Device channel effect does not match its durable frame.",
      );
    }
    return row;
  }

  private requireInboundEffect(deviceId: string, sequence: number): InboundEffectRow {
    const effect = this.database
      .prepare(
        `SELECT status, claim_id
         FROM od_device_channel_inbound_effect
         WHERE device_id = ? AND sequence = ?`,
      )
      .get(deviceId, sequence) as InboundEffectRow | undefined;
    if (
      effect === undefined ||
      !["handled", "processing", "received"].includes(effect.status) ||
      (effect.status === "processing") !== (effect.claim_id !== null)
    ) {
      throw corruptState();
    }
    return effect;
  }

  private readAcknowledgedWorkerSequence(deviceId: string, state: ChannelStateRow): number {
    const rows = this.database
      .prepare(
        `SELECT inbox.sequence, effect.status
         FROM od_device_channel_inbox AS inbox
         LEFT JOIN od_device_channel_inbound_effect AS effect
           ON effect.device_id = inbox.device_id AND effect.sequence = inbox.sequence
         WHERE inbox.device_id = ?
         ORDER BY inbox.sequence`,
      )
      .all(deviceId) as InboundEffectSequenceRow[];
    if (
      rows.length !== state.last_worker_sequence ||
      rows.some(
        (row, index) =>
          row.sequence !== index + 1 ||
          !["handled", "processing", "received"].includes(row.status ?? ""),
      )
    ) {
      throw corruptState();
    }
    let acknowledgedSequence = 0;
    for (const row of rows) {
      if (row.status !== "handled") {
        break;
      }
      acknowledgedSequence = row.sequence;
    }
    return acknowledgedSequence;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw repositoryError(
        "CHANNEL_REPOSITORY_CLOSED",
        "The Device channel repository is closed.",
      );
    }
  }
}

function validateDatabasePath(filename: string, sourceCheckoutRoot: string): string {
  if (
    !isAbsolute(filename) ||
    !isAbsolute(sourceCheckoutRoot) ||
    filename !== filename.trim() ||
    sourceCheckoutRoot !== sourceCheckoutRoot.trim() ||
    filename.includes("\0") ||
    sourceCheckoutRoot.includes("\0")
  ) {
    throw repositoryError(
      "CHANNEL_CONFIGURATION_INVALID",
      "Device channel database paths must be absolute.",
    );
  }
  const resolvedFile = resolve(filename);
  const relationship = relative(resolve(sourceCheckoutRoot), resolvedFile);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw repositoryError(
      "CHANNEL_CONFIGURATION_INVALID",
      "Device channel state must remain outside the source checkout.",
    );
  }
  return resolvedFile;
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

function decodeOutboundRow(row: OutboundFrameRow): MainToWorkerFrameV1 {
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
    (parsed as { sequence?: unknown }).sequence !== row.sequence ||
    (parsed as { messageId?: unknown }).messageId !== row.message_id ||
    (parsed as { idempotencyKey?: unknown }).idempotencyKey !== row.idempotency_key ||
    typeof (parsed as { senderDeviceId?: unknown }).senderDeviceId !== "string"
  ) {
    throw corruptState();
  }
  try {
    return decodeDeviceChannelFrame(
      Buffer.from(row.frame_json, "utf8"),
      (parsed as { senderDeviceId: string }).senderDeviceId,
      "main-to-worker",
    ) as MainToWorkerFrameV1;
  } catch {
    throw corruptState();
  }
}

function isDurableCommandFrame(frame: MainToWorkerFrameV1): boolean {
  return (
    frame.type === "main.control" ||
    frame.type === "main.dispatch" ||
    frame.type === "main.revoked" ||
    frame.type === "main.run.lease" ||
    frame.type === "main.run.steer"
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
  code: DeviceChannelRepositoryErrorCode,
  message: string,
): DeviceChannelRepositoryError {
  return new DeviceChannelRepositoryError(code, message);
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
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

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS od_device_channel_schema (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;
INSERT INTO od_device_channel_schema (singleton_id, schema_version)
VALUES (1, 1)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS od_device_channel_state (
  device_id TEXT PRIMARY KEY,
  certificate_generation INTEGER NOT NULL CHECK (certificate_generation > 0),
  last_worker_sequence INTEGER NOT NULL CHECK (last_worker_sequence >= 0),
  acknowledged_main_sequence INTEGER NOT NULL CHECK (acknowledged_main_sequence >= 0),
  next_main_sequence INTEGER NOT NULL CHECK (next_main_sequence > 0),
  CHECK (acknowledged_main_sequence < next_main_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS od_device_channel_inbox (
  device_id TEXT NOT NULL REFERENCES od_device_channel_state(device_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  frame_json TEXT NOT NULL,
  PRIMARY KEY (device_id, sequence),
  UNIQUE (device_id, message_id),
  UNIQUE (device_id, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS od_device_channel_inbound_effect (
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'handled')),
  claim_id TEXT,
  PRIMARY KEY (device_id, sequence),
  FOREIGN KEY (device_id, sequence)
    REFERENCES od_device_channel_inbox(device_id, sequence) ON DELETE RESTRICT,
  CHECK (
    (status = 'processing' AND claim_id IS NOT NULL)
    OR (status <> 'processing' AND claim_id IS NULL)
  )
) STRICT;

INSERT INTO od_device_channel_inbound_effect (device_id, sequence, status, claim_id)
SELECT device_id, sequence, 'handled', NULL
FROM od_device_channel_inbox
WHERE 1
ON CONFLICT (device_id, sequence) DO NOTHING;

UPDATE od_device_channel_inbound_effect
SET status = 'received', claim_id = NULL
WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS od_device_channel_outbox (
  device_id TEXT NOT NULL REFERENCES od_device_channel_state(device_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  PRIMARY KEY (device_id, sequence),
  UNIQUE (device_id, message_id),
  UNIQUE (device_id, idempotency_key)
) STRICT;
`;
