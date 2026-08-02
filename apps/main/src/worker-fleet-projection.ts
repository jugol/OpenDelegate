import { isDeepStrictEqual } from "node:util";

import type { WorkerHeartbeatV1 } from "@opendelegate/device-channel";
import type { PersistedDeviceIdentity } from "@opendelegate/device-identity";
import type { DeviceSummaryV1 } from "@opendelegate/protocol";
import {
  DEFAULT_AGENT_EXECUTION_PROFILE,
  isAgentExecutionProfile,
  type AgentExecutionProfile,
} from "@opendelegate/configuration";

import type { AgentAwareWorkerCandidate, WorkerCandidateSource } from "./worker-target-resolver.ts";

const DEFAULT_OFFLINE_AFTER_MS = 45_000;
const MAXIMUM_FUTURE_CLOCK_SKEW_MS = 30_000;
const MAXIMUM_DATE_MS = 8_640_000_000_000_000;

export interface MainWorkerIdentitySource {
  list(): Promise<readonly PersistedDeviceIdentity[]>;
}

export interface MainWorkerFleetClock {
  now(): number;
}

export interface MainOwnedDeviceProfile {
  readonly displayName?: string;
  readonly roles?: readonly string[];
  readonly instructions?: readonly string[];
  readonly agentExecutionProfile?: AgentExecutionProfile;
  readonly coordinatorAgentExecutionProfile?: AgentExecutionProfile;
  readonly policies?: readonly {
    readonly policyId: string;
    readonly actionCategory: string;
    readonly decision: "allow" | "require-approval" | "deny";
    readonly source: "built-in" | "configuration";
    readonly effectiveScope: "instance" | "main" | "device";
  }[];
}

export interface MainOwnedDeviceProfileSource {
  get(deviceId: string): Promise<MainOwnedDeviceProfile | undefined>;
}

export interface MainWorkerFleetProjectionOptions {
  readonly identities: MainWorkerIdentitySource;
  readonly profiles?: MainOwnedDeviceProfileSource;
  readonly observations?: MainDeviceObservationStore;
  readonly clock?: MainWorkerFleetClock;
  readonly offlineAfterMs?: number;
}

export interface MainDeviceObservationStore {
  accept(input: {
    readonly authenticatedDeviceId: string;
    readonly acceptedAtMs: number;
    readonly heartbeat: WorkerHeartbeatV1;
  }): Promise<{
    readonly disposition: "accepted" | "duplicate" | "stale";
    readonly observationSequence: number;
  }>;
  latest(deviceId: string): Promise<
    | {
        readonly acceptedAtMs: number;
        readonly deviceId: string;
        readonly heartbeat: WorkerHeartbeatV1;
        readonly observationSequence: number;
        readonly observedAtMs: number;
      }
    | undefined
  >;
}

interface ObservedHeartbeat {
  readonly heartbeat: WorkerHeartbeatV1;
  readonly receivedAtMs: number;
}

/**
 * Joins Main-owned Device identity/profile authority with the latest authenticated
 * Worker heartbeat. Worker metadata can describe local readiness and verified
 * capabilities, but it cannot grant itself Roles or enable a revoked identity.
 */
export class MainWorkerFleetProjection implements WorkerCandidateSource {
  readonly #identities: MainWorkerIdentitySource;
  readonly #profiles: MainOwnedDeviceProfileSource | undefined;
  readonly #observations: MainDeviceObservationStore | undefined;
  readonly #clock: MainWorkerFleetClock;
  readonly #offlineAfterMs: number;
  readonly #heartbeats = new Map<string, ObservedHeartbeat>();

  public constructor(options: MainWorkerFleetProjectionOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      options.identities === null ||
      typeof options.identities !== "object" ||
      typeof options.identities.list !== "function"
    ) {
      throw new TypeError("A Main-owned Device identity source is required.");
    }
    const offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
    if (
      !Number.isSafeInteger(offlineAfterMs) ||
      offlineAfterMs < 1_000 ||
      offlineAfterMs > 24 * 60 * 60_000
    ) {
      throw new TypeError("offlineAfterMs must be a safe duration between 1 second and 24 hours.");
    }
    this.#identities = options.identities;
    if (
      options.profiles !== undefined &&
      (options.profiles === null ||
        typeof options.profiles !== "object" ||
        typeof options.profiles.get !== "function")
    ) {
      throw new TypeError("The Main-owned Device profile source is invalid.");
    }
    this.#profiles = options.profiles;
    if (
      options.observations !== undefined &&
      (options.observations === null ||
        typeof options.observations !== "object" ||
        typeof options.observations.accept !== "function" ||
        typeof options.observations.latest !== "function")
    ) {
      throw new TypeError("The Main-owned Device observation store is invalid.");
    }
    this.#observations = options.observations;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#offlineAfterMs = offlineAfterMs;
  }

  public async observeHeartbeat(
    authenticatedDeviceId: string,
    heartbeat: WorkerHeartbeatV1,
  ): Promise<void> {
    if (authenticatedDeviceId !== heartbeat.deviceId) {
      throw new Error("The heartbeat identity does not match the authenticated Device.");
    }
    const now = this.#readNow();
    if (heartbeat.observedAtMs > now + MAXIMUM_FUTURE_CLOCK_SKEW_MS) {
      throw new Error("The Worker heartbeat time is too far in the future.");
    }
    const identities = await this.#readIdentities();
    const identity = identities.find((candidate) => candidate.deviceId === authenticatedDeviceId);
    if (identity === undefined || identity.status !== "active") {
      throw new Error("The heartbeat identity is not an active Main-owned Device.");
    }
    const inventory = heartbeat.inventory;
    if (
      inventory !== undefined &&
      (inventory.osFamily !== identity.discovery.osFamily ||
        inventory.architecture !== identity.discovery.architecture)
    ) {
      throw new Error("The heartbeat inventory conflicts with enrolled Device identity.");
    }
    const previous = this.#heartbeats.get(authenticatedDeviceId);
    if (previous !== undefined) {
      if (heartbeat.observedAtMs < previous.heartbeat.observedAtMs) {
        return;
      }
      if (heartbeat.observedAtMs === previous.heartbeat.observedAtMs) {
        if (!isDeepStrictEqual(heartbeat, previous.heartbeat)) {
          throw new Error("The Worker reused one heartbeat time for different inventory.");
        }
        return;
      }
    }
    const durable = await this.#observations?.accept({
      authenticatedDeviceId,
      acceptedAtMs: now,
      heartbeat,
    });
    if (durable?.disposition === "stale") {
      return;
    }
    const current = this.#heartbeats.get(authenticatedDeviceId);
    if (current !== undefined) {
      if (heartbeat.observedAtMs < current.heartbeat.observedAtMs) {
        return;
      }
      if (heartbeat.observedAtMs === current.heartbeat.observedAtMs) {
        if (!isDeepStrictEqual(heartbeat, current.heartbeat)) {
          throw new Error("The Worker reused one heartbeat time for different inventory.");
        }
        return;
      }
    }
    this.#heartbeats.set(
      authenticatedDeviceId,
      Object.freeze({
        heartbeat: structuredClone(heartbeat),
        receivedAtMs: now,
      }),
    );
  }

  public async list(): Promise<readonly AgentAwareWorkerCandidate[]> {
    const identities = await this.#readIdentities();
    const now = this.#readNow();
    return Object.freeze(
      await Promise.all(
        identities.map(async (identity) =>
          this.#candidate(identity, now, await this.#readProfile(identity.deviceId)),
        ),
      ),
    );
  }

  public async deviceSummaries(): Promise<readonly DeviceSummaryV1[]> {
    const identities = await this.#readIdentities();
    const now = this.#readNow();
    return Object.freeze(
      await Promise.all(
        identities.map(async (identity) => {
          const heartbeat = this.#currentHeartbeat(identity.deviceId, now);
          const durable = await this.#readDurableObservation(identity.deviceId);
          const observedHeartbeat = heartbeat ?? durable?.heartbeat;
          const inventory = observedHeartbeat?.inventory;
          const profile = await this.#readProfile(identity.deviceId);
          const online =
            identity.status === "active" &&
            heartbeat !== undefined &&
            heartbeat.connectionState === "online";
          const maximumConcurrentRuns = inventory?.maximumConcurrentRuns ?? 1;
          const activeRuns = heartbeat?.capacity.activeRuns ?? 0;
          return Object.freeze({
            deviceId: identity.deviceId,
            name: profile?.displayName ?? inventory?.deviceName ?? identity.discovery.hostname,
            osFamily: identity.discovery.osFamily,
            platformRelease: inventory?.platformRelease ?? "unknown",
            architecture: identity.discovery.architecture,
            role: "worker" as const,
            connection: online ? ("online" as const) : ("offline" as const),
            runtime: !online
              ? ("unavailable" as const)
              : heartbeat.readiness.daemon === "healthy"
                ? ("healthy" as const)
                : ("degraded" as const),
            serviceMode: inventory?.serviceMode ?? ("foreground" as const),
            ...(observedHeartbeat === undefined
              ? {}
              : {
                  lastObservation: {
                    observedAtMs: observedHeartbeat.observedAtMs,
                    acceptedAtMs:
                      durable?.acceptedAtMs ??
                      this.#heartbeats.get(identity.deviceId)!.receivedAtMs,
                    source: "authenticated-heartbeat" as const,
                  },
                }),
            roles: [...(profile?.roles ?? identity.allowedBootstrapRoles)],
            instructions: [...(profile?.instructions ?? [])],
            facts: projectDeviceFacts(identity, observedHeartbeat),
            capabilities: (inventory?.capabilities ?? []).map((capability) => ({
              name: capability.name,
              verification: capability.verification,
              ...(capability.observedAtMs === undefined
                ? {}
                : { observedAtMs: capability.observedAtMs }),
              ...(capability.evidenceSource === undefined
                ? {}
                : { evidenceSource: capability.evidenceSource }),
              ...(capability.version === undefined ? {} : { version: capability.version }),
              ...(capability.blockedBy === undefined ? {} : { blockedBy: capability.blockedBy }),
            })),
            policies: [...(profile?.policies ?? [])],
            ...(inventory?.agentAdapters === undefined
              ? {}
              : {
                  agentAdapters: inventory.agentAdapters.map((adapter) => ({
                    provider: adapter.provider,
                    adapterId: adapter.adapterId,
                    readiness: adapter.readiness,
                    compatibility: adapter.compatibility,
                    ...(adapter.version === undefined ? {} : { version: adapter.version }),
                    ...(adapter.availableUpgrade === undefined
                      ? {}
                      : { availableUpgrade: { ...adapter.availableUpgrade } }),
                    observedAtMs: adapter.observedAtMs,
                    ...(adapter.modelCatalogObservedAtMs === undefined
                      ? {}
                      : {
                          modelCatalogObservedAtMs: adapter.modelCatalogObservedAtMs,
                          models: (adapter.models ?? []).map((model) => ({
                            modelId: model.modelId,
                            displayName: model.displayName,
                            ...(model.isDefault === undefined
                              ? {}
                              : { isDefault: model.isDefault }),
                            ...(model.supportedEfforts === undefined
                              ? {}
                              : { supportedEfforts: [...model.supportedEfforts] }),
                          })),
                        }),
                  })),
                }),
            agentExecutionProfile: projectAgentExecutionProfile(
              profile?.agentExecutionProfile ?? DEFAULT_AGENT_EXECUTION_PROFILE,
            ),
            ...(inventory?.wakeOnLan === undefined
              ? {}
              : { wakeOnLan: projectWakeOnLanReadiness(inventory.wakeOnLan) }),
            routes:
              heartbeat?.routes === undefined
                ? [
                    {
                      routeId: `device-channel:${identity.deviceId}`,
                      label: "Device channel",
                      priority: 0,
                      health: online ? ("healthy" as const) : ("unhealthy" as const),
                    },
                  ]
                : heartbeat.routes.map((route) => ({
                    ...route,
                    health: online ? route.health : ("unhealthy" as const),
                  })),
            ...(heartbeat?.inventory?.resourceLocks === undefined
              ? {}
              : {
                  resourceLocks: heartbeat.inventory.resourceLocks.map((lock) => ({
                    resourceName: lock.resourceName,
                    capacity: lock.capacity,
                    holders: lock.holders.map((holder) => ({ ...holder })),
                  })),
                }),
            ...(heartbeat?.currentRuns === undefined
              ? {}
              : { currentRuns: [...heartbeat.currentRuns] }),
            ...(heartbeat === undefined
              ? {}
              : {
                  capacity: {
                    activeRuns,
                    maximumConcurrentRuns,
                    acceptingWork:
                      online &&
                      heartbeat.operationalState === "active" &&
                      heartbeat.capacity.acceptingWork,
                    maxOutboxEntries: heartbeat.capacity.maxOutboxEntries,
                    outboxDepth: heartbeat.capacity.outboxDepth,
                  },
                }),
            knowledgeHealth: inventory?.knowledgeHealth ?? ("unknown" as const),
          });
        }),
      ),
    );
  }

  #candidate(
    identity: PersistedDeviceIdentity,
    now: number,
    profile: MainOwnedDeviceProfile | undefined,
  ): AgentAwareWorkerCandidate {
    const heartbeat = this.#currentHeartbeat(identity.deviceId, now);
    const inventory = heartbeat?.inventory;
    const online =
      identity.status === "active" &&
      heartbeat !== undefined &&
      heartbeat.connectionState === "online";
    const enabled =
      identity.status === "active" &&
      heartbeat?.operationalState !== "disabled" &&
      heartbeat?.operationalState !== "revoked";
    const maximumConcurrentRuns = inventory?.maximumConcurrentRuns ?? 1;
    const activeRuns = heartbeat?.capacity.activeRuns ?? 0;
    const acceptingWork =
      online &&
      enabled &&
      heartbeat?.operationalState === "active" &&
      heartbeat.capacity.acceptingWork;
    const capabilities = Object.freeze(
      (inventory?.capabilities ?? []).map((capability) =>
        Object.freeze({
          name: capability.name,
          verification: capability.verification,
        }),
      ),
    );
    const desktopVerified = capabilities.some(
      (capability) => capability.name === "computer-use" && capability.verification === "verified",
    );
    const desktopSessionAvailable =
      online &&
      desktopVerified &&
      heartbeat.readiness.session === "ready" &&
      heartbeat.readiness.desktop === "available" &&
      heartbeat.readiness.permissions.accessibility === "granted" &&
      heartbeat.readiness.permissions.input === "granted" &&
      heartbeat.readiness.permissions.screenCapture === "granted";
    return Object.freeze({
      deviceId: identity.deviceId,
      workerId: heartbeat?.workerId ?? `worker:${identity.deviceId}`,
      enabled,
      status: online ? ("online" as const) : ("offline" as const),
      draining: heartbeat?.operationalState === "draining",
      osFamily: identity.discovery.osFamily,
      capabilities,
      roles: Object.freeze([...(profile?.roles ?? identity.allowedBootstrapRoles)]),
      workspaceIds: Object.freeze([...(inventory?.workspaceIds ?? [])]),
      transports: Object.freeze([
        ...(heartbeat?.routes === undefined
          ? [
              Object.freeze({
                routeId: `device-channel:${identity.deviceId}`,
                priority: 0,
                health: online ? ("healthy" as const) : ("unhealthy" as const),
              }),
            ]
          : heartbeat.routes.map((route) =>
              Object.freeze({
                routeId: route.routeId,
                priority: route.priority,
                health:
                  online && route.health === "healthy"
                    ? ("healthy" as const)
                    : ("unhealthy" as const),
              }),
            )),
      ]),
      availableRunSlots: acceptingWork ? Math.max(0, maximumConcurrentRuns - activeRuns) : 0,
      loadRatio: Math.min(1, activeRuns / maximumConcurrentRuns),
      desktopSessionAvailable,
      executionPolicyDecision:
        enabled && identity.status === "active"
          ? Object.freeze({ outcome: "allow" as const, code: "PERSONAL_INSTANCE_DEFAULT" })
          : Object.freeze({ outcome: "deny" as const, code: "DEVICE_DISABLED" }),
      availableSecretRefs: Object.freeze([...(inventory?.availableSecretRefs ?? [])]),
      agentExecutionProfile: profile?.agentExecutionProfile ?? DEFAULT_AGENT_EXECUTION_PROFILE,
      agentAdapters: Object.freeze(
        (inventory?.agentAdapters ?? []).map((adapter) =>
          Object.freeze({
            provider: adapter.provider === "generic-command" ? "generic" : adapter.provider,
            adapterId: adapter.adapterId,
            readiness: adapter.readiness,
            compatibility: adapter.compatibility,
            models: Object.freeze(
              (adapter.models ?? []).map((model) =>
                Object.freeze({
                  modelId: model.modelId,
                  isDefault: model.isDefault === true,
                }),
              ),
            ),
          }),
        ),
      ),
    });
  }

  #currentHeartbeat(deviceId: string, now: number): WorkerHeartbeatV1 | undefined {
    const observed = this.#heartbeats.get(deviceId);
    if (observed === undefined || now - observed.receivedAtMs > this.#offlineAfterMs) {
      return undefined;
    }
    return observed.heartbeat;
  }

  async #readIdentities(): Promise<readonly PersistedDeviceIdentity[]> {
    const identities = await this.#identities.list();
    if (!Array.isArray(identities)) {
      throw new Error("The Device identity source returned invalid state.");
    }
    const seen = new Set<string>();
    return identities
      .map((identity) => {
        if (identity === null || typeof identity !== "object" || seen.has(identity.deviceId)) {
          throw new Error("The Device identity source returned invalid state.");
        }
        seen.add(identity.deviceId);
        return structuredClone(identity);
      })
      .sort((left, right) => compareText(left.deviceId, right.deviceId));
  }

  async #readProfile(deviceId: string): Promise<MainOwnedDeviceProfile | undefined> {
    const profile = await this.#profiles?.get(deviceId);
    if (profile === undefined) {
      return undefined;
    }
    if (profile === null || typeof profile !== "object") {
      throw new Error("The Main-owned Device profile source returned invalid state.");
    }
    return Object.freeze({
      ...(profile.displayName === undefined
        ? {}
        : { displayName: validateProfileText(profile.displayName, "display name", 253) }),
      ...(profile.roles === undefined
        ? {}
        : { roles: validateProfileList(profile.roles, "role", 128, 256) }),
      ...(profile.instructions === undefined
        ? {}
        : {
            instructions: validateProfileList(profile.instructions, "instruction", 128, 4_096),
          }),
      ...(profile.agentExecutionProfile === undefined
        ? {}
        : {
            agentExecutionProfile: validateAgentExecutionProfile(
              profile.agentExecutionProfile,
              "Worker Agent Execution Profile",
            ),
          }),
      ...(profile.coordinatorAgentExecutionProfile === undefined
        ? {}
        : {
            coordinatorAgentExecutionProfile: validateAgentExecutionProfile(
              profile.coordinatorAgentExecutionProfile,
              "Coordinator Agent Execution Profile",
            ),
          }),
      ...(profile.policies === undefined
        ? {}
        : {
            policies: validatePolicies(profile.policies),
          }),
    });
  }

  async #readDurableObservation(
    deviceId: string,
  ): Promise<Awaited<ReturnType<MainDeviceObservationStore["latest"]>>> {
    const observation = await this.#observations?.latest(deviceId);
    if (observation === undefined) {
      return undefined;
    }
    if (
      observation.deviceId !== deviceId ||
      observation.heartbeat.deviceId !== deviceId ||
      observation.observedAtMs !== observation.heartbeat.observedAtMs
    ) {
      throw new Error("The Main-owned Device observation store returned invalid state.");
    }
    return structuredClone(observation);
  }

  #readNow(): number {
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAXIMUM_DATE_MS) {
      throw new Error("The Main fleet clock is invalid.");
    }
    return now;
  }
}

