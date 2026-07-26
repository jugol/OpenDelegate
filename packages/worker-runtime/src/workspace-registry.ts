import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { WorkspaceBinding, WorkspaceIsolation } from "@opendelegate/agent-adapters";
import Database from "better-sqlite3";

import type { WorkerWorkspaceResolver } from "./agent-run-process-factory.ts";
import type { WorkerRunAssignmentV1 } from "./contracts.ts";
import type { ManagedGitWorktreeManager } from "./managed-git-worktree.ts";

export type WorkspaceType = "directory" | "git" | "mounted-storage";
export type WorkspaceState = "active" | "disabled";

export interface WorkspaceRecord {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly alias: string;
  readonly type: WorkspaceType;
  readonly rootPath: string;
  readonly isolation: WorkspaceIsolation;
  readonly capabilities: readonly string[];
  readonly state: WorkspaceState;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface WorkspaceSchedulingMetadata {
  readonly workspaceId: string;
  readonly alias: string;
  readonly type: WorkspaceType;
  readonly isolation: WorkspaceIsolation;
  readonly capabilities: readonly string[];
  readonly state: WorkspaceState;
  readonly revision: number;
}

export interface RegisterWorkspaceInput {
  readonly workspaceId: string;
  readonly alias: string;
  readonly type: WorkspaceType;
  readonly rootPath: string;
  readonly isolation: WorkspaceIsolation;
  readonly capabilities: readonly string[];
}

export interface UpdateWorkspaceMetadataInput {
  readonly workspaceId: string;
  readonly expectedRevision: number;
  readonly alias: string;
  readonly isolation: WorkspaceIsolation;
  readonly capabilities: readonly string[];
  readonly state?: WorkspaceState;
}

export interface WorkspaceRegistryClock {
  now(): number;
}

export interface SqliteWorkspaceRegistryOptions {
  readonly filename: string;
  readonly sourceCheckoutDirectory: string;
  readonly clock?: WorkspaceRegistryClock;
}

export type WorkspaceRegistryErrorCode =
  | "WORKSPACE_CONFLICT"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_CHANGED"
  | "WORKSPACE_PATH_UNSAFE"
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_REVISION_CONFLICT"
  | "WORKSPACE_STATE_CORRUPT"
  | "WORKSPACE_STATE_PATH_UNSAFE"
  | "WORKSPACE_STORE_CLOSED";

export class WorkspaceRegistryError extends Error {
  public readonly code: WorkspaceRegistryErrorCode;

  public constructor(code: WorkspaceRegistryErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
    this.code = code;
  }
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly alias: string;
  readonly root_path: string;
  readonly root_device: string;
  readonly root_inode: string;
  readonly root_birthtime_ms: number;
  readonly revision: number;
  readonly document: string;
  readonly checksum: string;
}

interface WorkspacePathIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeMs: number;
}

const WORKSPACE_TYPES = new Set<WorkspaceType>(["directory", "git", "mounted-storage"]);
const WORKSPACE_STATES = new Set<WorkspaceState>(["active", "disabled"]);
const WORKSPACE_ISOLATIONS = new Set<WorkspaceIsolation>([
  "none",
  "agent-native-worktree",
  "opendelegate-worktree",
  "container",
  "custom",
]);
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ALIAS_BYTES = 512;
const MAX_CAPABILITIES = 128;

export class SqliteWorkspaceRegistry {
  readonly #database: Database.Database;
  readonly #clock: WorkspaceRegistryClock;
  #closed = false;

