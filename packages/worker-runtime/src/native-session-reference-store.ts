import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { NativeSessionReference } from "@opendelegate/agent-adapters";
import Database from "better-sqlite3";

import { AgentRunBridgeError } from "./agent-run-bridge-error.ts";
import {
  type WorkerEgressGuardSnapshot,
  validateWorkerEgressGuardSnapshot,
} from "./worker-egress-guard.ts";

export interface NativeSessionReferenceStore {
  load(sessionKey: string): Promise<NativeSessionReference | undefined>;
  loadEgressGuardSnapshot(sessionKey: string): Promise<WorkerEgressGuardSnapshot | undefined>;
  save(
    reference: NativeSessionReference,
    egressGuardSnapshot: WorkerEgressGuardSnapshot,
  ): Promise<void>;
  queueSteeringInstruction(
    input: NativeSessionSteeringInstruction,
  ): Promise<"already-queued" | "queued">;
  loadPendingSteeringInstructions(
    sessionKey: string,
  ): Promise<readonly NativeSessionSteeringInstruction[]>;
  markSteeringInstructionsDispatched(
    sessionKey: string,
    requestIds: readonly string[],
  ): Promise<void>;
  close(): void;
}

/**
 * Device-local durable input for the next related native-session resume.
 * `sessionKey` and local paths never cross the Device channel.
 */
export interface NativeSessionSteeringInstruction {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly sourceRunId: string;
  readonly sessionKey: string;
  readonly nativeSessionId: string;
  readonly taskId: string;
  readonly workstreamId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
  readonly provider: NativeSessionReference["provider"];
  readonly adapterId: string;
  readonly instruction: string;
  readonly requestedBy: "main-agent" | "owner";
  readonly queuedAt: string;
}

export interface SqliteNativeSessionReferenceStoreOptions {
  readonly filename: string;
  readonly sourceCheckoutDirectory: string;
}

interface SessionRow {
  readonly session_key: string;
  readonly task_id: string;
  readonly workstream_id: string;
  readonly device_id: string;
  readonly provider: string;
  readonly adapter_id: string;
  readonly workspace_id: string;
  readonly document: string;
  readonly checksum: string;
}

interface EgressGuardRow {
  readonly session_key: string;
  readonly document: string;
  readonly checksum: string;
}

interface SteeringInstructionRow {
  readonly request_id: string;
  readonly session_key: string;
  readonly document: string;
  readonly checksum: string;
  readonly status: "dispatched" | "pending";
}

const SESSION_REFERENCE_KEYS = new Set([
  "schemaVersion",
  "provider",
  "adapterId",
  "adapterVersion",
  "modelId",
  "effort",
  "nativeSessionId",
  "sessionKey",
  "taskId",
  "workstreamId",
  "deviceId",
  "workspaceId",
  "cwd",
  "worktreePath",
  "lineage",
  "createdAt",
]);
const LINEAGE_KEYS = new Set(["lineageId", "parentNativeSessionId", "continuationReason"]);
const MAX_IDENTIFIER_BYTES = 4_096;
const MAX_PATH_BYTES = 32_768;
const MAX_STEERING_INSTRUCTION_BYTES = 64 * 1024;
const MAX_PENDING_STEERING_INSTRUCTIONS = 64;
const MAX_STEERING_INSTRUCTION_AUDIT_ROWS = 4_096;

export class SqliteNativeSessionReferenceStore implements NativeSessionReferenceStore {
  readonly #database: Database.Database;
  #closed = false;

