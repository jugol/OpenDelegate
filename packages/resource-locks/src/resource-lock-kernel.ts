export interface Clock {
  now(): number;
}

export interface ResourceDefinition {
  readonly name: string;
  readonly capacity: number;
}

export const DESKTOP_SESSION_RESOURCE: ResourceDefinition = Object.freeze({
  name: "desktop-session",
  capacity: 1,
});

export type ResourceLockErrorCode =
  | "ACQUIRE_COMMAND_CONFLICT"
  | "CLOCK_VALUE_INVALID"
  | "FENCING_TOKEN_EXHAUSTED"
  | "LEASE_DURATION_INVALID"
  | "LEASE_EXPIRY_OVERFLOW"
  | "LEASE_HOLDER_MISMATCH"
  | "LEASE_NOT_FOUND"
  | "RESOURCE_CAPACITY_EXHAUSTED"
  | "RESOURCE_DEFINITION_DUPLICATED"
  | "RESOURCE_DEFINITION_INVALID"
  | "RESOURCE_IDENTIFIER_INVALID"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_SNAPSHOT_INVALID"
  | "RENEW_COMMAND_CONFLICT"
  | "STALE_FENCING_TOKEN";

export class ResourceLockError extends Error {
  public readonly code: ResourceLockErrorCode;

  public constructor(code: ResourceLockErrorCode, message: string) {
    super(message);
    this.name = "ResourceLockError";
    this.code = code;
  }
}

export interface ResourceLease {
  readonly resourceName: string;
  readonly holderId: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface AcquireResourceInput {
  readonly commandId: string;
  readonly resourceName: string;
  readonly holderId: string;
  readonly leaseDurationMs: number;
}

export interface LeaseMutationInput {
  readonly resourceName: string;
  readonly holderId: string;
  readonly fencingToken: number;
}

export interface RenewLeaseInput extends LeaseMutationInput {
  readonly commandId: string;
  readonly leaseDurationMs: number;
}

export interface ResourceLockKernelOptions {
  readonly clock: Clock;
  readonly resources: readonly ResourceDefinition[];
  readonly restoreFrom?: ResourceLockSnapshot;
}

export interface ResourceSnapshot {
  readonly resourceName: string;
  readonly capacity: number;
  readonly lastIssuedFencingToken: number;
  readonly activeLeases: readonly ResourceLease[];
}

export interface AcquireCommandSnapshot {
  readonly input: AcquireResourceInput;
  readonly lease: ResourceLease;
}

export interface LeaseRenewalSnapshot {
  readonly renewalSequence: number;
  readonly input: RenewLeaseInput;
  readonly renewedAtMs: number;
  readonly previousExpiresAtMs: number;
  readonly lease: ResourceLease;
}

export interface ResourceLockSnapshot {
  readonly observedAtMs: number;
  readonly resources: readonly ResourceSnapshot[];
  readonly acquireCommands: readonly AcquireCommandSnapshot[];
  readonly leaseRenewals: readonly LeaseRenewalSnapshot[];
}

interface ResourceState {
  readonly definition: ResourceDefinition;
  readonly leases: Map<number, ResourceLease>;
  lastIssuedFencingToken: number;
}

type AcquireCommandRecord = AcquireCommandSnapshot;

export class ResourceLockKernel {
  private readonly acquireCommands = new Map<string, AcquireCommandRecord>();
  private readonly clock: Clock;
  private readonly leaseRenewals = new Map<string, LeaseRenewalSnapshot[]>();
  private readonly renewCommands = new Map<string, LeaseRenewalSnapshot>();
  private readonly resources: Map<string, ResourceState>;
  private lastObservedAtMs: number | undefined;

  public constructor(options: ResourceLockKernelOptions) {
    this.clock = options.clock;
    this.resources = new Map();

    for (const definition of options.resources) {
      if (
        definition.name.trim().length === 0 ||
        !Number.isSafeInteger(definition.capacity) ||
        definition.capacity <= 0
      ) {
        throw new ResourceLockError(
          "RESOURCE_DEFINITION_INVALID",
          "A resource definition requires a non-blank name and positive safe-integer capacity.",
        );
      }

      if (this.resources.has(definition.name)) {
        throw new ResourceLockError(
          "RESOURCE_DEFINITION_DUPLICATED",
          `Resource "${definition.name}" is defined more than once.`,
        );
      }

      this.resources.set(definition.name, {
        definition: Object.freeze({ ...definition }),
        leases: new Map(),
        lastIssuedFencingToken: 0,
      });
    }

    if (options.restoreFrom !== undefined) {
      this.restoreSnapshot(options.restoreFrom);
      this.lastObservedAtMs = options.restoreFrom.observedAtMs;
      this.readClock();
    }
  }

