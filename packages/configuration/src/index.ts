export type ConfigurationScopeKind =
  | "instance"
  | "main"
  | "device"
  | "agent-adapter"
  | "transport"
  | "channel-binding"
  | "task-default"
  | "artifact";

export interface ConfigurationScope {
  readonly kind: ConfigurationScopeKind;
  readonly id: string;
}

export interface ConfigurationContext {
  readonly instanceId: string;
  readonly mainId?: string;
  readonly deviceId?: string;
  readonly agentAdapterId?: string;
  readonly transportId?: string;
  readonly channelBindingId?: string;
  readonly taskDefaultId?: string;
  readonly artifactId?: string;
}

export interface ConfigurationDefinition {
  readonly key: string;
  readonly defaultValue: unknown;
  /**
   * Least-specific to most-specific precedence. A setting may only be written at
   * one of these scopes.
   */
  readonly scopes: readonly ConfigurationScopeKind[];
  readonly validate: (value: unknown) => boolean;
}

export type ConfigurationChange =
  | {
      readonly operation: "set";
      readonly key: string;
      readonly scope: ConfigurationScope;
      readonly value: unknown;
    }
  | {
      readonly operation: "unset";
      readonly key: string;
      readonly scope: ConfigurationScope;
    };

export interface ConfigurationCandidate {
  readonly scope: ConfigurationScope;
  readonly value: unknown;
}

export interface EffectiveConfigurationValue {
  readonly key: string;
  readonly value: unknown;
  readonly source: ConfigurationScope | "default";
  readonly inherited: boolean;
  readonly candidates: readonly ConfigurationCandidate[];
}

export interface ConfigurationDiff {
  readonly key: string;
  readonly scope: ConfigurationScope;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ConfigurationProposal {
  readonly id: string;
  readonly baseRevision: number;
  readonly actor: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly changes: readonly ConfigurationChange[];
  readonly diff: readonly ConfigurationDiff[];
}

export interface ConfigurationAudit {
  readonly id: string;
  readonly action: "configuration.applied" | "configuration.rolled-back";
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly revision: number;
  readonly changeSetId: string;
  readonly proposalId?: string;
  readonly rolledBackChangeSetId?: string;
  readonly diff: readonly ConfigurationDiff[];
}

export interface ConfigurationCommit {
  readonly revision: number;
  readonly changeSetId: string;
  readonly audit: ConfigurationAudit;
}

interface ConfigurationEntry {
  readonly key: string;
  readonly scope: ConfigurationScope;
  readonly value: unknown;
}

interface StoredProposal {
  readonly proposal: ConfigurationProposal;
  consumedAtRevision?: number;
}

interface StoredChangeSet {
  readonly id: string;
  readonly revision: number;
  readonly diff: readonly ConfigurationDiff[];
  rolledBackBy?: string;
}

interface ConfigurationRepositoryState {
  revision: number;
  readonly entries: Map<string, ConfigurationEntry>;
  readonly proposals: Map<string, StoredProposal>;
  readonly changeSets: Map<string, StoredChangeSet>;
  readonly audits: ConfigurationAudit[];
}

export interface ConfigurationRepository {
  read<T>(operation: (state: ReadonlyConfigurationState) => T): Promise<T>;
  transact<T>(operation: (state: ConfigurationRepositoryState) => T): Promise<T>;
}

export interface ReadonlyConfigurationState {
  readonly revision: number;
  readonly entries: ReadonlyMap<string, ConfigurationEntry>;
  readonly proposals: ReadonlyMap<string, Readonly<StoredProposal>>;
  readonly changeSets: ReadonlyMap<string, Readonly<StoredChangeSet>>;
  readonly audits: readonly ConfigurationAudit[];
}

export interface ConfigurationServiceOptions {
  readonly definitions: readonly ConfigurationDefinition[];
  readonly repository: ConfigurationRepository;
  readonly idSource: () => string;
  readonly clock: () => string;
}

export class ConfigurationError extends Error {
  readonly code:
    | "duplicate-definition"
    | "invalid-definition"
    | "unknown-setting"
    | "scope-not-allowed"
    | "invalid-scope"
    | "invalid-value"
    | "duplicate-target"
    | "empty-patch"
    | "no-effective-change"
    | "invalid-actor"
    | "invalid-reason"
    | "duplicate-id"
    | "proposal-not-found"
    | "proposal-consumed"
    | "revision-conflict"
    | "change-set-not-found"
    | "change-set-already-rolled-back"
    | "rollback-conflict";

