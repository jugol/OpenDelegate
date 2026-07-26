import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  NativeServiceCommandJournalError,
  createNativeServiceCommandJournal,
  type NativeServiceJournalAtomicBoundary,
} from "../src/native-service-journal.ts";
import type { ServicePlanExecutionReport } from "../src/plan-executor.ts";
import type { ServiceCommandJournalEntry } from "../src/service-command.ts";

const FIRST_FINGERPRINT = `sha256:${"1".repeat(64)}`;
const SECOND_FINGERPRINT = `sha256:${"2".repeat(64)}`;

class FakeAtomicBoundary implements NativeServiceJournalAtomicBoundary {
  readonly files = new Map<string, Buffer>();
  readonly ensuredDirectories = new Map<string, number>();
  readonly writes: Array<{
    readonly path: string;
    readonly bytes: Buffer;
    readonly mode: number;
  }> = [];
  failNextLock = false;
  failNextWrite = false;
  maximumConcurrentLocks = 0;

  private readonly lockTails = new Map<string, Promise<void>>();
  private activeLocks = 0;

  async ensureDirectory(path: string, mode: number): Promise<void> {
    this.ensuredDirectories.set(path, mode);
  }

  async withExclusiveLock<Result>(
    lockPath: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const preceding = this.lockTails.get(lockPath) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    const tail = preceding.then(() => held);
    this.lockTails.set(lockPath, tail);
    await preceding;
    if (this.failNextLock) {
      this.failNextLock = false;
      release();
      throw new Error("injected lock failure");
    }
    this.activeLocks += 1;
    this.maximumConcurrentLocks = Math.max(this.maximumConcurrentLocks, this.activeLocks);
    try {
      await Promise.resolve();
      return await operation();
    } finally {
      this.activeLocks -= 1;
      release();
      if (this.lockTails.get(lockPath) === tail) {
        this.lockTails.delete(lockPath);
      }
    }
  }

  async readFile(path: string, maximumBytes: number): Promise<Buffer | undefined> {
    const bytes = this.files.get(path);
    if (bytes !== undefined && bytes.length > maximumBytes) {
      throw new Error("injected bounded-read overflow");
    }
    return bytes === undefined ? undefined : Buffer.from(bytes);
  }

  async writeFileAtomic(path: string, bytes: Buffer, mode: number): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected atomic write failure");
    }
    const copy = Buffer.from(bytes);
    this.files.set(path, copy);
    this.writes.push({ path, bytes: copy, mode });
  }
}

test("concurrent claims serialize through one cross-process lock and create one durable claim", async () => {
  const boundary = new FakeAtomicBoundary();
  const first = createJournal(boundary);
  const second = createJournal(boundary);
  const entry = claimedEntry();

  const claims = await Promise.all([first.claim(entry), second.claim(entry)]);

  assert.deepEqual(claims.map((claim) => claim.disposition).sort(), ["claimed", "in-progress"]);
  assert.equal(boundary.maximumConcurrentLocks, 1);
  assert.equal(boundary.writes.length, 1);
  assert.equal(boundary.ensuredDirectories.get(first.directoryPath), 0o700);
  assert.match(
    first.journalPath,
    /platform-services[\\/]native-service-command-journal\.v1\.json$/u,
  );
  assert.equal(first.lockPath, `${first.journalPath}.lock`);
  assert.equal(boundary.writes[0]?.mode, 0o600);
});

test("a crash after claim remains durably in progress and is never reclaimed automatically", async () => {
  const boundary = new FakeAtomicBoundary();
  const beforeCrash = createJournal(boundary);
  assert.deepEqual(await beforeCrash.claim(claimedEntry()), {
    disposition: "claimed",
  });

  const afterRestart = createJournal(boundary);
  assert.deepEqual(await afterRestart.claim(claimedEntry()), {
    disposition: "in-progress",
    planFingerprint: FIRST_FINGERPRINT,
  });
  assert.equal(boundary.writes.length, 1);
});

test("completion is committed atomically and exact completion or claim replay is side-effect free", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  const entry = claimedEntry();
  const report = successfulReport(entry);

  await journal.claim(entry);
  await journal.complete({ ...entry, report });
  const writesAfterCompletion = boundary.writes.length;
  await journal.complete({ ...entry, report });

  const replay = await createJournal(boundary).claim(entry);
  assert.equal(replay.disposition, "completed");
  if (replay.disposition !== "completed") {
    assert.fail("Expected a completed replay.");
  }
  assert.deepEqual(replay.report, report);
  assert.equal(boundary.writes.length, writesAfterCompletion);
});