function projectWakeOnLanReadiness(
  observation: NonNullable<NonNullable<WorkerHeartbeatV1["inventory"]>["wakeOnLan"]>,
): NonNullable<DeviceSummaryV1["wakeOnLan"]> {
  if (observation.state === "unknown") {
    return Object.freeze({
      targetState: "unknown",
      automaticWakeState: "unknown",
      source: observation.source,
      observedAtMs: observation.observedAtMs,
    });
  }
  if (observation.source === "probe-unavailable") {
    throw new Error("Unavailable Wake-on-LAN evidence cannot project a known target state.");
  }
  if (observation.state === "enabled") {
    return Object.freeze({
      targetState: "enabled",
      automaticWakeState: "relay-required",
      source: observation.source,
      observedAtMs: observation.observedAtMs,
    });
  }
  return Object.freeze({
    targetState: observation.state,
    automaticWakeState: "unavailable",
    source: observation.source,
    observedAtMs: observation.observedAtMs,
  });
}

function validateAgentExecutionProfile(value: unknown, label: string): AgentExecutionProfile {
  if (!isAgentExecutionProfile(value)) {
    throw new Error(`The Main-owned ${label} is invalid.`);
  }
  return structuredClone(value);
}

function projectAgentExecutionProfile(
  value: AgentExecutionProfile,
): NonNullable<DeviceSummaryV1["agentExecutionProfile"]> {
  if (value.mode === "auto") {
    return { schemaVersion: 1, mode: "auto" };
  }
  const primary = { ...value.primary };
  return value.mode === "pinned"
    ? { schemaVersion: 1, mode: "pinned", primary }
    : {
        schemaVersion: 1,
        mode: "prefer",
        primary,
        fallbacks: value.fallbacks.map((binding) => ({ ...binding })),
      };
}

