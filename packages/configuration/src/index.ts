import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  isNullableCanonicalMainSecretReferenceValue,
  type CanonicalMainSecretReferenceValue,
} from "./secret-reference.ts";

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
  /**
   * Marks a value as a Secret Store reference rather than ordinary
   * configuration data. Main-local references are revalidated against local
   * availability before proposal persistence and immediately before mutation.
   */
  readonly secretReference?: {
    readonly locality: "main";
  };
  readonly validate: (value: unknown) => boolean;
}

export interface ConfigurationSecretReferenceAvailabilityInput {
  readonly key: string;
  readonly locality: "main";
  readonly scope: ConfigurationScope;
  readonly secretRef: string;
}

export interface ConfigurationSecretReferenceAuthority {
  /**
   * Consults Main-local availability metadata only. Implementations must not
   * resolve or return the Secret value through this boundary.
   */
  isAvailable(input: ConfigurationSecretReferenceAvailabilityInput): boolean;
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

export type ConfigurationToolName =
  "inspect" | "validate" | "propose" | "diff" | "apply" | "rollback";

export type ConfigurationToolRequest =
  | {
      readonly tool: "inspect";
    }
  | {
      readonly tool: "validate";
      readonly expectedRevision: number;
      readonly changes: readonly ConfigurationChange[];
    }
  | {
      readonly tool: "propose";
      readonly expectedRevision: number;
      readonly reason: string;
      readonly changes: readonly ConfigurationChange[];
    }
  | {
      readonly tool: "diff";
      readonly proposalId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly tool: "apply";
      readonly proposalId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly tool: "rollback";
      readonly changeSetId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    };

export type ConfigurationMutationAuthorization =
  | {
      readonly decision: "allow";
      readonly authority: "owner" | "policy";
      readonly decisionId?: string;
    }
  | {
      readonly decision: "deny" | "require-approval";
      readonly code: string;
    };

export interface ConfigurationMutationAuthorizationInput {
  readonly actor: string;
  readonly context: ConfigurationContext;
  readonly tool: "apply" | "rollback";
  readonly reason: string;
  readonly diff: readonly ConfigurationDiff[];
  readonly proposalId?: string;
  readonly changeSetId?: string;
}

export type ConfigurationMutationAuthorizer = (
  input: ConfigurationMutationAuthorizationInput,
) => ConfigurationMutationAuthorization;

interface ConfigurationToolReceiptBase {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly actor: string;
  readonly occurredAt: string;
}

export type ConfigurationToolReceipt =
  | (ConfigurationToolReceiptBase & {
      readonly tool: "inspect";
      readonly result: {
        readonly revision: number;
        readonly values: Readonly<Record<string, EffectiveConfigurationValue>>;
      };
    })
  | (ConfigurationToolReceiptBase & {
      readonly tool: "validate";
      readonly result: {
        readonly baseRevision: number;
        readonly changes: readonly ConfigurationChange[];
        readonly diff: readonly ConfigurationDiff[];
      };
    })
  | (ConfigurationToolReceiptBase & {
      readonly tool: "propose";
      readonly result: {
        readonly proposal: ConfigurationProposal;
      };
    })
  | (ConfigurationToolReceiptBase & {
      readonly tool: "diff";
      readonly result: {
        readonly proposalId: string;
        readonly baseRevision: number;
        readonly diff: readonly ConfigurationDiff[];
      };
    })
  | (ConfigurationToolReceiptBase & {
      readonly tool: "apply";
      readonly authorization: Extract<ConfigurationMutationAuthorization, { decision: "allow" }>;
      readonly result: {
        readonly commit: ConfigurationCommit;
      };
    })
  | (ConfigurationToolReceiptBase & {
      readonly tool: "rollback";
      readonly authorization: Extract<ConfigurationMutationAuthorization, { decision: "allow" }>;
      readonly result: {
        readonly commit: ConfigurationCommit;
      };
    });

export interface ExecuteConfigurationToolInput {
  readonly operationId: string;
  readonly actor: string;
  readonly context: ConfigurationContext;
  readonly request: ConfigurationToolRequest;
  readonly authorizeMutation: ConfigurationMutationAuthorizer;
}

export interface ConfigurationEntry {
  readonly key: string;
  readonly scope: ConfigurationScope;
  readonly value: unknown;
}

export interface StoredProposal {
  readonly proposal: ConfigurationProposal;
  consumedAtRevision?: number;
}

export interface StoredChangeSet {
  readonly id: string;
  readonly revision: number;
  readonly diff: readonly ConfigurationDiff[];
  rolledBackBy?: string;
}

export interface StoredConfigurationToolReceipt {
  readonly requestDigest: string;
  readonly receipt: ConfigurationToolReceipt;
}

export interface ConfigurationRepositoryState {
  revision: number;
  readonly entries: Map<string, ConfigurationEntry>;
  readonly proposals: Map<string, StoredProposal>;
  readonly changeSets: Map<string, StoredChangeSet>;
  readonly audits: ConfigurationAudit[];
  readonly toolReceipts: Map<string, StoredConfigurationToolReceipt>;
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
  readonly toolReceipts: ReadonlyMap<string, Readonly<StoredConfigurationToolReceipt>>;
}

export interface ConfigurationServiceOptions {
  readonly definitions: readonly ConfigurationDefinition[];
  readonly repository: ConfigurationRepository;
  readonly idSource: () => string;
  readonly clock: () => string;
  readonly secretReferenceAuthority?: ConfigurationSecretReferenceAuthority;
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
    | "rollback-conflict"
    | "scope-outside-context"
    | "secret-reference-unavailable"
    | "invalid-tool-request"
    | "tool-idempotency-conflict"
    | "mutation-authorization-unavailable"
    | "mutation-denied"
    | "mutation-requires-approval";

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
      | "rollback-conflict"
      | "scope-outside-context"
      | "secret-reference-unavailable"
      | "invalid-tool-request"
      | "tool-idempotency-conflict"
      | "mutation-authorization-unavailable"
      | "mutation-denied"
      | "mutation-requires-approval",
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
    toolReceipts: new Map(),
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
  readonly #secretReferenceAuthority: ConfigurationSecretReferenceAuthority | undefined;

