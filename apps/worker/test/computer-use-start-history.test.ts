import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SqliteComputerUseStartHistory,
  SqliteComputerUseStartHistoryError,
} from "../src/computer-use-start-history.ts";

const first = {
  commandId: "computer-use:start:task-1:run-1:9",
  startFingerprint: `sha256:${"a".repeat(64)}` as const,
  executionHandleId: "cu_1234567890abcdef",
  recordedAtMs: 1_000,
};

test("Computer Use start claims survive restart and reject command reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-cu-start-"));
  const filename = join(root, "computer-use-start.sqlite3");
  try {
    const initial = new SqliteComputerUseStartHistory({
      filename,
      sourceCheckoutDirectory: process.cwd(),
    });
    assert.deepEqual(await initial.claim(first), {
      disposition: "created",
      record: first,
    });
    initial.close();

    const restarted = new SqliteComputerUseStartHistory({
      filename,
      sourceCheckoutDirectory: process.cwd(),
    });
    assert.deepEqual(await restarted.claim({ ...first, recordedAtMs: 2_000 }), {
      disposition: "replay",
      record: first,
    });
    const conflict = await restarted.claim({
      ...first,
      startFingerprint: `sha256:${"b".repeat(64)}`,
      recordedAtMs: 3_000,
    });
    assert.equal(conflict.disposition, "conflict");
    assert.deepEqual(conflict.record, first);
    assert.deepEqual(
      await restarted.claim({
        ...first,
        commandId: "computer-use:start:task-1:run-2:10",
        startFingerprint: `sha256:${"c".repeat(64)}`,
        executionHandleId: "cu_fresh",
        recordedAtMs: 4_000,
      }),
      {
        disposition: "created",
        record: {
          ...first,
          commandId: "computer-use:start:task-1:run-2:10",
          startFingerprint: `sha256:${"c".repeat(64)}`,
          executionHandleId: "cu_fresh",
          recordedAtMs: 4_000,
        },
      },
    );
    restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Computer Use start history rejects checkout paths, corrupt state, and invalid records", async () => {
  assert.throws(
    () =>
      new SqliteComputerUseStartHistory({
        filename: join(process.cwd(), ".unsafe-computer-use-start.sqlite3"),
        sourceCheckoutDirectory: process.cwd(),
      }),
    hasCode("INVALID_RUNTIME_PATH"),
  );

  const root = await mkdtemp(join(tmpdir(), "opendelegate-cu-corrupt-"));
  const filename = join(root, "computer-use-start.sqlite3");
  await writeFile(filename, "not a sqlite database");
  try {
    assert.throws(
      () =>
        new SqliteComputerUseStartHistory({
          filename,
          sourceCheckoutDirectory: process.cwd(),
        }),
      hasCode("STATE_CORRUPT"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const validRoot = await mkdtemp(join(tmpdir(), "opendelegate-cu-invalid-"));
  const history = new SqliteComputerUseStartHistory({
    filename: join(validRoot, "computer-use-start.sqlite3"),
    sourceCheckoutDirectory: process.cwd(),
  });
  try {
    await assert.rejects(
      history.claim({ ...first, startFingerprint: "not-a-fingerprint" as `sha256:${string}` }),
      hasCode("INVALID_INPUT"),
    );
  } finally {
    history.close();
    await rm(validRoot, { recursive: true, force: true });
  }
});

function hasCode(code: SqliteComputerUseStartHistoryError["code"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SqliteComputerUseStartHistoryError && error.code === code;
}
