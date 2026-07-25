import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeServiceCommandJournal,
  createNodeNativeServiceJournalAtomicBoundary,
  type ServiceCommandJournalEntry,
  type ServicePlanExecutionReport,
} from "../src/index.ts";

test("the production journal boundary durably replays a terminal command", async (context) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "opendelegate-native-journal-"));
  context.after(async () => {
    await rm(stateRoot, { force: true, recursive: true });
  });
  const boundary = createNodeNativeServiceJournalAtomicBoundary();
  const entry: ServiceCommandJournalEntry = {
    commandId: "service-command-production-0001",
    planFingerprint: `sha256:${"a".repeat(64)}`,
    operation: "start",
    platform: "windows",
    instanceId: "personal",
  };
  const report: ServicePlanExecutionReport = {
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
      summary: "The native service command completed.",
    },
  };
  const journal = createNativeServiceCommandJournal({ stateRoot, boundary });

  assert.deepEqual(await journal.claim(entry), { disposition: "claimed" });
  await journal.complete({ ...entry, report });

  const reopened = createNativeServiceCommandJournal({ stateRoot, boundary });
  assert.deepEqual(await reopened.claim(entry), {
    disposition: "completed",
    planFingerprint: entry.planFingerprint,
    report,
  });
});