  constructor(options: ConfigurationServiceOptions) {
    this.#definitions = validateDefinitions(options.definitions);
    this.#repository = options.repository;
    this.#idSource = options.idSource;
    this.#clock = options.clock;
    if (
      options.secretReferenceAuthority !== undefined &&
      (options.secretReferenceAuthority === null ||
        typeof options.secretReferenceAuthority !== "object" ||
        typeof options.secretReferenceAuthority.isAvailable !== "function")
    ) {
      throw new TypeError("The Configuration Secret reference authority is invalid.");
    }
    this.#secretReferenceAuthority = options.secretReferenceAuthority;
  }

  getRevision(): Promise<number> {
    return this.#repository.read((state) => state.revision);
  }

  inspect(
    context: ConfigurationContext,
  ): Promise<Readonly<Record<string, EffectiveConfigurationValue>>> {
    const scopeByKind = contextScopes(context);
    return this.#repository.read((state) =>
      inspectConfiguration(this.#definitions, scopeByKind, state),
    );
  }

  executeTool(input: ExecuteConfigurationToolInput): Promise<ConfigurationToolReceipt> {
    validateNonempty(input.operationId, "invalid-tool-request", "Configuration tool operation ID");
    validateNonempty(input.actor, "invalid-actor", "Configuration actor");
    if (typeof input.authorizeMutation !== "function") {
      throw new ConfigurationError(
        "mutation-authorization-unavailable",
        "Configuration mutation authorization is unavailable.",
      );
    }
    const context = cloneConfigurationContext(input.context);
    const scopeByKind = contextScopes(context);
    const request = cloneToolRequest(input.request);
    const requestDigest = configurationToolRequestDigest({
      actor: input.actor.trim(),
      context,
      request,
    });

    return this.#repository.transact((state) => {
      const stored = state.toolReceipts.get(input.operationId);
      if (stored !== undefined) {
        if (stored.requestDigest !== requestDigest) {
          throw new ConfigurationError(
            "tool-idempotency-conflict",
            "The Configuration Agent tool operation ID was reused for different input.",
          );
        }
        return cloneToolReceipt(stored.receipt);
      }

      const actor = input.actor.trim();
      const reservedIds = new Set<string>();
      let outcome:
        | {
            readonly tool: "inspect";
            readonly result: Extract<ConfigurationToolReceipt, { tool: "inspect" }>["result"];
          }
        | {
            readonly tool: "validate";
            readonly result: Extract<ConfigurationToolReceipt, { tool: "validate" }>["result"];
          }
        | {
            readonly tool: "propose";
            readonly result: Extract<ConfigurationToolReceipt, { tool: "propose" }>["result"];
          }
        | {
            readonly tool: "diff";
            readonly result: Extract<ConfigurationToolReceipt, { tool: "diff" }>["result"];
          }
        | {
            readonly tool: "apply";
            readonly authorization: Extract<
              ConfigurationMutationAuthorization,
              { decision: "allow" }
            >;
            readonly result: Extract<ConfigurationToolReceipt, { tool: "apply" }>["result"];
          }
        | {
            readonly tool: "rollback";
            readonly authorization: Extract<
              ConfigurationMutationAuthorization,
              { decision: "allow" }
            >;
            readonly result: Extract<ConfigurationToolReceipt, { tool: "rollback" }>["result"];
          };

      switch (request.tool) {
        case "inspect": {
          outcome = {
            tool: request.tool,
            result: {
              revision: state.revision,
              values: inspectConfiguration(this.#definitions, scopeByKind, state),
            },
          };
          break;
        }
        case "validate": {
          assertRevision(state.revision, request.expectedRevision);
          const changes = this.#validateChanges(request.changes);
          assertChangesWithinContext(changes, scopeByKind);
          outcome = {
            tool: request.tool,
            result: {
              baseRevision: state.revision,
              changes,
              diff: calculateDiff(state.entries, changes),
            },
          };
          break;
        }
        case "propose": {
          assertRevision(state.revision, request.expectedRevision);
          validateNonempty(request.reason, "invalid-reason", "Configuration reason");
          const changes = this.#validateChanges(request.changes);
          assertChangesWithinContext(changes, scopeByKind);
          const diff = calculateDiff(state.entries, changes);
          assertEffectiveDiff(diff);
          const proposal: ConfigurationProposal = {
            id: this.#nextToolId(state, reservedIds),
            baseRevision: state.revision,
            actor,
            reason: request.reason.trim(),
            createdAt: this.#clock(),
            changes,
            diff,
          };
          state.proposals.set(proposal.id, { proposal });
          outcome = {
            tool: request.tool,
            result: {
              proposal: cloneProposal(proposal),
            },
          };
          break;
        }
        case "diff": {
          assertRevision(state.revision, request.expectedRevision);
          const storedProposal = requireApplicableProposal(state, request.proposalId);
          assertChangesWithinContext(storedProposal.proposal.changes, scopeByKind);
          outcome = {
            tool: request.tool,
            result: {
              proposalId: storedProposal.proposal.id,
              baseRevision: storedProposal.proposal.baseRevision,
              diff: structuredClone(storedProposal.proposal.diff),
            },
          };
          break;
        }
        case "apply": {
          assertRevision(state.revision, request.expectedRevision);
          const storedProposal = requireApplicableProposal(state, request.proposalId);
          assertChangesWithinContext(storedProposal.proposal.changes, scopeByKind);
          this.#assertSecretReferencesAvailable(storedProposal.proposal.changes);
          const authorization = requireAllowedMutation(
            input.authorizeMutation({
              actor,
              context,
              tool: "apply",
              reason: storedProposal.proposal.reason,
              diff: structuredClone(storedProposal.proposal.diff),
              proposalId: storedProposal.proposal.id,
            }),
          );
          this.#assertSecretReferencesAvailable(storedProposal.proposal.changes);
          const diff = applyChanges(state.entries, storedProposal.proposal.changes);
          const revision = state.revision + 1;
          state.revision = revision;
          storedProposal.consumedAtRevision = revision;
          const changeSetId = this.#nextToolId(state, reservedIds);
          const changeSet: StoredChangeSet = {
            id: changeSetId,
            revision,
            diff,
          };
          state.changeSets.set(changeSetId, changeSet);
          const audit: ConfigurationAudit = {
            id: this.#nextToolId(state, reservedIds),
            action: "configuration.applied",
            actor,
            reason: storedProposal.proposal.reason,
            occurredAt: this.#clock(),
            revision,
            changeSetId,
            proposalId: storedProposal.proposal.id,
            diff,
          };
          state.audits.push(audit);
          outcome = {
            tool: request.tool,
            authorization,
            result: {
              commit: {
                revision,
                changeSetId,
                audit: cloneAudit(audit),
              },
            },
          };
          break;
        }
        case "rollback": {
          assertRevision(state.revision, request.expectedRevision);
          validateNonempty(request.reason, "invalid-reason", "Configuration reason");
          const original = requireRollbackChangeSet(state, request.changeSetId);
          assertDiffWithinContext(original.diff, scopeByKind);
          assertRollbackTargetsCurrent(state.entries, original.diff);
          const inverseChanges = [...original.diff].reverse().map(diffToInverseChange);
          this.#assertSecretReferencesAvailable(inverseChanges);
          const preview = calculateDiff(state.entries, inverseChanges);
          const authorization = requireAllowedMutation(
            input.authorizeMutation({
              actor,
              context,
              tool: "rollback",
              reason: request.reason.trim(),
              diff: preview,
              changeSetId: original.id,
            }),
          );
          this.#assertSecretReferencesAvailable(inverseChanges);
          const diff = applyChanges(state.entries, inverseChanges);
          const revision = state.revision + 1;
          state.revision = revision;
          const rollbackChangeSetId = this.#nextToolId(state, reservedIds);
          original.rolledBackBy = rollbackChangeSetId;
          state.changeSets.set(rollbackChangeSetId, {
            id: rollbackChangeSetId,
            revision,
            diff,
          });
          const audit: ConfigurationAudit = {
            id: this.#nextToolId(state, reservedIds),
            action: "configuration.rolled-back",
            actor,
            reason: request.reason.trim(),
            occurredAt: this.#clock(),
            revision,
            changeSetId: rollbackChangeSetId,
            rolledBackChangeSetId: original.id,
            diff,
          };
          state.audits.push(audit);
          outcome = {
            tool: request.tool,
            authorization,
            result: {
              commit: {
                revision,
                changeSetId: rollbackChangeSetId,
                audit: cloneAudit(audit),
              },
            },
          };
          break;
        }
      }

      const receiptId = this.#nextToolId(state, reservedIds);
      const common = {
        schemaVersion: 1 as const,
        receiptId,
        operationId: input.operationId.trim(),
        requestDigest,
        actor,
        occurredAt: this.#clock(),
      };
      const receipt = {
        ...common,
        ...outcome,
      } as ConfigurationToolReceipt;
      state.toolReceipts.set(input.operationId, {
        requestDigest,
        receipt: cloneToolReceipt(receipt),
      });
      return cloneToolReceipt(receipt);
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

      this.#assertSecretReferencesAvailable(stored.proposal.changes);
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
      this.#assertSecretReferencesAvailable(inverseChanges);
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
    const changes = input.map((change): ConfigurationChange => {
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
    this.#assertSecretReferencesAvailable(changes);
    return changes;
  }

  #assertSecretReferencesAvailable(changes: readonly ConfigurationChange[]): void {
    for (const change of changes) {
      if (change.operation !== "set") {
        continue;
      }
      const definition = this.#definitions.get(change.key);
      if (definition === undefined) {
        throw new ConfigurationError(
          "unknown-setting",
          "A stored configuration change references an unknown setting.",
        );
      }
      const metadata = definition.secretReference;
      if (metadata === undefined) {
        if (hasSecretReferenceField(change.value)) {
          throw new ConfigurationError("invalid-value", `The value for ${change.key} is invalid.`);
        }
        continue;
      }
      if (!isNullableCanonicalMainSecretReferenceValue(change.value)) {
        throw new ConfigurationError("invalid-value", `The value for ${change.key} is invalid.`);
      }
      if (change.value === null) {
        continue;
      }
      if (change.scope.kind !== metadata.locality) {
        throw new ConfigurationError(
          "secret-reference-unavailable",
          "The Configuration Secret reference is unavailable on its required Main scope.",
        );
      }
      const authority = this.#secretReferenceAuthority;
      let available = false;
      if (authority !== undefined) {
        try {
          available =
            authority.isAvailable(
              Object.freeze({
                key: change.key,
                locality: metadata.locality,
                scope: Object.freeze(cloneScope(change.scope)),
                secretRef: (change.value as CanonicalMainSecretReferenceValue).secretRef,
              }),
            ) === true;
        } catch {
          available = false;
        }
      }
      if (!available) {
        throw new ConfigurationError(
          "secret-reference-unavailable",
          "The Configuration Secret reference is unavailable on its required Main scope.",
        );
      }
    }
  }

  #nextId(): string {
    const id = this.#idSource();
    validateNonempty(id, "duplicate-id", "Generated configuration identifier");
    return id.trim();
  }

  #nextToolId(state: ConfigurationRepositoryState, reservedIds: Set<string>): string {
    const id = this.#nextId();
    assertUniqueId(state, id);
    if (reservedIds.has(id)) {
      throw new ConfigurationError(
        "duplicate-id",
        "A generated configuration identifier was reused.",
      );
    }
    reservedIds.add(id);
    return id;
  }
}

function inspectConfiguration(
  definitions: ReadonlyMap<string, ConfigurationDefinition>,
  scopeByKind: ReadonlyMap<ConfigurationScopeKind, ConfigurationScope>,
  state: ReadonlyConfigurationState,
): Readonly<Record<string, EffectiveConfigurationValue>> {
  const result: Record<string, EffectiveConfigurationValue> = {};
  for (const definition of definitions.values()) {
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
}

function cloneConfigurationContext(context: ConfigurationContext): ConfigurationContext {
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    throw new ConfigurationError(
      "invalid-tool-request",
      "The Configuration Agent context is invalid.",
    );
  }
  return {
    instanceId: context.instanceId,
    ...(context.mainId === undefined ? {} : { mainId: context.mainId }),
    ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
    ...(context.agentAdapterId === undefined ? {} : { agentAdapterId: context.agentAdapterId }),
    ...(context.transportId === undefined ? {} : { transportId: context.transportId }),
    ...(context.channelBindingId === undefined
      ? {}
      : { channelBindingId: context.channelBindingId }),
    ...(context.taskDefaultId === undefined ? {} : { taskDefaultId: context.taskDefaultId }),
    ...(context.artifactId === undefined ? {} : { artifactId: context.artifactId }),
  };
}

function cloneToolRequest(request: ConfigurationToolRequest): ConfigurationToolRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ConfigurationError(
      "invalid-tool-request",
      "The Configuration Agent tool request is invalid.",
    );
  }
  switch (request.tool) {
    case "inspect":
      return { tool: request.tool };
    case "validate":
      return {
        tool: request.tool,
        expectedRevision: request.expectedRevision,
        changes: structuredClone(request.changes),
      };
    case "propose":
      return {
        tool: request.tool,
        expectedRevision: request.expectedRevision,
        reason: request.reason,
        changes: structuredClone(request.changes),
      };
    case "diff":
      return {
        tool: request.tool,
        proposalId: request.proposalId,
        expectedRevision: request.expectedRevision,
      };
    case "apply":
      return {
        tool: request.tool,
        proposalId: request.proposalId,
        expectedRevision: request.expectedRevision,
      };
    case "rollback":
      return {
        tool: request.tool,
        changeSetId: request.changeSetId,
        expectedRevision: request.expectedRevision,
        reason: request.reason,
      };
    default:
      throw new ConfigurationError(
        "invalid-tool-request",
        "The Configuration Agent tool request is invalid.",
      );
  }
}

