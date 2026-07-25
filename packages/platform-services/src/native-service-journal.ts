import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { ServicePlanExecutionReport } from "./plan-executor.ts";
import type {
  ServiceCommandClaim,
  ServiceCommandJournal,
  ServiceCommandJournalEntry,
} from "./service-command.ts";

const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_DIRECTORY_NAME = "platform-services";
const JOURNAL_FILE_NAME = "native-service-command-journal.v1.json";
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIRECTORY_MODE = 0o700;
const DEFAULT_MAXIMUM_ENTRIES = 4_096;
const DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024;
const MAXIMUM_CONFIGURED_ENTRIES = 100_000;
const MAXIMUM_CONFIGURED_BYTES = 64 * 1024 * 1024;
const MAXIMUM_REPORT_ITEMS = 4_096;
const MAXIMUM_SUMMARY_LENGTH = 2_048;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PLAN_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/u;
const SECRET_MATERIAL_PATTERN =
  /(?:secret:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:api[_-]?key|authorization|password|private[_-]?key|secret|token)\s*[:=]\s*\S+)/iu;

type JournalOperation = ServiceCommandJournalEntry["operation"];
type JournalPlatform = ServiceCommandJournalEntry["platform"];

export type NativeServiceCommandJournalErrorCode =
  | "NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED"
  | "NATIVE_SERVICE_JOURNAL_CONFLICT"
  | "NATIVE_SERVICE_JOURNAL_CORRUPT"
  | "NATIVE_SERVICE_JOURNAL_INVALID_CONFIGURATION"
  | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY"
  | "NATIVE_SERVICE_JOURNAL_UNAVAILABLE";

export class NativeServiceCommandJournalError extends Error {
  public readonly code: NativeServiceCommandJournalErrorCode;

  public constructor(
    code: NativeServiceCommandJournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeServiceCommandJournalError";
    this.code = code;
  }
}

/**
 * The host-specific persistence boundary for the service command journal.
 *
 * Implementations must hold one exclusive, cross-process lock for the entire
 * callback and must make `writeFileAtomic` either leave the old file intact or
 * replace it completely. The boundary is also responsible for refusing links and
 * special files at these paths.
 */
export interface NativeServiceJournalAtomicBoundary {
  ensureDirectory(path: string, mode: number): Promise<void>;
  withExclusiveLock<Result>(lockPath: string, operation: () => Promise<Result>): Promise<Result>;
  readFile(path: string, maximumBytes: number): Promise<Buffer | undefined>;
  writeFileAtomic(path: string, bytes: Buffer, mode: number): Promise<void>;
}

export interface NativeServiceCommandJournalLimits {
  readonly maximumBytes?: number;
  readonly maximumEntries?: number;
}

export interface CreateNativeServiceCommandJournalInput {
  /**
   * An absolute, externally configured runtime state root. This is deliberately
   * not inferred from the source checkout or process working directory.
   */
  readonly stateRoot: string;
  readonly boundary: NativeServiceJournalAtomicBoundary;
  readonly limits?: NativeServiceCommandJournalLimits;
}

export interface NativeServiceCommandJournal extends ServiceCommandJournal {
  readonly directoryPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
}

interface StoredJournal {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly entries: readonly StoredJournalEntry[];
}

type StoredJournalEntry =
  | {
      readonly commandId: string;
      readonly planFingerprint: string;
      readonly operation: JournalOperation;
      readonly platform: JournalPlatform;
      readonly instanceId: string;
      readonly state: "in-progress";
    }
  | {
      readonly commandId: string;
      readonly planFingerprint: string;
      readonly operation: JournalOperation;
      readonly platform: JournalPlatform;
      readonly instanceId: string;
      readonly state: "completed";
      readonly report: ServicePlanExecutionReport;
    };

interface NormalizedBinding {
  readonly commandId: string;
  readonly planFingerprint: string;
  readonly operation: JournalOperation;
  readonly platform: JournalPlatform;
  readonly instanceId: string;
}

interface JournalLimits {
  readonly maximumBytes: number;
  readonly maximumEntries: number;
}

