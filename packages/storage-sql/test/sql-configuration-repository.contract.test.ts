import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  ConfigurationService,
  STANDARD_CONFIGURATION_DEFINITIONS,
  type ConfigurationDefinition,
  type ConfigurationMutationAuthorization,
} from "@opendelegate/configuration";
import Database from "better-sqlite3";
import { Pool } from "pg";

import {
  SqlConfigurationRepository,
  SqlStorageError,
  type SqlMigrationMode,
} from "../src/index.ts";

interface ConfigurationFixture {
  open(mode: SqlMigrationMode): Promise<SqlConfigurationRepository>;
  corruptSnapshot(): Promise<void>;
  deleteSnapshot(): Promise<void>;
  rewriteSnapshot(operation: (snapshot: MutableJsonObject) => void): Promise<void>;
  cleanup(): Promise<void>;
}

type FixtureFactory = () => Promise<ConfigurationFixture>;
type MutableJson = null | boolean | number | string | MutableJson[] | MutableJsonObject;
type MutableJsonObject = { [key: string]: MutableJson };

function registerConfigurationRepositoryContract(
  label: string,
  createFixture: FixtureFactory,
): void {
  describe(`${label} configuration repository contract`, () => {
    test("atomically persists configuration and replays the same receipt after restart", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;
      let sequence = 0;

      try {
        repository = await fixture.open("apply");
        let service = createService(repository, () => `configuration-${++sequence}`);
        const proposal = await service.executeTool({
          operationId: "request:propose",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Require owner authentication for Device reports.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "authenticated",
              },
            ],
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(proposal.tool, "propose");

        const applyInput = {
          operationId: "request:apply",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "apply" as const,
            proposalId: proposal.result.proposal.id,
            expectedRevision: 0,
          },
          authorizeMutation: allowMutation,
        };
        const applied = await service.executeTool(applyInput);
        assert.equal(applied.tool, "apply");
        assert.equal(applied.result.commit.revision, 1);

        await repository.close();
        repository = await fixture.open("verify");
        service = createService(repository, () => {
          throw new Error("An idempotent replay must not allocate another identifier.");
        });
        assert.deepEqual(await service.executeTool(applyInput), applied);
        assert.equal(await service.getRevision(), 1);
        assert.equal((await service.inspect(CONTEXT))["artifact.exposure"]?.value, "authenticated");
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("persists a rollback chain and replays its receipt after restart", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;
      let sequence = 0;

      try {
        repository = await fixture.open("apply");
        let service = createService(repository, () => `rollback-${++sequence}`);
        const proposal = await service.executeTool({
          operationId: "rollback:propose",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Temporarily authenticate Device reports.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "authenticated",
              },
            ],
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(proposal.tool, "propose");
        const applied = await service.executeTool({
          operationId: "rollback:apply",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "apply",
            proposalId: proposal.result.proposal.id,
            expectedRevision: 0,
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(applied.tool, "apply");
        const rollbackInput = {
          operationId: "rollback:commit",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "rollback" as const,
            changeSetId: applied.result.commit.changeSetId,
            expectedRevision: 1,
            reason: "Restore the inherited exposure policy.",
          },
          authorizeMutation: allowMutation,
        };
        const rolledBack = await service.executeTool(rollbackInput);
        assert.equal(rolledBack.tool, "rollback");
        assert.equal(rolledBack.result.commit.revision, 2);

        await repository.close();
        repository = await fixture.open("verify");
        service = createService(repository, () => {
          throw new Error("A rollback replay must not allocate another identifier.");
        });
        assert.deepEqual(await service.executeTool(rollbackInput), rolledBack);
        assert.equal(await service.getRevision(), 2);
        assert.equal(
          (await service.inspect(CONTEXT))["artifact.exposure"]?.value,
          "private-network",
        );
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("serializes independent connections and commits one idempotent receipt", async () => {
      const fixture = await createFixture();
      let first: SqlConfigurationRepository | undefined;
      let second: SqlConfigurationRepository | undefined;

      try {
        first = await fixture.open("apply");
        second = await fixture.open("verify");
        const firstService = createService(first, () => "receipt-first");
        const secondService = createService(second, () => "receipt-second");
        const input = {
          operationId: "concurrent:inspect",
          actor: "owner_personal",
          context: CONTEXT,
          request: { tool: "inspect" as const },
          authorizeMutation: allowMutation,
        };

        const [left, right] = await Promise.all([
          firstService.executeTool(input),
          secondService.executeTool(input),
        ]);

        assert.deepEqual(left, right);
        assert.equal(
          left.receiptId === "receipt-first" || left.receiptId === "receipt-second",
          true,
        );
        assert.equal(await firstService.getRevision(), 0);
        assert.equal(await secondService.getRevision(), 0);
      } finally {
        await Promise.all([first?.close(), second?.close()]);
        await fixture.cleanup();
      }
    });

    test("rolls back the entire repository transaction when the callback fails", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await assert.rejects(
          repository.transact((state) => {
            state.revision = 99;
            throw new Error("abort the transaction");
          }),
          /abort the transaction/u,
        );
        await repository.close();
        repository = await fixture.open("verify");
        assert.equal(await repository.read((state) => state.revision), 0);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects an invalid transaction state without persisting or reporting corruption", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await assert.rejects(
          repository.transact((state) => {
            state.entries.set("invalid", {
              key: "artifact.exposure",
              scope: { kind: "device", id: "device_worker" },
              value: undefined,
            });
          }),
          (error: unknown) =>
            error instanceof SqlStorageError && error.code === "STORAGE_CONFIGURATION_INVALID",
        );
        assert.equal(await repository.read((state) => state.entries.size), 0);

        await repository.close();
        repository = await fixture.open("verify");
        assert.equal(await repository.read((state) => state.entries.size), 0);
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects a corrupt configuration snapshot during startup", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;

      try {
        repository = await fixture.open("apply");
        const service = createService(repository, () => "receipt-before-corruption");
        await service.executeTool({
          operationId: "corruption:inspect",
          actor: "owner_personal",
          context: CONTEXT,
          request: { tool: "inspect" },
          authorizeMutation: allowMutation,
        });
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

    test("rejects a missing configuration singleton during startup", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;

      try {
        repository = await fixture.open("apply");
        await repository.close();
        repository = undefined;
        await fixture.deleteSnapshot();

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

    test("round-trips canonical object keys independently of locale collation", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;
      let sequence = 0;
      const definitions: readonly ConfigurationDefinition[] = [
        ...STANDARD_CONFIGURATION_DEFINITIONS,
        {
          key: "test.object",
          defaultValue: {},
          scopes: ["device"],
          validate: (value) => typeof value === "object" && value !== null,
        },
      ];

      try {
        repository = await fixture.open("apply");
        let service = createService(repository, () => `canonical-${++sequence}`, definitions);
        const proposal = await service.executeTool({
          operationId: "canonical:propose",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Persist deterministic object ordering.",
            changes: [
              {
                operation: "set",
                key: "test.object",
                scope: { kind: "device", id: "device_worker" },
                value: { a: 1, Z: 2 },
              },
            ],
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(proposal.tool, "propose");
        await service.executeTool({
          operationId: "canonical:apply",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "apply",
            proposalId: proposal.result.proposal.id,
            expectedRevision: 0,
          },
          authorizeMutation: allowMutation,
        });

        await repository.close();
        repository = await fixture.open("verify");
        service = createService(repository, () => `unused-${++sequence}`, definitions);
        assert.deepEqual((await service.inspect(CONTEXT))["test.object"]?.value, { Z: 2, a: 1 });
      } finally {
        await repository?.close();
        await fixture.cleanup();
      }
    });

    test("rejects a semantically inconsistent receipt with a valid digest", async () => {
      const fixture = await createFixture();
      let repository: SqlConfigurationRepository | undefined;
      let sequence = 0;

      try {
        repository = await fixture.open("apply");
        const service = createService(repository, () => `semantic-${++sequence}`);
        const firstProposal = await service.executeTool({
          operationId: "semantic:propose-one",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "First semantic state.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "authenticated",
              },
            ],
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(firstProposal.tool, "propose");
        const firstApply = await service.executeTool({
          operationId: "semantic:apply-one",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "apply",
            proposalId: firstProposal.result.proposal.id,
            expectedRevision: 0,
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(firstApply.tool, "apply");

        const secondProposal = await service.executeTool({
          operationId: "semantic:propose-two",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "propose",
            expectedRevision: 1,
            reason: "Second semantic state.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "public",
              },
            ],
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(secondProposal.tool, "propose");
        const secondApply = await service.executeTool({
          operationId: "semantic:apply-two",
          actor: "owner_personal",
          context: CONTEXT,
          request: {
            tool: "apply",
            proposalId: secondProposal.result.proposal.id,
            expectedRevision: 1,
          },
          authorizeMutation: allowMutation,
        });
        assert.equal(secondApply.tool, "apply");

        await repository.close();
        repository = undefined;
        await fixture.rewriteSnapshot((snapshot) => {
          const storedReceipt = encodedMapValue(snapshot["toolReceipts"], "semantic:apply-one");
          const receipt = durableObjectProperty(storedReceipt, "receipt");
          const result = durableObjectProperty(receipt, "result");
          const commit = durableObjectProperty(result, "commit");
          replaceDurableStringProperty(
            commit,
            "changeSetId",
            secondApply.result.commit.changeSetId,
          );
        });

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

async function createSqliteFixture(): Promise<ConfigurationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-configuration-sql-"));
  const filename = join(directory, "main.sqlite3");
  return {
    open: (migrationMode) =>
      SqlConfigurationRepository.openSqlite({
        busyTimeoutMs: 100,
        filename,
        migrationMode,
      }),
    corruptSnapshot: async () => {
      const sqlite = new Database(filename);
      try {
        sqlite
          .prepare(
            `UPDATE od_configuration_state
             SET state_sha256 = ? WHERE singleton_id = 1`,
          )
          .run("0".repeat(64));
      } finally {
        sqlite.close();
      }
    },
    deleteSnapshot: async () => {
      const sqlite = new Database(filename);
      try {
        sqlite.prepare("DELETE FROM od_configuration_state WHERE singleton_id = 1").run();
      } finally {
        sqlite.close();
      }
    },
    rewriteSnapshot: async (operation) => {
      const sqlite = new Database(filename);
      try {
        const row = sqlite
          .prepare("SELECT state_json FROM od_configuration_state WHERE singleton_id = 1")
          .get() as { state_json: string } | undefined;
        if (row === undefined) {
          throw new Error("The Configuration snapshot fixture is missing.");
        }
        const snapshot = JSON.parse(row.state_json) as MutableJsonObject;
        operation(snapshot);
        const stateJson = JSON.stringify(snapshot);
        sqlite
          .prepare(
            `UPDATE od_configuration_state
             SET state_json = ?, state_sha256 = ? WHERE singleton_id = 1`,
          )
          .run(stateJson, createDigest(stateJson));
      } finally {
        sqlite.close();
      }
    },
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

registerConfigurationRepositoryContract("SQLite", createSqliteFixture);

const postgresUri = process.env["OPENDELEGATE_TEST_POSTGRES_URI"];
const postgresAdminPool =
  postgresUri === undefined ? undefined : new Pool({ connectionString: postgresUri });

after(async () => {
  await postgresAdminPool?.end();
});

if (postgresUri !== undefined) {
  registerConfigurationRepositoryContract("PostgreSQL", async () => {
    const schema = `od_configuration_${randomUUID().replaceAll("-", "")}`;
    await postgresAdminPool?.query(`CREATE SCHEMA "${schema}"`);
    return {
      open: (migrationMode) =>
        SqlConfigurationRepository.openPostgres({
          connectionString: postgresUri,
          migrationMode,
          schema,
        }),
      corruptSnapshot: async () => {
        await postgresAdminPool?.query(
          `UPDATE "${schema}".od_configuration_state
           SET state_sha256 = $1 WHERE singleton_id = 1`,
          ["0".repeat(64)],
        );
      },
      deleteSnapshot: async () => {
        await postgresAdminPool?.query(
          `DELETE FROM "${schema}".od_configuration_state WHERE singleton_id = 1`,
        );
      },
      rewriteSnapshot: async (operation) => {
        const result = await postgresAdminPool?.query<{ state_json: string }>(
          `SELECT state_json FROM "${schema}".od_configuration_state WHERE singleton_id = 1`,
        );
        assert.equal(result?.rowCount, 1);
        const snapshot = JSON.parse(result.rows[0]?.state_json ?? "") as MutableJsonObject;
        operation(snapshot);
        const stateJson = JSON.stringify(snapshot);
        await postgresAdminPool?.query(
          `UPDATE "${schema}".od_configuration_state
           SET state_json = $1, state_sha256 = $2 WHERE singleton_id = 1`,
          [stateJson, createDigest(stateJson)],
        );
      },
      cleanup: async () => {
        await postgresAdminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  });
}

const NOW = "2026-07-25T12:00:00.000Z";
const CONTEXT = {
  instanceId: "instance_personal",
  mainId: "device_main",
  deviceId: "device_worker",
} as const;

function createService(
  repository: SqlConfigurationRepository,
  idSource: () => string,
  definitions: readonly ConfigurationDefinition[] = STANDARD_CONFIGURATION_DEFINITIONS,
): ConfigurationService {
  return new ConfigurationService({
    definitions,
    repository,
    idSource,
    clock: () => NOW,
  });
}

function allowMutation(): ConfigurationMutationAuthorization {
  return {
    decision: "allow",
    authority: "owner",
  };
}

function createDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodedMapValue(value: MutableJson | undefined, key: string): MutableJson {
  assert.ok(Array.isArray(value));
  const entry = value.find((candidate) => Array.isArray(candidate) && candidate[0] === key);
  assert.ok(Array.isArray(entry));
  const result = entry[1];
  if (result === undefined) {
    throw new Error(`The encoded map entry ${key} has no value.`);
  }
  return result;
}

function durableObjectProperty(value: MutableJson, key: string): MutableJson {
  assert.ok(Array.isArray(value));
  assert.equal(value[0], "object");
  const entries = value[1];
  assert.ok(Array.isArray(entries));
  const entry = entries.find((candidate) => Array.isArray(candidate) && candidate[0] === key);
  assert.ok(Array.isArray(entry));
  const result = entry[1];
  if (result === undefined) {
    throw new Error(`The durable object property ${key} has no value.`);
  }
  return result;
}

function replaceDurableStringProperty(value: MutableJson, key: string, replacement: string): void {
  const encoded = durableObjectProperty(value, key);
  assert.ok(Array.isArray(encoded));
  assert.equal(encoded[0], "string");
  encoded[1] = replacement;
}