function calculateDiff(
  entries: ReadonlyMap<string, ConfigurationEntry>,
  changes: readonly ConfigurationChange[],
): readonly ConfigurationDiff[] {
  return changes.map((change) => ({
    key: change.key,
    scope: cloneScope(change.scope),
    before: cloneValue(entries.get(entryKey(change.key, change.scope))?.value),
    after: change.operation === "set" ? cloneValue(change.value) : undefined,
  }));
}

function assertEffectiveDiff(diff: readonly ConfigurationDiff[]): void {
  if (diff.every((item) => isDeepStrictEqual(item.before, item.after))) {
    throw new ConfigurationError(
      "no-effective-change",
      "The configuration proposal does not change any stored value.",
    );
  }
}

function assertChangesWithinContext(
  changes: readonly ConfigurationChange[],
  scopeByKind: ReadonlyMap<ConfigurationScopeKind, ConfigurationScope>,
): void {
  for (const change of changes) {
    const available = scopeByKind.get(change.scope.kind);
    if (available === undefined || available.id !== change.scope.id) {
      throw new ConfigurationError(
        "scope-outside-context",
        "A Configuration Agent tool cannot modify a scope outside its target context.",
      );
    }
  }
}

function assertDiffWithinContext(
  diff: readonly ConfigurationDiff[],
  scopeByKind: ReadonlyMap<ConfigurationScopeKind, ConfigurationScope>,
): void {
  for (const item of diff) {
    const available = scopeByKind.get(item.scope.kind);
    if (available === undefined || available.id !== item.scope.id) {
      throw new ConfigurationError(
        "scope-outside-context",
        "A Configuration Agent tool cannot modify a scope outside its target context.",
      );
    }
  }
}