export function createNativeServiceCommandJournal(
  input: CreateNativeServiceCommandJournalInput,
): NativeServiceCommandJournal {
  const stateRoot = validateStateRoot(input.stateRoot);
  const limits = validateLimits(input.limits);
  const directoryPath = join(stateRoot, JOURNAL_DIRECTORY_NAME);
  const journalPath = join(directoryPath, JOURNAL_FILE_NAME);
  const lockPath = `${journalPath}.lock`;

  return {
    directoryPath,
    journalPath,
    lockPath,

    async claim(entry): Promise<ServiceCommandClaim> {
      const binding = normalizeClaimEntry(entry);
      return runLocked(input.boundary, directoryPath, lockPath, async () => {
        const journal = await loadJournal(input.boundary, journalPath, limits);
        const existing = journal.entries.find(
          (candidate) => candidate.commandId === binding.commandId,
        );
        if (existing !== undefined) {
          return claimFromStoredEntry(existing);
        }
        if (journal.entries.length >= limits.maximumEntries) {
          throw new NativeServiceCommandJournalError(
            "NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED",
            "The durable native service command journal reached its configured entry limit.",
          );
        }
        const next: StoredJournal = {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          entries: [
            ...journal.entries,
            {
              ...binding,
              state: "in-progress",
            },
          ],
        };
        await persistJournal(input.boundary, journalPath, next, limits);
        return { disposition: "claimed" };
      });
    },

    async complete(entry): Promise<void> {
      const completeRecord = strictRecord(
        entry,
        ["commandId", "planFingerprint", "operation", "platform", "instanceId", "report"],
        [],
        "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
      );
      const binding = normalizeBinding(completeRecord, "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY");
      const report = normalizeReport(
        completeRecord["report"],
        binding,
        "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
      );
      await runLocked(input.boundary, directoryPath, lockPath, async () => {
        const journal = await loadJournal(input.boundary, journalPath, limits);
        const existingIndex = journal.entries.findIndex(
          (candidate) => candidate.commandId === binding.commandId,
        );
        if (existingIndex < 0) {
          throw new NativeServiceCommandJournalError(
            "NATIVE_SERVICE_JOURNAL_CONFLICT",
            "A native service command cannot be completed before its durable claim exists.",
          );
        }
        const existing = journal.entries[existingIndex];
        if (existing === undefined || !sameBinding(existing, binding)) {
          throw new NativeServiceCommandJournalError(
            "NATIVE_SERVICE_JOURNAL_CONFLICT",
            "The native service command completion does not match its durable claim.",
          );
        }
        if (existing.state === "completed") {
          if (!reportsEqual(existing.report, report)) {
            throw new NativeServiceCommandJournalError(
              "NATIVE_SERVICE_JOURNAL_CONFLICT",
              "A completed native service command cannot be replaced by a different report.",
            );
          }
          return;
        }
        const entries = [...journal.entries];
        entries[existingIndex] = {
          ...binding,
          state: "completed",
          report,
        };
        await persistJournal(
          input.boundary,
          journalPath,
          {
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            entries,
          },
          limits,
        );
      });
    },
  };
}

async function runLocked<Result>(
  boundary: NativeServiceJournalAtomicBoundary,
  directoryPath: string,
  lockPath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    await boundary.ensureDirectory(directoryPath, JOURNAL_DIRECTORY_MODE);
    return await boundary.withExclusiveLock(lockPath, operation);
  } catch (error) {
    if (error instanceof NativeServiceCommandJournalError) {
      throw error;
    }
    throw new NativeServiceCommandJournalError(
      "NATIVE_SERVICE_JOURNAL_UNAVAILABLE",
      "The durable native service command journal could not complete an atomic file operation.",
      { cause: error },
    );
  }
}

async function loadJournal(
  boundary: NativeServiceJournalAtomicBoundary,
  journalPath: string,
  limits: JournalLimits,
): Promise<StoredJournal> {
  const bytes = await boundary.readFile(journalPath, limits.maximumBytes);
  if (bytes === undefined) {
    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      entries: [],
    };
  }
  if (bytes.length === 0 || bytes.length > limits.maximumBytes) {
    throw corrupt("The native service command journal has an invalid byte length.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw corrupt("The native service command journal is not valid UTF-8.", error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw corrupt("The native service command journal is not valid JSON.", error);
  }
  return normalizeStoredJournal(value, limits);
}

async function persistJournal(
  boundary: NativeServiceJournalAtomicBoundary,
  journalPath: string,
  journal: StoredJournal,
  limits: JournalLimits,
): Promise<void> {
  if (journal.entries.length > limits.maximumEntries) {
    throw new NativeServiceCommandJournalError(
      "NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED",
      "The durable native service command journal exceeded its configured entry limit.",
    );
  }
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
  if (bytes.length > limits.maximumBytes) {
    throw new NativeServiceCommandJournalError(
      "NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED",
      "The durable native service command journal exceeded its configured byte limit.",
    );
  }
  await boundary.writeFileAtomic(journalPath, bytes, JOURNAL_FILE_MODE);
}