  public constructor(options: SqliteWorkspaceRegistryOptions) {
    const filename = validateStatePath(options);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS registered_workspaces (
        workspace_id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL UNIQUE,
        root_device TEXT NOT NULL,
        root_inode TEXT NOT NULL,
        root_birthtime_ms INTEGER NOT NULL CHECK (root_birthtime_ms >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
    if (process.platform !== "win32") {
      chmodSync(filename, 0o600);
    }
  }

  public async register(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> {
    this.#assertOpen();
    const validated = validateRegistration(input);
    const identity = inspectWorkspacePath(validated.rootPath);
    const now = readClock(this.#clock);
    const record: WorkspaceRecord = freezeRecord({
      schemaVersion: 1,
      ...validated,
      rootPath: identity.canonicalPath,
      state: "active",
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const transaction = this.#database.transaction(() => {
      const existing = this.#selectRow(record.workspaceId);
      if (existing !== undefined) {
        const current = decodeRow(existing);
        if (sameRegistration(current, record) && samePathIdentity(existing, identity)) {
          return current;
        }
        throw conflict();
      }
      const document = JSON.stringify(record);
      try {
        this.#database
          .prepare(
            `INSERT INTO registered_workspaces (
               workspace_id, alias, root_path, root_device, root_inode,
               root_birthtime_ms, revision, document, checksum
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.workspaceId,
            record.alias,
            record.rootPath,
            identity.device,
            identity.inode,
            identity.birthtimeMs,
            record.revision,
            document,
            checksum(document),
          );
      } catch {
        throw conflict();
      }
      return record;
    });
    return structuredClone(transaction());
  }

  public async updateMetadata(input: UpdateWorkspaceMetadataInput): Promise<WorkspaceRecord> {
    this.#assertOpen();
    assertIdentifier(input.workspaceId, "Workspace ID");
    assertRevision(input.expectedRevision);
    const alias = validateAlias(input.alias);
    const isolation = validateIsolation(input.isolation);
    const capabilities = validateCapabilities(input.capabilities);
    const state = validateState(input.state ?? "active");
    const transaction = this.#database.transaction(() => {
      const row = this.#selectRow(input.workspaceId);
      if (row === undefined) {
        throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "The Workspace is not registered.");
      }
      const current = decodeRow(row);
      if (current.revision !== input.expectedRevision) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_REVISION_CONFLICT",
          "The Workspace metadata changed concurrently.",
        );
      }
      assertCurrentPath(row);
      const updated = freezeRecord({
        ...current,
        alias,
        isolation,
        capabilities,
        state,
        revision: current.revision + 1,
        updatedAtMs: readClock(this.#clock),
      });
      const document = JSON.stringify(updated);
      try {
        const result = this.#database
          .prepare(
            `UPDATE registered_workspaces
             SET alias = ?, revision = ?, document = ?, checksum = ?
             WHERE workspace_id = ? AND revision = ?`,
          )
          .run(
            updated.alias,
            updated.revision,
            document,
            checksum(document),
            updated.workspaceId,
            input.expectedRevision,
          );
        if (result.changes !== 1) {
          throw new WorkspaceRegistryError(
            "WORKSPACE_REVISION_CONFLICT",
            "The Workspace metadata changed concurrently.",
          );
        }
      } catch (error) {
        if (error instanceof WorkspaceRegistryError) {
          throw error;
        }
        throw conflict();
      }
      return updated;
    });
    return structuredClone(transaction());
  }

  public async resolve(workspaceId: string): Promise<WorkspaceRecord> {
    this.#assertOpen();
    assertIdentifier(workspaceId, "Workspace ID");
    const row = this.#selectRow(workspaceId);
    if (row === undefined) {
      throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "The Workspace is not registered.");
    }
    const record = decodeRow(row);
    assertCurrentPath(row);
    if (record.state !== "active") {
      throw new WorkspaceRegistryError("WORKSPACE_NOT_FOUND", "The Workspace is disabled.");
    }
    return structuredClone(record);
  }

  public async listSchedulingMetadata(): Promise<readonly WorkspaceSchedulingMetadata[]> {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT workspace_id, alias, root_path, root_device, root_inode,
                root_birthtime_ms, revision, document, checksum
         FROM registered_workspaces
         ORDER BY workspace_id`,
      )
      .all() as WorkspaceRow[];
    return Object.freeze(
      rows.map((row) => {
        const record = decodeRow(row);
        return Object.freeze({
          workspaceId: record.workspaceId,
          alias: record.alias,
          type: record.type,
          isolation: record.isolation,
          capabilities: Object.freeze([...record.capabilities]),
          state: record.state,
          revision: record.revision,
        });
      }),
    );
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  #selectRow(workspaceId: string): WorkspaceRow | undefined {
    return this.#database
      .prepare(
        `SELECT workspace_id, alias, root_path, root_device, root_inode,
                root_birthtime_ms, revision, document, checksum
         FROM registered_workspaces
         WHERE workspace_id = ?`,
      )
      .get(workspaceId) as WorkspaceRow | undefined;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_STORE_CLOSED",
        "The Workspace registry is closed.",
      );
    }
  }
}

export interface RegisteredWorkerWorkspaceResolverOptions {
  readonly registry: Pick<SqliteWorkspaceRegistry, "resolve">;
  readonly defaultWorkspaceId?: string;
  readonly managedWorktreeManager?: Pick<ManagedGitWorktreeManager, "create">;
}

export class RegisteredWorkerWorkspaceResolver implements WorkerWorkspaceResolver {
  readonly #registry: RegisteredWorkerWorkspaceResolverOptions["registry"];
  readonly #defaultWorkspaceId: string | undefined;
  readonly #managedWorktreeManager:
    RegisteredWorkerWorkspaceResolverOptions["managedWorktreeManager"] | undefined;

  public constructor(options: RegisteredWorkerWorkspaceResolverOptions) {
    this.#registry = options.registry;
    if (options.defaultWorkspaceId !== undefined) {
      assertIdentifier(options.defaultWorkspaceId, "Default Workspace ID");
    }
    this.#defaultWorkspaceId = options.defaultWorkspaceId;
    this.#managedWorktreeManager = options.managedWorktreeManager;
  }

  public async resolve(input: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspaceId?: string;
    readonly workstreamId?: string;
  }): Promise<WorkspaceBinding> {
    const assignedWorkspaceId = input.assignment.workOrder.workspaceId;
    if (
      input.workspaceId !== undefined &&
      assignedWorkspaceId !== undefined &&
      input.workspaceId !== assignedWorkspaceId
    ) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_CONFLICT",
        "The assigned Workspace references do not match.",
      );
    }
    const workspaceId = input.workspaceId ?? assignedWorkspaceId ?? this.#defaultWorkspaceId;
    if (workspaceId === undefined) {
      throw new WorkspaceRegistryError(
        "WORKSPACE_REQUIRED",
        "The Work Order requires an explicit registered Workspace.",
      );
    }
    const record = await this.#registry.resolve(workspaceId);
    if (record.isolation === "opendelegate-worktree") {
      if (
        record.type !== "git" ||
        input.workstreamId === undefined ||
        this.#managedWorktreeManager === undefined
      ) {
        throw new WorkspaceRegistryError(
          "WORKSPACE_INVALID",
          "The managed Git Worktree lifecycle is not configured for this Workspace.",
        );
      }
      assertIdentifier(input.workstreamId, "Workstream ID");
      const managed = await this.#managedWorktreeManager.create({
        worktreeId: managedWorktreeId({
          taskId: input.assignment.taskId,
          workstreamId: input.workstreamId,
          workspaceId: record.workspaceId,
        }),
        workspaceId: record.workspaceId,
        repositoryRoot: record.rootPath,
      });
      return Object.freeze({
        workspaceId: record.workspaceId,
        cwd: managed.worktreePath,
        worktreePath: managed.worktreePath,
        isolation: record.isolation,
      });
    }
    return Object.freeze({
      workspaceId: record.workspaceId,
      cwd: record.rootPath,
      isolation: record.isolation,
    });
  }
}