  public constructor(options: SqliteNativeSessionReferenceStoreOptions) {
    const filename = validateStatePath(options);
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS native_agent_sessions (
        session_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS native_agent_session_egress_guards (
        session_key TEXT PRIMARY KEY
          REFERENCES native_agent_sessions(session_key) ON DELETE CASCADE,
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS native_agent_session_steering (
        request_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL
          REFERENCES native_agent_sessions(session_key) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')),
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS native_agent_session_steering_pending
      ON native_agent_session_steering (session_key, status, request_id)
    `);
  }

  public async load(sessionKey: string): Promise<NativeSessionReference | undefined> {
    this.#assertOpen();
    assertIdentifier(sessionKey, "Session key");
    const row = this.#database
      .prepare(
        `SELECT session_key, task_id, workstream_id, device_id, provider, adapter_id,
                workspace_id, document, checksum
         FROM native_agent_sessions
         WHERE session_key = ?`,
      )
      .get(sessionKey) as SessionRow | undefined;
    return row === undefined ? undefined : structuredClone(decodeRow(row));
  }

  public async loadEgressGuardSnapshot(
    sessionKey: string,
  ): Promise<WorkerEgressGuardSnapshot | undefined> {
    this.#assertOpen();
    assertIdentifier(sessionKey, "Session key");
    const row = this.#database
      .prepare(
        `SELECT session_key, document, checksum
         FROM native_agent_session_egress_guards
         WHERE session_key = ?`,
      )
      .get(sessionKey) as EgressGuardRow | undefined;
    return row === undefined ? undefined : structuredClone(decodeEgressGuardRow(row, sessionKey));
  }

  public async save(
    input: NativeSessionReference,
    egressGuardInput: WorkerEgressGuardSnapshot,
  ): Promise<void> {
    this.#assertOpen();
    const reference = validateNativeSessionReference(input);
    const egressGuard = validateWorkerEgressGuardSnapshot(egressGuardInput);
    const transaction = this.#database.transaction(() => {
      const currentRow = this.#database
        .prepare(
          `SELECT session_key, task_id, workstream_id, device_id, provider, adapter_id,
                  workspace_id, document, checksum
           FROM native_agent_sessions
           WHERE session_key = ?`,
        )
        .get(reference.sessionKey) as SessionRow | undefined;
      if (currentRow !== undefined) {
        assertValidReplacement(decodeRow(currentRow), reference);
      }
      const currentEgressRow = this.#database
        .prepare(
          `SELECT session_key, document, checksum
           FROM native_agent_session_egress_guards
           WHERE session_key = ?`,
        )
        .get(reference.sessionKey) as EgressGuardRow | undefined;
      if (currentEgressRow !== undefined) {
        assertValidEgressReplacement(
          decodeEgressGuardRow(currentEgressRow, reference.sessionKey),
          egressGuard,
        );
      }
      const document = JSON.stringify(reference);
      this.#database
        .prepare(
          `INSERT INTO native_agent_sessions (
             session_key, task_id, workstream_id, device_id, provider, adapter_id,
             workspace_id, document, checksum
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             task_id = excluded.task_id,
             workstream_id = excluded.workstream_id,
             device_id = excluded.device_id,
             provider = excluded.provider,
             adapter_id = excluded.adapter_id,
             workspace_id = excluded.workspace_id,
             document = excluded.document,
             checksum = excluded.checksum`,
        )
        .run(
          reference.sessionKey,
          reference.taskId,
          reference.workstreamId,
          reference.deviceId,
          reference.provider,
          reference.adapterId,
          reference.workspaceId,
          document,
          checksum(document),
        );
      const egressDocument = JSON.stringify(egressGuard);
      this.#database
        .prepare(
          `INSERT INTO native_agent_session_egress_guards (
             session_key, document, checksum
           ) VALUES (?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             document = excluded.document,
             checksum = excluded.checksum`,
        )
        .run(reference.sessionKey, egressDocument, checksum(egressDocument));
    });
    transaction();
  }

  public async queueSteeringInstruction(
    input: NativeSessionSteeringInstruction,
  ): Promise<"already-queued" | "queued"> {
    this.#assertOpen();
    const instruction = validateSteeringInstruction(input);
    const transaction = this.#database.transaction(() => {
      const sessionRow = this.#database
        .prepare(
          `SELECT session_key, task_id, workstream_id, device_id, provider, adapter_id,
                  workspace_id, document, checksum
           FROM native_agent_sessions
           WHERE session_key = ?`,
        )
        .get(instruction.sessionKey) as SessionRow | undefined;
      if (sessionRow === undefined) {
        throw new AgentRunBridgeError(
          "SESSION_BINDING_MISMATCH",
          "A steering fallback requires an already-bound native session.",
        );
      }
      assertSteeringSessionBinding(decodeRow(sessionRow), instruction);
      const document = JSON.stringify(instruction);
      const existing = this.#database
        .prepare(
          `SELECT request_id, session_key, document, checksum, status
           FROM native_agent_session_steering
           WHERE request_id = ?`,
        )
        .get(instruction.requestId) as SteeringInstructionRow | undefined;
      if (existing !== undefined) {
        if (
          existing.session_key !== instruction.sessionKey ||
          existing.checksum !== checksum(document) ||
          existing.document !== document
        ) {
          throw new AgentRunBridgeError(
            "SESSION_STORE_CONFLICT",
            "A steering request ID was reused with different content or scope.",
          );
        }
        return "already-queued" as const;
      }
      const total = this.#database
        .prepare("SELECT COUNT(*) AS count FROM native_agent_session_steering")
        .get() as { readonly count: number };
      if (total.count >= MAX_STEERING_INSTRUCTION_AUDIT_ROWS) {
        throw new AgentRunBridgeError(
          "SESSION_STORE_CONFLICT",
          "The bounded next-resume steering audit is full.",
        );
      }
      const pending = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM native_agent_session_steering
           WHERE session_key = ? AND status = 'pending'`,
        )
        .get(instruction.sessionKey) as { readonly count: number };
      if (pending.count >= MAX_PENDING_STEERING_INSTRUCTIONS) {
        throw new AgentRunBridgeError(
          "SESSION_STORE_CONFLICT",
          "The bounded next-resume steering queue is full.",
        );
      }
      this.#database
        .prepare(
          `INSERT INTO native_agent_session_steering (
             request_id, session_key, status, document, checksum
           ) VALUES (?, ?, 'pending', ?, ?)`,
        )
        .run(instruction.requestId, instruction.sessionKey, document, checksum(document));
      return "queued" as const;
    });
    return transaction();
  }

  public async loadPendingSteeringInstructions(
    sessionKey: string,
  ): Promise<readonly NativeSessionSteeringInstruction[]> {
    this.#assertOpen();
    assertIdentifier(sessionKey, "Session key");
    const rows = this.#database
      .prepare(
        `SELECT request_id, session_key, document, checksum, status
         FROM native_agent_session_steering
         WHERE session_key = ? AND status = 'pending'
         ORDER BY rowid`,
      )
      .all(sessionKey) as SteeringInstructionRow[];
    if (rows.length > MAX_PENDING_STEERING_INSTRUCTIONS) {
      throw corruptStore();
    }
    return Object.freeze(
      rows.map((row) => structuredClone(decodeSteeringInstructionRow(row, sessionKey))),
    );
  }

  public async markSteeringInstructionsDispatched(
    sessionKey: string,
    requestIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    assertIdentifier(sessionKey, "Session key");
    if (
      !Array.isArray(requestIds) ||
      requestIds.length === 0 ||
      requestIds.length > MAX_PENDING_STEERING_INSTRUCTIONS ||
      new Set(requestIds).size !== requestIds.length
    ) {
      throw new AgentRunBridgeError(
        "SESSION_STORE_CONFLICT",
        "The dispatched steering request set is invalid.",
      );
    }
    requestIds.forEach((requestId) => assertIdentifier(requestId, "Steering request ID"));
    const transaction = this.#database.transaction(() => {
      for (const requestId of requestIds) {
        const row = this.#database
          .prepare(
            `SELECT request_id, session_key, document, checksum, status
             FROM native_agent_session_steering
             WHERE request_id = ?`,
          )
          .get(requestId) as SteeringInstructionRow | undefined;
        if (
          row === undefined ||
          row.session_key !== sessionKey ||
          decodeSteeringInstructionRow(row, sessionKey).requestId !== requestId
        ) {
          throw new AgentRunBridgeError(
            "SESSION_STORE_CONFLICT",
            "A dispatched steering request escaped its native-session scope.",
          );
        }
        if (row.status === "pending") {
          this.#database
            .prepare(
              `UPDATE native_agent_session_steering
               SET status = 'dispatched'
               WHERE request_id = ? AND session_key = ? AND status = 'pending'`,
            )
            .run(requestId, sessionKey);
        }
      }
    });
    transaction();
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AgentRunBridgeError(
        "SESSION_STORE_CLOSED",
        "Native session reference store is closed.",
      );
    }
  }
}