  constructor(
    code:
      | "duplicate-definition"
      | "invalid-definition"
      | "unknown-setting"
      | "scope-not-allowed"
      | "invalid-scope"
      | "invalid-value"
      | "duplicate-target"
      | "empty-patch"
      | "no-effective-change"
      | "invalid-actor"
      | "invalid-reason"
      | "duplicate-id"
      | "proposal-not-found"
      | "proposal-consumed"
      | "revision-conflict"
      | "change-set-not-found"
      | "change-set-already-rolled-back"
      | "rollback-conflict",
    message: string,
  ) {
    super(message);
    this.name = "ConfigurationError";
    this.code = code;
  }
}

export class InMemoryConfigurationRepository implements ConfigurationRepository {
  readonly #state: ConfigurationRepositoryState = {
    revision: 0,
    entries: new Map(),
    proposals: new Map(),
    changeSets: new Map(),
    audits: [],
  };

  #writeTail: Promise<void> = Promise.resolve();

  async read<T>(operation: (state: ReadonlyConfigurationState) => T): Promise<T> {
    await this.#writeTail;
    return operation(this.#state);
  }

  async transact<T>(operation: (state: ConfigurationRepositoryState) => T): Promise<T> {
    const previous = this.#writeTail;
    let release: () => void = () => undefined;
    this.#writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const working = cloneState(this.#state);
    try {
      const result = operation(working);
      replaceState(this.#state, working);
      return result;
    } finally {
      release();
    }
  }
}

export class ConfigurationService {
  readonly #definitions: ReadonlyMap<string, ConfigurationDefinition>;
  readonly #repository: ConfigurationRepository;
  readonly #idSource: () => string;
  readonly #clock: () => string;

  constructor(options: ConfigurationServiceOptions) {
    this.#definitions = validateDefinitions(options.definitions);
    this.#repository = options.repository;
    this.#idSource = options.idSource;
    this.#clock = options.clock;
  }

  getRevision(): Promise<number> {
    return this.#repository.read((state) => state.revision);
  }

  inspect(
    context: ConfigurationContext,
  ): Promise<Readonly<Record<string, EffectiveConfigurationValue>>> {
    const scopeByKind = contextScopes(context);
    return this.#repository.read((state) => {
      const result: Record<string, EffectiveConfigurationValue> = {};
      for (const definition of this.#definitions.values()) {
        const candidates: ConfigurationCandidate[] = [];
        for (const kind of definition.scopes) {
          const scope = scopeByKind.get(kind);
          if (scope === undefined) {
            continue;
          }
          const entry = state.entries.get(entryKey(definition.key, scope));
          if (entry !== undefined) {
            candidates.push({
              scope: cloneScope(entry.scope),
              value: cloneValue(entry.value),
            });
          }
        }

        const selected = candidates.at(-1);
        result[definition.key] = {
          key: definition.key,
          value: cloneValue(selected === undefined ? definition.defaultValue : selected.value),
          source: selected === undefined ? "default" : cloneScope(selected.scope),
          inherited: selected !== undefined && selected.scope.kind !== definition.scopes.at(-1),
          candidates,
        };
      }
      return result;
    });
  }

