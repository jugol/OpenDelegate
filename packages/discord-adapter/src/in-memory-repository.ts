import { DiscordAdapterError } from "./errors.ts";
import type {
  DiscordGatewayCursor,
  DiscordInboundRecord,
  DiscordOutboxItem,
  DiscordRepositorySnapshot,
  DiscordStateRepository,
  DiscordTaskBinding,
} from "./contracts.ts";

export class InMemoryDiscordStateRepository implements DiscordStateRepository {
  #cursor: DiscordGatewayCursor | undefined;
  readonly #bindingsByThread = new Map<string, DiscordTaskBinding>();
  readonly #threadByTask = new Map<string, string>();
  readonly #inbound = new Map<string, DiscordInboundRecord>();
  readonly #outbox = new Map<string, DiscordOutboxItem>();

  constructor(snapshot?: DiscordRepositorySnapshot) {
    if (snapshot === undefined) {
      return;
    }
    if (snapshot.version !== 1) {
      throw new DiscordAdapterError("PERSISTENCE_CONFLICT", "Unsupported Discord state version.");
    }
    this.#cursor = snapshot.cursor === undefined ? undefined : frozenClone(snapshot.cursor);
    for (const binding of snapshot.bindings) {
      this.#restoreBinding(binding);
    }
    for (const record of snapshot.inbound) {
      if (this.#inbound.has(record.key)) {
        throw persistenceConflict();
      }
      this.#inbound.set(record.key, frozenClone(record));
    }
    for (const item of snapshot.outbox) {
      if (this.#outbox.has(item.id)) {
        throw persistenceConflict();
      }
      this.#outbox.set(item.id, frozenClone(item));
    }
  }

  async getGatewayCursor(): Promise<DiscordGatewayCursor | undefined> {
    return this.#cursor === undefined ? undefined : frozenClone(this.#cursor);
  }

  async saveGatewayCursor(cursor: DiscordGatewayCursor): Promise<void> {
    validateCursor(cursor);
    const current = this.#cursor;
    if (
      current !== undefined &&
      current.sessionId === cursor.sessionId &&
      cursor.sequence < current.sequence
    ) {
      return;
    }
    if (
      current !== undefined &&
      current.sessionId !== cursor.sessionId &&
      cursor.updatedAtMs < current.updatedAtMs
    ) {
      return;
    }
    this.#cursor = frozenClone(cursor);
  }

  async claimInbound(input: { key: string; digest: string; nowMs: number }): Promise<{
    readonly outcome: "new" | "pending" | "completed";
    readonly record: DiscordInboundRecord;
  }> {
    assertKey(input.key);
    assertDigest(input.digest);
    assertTimestamp(input.nowMs);
    const current = this.#inbound.get(input.key);
    if (current !== undefined) {
      if (current.digest !== input.digest) {
        throw new DiscordAdapterError(
          "IDEMPOTENCY_CONFLICT",
          "A Discord inbound key was reused with different content.",
        );
      }
      return {
        outcome: current.state,
        record: frozenClone(current),
      };
    }
    const created: DiscordInboundRecord = Object.freeze({
      key: input.key,
      digest: input.digest,
      state: "pending",
      acknowledged: false,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    });
    this.#inbound.set(input.key, created);
    return { outcome: "new", record: frozenClone(created) };
  }

  async acknowledgeInbound(input: {
    key: string;
    responseRef: string;
    nowMs: number;
  }): Promise<DiscordInboundRecord> {
    const current = this.#requiredInbound(input.key);
    assertKey(input.responseRef);
    assertTimestamp(input.nowMs);
    if (current.acknowledged) {
      if (current.responseRef !== input.responseRef) {
        throw persistenceConflict();
      }
      return frozenClone(current);
    }
    const updated: DiscordInboundRecord = Object.freeze({
      ...current,
      acknowledged: true,
      responseRef: input.responseRef,
      updatedAtMs: input.nowMs,
    });
    this.#inbound.set(input.key, updated);
    return frozenClone(updated);
  }

