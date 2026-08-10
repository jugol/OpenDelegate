import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  DeviceChannelRepositoryError,
  type DeviceChannelRepositoryErrorCode,
  type InboundEffectClaimResult,
  type InboundEffectCompletionResult,
} from "./channel-repository.ts";
import {
  decodeDeviceChannelFrame,
  encodeDeviceChannelFrame,
  type MainToWorkerFrameV1,
  type WorkerToMainFrameV1,
} from "./protocol.ts";

export interface OpenSqliteWorkerChannelStateOptions {
  readonly filename: string;
  readonly sourceCheckoutRoot: string;
  readonly deviceId: string;
  readonly mainDeviceId: string;
  readonly certificateGeneration: number;
  /** Clears only transport durability when owner-approved re-credentialing advances generation. */
  readonly resetForRecredential?: boolean;
  readonly busyTimeoutMs?: number;
}

export interface WorkerChannelResumeState {
  readonly acknowledgedMainSequence: number;
  readonly acknowledgedWorkerSequence: number;
  readonly nextWorkerSequence: number;
  readonly pendingOutbound: readonly WorkerToMainFrameV1[];
}

export interface WorkerMainAcknowledgment {
  readonly acknowledgedMainSequence: number;
  readonly acknowledgedMessageIds: readonly string[];
}

export interface WorkerInboundCommitResult {
  readonly disposition: "accepted" | "duplicate";
  readonly acknowledgedMainSequence: number;
}

interface WorkerChannelStateRow {
  readonly device_id: string;
  readonly main_device_id: string;
  readonly certificate_generation: number;
  readonly last_main_sequence: number;
  readonly last_main_acknowledgment_sequence: number;
  readonly acknowledged_worker_sequence: number;
  readonly next_worker_sequence: number;
}

interface PersistedIdentityRow {
  readonly idempotency_key: string;
  readonly message_id: string;
  readonly sequence: number;
  readonly fingerprint: string;
}

interface WorkerInboundEffectRow {
  readonly claim_id: string | null;
  readonly status: "handled" | "processing" | "received";
}

interface WorkerInboundEffectSequenceRow {
  readonly sequence: number;
  readonly status: "handled" | "processing" | "received" | null;
}

interface PersistedFrameRow {
  readonly sequence: number;
  readonly frame_json: string;
}

export class SqliteWorkerChannelState {
  private readonly database: Database.Database;
  private readonly deviceId: string;
  private readonly mainDeviceId: string;
  private closed = false;

  private constructor(database: Database.Database, deviceId: string, mainDeviceId: string) {
    this.database = database;
    this.deviceId = deviceId;
    this.mainDeviceId = mainDeviceId;
  }

  public static async open(
    options: OpenSqliteWorkerChannelStateOptions,
  ): Promise<SqliteWorkerChannelState> {
    const filename = validateStatePath(options.filename, options.sourceCheckoutRoot);
    const deviceId = validateDeviceId(options.deviceId);
    const mainDeviceId = validateDeviceId(options.mainDeviceId);
    const generation = readPositiveInteger(options.certificateGeneration, "certificate generation");
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
      throw stateError(
        "CHANNEL_CONFIGURATION_INVALID",
        "The Worker channel SQLite busy timeout is invalid.",
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
      database.exec(WORKER_CHANNEL_SCHEMA);
      const state = new SqliteWorkerChannelState(database, deviceId, mainDeviceId);
      state.initialize(generation, options.resetForRecredential === true);
      if (process.platform !== "win32") {
        await chmod(filename, 0o600);
      }
      return state;
    } catch (error) {
      database?.close();
      if (error instanceof DeviceChannelRepositoryError) {
        throw error;
      }
      throw stateError(
        "CHANNEL_STORAGE_UNAVAILABLE",
        "The Worker channel SQLite state is unavailable.",
      );
    }
  }

