import { isAbsolute, join, parse, resolve } from "node:path";

import type { NativeServiceJournalAtomicBoundary } from "./native-service-journal.ts";
import type {
  PlatformMutationActionCategory,
  PlatformMutationCommandJournal,
  PlatformMutationCommandJournalEntry,
  PlatformMutationReceipt,
} from "./platform-mutation-executor.ts";

const SCHEMA_VERSION = 1;
const DIRECTORY_NAME = "platform-mutations";
const JOURNAL_NAME = "platform-mutation-journal.v1.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAXIMUM_BYTES = 8 * 1024 * 1024;
const MAXIMUM_ENTRIES = 4_096;
const DEFAULT_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MINIMUM_COMPLETED_RETENTION_MS = 60_000;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/u;
const ACTION_CATEGORIES = new Set<PlatformMutationActionCategory>([
  "project-dependency-install",
  "configured-official-package-install",
  "package-repository-addition",
  "remote-installer-script",
  "untrusted-installer",
  "driver-installation",
  "kernel-extension-installation",
  "os-network-change",
  "vpn-change",
  "firewall-change",
]);

export type PlatformMutationJournalErrorCode =
  | "MUTATION_JOURNAL_CAPACITY_EXCEEDED"
  | "MUTATION_JOURNAL_CONFLICT"
  | "MUTATION_JOURNAL_CORRUPT"
  | "MUTATION_JOURNAL_INVALID_CONFIGURATION"
  | "MUTATION_JOURNAL_UNAVAILABLE";

export class PlatformMutationJournalError extends Error {
  public readonly code: PlatformMutationJournalErrorCode;

  public constructor(
    code: PlatformMutationJournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlatformMutationJournalError";
    this.code = code;
  }
}

export interface NativePlatformMutationJournal extends PlatformMutationCommandJournal {
  readonly directoryPath: string;
  readonly journalPath: string;
  readonly lockPath: string;
  inspect(): Promise<PlatformMutationJournalHealth>;
}

export interface CreateNativePlatformMutationJournalInput {
  readonly stateRoot: string;
  readonly boundary: NativeServiceJournalAtomicBoundary;
  readonly clock?: { now(): number };
  readonly completedRetentionMs?: number;
  readonly maximumEntries?: number;
}

export interface PlatformMutationJournalHealth {
  readonly entryCount: number;
  readonly inProgressCount: number;
  readonly completedCount: number;
  readonly compactionEligibleCount: number;
  readonly maximumEntries: number;
  readonly status: "ready" | "near-capacity" | "blocked";
}

interface StoredJournal {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: readonly PlatformMutationCommandJournalEntry[];
}

