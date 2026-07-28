import { createHash } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";

import type { AgentAdapterProbe } from "@opendelegate/agent-adapters";
import type { EventStore, StoredEvent } from "@opendelegate/event-store";
import { LocalKnowledgeService } from "@opendelegate/knowledge";
import type { DeviceSummaryV1 } from "@opendelegate/protocol";

type AssessmentCapability = NonNullable<DeviceSummaryV1["capabilities"]>[number];
type AssessmentAgentAdapter = NonNullable<DeviceSummaryV1["agentAdapters"]>[number];

export interface CapabilityAssessmentProbe {
  readonly verification: AssessmentCapability["verification"];
  readonly observedAtMs?: number;
  readonly version?: string;
}

export interface MainDeviceAssessmentObservation {
  readonly schemaVersion: 1;
  readonly deviceId: string;
  readonly observedAtMs: number;
  readonly facts: NonNullable<DeviceSummaryV1["facts"]>;
  readonly capabilities: NonNullable<DeviceSummaryV1["capabilities"]>;
  readonly agentAdapters: NonNullable<DeviceSummaryV1["agentAdapters"]>;
  readonly knowledgeHealth: NonNullable<DeviceSummaryV1["knowledgeHealth"]>;
}

interface MainDeviceAssessmentEventPayload {
  readonly schemaVersion: 1;
  readonly principalId: string;
  readonly requestDigest: string;
  readonly observation: MainDeviceAssessmentObservation;
}

export interface MainDeviceAssessmentOptions {
  readonly deviceId: string;
  readonly knowledgeDirectory: string;
  readonly repository: EventStoreMainDeviceAssessmentRepository;
  readonly probeAgentAdapters: () => Promise<readonly AgentAdapterProbe[]>;
  readonly probeBrowserAutomation: () => Promise<CapabilityAssessmentProbe>;
  readonly probeComputerUse: () => Promise<CapabilityAssessmentProbe>;
  readonly clock?: { now(): number };
}

export class MainDeviceAssessmentService {
  readonly #deviceId: string;
  readonly #knowledge: LocalKnowledgeService;
  readonly #repository: EventStoreMainDeviceAssessmentRepository;
  readonly #probeAgentAdapters: MainDeviceAssessmentOptions["probeAgentAdapters"];
  readonly #probeBrowserAutomation: MainDeviceAssessmentOptions["probeBrowserAutomation"];
  readonly #probeComputerUse: MainDeviceAssessmentOptions["probeComputerUse"];
  readonly #clock: { now(): number };
  readonly #active = new Map<string, Promise<MainDeviceAssessmentObservation>>();

  public constructor(options: MainDeviceAssessmentOptions) {
    this.#deviceId = options.deviceId;
    this.#knowledge = new LocalKnowledgeService({ root: options.knowledgeDirectory });
    this.#repository = options.repository;
    this.#probeAgentAdapters = options.probeAgentAdapters;
    this.#probeBrowserAutomation = options.probeBrowserAutomation;
    this.#probeComputerUse = options.probeComputerUse;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  public async assess(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
  }): Promise<MainDeviceAssessmentObservation> {
    const operationKey = digest(
      `${input.principalId}\u0000${this.#deviceId}\u0000${input.idempotencyKey}`,
    );
    const active = this.#active.get(operationKey);
    if (active !== undefined) {
      return active;
    }
    const result = this.#assessOnce(input);
    this.#active.set(operationKey, result);
    const cleanup = (): void => {
      if (this.#active.get(operationKey) === result) {
        this.#active.delete(operationKey);
      }
    };
    void result.then(cleanup, cleanup);
    return result;
  }

  async #assessOnce(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
  }): Promise<MainDeviceAssessmentObservation> {
    const replay = await this.#repository.replay(
      this.#deviceId,
      input.principalId,
      input.idempotencyKey,
    );
    if (replay !== undefined) {
      return replay;
    }
    const observedAtMs = this.#clock.now();
    const [agentProbes, browserAutomation, computerUse] = await Promise.all([
      this.#probeAgentAdapters(),
      this.#probeBrowserAutomation(),
      this.#probeComputerUse(),
      this.#knowledge.rebuild(),
    ]);
    const capabilities = [
      ...agentProbes.map((probe): AssessmentCapability => ({
        name: probe.provider === "claude" ? "claude-code" : probe.provider,
        verification: agentCapabilityVerification(probe),
        observedAtMs,
        evidenceSource: "agent-adapter",
        ...(probe.version === undefined ? {} : { version: probe.version }),
      })),
      capabilityObservation("browser-automation", browserAutomation, observedAtMs),
      capabilityObservation("computer-use", computerUse, observedAtMs),
    ].sort((left, right) => left.name.localeCompare(right.name, "en"));
    const observation: MainDeviceAssessmentObservation = {
      schemaVersion: 1,
      deviceId: this.#deviceId,
      observedAtMs,
      facts: [
        deviceFact("os-family", osFamily(platform()), observedAtMs),
        deviceFact("platform-release", release(), observedAtMs),
        deviceFact("architecture", arch(), observedAtMs),
        deviceFact("hostname", hostname(), observedAtMs),
      ],
      capabilities,
      agentAdapters: agentProbes
        .map((probe) => agentAdapterObservation(probe, observedAtMs))
        .sort(
          (left, right) =>
            left.provider.localeCompare(right.provider, "en") ||
            left.adapterId.localeCompare(right.adapterId, "en"),
        ),
      knowledgeHealth: "healthy",
    };
    return await this.#repository.record({
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      observation,
    });
  }
}