  async propose(input: {
    readonly actor: string;
    readonly reason: string;
    readonly changes: readonly ConfigurationChange[];
  }): Promise<ConfigurationProposal> {
    validateNonempty(input.actor, "invalid-actor", "Configuration actor");
    validateNonempty(input.reason, "invalid-reason", "Configuration reason");
    const changes = this.#validateChanges(input.changes);
    const id = this.#nextId();
    const createdAt = this.#clock();

    return this.#repository.transact((state) => {
      assertUniqueId(state, id);
      const diff = changes.map((change) => {
        const current = state.entries.get(entryKey(change.key, change.scope));
        return {
          key: change.key,
          scope: cloneScope(change.scope),
          before: cloneValue(current?.value),
          after: change.operation === "set" ? cloneValue(change.value) : undefined,
        };
      });
      if (diff.every((item) => isDeepStrictEqual(item.before, item.after))) {
        throw new ConfigurationError(
          "no-effective-change",
          "The configuration proposal does not change any stored value.",
        );
      }
      const proposal: ConfigurationProposal = {
        id,
        baseRevision: state.revision,
        actor: input.actor.trim(),
        reason: input.reason.trim(),
        createdAt,
        changes,
        diff,
      };
      state.proposals.set(id, { proposal });
      return cloneProposal(proposal);
    });
  }

  apply(input: {
    readonly proposalId: string;
    readonly expectedRevision: number;
    readonly actor: string;
  }): Promise<ConfigurationCommit> {
    validateNonempty(input.actor, "invalid-actor", "Configuration actor");
    const changeSetId = this.#nextId();
    const auditId = this.#nextId();
    const occurredAt = this.#clock();

    return this.#repository.transact((state) => {
      assertUniqueId(state, changeSetId);
      assertUniqueId(state, auditId);
      assertRevision(state.revision, input.expectedRevision);
      const stored = state.proposals.get(input.proposalId);
      if (stored === undefined) {
        throw new ConfigurationError(
          "proposal-not-found",
          "The configuration proposal does not exist.",
        );
      }
      if (stored.consumedAtRevision !== undefined) {
        throw new ConfigurationError(
          "proposal-consumed",
          "The configuration proposal was already consumed.",
        );
      }
      if (stored.proposal.baseRevision !== state.revision) {
        throw new ConfigurationError(
          "revision-conflict",
          "The configuration proposal is based on an obsolete revision.",
        );
      }

      const diff = applyChanges(state.entries, stored.proposal.changes);
      const revision = state.revision + 1;
      state.revision = revision;
      stored.consumedAtRevision = revision;

      const changeSet: StoredChangeSet = {
        id: changeSetId,
        revision,
        diff,
      };
      state.changeSets.set(changeSetId, changeSet);

      const audit: ConfigurationAudit = {
        id: auditId,
        action: "configuration.applied",
        actor: input.actor.trim(),
        reason: stored.proposal.reason,
        occurredAt,
        revision,
        changeSetId,
        proposalId: stored.proposal.id,
        diff,
      };
      state.audits.push(audit);
      return {
        revision,
        changeSetId,
        audit: cloneAudit(audit),
      };
    });
  }

  rollback(input: {
    readonly changeSetId: string;
    readonly expectedRevision: number;
    readonly actor: string;
    readonly reason: string;
  }): Promise<ConfigurationCommit> {
    validateNonempty(input.actor, "invalid-actor", "Configuration actor");
    validateNonempty(input.reason, "invalid-reason", "Configuration reason");
    const rollbackChangeSetId = this.#nextId();
    const auditId = this.#nextId();
    const occurredAt = this.#clock();

    return this.#repository.transact((state) => {
      assertUniqueId(state, rollbackChangeSetId);
      assertUniqueId(state, auditId);
      assertRevision(state.revision, input.expectedRevision);
      const original = state.changeSets.get(input.changeSetId);
      if (original === undefined) {
        throw new ConfigurationError(
          "change-set-not-found",
          "The configuration change set does not exist.",
        );
      }
      if (original.rolledBackBy !== undefined) {
        throw new ConfigurationError(
          "change-set-already-rolled-back",
          "The configuration change set was already rolled back.",
        );
      }

      for (const item of original.diff) {
        const current = state.entries.get(entryKey(item.key, item.scope));
        if (!isDeepStrictEqual(current?.value, item.after)) {
          throw new ConfigurationError(
            "rollback-conflict",
            "A newer configuration change modified a rollback target.",
          );
        }
      }

      const inverseChanges = [...original.diff].reverse().map(diffToInverseChange);
      const diff = applyChanges(state.entries, inverseChanges);
      const revision = state.revision + 1;
      state.revision = revision;
      original.rolledBackBy = rollbackChangeSetId;
      state.changeSets.set(rollbackChangeSetId, {
        id: rollbackChangeSetId,
        revision,
        diff,
      });

      const audit: ConfigurationAudit = {
        id: auditId,
        action: "configuration.rolled-back",
        actor: input.actor.trim(),
        reason: input.reason.trim(),
        occurredAt,
        revision,
        changeSetId: rollbackChangeSetId,
        rolledBackChangeSetId: original.id,
        diff,
      };
      state.audits.push(audit);
      return {
        revision,
        changeSetId: rollbackChangeSetId,
        audit: cloneAudit(audit),
      };
    });
  }

  listAudit(): Promise<readonly ConfigurationAudit[]> {
    return this.#repository.read((state) => state.audits.map(cloneAudit));
  }

  #validateChanges(input: readonly ConfigurationChange[]): readonly ConfigurationChange[] {
    if (input.length === 0) {
      throw new ConfigurationError(
        "empty-patch",
        "A configuration proposal must contain at least one change.",
      );
    }

    const targets = new Set<string>();
    return input.map((change) => {
      const definition = this.#definitions.get(change.key);
      if (definition === undefined) {
        throw new ConfigurationError(
          "unknown-setting",
          `Unknown configuration setting: ${change.key}.`,
        );
      }
      validateScope(change.scope);
      if (!definition.scopes.includes(change.scope.kind)) {
        throw new ConfigurationError(
          "scope-not-allowed",
          `${change.key} cannot be configured at ${change.scope.kind} scope.`,
        );
      }
      const target = entryKey(change.key, change.scope);
      if (targets.has(target)) {
        throw new ConfigurationError(
          "duplicate-target",
          `The proposal changes ${change.key} at the same scope more than once.`,
        );
      }
      targets.add(target);

      if (change.operation === "set") {
        if (change.value === undefined || !definition.validate(change.value)) {
          throw new ConfigurationError("invalid-value", `The value for ${change.key} is invalid.`);
        }
        return {
          operation: "set",
          key: change.key,
          scope: cloneScope(change.scope),
          value: cloneValue(change.value),
        };
      }
      return {
        operation: "unset",
        key: change.key,
        scope: cloneScope(change.scope),
      };
    });
  }

  #nextId(): string {
    const id = this.#idSource();
    validateNonempty(id, "duplicate-id", "Generated configuration identifier");
    return id.trim();
  }
}