function validateStatePath(options: SqliteNativeSessionReferenceStoreOptions): string {
  if (
    typeof options.filename !== "string" ||
    options.filename.length === 0 ||
    !isAbsolute(options.filename) ||
    typeof options.sourceCheckoutDirectory !== "string" ||
    options.sourceCheckoutDirectory.length === 0 ||
    !isAbsolute(options.sourceCheckoutDirectory)
  ) {
    throw invalidStatePath();
  }

  const filename = resolve(options.filename);
  const checkoutInput = resolve(options.sourceCheckoutDirectory);
  let checkout: string;
  try {
    checkout = realpathSync(checkoutInput);
    if (!statSync(checkout).isDirectory()) {
      throw invalidStatePath();
    }
  } catch (error) {
    if (error instanceof AgentRunBridgeError) {
      throw error;
    }
    throw invalidStatePath();
  }
  if (isWithin(checkout, filename)) {
    throw invalidStatePath();
  }

  try {
    mkdirSync(dirname(filename), { recursive: true });
    const parent = realpathSync(dirname(filename));
    const resolvedThroughParent = resolve(parent, basename(filename));
    if (isWithin(checkout, resolvedThroughParent)) {
      throw invalidStatePath();
    }
    if (existsSync(filename)) {
      const fileStatus = lstatSync(filename);
      if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
        throw invalidStatePath();
      }
      if (isWithin(checkout, realpathSync(filename))) {
        throw invalidStatePath();
      }
    }
  } catch (error) {
    if (error instanceof AgentRunBridgeError) {
      throw error;
    }
    throw invalidStatePath();
  }
  return filename;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function invalidStatePath(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "SESSION_STORE_PATH_INVALID",
    "Native session state must be a regular absolute file outside the source checkout.",
  );
}

