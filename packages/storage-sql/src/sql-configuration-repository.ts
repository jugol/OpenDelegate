import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ConfigurationAudit,
  ConfigurationChange,
  ConfigurationDiff,
  ConfigurationEntry,
  ConfigurationProposal,
  ConfigurationRepository,
  ConfigurationRepositoryState,
  ConfigurationScope,
  ConfigurationToolReceipt,
  ReadonlyConfigurationState,
  StoredChangeSet,
  StoredConfigurationToolReceipt,
  StoredProposal,
} from "@opendelegate/configuration";
import type { Kysely, Selectable, Transaction } from "kysely";

import { decodeCanonicalJson, encodeCanonicalJson, parseSafeNonNegativeInteger } from "./codecs.ts";
import {
  createPostgresDatabase,
  createSqliteDatabase,
  type PostgresDialectOptions,
  type SqlDatabaseContext,
  type SqliteDialectOptions,
} from "./dialects.ts";
import { SqlStorageError } from "./errors.ts";
import { applySqlMigrations, verifySqlMigrations } from "./migrations.ts";
import type { ConfigurationStateTable, SqlStorageSchema } from "./schema.ts";
import {
  DEFAULT_SQL_RETRY_POLICY,
  SqlTransactionRunner,
  type SqlRetryPolicy,
} from "./transactions.ts";
import type { SqlMigrationMode } from "./sql-event-store.ts";

interface SqlConfigurationRepositoryOptions {
  readonly migrationMode?: SqlMigrationMode;
  readonly retryPolicy?: SqlRetryPolicy;
}

export interface OpenSqliteConfigurationRepositoryOptions
  extends SqlConfigurationRepositoryOptions, SqliteDialectOptions {}

export interface OpenPostgresConfigurationRepositoryOptions
  extends SqlConfigurationRepositoryOptions, PostgresDialectOptions {}

type DurableNode =
  | readonly ["undefined"]
  | readonly ["null"]
  | readonly ["boolean", boolean]
  | readonly ["number", number]
  | readonly ["string", string]
  | readonly ["array", readonly DurableNode[]]
  | readonly ["object", readonly (readonly [string, DurableNode])[]];

interface ConfigurationSnapshotV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly entries: readonly (readonly [string, DurableNode])[];
  readonly proposals: readonly (readonly [string, DurableNode])[];
  readonly changeSets: readonly (readonly [string, DurableNode])[];
  readonly audits: readonly DurableNode[];
  readonly toolReceipts: readonly (readonly [string, DurableNode])[];
}

const MAXIMUM_STATE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_COLLECTION_SIZE = 100_000;

export class SqlConfigurationRepository implements ConfigurationRepository {
  readonly #context: SqlDatabaseContext;
  readonly #transactionRunner: SqlTransactionRunner;