export function createNativePlatformMutationJournal(
  input: CreateNativePlatformMutationJournalInput,
): NativePlatformMutationJournal {
  const stateRoot = validateStateRoot(input.stateRoot);
  const completedRetentionMs = input.completedRetentionMs ?? DEFAULT_COMPLETED_RETENTION_MS;
  const maximumEntries = input.maximumEntries ?? MAXIMUM_ENTRIES;
  if (
    input.boundary === null ||
    typeof input.boundary !== "object" ||
    typeof input.boundary.ensureDirectory !== "function" ||
    typeof input.boundary.withExclusiveLock !== "function" ||
    typeof input.boundary.readFile !== "function" ||
    typeof input.boundary.writeFileAtomic !== "function" ||
    !Number.isSafeInteger(completedRetentionMs) ||
    completedRetentionMs < MINIMUM_COMPLETED_RETENTION_MS ||
    completedRetentionMs > 365 * 24 * 60 * 60_000 ||
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 2 ||
    maximumEntries > MAXIMUM_ENTRIES ||
    (input.clock !== undefined && typeof input.clock.now !== "function")
  ) {
    throw invalidConfiguration();
  }
  const directoryPath = join(stateRoot, DIRECTORY_NAME);
  const journalPath = join(directoryPath, JOURNAL_NAME);
  const lockPath = `${journalPath}.lock`;

  return Object.freeze({
    directoryPath,
    journalPath,
    lockPath,

    async inspect() {
      return runLocked(input.boundary, directoryPath, lockPath, async () => {
        const journal = await load(input.boundary, journalPath);
        return journalHealth(
          journal.entries,
          now(input.clock),
          completedRetentionMs,
          maximumEntries,
        );
      });
    },

    async claim(entry: Omit<PlatformMutationCommandJournalEntry, "receipt" | "state">) {
      const binding = normalizeBinding(entry);
      return runLocked(input.boundary, directoryPath, lockPath, async () => {
        const journal = await load(input.boundary, journalPath);
        const existing = journal.entries.find(
          (candidate) => candidate.commandId === binding.commandId,
        );
        if (existing !== undefined) {
          if (
            existing.actionCategory !== binding.actionCategory ||
            existing.actionFingerprint !== binding.actionFingerprint
          ) {
            return { disposition: "conflict" } as const;
          }
          return existing.state === "completed"
            ? ({ disposition: "completed", receipt: existing.receipt } as const)
            : ({ disposition: "in-progress" } as const);
        }
        const retainedEntries = compactCompletedEntries(
          journal.entries,
          now(input.clock),
          completedRetentionMs,
        );
        if (retainedEntries.length >= maximumEntries) {
          throw new PlatformMutationJournalError(
            "MUTATION_JOURNAL_CAPACITY_EXCEEDED",
            "The durable platform mutation journal has no safely compactable capacity.",
          );
        }
        await persist(input.boundary, journalPath, {
          schemaVersion: SCHEMA_VERSION,
          entries: [
            ...retainedEntries,
            {
              ...binding,
              state: "in-progress",
            },
          ],
        });
        return { disposition: "claimed" } as const;
      });
    },

    async complete(input_: {
      readonly commandId: string;
      readonly actionFingerprint: `sha256:${string}`;
      readonly receipt: PlatformMutationReceipt;
    }) {
      const binding = normalizeCompletion(input_);
      await runLocked(input.boundary, directoryPath, lockPath, async () => {
        const journal = await load(input.boundary, journalPath);
        const index = journal.entries.findIndex(
          (candidate) => candidate.commandId === binding.commandId,
        );
        const existing = journal.entries[index];
        if (
          index < 0 ||
          existing === undefined ||
          existing.actionFingerprint !== binding.actionFingerprint ||
          existing.actionCategory !== binding.receipt.actionCategory
        ) {
          throw new PlatformMutationJournalError(
            "MUTATION_JOURNAL_CONFLICT",
            "The platform mutation completion does not match its durable claim.",
          );
        }
        if (existing.state === "completed") {
          if (JSON.stringify(existing.receipt) !== JSON.stringify(binding.receipt)) {
            throw new PlatformMutationJournalError(
              "MUTATION_JOURNAL_CONFLICT",
              "A completed platform mutation receipt cannot be replaced.",
            );
          }
          return;
        }
        const entries = [...journal.entries];
        entries[index] = {
          commandId: binding.commandId,
          actionCategory: existing.actionCategory,
          actionFingerprint: binding.actionFingerprint,
          state: "completed",
          receipt: binding.receipt,
        };
        await persist(input.boundary, journalPath, {
          schemaVersion: SCHEMA_VERSION,
          entries,
        });
      });
    },
  });
}

function compactCompletedEntries(
  entries: readonly PlatformMutationCommandJournalEntry[],
  currentTime: number,
  completedRetentionMs: number,
): readonly PlatformMutationCommandJournalEntry[] {
  const cutoff = currentTime - completedRetentionMs;
  return entries.filter(
    (entry) => entry.state === "in-progress" || entry.receipt.completedAtMs > cutoff,
  );
}