function decodeRow(row: SessionRow): NativeSessionReference {
  if (checksum(row.document) !== row.checksum) {
    throw corruptStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document);
  } catch {
    throw corruptStore();
  }
  let reference: NativeSessionReference;
  try {
    reference = validateNativeSessionReference(parsed);
  } catch {
    throw corruptStore();
  }
  if (
    row.session_key !== reference.sessionKey ||
    row.task_id !== reference.taskId ||
    row.workstream_id !== reference.workstreamId ||
    row.device_id !== reference.deviceId ||
    row.provider !== reference.provider ||
    row.adapter_id !== reference.adapterId ||
    row.workspace_id !== reference.workspaceId
  ) {
    throw corruptStore();
  }
  return reference;
}

function decodeEgressGuardRow(
  row: EgressGuardRow,
  expectedSessionKey: string,
): WorkerEgressGuardSnapshot {
  if (row.session_key !== expectedSessionKey || checksum(row.document) !== row.checksum) {
    throw corruptStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document);
  } catch {
    throw corruptStore();
  }
  try {
    return validateWorkerEgressGuardSnapshot(parsed as WorkerEgressGuardSnapshot);
  } catch {
    throw corruptStore();
  }
}

function decodeSteeringInstructionRow(
  row: SteeringInstructionRow,
  expectedSessionKey: string,
): NativeSessionSteeringInstruction {
  if (
    row.session_key !== expectedSessionKey ||
    (row.status !== "pending" && row.status !== "dispatched") ||
    checksum(row.document) !== row.checksum
  ) {
    throw corruptStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document);
  } catch {
    throw corruptStore();
  }
  let instruction: NativeSessionSteeringInstruction;
  try {
    instruction = validateSteeringInstruction(parsed);
  } catch {
    throw corruptStore();
  }
  if (row.request_id !== instruction.requestId || row.session_key !== instruction.sessionKey) {
    throw corruptStore();
  }
  return instruction;
}