export class EventStoreMainDeviceAssessmentRepository {
  readonly #eventStore: Pick<EventStore, "append" | "readStream">;

  public constructor(eventStore: Pick<EventStore, "append" | "readStream">) {
    this.#eventStore = eventStore;
  }

  public async latest(deviceId: string): Promise<MainDeviceAssessmentObservation | undefined> {
    const events = await this.#read(deviceId);
    return events.at(-1)?.observation;
  }

  public async replay(
    deviceId: string,
    principalId: string,
    idempotencyKey: string,
  ): Promise<MainDeviceAssessmentObservation | undefined> {
    const requestDigest = digest(idempotencyKey);
    const matching = (await this.#read(deviceId)).find(
      (event) => event.requestDigest === requestDigest,
    );
    if (matching === undefined) {
      return undefined;
    }
    if (matching.principalId !== principalId) {
      throw new Error("The Device assessment idempotency identity conflicts with its owner.");
    }
    return matching.observation;
  }

  public async record(input: {
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly observation: MainDeviceAssessmentObservation;
  }): Promise<MainDeviceAssessmentObservation> {
    const streamId = assessmentStreamId(input.observation.deviceId);
    const existing = await this.replay(
      input.observation.deviceId,
      input.principalId,
      input.idempotencyKey,
    );
    if (existing !== undefined) {
      return existing;
    }
    const events = await this.#eventStore.readStream(streamId);
    const requestDigest = digest(input.idempotencyKey);
    const payload: MainDeviceAssessmentEventPayload = {
      schemaVersion: 1,
      principalId: input.principalId,
      requestDigest,
      observation: structuredClone(input.observation),
    };
    await this.#eventStore.append({
      streamId,
      expectedVersion: events.length,
      events: [
        {
          eventId: `event_${digest(`${streamId}\u0000${requestDigest}`).slice("sha256:".length)}`,
          type: "device.main-assessment-recorded",
          payload,
        },
      ],
    });
    return structuredClone(input.observation);
  }

  async #read(deviceId: string): Promise<readonly MainDeviceAssessmentEventPayload[]> {
    return (await this.#eventStore.readStream(assessmentStreamId(deviceId))).map(
      decodeAssessmentEvent,
    );
  }
}

export function projectMainDeviceAssessment(
  main: DeviceSummaryV1,
  observation: MainDeviceAssessmentObservation | undefined,
): DeviceSummaryV1 {
  if (observation === undefined) {
    return structuredClone(main);
  }
  return {
    ...structuredClone(main),
    lastObservation: {
      observedAtMs: observation.observedAtMs,
      acceptedAtMs: observation.observedAtMs,
      source: "local-assessment",
    },
    facts: observation.facts.map((fact) => ({ ...fact })),
    capabilities: observation.capabilities.map((capability) => ({ ...capability })),
    agentAdapters: observation.agentAdapters.map((adapter) => ({ ...adapter })),
    knowledgeHealth: observation.knowledgeHealth,
  };
}

function capabilityObservation(
  name: string,
  probe: CapabilityAssessmentProbe,
  observedAtMs: number,
): AssessmentCapability {
  return {
    name,
    verification: probe.verification,
    observedAtMs: probe.observedAtMs ?? observedAtMs,
    evidenceSource: "capability-probe",
    ...(probe.version === undefined ? {} : { version: probe.version }),
  };
}

function agentCapabilityVerification(
  probe: AgentAdapterProbe,
): AssessmentCapability["verification"] {
  if (!probe.installed) {
    return "unavailable";
  }
  if (
    probe.compatibility === "incompatible" ||
    probe.auth.state === "not_ready" ||
    probe.auth.state === "unknown" ||
    !probe.capabilities.start ||
    !probe.capabilities.resume ||
    !probe.capabilities.streaming ||
    !probe.capabilities.cancellation
  ) {
    return "degraded";
  }
  return probe.compatibility === "tested" &&
    (probe.auth.state === "ready" || probe.auth.state === "not_required")
    ? "verified"
    : "detected";
}

function agentAdapterObservation(
  probe: AgentAdapterProbe,
  observedAtMs: number,
): AssessmentAgentAdapter {
  return {
    provider: probe.provider === "generic" ? "generic-command" : probe.provider,
    adapterId: probe.adapterId,
    readiness:
      agentCapabilityVerification(probe) === "verified"
        ? "ready"
        : probe.installed
          ? "degraded"
          : "unavailable",
    compatibility: probe.compatibility,
    ...(probe.version === undefined ? {} : { version: probe.version }),
    observedAtMs,
  };
}

function deviceFact(
  kind: NonNullable<DeviceSummaryV1["facts"]>[number]["kind"],
  value: string,
  observedAtMs: number,
): NonNullable<DeviceSummaryV1["facts"]>[number] {
  return {
    kind,
    value,
    source: "node-os",
    observedAtMs,
    verification: "verified",
  };
}

function decodeAssessmentEvent(event: StoredEvent): MainDeviceAssessmentEventPayload {
  if (
    event.type !== "device.main-assessment-recorded" ||
    !isRecord(event.payload) ||
    event.payload["schemaVersion"] !== 1 ||
    typeof event.payload["principalId"] !== "string" ||
    typeof event.payload["requestDigest"] !== "string"
  ) {
    throw new Error("The durable Main Device assessment stream is corrupt.");
  }
  return structuredClone(event.payload) as unknown as MainDeviceAssessmentEventPayload;
}

function assessmentStreamId(deviceId: string): string {
  return `main-device-assessment:${digest(deviceId).slice("sha256:".length)}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function osFamily(value: NodeJS.Platform): "linux" | "macos" | "windows" {
  switch (value) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