function projectDeviceFacts(
  identity: PersistedDeviceIdentity,
  heartbeat: WorkerHeartbeatV1 | undefined,
): NonNullable<DeviceSummaryV1["facts"]> {
  const inventory = heartbeat?.inventory;
  const hardware = inventory?.hardware;
  const facts: NonNullable<DeviceSummaryV1["facts"]> = [
    {
      kind: "os-family" as const,
      value: identity.discovery.osFamily,
      source: "enrollment" as const,
      observedAtMs: identity.createdAt,
      verification: "verified" as const,
    },
    {
      kind: "architecture" as const,
      value: identity.discovery.architecture,
      source: "enrollment" as const,
      observedAtMs: identity.createdAt,
      verification: "verified" as const,
    },
    {
      kind: "hostname" as const,
      value: identity.discovery.hostname,
      source: "enrollment" as const,
      observedAtMs: identity.createdAt,
      verification: "observed" as const,
    },
  ];

  if (inventory !== undefined && heartbeat !== undefined) {
    facts.push({
      kind: "platform-release",
      value: inventory.platformRelease,
      source: "authenticated-heartbeat",
      observedAtMs: heartbeat.observedAtMs,
      verification: "observed",
    });
  }

  if (hardware !== undefined) {
    facts.push(
      {
        kind: "cpu-model",
        value: hardware.cpu.model,
        source: hardware.cpu.source,
        observedAtMs: hardware.cpu.observedAtMs,
        verification: hardware.cpu.verification,
      },
      {
        kind: "cpu-logical-cores",
        value: String(hardware.cpu.logicalCoreCount),
        source: hardware.cpu.source,
        observedAtMs: hardware.cpu.observedAtMs,
        verification: hardware.cpu.verification,
      },
      {
        kind: "memory-total-bytes",
        value: String(hardware.memory.totalBytes),
        source: hardware.memory.source,
        observedAtMs: hardware.memory.observedAtMs,
        verification: hardware.memory.verification,
      },
    );

    if (hardware.gpu.verification !== "not-observed") {
      const verification = hardware.gpu.verification;
      facts.push(
        ...hardware.gpu.devices.map((gpu) => ({
          kind: "gpu-model" as const,
          value: [gpu.vendor, gpu.model].filter(Boolean).join(" "),
          source: hardware.gpu.source,
          observedAtMs: hardware.gpu.observedAtMs,
          verification,
        })),
      );
    }
  }

  return facts;
}