function normalizeStoredJournal(value: unknown, limits: JournalLimits): StoredJournal {
  const root = strictRecord(
    value,
    ["schemaVersion", "entries"],
    [],
    "NATIVE_SERVICE_JOURNAL_CORRUPT",
  );
  if (root["schemaVersion"] !== JOURNAL_SCHEMA_VERSION) {
    throw corrupt("The native service command journal schema version is unsupported.");
  }
  if (!Array.isArray(root["entries"])) {
    throw corrupt("The native service command journal entries field is invalid.");
  }
  if (root["entries"].length > limits.maximumEntries) {
    throw corrupt("The native service command journal exceeds its configured entry limit.");
  }
  const seenCommandIds = new Set<string>();
  const entries = root["entries"].map((entry) => {
    const normalized = normalizeStoredEntry(entry);
    if (seenCommandIds.has(normalized.commandId)) {
      throw corrupt("The native service command journal contains a duplicate command ID.");
    }
    seenCommandIds.add(normalized.commandId);
    return normalized;
  });
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    entries,
  };
}

function normalizeStoredEntry(value: unknown): StoredJournalEntry {
  const base = strictRecord(
    value,
    ["commandId", "planFingerprint", "operation", "platform", "instanceId", "state"],
    ["report"],
    "NATIVE_SERVICE_JOURNAL_CORRUPT",
  );
  const binding = normalizeBinding(base, "NATIVE_SERVICE_JOURNAL_CORRUPT");
  if (base["state"] === "in-progress") {
    if ("report" in base) {
      throw corrupt("An in-progress native service command cannot contain a report.");
    }
    return {
      ...binding,
      state: "in-progress",
    };
  }
  if (base["state"] !== "completed" || !("report" in base)) {
    throw corrupt("A native service command journal entry has an invalid state.");
  }
  return {
    ...binding,
    state: "completed",
    report: normalizeReport(base["report"], binding, "NATIVE_SERVICE_JOURNAL_CORRUPT"),
  };
}

function normalizeClaimEntry(entry: ServiceCommandJournalEntry): NormalizedBinding {
  const record = strictRecord(
    entry,
    ["commandId", "planFingerprint", "operation", "platform", "instanceId"],
    [],
    "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
  );
  return normalizeBinding(record, "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY");
}

function normalizeBinding(
  value: unknown,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): NormalizedBinding {
  const record = asRecord(value, code);
  const commandId = boundedIdentifier(record["commandId"], COMMAND_ID_PATTERN, "command ID", code);
  const planFingerprint = boundedIdentifier(
    record["planFingerprint"],
    PLAN_FINGERPRINT_PATTERN,
    "plan fingerprint",
    code,
  );
  const operation = normalizeOperation(record["operation"], code);
  const platform = normalizePlatform(record["platform"], code);
  const instanceId = boundedIdentifier(
    record["instanceId"],
    INSTANCE_ID_PATTERN,
    "Instance ID",
    code,
  );
  return {
    commandId,
    planFingerprint,
    operation,
    platform,
    instanceId,
  };
}