  private constructor(context: SqlDatabaseContext, retryPolicy: SqlRetryPolicy) {
    this.#context = context;
    this.#transactionRunner = new SqlTransactionRunner(
      context.database,
      context.backend,
      retryPolicy,
    );
  }

  static async openSqlite(
    options: OpenSqliteConfigurationRepositoryOptions,
  ): Promise<SqlConfigurationRepository> {
    const context = await createSqliteDatabase(options);
    return this.#open(context, options);
  }

  static async openPostgres(
    options: OpenPostgresConfigurationRepositoryOptions,
  ): Promise<SqlConfigurationRepository> {
    const context = await createPostgresDatabase(options);
    return this.#open(context, options);
  }

  async read<T>(operation: (state: ReadonlyConfigurationState) => T): Promise<T> {
    if (typeof operation !== "function") {
      throw invalidInput("A Configuration repository read callback is required.");
    }
    const state = await loadState(this.#context.database);
    return operation(state);
  }

  async transact<T>(operation: (state: ConfigurationRepositoryState) => T): Promise<T> {
    if (typeof operation !== "function") {
      throw invalidInput("A Configuration repository transaction callback is required.");
    }
    return this.#transactionRunner.write(async (transaction) => {
      const state = await loadState(transaction);
      const result = operation(state);
      const encoded = encodeState(state);
      await transaction
        .insertInto("od_configuration_state")
        .values({
          revision: state.revision,
          schema_version: 1,
          singleton_id: 1,
          state_json: encoded.json,
          state_sha256: encoded.sha256,
        })
        .onConflict((conflict) =>
          conflict.column("singleton_id").doUpdateSet({
            revision: state.revision,
            schema_version: 1,
            state_json: encoded.json,
            state_sha256: encoded.sha256,
          }),
        )
        .execute();
      return result;
    });
  }

  async close(): Promise<void> {
    await this.#context.close();
  }

  static async #open(
    context: SqlDatabaseContext,
    options: SqlConfigurationRepositoryOptions,
  ): Promise<SqlConfigurationRepository> {
    try {
      if ((options.migrationMode ?? "verify") === "apply") {
        await applySqlMigrations(context.database, context.backend, context.migrationTableSchema);
      } else {
        await verifySqlMigrations(context.database);
      }
      const repository = new SqlConfigurationRepository(
        context,
        options.retryPolicy ?? DEFAULT_SQL_RETRY_POLICY,
      );
      await repository.read(() => undefined);
      return repository;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

type StateReader = Kysely<SqlStorageSchema> | Transaction<SqlStorageSchema>;

async function loadState(database: StateReader): Promise<ConfigurationRepositoryState> {
  const row = await database
    .selectFrom("od_configuration_state")
    .selectAll()
    .where("singleton_id", "=", 1)
    .executeTakeFirst();
  if (row === undefined) {
    throw dataCorrupt("The singleton Configuration state is missing.");
  }
  return decodeState(row);
}

function encodeState(state: ConfigurationRepositoryState): {
  readonly json: string;
  readonly sha256: string;
} {
  try {
    validateState(state);
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw invalidInput("Configuration state is outside the durable repository contract.", error);
    }
    throw error;
  }
  const snapshot: ConfigurationSnapshotV1 = {
    schemaVersion: 1,
    revision: state.revision,
    entries: encodeMap(state.entries),
    proposals: encodeMap(state.proposals),
    changeSets: encodeMap(state.changeSets),
    audits: state.audits.map((audit) => encodeNode(audit)),
    toolReceipts: encodeMap(state.toolReceipts),
  };
  let json: string;
  try {
    json = encodeCanonicalJson(snapshot);
  } catch (error) {
    throw invalidInput(
      "Configuration state contains a value outside the durable JSON contract.",
      error,
    );
  }
  if (Buffer.byteLength(json, "utf8") > MAXIMUM_STATE_BYTES) {
    throw invalidInput("Configuration state exceeds the 16 MiB durable snapshot limit.");
  }
  return {
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function decodeState(row: Selectable<ConfigurationStateTable>): ConfigurationRepositoryState {
  try {
    if (row.singleton_id !== 1 || row.schema_version !== 1) {
      throw dataCorrupt("The Configuration state schema marker is invalid.");
    }
    if (
      Buffer.byteLength(row.state_json, "utf8") > MAXIMUM_STATE_BYTES ||
      !/^[0-9a-f]{64}$/u.test(row.state_sha256) ||
      createHash("sha256").update(row.state_json, "utf8").digest("hex") !== row.state_sha256
    ) {
      throw dataCorrupt("The Configuration state integrity digest does not match.");
    }
    const decoded = decodeCanonicalJson(row.state_json);
    const snapshot = requireSnapshot(decoded);
    const columnRevision = parseSafeNonNegativeInteger(
      row.revision,
      "Configuration state revision",
    );
    if (snapshot.revision !== columnRevision) {
      throw dataCorrupt("The Configuration state revision columns disagree.");
    }
    const state: ConfigurationRepositoryState = {
      revision: snapshot.revision,
      entries: decodeMap(snapshot.entries, decodeEntry),
      proposals: decodeMap(snapshot.proposals, decodeStoredProposal),
      changeSets: decodeMap(snapshot.changeSets, decodeStoredChangeSet),
      audits: snapshot.audits.map((node) => decodeAudit(decodeNode(node))),
      toolReceipts: decodeMap(snapshot.toolReceipts, decodeStoredReceipt),
    };
    validateState(state);
    return state;
  } catch (error) {
    if (error instanceof SqlStorageError && error.code === "DATA_CORRUPT") {
      throw error;
    }
    throw dataCorrupt("The stored Configuration state is invalid.", error);
  }
}

function encodeMap<TValue>(
  values: ReadonlyMap<string, TValue>,
): readonly (readonly [string, DurableNode])[] {
  return [...values]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([key, value]) => [key, encodeNode(value)] as const);
}

function decodeMap<TValue>(
  values: readonly (readonly [string, DurableNode])[],
  decode: (value: unknown, key: string) => TValue,
): Map<string, TValue> {
  if (values.length > MAXIMUM_COLLECTION_SIZE) {
    throw dataCorrupt("A Configuration state collection is unreasonably large.");
  }
  const result = new Map<string, TValue>();
  let previous: string | undefined;
  for (const [key, node] of values) {
    requireMapKey(key);
    if (result.has(key) || (previous !== undefined && compareCanonicalText(previous, key) >= 0)) {
      throw dataCorrupt("A Configuration state map is duplicated or out of canonical order.");
    }
    previous = key;
    result.set(key, decode(decodeNode(node), key));
  }
  return result;
}

function encodeNode(value: unknown, active = new WeakSet<object>()): DurableNode {
  if (value === undefined) {
    return ["undefined"];
  }
  if (value === null) {
    return ["null"];
  }
  if (typeof value === "string") {
    return ["string", value];
  }
  if (typeof value === "boolean") {
    return ["boolean", value];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput("Configuration state contains a non-finite number.");
    }
    return ["number", value];
  }
  if (typeof value !== "object" || active.has(value)) {
    throw invalidInput("Configuration state must contain only acyclic durable values.");
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAXIMUM_COLLECTION_SIZE) {
        throw invalidInput("A Configuration state array is unreasonably large.");
      }
      return ["array", value.map((item) => encodeNode(item, active))];
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw invalidInput("Configuration state must contain only plain durable objects.");
    }
    const entries: (readonly [string, DurableNode])[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort(compareCanonicalText)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw invalidInput("Configuration state contains a non-data property.");
      }
      entries.push([key, encodeNode(descriptor.value, active)]);
    }
    return ["object", entries];
  } finally {
    active.delete(value);
  }
}