function validateSteeringInstruction(input: unknown): NativeSessionSteeringInstruction {
  if (!isRecord(input)) {
    throw invalidReference();
  }
  const keys = new Set([
    "schemaVersion",
    "requestId",
    "sourceRunId",
    "sessionKey",
    "nativeSessionId",
    "taskId",
    "workstreamId",
    "deviceId",
    "workspaceId",
    "provider",
    "adapterId",
    "instruction",
    "requestedBy",
    "queuedAt",
  ]);
  if (hasUnexpectedKey(input, keys) || Object.keys(input).length !== keys.size) {
    throw invalidReference();
  }
  if (
    input["schemaVersion"] !== 1 ||
    (input["provider"] !== "codex" &&
      input["provider"] !== "claude" &&
      input["provider"] !== "generic") ||
    (input["requestedBy"] !== "main-agent" && input["requestedBy"] !== "owner")
  ) {
    throw invalidReference();
  }
  const instruction = input["instruction"];
  const queuedAt = input["queuedAt"];
  if (
    typeof instruction !== "string" ||
    instruction.trim().length === 0 ||
    instruction.includes("\0") ||
    Buffer.byteLength(instruction, "utf8") > MAX_STEERING_INSTRUCTION_BYTES ||
    typeof queuedAt !== "string" ||
    !Number.isFinite(Date.parse(queuedAt)) ||
    new Date(queuedAt).toISOString() !== queuedAt
  ) {
    throw invalidReference();
  }
  return Object.freeze({
    schemaVersion: 1,
    requestId: readIdentifier(input, "requestId"),
    sourceRunId: readIdentifier(input, "sourceRunId"),
    sessionKey: readIdentifier(input, "sessionKey"),
    nativeSessionId: readIdentifier(input, "nativeSessionId"),
    taskId: readIdentifier(input, "taskId"),
    workstreamId: readIdentifier(input, "workstreamId"),
    deviceId: readIdentifier(input, "deviceId"),
    workspaceId: readIdentifier(input, "workspaceId"),
    provider: input["provider"],
    adapterId: readIdentifier(input, "adapterId"),
    instruction,
    requestedBy: input["requestedBy"],
    queuedAt,
  });
}

function assertSteeringSessionBinding(
  session: NativeSessionReference,
  instruction: NativeSessionSteeringInstruction,
): void {
  if (
    instruction.sessionKey !== session.sessionKey ||
    instruction.nativeSessionId !== session.nativeSessionId ||
    instruction.taskId !== session.taskId ||
    instruction.workstreamId !== session.workstreamId ||
    instruction.deviceId !== session.deviceId ||
    instruction.workspaceId !== session.workspaceId ||
    instruction.provider !== session.provider ||
    instruction.adapterId !== session.adapterId
  ) {
    throw new AgentRunBridgeError(
      "SESSION_BINDING_MISMATCH",
      "The steering fallback does not match this exact native-session binding.",
    );
  }
}

function validateNativeSessionReference(input: unknown): NativeSessionReference {
  if (!isRecord(input) || hasUnexpectedKey(input, SESSION_REFERENCE_KEYS)) {
    throw invalidReference();
  }
  if (
    input["schemaVersion"] !== 1 ||
    (input["provider"] !== "codex" &&
      input["provider"] !== "claude" &&
      input["provider"] !== "generic")
  ) {
    throw invalidReference();
  }
  const provider = input["provider"];
  const adapterId = readIdentifier(input, "adapterId");
  const adapterVersion = readIdentifier(input, "adapterVersion");
  const modelId = readOptionalIdentifier(input, "modelId");
  const effort = readOptionalIdentifier(input, "effort");
  const nativeSessionId = readIdentifier(input, "nativeSessionId");
  const sessionKey = readIdentifier(input, "sessionKey");
  const taskId = readIdentifier(input, "taskId");
  const workstreamId = readIdentifier(input, "workstreamId");
  const deviceId = readIdentifier(input, "deviceId");
  const workspaceId = readIdentifier(input, "workspaceId");
  const cwd = readAbsolutePath(input, "cwd");
  const worktreeValue = input["worktreePath"];
  const worktreePath =
    worktreeValue === undefined ? undefined : readAbsolutePath(input, "worktreePath");
  if (worktreePath !== undefined && !isWithin(worktreePath, cwd)) {
    throw invalidReference();
  }
  const lineageInput = input["lineage"];
  if (!isRecord(lineageInput) || hasUnexpectedKey(lineageInput, LINEAGE_KEYS)) {
    throw invalidReference();
  }
  const lineageId = readIdentifier(lineageInput, "lineageId");
  const parentNativeSessionId = readOptionalIdentifier(lineageInput, "parentNativeSessionId");
  const continuationReason = readOptionalIdentifier(lineageInput, "continuationReason");
  if ((parentNativeSessionId === undefined) !== (continuationReason === undefined)) {
    throw invalidReference();
  }
  const createdAt = input["createdAt"];
  if (
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw invalidReference();
  }
  return Object.freeze({
    schemaVersion: 1,
    provider,
    adapterId,
    adapterVersion,
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    nativeSessionId,
    sessionKey,
    taskId,
    workstreamId,
    deviceId,
    workspaceId,
    cwd,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    lineage: Object.freeze({
      lineageId,
      ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
      ...(continuationReason === undefined ? {} : { continuationReason }),
    }),
    createdAt,
  });
}

