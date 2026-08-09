import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  DiscordAdapterError,
  type DiscordOutboxAction,
  type DiscordStateRepository,
} from "@opendelegate/discord-adapter";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlDiscordStateRepository, SqlStorageError, type SqlMigrationMode } from "../src/index.ts";

interface DiscordRepositoryFixture {
  readonly filename?: string;
  open(mode: SqlMigrationMode): Promise<SqlDiscordStateRepository>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<DiscordRepositoryFixture>;

function registerDiscordRepositoryContract(label: string, createFixture: FixtureFactory): void {
  describe(`${label} Discord state repository contract`, () => {
    test("persists only monotonic Gateway cursor progress across restart", async () => {
      const fixture = await createFixture();
      let repository: SqlDiscordStateRepository | undefined;
      try {
        repository = await fixture.open("apply");
        await repository.saveGatewayCursor({
          sessionId: "session-a",
          resumeGatewayUrl: "wss://resume-a.discord.gg",
          sequence: 10,
          updatedAtMs: 1_000,
        });
        await repository.saveGatewayCursor({
          sessionId: "session-a",
          resumeGatewayUrl: "wss://stale.discord.gg",
          sequence: 9,
          updatedAtMs: 1_100,
        });
        await repository.saveGatewayCursor({
          sessionId: "session-b",
          resumeGatewayUrl: "wss://too-old.discord.gg",
          sequence: 1,
          updatedAtMs: 999,
        });
        assert.deepEqual(await repository.getGatewayCursor(), {
          sessionId: "session-a",
          resumeGatewayUrl: "wss://resume-a.discord.gg",
          sequence: 10,
          updatedAtMs: 1_000,
        });

        await repository.close();
        repository = await fixture.open("verify");
        await repository.saveGatewayCursor({
          sessionId: "session-b",
          resumeGatewayUrl: "wss://resume-b.discord.gg",
          sequence: 1,
          updatedAtMs: 1_001,
        });
        assert.equal((await repository.getGatewayCursor())?.sessionId, "session-b");
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("inbox claims are digest-idempotent and completion is terminal", async () => {
      const fixture = await createFixture();
      let repository: SqlDiscordStateRepository | undefined;
      try {
        repository = await fixture.open("apply");
        const first = await repository.claimInbound({
          key: "discord-interaction:100000000000000001",
          digest: `sha256:${"a".repeat(64)}`,
          nowMs: 1_000,
        });
        assert.equal(first.outcome, "new");
        assert.equal(
          (
            await repository.claimInbound({
              key: first.record.key,
              digest: first.record.digest,
              nowMs: 1_001,
            })
          ).outcome,
          "pending",
        );
        await assert.rejects(
          repository.claimInbound({
            key: first.record.key,
            digest: `sha256:${"b".repeat(64)}`,
            nowMs: 1_001,
          }),
          hasDiscordCode("IDEMPOTENCY_CONFLICT"),
        );

        const acknowledged = await repository.acknowledgeInbound({
          key: first.record.key,
          responseRef: "discord-interaction-ref:opaque-reference",
          nowMs: 1_002,
        });
        assert.equal(acknowledged.acknowledged, true);
        assert.deepEqual(
          await repository.acknowledgeInbound({
            key: first.record.key,
            responseRef: "discord-interaction-ref:opaque-reference",
            nowMs: 1_003,
          }),
          acknowledged,
        );
        await repository.completeInbound({ key: first.record.key, nowMs: 1_004 });
        await repository.completeInbound({ key: first.record.key, nowMs: 1_005 });
        assert.equal(
          (
            await repository.claimInbound({
              key: first.record.key,
              digest: first.record.digest,
              nowMs: 1_006,
            })
          ).outcome,
          "completed",
        );
        await assert.rejects(
          repository.acknowledgeInbound({
            key: first.record.key,
            responseRef: "discord-interaction-ref:different-reference",
            nowMs: 1_007,
          }),
          hasDiscordCode("PERSISTENCE_CONFLICT"),
        );

        await repository.close();
        repository = await fixture.open("verify");
        assert.equal(
          (
            await repository.claimInbound({
              key: first.record.key,
              digest: first.record.digest,
              nowMs: 2_000,
            })
          ).outcome,
          "completed",
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("Task bindings are one-to-one, revisioned, monotonic, and deletion is terminal", async () => {
      const fixture = await createFixture();
      const repository = await fixture.open("apply");
      try {
        const created = await repository.bindTask({
          guildId: "100000000000000001",
          forumChannelId: "100000000000000002",
          threadId: "100000000000000003",
          starterMessageId: "100000000000000003",
          taskId: "task-1",
          externalState: "available",
          archived: false,
          locked: false,
        });
        assert.equal(created.revision, 1);
        assert.deepEqual(
          await repository.bindTask({
            guildId: created.guildId,
            forumChannelId: created.forumChannelId,
            threadId: created.threadId,
            starterMessageId: created.starterMessageId,
            taskId: created.taskId,
            externalState: "inaccessible",
            archived: true,
            locked: true,
          }),
          created,
        );
        await assert.rejects(
          repository.bindTask({
            guildId: created.guildId,
            forumChannelId: created.forumChannelId,
            threadId: "100000000000000004",
            starterMessageId: "100000000000000004",
            taskId: created.taskId,
            externalState: "available",
            archived: false,
            locked: false,
          }),
          hasDiscordCode("PERSISTENCE_CONFLICT"),
        );

        const reconciled = await repository.updateBinding(created.threadId, {
          lastReconciledMessageId: "100000000000000100",
          archived: true,
        });
        assert.equal(reconciled.revision, 2);
        const idempotent = await repository.updateBinding(created.threadId, {
          lastReconciledMessageId: "100000000000000100",
          archived: true,
        });
        assert.equal(idempotent.revision, 2);
        const panel = await repository.updateBinding(created.threadId, {
          statusPanelMessageId: "100000000000000101",
        });
        const replacedPanel = await repository.updateBinding(created.threadId, {
          statusPanelMessageId: "100000000000000102",
        });
        assert.equal(replacedPanel.statusPanelMessageId, "100000000000000102");
        assert.equal(replacedPanel.revision, panel.revision + 1);
        const activity = await repository.updateBinding(created.threadId, {
          activitySurface: {
            cycleId: "activity_cycle_1",
            revision: 7,
            updatedAtMs: 7_000,
            outboxCreatedAtMs: 7_100,
            state: "open",
            messageId: "100000000000000103",
          },
        });
        assert.deepEqual(activity.activitySurface, {
          cycleId: "activity_cycle_1",
          revision: 7,
          updatedAtMs: 7_000,
          outboxCreatedAtMs: 7_100,
          state: "open",
          messageId: "100000000000000103",
        });
        const failure = await repository.updateBinding(created.threadId, {
          failureSurface: {
            requestKey: "failure-projection:03-update",
            sourceEventId: "event_failure_before_retry",
            messageId: "100000000000000104",
            outboxCreatedAtMs: 7_200,
            state: "open",
          },
        });
        assert.deepEqual(failure.failureSurface, {
          requestKey: "failure-projection:03-update",
          sourceEventId: "event_failure_before_retry",
          messageId: "100000000000000104",
          outboxCreatedAtMs: 7_200,
          state: "open",
        });
        assert.deepEqual(
          (await repository.getBindingByThread(created.threadId))?.failureSurface,
          failure.failureSurface,
        );
        const closedActivity = await repository.updateBinding(created.threadId, {
          activitySurface: {
            cycleId: "activity_cycle_1",
            revision: 8,
            updatedAtMs: 8_000,
            outboxCreatedAtMs: 8_100,
            state: "closed",
          },
        });
        assert.deepEqual(closedActivity.activitySurface, {
          cycleId: "activity_cycle_1",
          revision: 8,
          updatedAtMs: 8_000,
          outboxCreatedAtMs: 8_100,
          state: "closed",
        });
        await assert.rejects(
          repository.updateBinding(created.threadId, {
            lastReconciledMessageId: "100000000000000099",
          }),
          hasDiscordCode("PERSISTENCE_CONFLICT"),
        );

        const deleted = await repository.updateBinding(created.threadId, {
          externalState: "deleted",
        });
        assert.equal(deleted.externalState, "deleted");
        await assert.rejects(
          repository.updateBinding(created.threadId, {
            externalState: "available",
          }),
          hasDiscordCode("PERSISTENCE_CONFLICT"),
        );
      } finally {
        await repository.close();
        await fixture.cleanup();
      }
    });

    test("outbox leases reclaim safely and retry or completion commands replay exactly once", async () => {
      const fixture = await createFixture();
      let repository: SqlDiscordStateRepository | undefined;
      try {
        repository = await fixture.open("apply");
        await repository.enqueueOutbox(outbox("outbox-1", 1_000, taskCommand("pause")));
        await repository.enqueueOutbox(outbox("outbox-2", 1_001, taskCommand("resume")));
        await repository.enqueueOutbox(outbox("outbox-1", 9_999, taskCommand("pause")));
        await assert.rejects(
          repository.enqueueOutbox(outbox("outbox-1", 1_000, taskCommand("cancel"))),
          hasDiscordCode("IDEMPOTENCY_CONFLICT"),
        );

        const claimed = await repository.claimReadyOutbox({
          owner: "dispatcher-a",
          nowMs: 1_001,
          leaseMs: 100,
          limit: 1,
        });
        assert.deepEqual(
          claimed.map((item) => item.id),
          ["outbox-1"],
        );
        assert.equal(claimed[0]?.leaseExpiresAtMs, 1_101);
        assert.deepEqual(
          await repository.claimReadyOutbox({
            owner: "dispatcher-b",
            nowMs: 1_050,
            leaseMs: 100,
            limit: 10,
          }),
          [
            {
              ...(await repository.listOutbox()).find((item) => item.id === "outbox-2"),
              leaseOwner: "dispatcher-b",
              leaseExpiresAtMs: 1_150,
            },
          ],
        );

        await repository.retryOutbox({
          id: "outbox-1",
          owner: "dispatcher-a",
          notBeforeMs: 1_200,
          errorCode: "RATE_LIMIT",
        });
        await repository.retryOutbox({
          id: "outbox-1",
          owner: "dispatcher-a",
          notBeforeMs: 1_200,
          errorCode: "RATE_LIMIT",
        });
        assert.equal((await repository.listOutbox())[0]?.attempts, 1);

        await repository.completeOutbox({ id: "outbox-2", owner: "dispatcher-b" });
        await repository.completeOutbox({ id: "outbox-2", owner: "dispatcher-b" });
        assert.equal((await repository.listOutbox())[1]?.attempts, 1);
        assert.equal((await repository.listOutbox())[1]?.delivered, true);

        await repository.close();
        repository = await fixture.open("verify");
        assert.deepEqual(
          (
            await repository.claimReadyOutbox({
              owner: "dispatcher-c",
              nowMs: 1_199,
              leaseMs: 100,
              limit: 10,
            })
          ).map((item) => item.id),
          [],
        );
        assert.deepEqual(
          (
            await repository.claimReadyOutbox({
              owner: "dispatcher-c",
              nowMs: 1_200,
              leaseMs: 100,
              limit: 10,
            })
          ).map((item) => item.id),
          ["outbox-1"],
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

registerDiscordRepositoryContract("SQLite", createSqliteFixture);

test("SQLite Discord schema has no credential column and stores only the opaque interaction reference", async () => {
  const fixture = await createSqliteFixture();
  const repository = await fixture.open("apply");
  const rawToken = "raw-interaction-token-must-not-persist";
  try {
    await repository.enqueueOutbox(
      outbox("outbox-secret-check", 1_000, {
        kind: "task-command",
        taskId: "task-1",
        principalId: "discord:100000000000000001",
        command: "pause",
        idempotencyKey: "discord-interaction:100000000000000002",
        responseRef: "discord-interaction-ref:opaque-reference",
      }),
    );
    await repository.close();

    const sqlite = new Database(fixture.filename, { readonly: true });
    try {
      const tables = sqlite
        .prepare(
          `SELECT name
             FROM sqlite_master
            WHERE type = 'table'
              AND name LIKE 'od_discord_%'
            ORDER BY name`,
        )
        .all() as { name: string }[];
      const columns = tables.flatMap(({ name: tableName }) =>
        (
          sqlite
            .prepare(
              `SELECT name
                 FROM pragma_table_info(?)
                ORDER BY cid`,
            )
            .all(tableName) as { name: string }[]
        ).map(({ name }) => ({ name, tableName })),
      );
      assert.equal(
        columns.some(({ name }) => /token|credential|secret/iu.test(name)),
        false,
      );
      const stored = JSON.stringify(
        sqlite.prepare("SELECT * FROM od_discord_outbox").all() as unknown,
      );
      assert.equal(stored.includes(rawToken), false);
      assert.equal(stored.includes("discord-interaction-ref:opaque-reference"), true);
    } finally {
      sqlite.close();
    }
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});

test("SQLite persists a durable Discord failure-resolution action across restart", async () => {
  const fixture = await createSqliteFixture();
  let repository: SqlDiscordStateRepository | undefined;
  const action: DiscordOutboxAction = {
    kind: "resolve-task-failure",
    taskId: "task-1",
    failureRequestKey: "failure-projection:03-update",
    projection: {
      taskId: "task-1",
      state: "failed",
      objective: "Recover the Task.",
      summary: "The previous attempt stopped safely.",
      sourceEventId: "event_failure_before_retry",
      significance: "failure",
    },
  };
  try {
    repository = await fixture.open("apply");
    await repository.enqueueOutbox(outbox("resolve-failure", 1_000, action));
    await repository.close();
    repository = await fixture.open("verify");
    assert.deepEqual((await repository.listOutbox())[0]?.action, action);
  } finally {
    await repository?.close();
    await fixture.cleanup();
  }
});

test("SQLite rejects noncanonical or credential-shaped Discord outbox data before persistence", async () => {
  const fixture = await createSqliteFixture();
  const repository = await fixture.open("apply");
  try {
    await assert.rejects(
      repository.enqueueOutbox(
        outbox("outbox-raw-token", 1_000, {
          kind: "task-command",
          taskId: "task-1",
          principalId: "discord:100000000000000001",
          command: "pause",
          idempotencyKey: "discord-interaction:100000000000000002",
          responseRef: "MzAwMDAwMDAwMDAwMDAwMDAx.ABCDEF.abcdefghijklmnopqrstuvwxyz123456789",
        }),
      ),
      hasSqlCode("STORAGE_CONFIGURATION_INVALID"),
    );
    assert.deepEqual(await repository.listOutbox(), []);
  } finally {
    await repository.close();
    await fixture.cleanup();
  }
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerDiscordRepositoryContract("PostgreSQL", async () => {
    const schema = `od_discord_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
      open: (migrationMode) =>
        SqlDiscordStateRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
    };
  });
}

async function createSqliteFixture(): Promise<DiscordRepositoryFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-discord-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    filename,
    cleanup: () => rm(directory, { force: true, recursive: true }),
    open: (migrationMode) =>
      SqlDiscordStateRepository.openSqlite({
        filename,
        migrationMode,
      }),
  };
}

function outbox(
  id: string,
  createdAtMs: number,
  action: DiscordOutboxAction,
): Parameters<DiscordStateRepository["enqueueOutbox"]>[0] {
  return {
    id,
    action,
    createdAtMs,
    notBeforeMs: createdAtMs,
  };
}

function taskCommand(command: "pause" | "resume" | "cancel" | "retry"): DiscordOutboxAction {
  return {
    kind: "task-command",
    taskId: "task-1",
    principalId: "discord:100000000000000001",
    command,
    idempotencyKey: `discord-interaction:${command}`,
    responseRef: `discord-interaction-ref:${command}`,
  };
}

function hasDiscordCode(code: DiscordAdapterError["code"]) {
  return (error: unknown): boolean => error instanceof DiscordAdapterError && error.code === code;
}

function hasSqlCode(code: SqlStorageError["code"]) {
  return (error: unknown): boolean => error instanceof SqlStorageError && error.code === code;
}