function decodeNode(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw dataCorrupt("A Configuration durable value has an invalid tag.");
  }
  switch (value[0]) {
    case "undefined":
      requireArrayLength(value, 1);
      return undefined;
    case "null":
      requireArrayLength(value, 1);
      return null;
    case "boolean":
      requireArrayLength(value, 2);
      if (typeof value[1] !== "boolean") {
        break;
      }
      return value[1];
    case "number":
      requireArrayLength(value, 2);
      if (typeof value[1] !== "number" || !Number.isFinite(value[1])) {
        break;
      }
      return value[1];
    case "string":
      requireArrayLength(value, 2);
      if (typeof value[1] !== "string") {
        break;
      }
      return value[1];
    case "array": {
      requireArrayLength(value, 2);
      if (!Array.isArray(value[1]) || value[1].length > MAXIMUM_COLLECTION_SIZE) {
        break;
      }
      return value[1].map(decodeNode);
    }
    case "object": {
      requireArrayLength(value, 2);
      if (!Array.isArray(value[1]) || value[1].length > MAXIMUM_COLLECTION_SIZE) {
        break;
      }
      const result: Record<string, unknown> = {};
      let previous: string | undefined;
      for (const entry of value[1]) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          (previous !== undefined && compareCanonicalText(previous, entry[0]) >= 0)
        ) {
          throw dataCorrupt("A Configuration durable object is not canonical.");
        }
        previous = entry[0];
        Object.defineProperty(result, entry[0], {
          configurable: true,
          enumerable: true,
          value: decodeNode(entry[1]),
          writable: true,
        });
      }
      return result;
    }
  }
  throw dataCorrupt("A Configuration durable value is invalid.");
}

function requireSnapshot(value: unknown): ConfigurationSnapshotV1 {
  const record = requireRecord(value, "Configuration snapshot");
  requireExactKeys(record, [
    "schemaVersion",
    "revision",
    "entries",
    "proposals",
    "changeSets",
    "audits",
    "toolReceipts",
  ]);
  if (
    record["schemaVersion"] !== 1 ||
    !isNonNegativeInteger(record["revision"]) ||
    !Array.isArray(record["entries"]) ||
    !Array.isArray(record["proposals"]) ||
    !Array.isArray(record["changeSets"]) ||
    !Array.isArray(record["audits"]) ||
    !Array.isArray(record["toolReceipts"])
  ) {
    throw dataCorrupt("The Configuration snapshot envelope is invalid.");
  }
  return record as unknown as ConfigurationSnapshotV1;
}

function decodeEntry(value: unknown, storageKey: string): ConfigurationEntry {
  const entry = requireRecord(value, "Configuration entry");
  requireExactKeys(entry, ["key", "scope", "value"]);
  const key = requireSettingKey(entry["key"]);
  const scope = requireScope(entry["scope"]);
  if (entry["value"] === undefined || storageKey !== entryStorageKey(key, scope)) {
    throw dataCorrupt("A Configuration entry identity is inconsistent.");
  }
  return {
    key,
    scope,
    value: structuredClone(entry["value"]),
  };
}

function decodeStoredProposal(value: unknown, id: string): StoredProposal {
  const stored = requireRecord(value, "stored Configuration proposal");
  requireAllowedKeys(stored, ["proposal", "consumedAtRevision"]);
  const proposal = requireProposal(stored["proposal"]);
  if (proposal.id !== id) {
    throw dataCorrupt("A stored Configuration proposal ID is inconsistent.");
  }
  const consumedAtRevision =
    stored["consumedAtRevision"] === undefined
      ? undefined
      : requirePositiveInteger(stored["consumedAtRevision"], "proposal consumed revision");
  return {
    proposal,
    ...(consumedAtRevision === undefined ? {} : { consumedAtRevision }),
  };
}