function validateStatePath(options: SqliteWorkspaceRegistryOptions): string {
  if (
    typeof options.filename !== "string" ||
    !isAbsolute(options.filename) ||
    typeof options.sourceCheckoutDirectory !== "string" ||
    !isAbsolute(options.sourceCheckoutDirectory)
  ) {
    throw statePathUnsafe();
  }
  const filename = resolve(options.filename);
  const checkout = realpathSync.native(options.sourceCheckoutDirectory);
  if (isWithin(checkout, filename) || checkout === filename) {
    throw statePathUnsafe();
  }
  const parent = dirname(filename);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw statePathUnsafe();
  }
  const canonicalFilename = join(realpathSync.native(parent), basename(filename));
  if (isWithin(checkout, canonicalFilename) || checkout === canonicalFilename) {
    throw statePathUnsafe();
  }
  if (existsSync(canonicalFilename)) {
    const metadata = lstatSync(canonicalFilename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw statePathUnsafe();
    }
  }
  return canonicalFilename;
}

function validateRegistration(
  input: RegisterWorkspaceInput,
): Omit<RegisterWorkspaceInput, "capabilities"> & { readonly capabilities: readonly string[] } {
  assertIdentifier(input.workspaceId, "Workspace ID");
  const alias = validateAlias(input.alias);
  if (!WORKSPACE_TYPES.has(input.type)) {
    throw invalidWorkspace();
  }
  if (typeof input.rootPath !== "string" || !isAbsolute(input.rootPath)) {
    throw pathUnsafe();
  }
  const isolation = validateIsolation(input.isolation);
  if (isolation === "opendelegate-worktree" && input.type !== "git") {
    throw invalidWorkspace();
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    alias,
    type: input.type,
    rootPath: resolve(input.rootPath),
    isolation,
    capabilities: validateCapabilities(input.capabilities),
  });
}