  async completeInbound(input: { key: string; nowMs: number }): Promise<void> {
    const current = this.#requiredInbound(input.key);
    assertTimestamp(input.nowMs);
    this.#inbound.set(
      input.key,
      Object.freeze({ ...current, state: "completed", updatedAtMs: input.nowMs }),
    );
  }

  async getBindingByThread(threadId: string): Promise<DiscordTaskBinding | undefined> {
    const binding = this.#bindingsByThread.get(threadId);
    return binding === undefined ? undefined : frozenClone(binding);
  }

  async getBindingByTask(taskId: string): Promise<DiscordTaskBinding | undefined> {
    const threadId = this.#threadByTask.get(taskId);
    if (threadId === undefined) {
      return undefined;
    }
    return this.getBindingByThread(threadId);
  }

  async listBindings(): Promise<readonly DiscordTaskBinding[]> {
    return Object.freeze(
      [...this.#bindingsByThread.values()]
        .sort((left, right) => left.threadId.localeCompare(right.threadId))
        .map(frozenClone),
    );
  }

  async bindTask(binding: Omit<DiscordTaskBinding, "revision">): Promise<DiscordTaskBinding> {
    const existing = this.#bindingsByThread.get(binding.threadId);
    if (existing !== undefined) {
      if (!sameBindingIdentity(existing, binding)) {
        throw persistenceConflict();
      }
      return frozenClone(existing);
    }
    const taskThread = this.#threadByTask.get(binding.taskId);
    if (taskThread !== undefined && taskThread !== binding.threadId) {
      throw persistenceConflict();
    }
    const created: DiscordTaskBinding = Object.freeze({ ...frozenClone(binding), revision: 1 });
    this.#bindingsByThread.set(created.threadId, created);
    this.#threadByTask.set(created.taskId, created.threadId);
    return frozenClone(created);
  }

  async updateBinding(
    threadId: string,
    patch: Partial<
      Pick<
        DiscordTaskBinding,
        "statusPanelMessageId" | "lastReconciledMessageId" | "externalState" | "archived" | "locked"
      >
    >,
  ): Promise<DiscordTaskBinding> {
    const current = this.#bindingsByThread.get(threadId);
    if (current === undefined) {
      throw persistenceConflict();
    }
    const updated: DiscordTaskBinding = Object.freeze({
      ...current,
      ...frozenClone(patch),
      revision: current.revision + 1,
    });
    this.#bindingsByThread.set(threadId, updated);
    return frozenClone(updated);
  }

  async enqueueOutbox(item: Omit<DiscordOutboxItem, "attempts" | "delivered">): Promise<void> {
    assertKey(item.id);
    const existing = this.#outbox.get(item.id);
    const created: DiscordOutboxItem = Object.freeze({
      ...frozenClone(item),
      attempts: 0,
      delivered: false,
    });
    if (existing !== undefined) {
      if (!sameOutboxWork(existing, created)) {
        throw new DiscordAdapterError(
          "IDEMPOTENCY_CONFLICT",
          "A Discord outbox key was reused with different work.",
        );
      }
      return;
    }
    this.#outbox.set(item.id, created);
  }

  async claimReadyOutbox(input: {
    owner: string;
    nowMs: number;
    leaseMs: number;
    limit: number;
  }): Promise<readonly DiscordOutboxItem[]> {
    assertKey(input.owner);
    assertTimestamp(input.nowMs);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw persistenceConflict();
    }
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 100) {
      throw persistenceConflict();
    }
    const ready = [...this.#outbox.values()]
      .filter(
        (item) =>
          !item.delivered &&
          item.notBeforeMs <= input.nowMs &&
          (item.leaseExpiresAtMs === undefined || item.leaseExpiresAtMs <= input.nowMs),
      )
      .sort(
        (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit);
    const claimed = ready.map((item) => {
      const updated: DiscordOutboxItem = Object.freeze({
        ...item,
        leaseOwner: input.owner,
        leaseExpiresAtMs: input.nowMs + input.leaseMs,
      });
      this.#outbox.set(item.id, updated);
      return frozenClone(updated);
    });
    return Object.freeze(claimed);
  }

  async completeOutbox(input: { id: string; owner: string }): Promise<void> {
    const current = this.#requiredOutbox(input.id);
    assertLeaseOwner(current, input.owner);
    this.#outbox.set(
      input.id,
      Object.freeze({
        id: current.id,
        action: current.action,
        createdAtMs: current.createdAtMs,
        notBeforeMs: current.notBeforeMs,
        attempts: current.attempts + 1,
        delivered: true,
        ...(current.lastErrorCode === undefined ? {} : { lastErrorCode: current.lastErrorCode }),
      }),
    );
  }

  async retryOutbox(input: {
    id: string;
    owner: string;
    notBeforeMs: number;
    errorCode: string;
  }): Promise<void> {
    const current = this.#requiredOutbox(input.id);
    assertLeaseOwner(current, input.owner);
    assertTimestamp(input.notBeforeMs);
    assertKey(input.errorCode);
    this.#outbox.set(
      input.id,
      Object.freeze({
        id: current.id,
        action: current.action,
        createdAtMs: current.createdAtMs,
        attempts: current.attempts + 1,
        delivered: false,
        notBeforeMs: input.notBeforeMs,
        lastErrorCode: input.errorCode,
      }),
    );
  }

  async listOutbox(): Promise<readonly DiscordOutboxItem[]> {
    return Object.freeze(
      [...this.#outbox.values()]
        .sort(
          (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
        )
        .map(frozenClone),
    );
  }

  snapshot(): DiscordRepositorySnapshot {
    return Object.freeze({
      version: 1 as const,
      ...(this.#cursor === undefined ? {} : { cursor: frozenClone(this.#cursor) }),
      bindings: Object.freeze(
        [...this.#bindingsByThread.values()]
          .sort((left, right) => left.threadId.localeCompare(right.threadId))
          .map(frozenClone),
      ),
      inbound: Object.freeze(
        [...this.#inbound.values()]
          .sort((left, right) => left.key.localeCompare(right.key))
          .map(frozenClone),
      ),
      outbox: Object.freeze(
        [...this.#outbox.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(frozenClone),
      ),
    });
  }

  #requiredInbound(key: string): DiscordInboundRecord {
    const record = this.#inbound.get(key);
    if (record === undefined) {
      throw persistenceConflict();
    }
    return record;
  }

  #requiredOutbox(id: string): DiscordOutboxItem {
    const item = this.#outbox.get(id);
    if (item === undefined || item.delivered) {
      throw persistenceConflict();
    }
    return item;
  }

  #restoreBinding(binding: DiscordTaskBinding): void {
    if (
      this.#bindingsByThread.has(binding.threadId) ||
      this.#threadByTask.has(binding.taskId) ||
      !Number.isSafeInteger(binding.revision) ||
      binding.revision < 1
    ) {
      throw persistenceConflict();
    }
    const clone = frozenClone(binding);
    this.#bindingsByThread.set(clone.threadId, clone);
    this.#threadByTask.set(clone.taskId, clone.threadId);
  }
}

function sameBindingIdentity(
  left: DiscordTaskBinding,
  right: Omit<DiscordTaskBinding, "revision">,
): boolean {
  return (
    left.guildId === right.guildId &&
    left.forumChannelId === right.forumChannelId &&
    left.threadId === right.threadId &&
    left.starterMessageId === right.starterMessageId &&
    left.taskId === right.taskId
  );
}

function sameOutboxWork(left: DiscordOutboxItem, right: DiscordOutboxItem): boolean {
  return left.id === right.id && JSON.stringify(left.action) === JSON.stringify(right.action);
}

function assertLeaseOwner(item: DiscordOutboxItem, owner: string): void {
  if (item.leaseOwner !== owner) {
    throw persistenceConflict();
  }
}

function validateCursor(cursor: DiscordGatewayCursor): void {
  assertKey(cursor.sessionId);
  if (!URL.canParse(cursor.resumeGatewayUrl) || !cursor.resumeGatewayUrl.startsWith("wss://")) {
    throw persistenceConflict();
  }
  if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) {
    throw persistenceConflict();
  }
  assertTimestamp(cursor.updatedAtMs);
}

function assertDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw persistenceConflict();
  }
}

function assertKey(value: string): void {
  if (value.length === 0 || value.length > 512 || value.includes("\u0000")) {
    throw persistenceConflict();
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw persistenceConflict();
  }
}

function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function persistenceConflict(): DiscordAdapterError {
  return new DiscordAdapterError(
    "PERSISTENCE_CONFLICT",
    "Persisted Discord adapter state is inconsistent.",
  );
}