function decodeStoredChangeSet(value: unknown, id: string): StoredChangeSet {
  const stored = requireRecord(value, "stored Configuration change set");
  requireAllowedKeys(stored, ["id", "revision", "diff", "rolledBackBy"]);
  const decodedId = requireSafeText(stored["id"], "Configuration change-set ID", 500);
  if (decodedId !== id) {
    throw dataCorrupt("A stored Configuration change-set ID is inconsistent.");
  }
  const rolledBackBy =
    stored["rolledBackBy"] === undefined
      ? undefined
      : requireSafeText(stored["rolledBackBy"], "rollback change-set ID", 500);
  return {
    id,
    revision: requirePositiveInteger(stored["revision"], "change-set revision"),
    diff: requireDiff(stored["diff"]),
    ...(rolledBackBy === undefined ? {} : { rolledBackBy }),
  };
}

function decodeAudit(value: unknown): ConfigurationAudit {
  const audit = requireRecord(value, "Configuration audit");
  requireAllowedKeys(audit, [
    "id",
    "action",
    "actor",
    "reason",
    "occurredAt",
    "revision",
    "changeSetId",
    "proposalId",
    "rolledBackChangeSetId",
    "diff",
  ]);
  if (
    audit["action"] !== "configuration.applied" &&
    audit["action"] !== "configuration.rolled-back"
  ) {
    throw dataCorrupt("A Configuration audit action is invalid.");
  }
  return {
    id: requireSafeText(audit["id"], "Configuration audit ID", 500),
    action: audit["action"],
    actor: requireSafeText(audit["actor"], "Configuration audit actor", 500),
    reason: requireSafeText(audit["reason"], "Configuration audit reason", 500),
    occurredAt: requireInstant(audit["occurredAt"], "Configuration audit instant"),
    revision: requirePositiveInteger(audit["revision"], "Configuration audit revision"),
    changeSetId: requireSafeText(audit["changeSetId"], "Configuration audit change-set ID", 500),
    ...(audit["proposalId"] === undefined
      ? {}
      : {
          proposalId: requireSafeText(audit["proposalId"], "Configuration audit proposal ID", 500),
        }),
    ...(audit["rolledBackChangeSetId"] === undefined
      ? {}
      : {
          rolledBackChangeSetId: requireSafeText(
            audit["rolledBackChangeSetId"],
            "Configuration audit rollback target",
            500,
          ),
        }),
    diff: requireDiff(audit["diff"]),
  };
}

function decodeStoredReceipt(value: unknown, operationId: string): StoredConfigurationToolReceipt {
  const stored = requireRecord(value, "stored Configuration tool receipt");
  requireExactKeys(stored, ["requestDigest", "receipt"]);
  const requestDigest = requireDigest(stored["requestDigest"], "Configuration request digest");
  const receipt = requireReceipt(stored["receipt"]);
  if (receipt.operationId !== operationId || receipt.requestDigest !== requestDigest) {
    throw dataCorrupt("A stored Configuration tool receipt identity is inconsistent.");
  }
  return {
    requestDigest,
    receipt,
  };
}