  public acquire(input: AcquireResourceInput): ResourceLease {
    assertNonBlankIdentifier(input.commandId, "Acquire command ID");
    assertNonBlankIdentifier(input.resourceName, "Resource name");
    assertNonBlankIdentifier(input.holderId, "Lease holder ID");
    assertLeaseDuration(input.leaseDurationMs);
    const nowMs = this.readClock();

    const previousCommand = this.acquireCommands.get(input.commandId);

    if (previousCommand !== undefined) {
      if (!this.isSameAcquireCommand(previousCommand.input, input)) {
        throw new ResourceLockError(
          "ACQUIRE_COMMAND_CONFLICT",
          `Acquire command "${input.commandId}" was already used with different input.`,
        );
      }

      return previousCommand.lease;
    }

    const state = this.requireResource(input.resourceName);

    this.removeExpiredLeases(state, nowMs);

    if (state.leases.size >= state.definition.capacity) {
      throw new ResourceLockError(
        "RESOURCE_CAPACITY_EXHAUSTED",
        `Resource "${input.resourceName}" is at capacity ${state.definition.capacity}.`,
      );
    }

    if (state.lastIssuedFencingToken >= Number.MAX_SAFE_INTEGER) {
      throw new ResourceLockError(
        "FENCING_TOKEN_EXHAUSTED",
        `Resource "${input.resourceName}" cannot issue another safe fencing token.`,
      );
    }

    const expiresAtMs = leaseExpiry(nowMs, input.leaseDurationMs);
    state.lastIssuedFencingToken += 1;
    const lease = Object.freeze({
      resourceName: input.resourceName,
      holderId: input.holderId,
      fencingToken: state.lastIssuedFencingToken,
      acquiredAtMs: nowMs,
      expiresAtMs,
    });
    state.leases.set(lease.fencingToken, lease);
    this.acquireCommands.set(input.commandId, {
      input: Object.freeze({ ...input }),
      lease,
    });

    return lease;
  }

  public release(input: LeaseMutationInput): void {
    assertLeaseMutationInput(input);
    const state = this.requireResource(input.resourceName);
    this.removeExpiredLeases(state, this.readClock());
    const lease = this.requireCurrentLease(state, input);

    state.leases.delete(lease.fencingToken);
  }

  public cancel(input: LeaseMutationInput): void {
    this.release(input);
  }

  public renew(input: RenewLeaseInput): ResourceLease {
    assertNonBlankIdentifier(input.commandId, "Renew command ID");
    assertLeaseMutationInput(input);
    assertLeaseDuration(input.leaseDurationMs);
    const nowMs = this.readClock();
    const previousCommand = this.renewCommands.get(input.commandId);

    if (previousCommand !== undefined) {
      if (!this.isSameRenewCommand(previousCommand.input, input)) {
        throw new ResourceLockError(
          "RENEW_COMMAND_CONFLICT",
          `Renew command "${input.commandId}" was already used with different input.`,
        );
      }

      return previousCommand.lease;
    }

    const state = this.requireResource(input.resourceName);
    this.removeExpiredLeases(state, nowMs);
    const currentLease = this.requireCurrentLease(state, input);
    const expiresAtMs = leaseExpiry(nowMs, input.leaseDurationMs);
    const renewedLease = Object.freeze({
      ...currentLease,
      expiresAtMs,
    });
    const renewalKey = leaseHistoryKey(input.resourceName, input.fencingToken);
    const history = this.leaseRenewals.get(renewalKey) ?? [];
    const renewal = Object.freeze({
      renewalSequence: history.length + 1,
      input: Object.freeze({ ...input }),
      renewedAtMs: nowMs,
      previousExpiresAtMs: currentLease.expiresAtMs,
      lease: renewedLease,
    });

    state.leases.set(renewedLease.fencingToken, renewedLease);
    history.push(renewal);
    this.leaseRenewals.set(renewalKey, history);
    this.renewCommands.set(input.commandId, renewal);

    return renewedLease;
  }