function normalizeReport(
  value: unknown,
  binding: NormalizedBinding,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): ServicePlanExecutionReport {
  const report = strictRecord(
    value,
    [
      "outcome",
      "operation",
      "platform",
      "instanceId",
      "completedStepIds",
      "unchangedStepIds",
      "rollback",
      "diagnostic",
    ],
    ["failedStepId"],
    code,
  );
  const outcome = report["outcome"];
  if (outcome !== "failed" && outcome !== "rolled-back" && outcome !== "succeeded") {
    throw schemaError(code, "The native service command report outcome is invalid.");
  }
  const operation = normalizeOperation(report["operation"], code);
  const platform = normalizePlatform(report["platform"], code);
  const instanceId = boundedIdentifier(
    report["instanceId"],
    INSTANCE_ID_PATTERN,
    "report Instance ID",
    code,
  );
  if (
    operation !== binding.operation ||
    platform !== binding.platform ||
    instanceId !== binding.instanceId
  ) {
    throw schemaError(
      code,
      "The native service command report does not match its claimed binding.",
    );
  }
  const completedStepIds = normalizeIdentifierArray(
    report["completedStepIds"],
    "completed step IDs",
    code,
  );
  const unchangedStepIds = normalizeIdentifierArray(
    report["unchangedStepIds"],
    "unchanged step IDs",
    code,
  );
  if (unchangedStepIds.some((stepId) => !completedStepIds.includes(stepId))) {
    throw schemaError(
      code,
      "The native service command report marks an uncompleted step as unchanged.",
    );
  }
  const failedStepId =
    "failedStepId" in report
      ? boundedIdentifier(report["failedStepId"], STEP_ID_PATTERN, "failed step ID", code)
      : undefined;
  const rollbackRecord = strictRecord(
    report["rollback"],
    ["attempted", "completedStepIds", "failures"],
    [],
    code,
  );
  if (typeof rollbackRecord["attempted"] !== "boolean") {
    throw schemaError(code, "The native service command rollback flag is invalid.");
  }
  const rollbackCompletedStepIds = normalizeIdentifierArray(
    rollbackRecord["completedStepIds"],
    "rollback step IDs",
    code,
  );
  const rollbackFailures = normalizeRollbackFailures(rollbackRecord["failures"], code);
  const diagnosticRecord = strictRecord(
    report["diagnostic"],
    ["eventName", "summary"],
    ["errorType"],
    code,
  );
  const expectedEventName =
    outcome === "succeeded"
      ? "platform.service.operation.succeeded"
      : outcome === "rolled-back"
        ? "platform.service.operation.rolled_back"
        : "platform.service.operation.failed";
  if (diagnosticRecord["eventName"] !== expectedEventName) {
    throw schemaError(
      code,
      "The native service command diagnostic event does not match its outcome.",
    );
  }
  const summary = boundedSafeText(
    diagnosticRecord["summary"],
    MAXIMUM_SUMMARY_LENGTH,
    "diagnostic summary",
    code,
  );
  const errorType =
    "errorType" in diagnosticRecord
      ? boundedIdentifier(
          diagnosticRecord["errorType"],
          ERROR_TYPE_PATTERN,
          "diagnostic error type",
          code,
        )
      : undefined;

  if (
    (outcome === "succeeded" &&
      (failedStepId !== undefined ||
        rollbackRecord["attempted"] ||
        rollbackCompletedStepIds.length > 0 ||
        rollbackFailures.length > 0)) ||
    (outcome !== "succeeded" && failedStepId === undefined) ||
    (outcome === "rolled-back" && (!rollbackRecord["attempted"] || rollbackFailures.length > 0)) ||
    (!rollbackRecord["attempted"] &&
      (rollbackCompletedStepIds.length > 0 || rollbackFailures.length > 0))
  ) {
    throw schemaError(
      code,
      "The native service command report contains an inconsistent terminal state.",
    );
  }

  const normalized: ServicePlanExecutionReport = {
    outcome,
    operation,
    platform,
    instanceId,
    completedStepIds,
    unchangedStepIds,
    ...(failedStepId === undefined ? {} : { failedStepId }),
    rollback: {
      attempted: rollbackRecord["attempted"],
      completedStepIds: rollbackCompletedStepIds,
      failures: rollbackFailures,
    },
    diagnostic: {
      eventName: expectedEventName,
      summary,
      ...(errorType === undefined ? {} : { errorType }),
    },
  };
  return normalized;
}

function normalizeRollbackFailures(
  value: unknown,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): ServicePlanExecutionReport["rollback"]["failures"] {
  if (!Array.isArray(value) || value.length > MAXIMUM_REPORT_ITEMS) {
    throw schemaError(code, "The native service command rollback failures are invalid.");
  }
  const seenStepIds = new Set<string>();
  return value.map((failure) => {
    const record = strictRecord(failure, ["stepId", "actionKind", "errorType"], [], code);
    const stepId = boundedIdentifier(
      record["stepId"],
      STEP_ID_PATTERN,
      "rollback failure step ID",
      code,
    );
    if (seenStepIds.has(stepId)) {
      throw schemaError(
        code,
        "The native service command report contains duplicate rollback failures.",
      );
    }
    seenStepIds.add(stepId);
    const actionKind = record["actionKind"];
    if (
      actionKind !== "account.ensure" &&
      actionKind !== "account.remove" &&
      actionKind !== "activation.switch" &&
      actionKind !== "directory.ensure" &&
      actionKind !== "file.write" &&
      actionKind !== "health.check" &&
      actionKind !== "path.remove" &&
      actionKind !== "release.promote" &&
      actionKind !== "release.prune" &&
      actionKind !== "release.remove" &&
      actionKind !== "release.stage" &&
      actionKind !== "release.verify" &&
      actionKind !== "supervisor.invoke"
    ) {
      throw schemaError(
        code,
        "The native service command rollback failure action kind is invalid.",
      );
    }
    const errorType = boundedIdentifier(
      record["errorType"],
      ERROR_TYPE_PATTERN,
      "rollback failure error type",
      code,
    );
    return {
      stepId,
      actionKind,
      errorType,
    };
  });
}

