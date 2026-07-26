import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";

export type ManagedGitWorktreeState = "creating" | "active" | "preserved" | "removed";
export type WorktreeCleanupDisposition = "preserve" | "discard";

export interface ManagedGitWorktreeRecord {
  readonly schemaVersion: 1;
  readonly worktreeId: string;
  readonly workspaceId: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly state: ManagedGitWorktreeState;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ManagedGitWorktreeInspection {
  readonly worktreeId: string;
  readonly workspaceId: string;
  readonly worktreePath: string;
  readonly state: "active" | "preserved";
  readonly hasUncommittedChanges: boolean;
  readonly hasUntrackedFiles: boolean;
  readonly hasUnpushedCommits: boolean;
}

export interface CreateManagedGitWorktreeInput {
  readonly worktreeId: string;
  readonly workspaceId: string;
  readonly repositoryRoot: string;
}

export interface DisposeManagedGitWorktreeInput {
  readonly worktreeId: string;
  readonly approvedDisposition?: WorktreeCleanupDisposition;
}

export interface DisposeManagedGitWorktreeResult {
  readonly action: "preserved" | "removed";
  readonly inspection: ManagedGitWorktreeInspection;
}

export interface ManagedGitWorktreeClock {
  now(): number;
}

export interface GitCommandRequest {
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
}

export interface GitCommandResult {
  readonly stdout: string;
}

export interface GitCommandRunner {
  run(request: GitCommandRequest): Promise<GitCommandResult>;
}

export type GitChildEnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface ManagedGitWorktreeManagerOptions {
  readonly filename: string;
  readonly managedRootDirectory: string;
  readonly sourceCheckoutDirectory: string;
  readonly clock?: ManagedGitWorktreeClock;
  readonly commandRunner?: GitCommandRunner;
  readonly commandTimeoutMs?: number;
}

export type ManagedGitWorktreeErrorCode =
  | "WORKTREE_CLEANUP_UNSAFE"
  | "WORKTREE_COMMAND_FAILED"
  | "WORKTREE_CONFLICT"
  | "WORKTREE_INPUT_INVALID"
  | "WORKTREE_NOT_FOUND"
  | "WORKTREE_PATH_CHANGED"
  | "WORKTREE_REPOSITORY_INVALID"
  | "WORKTREE_ROOT_UNSAFE"
  | "WORKTREE_STATE_CORRUPT"
  | "WORKTREE_STORE_CLOSED";

export class ManagedGitWorktreeError extends Error {
  public readonly code: ManagedGitWorktreeErrorCode;

  public constructor(code: ManagedGitWorktreeErrorCode, message: string) {
    super(message);
    this.name = "ManagedGitWorktreeError";
    this.code = code;
  }
}

interface WorktreeRow {
  readonly worktree_id: string;
  readonly workspace_id: string;
  readonly repository_root: string;
  readonly worktree_path: string;
  readonly path_device: string | null;
  readonly path_inode: string | null;
  readonly path_birthtime_ms: number | null;
  readonly revision: number;
  readonly document: string;
  readonly checksum: string;
}

interface PathIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeMs: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const EXTERNAL_CHECKOUT_FILTER_PATTERN = "^filter\\..*\\.(clean|smudge|process)$";
const TRUSTED_GIT_CONFIGURATION_ARGUMENTS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "hook.post-checkout.enabled=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "submodule.recurse=false",
] as const);

export class ManagedGitWorktreeManager {
  readonly #database: Database.Database;
  readonly #managedRoot: string;
  readonly #clock: ManagedGitWorktreeClock;
  readonly #commandRunner: GitCommandRunner;
  readonly #commandTimeoutMs: number;
  #closed = false;
  #operationCount = 0;
  #operationTail: Promise<void> = Promise.resolve();

  public constructor(options: ManagedGitWorktreeManagerOptions) {
    const paths = validateManagerPaths(options);
    this.#managedRoot = paths.managedRoot;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#commandRunner = options.commandRunner ?? new SpawnGitCommandRunner();
    this.#commandTimeoutMs = validateCommandTimeout(options.commandTimeoutMs);
    this.#database = new Database(paths.filename);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS managed_git_worktrees (
        worktree_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        repository_root TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        path_device TEXT,
        path_inode TEXT,
        path_birthtime_ms INTEGER CHECK (
          path_birthtime_ms IS NULL OR path_birthtime_ms >= 0
        ),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        document TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
    if (process.platform !== "win32") {
      chmodSync(paths.filename, 0o600);
    }
  }