  public snapshot(): ResourceLockSnapshot {
    const observedAtMs = this.readClock();
    const resourceSnapshots = [...this.resources.values()]
      .sort((left, right) => compareStrings(left.definition.name, right.definition.name))
      .map((state) => {
        this.removeExpiredLeases(state, observedAtMs);

        return Object.freeze({
          resourceName: state.definition.name,
          capacity: state.definition.capacity,
          lastIssuedFencingToken: state.lastIssuedFencingToken,
          activeLeases: Object.freeze(
            [...state.leases.values()].sort(
              (left, right) => left.fencingToken - right.fencingToken,
            ),
          ),
        });
      });

    const acquireCommands = [...this.acquireCommands.values()]
      .sort((left, right) => compareStrings(left.input.commandId, right.input.commandId))
      .map((record) =>
        Object.freeze({
          input: Object.freeze({ ...record.input }),
          lease: Object.freeze({ ...record.lease }),
        }),
      );

    const leaseRenewals = [...this.leaseRenewals.values()]
      .flat()
      .sort(
        (left, right) =>
          compareStrings(left.input.resourceName, right.input.resourceName) ||
          left.input.fencingToken - right.input.fencingToken ||
          left.renewalSequence - right.renewalSequence,
      )
      .map((record) =>
        Object.freeze({
          renewalSequence: record.renewalSequence,
          input: Object.freeze({ ...record.input }),
          renewedAtMs: record.renewedAtMs,
          previousExpiresAtMs: record.previousExpiresAtMs,
          lease: Object.freeze({ ...record.lease }),
        }),
      );

    return Object.freeze({
      observedAtMs,
      resources: Object.freeze(resourceSnapshots),
      acquireCommands: Object.freeze(acquireCommands),
      leaseRenewals: Object.freeze(leaseRenewals),
    });
  }

  private requireResource(resourceName: string): ResourceState {
    const state = this.resources.get(resourceName);

    if (state === undefined) {
      throw new ResourceLockError(
        "RESOURCE_NOT_FOUND",
        `Resource "${resourceName}" is not defined.`,
      );
    }

    return state;
  }