function requireApplicableProposal(
  state: ConfigurationRepositoryState,
  proposalId: string,
): StoredProposal {
  validateNonempty(proposalId, "invalid-tool-request", "Configuration proposal ID");
  const stored = state.proposals.get(proposalId);
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
  return stored;
}

function requireRollbackChangeSet(
  state: ConfigurationRepositoryState,
  changeSetId: string,
): StoredChangeSet {
  validateNonempty(changeSetId, "invalid-tool-request", "Configuration change-set ID");
  const original = state.changeSets.get(changeSetId);
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
  return original;
}

function assertRollbackTargetsCurrent(
  entries: ReadonlyMap<string, ConfigurationEntry>,
  diff: readonly ConfigurationDiff[],
): void {
  for (const item of diff) {
    const current = entries.get(entryKey(item.key, item.scope));
    if (!isDeepStrictEqual(current?.value, item.after)) {
      throw new ConfigurationError(
        "rollback-conflict",
        "A newer configuration change modified a rollback target.",
      );
    }
  }
}

function requireAllowedMutation(
  authorization: ConfigurationMutationAuthorization,
): Extract<ConfigurationMutationAuthorization, { decision: "allow" }> {
  if (authorization === null || typeof authorization !== "object") {
    throw new ConfigurationError(
      "mutation-authorization-unavailable",
      "Configuration mutation authorization is unavailable.",
    );
  }
  if (authorization.decision === "deny") {
    validateAuthorizationCode(authorization.code);
    throw new ConfigurationError(
      "mutation-denied",
      `Configuration mutation denied by executable policy (${authorization.code}).`,
    );
  }
  if (authorization.decision === "require-approval") {
    validateAuthorizationCode(authorization.code);
    throw new ConfigurationError(
      "mutation-requires-approval",
      `Configuration mutation requires owner approval (${authorization.code}).`,
    );
  }
  if (
    authorization.decision !== "allow" ||
    (authorization.authority !== "owner" && authorization.authority !== "policy") ||
    (authorization.decisionId !== undefined && !isCanonicalSafeText(authorization.decisionId, 500))
  ) {
    throw new ConfigurationError(
      "mutation-authorization-unavailable",
      "Configuration mutation authorization is invalid.",
    );
  }
  return structuredClone(authorization);
}