  public async create(input: CreateManagedGitWorktreeInput): Promise<ManagedGitWorktreeRecord> {
    return this.#serialize(async () => this.#create(input));
  }

  public async inspect(worktreeId: string): Promise<ManagedGitWorktreeInspection> {
    return this.#serialize(async () => this.#inspect(worktreeId));
  }

  public async dispose(
    input: DisposeManagedGitWorktreeInput,
  ): Promise<DisposeManagedGitWorktreeResult> {
    return this.#serialize(async () => this.#dispose(input));
  }

  public close(): void {
    if (this.#operationCount > 0) {
      throw new ManagedGitWorktreeError(
        "WORKTREE_CONFLICT",
        "The managed Worktree store cannot close during an active operation.",
      );
    }
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  async #create(input: CreateManagedGitWorktreeInput): Promise<ManagedGitWorktreeRecord> {
    this.#assertOpen();
    const worktreeId = validateIdentifier(input.worktreeId);
    const workspaceId = validateIdentifier(input.workspaceId);
    const repositoryRoot = inspectRealDirectory(
      input.repositoryRoot,
      "WORKTREE_REPOSITORY_INVALID",
    ).canonicalPath;
    assertSeparateTrees(repositoryRoot, this.#managedRoot);
    await this.#assertRepositoryRoot(repositoryRoot);
    const worktreePath = join(this.#managedRoot, worktreeId);
    const existing = this.#selectRow(worktreeId);
    if (existing !== undefined) {
      const record = decodeRow(existing);
      if (
        record.workspaceId !== workspaceId ||
        record.repositoryRoot !== repositoryRoot ||
        record.worktreePath !== worktreePath ||
        record.state === "removed"
      ) {
        throw conflict();
      }
      if (record.state === "creating") {
        return this.#recoverCreating(existing, record);
      }
      assertPathIdentity(existing);
      await this.#assertWorktreeBinding(record);
      return structuredClone(record);
    }

    if (existsSync(worktreePath)) {
      throw rootUnsafe();
    }
    const baseCommit = await this.#readCommit(repositoryRoot, "HEAD");
    const now = readClock(this.#clock);
    const creating = freezeRecord({
      schemaVersion: 1,
      worktreeId,
      workspaceId,
      repositoryRoot,
      worktreePath,
      baseCommit,
      state: "creating",
      revision: 1,
      createdAtMs: now,
      updatedAtMs: now,
    });
    this.#insert(creating);
    return this.#provision(creating);
  }

  async #recoverCreating(
    row: WorktreeRow,
    record: ManagedGitWorktreeRecord,
  ): Promise<ManagedGitWorktreeRecord> {
    if (!existsSync(record.worktreePath)) {
      await this.#runGit(["-C", record.repositoryRoot, "worktree", "prune", "--expire", "now"]);
      return this.#provision(record);
    }
    const identity = await this.#materializeCreating(record);
    return this.#activate(row, record, identity);
  }

  async #provision(record: ManagedGitWorktreeRecord): Promise<ManagedGitWorktreeRecord> {
    try {
      await this.#runGit([
        "-C",
        record.repositoryRoot,
        "worktree",
        "add",
        "--no-checkout",
        "--detach",
        "--",
        record.worktreePath,
        record.baseCommit,
      ]);
      const identity = await this.#materializeCreating(record);
      const row = this.#selectRequiredRow(record.worktreeId);
      return this.#activate(row, record, identity);
    } catch (error) {
      if (error instanceof ManagedGitWorktreeError) {
        throw error;
      }
      throw commandFailed();
    }
  }

  async #materializeCreating(record: ManagedGitWorktreeRecord): Promise<PathIdentity> {
    if (record.state !== "creating") {
      throw stateCorrupt();
    }
    const initialIdentity = inspectRealDirectory(record.worktreePath, "WORKTREE_PATH_CHANGED");
    await this.#assertWorktreeBinding(record);
    await this.#runGit([
      "-C",
      record.worktreePath,
      "reset",
      "--hard",
      "--no-recurse-submodules",
      record.baseCommit,
    ]);
    const materializedIdentity = inspectRealDirectory(record.worktreePath, "WORKTREE_PATH_CHANGED");
    assertSamePathIdentity(initialIdentity, materializedIdentity);
    await this.#assertWorktreeBinding(record);
    return materializedIdentity;
  }

  #activate(
    row: WorktreeRow,
    record: ManagedGitWorktreeRecord,
    identity: PathIdentity,
  ): ManagedGitWorktreeRecord {
    if (record.state !== "creating") {
      throw stateCorrupt();
    }
    const active = freezeRecord({
      ...record,
      state: "active",
      revision: record.revision + 1,
      updatedAtMs: readClock(this.#clock),
    });
    this.#update(row, active, identity);
    return structuredClone(active);
  }

  async #inspect(worktreeId: string): Promise<ManagedGitWorktreeInspection> {
    this.#assertOpen();
    const id = validateIdentifier(worktreeId);
    const row = this.#selectRow(id);
    if (row === undefined) {
      throw notFound();
    }
    const record = decodeRow(row);
    if (record.state !== "active" && record.state !== "preserved") {
      throw notFound();
    }
    assertPathIdentity(row);
    await this.#assertWorktreeBinding(record);
    const status = await this.#runGit([
      "-C",
      record.worktreePath,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const entries = status.stdout.split("\0").filter((entry) => entry.length > 0);
    const hasUntrackedFiles = entries.some((entry) => entry.startsWith("?? "));
    const hasUncommittedChanges = entries.some((entry) => !entry.startsWith("?? "));
    const commitCountOutput = await this.#runGit([
      "-C",
      record.worktreePath,
      "rev-list",
      "--count",
      `${record.baseCommit}..HEAD`,
      "--",
    ]);
    const commitCount = Number.parseInt(commitCountOutput.stdout.trim(), 10);
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
      throw commandFailed();
    }
    return Object.freeze({
      worktreeId: record.worktreeId,
      workspaceId: record.workspaceId,
      worktreePath: record.worktreePath,
      state: record.state,
      hasUncommittedChanges,
      hasUntrackedFiles,
      hasUnpushedCommits: commitCount > 0,
    });
  }

  async #dispose(input: DisposeManagedGitWorktreeInput): Promise<DisposeManagedGitWorktreeResult> {
    this.#assertOpen();
    const worktreeId = validateIdentifier(input.worktreeId);
    const disposition = validateDisposition(input.approvedDisposition);
    const inspection = await this.#inspect(worktreeId);
    const isDirty =
      inspection.hasUncommittedChanges ||
      inspection.hasUntrackedFiles ||
      inspection.hasUnpushedCommits;
    if (isDirty && disposition === undefined) {
      throw new ManagedGitWorktreeError(
        "WORKTREE_CLEANUP_UNSAFE",
        "The managed Worktree contains work and requires an approved disposition.",
      );
    }
    const row = this.#selectRequiredRow(worktreeId);
    const current = decodeRow(row);
    if (disposition === "preserve") {
      const preserved = freezeRecord({
        ...current,
        state: "preserved",
        revision: current.revision + 1,
        updatedAtMs: readClock(this.#clock),
      });
      this.#update(
        row,
        preserved,
        inspectRealDirectory(current.worktreePath, "WORKTREE_PATH_CHANGED"),
      );
      return Object.freeze({ action: "preserved", inspection });
    }
    await this.#runGit([
      "-C",
      current.repositoryRoot,
      "worktree",
      "remove",
      ...(isDirty && disposition === "discard" ? ["--force"] : []),
      "--",
      current.worktreePath,
    ]);
    if (existsSync(current.worktreePath)) {
      throw commandFailed();
    }
    await this.#runGit(["-C", current.repositoryRoot, "worktree", "prune", "--expire", "now"]);
    const removed = freezeRecord({
      ...current,
      state: "removed",
      revision: current.revision + 1,
      updatedAtMs: readClock(this.#clock),
    });
    this.#update(row, removed);
    return Object.freeze({ action: "removed", inspection });
  }

  async #assertRepositoryRoot(repositoryRoot: string): Promise<void> {
    try {
      const result = await this.#runGit(["-C", repositoryRoot, "rev-parse", "--show-toplevel"]);
      const canonical = realpathSync.native(result.stdout.trim());
      if (canonical !== repositoryRoot) {
        throw repositoryInvalid();
      }
      await this.#readGitCommonDirectory(repositoryRoot);
    } catch {
      throw repositoryInvalid();
    }
  }

  async #assertWorktreeBinding(record: ManagedGitWorktreeRecord): Promise<void> {
    try {
      const topLevel = await this.#runGit([
        "-C",
        record.worktreePath,
        "rev-parse",
        "--show-toplevel",
      ]);
      const canonical = realpathSync.native(topLevel.stdout.trim());
      const [repositoryCommonDirectory, worktreeCommonDirectory] = await Promise.all([
        this.#readGitCommonDirectory(record.repositoryRoot),
        this.#readGitCommonDirectory(record.worktreePath),
      ]);
      if (
        canonical !== record.worktreePath ||
        repositoryCommonDirectory !== worktreeCommonDirectory
      ) {
        throw pathChanged();
      }
    } catch {
      throw pathChanged();
    }
    const commit = await this.#readCommit(record.worktreePath, "HEAD");
    if (record.state === "creating" && commit !== record.baseCommit) {
      throw pathChanged();
    }
  }

  async #readGitCommonDirectory(repository: string): Promise<string> {
    const result = await this.#runGit([
      "-C",
      repository,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const value = result.stdout.trim();
    const candidate = isAbsolute(value) ? resolve(value) : resolve(repository, value);
    const lexical = lstatSync(candidate);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
      throw pathChanged();
    }
    return realpathSync.native(candidate);
  }

  async #readCommit(repository: string, reference: "HEAD"): Promise<string> {
    const result = await this.#runGit([
      "-C",
      repository,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${reference}^{commit}`,
    ]);
    const commit = result.stdout.trim().toLowerCase();
    if (!COMMIT_PATTERN.test(commit)) {
      throw repositoryInvalid();
    }
    return commit;
  }

  async #runGit(arguments_: readonly string[]): Promise<GitCommandResult> {
    try {
      return await this.#commandRunner.run({
        arguments: Object.freeze([...arguments_]),
        timeoutMs: this.#commandTimeoutMs,
      });
    } catch {
      throw commandFailed();
    }
  }

  #insert(record: ManagedGitWorktreeRecord): void {
    const document = JSON.stringify(record);
    try {
      this.#database
        .prepare(
          `INSERT INTO managed_git_worktrees (
             worktree_id, workspace_id, repository_root, worktree_path,
             path_device, path_inode, path_birthtime_ms, revision, document, checksum
           ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          record.worktreeId,
          record.workspaceId,
          record.repositoryRoot,
          record.worktreePath,
          record.revision,
          document,
          checksum(document),
        );
    } catch {
      throw conflict();
    }
  }

  #update(row: WorktreeRow, record: ManagedGitWorktreeRecord, identity?: PathIdentity): void {
    const document = JSON.stringify(record);
    const result = this.#database
      .prepare(
        `UPDATE managed_git_worktrees
         SET path_device = ?, path_inode = ?, path_birthtime_ms = ?,
             revision = ?, document = ?, checksum = ?
         WHERE worktree_id = ? AND revision = ?`,
      )
      .run(
        identity?.device ?? row.path_device,
        identity?.inode ?? row.path_inode,
        identity?.birthtimeMs ?? row.path_birthtime_ms,
        record.revision,
        document,
        checksum(document),
        record.worktreeId,
        row.revision,
      );
    if (result.changes !== 1) {
      throw conflict();
    }
  }

  #selectRow(worktreeId: string): WorktreeRow | undefined {
    return this.#database
      .prepare(
        `SELECT worktree_id, workspace_id, repository_root, worktree_path,
                path_device, path_inode, path_birthtime_ms, revision,
                document, checksum
         FROM managed_git_worktrees
         WHERE worktree_id = ?`,
      )
      .get(worktreeId) as WorktreeRow | undefined;
  }

  #selectRequiredRow(worktreeId: string): WorktreeRow {
    const row = this.#selectRow(worktreeId);
    if (row === undefined) {
      throw notFound();
    }
    return row;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ManagedGitWorktreeError(
        "WORKTREE_STORE_CLOSED",
        "The managed Worktree store is closed.",
      );
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#operationCount += 1;
    const previous = this.#operationTail;
    let release: (() => void) | undefined;
    this.#operationTail = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      this.#assertOpen();
      return await operation();
    } finally {
      this.#operationCount -= 1;
      release?.();
    }
  }
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  public async run(request: GitCommandRequest): Promise<GitCommandResult> {
    if (
      !Array.isArray(request.arguments) ||
      request.arguments.some((argument) => typeof argument !== "string") ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0
    ) {
      throw commandFailed();
    }
    const arguments_ = withTrustedGitConfiguration(request.arguments);
    if (!isManagedGitCommand(arguments_)) {
      throw commandFailed();
    }
    const environment = buildGitChildEnvironment(process.platform, process.env);
    const deadlineMs = performance.now() + request.timeoutMs;
    const outputBudget = { bytes: 0 };
    const repositoryRoot = request.arguments[1] as string;
    const filterInspection = await executeTrustedGitCommand({
      arguments: filterInspectionArguments(repositoryRoot),
      environment,
      outputBudget,
      timeoutMs: remainingCommandTime(deadlineMs),
    });
    if (filterInspection.exitCode !== 1 || filterInspection.stdout.length !== 0) {
      throw commandFailed();
    }
    const result = await executeTrustedGitCommand({
      arguments: arguments_,
      environment,
      outputBudget,
      timeoutMs: remainingCommandTime(deadlineMs),
    });
    if (result.exitCode !== 0) {
      throw commandFailed();
    }
    return Object.freeze({ stdout: result.stdout });
  }
}