  private restoreSnapshot(snapshot: ResourceLockSnapshot): void {
    if (
      !Number.isSafeInteger(snapshot.observedAtMs) ||
      snapshot.observedAtMs < 0 ||
      !Array.isArray(snapshot.resources) ||
      !Array.isArray(snapshot.acquireCommands) ||
      !Array.isArray(snapshot.leaseRenewals) ||
      snapshot.resources.length !== this.resources.size
    ) {
      throw invalidSnapshot();
    }

    const seenResources = new Set<string>();
    for (const resourceSnapshot of snapshot.resources) {
      if (
        resourceSnapshot === null ||
        typeof resourceSnapshot !== "object" ||
        typeof resourceSnapshot.resourceName !== "string" ||
        !Array.isArray(resourceSnapshot.activeLeases)
      ) {
        throw invalidSnapshot();
      }
      const state = this.resources.get(resourceSnapshot.resourceName);
      if (
        state === undefined ||
        seenResources.has(resourceSnapshot.resourceName) ||
        state.definition.capacity !== resourceSnapshot.capacity ||
        !Number.isSafeInteger(resourceSnapshot.lastIssuedFencingToken) ||
        resourceSnapshot.lastIssuedFencingToken < 0
      ) {
        throw invalidSnapshot();
      }

      const leases = new Map<number, ResourceLease>();
      for (const lease of resourceSnapshot.activeLeases) {
        if (
          lease === null ||
          typeof lease !== "object" ||
          lease.resourceName !== resourceSnapshot.resourceName ||
          typeof lease.holderId !== "string" ||
          lease.holderId.trim() === "" ||
          !Number.isSafeInteger(lease.fencingToken) ||
          lease.fencingToken <= 0 ||
          lease.fencingToken > resourceSnapshot.lastIssuedFencingToken ||
          !Number.isSafeInteger(lease.acquiredAtMs) ||
          !Number.isSafeInteger(lease.expiresAtMs) ||
          lease.expiresAtMs <= lease.acquiredAtMs ||
          lease.acquiredAtMs > snapshot.observedAtMs ||
          lease.expiresAtMs <= snapshot.observedAtMs ||
          leases.has(lease.fencingToken)
        ) {
          throw invalidSnapshot();
        }
        leases.set(lease.fencingToken, Object.freeze({ ...lease }));
      }

      if (leases.size > state.definition.capacity) {
        throw invalidSnapshot();
      }

      state.lastIssuedFencingToken = resourceSnapshot.lastIssuedFencingToken;
      state.leases.clear();
      for (const [fencingToken, lease] of leases) {
        state.leases.set(fencingToken, lease);
      }
      seenResources.add(resourceSnapshot.resourceName);
    }

    const seenCommandIds = new Set<string>();
    const commandLeasesByResource = new Map<string, Map<number, ResourceLease>>();
    const restoredCommands = new Map<string, AcquireCommandRecord>();
    for (const record of snapshot.acquireCommands) {
      if (
        record === null ||
        typeof record !== "object" ||
        record.input === null ||
        typeof record.input !== "object" ||
        record.lease === null ||
        typeof record.lease !== "object"
      ) {
        throw invalidSnapshot();
      }
      const input = record.input;
      const lease = record.lease;
      const state =
        typeof input.resourceName === "string" ? this.resources.get(input.resourceName) : undefined;
      if (
        state === undefined ||
        typeof input.commandId !== "string" ||
        input.commandId.trim() === "" ||
        seenCommandIds.has(input.commandId) ||
        typeof input.holderId !== "string" ||
        input.holderId.trim() === "" ||
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs <= 0 ||
        lease.resourceName !== input.resourceName ||
        lease.holderId !== input.holderId ||
        !Number.isSafeInteger(lease.fencingToken) ||
        lease.fencingToken <= 0 ||
        lease.fencingToken > state.lastIssuedFencingToken ||
        !Number.isSafeInteger(lease.acquiredAtMs) ||
        lease.acquiredAtMs < 0 ||
        lease.acquiredAtMs > snapshot.observedAtMs ||
        !Number.isSafeInteger(lease.expiresAtMs) ||
        lease.expiresAtMs !== lease.acquiredAtMs + input.leaseDurationMs
      ) {
        throw invalidSnapshot();
      }
      const resourceLeases =
        commandLeasesByResource.get(input.resourceName) ?? new Map<number, ResourceLease>();
      if (resourceLeases.has(lease.fencingToken)) {
        throw invalidSnapshot();
      }
      resourceLeases.set(lease.fencingToken, lease);
      commandLeasesByResource.set(input.resourceName, resourceLeases);
      seenCommandIds.add(input.commandId);
      restoredCommands.set(
        input.commandId,
        Object.freeze({
          input: Object.freeze({ ...input }),
          lease: Object.freeze({ ...lease }),
        }),
      );
    }

    const expectedLeasesByResource = new Map<string, Map<number, ResourceLease>>();
    for (const [resourceName, commandLeases] of commandLeasesByResource) {
      expectedLeasesByResource.set(resourceName, new Map(commandLeases));
    }
    const restoredRenewals = new Map<string, LeaseRenewalSnapshot[]>();
    const restoredRenewCommands = new Map<string, LeaseRenewalSnapshot>();
    const seenRenewCommandIds = new Set<string>();
    for (const record of snapshot.leaseRenewals) {
      if (
        record === null ||
        typeof record !== "object" ||
        record.input === null ||
        typeof record.input !== "object" ||
        record.lease === null ||
        typeof record.lease !== "object"
      ) {
        throw invalidSnapshot();
      }
      const input = record.input;
      const lease = record.lease;
      const commandLease =
        typeof input.resourceName === "string" &&
        Number.isSafeInteger(input.fencingToken) &&
        input.fencingToken > 0
          ? commandLeasesByResource.get(input.resourceName)?.get(input.fencingToken)
          : undefined;
      const renewalKey =
        commandLease === undefined
          ? undefined
          : leaseHistoryKey(input.resourceName, input.fencingToken);
      const history =
        renewalKey === undefined ? undefined : (restoredRenewals.get(renewalKey) ?? []);
      const previousLease =
        history === undefined
          ? undefined
          : history.length === 0
            ? commandLease
            : history.at(-1)?.lease;
      const previousRenewedAtMs = history?.at(-1)?.renewedAtMs;
      const expectedExpiresAtMs =
        Number.isSafeInteger(record.renewedAtMs) && Number.isSafeInteger(input.leaseDurationMs)
          ? record.renewedAtMs + input.leaseDurationMs
          : Number.NaN;
      if (
        commandLease === undefined ||
        renewalKey === undefined ||
        history === undefined ||
        previousLease === undefined ||
        !Number.isSafeInteger(record.renewalSequence) ||
        record.renewalSequence !== history.length + 1 ||
        typeof input.commandId !== "string" ||
        input.commandId.trim() === "" ||
        seenRenewCommandIds.has(input.commandId) ||
        typeof input.holderId !== "string" ||
        input.holderId !== commandLease.holderId ||
        input.fencingToken !== commandLease.fencingToken ||
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs <= 0 ||
        !Number.isSafeInteger(record.renewedAtMs) ||
        record.renewedAtMs < commandLease.acquiredAtMs ||
        record.renewedAtMs > snapshot.observedAtMs ||
        (previousRenewedAtMs !== undefined && record.renewedAtMs < previousRenewedAtMs) ||
        record.renewedAtMs >= previousLease.expiresAtMs ||
        !Number.isSafeInteger(record.previousExpiresAtMs) ||
        record.previousExpiresAtMs !== previousLease.expiresAtMs ||
        !Number.isSafeInteger(expectedExpiresAtMs) ||
        lease.resourceName !== commandLease.resourceName ||
        lease.holderId !== commandLease.holderId ||
        lease.fencingToken !== commandLease.fencingToken ||
        lease.acquiredAtMs !== commandLease.acquiredAtMs ||
        lease.expiresAtMs !== expectedExpiresAtMs
      ) {
        throw invalidSnapshot();
      }
      const restoredRenewal = Object.freeze({
        renewalSequence: record.renewalSequence,
        input: Object.freeze({ ...input }),
        renewedAtMs: record.renewedAtMs,
        previousExpiresAtMs: record.previousExpiresAtMs,
        lease: Object.freeze({ ...lease }),
      });
      history.push(restoredRenewal);
      restoredRenewals.set(renewalKey, history);
      seenRenewCommandIds.add(input.commandId);
      restoredRenewCommands.set(input.commandId, restoredRenewal);
      expectedLeasesByResource
        .get(input.resourceName)
        ?.set(input.fencingToken, restoredRenewal.lease);
    }

    for (const [resourceName, state] of this.resources) {
      const commandLeases = commandLeasesByResource.get(resourceName);
      if ((commandLeases?.size ?? 0) !== state.lastIssuedFencingToken) {
        throw invalidSnapshot();
      }
      let previousAcquiredAtMs = -1;
      const mandatoryContinuityHorizons: number[] = [];
      for (let fencingToken = 1; fencingToken <= state.lastIssuedFencingToken; fencingToken += 1) {
        const commandLease = commandLeases?.get(fencingToken);
        if (commandLease === undefined || commandLease.acquiredAtMs < previousAcquiredAtMs) {
          throw invalidSnapshot();
        }
        previousAcquiredAtMs = commandLease.acquiredAtMs;
        while (
          mandatoryContinuityHorizons.length > 0 &&
          mandatoryContinuityHorizons[0]! <= commandLease.acquiredAtMs
        ) {
          popMinHeap(mandatoryContinuityHorizons);
        }
        if (mandatoryContinuityHorizons.length >= state.definition.capacity) {
          throw invalidSnapshot();
        }
        const renewalHistory =
          restoredRenewals.get(leaseHistoryKey(resourceName, fencingToken)) ?? [];
        pushMinHeap(
          mandatoryContinuityHorizons,
          state.leases.has(fencingToken)
            ? Number.POSITIVE_INFINITY
            : (renewalHistory.at(-1)?.renewedAtMs ?? commandLease.acquiredAtMs),
        );
      }
      for (const [fencingToken, activeLease] of state.leases) {
        const expectedLease = expectedLeasesByResource.get(resourceName)?.get(fencingToken);
        if (
          expectedLease === undefined ||
          expectedLease.resourceName !== activeLease.resourceName ||
          expectedLease.holderId !== activeLease.holderId ||
          expectedLease.fencingToken !== activeLease.fencingToken ||
          expectedLease.acquiredAtMs !== activeLease.acquiredAtMs ||
          expectedLease.expiresAtMs !== activeLease.expiresAtMs
        ) {
          throw invalidSnapshot();
        }
      }
    }
    this.acquireCommands.clear();
    for (const [commandId, record] of restoredCommands) {
      this.acquireCommands.set(commandId, record);
    }
    this.leaseRenewals.clear();
    for (const [renewalKey, history] of restoredRenewals) {
      this.leaseRenewals.set(renewalKey, history);
    }
    this.renewCommands.clear();
    for (const [commandId, record] of restoredRenewCommands) {
      this.renewCommands.set(commandId, record);
    }
  }