function journalHealth(
  entries: readonly PlatformMutationCommandJournalEntry[],
  currentTime: number,
  completedRetentionMs: number,
  maximumEntries: number,
): PlatformMutationJournalHealth {
  const inProgressCount = entries.filter((entry) => entry.state === "in-progress").length;
  const completedCount = entries.length - inProgressCount;
  const compactionEligibleCount =
    entries.length - compactCompletedEntries(entries, currentTime, completedRetentionMs).length;
  const retainedCount = entries.length - compactionEligibleCount;
  return Object.freeze({
    entryCount: entries.length,
    inProgressCount,
    completedCount,
    compactionEligibleCount,
    maximumEntries,
    status:
      retainedCount >= maximumEntries
        ? "blocked"
        : retainedCount >= Math.floor(maximumEntries * 0.8)
          ? "near-capacity"
          : "ready",
  });
}

function now(clock?: { now(): number }): number {
  const value = (clock ?? { now: () => Date.now() }).now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PlatformMutationJournalError(
      "MUTATION_JOURNAL_UNAVAILABLE",
      "The durable platform mutation journal clock is unavailable.",
    );
  }
  return value;
}

async function runLocked<Result>(
  boundary: NativeServiceJournalAtomicBoundary,
  directoryPath: string,
  lockPath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    await boundary.ensureDirectory(directoryPath, DIRECTORY_MODE);
    return await boundary.withExclusiveLock(lockPath, operation);
  } catch (error) {
    if (error instanceof PlatformMutationJournalError) {
      throw error;
    }
    throw new PlatformMutationJournalError(
      "MUTATION_JOURNAL_UNAVAILABLE",
      "The durable platform mutation journal is unavailable.",
      { cause: error },
    );
  }
}

async function load(
  boundary: NativeServiceJournalAtomicBoundary,
  journalPath: string,
): Promise<StoredJournal> {
  const bytes = await boundary.readFile(journalPath, MAXIMUM_BYTES);
  if (bytes === undefined) {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw corrupt(error);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "entries"]) ||
    value["schemaVersion"] !== SCHEMA_VERSION ||
    !Array.isArray(value["entries"]) ||
    value["entries"].length > MAXIMUM_ENTRIES
  ) {
    throw corrupt();
  }
  const commandIds = new Set<string>();
  const entries = value["entries"].map((entry) => {
    const normalized = normalizeStoredEntry(entry);
    if (commandIds.has(normalized.commandId)) {
      throw corrupt();
    }
    commandIds.add(normalized.commandId);
    return normalized;
  });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    entries: Object.freeze(entries),
  });
}