function normalizeIdentifierArray(
  value: unknown,
  label: string,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_REPORT_ITEMS) {
    throw schemaError(code, `The native service command ${label} are invalid.`);
  }
  const result = value.map((entry) => boundedIdentifier(entry, STEP_ID_PATTERN, label, code));
  if (new Set(result).size !== result.length) {
    throw schemaError(code, `The native service command ${label} contain duplicates.`);
  }
  return result;
}

function normalizeOperation(
  value: unknown,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): JournalOperation {
  if (
    value !== "install" &&
    value !== "reconfigure" &&
    value !== "restart" &&
    value !== "start" &&
    value !== "stop" &&
    value !== "uninstall" &&
    value !== "upgrade"
  ) {
    throw schemaError(code, "The native service command operation is invalid.");
  }
  return value;
}

function normalizePlatform(
  value: unknown,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): JournalPlatform {
  if (value !== "linux" && value !== "macos" && value !== "windows") {
    throw schemaError(code, "The native service command platform is invalid.");
  }
  return value;
}

function boundedIdentifier(
  value: unknown,
  pattern: RegExp,
  label: string,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw schemaError(code, `The native service command ${label} is invalid.`);
  }
  return value;
}

function boundedSafeText(
  value: unknown,
  maximumLength: number,
  label: string,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\0") ||
    SECRET_MATERIAL_PATTERN.test(value)
  ) {
    throw schemaError(
      code,
      `The native service command ${label} is invalid or contains secret material.`,
    );
  }
  return value;
}

function strictRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): Record<string, unknown> {
  const record = asRecord(value, code);
  const keys = Object.keys(record);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw schemaError(code, "The native service command journal schema is invalid.");
  }
  return record;
}

function asRecord(
  value: unknown,
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw schemaError(code, "The native service command journal value is invalid.");
  }
  return value as Record<string, unknown>;
}

function sameBinding(left: StoredJournalEntry, right: NormalizedBinding): boolean {
  return (
    left.commandId === right.commandId &&
    left.planFingerprint === right.planFingerprint &&
    left.operation === right.operation &&
    left.platform === right.platform &&
    left.instanceId === right.instanceId
  );
}

function reportsEqual(
  left: ServicePlanExecutionReport,
  right: ServicePlanExecutionReport,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function claimFromStoredEntry(entry: StoredJournalEntry): ServiceCommandClaim {
  return entry.state === "in-progress"
    ? {
        disposition: "in-progress",
        planFingerprint: entry.planFingerprint,
      }
    : {
        disposition: "completed",
        planFingerprint: entry.planFingerprint,
        report: entry.report,
      };
}

function validateStateRoot(stateRoot: string): string {
  if (
    typeof stateRoot !== "string" ||
    stateRoot.trim() === "" ||
    !isAbsolute(stateRoot) ||
    stateRoot.includes("\0") ||
    stateRoot.includes("\n") ||
    stateRoot.includes("\r")
  ) {
    throw new NativeServiceCommandJournalError(
      "NATIVE_SERVICE_JOURNAL_INVALID_CONFIGURATION",
      "The native service command journal requires an absolute external state root.",
    );
  }
  return resolve(stateRoot);
}

function validateLimits(input: NativeServiceCommandJournalLimits | undefined): JournalLimits {
  const maximumEntries = input?.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
  const maximumBytes = input?.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > MAXIMUM_CONFIGURED_ENTRIES ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1_024 ||
    maximumBytes > MAXIMUM_CONFIGURED_BYTES
  ) {
    throw new NativeServiceCommandJournalError(
      "NATIVE_SERVICE_JOURNAL_INVALID_CONFIGURATION",
      "The native service command journal limits are outside the supported bounds.",
    );
  }
  return {
    maximumEntries,
    maximumBytes,
  };
}

function schemaError(
  code: "NATIVE_SERVICE_JOURNAL_CORRUPT" | "NATIVE_SERVICE_JOURNAL_INVALID_ENTRY",
  message: string,
): NativeServiceCommandJournalError {
  return new NativeServiceCommandJournalError(code, message);
}

function corrupt(message: string, cause?: unknown): NativeServiceCommandJournalError {
  return new NativeServiceCommandJournalError(
    "NATIVE_SERVICE_JOURNAL_CORRUPT",
    message,
    cause === undefined ? undefined : { cause },
  );
}