function validateState(state: ConfigurationRepositoryState): void {
  if (!isNonNegativeInteger(state.revision)) {
    throw invalidInput("Configuration revision must be a non-negative safe integer.");
  }
  if (
    state.entries.size > MAXIMUM_COLLECTION_SIZE ||
    state.proposals.size > MAXIMUM_COLLECTION_SIZE ||
    state.changeSets.size > MAXIMUM_COLLECTION_SIZE ||
    state.audits.length > MAXIMUM_COLLECTION_SIZE ||
    state.toolReceipts.size > MAXIMUM_COLLECTION_SIZE
  ) {
    throw invalidInput("A Configuration state collection is unreasonably large.");
  }

  const identifiers = new Set<string>();
  for (const [key, entry] of state.entries) {
    const decoded = decodeEntry(entry, key);
    if (!isDeepStrictEqual(decoded, entry)) {
      throw invalidInput("A Configuration entry is outside the durable contract.");
    }
  }

  const changeSetsByRevision = new Map<number, StoredChangeSet>();
  for (const [id, stored] of state.changeSets) {
    const decoded = decodeStoredChangeSet(stored, id);
    if (
      decoded.revision > state.revision ||
      changeSetsByRevision.has(decoded.revision) ||
      !hasUniqueDiffTargets(decoded.diff) ||
      !isDeepStrictEqual(decoded, stored)
    ) {
      throw invalidInput("A Configuration change-set history is inconsistent.");
    }
    changeSetsByRevision.set(decoded.revision, stored);
    requireUniqueIdentifier(identifiers, id);
  }

  const replayedEntries = new Map<string, ConfigurationEntry>();
  const valueHistory = new Map<string, { readonly revision: number; readonly value: unknown }[]>();
  for (let revision = 1; revision <= state.revision; revision += 1) {
    const changeSet = changeSetsByRevision.get(revision);
    if (changeSet === undefined) {
      throw invalidInput("Configuration change-set revisions are not contiguous.");
    }
    for (const item of changeSet.diff) {
      const key = entryStorageKey(item.key, item.scope);
      const current = replayedEntries.get(key)?.value;
      if (!isDeepStrictEqual(current, item.before)) {
        throw invalidInput("Configuration change-set history cannot be replayed.");
      }
      if (item.after === undefined) {
        replayedEntries.delete(key);
      } else {
        replayedEntries.set(key, {
          key: item.key,
          scope: item.scope,
          value: item.after,
        });
      }
      const history = valueHistory.get(key) ?? [];
      history.push({ revision, value: item.after });
      valueHistory.set(key, history);
    }
  }
  if (
    replayedEntries.size !== state.entries.size ||
    [...state.entries].some(([key, entry]) => !isDeepStrictEqual(replayedEntries.get(key), entry))
  ) {
    throw invalidInput("Configuration entries disagree with committed change-set history.");
  }

  for (const [id, stored] of state.proposals) {
    const decoded = decodeStoredProposal(stored, id);
    if (
      decoded.proposal.baseRevision > state.revision ||
      !changesMatchDiff(decoded.proposal.changes, decoded.proposal.diff) ||
      decoded.proposal.diff.some(
        (item) =>
          !isDeepStrictEqual(
            valueAtRevision(
              valueHistory.get(entryStorageKey(item.key, item.scope)),
              decoded.proposal.baseRevision,
            ),
            item.before,
          ),
      ) ||
      (decoded.consumedAtRevision !== undefined &&
        decoded.consumedAtRevision !== decoded.proposal.baseRevision + 1) ||
      !isDeepStrictEqual(decoded, stored)
    ) {
      throw invalidInput("A Configuration proposal history is inconsistent.");
    }
    requireUniqueIdentifier(identifiers, id);
  }

  for (const changeSet of state.changeSets.values()) {
    if (
      changeSet.rolledBackBy !== undefined &&
      (!state.changeSets.has(changeSet.rolledBackBy) ||
        (state.changeSets.get(changeSet.rolledBackBy)?.revision ?? 0) <= changeSet.revision)
    ) {
      throw invalidInput("A Configuration rollback history references a missing change set.");
    }
  }

  const auditsById = new Map<string, ConfigurationAudit>();
  const auditsByChangeSetId = new Map<string, ConfigurationAudit>();
  let expectedAuditRevision = 1;
  for (const audit of state.audits) {
    const decoded = decodeAudit(audit);
    const matchingChangeSet = state.changeSets.get(decoded.changeSetId);
    const proposal =
      decoded.proposalId === undefined ? undefined : state.proposals.get(decoded.proposalId);
    const rolledBackChangeSet =
      decoded.rolledBackChangeSetId === undefined
        ? undefined
        : state.changeSets.get(decoded.rolledBackChangeSetId);
    if (
      decoded.revision !== expectedAuditRevision ||
      matchingChangeSet === undefined ||
      matchingChangeSet.revision !== decoded.revision ||
      !isDeepStrictEqual(matchingChangeSet.diff, decoded.diff) ||
      (decoded.action === "configuration.applied" &&
        (proposal === undefined ||
          proposal.consumedAtRevision !== decoded.revision ||
          proposal.proposal.reason !== decoded.reason ||
          !isDeepStrictEqual(proposal.proposal.diff, decoded.diff) ||
          decoded.rolledBackChangeSetId !== undefined)) ||
      (decoded.action === "configuration.rolled-back" &&
        (decoded.proposalId !== undefined ||
          rolledBackChangeSet === undefined ||
          rolledBackChangeSet.rolledBackBy !== decoded.changeSetId ||
          !isDeepStrictEqual(invertDiff(rolledBackChangeSet.diff), decoded.diff))) ||
      auditsByChangeSetId.has(decoded.changeSetId) ||
      !isDeepStrictEqual(decoded, audit)
    ) {
      throw invalidInput("A Configuration audit history is inconsistent.");
    }
    expectedAuditRevision += 1;
    auditsById.set(decoded.id, decoded);
    auditsByChangeSetId.set(decoded.changeSetId, decoded);
    requireUniqueIdentifier(identifiers, decoded.id);
  }
  for (const changeSet of state.changeSets.values()) {
    const rollbackAudit =
      changeSet.rolledBackBy === undefined
        ? undefined
        : auditsByChangeSetId.get(changeSet.rolledBackBy);
    if (
      changeSet.rolledBackBy !== undefined &&
      (rollbackAudit?.action !== "configuration.rolled-back" ||
        rollbackAudit.rolledBackChangeSetId !== changeSet.id)
    ) {
      throw invalidInput("A Configuration rollback link has no matching audit.");
    }
  }

  for (const [operationId, stored] of state.toolReceipts) {
    const decoded = decodeStoredReceipt(stored, operationId);
    if (!isDeepStrictEqual(decoded, stored)) {
      throw invalidInput("A Configuration tool receipt is outside the durable contract.");
    }
    validateReceiptReferences(decoded.receipt, state, auditsById, valueHistory);
    requireUniqueIdentifier(identifiers, decoded.receipt.receiptId);
  }
  if (state.audits.length !== state.revision) {
    throw invalidInput("Configuration audit revisions do not cover the committed state.");
  }
}