  private removeExpiredLeases(state: ResourceState, nowMs: number): void {
    for (const [fencingToken, lease] of state.leases) {
      if (lease.expiresAtMs <= nowMs) {
        state.leases.delete(fencingToken);
      }
    }
  }

  private requireCurrentLease(state: ResourceState, input: LeaseMutationInput): ResourceLease {
    const lease = state.leases.get(input.fencingToken);

    if (lease === undefined) {
      if (input.fencingToken <= state.lastIssuedFencingToken) {
        throw new ResourceLockError(
          "STALE_FENCING_TOKEN",
          `Fencing token ${input.fencingToken} for resource "${input.resourceName}" is stale.`,
        );
      }

      throw new ResourceLockError(
        "LEASE_NOT_FOUND",
        `No lease with fencing token ${input.fencingToken} exists for resource "${input.resourceName}".`,
      );
    }

    if (lease.holderId !== input.holderId) {
      throw new ResourceLockError(
        "LEASE_HOLDER_MISMATCH",
        `Lease ${input.fencingToken} for resource "${input.resourceName}" is not held by "${input.holderId}".`,
      );
    }

    return lease;
  }

  private isSameAcquireCommand(first: AcquireResourceInput, second: AcquireResourceInput): boolean {
    return (
      first.commandId === second.commandId &&
      first.resourceName === second.resourceName &&
      first.holderId === second.holderId &&
      first.leaseDurationMs === second.leaseDurationMs
    );
  }