test("the durable journal accepts and replays the narrow reconfigure operation", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  const entry: ServiceCommandJournalEntry = {
    ...claimedEntry(),
    operation: "reconfigure",
  };
  const report = successfulReport(entry);

  assert.deepEqual(await journal.claim(entry), { disposition: "claimed" });
  await journal.complete({ ...entry, report });
  const replay = await createJournal(boundary).claim(entry);

  assert.equal(replay.disposition, "completed");
  if (replay.disposition === "completed") {
    assert.equal(replay.report.operation, "reconfigure");
  }
});

test("a reused command ID exposes the original fingerprint and conflicting completion fails closed", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  const original = claimedEntry();
  await journal.claim(original);

  assert.deepEqual(
    await journal.claim({
      ...original,
      planFingerprint: SECOND_FINGERPRINT,
      operation: "stop",
    }),
    {
      disposition: "in-progress",
      planFingerprint: FIRST_FINGERPRINT,
    },
  );
  await assert.rejects(
    journal.complete({
      ...original,
      planFingerprint: SECOND_FINGERPRINT,
      report: successfulReport(original),
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_CONFLICT"),
  );
  assert.equal(boundary.writes.length, 1);
});

test("a completed outcome cannot be replaced by a different terminal report", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  const entry = claimedEntry();
  const report = successfulReport(entry);
  await journal.claim(entry);
  await journal.complete({ ...entry, report });

  await assert.rejects(
    journal.complete({
      ...entry,
      report: {
        ...report,
        diagnostic: {
          ...report.diagnostic,
          summary: "A different terminal outcome.",
        },
      },
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_CONFLICT"),
  );
});

test("strict loading rejects invalid JSON, unknown fields, duplicate IDs, and malformed reports without repair", async () => {
  const corruptDocuments = [
    Buffer.from("{not-json", "utf8"),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        entries: [],
        secret: "must-not-be-accepted",
      }),
      "utf8",
    ),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        entries: [storedPendingEntry(), storedPendingEntry()],
      }),
      "utf8",
    ),
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            ...storedPendingEntry(),
            state: "completed",
            report: {
              ...successfulReport(claimedEntry()),
              diagnostic: {
                eventName: "platform.service.operation.failed",
                summary: "Mismatched with the succeeded outcome.",
              },
            },
          },
        ],
      }),
      "utf8",
    ),
  ];

  for (const document of corruptDocuments) {
    const boundary = new FakeAtomicBoundary();
    const journal = createJournal(boundary);
    boundary.files.set(journal.journalPath, document);

    await assert.rejects(
      journal.claim(claimedEntry()),
      isJournalError("NATIVE_SERVICE_JOURNAL_CORRUPT"),
    );
    assert.equal(boundary.writes.length, 0);
    assert.deepEqual(boundary.files.get(journal.journalPath), document);
  }
});