function validateReceiptReferences(
  receipt: ConfigurationToolReceipt,
  state: ConfigurationRepositoryState,
  auditsById: ReadonlyMap<string, ConfigurationAudit>,
  valueHistory: ReadonlyMap<
    string,
    readonly { readonly revision: number; readonly value: unknown }[]
  >,
): void {
  if (receipt.tool === "propose") {
    const stored = state.proposals.get(receipt.result.proposal.id);
    if (stored === undefined || !isDeepStrictEqual(stored.proposal, receipt.result.proposal)) {
      throw invalidInput("A Configuration proposal receipt has no matching durable proposal.");
    }
  }
  if (receipt.tool === "inspect" && receipt.result.revision > state.revision) {
    throw invalidInput("A Configuration inspection receipt has a future revision.");
  }
  if (
    receipt.tool === "validate" &&
    (receipt.result.baseRevision > state.revision ||
      !changesMatchDiff(receipt.result.changes, receipt.result.diff) ||
      receipt.result.diff.some(
        (item) =>
          !isDeepStrictEqual(
            valueAtRevision(
              valueHistory.get(entryStorageKey(item.key, item.scope)),
              receipt.result.baseRevision,
            ),
            item.before,
          ),
      ))
  ) {
    throw invalidInput("A Configuration validation receipt is inconsistent.");
  }
  if (receipt.tool === "diff") {
    const proposal = state.proposals.get(receipt.result.proposalId)?.proposal;
    if (
      proposal === undefined ||
      proposal.baseRevision !== receipt.result.baseRevision ||
      !isDeepStrictEqual(proposal.diff, receipt.result.diff)
    ) {
      throw invalidInput("A Configuration diff receipt has no matching durable proposal.");
    }
  }
  if (receipt.tool === "apply" || receipt.tool === "rollback") {
    const commit = receipt.result.commit;
    const changeSet = state.changeSets.get(commit.changeSetId);
    if (
      commit.revision > state.revision ||
      changeSet === undefined ||
      changeSet.revision !== commit.revision ||
      commit.audit.revision !== commit.revision ||
      commit.audit.changeSetId !== commit.changeSetId ||
      commit.audit.actor !== receipt.actor ||
      commit.audit.action !==
        (receipt.tool === "apply" ? "configuration.applied" : "configuration.rolled-back") ||
      !isDeepStrictEqual(auditsById.get(commit.audit.id), commit.audit)
    ) {
      throw invalidInput("A Configuration mutation receipt has no matching durable commit.");
    }
  }
}

function changesMatchDiff(
  changes: readonly ConfigurationChange[],
  diff: readonly ConfigurationDiff[],
): boolean {
  if (changes.length !== diff.length || !hasUniqueDiffTargets(diff)) {
    return false;
  }
  const targets = new Set<string>();
  return changes.every((change, index) => {
    const item = diff[index];
    const target = entryStorageKey(change.key, change.scope);
    if (
      item === undefined ||
      targets.has(target) ||
      item.key !== change.key ||
      !isDeepStrictEqual(item.scope, change.scope)
    ) {
      return false;
    }
    targets.add(target);
    return isDeepStrictEqual(item.after, change.operation === "set" ? change.value : undefined);
  });
}

function hasUniqueDiffTargets(diff: readonly ConfigurationDiff[]): boolean {
  const targets = new Set<string>();
  for (const item of diff) {
    const target = entryStorageKey(item.key, item.scope);
    if (targets.has(target)) {
      return false;
    }
    targets.add(target);
  }
  return true;
}