function assertValidReplacement(
  current: NativeSessionReference,
  replacement: NativeSessionReference,
): void {
  if (
    current.sessionKey !== replacement.sessionKey ||
    current.taskId !== replacement.taskId ||
    current.workstreamId !== replacement.workstreamId ||
    current.deviceId !== replacement.deviceId ||
    current.provider !== replacement.provider ||
    current.adapterId !== replacement.adapterId ||
    current.modelId !== replacement.modelId ||
    current.effort !== replacement.effort ||
    current.workspaceId !== replacement.workspaceId ||
    current.cwd !== replacement.cwd ||
    current.worktreePath !== replacement.worktreePath
  ) {
    throw new AgentRunBridgeError(
      "SESSION_STORE_CONFLICT",
      "Native session replacement changed an immutable Task workstream binding.",
    );
  }
  if (current.nativeSessionId === replacement.nativeSessionId) {
    if (
      current.adapterVersion !== replacement.adapterVersion ||
      current.createdAt !== replacement.createdAt ||
      current.lineage.lineageId !== replacement.lineage.lineageId ||
      current.lineage.parentNativeSessionId !== replacement.lineage.parentNativeSessionId ||
      current.lineage.continuationReason !== replacement.lineage.continuationReason
    ) {
      throw new AgentRunBridgeError(
        "SESSION_STORE_CONFLICT",
        "Native session metadata changed without an explicit continuation.",
      );
    }
    return;
  }
  if (
    replacement.lineage.lineageId === current.lineage.lineageId ||
    replacement.lineage.parentNativeSessionId !== current.nativeSessionId ||
    replacement.lineage.continuationReason === undefined ||
    Date.parse(replacement.createdAt) < Date.parse(current.createdAt)
  ) {
    throw new AgentRunBridgeError(
      "SESSION_STORE_CONFLICT",
      "Native session replacement requires an explicit checkpoint-continuation lineage.",
    );
  }
}

function assertValidEgressReplacement(
  current: WorkerEgressGuardSnapshot,
  replacement: WorkerEgressGuardSnapshot,
): void {
  if (current.mode === "opaque" && replacement.mode !== "opaque") {
    throw new AgentRunBridgeError(
      "SESSION_STORE_CONFLICT",
      "Native session egress protection cannot replace unknown history with a scoped guard.",
    );
  }
  if (replacement.mode === "opaque") {
    return;
  }
  const exact = new Set(
    replacement.exactFingerprints.map(
      (entry) => `${entry.category}:${entry.length}:${entry.rolling}:${entry.sha256}`,
    ),
  );
  const fragments = new Set(
    replacement.fragmentFingerprints.map(
      (entry) => `${entry.category}:${entry.rolling}:${entry.sha256}`,
    ),
  );
  if (
    current.exactFingerprints.some(
      (entry) => !exact.has(`${entry.category}:${entry.length}:${entry.rolling}:${entry.sha256}`),
    ) ||
    current.fragmentFingerprints.some(
      (entry) => !fragments.has(`${entry.category}:${entry.rolling}:${entry.sha256}`),
    )
  ) {
    throw new AgentRunBridgeError(
      "SESSION_STORE_CONFLICT",
      "Native session egress protection cannot discard previously protected values.",
    );
  }
}

function readIdentifier(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assertIdentifier(value, key);
  return value;
}

function readOptionalIdentifier(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  assertIdentifier(value, key);
  return value;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    value !== value.trim() ||
    value.includes("\0") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new AgentRunBridgeError(
      "INVALID_SESSION_REFERENCE",
      `${label} is not a valid native session identifier.`,
    );
  }
}

function readAbsolutePath(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw invalidReference();
  }
  return value;
}

function hasUnexpectedKey(record: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  return Object.keys(record).some((key) => !expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidReference(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "INVALID_SESSION_REFERENCE",
    "Native session reference is structurally invalid.",
  );
}

function corruptStore(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "SESSION_STORE_CORRUPT",
    "Native session reference state is corrupt or incompatible.",
  );
}

function checksum(document: string): string {
  return createHash("sha256").update(document).digest("hex");
}