function inspectWorkspacePath(path: string): WorkspacePathIdentity {
  let lexical: Stats;
  let canonicalPath: string;
  let canonical: Stats;
  try {
    lexical = lstatSync(path);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
      throw pathUnsafe();
    }
    canonicalPath = realpathSync.native(path);
    canonical = statSync(canonicalPath);
  } catch (error) {
    if (error instanceof WorkspaceRegistryError) {
      throw error;
    }
    throw pathUnsafe();
  }
  if (!canonical.isDirectory()) {
    throw pathUnsafe();
  }
  return Object.freeze({
    canonicalPath,
    device: canonical.dev.toString(10),
    inode: canonical.ino.toString(10),
    birthtimeMs: safeFilesystemTime(canonical.birthtimeMs),
  });
}

function assertCurrentPath(row: WorkspaceRow): void {
  let current: WorkspacePathIdentity;
  try {
    current = inspectWorkspacePath(row.root_path);
  } catch {
    throw pathChanged();
  }
  if (
    current.canonicalPath !== row.root_path ||
    current.device !== row.root_device ||
    current.inode !== row.root_inode ||
    (current.device === "0" &&
      current.inode === "0" &&
      current.birthtimeMs !== row.root_birthtime_ms)
  ) {
    throw pathChanged();
  }
}

function decodeRow(row: WorkspaceRow): WorkspaceRecord {
  if (checksum(row.document) !== row.checksum) {
    throw stateCorrupt();
  }
  let input: unknown;
  try {
    input = JSON.parse(row.document);
  } catch {
    throw stateCorrupt();
  }
  const record = parseRecord(input);
  if (
    record.workspaceId !== row.workspace_id ||
    record.alias !== row.alias ||
    record.rootPath !== row.root_path ||
    record.revision !== row.revision
  ) {
    throw stateCorrupt();
  }
  return record;
}

function parseRecord(input: unknown): WorkspaceRecord {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "workspaceId",
      "alias",
      "type",
      "rootPath",
      "isolation",
      "capabilities",
      "state",
      "revision",
      "createdAtMs",
      "updatedAtMs",
    ]) ||
    input["schemaVersion"] !== 1
  ) {
    throw stateCorrupt();
  }
  try {
    assertIdentifier(input["workspaceId"], "Workspace ID");
    const alias = validateAlias(input["alias"]);
    if (!WORKSPACE_TYPES.has(input["type"] as WorkspaceType)) {
      throw stateCorrupt();
    }
    if (typeof input["rootPath"] !== "string" || !isAbsolute(input["rootPath"])) {
      throw stateCorrupt();
    }
    const revision = input["revision"];
    assertRevision(revision);
    const createdAtMs = parseTimestamp(input["createdAtMs"]);
    const updatedAtMs = parseTimestamp(input["updatedAtMs"]);
    if (updatedAtMs < createdAtMs) {
      throw stateCorrupt();
    }
    return freezeRecord({
      schemaVersion: 1,
      workspaceId: input["workspaceId"],
      alias,
      type: input["type"] as WorkspaceType,
      rootPath: resolve(input["rootPath"]),
      isolation: validateIsolation(input["isolation"]),
      capabilities: validateCapabilities(input["capabilities"]),
      state: validateState(input["state"]),
      revision,
      createdAtMs,
      updatedAtMs,
    });
  } catch (error) {
    if (error instanceof WorkspaceRegistryError && error.code === "WORKSPACE_STATE_CORRUPT") {
      throw error;
    }
    throw stateCorrupt();
  }
}