  private isSameRenewCommand(first: RenewLeaseInput, second: RenewLeaseInput): boolean {
    return (
      first.commandId === second.commandId &&
      first.resourceName === second.resourceName &&
      first.holderId === second.holderId &&
      first.fencingToken === second.fencingToken &&
      first.leaseDurationMs === second.leaseDurationMs
    );
  }

  private readClock(): number {
    const nowMs = this.clock.now();

    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      (this.lastObservedAtMs !== undefined && nowMs < this.lastObservedAtMs)
    ) {
      throw new ResourceLockError(
        "CLOCK_VALUE_INVALID",
        "The resource-lock clock must return a non-negative, monotonically non-decreasing safe-integer value.",
      );
    }

    this.lastObservedAtMs = nowMs;
    return nowMs;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function leaseHistoryKey(resourceName: string, fencingToken: number): string {
  return JSON.stringify([resourceName, fencingToken]);
}

function pushMinHeap(heap: number[], value: number): void {
  heap.push(value);
  let index = heap.length - 1;

  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (heap[parentIndex]! <= value) {
      break;
    }
    heap[index] = heap[parentIndex]!;
    index = parentIndex;
  }
  heap[index] = value;
}

function popMinHeap(heap: number[]): number | undefined {
  const minimum = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || last === undefined) {
    return minimum;
  }

  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= heap.length) {
      break;
    }
    const rightIndex = leftIndex + 1;
    const childIndex =
      rightIndex < heap.length && heap[rightIndex]! < heap[leftIndex]! ? rightIndex : leftIndex;
    if (heap[childIndex]! >= last) {
      break;
    }
    heap[index] = heap[childIndex]!;
    index = childIndex;
  }
  heap[index] = last;

  return minimum;
}

function assertNonBlankIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ResourceLockError(
      "RESOURCE_IDENTIFIER_INVALID",
      `${label} must be a non-blank string.`,
    );
  }
}

function assertLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new ResourceLockError(
      "LEASE_DURATION_INVALID",
      "A resource lease requires a positive safe-integer duration.",
    );
  }
}

function assertLeaseMutationInput(input: LeaseMutationInput): void {
  assertNonBlankIdentifier(input.resourceName, "Resource name");
  assertNonBlankIdentifier(input.holderId, "Lease holder ID");
}

function leaseExpiry(nowMs: number, leaseDurationMs: number): number {
  const expiresAtMs = nowMs + leaseDurationMs;

  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new ResourceLockError(
      "LEASE_EXPIRY_OVERFLOW",
      "The resource lease expiration exceeds the safe clock range.",
    );
  }

  return expiresAtMs;
}

function invalidSnapshot(): ResourceLockError {
  return new ResourceLockError(
    "RESOURCE_SNAPSHOT_INVALID",
    "The resource-lock snapshot is malformed or incompatible with its definitions.",
  );
}