function validateAuthorizationCode(code: string): void {
  if (!isCanonicalSafeText(code, 160) || !/^[A-Z][A-Z0-9_]*$/u.test(code)) {
    throw new ConfigurationError(
      "mutation-authorization-unavailable",
      "Configuration mutation authorization is invalid.",
    );
  }
}

function configurationToolRequestDigest(input: {
  readonly actor: string;
  readonly context: ConfigurationContext;
  readonly request: ConfigurationToolRequest;
}): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ConfigurationError(
        "invalid-tool-request",
        "The Configuration Agent tool request is invalid.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value === undefined || typeof value !== "object") {
    throw new ConfigurationError(
      "invalid-tool-request",
      "The Configuration Agent tool request is invalid.",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigurationError(
      "invalid-tool-request",
      "The Configuration Agent tool request is invalid.",
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function cloneToolReceipt(receipt: ConfigurationToolReceipt): ConfigurationToolReceipt {
  return structuredClone(receipt);
}

function validateDefinitions(
  definitions: readonly ConfigurationDefinition[],
): ReadonlyMap<string, ConfigurationDefinition> {
  const result = new Map<string, ConfigurationDefinition>();
  for (const definition of definitions) {
    const secretReference = validateSecretReferenceDefinition(definition);
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
      ...(secretReference === undefined ? {} : { secretReference }),
    });
  }
  return result;
}

function validateSecretReferenceDefinition(
  definition: ConfigurationDefinition,
): ConfigurationDefinition["secretReference"] {
  const metadata = definition.secretReference;
  if (metadata === undefined) {
    return undefined;
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).length !== 1 ||
    metadata.locality !== "main" ||
    definition.defaultValue !== null ||
    definition.scopes.length !== 1 ||
    definition.scopes[0] !== "main" ||
    !definition.validate({
      secretRef: "secret://main/configuration-definition-probe",
    })
  ) {
    throw new ConfigurationError(
      "invalid-definition",
      `Invalid Secret reference definition: ${definition.key}.`,
    );
  }
  return Object.freeze({ locality: "main" });
}