async function persist(
  boundary: NativeServiceJournalAtomicBoundary,
  journalPath: string,
  journal: StoredJournal,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`, "utf8");
  if (bytes.length > MAXIMUM_BYTES) {
    throw new PlatformMutationJournalError(
      "MUTATION_JOURNAL_CAPACITY_EXCEEDED",
      "The durable platform mutation journal reached its byte limit.",
    );
  }
  await boundary.writeFileAtomic(journalPath, bytes, FILE_MODE);
}

function normalizeBinding(
  value: unknown,
): Omit<PlatformMutationCommandJournalEntry, "receipt" | "state"> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["commandId", "actionCategory", "actionFingerprint"])
  ) {
    throw corrupt();
  }
  return normalizeBindingFields(value);
}

function normalizeBindingFields(
  value: Readonly<Record<string, unknown>>,
): Omit<PlatformMutationCommandJournalEntry, "receipt" | "state"> {
  if (
    typeof value["commandId"] !== "string" ||
    !COMMAND_ID_PATTERN.test(value["commandId"]) ||
    !isActionCategory(value["actionCategory"]) ||
    typeof value["actionFingerprint"] !== "string" ||
    !FINGERPRINT_PATTERN.test(value["actionFingerprint"])
  ) {
    throw corrupt();
  }
  return Object.freeze({
    commandId: value["commandId"],
    actionCategory: value["actionCategory"],
    actionFingerprint: value["actionFingerprint"] as `sha256:${string}`,
  });
}

function normalizeCompletion(value: unknown): {
  readonly commandId: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly receipt: PlatformMutationReceipt;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["commandId", "actionFingerprint", "receipt"])) {
    throw corrupt();
  }
  const receipt = normalizeReceipt(value["receipt"]);
  if (
    value["commandId"] !== receipt.commandId ||
    value["actionFingerprint"] !== receipt.actionFingerprint
  ) {
    throw corrupt();
  }
  return Object.freeze({
    commandId: receipt.commandId,
    actionFingerprint: receipt.actionFingerprint,
    receipt,
  });
}

function normalizeStoredEntry(value: unknown): PlatformMutationCommandJournalEntry {
  if (!isRecord(value) || (value["state"] !== "in-progress" && value["state"] !== "completed")) {
    throw corrupt();
  }
  const binding = normalizeBindingFields(value);
  if (value["state"] === "in-progress") {
    if (!hasExactKeys(value, ["commandId", "actionCategory", "actionFingerprint", "state"])) {
      throw corrupt();
    }
    return Object.freeze({ ...binding, state: "in-progress" });
  }
  if (
    !hasExactKeys(value, ["commandId", "actionCategory", "actionFingerprint", "state", "receipt"])
  ) {
    throw corrupt();
  }
  const receipt = normalizeReceipt(value["receipt"]);
  if (
    receipt.commandId !== binding.commandId ||
    receipt.actionCategory !== binding.actionCategory ||
    receipt.actionFingerprint !== binding.actionFingerprint
  ) {
    throw corrupt();
  }
  return Object.freeze({ ...binding, state: "completed", receipt });
}

function normalizeReceipt(value: unknown): PlatformMutationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "commandId",
        "actionCategory",
        "actionFingerprint",
        "outcome",
        "reasonCode",
        "completedAtMs",
      ],
      ["exitCode", "processSignal"],
    ) ||
    typeof value["commandId"] !== "string" ||
    !COMMAND_ID_PATTERN.test(value["commandId"]) ||
    !isActionCategory(value["actionCategory"]) ||
    typeof value["actionFingerprint"] !== "string" ||
    !FINGERPRINT_PATTERN.test(value["actionFingerprint"]) ||
    (value["outcome"] !== "succeeded" &&
      value["outcome"] !== "failed" &&
      value["outcome"] !== "denied") ||
    typeof value["reasonCode"] !== "string" ||
    !REASON_CODE_PATTERN.test(value["reasonCode"]) ||
    typeof value["completedAtMs"] !== "number" ||
    !Number.isSafeInteger(value["completedAtMs"]) ||
    value["completedAtMs"] < 0 ||
    (value["exitCode"] !== undefined &&
      (typeof value["exitCode"] !== "number" ||
        !Number.isSafeInteger(value["exitCode"]) ||
        value["exitCode"] < 0)) ||
    (value["processSignal"] !== undefined &&
      (typeof value["processSignal"] !== "string" ||
        value["processSignal"].length === 0 ||
        value["processSignal"].length > 64))
  ) {
    throw corrupt();
  }
  return Object.freeze({
    commandId: value["commandId"],
    actionCategory: value["actionCategory"],
    actionFingerprint: value["actionFingerprint"] as `sha256:${string}`,
    outcome: value["outcome"],
    reasonCode: value["reasonCode"],
    ...(value["exitCode"] === undefined ? {} : { exitCode: value["exitCode"] }),
    ...(value["processSignal"] === undefined ? {} : { processSignal: value["processSignal"] }),
    completedAtMs: value["completedAtMs"],
  });
}

function validateStateRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === parse(value).root ||
    value.includes("\0")
  ) {
    throw invalidConfiguration();
  }
  return value;
}

function isActionCategory(value: unknown): value is PlatformMutationActionCategory {
  return (
    typeof value === "string" && ACTION_CATEGORIES.has(value as PlatformMutationActionCategory)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function corrupt(cause?: unknown): PlatformMutationJournalError {
  return new PlatformMutationJournalError(
    "MUTATION_JOURNAL_CORRUPT",
    "The durable platform mutation journal is corrupt.",
    cause === undefined ? undefined : { cause },
  );
}

function invalidConfiguration(): PlatformMutationJournalError {
  return new PlatformMutationJournalError(
    "MUTATION_JOURNAL_INVALID_CONFIGURATION",
    "The durable platform mutation journal configuration is invalid.",
  );
}