function sameRegistration(left: WorkspaceRecord, right: WorkspaceRecord): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.alias === right.alias &&
    left.type === right.type &&
    left.rootPath === right.rootPath &&
    left.isolation === right.isolation &&
    JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities) &&
    left.state === "active"
  );
}

function managedWorktreeId(input: {
  readonly taskId: string;
  readonly workstreamId: string;
  readonly workspaceId: string;
}): string {
  const digest = createHash("sha256")
    .update(input.taskId, "utf8")
    .update("\0", "utf8")
    .update(input.workstreamId, "utf8")
    .update("\0", "utf8")
    .update(input.workspaceId, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `od-${digest}`;
}

function samePathIdentity(row: WorkspaceRow, identity: WorkspacePathIdentity): boolean {
  return (
    row.root_path === identity.canonicalPath &&
    row.root_device === identity.device &&
    row.root_inode === identity.inode &&
    (row.root_device !== "0" ||
      row.root_inode !== "0" ||
      row.root_birthtime_ms === identity.birthtimeMs)
  );
}

function validateCapabilities(input: unknown): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_CAPABILITIES ||
    input.some((value) => typeof value !== "string") ||
    new Set(input).size !== input.length
  ) {
    throw invalidWorkspace();
  }
  for (const capability of input) {
    assertIdentifier(capability, "Workspace capability");
  }
  return Object.freeze([...input].sort(compareCodeUnits));
}

function validateAlias(input: unknown): string {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    input.length === 0 ||
    Buffer.byteLength(input, "utf8") > MAX_ALIAS_BYTES ||
    hasControlCharacter(input)
  ) {
    throw invalidWorkspace();
  }
  return input;
}

function validateIsolation(input: unknown): WorkspaceIsolation {
  if (!WORKSPACE_ISOLATIONS.has(input as WorkspaceIsolation)) {
    throw invalidWorkspace();
  }
  return input as WorkspaceIsolation;
}

function validateState(input: unknown): WorkspaceState {
  if (!WORKSPACE_STATES.has(input as WorkspaceState)) {
    throw invalidWorkspace();
  }
  return input as WorkspaceState;
}

function assertIdentifier(input: unknown, _label: string): asserts input is string {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    input.length === 0 ||
    Buffer.byteLength(input, "utf8") > MAX_IDENTIFIER_BYTES ||
    hasControlCharacter(input) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input)
  ) {
    throw invalidWorkspace();
  }
}

function assertRevision(input: unknown): asserts input is number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw invalidWorkspace();
  }
}

function readClock(clock: WorkspaceRegistryClock): number {
  let now: number;
  try {
    now = clock.now();
  } catch {
    throw invalidWorkspace();
  }
  return parseTimestamp(now);
}

function parseTimestamp(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw stateCorrupt();
  }
  return input as number;
}

function safeFilesystemTime(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function freezeRecord(input: WorkspaceRecord): WorkspaceRecord {
  return Object.freeze({
    ...input,
    capabilities: Object.freeze([...input.capabilities]),
  });
}

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function conflict(): WorkspaceRegistryError {
  return new WorkspaceRegistryError(
    "WORKSPACE_CONFLICT",
    "The Workspace identity, alias, or local path conflicts with an existing registration.",
  );
}

function invalidWorkspace(): WorkspaceRegistryError {
  return new WorkspaceRegistryError("WORKSPACE_INVALID", "The Workspace metadata is invalid.");
}

function pathUnsafe(): WorkspaceRegistryError {
  return new WorkspaceRegistryError(
    "WORKSPACE_PATH_UNSAFE",
    "A Workspace root must be an existing real local directory.",
  );
}

function pathChanged(): WorkspaceRegistryError {
  return new WorkspaceRegistryError(
    "WORKSPACE_PATH_CHANGED",
    "The registered Workspace path identity changed or became unavailable.",
  );
}

function stateCorrupt(): WorkspaceRegistryError {
  return new WorkspaceRegistryError(
    "WORKSPACE_STATE_CORRUPT",
    "The local Workspace registry is corrupt.",
  );
}

function statePathUnsafe(): WorkspaceRegistryError {
  return new WorkspaceRegistryError(
    "WORKSPACE_STATE_PATH_UNSAFE",
    "Workspace registry state must be a regular file outside the source checkout.",
  );
}