  public async enqueueOutbound(
    createFrame: (sequence: number) => WorkerToMainFrameV1,
  ): Promise<WorkerToMainFrameV1> {
    this.assertOpen();
    return this.transaction(() => {
      const state = this.readState();
      let candidate: WorkerToMainFrameV1;
      try {
        candidate = createFrame(state.next_worker_sequence);
      } catch {
        throw stateError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Worker channel frame could not be created.",
        );
      }
      if (
        candidate.sequence !== state.next_worker_sequence ||
        candidate.senderDeviceId !== this.deviceId
      ) {
        throw stateError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The outbound Worker frame used an invalid sender or durable sequence.",
        );
      }
      const frame = decodeDeviceChannelFrame(
        encodeDeviceChannelFrame(candidate),
        this.deviceId,
        "worker-to-main",
      ) as WorkerToMainFrameV1;
      const encoded = encodeDeviceChannelFrame(frame).toString("utf8");
      try {
        this.database
          .prepare(
            `INSERT INTO od_worker_channel_outbox (
               singleton_id, sequence, message_id, idempotency_key, frame_json
             ) VALUES (1, ?, ?, ?, ?)`,
          )
          .run(frame.sequence, frame.messageId, frame.idempotencyKey, encoded);
        this.database
          .prepare(
            `UPDATE od_worker_channel_state
             SET next_worker_sequence = ?
             WHERE singleton_id = 1`,
          )
          .run(frame.sequence + 1);
      } catch {
        throw stateError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "The outbound Worker channel identity is already in use.",
        );
      }
      return deepFreeze(frame);
    });
  }

  public async enqueueMainAcknowledgment(
    createFrame: (
      sequence: number,
      acknowledgment: WorkerMainAcknowledgment,
    ) => WorkerToMainFrameV1,
  ): Promise<WorkerToMainFrameV1 | undefined> {
    this.assertOpen();
    return this.transaction(() => {
      const state = this.readState();
      const acknowledgedMainSequence = this.readAcknowledgedMainSequence(state);
      if (state.last_main_acknowledgment_sequence > acknowledgedMainSequence) {
        throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel acknowledgment is invalid.");
      }
      if (state.last_main_acknowledgment_sequence === acknowledgedMainSequence) {
        return undefined;
      }
      const rows = this.database
        .prepare(
          `SELECT sequence, message_id
           FROM od_worker_channel_inbox
           WHERE singleton_id = 1
             AND sequence > ?
             AND sequence <= ?
           ORDER BY sequence`,
        )
        .all(state.last_main_acknowledgment_sequence, acknowledgedMainSequence) as Array<{
        readonly sequence: number;
        readonly message_id: string;
      }>;
      if (
        rows.length !== acknowledgedMainSequence - state.last_main_acknowledgment_sequence ||
        rows.some(
          (row, index) => row.sequence !== state.last_main_acknowledgment_sequence + index + 1,
        )
      ) {
        throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel inbox is not contiguous.");
      }
      const acknowledgment = deepFreeze({
        acknowledgedMainSequence,
        acknowledgedMessageIds: rows.map((row) => row.message_id),
      });
      const frame = createFrame(state.next_worker_sequence, acknowledgment);
      if (
        frame.type !== "worker.ack" ||
        frame.sequence !== state.next_worker_sequence ||
        frame.senderDeviceId !== this.deviceId ||
        frame.payload.acknowledgedMainSequence !== acknowledgment.acknowledgedMainSequence ||
        frame.payload.acknowledgedMessageIds.length !==
          acknowledgment.acknowledgedMessageIds.length ||
        frame.payload.acknowledgedMessageIds.some(
          (messageId, index) => messageId !== acknowledgment.acknowledgedMessageIds[index],
        )
      ) {
        throw stateError(
          "CHANNEL_CONFIGURATION_INVALID",
          "The Worker acknowledgment frame does not match the durable Main prefix.",
        );
      }
      const parsed = decodeDeviceChannelFrame(
        encodeDeviceChannelFrame(frame),
        this.deviceId,
        "worker-to-main",
      ) as WorkerToMainFrameV1;
      try {
        this.database
          .prepare(
            `INSERT INTO od_worker_channel_outbox (
               singleton_id, sequence, message_id, idempotency_key, frame_json
             ) VALUES (1, ?, ?, ?, ?)`,
          )
          .run(
            parsed.sequence,
            parsed.messageId,
            parsed.idempotencyKey,
            encodeDeviceChannelFrame(parsed).toString("utf8"),
          );
        this.database
          .prepare(
            `UPDATE od_worker_channel_state
             SET next_worker_sequence = ?,
                 last_main_acknowledgment_sequence = ?
             WHERE singleton_id = 1`,
          )
          .run(parsed.sequence + 1, acknowledgment.acknowledgedMainSequence);
      } catch {
        throw stateError(
          "CHANNEL_IDEMPOTENCY_CONFLICT",
          "The Worker acknowledgment identity is already in use.",
        );
      }
      return deepFreeze(parsed);
    });
  }

  public async confirmMainAcknowledgment(acknowledgedMainSequence: number): Promise<void> {
    this.assertOpen();
    const sequence = readNonNegativeInteger(
      acknowledgedMainSequence,
      "confirmed Main acknowledgment",
    );
    this.transaction(() => {
      const state = this.readState();
      const handledSequence = this.readAcknowledgedMainSequence(state);
      if (sequence < state.last_main_acknowledgment_sequence || sequence > handledSequence) {
        throw stateError(
          "CHANNEL_ACK_INVALID",
          "The confirmed Main acknowledgment is outside the handled prefix.",
        );
      }
      this.database
        .prepare(
          `UPDATE od_worker_channel_state
           SET last_main_acknowledgment_sequence = ?
           WHERE singleton_id = 1`,
        )
        .run(sequence);
    });
  }

  public async commitInbound(frameInput: MainToWorkerFrameV1): Promise<WorkerInboundCommitResult> {
    this.assertOpen();
    const frame = this.normalizeMainFrame(frameInput);
    const encoded = encodeDeviceChannelFrame(frame);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    return this.transaction(() => {
      const state = this.readState();
      const duplicate = this.database
        .prepare(
          `SELECT sequence, message_id, idempotency_key, fingerprint
           FROM od_worker_channel_inbox
           WHERE singleton_id = 1
             AND (sequence = ? OR message_id = ? OR idempotency_key = ?)
           LIMIT 1`,
        )
        .get(frame.sequence, frame.messageId, frame.idempotencyKey) as
        PersistedIdentityRow | undefined;
      if (duplicate !== undefined) {
        if (duplicate.sequence !== frame.sequence || duplicate.fingerprint !== fingerprint) {
          throw stateError(
            "CHANNEL_IDEMPOTENCY_CONFLICT",
            "A Main channel message identity was reused with different content.",
          );
        }
        return {
          disposition: "duplicate" as const,
          acknowledgedMainSequence: this.readAcknowledgedMainSequence(state),
        };
      }
      if (frame.sequence !== state.last_main_sequence + 1) {
        throw stateError(
          "CHANNEL_SEQUENCE_GAP",
          "The Main channel sequence is not the next durable value.",
        );
      }
      this.database
        .prepare(
          `INSERT INTO od_worker_channel_inbox (
             singleton_id, sequence, message_id, idempotency_key, fingerprint, frame_json
           ) VALUES (1, ?, ?, ?, ?, ?)`,
        )
        .run(
          frame.sequence,
          frame.messageId,
          frame.idempotencyKey,
          fingerprint,
          encoded.toString("utf8"),
        );
      this.database
        .prepare(
          `INSERT INTO od_worker_channel_inbound_effect (
             singleton_id, sequence, status, claim_id
           ) VALUES (1, ?, 'received', NULL)`,
        )
        .run(frame.sequence);
      this.database
        .prepare(
          `UPDATE od_worker_channel_state
           SET last_main_sequence = ?
           WHERE singleton_id = 1`,
        )
        .run(frame.sequence);
      return {
        disposition: "accepted" as const,
        acknowledgedMainSequence: this.readAcknowledgedMainSequence({
          ...state,
          last_main_sequence: frame.sequence,
        }),
      };
    });
  }

  public async claimInboundEffect(
    frameInput: MainToWorkerFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectClaimResult> {
    this.assertOpen();
    const frame = this.normalizeMainFrame(frameInput);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(frame)).digest("hex");
    return this.transaction(() => {
      const state = this.readState();
      this.requireInboundIdentity(frame, fingerprint);
      const effect = this.requireInboundEffect(frame.sequence);
      const acknowledgedSequence = this.readAcknowledgedMainSequence(state);
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
          `UPDATE od_worker_channel_inbound_effect
           SET status = 'processing', claim_id = ?
           WHERE singleton_id = 1 AND sequence = ?
             AND status = 'received' AND claim_id IS NULL`,
        )
        .run(claimId, frame.sequence);
      if (result.changes !== 1) {
        throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
      }
      return {
        disposition: "claimed" as const,
        acknowledgedSequence,
      };
    });
  }

  public async completeInboundEffect(
    frameInput: MainToWorkerFrameV1,
    claimIdInput: string,
  ): Promise<InboundEffectCompletionResult> {
    this.assertOpen();
    const frame = this.normalizeMainFrame(frameInput);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(frame)).digest("hex");
    return this.transaction(() => {
      const state = this.readState();
      this.requireInboundIdentity(frame, fingerprint);
      const effect = this.requireInboundEffect(frame.sequence);
      if (effect.status === "handled") {
        return {
          acknowledgedSequence: this.readAcknowledgedMainSequence(state),
        };
      }
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = this.database
        .prepare(
          `UPDATE od_worker_channel_inbound_effect
           SET status = 'handled', claim_id = NULL
           WHERE singleton_id = 1 AND sequence = ?
             AND status = 'processing' AND claim_id = ?`,
        )
        .run(frame.sequence, claimId);
      if (result.changes !== 1) {
        throw invalidEffectClaim();
      }
      return {
        acknowledgedSequence: this.readAcknowledgedMainSequence(state),
      };
    });
  }

  public async releaseInboundEffect(
    frameInput: MainToWorkerFrameV1,
    claimIdInput: string,
  ): Promise<void> {
    this.assertOpen();
    const frame = this.normalizeMainFrame(frameInput);
    const claimId = validateFrameIdentity(claimIdInput, "inbound effect claim ID");
    const fingerprint = createHash("sha256").update(encodeDeviceChannelFrame(frame)).digest("hex");
    this.transaction(() => {
      this.readState();
      this.requireInboundIdentity(frame, fingerprint);
      const effect = this.requireInboundEffect(frame.sequence);
      if (effect.status !== "processing" || effect.claim_id !== claimId) {
        throw invalidEffectClaim();
      }
      const result = this.database
        .prepare(
          `UPDATE od_worker_channel_inbound_effect
           SET status = 'received', claim_id = NULL
           WHERE singleton_id = 1 AND sequence = ?
             AND status = 'processing' AND claim_id = ?`,
        )
        .run(frame.sequence, claimId);
      if (result.changes !== 1) {
        throw invalidEffectClaim();
      }
    });
  }

  public async acknowledgeOutbound(acknowledgedWorkerSequence: number): Promise<void> {
    this.assertOpen();
    const sequence = readNonNegativeInteger(acknowledgedWorkerSequence, "Worker acknowledgment");
    this.transaction(() => {
      const state = this.readState();
      if (sequence < state.acknowledged_worker_sequence || sequence >= state.next_worker_sequence) {
        throw stateError(
          "CHANNEL_ACK_INVALID",
          "The Main acknowledgment is outside the durable Worker outbox.",
        );
      }
      this.database
        .prepare(
          `DELETE FROM od_worker_channel_outbox
           WHERE singleton_id = 1 AND sequence <= ?`,
        )
        .run(sequence);
      this.database
        .prepare(
          `UPDATE od_worker_channel_state
           SET acknowledged_worker_sequence = ?
           WHERE singleton_id = 1`,
        )
        .run(sequence);
    });
  }

  public async resume(): Promise<WorkerChannelResumeState> {
    this.assertOpen();
    const state = this.readState();
    const rows = this.database
      .prepare(
        `SELECT sequence, frame_json
         FROM od_worker_channel_outbox
         WHERE singleton_id = 1 AND sequence > ?
         ORDER BY sequence`,
      )
      .all(state.acknowledged_worker_sequence) as PersistedFrameRow[];
    const pendingOutbound = rows.map((row) => {
      try {
        const frame = decodeDeviceChannelFrame(
          Buffer.from(row.frame_json, "utf8"),
          this.deviceId,
          "worker-to-main",
        ) as WorkerToMainFrameV1;
        if (frame.sequence !== row.sequence) {
          throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
        }
        return frame;
      } catch (error) {
        if (error instanceof DeviceChannelRepositoryError) {
          throw error;
        }
        throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
      }
    });
    return deepFreeze({
      acknowledgedMainSequence: this.readAcknowledgedMainSequence(state),
      acknowledgedWorkerSequence: state.acknowledged_worker_sequence,
      nextWorkerSequence: state.next_worker_sequence,
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

  private initialize(certificateGeneration: number, resetForRecredential: boolean): void {
    this.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT device_id, main_device_id, certificate_generation,
                  last_main_sequence, last_main_acknowledgment_sequence,
                  acknowledged_worker_sequence, next_worker_sequence
           FROM od_worker_channel_state
           WHERE singleton_id = 1`,
        )
        .get() as WorkerChannelStateRow | undefined;
      if (existing === undefined) {
        this.database
          .prepare(
            `INSERT INTO od_worker_channel_state (
               singleton_id, device_id, main_device_id, certificate_generation,
               last_main_sequence, last_main_acknowledgment_sequence,
               acknowledged_worker_sequence, next_worker_sequence
             ) VALUES (1, ?, ?, ?, 0, 0, 0, 1)`,
          )
          .run(this.deviceId, this.mainDeviceId, certificateGeneration);
        return;
      }
      if (existing.device_id !== this.deviceId || existing.main_device_id !== this.mainDeviceId) {
        throw stateError(
          "CHANNEL_CONFIGURATION_INVALID",
          "Worker channel state belongs to a different Device relationship.",
        );
      }
      if (certificateGeneration < existing.certificate_generation) {
        throw stateError(
          "CHANNEL_GENERATION_STALE",
          "A stale Worker certificate generation cannot resume this channel.",
        );
      }
      if (certificateGeneration > existing.certificate_generation) {
        if (resetForRecredential) {
          this.database
            .prepare("DELETE FROM od_worker_channel_inbound_effect WHERE singleton_id = 1")
            .run();
          this.database.prepare("DELETE FROM od_worker_channel_inbox WHERE singleton_id = 1").run();
          this.database
            .prepare("DELETE FROM od_worker_channel_outbox WHERE singleton_id = 1")
            .run();
          this.database
            .prepare(
              `UPDATE od_worker_channel_state
               SET certificate_generation = ?, last_main_sequence = 0,
                   last_main_acknowledgment_sequence = 0,
                   acknowledged_worker_sequence = 0, next_worker_sequence = 1
               WHERE singleton_id = 1`,
            )
            .run(certificateGeneration);
          return;
        }
        this.database
          .prepare(
            `UPDATE od_worker_channel_state
             SET certificate_generation = ?
             WHERE singleton_id = 1`,
          )
          .run(certificateGeneration);
      }
    });
  }

  private readState(): WorkerChannelStateRow {
    const state = this.database
      .prepare(
        `SELECT device_id, main_device_id, certificate_generation,
                last_main_sequence, last_main_acknowledgment_sequence,
                acknowledged_worker_sequence, next_worker_sequence
         FROM od_worker_channel_state
         WHERE singleton_id = 1`,
      )
      .get() as WorkerChannelStateRow | undefined;
    if (
      state === undefined ||
      state.device_id !== this.deviceId ||
      state.main_device_id !== this.mainDeviceId ||
      !Number.isSafeInteger(state.certificate_generation) ||
      state.certificate_generation <= 0 ||
      !Number.isSafeInteger(state.last_main_sequence) ||
      state.last_main_sequence < 0 ||
      !Number.isSafeInteger(state.last_main_acknowledgment_sequence) ||
      state.last_main_acknowledgment_sequence < 0 ||
      state.last_main_acknowledgment_sequence > state.last_main_sequence ||
      !Number.isSafeInteger(state.acknowledged_worker_sequence) ||
      state.acknowledged_worker_sequence < 0 ||
      !Number.isSafeInteger(state.next_worker_sequence) ||
      state.next_worker_sequence <= 0 ||
      state.acknowledged_worker_sequence >= state.next_worker_sequence
    ) {
      throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
    }
    return state;
  }

  private normalizeMainFrame(frame: MainToWorkerFrameV1): MainToWorkerFrameV1 {
    try {
      return decodeDeviceChannelFrame(
        encodeDeviceChannelFrame(frame),
        this.mainDeviceId,
        "main-to-worker",
      ) as MainToWorkerFrameV1;
    } catch {
      throw stateError(
        "CHANNEL_CONFIGURATION_INVALID",
        "The inbound Main channel frame is invalid.",
      );
    }
  }

  private requireInboundIdentity(
    frame: MainToWorkerFrameV1,
    fingerprint: string,
  ): PersistedIdentityRow {
    const rows = this.database
      .prepare(
        `SELECT sequence, message_id, idempotency_key, fingerprint
         FROM od_worker_channel_inbox
         WHERE singleton_id = 1
           AND (sequence = ? OR message_id = ? OR idempotency_key = ?)
         ORDER BY sequence`,
      )
      .all(frame.sequence, frame.messageId, frame.idempotencyKey) as PersistedIdentityRow[];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.sequence !== frame.sequence ||
      row.message_id !== frame.messageId ||
      row.idempotency_key !== frame.idempotencyKey ||
      row.fingerprint !== fingerprint
    ) {
      throw stateError(
        "CHANNEL_IDEMPOTENCY_CONFLICT",
        "The inbound Main channel effect does not match its durable frame.",
      );
    }
    return row;
  }

  private requireInboundEffect(sequence: number): WorkerInboundEffectRow {
    const effect = this.database
      .prepare(
        `SELECT status, claim_id
         FROM od_worker_channel_inbound_effect
         WHERE singleton_id = 1 AND sequence = ?`,
      )
      .get(sequence) as WorkerInboundEffectRow | undefined;
    if (
      effect === undefined ||
      !["handled", "processing", "received"].includes(effect.status) ||
      (effect.status === "processing") !== (effect.claim_id !== null)
    ) {
      throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
    }
    return effect;
  }

  private readAcknowledgedMainSequence(state: WorkerChannelStateRow): number {
    const rows = this.database
      .prepare(
        `SELECT inbox.sequence, effect.status
         FROM od_worker_channel_inbox AS inbox
         LEFT JOIN od_worker_channel_inbound_effect AS effect
           ON effect.singleton_id = inbox.singleton_id AND effect.sequence = inbox.sequence
         WHERE inbox.singleton_id = 1
         ORDER BY inbox.sequence`,
      )
      .all() as WorkerInboundEffectSequenceRow[];
    if (
      rows.length !== state.last_main_sequence ||
      rows.some(
        (row, index) =>
          row.sequence !== index + 1 ||
          !["handled", "processing", "received"].includes(row.status ?? ""),
      )
    ) {
      throw stateError("CHANNEL_STATE_CORRUPT", "Worker channel state is invalid.");
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

  private transaction<TResult>(operation: () => TResult): TResult {
    try {
      return this.database.transaction(operation)();
    } catch (error) {
      if (error instanceof DeviceChannelRepositoryError) {
        throw error;
      }
      throw stateError(
        "CHANNEL_STORAGE_UNAVAILABLE",
        "The Worker channel state transaction failed.",
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw stateError("CHANNEL_REPOSITORY_CLOSED", "The Worker channel state is closed.");
    }
  }
}

function validateStatePath(filename: string, sourceCheckoutRoot: string): string {
  if (
    !isAbsolute(filename) ||
    !isAbsolute(sourceCheckoutRoot) ||
    filename !== filename.trim() ||
    sourceCheckoutRoot !== sourceCheckoutRoot.trim() ||
    filename.includes("\0") ||
    sourceCheckoutRoot.includes("\0")
  ) {
    throw stateError(
      "CHANNEL_CONFIGURATION_INVALID",
      "Worker channel state paths must be absolute.",
    );
  }
  const resolved = resolve(filename);
  const relationship = relative(resolve(sourceCheckoutRoot), resolved);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    throw stateError(
      "CHANNEL_CONFIGURATION_INVALID",
      "Worker channel state must remain outside the source checkout.",
    );
  }
  return resolved;
}

function validateDeviceId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw stateError("CHANNEL_CONFIGURATION_INVALID", "The channel Device ID is invalid.");
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
    throw stateError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function invalidEffectClaim(): DeviceChannelRepositoryError {
  return stateError(
    "CHANNEL_EFFECT_CLAIM_INVALID",
    "The inbound Main channel effect claim is no longer current.",
  );
}

function readPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw stateError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function readNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw stateError("CHANNEL_CONFIGURATION_INVALID", `${label} is invalid.`);
  }
  return value;
}

function stateError(
  code: DeviceChannelRepositoryErrorCode,
  message: string,
): DeviceChannelRepositoryError {
  return new DeviceChannelRepositoryError(code, message);
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

const WORKER_CHANNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS od_worker_channel_schema (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;
INSERT INTO od_worker_channel_schema (singleton_id, schema_version)
VALUES (1, 1)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS od_worker_channel_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  device_id TEXT NOT NULL,
  main_device_id TEXT NOT NULL,
  certificate_generation INTEGER NOT NULL CHECK (certificate_generation > 0),
  last_main_sequence INTEGER NOT NULL CHECK (last_main_sequence >= 0),
  last_main_acknowledgment_sequence INTEGER NOT NULL
    CHECK (last_main_acknowledgment_sequence >= 0),
  acknowledged_worker_sequence INTEGER NOT NULL CHECK (acknowledged_worker_sequence >= 0),
  next_worker_sequence INTEGER NOT NULL CHECK (next_worker_sequence > 0),
  CHECK (last_main_acknowledgment_sequence <= last_main_sequence),
  CHECK (acknowledged_worker_sequence < next_worker_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS od_worker_channel_inbox (
  singleton_id INTEGER NOT NULL REFERENCES od_worker_channel_state(singleton_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  frame_json TEXT NOT NULL,
  PRIMARY KEY (singleton_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS od_worker_channel_inbound_effect (
  singleton_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('received', 'processing', 'handled')),
  claim_id TEXT,
  PRIMARY KEY (singleton_id, sequence),
  FOREIGN KEY (singleton_id, sequence)
    REFERENCES od_worker_channel_inbox(singleton_id, sequence) ON DELETE RESTRICT,
  CHECK (
    (status = 'processing' AND claim_id IS NOT NULL)
    OR (status <> 'processing' AND claim_id IS NULL)
  )
) STRICT;

INSERT INTO od_worker_channel_inbound_effect (singleton_id, sequence, status, claim_id)
SELECT singleton_id, sequence, 'handled', NULL
FROM od_worker_channel_inbox
WHERE 1
ON CONFLICT (singleton_id, sequence) DO NOTHING;

UPDATE od_worker_channel_inbound_effect
SET status = 'received', claim_id = NULL
WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS od_worker_channel_outbox (
  singleton_id INTEGER NOT NULL REFERENCES od_worker_channel_state(singleton_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  frame_json TEXT NOT NULL,
  PRIMARY KEY (singleton_id, sequence)
) STRICT;
`;