function hasSecretReferenceField(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "secretRef")
  );
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
  code: "invalid-actor" | "invalid-reason" | "duplicate-id" | "invalid-tool-request",
  label: string,
): void {
  if (!isCanonicalSafeText(value, 500)) {
    throw new ConfigurationError(code, `${label} must be nonempty safe text.`);
  }
}

function isCanonicalSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsControlCharacter(value)
  );
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
    toolReceipts: new Map(
      [...state.toolReceipts].map(([operationId, stored]) => [
        operationId,
        {
          requestDigest: stored.requestDigest,
          receipt: cloneToolReceipt(stored.receipt),
        },
      ]),
    ),
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
  target.toolReceipts.clear();
  for (const [key, value] of source.toolReceipts) {
    target.toolReceipts.set(key, value);
  }
}

function assertUniqueId(state: ConfigurationRepositoryState, id: string): void {
  if (
    state.proposals.has(id) ||
    state.changeSets.has(id) ||
    state.audits.some((audit) => audit.id === id) ||
    [...state.toolReceipts.values()].some((stored) => stored.receipt.receiptId === id)
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
export {
  isCanonicalMainSecretReference,
  isNullableCanonicalMainSecretReferenceValue,
  type CanonicalMainSecretReferenceValue,
} from "./secret-reference.ts";