interface TrustedGitExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
}

async function executeTrustedGitCommand(input: {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly outputBudget: { bytes: number };
  readonly timeoutMs: number;
}): Promise<TrustedGitExecutionResult> {
  if (!isTrustedGitInvocation(input.arguments)) {
    throw commandFailed();
  }
  return new Promise<TrustedGitExecutionResult>((resolveCommand, rejectCommand) => {
    // Both accepted grammars require the exact trusted configuration prefix, one
    // safe absolute -C path, and fixed local-only commands with no remote or
    // external-command option slot. Worktree creation is --no-checkout only;
    // materialization is the fixed target-local reset after this runner has
    // inspected effective filter configuration in that exact linked context.
    // A same-privilege process racing configuration after inspection is the
    // Device-compromise boundary defined by docs/THREAT_MODEL.md.
    // codeql[js/second-order-command-line-injection]
    const child = spawn("git", input.arguments, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.environment,
    });
    const stdout: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(commandFailed());
    }, input.timeoutMs);
    timer.unref();
    const finish = (error?: Error, result?: TrustedGitExecutionResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        rejectCommand(error);
      } else {
        resolveCommand(result ?? { exitCode: -1, stdout: "" });
      }
    };
    const collect = (chunk: Buffer, retain: boolean): void => {
      if (settled) {
        return;
      }
      input.outputBudget.bytes += chunk.byteLength;
      if (input.outputBudget.bytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        finish(commandFailed());
        return;
      }
      if (retain) {
        stdout.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", () => finish(commandFailed()));
    child.once("close", (code) => {
      if (code === null || code < 0) {
        finish(commandFailed());
        return;
      }
      finish(undefined, {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

function remainingCommandTime(deadlineMs: number): number {
  const remaining = Math.ceil(deadlineMs - performance.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw commandFailed();
  }
  return remaining;
}

function withTrustedGitConfiguration(arguments_: readonly string[]): readonly string[] {
  return Object.freeze([...TRUSTED_GIT_CONFIGURATION_ARGUMENTS, ...arguments_]);
}

function filterInspectionArguments(repositoryRoot: string): readonly string[] {
  return Object.freeze([
    ...TRUSTED_GIT_CONFIGURATION_ARGUMENTS,
    "-C",
    repositoryRoot,
    "config",
    "--null",
    "--includes",
    "--get-regexp",
    EXTERNAL_CHECKOUT_FILTER_PATTERN,
  ]);
}

function isTrustedGitInvocation(arguments_: readonly string[]): boolean {
  return isManagedGitCommand(arguments_) || isFilterInspectionCommand(arguments_);
}

function isManagedGitCommand(arguments_: readonly string[]): boolean {
  if (!hasTrustedGitConfiguration(arguments_)) {
    return false;
  }
  const offset = TRUSTED_GIT_CONFIGURATION_ARGUMENTS.length;
  if (
    arguments_.length < offset + 4 ||
    arguments_[offset] !== "-C" ||
    !safeAbsoluteGitPath(arguments_[offset + 1])
  ) {
    return false;
  }
  const command = arguments_.slice(offset + 2);
  if (
    sameArguments(command, ["worktree", "prune", "--expire", "now"]) ||
    sameArguments(command, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ||
    sameArguments(command, ["rev-parse", "--show-toplevel"]) ||
    sameArguments(command, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ||
    sameArguments(command, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])
  ) {
    return true;
  }
  if (
    command.length === 7 &&
    sameArguments(command.slice(0, 5), ["worktree", "add", "--no-checkout", "--detach", "--"])
  ) {
    return safeAbsoluteGitPath(command[5]) && COMMIT_PATTERN.test(command[6] ?? "");
  }
  if (
    command.length === 4 &&
    sameArguments(command.slice(0, 3), ["reset", "--hard", "--no-recurse-submodules"])
  ) {
    return COMMIT_PATTERN.test(command[3] ?? "");
  }
  if (
    command.length === 4 &&
    sameArguments(command.slice(0, 2), ["rev-list", "--count"]) &&
    command[3] === "--"
  ) {
    const range = command[2] ?? "";
    return range.endsWith("..HEAD") && COMMIT_PATTERN.test(range.slice(0, -6));
  }
  if (
    (command.length === 4 || command.length === 5) &&
    command[0] === "worktree" &&
    command[1] === "remove"
  ) {
    const forceOffset = command[2] === "--force" ? 1 : 0;
    return (
      command.length === 4 + forceOffset &&
      command[2 + forceOffset] === "--" &&
      safeAbsoluteGitPath(command[3 + forceOffset])
    );
  }
  return false;
}

function isFilterInspectionCommand(arguments_: readonly string[]): boolean {
  if (!hasTrustedGitConfiguration(arguments_)) {
    return false;
  }
  const offset = TRUSTED_GIT_CONFIGURATION_ARGUMENTS.length;
  return (
    arguments_.length === offset + 7 &&
    arguments_[offset] === "-C" &&
    safeAbsoluteGitPath(arguments_[offset + 1]) &&
    sameArguments(arguments_.slice(offset + 2), [
      "config",
      "--null",
      "--includes",
      "--get-regexp",
      EXTERNAL_CHECKOUT_FILTER_PATTERN,
    ])
  );
}

function hasTrustedGitConfiguration(arguments_: readonly string[]): boolean {
  return (
    arguments_.length >= TRUSTED_GIT_CONFIGURATION_ARGUMENTS.length &&
    TRUSTED_GIT_CONFIGURATION_ARGUMENTS.every((argument, index) => arguments_[index] === argument)
  );
}

function sameArguments(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

function safeAbsoluteGitPath(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    !value.includes("\0") &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    !basename(value).startsWith("-")
  );
}

export function buildGitChildEnvironment(
  hostPlatform: NodeJS.Platform,
  sourceEnvironment: GitChildEnvironmentSource,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const copyFirstPresent = (targetName: string, sourceNames: readonly string[]): void => {
    for (const sourceName of sourceNames) {
      const value = sourceEnvironment[sourceName];
      if (typeof value === "string" && value.length > 0) {
        environment[targetName] = value;
        return;
      }
    }
  };

  if (hostPlatform === "win32") {
    copyFirstPresent("PATH", ["PATH", "Path"]);
    copyFirstPresent("PATHEXT", ["PATHEXT", "PathExt"]);
    copyFirstPresent("SystemRoot", ["SystemRoot", "SYSTEMROOT"]);
    copyFirstPresent("WINDIR", ["WINDIR", "WinDir"]);
    copyFirstPresent("COMSPEC", ["COMSPEC", "ComSpec"]);
  } else {
    copyFirstPresent("PATH", ["PATH"]);
    copyFirstPresent("TMPDIR", ["TMPDIR"]);
  }
  copyFirstPresent("TEMP", ["TEMP"]);
  copyFirstPresent("TMP", ["TMP"]);

  const nullDevice = hostPlatform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = nullDevice;
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "";
  environment.GIT_PROTOCOL_FROM_USER = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LANG = "C";
  environment.LC_ALL = "C";
  environment.PAGER = "";
  return environment;
}

function validateManagerPaths(options: ManagedGitWorktreeManagerOptions): {
  readonly filename: string;
  readonly managedRoot: string;
} {
  if (
    typeof options.filename !== "string" ||
    !isAbsolute(options.filename) ||
    typeof options.managedRootDirectory !== "string" ||
    !isAbsolute(options.managedRootDirectory) ||
    typeof options.sourceCheckoutDirectory !== "string" ||
    !isAbsolute(options.sourceCheckoutDirectory)
  ) {
    throw rootUnsafe();
  }
  const checkout = inspectRealDirectory(
    options.sourceCheckoutDirectory,
    "WORKTREE_ROOT_UNSAFE",
  ).canonicalPath;
  const requestedRoot = resolve(options.managedRootDirectory);
  if (sameOrWithin(checkout, requestedRoot)) {
    throw rootUnsafe();
  }
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const managedRoot = inspectRealDirectory(requestedRoot, "WORKTREE_ROOT_UNSAFE").canonicalPath;
  if (sameOrWithin(checkout, managedRoot)) {
    throw rootUnsafe();
  }
  const requestedFilename = resolve(options.filename);
  if (sameOrWithin(checkout, requestedFilename)) {
    throw rootUnsafe();
  }
  const stateParent = dirname(requestedFilename);
  mkdirSync(stateParent, { recursive: true, mode: 0o700 });
  const stateParentIdentity = inspectRealDirectory(stateParent, "WORKTREE_ROOT_UNSAFE");
  const filename = join(stateParentIdentity.canonicalPath, basename(requestedFilename));
  if (sameOrWithin(checkout, filename) || sameOrWithin(managedRoot, filename)) {
    throw rootUnsafe();
  }
  if (existsSync(filename)) {
    const metadata = lstatSync(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw rootUnsafe();
    }
  }
  return Object.freeze({ filename, managedRoot });
}

function inspectRealDirectory(
  path: unknown,
  errorCode: "WORKTREE_PATH_CHANGED" | "WORKTREE_REPOSITORY_INVALID" | "WORKTREE_ROOT_UNSAFE",
): PathIdentity {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new Error("invalid");
    }
    const lexical = lstatSync(path);
    if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
      throw new Error("invalid");
    }
    const canonicalPath = realpathSync.native(path);
    const canonical = statSync(canonicalPath);
    if (!canonical.isDirectory()) {
      throw new Error("invalid");
    }
    return Object.freeze({
      canonicalPath,
      device: canonical.dev.toString(10),
      inode: canonical.ino.toString(10),
      birthtimeMs: safeFilesystemTime(canonical.birthtimeMs),
    });
  } catch {
    if (errorCode === "WORKTREE_PATH_CHANGED") {
      throw pathChanged();
    }
    if (errorCode === "WORKTREE_REPOSITORY_INVALID") {
      throw repositoryInvalid();
    }
    throw rootUnsafe();
  }
}

function assertSeparateTrees(repositoryRoot: string, managedRoot: string): void {
  if (sameOrWithin(repositoryRoot, managedRoot) || sameOrWithin(managedRoot, repositoryRoot)) {
    throw rootUnsafe();
  }
}

function assertPathIdentity(row: WorktreeRow): void {
  if (row.path_device === null || row.path_inode === null || row.path_birthtime_ms === null) {
    throw stateCorrupt();
  }
  const current = inspectRealDirectory(row.worktree_path, "WORKTREE_PATH_CHANGED");
  const recorded = Object.freeze({
    canonicalPath: row.worktree_path,
    device: row.path_device,
    inode: row.path_inode,
    birthtimeMs: row.path_birthtime_ms,
  });
  assertSamePathIdentity(recorded, current);
}

function assertSamePathIdentity(expected: PathIdentity, actual: PathIdentity): void {
  if (
    actual.canonicalPath !== expected.canonicalPath ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    (actual.device === "0" && actual.inode === "0" && actual.birthtimeMs !== expected.birthtimeMs)
  ) {
    throw pathChanged();
  }
}

function decodeRow(row: WorktreeRow): ManagedGitWorktreeRecord {
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
    record.worktreeId !== row.worktree_id ||
    record.workspaceId !== row.workspace_id ||
    record.repositoryRoot !== row.repository_root ||
    record.worktreePath !== row.worktree_path ||
    record.revision !== row.revision
  ) {
    throw stateCorrupt();
  }
  return record;
}

function parseRecord(input: unknown): ManagedGitWorktreeRecord {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "worktreeId",
      "workspaceId",
      "repositoryRoot",
      "worktreePath",
      "baseCommit",
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
    const worktreeId = validateIdentifier(input["worktreeId"]);
    const workspaceId = validateIdentifier(input["workspaceId"]);
    const repositoryRoot = validateAbsoluteStoredPath(input["repositoryRoot"]);
    const worktreePath = validateAbsoluteStoredPath(input["worktreePath"]);
    if (typeof input["baseCommit"] !== "string" || !COMMIT_PATTERN.test(input["baseCommit"])) {
      throw stateCorrupt();
    }
    if (
      input["state"] !== "creating" &&
      input["state"] !== "active" &&
      input["state"] !== "preserved" &&
      input["state"] !== "removed"
    ) {
      throw stateCorrupt();
    }
    const revision = readPositiveInteger(input["revision"]);
    const createdAtMs = readTimestamp(input["createdAtMs"]);
    const updatedAtMs = readTimestamp(input["updatedAtMs"]);
    if (updatedAtMs < createdAtMs) {
      throw stateCorrupt();
    }
    return freezeRecord({
      schemaVersion: 1,
      worktreeId,
      workspaceId,
      repositoryRoot,
      worktreePath,
      baseCommit: input["baseCommit"],
      state: input["state"],
      revision,
      createdAtMs,
      updatedAtMs,
    });
  } catch (error) {
    if (error instanceof ManagedGitWorktreeError && error.code === "WORKTREE_STATE_CORRUPT") {
      throw error;
    }
    throw stateCorrupt();
  }
}

function validateAbsoluteStoredPath(input: unknown): string {
  if (typeof input !== "string" || !isAbsolute(input) || resolve(input) !== input) {
    throw stateCorrupt();
  }
  return input;
}

function validateIdentifier(input: unknown): string {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    input.length === 0 ||
    Buffer.byteLength(input, "utf8") > MAX_IDENTIFIER_BYTES ||
    !IDENTIFIER_PATTERN.test(input)
  ) {
    throw invalidInput();
  }
  return input;
}

function validateDisposition(input: unknown): WorktreeCleanupDisposition | undefined {
  if (input === undefined || input === "preserve" || input === "discard") {
    return input;
  }
  throw invalidInput();
}

function validateCommandTimeout(input: unknown): number {
  if (input === undefined) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(input) || (input as number) < 1_000 || (input as number) > 300_000) {
    throw invalidInput();
  }
  return input as number;
}

