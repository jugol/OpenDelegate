import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  DeviceChannelRepositoryError,
  type DeviceChannelRepository,
  type MainDispatchFrameV1,
  type MainPingFrameV1,
  type WorkerPongFrameV1,
} from "@opendelegate/device-channel";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlDeviceChannelRepository, type SqlMigrationMode } from "../src/index.ts";

interface ChannelRepositoryFixture {
  open(mode: SqlMigrationMode): Promise<DeviceChannelRepository>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<ChannelRepositoryFixture>;

function registerDeviceChannelRepositoryContract(
  label: string,
  createFixture: FixtureFactory,
): void {
  describe(`${label} Device channel repository contract`, () => {
    test("persists ordered inbox and outbox state across restart", async () => {
      const fixture = await createFixture();
      let repository: DeviceChannelRepository | undefined;
      try {
        repository = await fixture.open("apply");
        await repository.observeConnection({
          certificateGeneration: 1,
          deviceId: "device-worker-1",
        });
        assert.deepEqual(await repository.commitInbound(workerPong(1)), {
          disposition: "accepted",
          acknowledgedWorkerSequence: 0,
        });
        assert.deepEqual(await repository.commitInbound(workerPong(1)), {
          disposition: "duplicate",
          acknowledgedWorkerSequence: 0,
        });
        assert.deepEqual(
          await repository.claimInboundEffect(workerPong(1), "claim-contract-failed"),
          {
            disposition: "claimed",
            acknowledgedSequence: 0,
          },
        );
        await repository.releaseInboundEffect(workerPong(1), "claim-contract-failed");
        assert.deepEqual(
          await repository.claimInboundEffect(workerPong(1), "claim-contract-complete"),
          {
            disposition: "claimed",
            acknowledgedSequence: 0,
          },
        );
        assert.deepEqual(
          await repository.completeInboundEffect(workerPong(1), "claim-contract-complete"),
          {
            acknowledgedSequence: 1,
          },
        );
        assert.deepEqual(await repository.commitInbound(workerPong(1)), {
          disposition: "duplicate",
          acknowledgedWorkerSequence: 1,
        });
        await assert.rejects(
          repository.commitInbound({
            ...workerPong(2),
            messageId: "worker-pong-1",
          }),
          hasChannelCode("CHANNEL_IDEMPOTENCY_CONFLICT"),
        );
        await assert.rejects(
          repository.commitInbound({
            ...workerPong(2),
            idempotencyKey: "worker-pong-1",
          }),
          hasChannelCode("CHANNEL_IDEMPOTENCY_CONFLICT"),
        );
        await assert.rejects(
          repository.commitInbound(workerPong(3)),
          hasChannelCode("CHANNEL_SEQUENCE_GAP"),
        );
        assert.deepEqual(await repository.commitInbound(workerPong(2)), {
          disposition: "accepted",
          acknowledgedWorkerSequence: 1,
        });
        assert.deepEqual(
          await repository.claimInboundEffect(workerPong(2), "claim-contract-restart"),
          {
            disposition: "claimed",
            acknowledgedSequence: 1,
          },
        );

        const [first, second] = await Promise.all([
          repository.enqueueOutbound("device-worker-1", (sequence) =>
            mainPing(sequence, `ping-${String(sequence)}`),
          ),
          repository.enqueueOutbound("device-worker-1", (sequence) =>
            mainPing(sequence, `ping-${String(sequence)}`),
          ),
        ]);
        assert.deepEqual(
          [first.sequence, second.sequence].toSorted((left, right) => left - right),
          [1, 2],
        );
        await repository.close();

        repository = await fixture.open("verify");
        assert.deepEqual(
          await repository.claimInboundEffect(workerPong(2), "claim-contract-recovered"),
          {
            disposition: "claimed",
            acknowledgedSequence: 1,
          },
        );
        assert.deepEqual(
          await repository.completeInboundEffect(workerPong(2), "claim-contract-recovered"),
          {
            acknowledgedSequence: 2,
          },
        );
        assert.deepEqual(
          (await repository.resume("device-worker-1")).pendingOutbound.map(
            (frame) => frame.sequence,
          ),
          [1, 2],
        );
        await assert.rejects(
          repository.acknowledgeOutbound({
            acknowledgedMainSequence: 2,
            acknowledgedMessageIds: ["main-ping-1", "wrong-message"],
            deviceId: "device-worker-1",
          }),
          hasChannelCode("CHANNEL_ACK_INVALID"),
        );
        await repository.acknowledgeOutbound({
          acknowledgedMainSequence: 1,
          acknowledgedMessageIds: ["main-ping-1"],
          deviceId: "device-worker-1",
        });
        assert.deepEqual(
          (await repository.resume("device-worker-1")).pendingOutbound.map(
            (frame) => frame.sequence,
          ),
          [2],
        );
        await repository.acknowledgeOutbound({
          acknowledgedMainSequence: 2,
          acknowledgedMessageIds: ["main-ping-2"],
          deviceId: "device-worker-1",
        });
        assert.deepEqual((await repository.resume("device-worker-1")).pendingOutbound, []);
        const dispatch = await repository.enqueueOutbound("device-worker-1", (sequence) =>
          mainDispatch(sequence),
        );
        await repository.acknowledgeOutbound({
          acknowledgedMainSequence: dispatch.sequence,
          acknowledgedMessageIds: [dispatch.messageId],
          deviceId: "device-worker-1",
        });
        assert.deepEqual(
          await repository.outboundByIdempotencyKey("device-worker-1", "dispatch:run-contract-1"),
          dispatch,
        );
        assert.equal(
          await repository.outboundByIdempotencyKey("device-worker-1", "main-ping-1"),
          undefined,
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("certificate generation, registration, closure, and frame validation fail closed", async () => {
      const fixture = await createFixture();
      const repository = await fixture.open("apply");
      try {
        await assert.rejects(
          repository.resume("unknown-worker"),
          hasChannelCode("CHANNEL_NOT_REGISTERED"),
        );
        await repository.observeConnection({
          certificateGeneration: 2,
          deviceId: "device-worker-2",
        });
        await repository.observeConnection({
          certificateGeneration: 3,
          deviceId: "device-worker-2",
        });
        await assert.rejects(
          repository.observeConnection({
            certificateGeneration: 2,
            deviceId: "device-worker-2",
          }),
          hasChannelCode("CHANNEL_GENERATION_STALE"),
        );
        await assert.rejects(
          repository.enqueueOutbound("device-worker-2", (sequence) =>
            mainPing(sequence + 1, "wrong-sequence"),
          ),
          hasChannelCode("CHANNEL_CONFIGURATION_INVALID"),
        );
      } finally {
        await repository.close();
        await fixture.cleanup();
      }
      await assert.rejects(
        repository.resume("device-worker-2"),
        hasChannelCode("CHANNEL_REPOSITORY_CLOSED"),
      );
    });
  });
}

registerDeviceChannelRepositoryContract("SQLite", createSqliteFixture);

test("SQLite migration backfills the pre-journal Device inbox as handled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-device-channel-upgrade-"));
  const filename = join(directory, "main.sqlite3");
  let repository: DeviceChannelRepository | undefined;
  try {
    repository = await SqlDeviceChannelRepository.openSqlite({
      filename,
      migrationMode: "apply",
    });
    await repository.observeConnection({
      certificateGeneration: 1,
      deviceId: "device-worker-1",
    });
    await repository.commitInbound(workerPong(1));
    await repository.close();
    repository = undefined;

    const legacy = new Database(filename);
    try {
      legacy.exec(`
        DROP TABLE od_device_observation_latest;
        DROP TABLE od_device_observation_events;
        DROP TABLE od_artifact_index_state;
        DROP TABLE od_action_authorizations;
        DROP TABLE od_approval_state;
        DROP TABLE od_configuration_state;
        DROP TABLE od_device_channel_inbound_effect;
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0012_owner_claim_replacement_audit';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0011_device_observations';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0010_artifact_index_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0009_action_authorizations';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0008_approval_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0007_configuration_state';
        DELETE FROM od_migration_manifest
          WHERE migration_name = '0006_device_channel_inbound_effect';
        DELETE FROM od_kysely_migration
          WHERE name = '0012_owner_claim_replacement_audit';
        DELETE FROM od_kysely_migration
          WHERE name = '0011_device_observations';
        DELETE FROM od_kysely_migration
          WHERE name = '0010_artifact_index_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0009_action_authorizations';
        DELETE FROM od_kysely_migration
          WHERE name = '0008_approval_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0007_configuration_state';
        DELETE FROM od_kysely_migration
          WHERE name = '0006_device_channel_inbound_effect';
      `);
    } finally {
      legacy.close();
    }

    repository = await SqlDeviceChannelRepository.openSqlite({
      filename,
      migrationMode: "apply",
    });
    assert.equal((await repository.resume("device-worker-1")).acknowledgedWorkerSequence, 1);
    assert.deepEqual(await repository.claimInboundEffect(workerPong(1), "claim-after-upgrade"), {
      disposition: "handled",
      acknowledgedSequence: 1,
    });
  } finally {
    await repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerDeviceChannelRepositoryContract("PostgreSQL", async () => {
    const schema = `od_device_channel_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
      open: (migrationMode) =>
        SqlDeviceChannelRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
    };
  });
}

async function createSqliteFixture(): Promise<ChannelRepositoryFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-device-channel-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    cleanup: () => rm(directory, { force: true, recursive: true }),
    open: (migrationMode) =>
      SqlDeviceChannelRepository.openSqlite({
        filename,
        migrationMode,
      }),
  };
}

function workerPong(sequence: number): WorkerPongFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: `worker-pong-${String(sequence)}`,
    senderDeviceId: "device-worker-1",
    correlationId: "connection-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: `worker-pong-${String(sequence)}`,
    sequence,
    type: "worker.pong",
    payload: {
      pingId: `ping-${String(sequence)}`,
      observedAtMs: sequence,
    },
  };
}

function mainPing(sequence: number, pingId: string): MainPingFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: `main-${pingId}`,
    senderDeviceId: "device-main-1",
    correlationId: "connection-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: `main-${pingId}`,
    sequence,
    type: "main.ping",
    payload: {
      pingId,
      deadlineAtMs: 1_900_000_000_000,
    },
  };
}

function mainDispatch(sequence: number): MainDispatchFrameV1 {
  return {
    protocolVersion: "v1",
    messageId: "dispatch:run-contract-1",
    senderDeviceId: "device-main-1",
    correlationId: "task-contract-1",
    createdAt: "2026-07-25T00:00:00.000Z",
    idempotencyKey: "dispatch:run-contract-1",
    sequence,
    type: "main.dispatch",
    payload: {
      taskId: "task-contract-1",
      workOrder: {
        protocolVersion: "v1",
        workOrderId: "work-order-contract-1",
        title: "Run the assignment",
        brief: "Produce the observable result.",
        completionCriteria: ["The result is reported."],
        constraints: [],
        selectedInputIds: [],
        dependsOn: [],
        schedulingHints: {
          preferredDeviceIds: [],
          preferredRoles: [],
        },
        requiredCapabilities: [],
        requiredSecretRefs: [],
      },
      deviceId: "device-worker-1",
      workerId: "worker-contract-1",
      routeId: "route-contract-1",
      runId: "run-contract-1",
      leaseId: "lease-contract-1",
      fencingToken: 1,
      leaseExpiresAtMs: 1_900_000_000_000,
    },
  };
}

function hasChannelCode(code: DeviceChannelRepositoryError["code"]) {
  return (error: unknown): boolean =>
    error instanceof DeviceChannelRepositoryError && error.code === code;
}