function valueAtRevision(
  history: readonly { readonly revision: number; readonly value: unknown }[] | undefined,
  revision: number,
): unknown {
  if (history === undefined) {
    return undefined;
  }
  let lower = 0;
  let upper = history.length - 1;
  let value: unknown;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const item = history[middle];
    if (item === undefined) {
      break;
    }
    if (item.revision <= revision) {
      value = item.value;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return value;
}

function invertDiff(diff: readonly ConfigurationDiff[]): readonly ConfigurationDiff[] {
  return [...diff].reverse().map((item) => ({
    key: item.key,
    scope: item.scope,
    before: item.after,
    after: item.before,
  }));
}

function requireProposal(value: unknown): ConfigurationProposal {
  const proposal = requireRecord(value, "Configuration proposal");
  requireExactKeys(proposal, [
    "id",
    "baseRevision",
    "actor",
    "reason",
    "createdAt",
    "changes",
    "diff",
  ]);
  const changes = requireChanges(proposal["changes"]);
  const diff = requireDiff(proposal["diff"]);
  if (changes.length !== diff.length) {
    throw dataCorrupt("A Configuration proposal diff length is inconsistent.");
  }
  return {
    id: requireSafeText(proposal["id"], "Configuration proposal ID", 500),
    baseRevision: requireNonNegativeInteger(
      proposal["baseRevision"],
      "Configuration proposal revision",
    ),
    actor: requireSafeText(proposal["actor"], "Configuration proposal actor", 500),
    reason: requireSafeText(proposal["reason"], "Configuration proposal reason", 500),
    createdAt: requireInstant(proposal["createdAt"], "Configuration proposal instant"),
    changes,
    diff,
  };
}

function requireChanges(value: unknown): readonly ConfigurationChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw dataCorrupt("A Configuration change list is invalid.");
  }
  return value.map((item) => {
    const change = requireRecord(item, "Configuration change");
    if (change["operation"] === "set") {
      requireExactKeys(change, ["operation", "key", "scope", "value"]);
      if (change["value"] === undefined) {
        throw dataCorrupt("A set Configuration change has no value.");
      }
      return {
        operation: "set" as const,
        key: requireSettingKey(change["key"]),
        scope: requireScope(change["scope"]),
        value: structuredClone(change["value"]),
      };
    }
    if (change["operation"] === "unset") {
      requireExactKeys(change, ["operation", "key", "scope"]);
      return {
        operation: "unset" as const,
        key: requireSettingKey(change["key"]),
        scope: requireScope(change["scope"]),
      };
    }
    throw dataCorrupt("A Configuration change operation is invalid.");
  });
}

function requireDiff(value: unknown): readonly ConfigurationDiff[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw dataCorrupt("A Configuration diff is invalid.");
  }
  return value.map((item) => {
    const diff = requireRecord(item, "Configuration diff");
    requireExactKeys(diff, ["key", "scope", "before", "after"]);
    return {
      key: requireSettingKey(diff["key"]),
      scope: requireScope(diff["scope"]),
      before: structuredClone(diff["before"]),
      after: structuredClone(diff["after"]),
    };
  });
}

function requireReceipt(value: unknown): ConfigurationToolReceipt {
  const receipt = requireRecord(value, "Configuration tool receipt");
  requireAllowedKeys(receipt, [
    "schemaVersion",
    "receiptId",
    "operationId",
    "requestDigest",
    "actor",
    "occurredAt",
    "tool",
    "result",
    "authorization",
  ]);
  if (
    receipt["schemaVersion"] !== 1 ||
    !["inspect", "validate", "propose", "diff", "apply", "rollback"].includes(
      String(receipt["tool"]),
    )
  ) {
    throw dataCorrupt("A Configuration tool receipt envelope is invalid.");
  }
  const tool = receipt["tool"] as ConfigurationToolReceipt["tool"];
  const common = {
    schemaVersion: 1 as const,
    receiptId: requireSafeText(receipt["receiptId"], "Configuration receipt ID", 500),
    operationId: requireSafeText(receipt["operationId"], "Configuration tool operation ID", 500),
    requestDigest: requireDigest(receipt["requestDigest"], "Configuration request digest"),
    actor: requireSafeText(receipt["actor"], "Configuration receipt actor", 500),
    occurredAt: requireInstant(receipt["occurredAt"], "Configuration receipt instant"),
  };
  const result = requireRecord(receipt["result"], "Configuration receipt result");

  if (tool === "inspect") {
    requireExactKeys(result, ["revision", "values"]);
    requireRecord(result["values"], "Configuration effective values");
    return {
      ...common,
      tool,
      result: {
        revision: requireNonNegativeInteger(result["revision"], "inspection revision"),
        values: structuredClone(result["values"]) as Extract<
          ConfigurationToolReceipt,
          { tool: "inspect" }
        >["result"]["values"],
      },
    };
  }
  if (tool === "validate") {
    requireExactKeys(result, ["baseRevision", "changes", "diff"]);
    return {
      ...common,
      tool,
      result: {
        baseRevision: requireNonNegativeInteger(result["baseRevision"], "validation revision"),
        changes: requireChanges(result["changes"]),
        diff: requireDiff(result["diff"]),
      },
    };
  }
  if (tool === "propose") {
    requireExactKeys(result, ["proposal"]);
    return {
      ...common,
      tool,
      result: {
        proposal: requireProposal(result["proposal"]),
      },
    };
  }
  if (tool === "diff") {
    requireExactKeys(result, ["proposalId", "baseRevision", "diff"]);
    return {
      ...common,
      tool,
      result: {
        proposalId: requireSafeText(result["proposalId"], "Configuration diff proposal ID", 500),
        baseRevision: requireNonNegativeInteger(
          result["baseRevision"],
          "Configuration diff revision",
        ),
        diff: requireDiff(result["diff"]),
      },
    };
  }

  requireExactKeys(result, ["commit"]);
  const authorization = requireRecord(
    receipt["authorization"],
    "Configuration mutation authorization",
  );
  requireAllowedKeys(authorization, ["decision", "authority", "decisionId"]);
  if (
    authorization["decision"] !== "allow" ||
    (authorization["authority"] !== "owner" && authorization["authority"] !== "policy")
  ) {
    throw dataCorrupt("A Configuration mutation receipt authorization is invalid.");
  }
  const authority = authorization["authority"] as "owner" | "policy";
  const allowedAuthorization = {
    decision: "allow" as const,
    authority,
    ...(authorization["decisionId"] === undefined
      ? {}
      : {
          decisionId: requireSafeText(
            authorization["decisionId"],
            "Configuration policy decision ID",
            500,
          ),
        }),
  };
  const commit = requireCommit(result["commit"]);
  return tool === "apply"
    ? { ...common, tool, authorization: allowedAuthorization, result: { commit } }
    : { ...common, tool, authorization: allowedAuthorization, result: { commit } };
}