function validateDefinitions(
  definitions: readonly ConfigurationDefinition[],
): ReadonlyMap<string, ConfigurationDefinition> {
  const result = new Map<string, ConfigurationDefinition>();
  for (const definition of definitions) {
    if (
      definition.key.trim() !== definition.key ||
      !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(definition.key) ||
      definition.scopes.length === 0 ||
      new Set(definition.scopes).size !== definition.scopes.length ||
      !definition.validate(definition.defaultValue)
    ) {
      throw new ConfigurationError(
        "invalid-definition",
        `Invalid configuration definition: ${definition.key}.`,
      );
    }
    if (result.has(definition.key)) {
      throw new ConfigurationError(
        "duplicate-definition",
        `Duplicate configuration definition: ${definition.key}.`,
      );
    }
    result.set(definition.key, {
      ...definition,
      defaultValue: cloneValue(definition.defaultValue),
      scopes: [...definition.scopes],
    });
  }
  return result;
}

function contextScopes(
  context: ConfigurationContext,
): ReadonlyMap<ConfigurationScopeKind, ConfigurationScope> {
  validateScopeId(context.instanceId);
  const result = new Map<ConfigurationScopeKind, ConfigurationScope>([
    ["instance", { kind: "instance", id: context.instanceId }],
  ]);
  const optional: readonly [ConfigurationScopeKind, string | undefined][] = [
    ["main", context.mainId],
    ["device", context.deviceId],
    ["agent-adapter", context.agentAdapterId],
    ["transport", context.transportId],
    ["channel-binding", context.channelBindingId],
    ["task-default", context.taskDefaultId],
    ["artifact", context.artifactId],
  ];
  for (const [kind, id] of optional) {
    if (id !== undefined) {
      validateScopeId(id);
      result.set(kind, { kind, id });
    }
  }
  return result;
}

function validateScope(scope: ConfigurationScope): void {
  const validKinds: readonly ConfigurationScopeKind[] = [
    "instance",
    "main",
    "device",
    "agent-adapter",
    "transport",
    "channel-binding",
    "task-default",
    "artifact",
  ];
  if (!validKinds.includes(scope.kind)) {
    throw new ConfigurationError("invalid-scope", "Unknown configuration scope.");
  }
  validateScopeId(scope.id);
}

