import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import Database from "better-sqlite3";
import { Pool } from "pg";

import {
  SqlActionAuthorizationRepository,
  SqlStorageError,
  type ActionAuthorizationRecord,
  type SqlMigrationMode,
} from "../src/index.ts";

interface ActionAuthorizationFixture {
  open(mode: SqlMigrationMode): Promise<SqlActionAuthorizationRepository>;
  corruptRecord(authorizationRequestId: string): Promise<void>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<ActionAuthorizationFixture>;

function registerActionAuthorizationRepositoryContract(
  label: string,
  createFixture: FixtureFactory,
): void {
  describe(`${label} action authorization repository contract`, () => {
    test("atomically consumes once, replays one digest, revokes, and preserves audit across restart", async () => {
      const fixture = await createFixture();
      let repository: SqlActionAuthorizationRepository | undefined;
      try {
        repository = await fixture.open("apply");
        const initial = record({
          decision: "allow",
          consumptionDigest: null,
          audit: ["authorization.allowed"],
          scope: exactScope(),
        });
        await repository.write(initial);

        const outcomes = await Promise.all([
          consumeOnce(repository, initial.authorizationRequestId, "a".repeat(64), 2_000),
          consumeOnce(repository, initial.authorizationRequestId, "b".repeat(64), 2_001),
        ]);
        assert.equal(outcomes.filter((outcome) => outcome === "consumed").length, 1);
        assert.equal(outcomes.filter((outcome) => outcome === "already-consumed").length, 1);
        const consumed = await repository.read(initial.authorizationRequestId);
        assert.ok(consumed);
        const consumedState = parseState(consumed);
        const winningDigest = requireString(consumedState["consumptionDigest"]);
        assert.equal(winningDigest === "a".repeat(64) || winningDigest === "b".repeat(64), true);
        assert.deepEqual(consumedState["scope"], exactScope());

        await repository.close();
        repository = await fixture.open("verify");
        assert.equal(
          await consumeOnce(repository, initial.authorizationRequestId, winningDigest, 2_002),
          "replay",
        );
        await repository.transact(initial.authorizationRequestId, (current) => {
          assert.ok(current);
          const state = parseState(current);
          const nextState = {
            ...state,
            decision: "deny",
            audit: [...requireStringArray(state["audit"]), "authorization.revoked"],
          };
          return {
            result: undefined,
            next: updateRecord(current, nextState, 3_000),
          };
        });
        await repository.close();
        repository = await fixture.open("verify");
        const revoked = await repository.read(initial.authorizationRequestId);
        assert.ok(revoked);
        assert.deepEqual(parseState(revoked), {
          decision: "deny",
          consumptionDigest: winningDigest,
          audit: ["authorization.allowed", "authorization.consumed", "authorization.revoked"],
          scope: exactScope(),
        });
        assert.deepEqual(await repository.list(), [revoked]);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects cross-request mutation and a corrupted integrity digest", async () => {
      const fixture = await createFixture();
      let repository: SqlActionAuthorizationRepository | undefined;
      try {
        repository = await fixture.open("apply");
        const initial = record({
          decision: "allow",
          consumptionDigest: null,
          audit: [],
          scope: exactScope(),
        });
        await repository.write(initial);
        await assert.rejects(
          repository.transact(initial.authorizationRequestId, () => ({
            result: undefined,
            next: {
              ...initial,
              authorizationRequestId: "authorization-request-other",
            },
          })),
          (error: unknown) =>
            error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
        );
        await repository.close();
        repository = undefined;
        await fixture.corruptRecord(initial.authorizationRequestId);
        repository = await fixture.open("verify");
        await assert.rejects(
          repository.read(initial.authorizationRequestId),
          (error: unknown) => error instanceof SqlStorageError && error.code === "DATA_CORRUPT",
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

async function consumeOnce(
  repository: SqlActionAuthorizationRepository,
  authorizationRequestId: string,
  consumptionDigest: string,
  updatedAtMs: number,
): Promise<"already-consumed" | "consumed" | "replay"> {
  return await repository.transact(authorizationRequestId, (current) => {
    assert.ok(current);
    const state = parseState(current);
    const prior = state["consumptionDigest"];
    if (prior !== null) {
      return {
        result: prior === consumptionDigest ? ("replay" as const) : ("already-consumed" as const),
      };
    }
    return {
      result: "consumed" as const,
      next: updateRecord(
        current,
        {
          ...state,
          consumptionDigest,
          audit: [...requireStringArray(state["audit"]), "authorization.consumed"],
        },
        updatedAtMs,
      ),
    };
  });
}

function record(state: Readonly<Record<string, unknown>>): ActionAuthorizationRecord {
  const stateJson = JSON.stringify(state);
  return {
    authorizationRequestId: "authorization-request-contract",
    requestDigest: "1".repeat(64),
    authorizationId: `authorization:${"2".repeat(64)}`,
    policyFingerprint: `sha256:${"3".repeat(64)}`,
    stateJson,
    stateSha256: sha256(stateJson),
    updatedAtMs: 1_000,
  };
}

function updateRecord(
  current: ActionAuthorizationRecord,
  state: Readonly<Record<string, unknown>>,
  updatedAtMs: number,
): ActionAuthorizationRecord {
  const stateJson = JSON.stringify(state);
  return {
    ...current,
    stateJson,
    stateSha256: sha256(stateJson),
    updatedAtMs,
  };
}

function parseState(record: ActionAuthorizationRecord): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(record.stateJson) as unknown;
  assert.equal(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), true);
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function requireStringArray(value: unknown): readonly string[] {
  assert.equal(Array.isArray(value) && value.every((entry) => typeof entry === "string"), true);
  return value as readonly string[];
}

function exactScope(): Readonly<Record<string, string | number>> {
  return {
    taskId: "task-contract",
    workOrderId: "work-order-contract",
    deviceId: "device-contract",
    workerId: "worker-contract",
    routeId: "route-contract",
    runId: "run-contract",
    leaseId: "lease-contract",
    fencingToken: 7,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createSqliteFixture(): Promise<ActionAuthorizationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-action-authorization-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    open: (migrationMode) =>
      SqlActionAuthorizationRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
    corruptRecord: async (authorizationRequestId) => {
      const sqlite = new Database(filename);
      try {
        sqlite
          .prepare(
            `UPDATE od_action_authorizations
             SET state_sha256 = ?
             WHERE authorization_request_id = ?`,
          )
          .run("0".repeat(64), authorizationRequestId);
      } finally {
        sqlite.close();
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

registerActionAuthorizationRepositoryContract("SQLite", createSqliteFixture);

test("a selected SQLite backend fails closed when its target is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-action-sql-unavailable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    SqlActionAuthorizationRepository.openSqlite({
      filename: directory,
      migrationMode: "apply",
    }),
  );
});

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerActionAuthorizationRepositoryContract("PostgreSQL", async () => {
    const schema = `od_action_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      open: (migrationMode) =>
        SqlActionAuthorizationRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      corruptRecord: async (authorizationRequestId) => {
        await postgresAdminPool?.query(
          `UPDATE "${schema}".od_action_authorizations
           SET state_sha256 = $1
           WHERE authorization_request_id = $2`,
          ["0".repeat(64), authorizationRequestId],
        );
      },
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  });
}