function requireCommit(
  value: unknown,
): Extract<ConfigurationToolReceipt, { tool: "apply" }>["result"]["commit"] {
  const commit = requireRecord(value, "Configuration commit");
  requireExactKeys(commit, ["revision", "changeSetId", "audit"]);
  return {
    revision: requirePositiveInteger(commit["revision"], "Configuration commit revision"),
    changeSetId: requireSafeText(commit["changeSetId"], "Configuration commit change-set ID", 500),
    audit: decodeAudit(commit["audit"]),
  };
}

function requireScope(value: unknown): ConfigurationScope {
  const scope = requireRecord(value, "Configuration scope");
  requireExactKeys(scope, ["kind", "id"]);
  const kinds = [
    "instance",
    "main",
    "device",
    "agent-adapter",
    "transport",
    "channel-binding",
    "task-default",
    "artifact",
  ] as const;
  if (
    typeof scope["kind"] !== "string" ||
    !kinds.includes(scope["kind"] as (typeof kinds)[number])
  ) {
    throw dataCorrupt("A Configuration scope kind is invalid.");
  }
  return {
    kind: scope["kind"] as (typeof kinds)[number],
    id: requireSafeText(scope["id"], "Configuration scope ID", 200),
  };
}

function requireSettingKey(value: unknown): string {
  const key = requireSafeText(value, "Configuration setting key", 500);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(key)) {
    throw dataCorrupt("A Configuration setting key is invalid.");
  }
  return key;
}

function entryStorageKey(key: string, scope: ConfigurationScope): string {
  return `${key}\u0000${scope.kind}\u0000${scope.id}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw dataCorrupt(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw dataCorrupt("A Configuration state object has unexpected fields.");
  }
}

function requireAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw dataCorrupt("A Configuration state object has unexpected fields.");
  }
}

function requireArrayLength(value: readonly unknown[], length: number): void {
  if (value.length !== length) {
    throw dataCorrupt("A Configuration durable value has an invalid shape.");
  }
}

function requireSafeText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw dataCorrupt(`${label} is invalid.`);
  }
  return value;
}

function requireMapKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw dataCorrupt("A Configuration state map key is invalid.");
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw dataCorrupt(`${label} is invalid.`);
  }
  return value;
}

function requireInstant(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw dataCorrupt(`${label} is invalid.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!isNonNegativeInteger(value)) {
    throw dataCorrupt(`${label} is invalid.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw dataCorrupt(`${label} is invalid.`);
  }
  return value as number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireUniqueIdentifier(identifiers: Set<string>, id: string): void {
  if (identifiers.has(id)) {
    throw invalidInput("Configuration durable identifiers must be globally unique.");
  }
  identifiers.add(id);
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidInput(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError(
    "STORAGE_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function dataCorrupt(message: string, cause?: unknown): SqlStorageError {
  return new SqlStorageError("DATA_CORRUPT", message, cause === undefined ? undefined : { cause });
}