function validateScopeId(id: string): void {
  if (
    typeof id !== "string" ||
    id.trim() !== id ||
    id.length === 0 ||
    id.length > 200 ||
    containsControlCharacter(id)
  ) {
    throw new ConfigurationError(
      "invalid-scope",
      "Configuration scope identifiers must be nonempty canonical text.",
    );
  }
}

function validateNonempty(
  value: string,
  code: "invalid-actor" | "invalid-reason" | "duplicate-id",
  label: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 500 ||
    containsControlCharacter(value)
  ) {
    throw new ConfigurationError(code, `${label} must be nonempty safe text.`);
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function entryKey(key: string, scope: ConfigurationScope): string {
  return `${key}\u0000${scope.kind}\u0000${scope.id}`;
}

function cloneScope(scope: ConfigurationScope): ConfigurationScope {
  return { kind: scope.kind, id: scope.id };
}

function cloneValue(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function cloneProposal(proposal: ConfigurationProposal): ConfigurationProposal {
  return structuredClone(proposal);
}

function cloneAudit(audit: ConfigurationAudit): ConfigurationAudit {
  return structuredClone(audit);
}

function cloneState(state: ConfigurationRepositoryState): ConfigurationRepositoryState {
  return {
    revision: state.revision,
    entries: new Map(
      [...state.entries].map(([key, entry]) => [
        key,
        {
          key: entry.key,
          scope: cloneScope(entry.scope),
          value: cloneValue(entry.value),
        },
      ]),
    ),
    proposals: new Map(
      [...state.proposals].map(([id, stored]) => [
        id,
        {
          proposal: cloneProposal(stored.proposal),
          ...(stored.consumedAtRevision === undefined
            ? {}
            : { consumedAtRevision: stored.consumedAtRevision }),
        },
      ]),
    ),
    changeSets: new Map(
      [...state.changeSets].map(([id, changeSet]) => [id, structuredClone(changeSet)]),
    ),
    audits: state.audits.map(cloneAudit),
  };
}

function replaceState(
  target: ConfigurationRepositoryState,
  source: ConfigurationRepositoryState,
): void {
  target.revision = source.revision;
  target.entries.clear();
  for (const [key, value] of source.entries) {
    target.entries.set(key, value);
  }
  target.proposals.clear();
  for (const [key, value] of source.proposals) {
    target.proposals.set(key, value);
  }
  target.changeSets.clear();
  for (const [key, value] of source.changeSets) {
    target.changeSets.set(key, value);
  }
  target.audits.splice(0, target.audits.length, ...source.audits);
}

function assertUniqueId(state: ConfigurationRepositoryState, id: string): void {
  if (
    state.proposals.has(id) ||
    state.changeSets.has(id) ||
    state.audits.some((audit) => audit.id === id)
  ) {
    throw new ConfigurationError(
      "duplicate-id",
      "A generated configuration identifier was reused.",
    );
  }
}

function assertRevision(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) {
    throw new ConfigurationError(
      "revision-conflict",
      `Expected configuration revision ${expected}; current revision is ${actual}.`,
    );
  }
}

function applyChanges(
  entries: Map<string, ConfigurationEntry>,
  changes: readonly ConfigurationChange[],
): readonly ConfigurationDiff[] {
  return changes.map((change) => {
    const key = entryKey(change.key, change.scope);
    const before = entries.get(key)?.value;
    if (change.operation === "set") {
      entries.set(key, {
        key: change.key,
        scope: cloneScope(change.scope),
        value: cloneValue(change.value),
      });
    } else {
      entries.delete(key);
    }
    return {
      key: change.key,
      scope: cloneScope(change.scope),
      before: cloneValue(before),
      after: change.operation === "set" ? cloneValue(change.value) : undefined,
    };
  });
}

function diffToInverseChange(diff: ConfigurationDiff): ConfigurationChange {
  return diff.before === undefined
    ? {
        operation: "unset",
        key: diff.key,
        scope: cloneScope(diff.scope),
      }
    : {
        operation: "set",
        key: diff.key,
        scope: cloneScope(diff.scope),
        value: cloneValue(diff.before),
      };
}

export { STANDARD_CONFIGURATION_DEFINITIONS } from "./standard-definitions.ts";
import { isDeepStrictEqual } from "node:util";
