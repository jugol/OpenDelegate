import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import Database from "better-sqlite3";
import { Pool } from "pg";

import {
  SqlDeviceObservationRepository,
  SqlStorageError,
  type SqlMigrationMode,
} from "../src/index.ts";
import type { WorkerHeartbeatV1 } from "@opendelegate/device-channel";

interface DeviceObservationFixture {
  open(mode: SqlMigrationMode): Promise<SqlDeviceObservationRepository>;
  assertEventAppendOnly(): Promise<void>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<DeviceObservationFixture>;

function registerDeviceObservationRepositoryContract(
  label: string,
  createFixture: FixtureFactory,
): void {
  describe(`${label} Device observation repository contract`, () => {
    test("persists accepted snapshots and append-only events across restart", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceObservationRepository | undefined;
      try {
        repository = await fixture.open("apply");
        assert.deepEqual(
          await repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 1_050,
            heartbeat: heartbeat(1_000),
          }),
          { disposition: "accepted", observationSequence: 1 },
        );
        assert.deepEqual(
          await repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 1_060,
            heartbeat: heartbeat(1_000),
          }),
          { disposition: "duplicate", observationSequence: 1 },
        );
        assert.deepEqual(
          await repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 1_070,
            heartbeat: heartbeat(900),
          }),
          { disposition: "stale", observationSequence: 1 },
        );
        await assert.rejects(
          repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 1_080,
            heartbeat: {
              ...heartbeat(1_000),
              capacity: { ...heartbeat(1_000).capacity, acceptingWork: false },
            },
          }),
          (error: unknown) =>
            error instanceof SqlStorageError &&
            error.code === "STORAGE_CONFIGURATION_INVALID" &&
            /reused/u.test(error.message),
        );
        assert.deepEqual(
          await repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 2_050,
            heartbeat: heartbeat(2_000),
          }),
          { disposition: "accepted", observationSequence: 2 },
        );

        await repository.close();
        repository = await fixture.open("verify");
        const latest = await repository.latest("device-worker-1");
        assert.equal(latest?.observationSequence, 2);
        assert.equal(latest?.observedAtMs, 2_000);
        assert.equal(latest?.acceptedAtMs, 2_050);
        assert.equal(latest?.heartbeat.inventory?.hardware?.cpu.model, "Example CPU");
        assert.deepEqual(
          (await repository.listEvents("device-worker-1")).map(
            ({ observationSequence, observedAtMs, acceptedAtMs }) => ({
              observationSequence,
              observedAtMs,
              acceptedAtMs,
            }),
          ),
          [
            { observationSequence: 1, observedAtMs: 1_000, acceptedAtMs: 1_050 },
            { observationSequence: 2, observedAtMs: 2_000, acceptedAtMs: 2_050 },
          ],
        );
        assert.deepEqual(
          (await repository.listLatest()).map(({ deviceId, observationSequence }) => ({
            deviceId,
            observationSequence,
          })),
          [{ deviceId: "device-worker-1", observationSequence: 2 }],
        );
        await fixture.assertEventAppendOnly();
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects identity mismatch, local-path-shaped fields, and unbounded reads", async () => {
      const fixture = await createFixture();
      let repository: SqlDeviceObservationRepository | undefined;
      try {
        repository = await fixture.open("apply");
        await assert.rejects(
          repository.accept({
            authenticatedDeviceId: "device-other",
            acceptedAtMs: 1_050,
            heartbeat: heartbeat(1_000),
          }),
          (error: unknown) =>
            error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
        );
        const tainted = structuredClone(heartbeat(1_000)) as unknown as {
          inventory: { hardware: { gpu: { devices: unknown[] } } };
        };
        tainted.inventory.hardware.gpu.devices = [
          { model: "Example GPU", localPath: "/sys/class/drm/card0/device" },
        ];
        await assert.rejects(
          repository.accept({
            authenticatedDeviceId: "device-worker-1",
            acceptedAtMs: 1_050,
            heartbeat: tainted as unknown as WorkerHeartbeatV1,
          }),
          (error: unknown) =>
            error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
        );
        await assert.rejects(
          repository.listEvents("device-worker-1", 1_001),
          (error: unknown) =>
            error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

function heartbeat(observedAtMs: number): WorkerHeartbeatV1 {
  return {
    protocolVersion: "v1",
    deviceId: "device-worker-1",
    workerId: "worker-primary",
    observedAtMs,
    operationalState: "active",
    connectionState: "online",
    readiness: {
      daemon: "healthy",
      session: "unavailable",
      desktop: "unavailable",
      permissions: {
        accessibility: "not-applicable",
        input: "not-applicable",
        screenCapture: "not-applicable",
      },
    },
    capacity: {
      acceptingWork: true,
      activeRuns: 0,
      maxOutboxEntries: 1_024,
      outboxDepth: 0,
    },
    inventory: {
      deviceName: "Build workstation",
      osFamily: "windows",
      platformRelease: "11.0.26100",
      architecture: "x64",
      serviceMode: "system-service",
      hardware: {
        cpu: {
          model: "Example CPU",
          logicalCoreCount: 16,
          observedAtMs,
          source: "node-os",
          verification: "observed",
        },
        memory: {
          totalBytes: 68_719_476_736,
          observedAtMs,
          source: "node-os",
          verification: "observed",
        },
        gpu: {
          devices: [
            {
              model: "Example GPU",
              vendor: "Example Vendor",
              memoryBytes: 17_179_869_184,
            },
          ],
          observedAtMs,
          source: "platform-probe",
          verification: "verified",
        },
      },
      maximumConcurrentRuns: 4,
      capabilities: [],
      workspaceIds: [],
      availableSecretRefs: [],
    },
  };
}

async function createSqliteFixture(): Promise<DeviceObservationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-device-observation-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    open: (migrationMode) =>
      SqlDeviceObservationRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
    assertEventAppendOnly: async () => {
      const sqlite = new Database(filename);
      try {
        assert.throws(
          () =>
            sqlite
              .prepare(
                `UPDATE od_device_observation_events
                 SET accepted_at_ms = accepted_at_ms + 1
                 WHERE device_id = ? AND observation_sequence = 1`,
              )
              .run("device-worker-1"),
          /append-only/u,
        );
      } finally {
        sqlite.close();
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

registerDeviceObservationRepositoryContract("SQLite", createSqliteFixture);

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerDeviceObservationRepositoryContract("PostgreSQL", async () => {
    const schema = `od_observation_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      open: (migrationMode) =>
        SqlDeviceObservationRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      assertEventAppendOnly: async () => {
        await assert.rejects(
          postgresAdminPool!.query(
            `UPDATE "${schema}".od_device_observation_events
             SET accepted_at_ms = accepted_at_ms + 1
             WHERE device_id = $1 AND observation_sequence = 1`,
            ["device-worker-1"],
          ),
          /append-only/u,
        );
      },
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  });
}