function readClock(clock: ManagedGitWorktreeClock): number {
  try {
    return readTimestamp(clock.now());
  } catch {
    throw invalidInput();
  }
}

function readTimestamp(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw stateCorrupt();
  }
  return input as number;
}

function readPositiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw stateCorrupt();
  }
  return input as number;
}

function safeFilesystemTime(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function freezeRecord(input: ManagedGitWorktreeRecord): ManagedGitWorktreeRecord {
  return Object.freeze({ ...input });
}

function checksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameOrWithin(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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

function invalidInput(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_INPUT_INVALID",
    "The managed Worktree request is invalid.",
  );
}

function repositoryInvalid(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_REPOSITORY_INVALID",
    "The Workspace root must be the real top level of a Git repository.",
  );
}

function rootUnsafe(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_ROOT_UNSAFE",
    "Managed Worktrees and their state require separate real directories outside the source checkout.",
  );
}

function conflict(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_CONFLICT",
    "The managed Worktree identity conflicts with existing local state.",
  );
}

function notFound(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError("WORKTREE_NOT_FOUND", "The managed Worktree is not active.");
}

function pathChanged(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_PATH_CHANGED",
    "The managed Worktree path identity or Git binding changed.",
  );
}

function stateCorrupt(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_STATE_CORRUPT",
    "The managed Worktree registry is corrupt.",
  );
}

function commandFailed(): ManagedGitWorktreeError {
  return new ManagedGitWorktreeError(
    "WORKTREE_COMMAND_FAILED",
    "The bounded Git operation failed.",
  );
}