test("entry and byte limits fail closed without evicting replay history", async () => {
  const boundary = new FakeAtomicBoundary();
  const oneEntry = createJournal(boundary, {
    maximumEntries: 1,
    maximumBytes: 4_096,
  });
  await oneEntry.claim(claimedEntry());
  const persisted = Buffer.from(boundary.files.get(oneEntry.journalPath) ?? []);

  await assert.rejects(
    oneEntry.claim({
      ...claimedEntry(),
      commandId: "service-command-0002",
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED"),
  );
  assert.deepEqual(boundary.files.get(oneEntry.journalPath), persisted);

  const byteBoundary = new FakeAtomicBoundary();
  const byteLimited = createJournal(byteBoundary, {
    maximumEntries: 10,
    maximumBytes: 1_024,
  });
  const byteEntry = claimedEntry();
  await byteLimited.claim(byteEntry);
  const pendingBytes = Buffer.from(byteBoundary.files.get(byteLimited.journalPath) ?? []);
  await assert.rejects(
    byteLimited.complete({
      ...byteEntry,
      report: {
        ...successfulReport(byteEntry),
        diagnostic: {
          eventName: "platform.service.operation.succeeded",
          summary: "x".repeat(900),
        },
      },
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_CAPACITY_EXCEEDED"),
  );
  assert.deepEqual(byteBoundary.files.get(byteLimited.journalPath), pendingBytes);
  assert.deepEqual(await byteLimited.claim(byteEntry), {
    disposition: "in-progress",
    planFingerprint: FIRST_FINGERPRINT,
  });
});

test("unknown input fields and diagnostic secret material are rejected before persistence", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);

  await assert.rejects(
    journal.claim({
      ...claimedEntry(),
      secret: "do-not-store",
    } as ServiceCommandJournalEntry),
    isJournalError("NATIVE_SERVICE_JOURNAL_INVALID_ENTRY"),
  );
  await journal.claim(claimedEntry());
  await assert.rejects(
    journal.complete({
      ...claimedEntry(),
      report: {
        ...successfulReport(claimedEntry()),
        diagnostic: {
          eventName: "platform.service.operation.succeeded",
          summary: "authorization=Bearer should-never-be-durable",
        },
      },
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_INVALID_ENTRY"),
  );
  assert.doesNotMatch(
    boundary.files.get(journal.journalPath)?.toString("utf8") ?? "",
    /authorization|Bearer|do-not-store/u,
  );
});

test("lock and atomic-write failures are surfaced as unavailable without a phantom claim", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  boundary.failNextLock = true;
  await assert.rejects(
    journal.claim(claimedEntry()),
    isJournalError("NATIVE_SERVICE_JOURNAL_UNAVAILABLE"),
  );
  assert.equal(boundary.files.has(journal.journalPath), false);

  boundary.failNextWrite = true;
  await assert.rejects(
    journal.claim(claimedEntry()),
    isJournalError("NATIVE_SERVICE_JOURNAL_UNAVAILABLE"),
  );
  assert.equal(boundary.files.has(journal.journalPath), false);
  assert.deepEqual(await journal.claim(claimedEntry()), {
    disposition: "claimed",
  });
});

test("a completion write failure preserves the durable in-progress state for explicit recovery", async () => {
  const boundary = new FakeAtomicBoundary();
  const journal = createJournal(boundary);
  const entry = claimedEntry();
  await journal.claim(entry);
  const pendingBytes = Buffer.from(boundary.files.get(journal.journalPath) ?? []);
  boundary.failNextWrite = true;

  await assert.rejects(
    journal.complete({
      ...entry,
      report: successfulReport(entry),
    }),
    isJournalError("NATIVE_SERVICE_JOURNAL_UNAVAILABLE"),
  );
  assert.deepEqual(boundary.files.get(journal.journalPath), pendingBytes);
  assert.deepEqual(await createJournal(boundary).claim(entry), {
    disposition: "in-progress",
    planFingerprint: FIRST_FINGERPRINT,
  });
});

function createJournal(
  boundary: FakeAtomicBoundary,
  limits?: {
    readonly maximumBytes: number;
    readonly maximumEntries: number;
  },
) {
  return createNativeServiceCommandJournal({
    stateRoot: join(tmpdir(), "opendelegate-native-service-journal-tests"),
    boundary,
    ...(limits === undefined ? {} : { limits }),
  });
}

function claimedEntry(): ServiceCommandJournalEntry {
  return {
    commandId: "service-command-0001",
    planFingerprint: FIRST_FINGERPRINT,
    operation: "start",
    platform: "windows",
    instanceId: "personal",
  };
}

function storedPendingEntry() {
  return {
    ...claimedEntry(),
    state: "in-progress",
  };
}

function successfulReport(entry: ServiceCommandJournalEntry): ServicePlanExecutionReport {
  return {
    outcome: "succeeded",
    operation: entry.operation,
    platform: entry.platform,
    instanceId: entry.instanceId,
    completedStepIds: ["start-core"],
    unchangedStepIds: [],
    rollback: {
      attempted: false,
      completedStepIds: [],
      failures: [],
    },
    diagnostic: {
      eventName: "platform.service.operation.succeeded",
      summary: "The native service operation completed successfully.",
    },
  };
}

function isJournalError(code: NativeServiceCommandJournalError["code"]) {
  return (error: unknown): boolean =>
    error instanceof NativeServiceCommandJournalError && error.code === code;
}
