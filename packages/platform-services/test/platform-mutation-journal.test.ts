import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createNativePlatformMutationJournal,
  createNodeNativeServiceJournalAtomicBoundary,
  type PlatformMutationReceipt,
} from "../src/index.ts";

test("the native mutation journal preserves completion and exact replay across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-mutation-journal-"));
  try {
    const boundary = createNodeNativeServiceJournalAtomicBoundary();
    const first = createNativePlatformMutationJournal({ stateRoot: root, boundary });
    const actionFingerprint = `sha256:${"a".repeat(64)}` as const;
    assert.deepEqual(
      await first.claim({
        commandId: "command-package-1001",
        actionCategory: "configured-official-package-install",
        actionFingerprint,
      }),
      { disposition: "claimed" },
    );
    const receipt: PlatformMutationReceipt = {
      commandId: "command-package-1001",
      actionCategory: "configured-official-package-install",
      actionFingerprint,
      outcome: "succeeded",
      reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
      exitCode: 0,
      completedAtMs: 15_000,
    };
    await first.complete({
      commandId: receipt.commandId,
      actionFingerprint,
      receipt,
    });

    const afterRestart = createNativePlatformMutationJournal({ stateRoot: root, boundary });
    assert.deepEqual(
      await afterRestart.claim({
        commandId: "command-package-1001",
        actionCategory: "configured-official-package-install",
        actionFingerprint,
      }),
      { disposition: "completed", receipt },
    );
    assert.doesNotMatch(await readFile(afterRestart.journalPath, "utf8"), /git|ripgrep|token/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the native mutation journal makes unfinished and conflicting commands fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-mutation-journal-"));
  try {
    const boundary = createNodeNativeServiceJournalAtomicBoundary();
    const first = createNativePlatformMutationJournal({ stateRoot: root, boundary });
    await first.claim({
      commandId: "command-firewall-1001",
      actionCategory: "firewall-change",
      actionFingerprint: `sha256:${"b".repeat(64)}`,
    });

    const afterRestart = createNativePlatformMutationJournal({ stateRoot: root, boundary });
    assert.deepEqual(
      await afterRestart.claim({
        commandId: "command-firewall-1001",
        actionCategory: "firewall-change",
        actionFingerprint: `sha256:${"b".repeat(64)}`,
      }),
      { disposition: "in-progress" },
    );
    assert.deepEqual(
      await afterRestart.claim({
        commandId: "command-firewall-1001",
        actionCategory: "firewall-change",
        actionFingerprint: `sha256:${"c".repeat(64)}`,
      }),
      { disposition: "conflict" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed tombstones compact only after retention while unfinished work still blocks capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-mutation-journal-"));
  try {
    let now = 120_000;
    const boundary = createNodeNativeServiceJournalAtomicBoundary();
    const journal = createNativePlatformMutationJournal({
      stateRoot: root,
      boundary,
      clock: { now: () => now },
      completedRetentionMs: 60_000,
      maximumEntries: 2,
    });
    const firstFingerprint = `sha256:${"d".repeat(64)}` as const;
    await journal.claim({
      commandId: "command-package-old-1001",
      actionCategory: "configured-official-package-install",
      actionFingerprint: firstFingerprint,
    });
    await journal.complete({
      commandId: "command-package-old-1001",
      actionFingerprint: firstFingerprint,
      receipt: {
        commandId: "command-package-old-1001",
        actionCategory: "configured-official-package-install",
        actionFingerprint: firstFingerprint,
        outcome: "succeeded",
        reasonCode: "POLICY_TRUSTED_PACKAGE_INSTALL",
        exitCode: 0,
        completedAtMs: 50_000,
      },
    });
    assert.deepEqual(await journal.inspect(), {
      entryCount: 1,
      inProgressCount: 0,
      completedCount: 1,
      compactionEligibleCount: 1,
      maximumEntries: 2,
      status: "ready",
    });
    await journal.claim({
      commandId: "command-network-live-1002",
      actionCategory: "vpn-change",
      actionFingerprint: `sha256:${"e".repeat(64)}`,
    });

    assert.deepEqual(await journal.inspect(), {
      entryCount: 1,
      inProgressCount: 1,
      completedCount: 0,
      compactionEligibleCount: 0,
      maximumEntries: 2,
      status: "near-capacity",
    });
    assert.deepEqual(
      await journal.claim({
        commandId: "command-package-new-1003",
        actionCategory: "project-dependency-install",
        actionFingerprint: `sha256:${"f".repeat(64)}`,
      }),
      { disposition: "claimed" },
    );
    const stored = JSON.parse(await readFile(journal.journalPath, "utf8")) as {
      readonly entries: readonly { readonly commandId: string }[];
    };
    assert.deepEqual(
      stored.entries.map((entry) => entry.commandId),
      ["command-network-live-1002", "command-package-new-1003"],
    );
    assert.deepEqual(await journal.inspect(), {
      entryCount: 2,
      inProgressCount: 2,
      completedCount: 0,
      compactionEligibleCount: 0,
      maximumEntries: 2,
      status: "blocked",
    });

    now += 60_000;
    await assert.rejects(
      journal.claim({
        commandId: "command-firewall-new-1004",
        actionCategory: "firewall-change",
        actionFingerprint: `sha256:${"1".repeat(64)}`,
      }),
      { code: "MUTATION_JOURNAL_CAPACITY_EXCEEDED" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