function validatePolicies(
  policies: NonNullable<MainOwnedDeviceProfile["policies"]>,
): NonNullable<MainOwnedDeviceProfile["policies"]> {
  if (!Array.isArray(policies) || policies.length > 256) {
    throw new Error("The Main-owned Device Policy profile is invalid.");
  }
  const seen = new Set<string>();
  return Object.freeze(
    policies.map((policy) => {
      if (
        policy === null ||
        typeof policy !== "object" ||
        Object.keys(policy).some(
          (key) =>
            !["policyId", "actionCategory", "decision", "source", "effectiveScope"].includes(key),
        ) ||
        !Object.prototype.hasOwnProperty.call(policy, "policyId") ||
        !Object.prototype.hasOwnProperty.call(policy, "actionCategory") ||
        !Object.prototype.hasOwnProperty.call(policy, "decision") ||
        !Object.prototype.hasOwnProperty.call(policy, "source") ||
        !Object.prototype.hasOwnProperty.call(policy, "effectiveScope") ||
        typeof policy.policyId !== "string" ||
        typeof policy.actionCategory !== "string" ||
        policy.policyId.length === 0 ||
        policy.policyId.length > 256 ||
        policy.actionCategory.length === 0 ||
        policy.actionCategory.length > 160 ||
        (policy.decision !== "allow" &&
          policy.decision !== "require-approval" &&
          policy.decision !== "deny") ||
        (policy.source !== "built-in" && policy.source !== "configuration") ||
        (policy.effectiveScope !== "instance" &&
          policy.effectiveScope !== "main" &&
          policy.effectiveScope !== "device") ||
        seen.has(policy.policyId)
      ) {
        throw new Error("The Main-owned Device Policy profile is invalid.");
      }
      seen.add(policy.policyId);
      return Object.freeze({ ...policy });
    }),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateProfileList(
  value: readonly string[],
  label: string,
  maximumItems: number,
  maximumLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`The Main-owned Device ${label} profile is invalid.`);
  }
  const result = value.map((entry) => validateProfileText(entry, label, maximumLength));
  if (new Set(result).size !== result.length) {
    throw new Error(`The Main-owned Device ${label} profile is invalid.`);
  }
  return Object.freeze(result);
}

function validateProfileText(value: string, label: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  ) {
    throw new Error(`The Main-owned Device ${label} profile is invalid.`);
  }
  return value;
}
