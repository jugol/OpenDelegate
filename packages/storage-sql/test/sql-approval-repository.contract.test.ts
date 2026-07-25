import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  ApprovalService,
  type ApprovalExecutionContext,
  type ApprovalExecutionPort,
} from "@opendelegate/policy";
import Database from "better-sqlite3";
import { Pool } from "pg";

import { SqlApprovalRepository, SqlStorageError, type SqlMigrationMode } from "../src/index.ts";

interface ApprovalFixture {
  open(mode: SqlMigrationMode): Promise<SqlApprovalRepository>;
  corruptSnapshot(): Promise<void>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<ApprovalFixture>;

class IdempotentExecutor implements ApprovalExecutionPort {
  readonly calls: ApprovalExecutionContext[] = [];
  readonly results = new Map<string, { readonly appliedRevision: number }>();

  async execute(input: ApprovalExecutionContext): Promise<{ readonly appliedRevision: number }> {
    this.calls.push(structuredClone(input));
    const existing = this.results.get(input.operationId);
    if (existing !== undefined) {
      return existing;
    }
    const result = { appliedRevision: 9 };
    this.results.set(input.operationId, result);
    return result;
  }
}

function registerApprovalRepositoryContract(label: string, createFixture: FixtureFactory): void {
  describe(`${label} Approval repository contract`, () => {
    test("persists an exact once grant, atomic consumption, result, and audit across restart", async () => {
      const fixture = await createFixture();
      const executor = new IdempotentExecutor();
      let repository: SqlApprovalRepository | undefined;
      let sequence = 0;

      try {
        repository = await fixture.open("apply");
        let service = createService(repository, executor, () => `approval-${++sequence}`);
        const pending = await service.request({
          idempotencyKey: "configuration:request:001",
          requestedBy: "owner_personal",
          actionCategory: "policy-relaxation",
          actionType: "configuration.apply",
          targetDeviceId: "device_main",
          resource: "configuration-proposal:proposal_001",
          descriptor: {
            kind: "configuration",
            operation: "apply-proposal",
            target: {
              diff: [
                {
                  after: "allow",
                  before: "require-approval",
                  key: "policy.network-change",
                },
              ],
              proposalId: "proposal_001",
            },
          },
          presentation: {
            reason: "Relax network mutation policy.",
            target: "device_main",
            risk: "high",
            evidence: ["policy.network-change"],
          },
          execution: {
            kind: "configuration.apply",
            payload: {
              expectedRevision: 2,
              proposalId: "proposal_001",
            },
          },
          expiresAtMs: 20_000,
        });
        const approved = await service.decide({
          approvalId: pending.approvalId,
          idempotencyKey: "configuration:decision:001",
          decidedBy: "owner_personal",
          decision: { kind: "approve", scope: "once" },
        });
        assert.equal(approved.executionStatus, "succeeded");
        assert.equal(approved.onceGrantConsumedAtMs, 1_000);
        assert.equal(executor.calls.length, 1);

        await repository.close();
        repository = await fixture.open("verify");
        service = createService(repository, executor, () => {
          throw new Error("An idempotent restart replay must not allocate another ID.");
        });
        assert.deepEqual(await service.get(pending.approvalId), approved);
        assert.deepEqual(
          await service.decide({
            approvalId: pending.approvalId,
            idempotencyKey: "configuration:decision:001",
            decidedBy: "owner_personal",
            decision: { kind: "approve", scope: "once" },
          }),
          approved,
        );
        assert.equal(executor.calls.length, 1);
        assert.deepEqual(
          (await service.audit()).map((event) => event.event),
          [
            "approval.requested",
            "approval.approved",
            "approval.once-grant-consumed",
            "approval.execution-succeeded",
          ],
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("fails closed when the durable Approval checksum is changed", async () => {
      const fixture = await createFixture();
      let repository: SqlApprovalRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await repository.close();
        repository = undefined;
        await fixture.corruptSnapshot();

        await assert.rejects(
          async () => {
            repository = await fixture.open("verify");
          },
          (error: unknown) => error instanceof SqlStorageError && error.code === "DATA_CORRUPT",
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });
  });
}

function createService(
  repository: SqlApprovalRepository,
  executor: ApprovalExecutionPort,
  nextId: () => string,
): ApprovalService {
  return new ApprovalService({
    repository,
    executor,
    clock: { now: () => 1_000 },
    idSource: { nextId },
  });
}

async function createSqliteFixture(): Promise<ApprovalFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-approval-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    open: (migrationMode) =>
      SqlApprovalRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
    corruptSnapshot: async () => {
      const sqlite = new Database(filename);
      try {
        sqlite
          .prepare("UPDATE od_approval_state SET state_sha256 = ? WHERE singleton_id = 1")
          .run("0".repeat(64));
      } finally {
        sqlite.close();
      }
    },
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

registerApprovalRepositoryContract("SQLite", createSqliteFixture);

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerApprovalRepositoryContract("PostgreSQL", async () => {
    const schema = `od_approval_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      open: (migrationMode) =>
        SqlApprovalRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      corruptSnapshot: async () => {
        await postgresAdminPool?.query(
          `UPDATE "${schema}".od_approval_state
           SET state_sha256 = $1 WHERE singleton_id = 1`,
          ["0".repeat(64)],
        );
      },
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  });
}
