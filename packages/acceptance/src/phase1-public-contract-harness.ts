import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createFakeAgentAdapter,
  type AgentAdapter,
  type AgentAdapterClock,
  type AgentAdapterIdSource,
} from "@opendelegate/agent-adapter";
import {
  ComputerUseError,
  FakeComputerUseBackend,
  createComputerUseInputFingerprint,
  type ComputerUseEvidence,
  type ComputerUseInputAuthorizationRequest,
  type ComputerUseInputAuthorizer,
  type ComputerUseRun,
} from "@opendelegate/computer-use";
import { type EventClock, type EventStore, type StoredEvent } from "@opendelegate/event-store";
import { KnowledgeError, LocalKnowledgeService } from "@opendelegate/knowledge";
import {
  createOpenDelegate,
  InMemoryOrchestrationJournal,
  type ArtifactContent,
  type ArtifactGateway,
  type ArtifactPublishInput,
  type ArtifactReference,
  type ChannelAuthorizer,
  type Coordinator,
  type CoordinatorIntakeDecision,
  type CoordinatorIntakeInput,
  type CoordinatorPlan,
  type CoordinatorPlanInput,
  type CoordinatorReview,
  type CoordinatorReviewInput,
  type CoordinatorSynthesis,
  type CoordinatorSynthesisInput,
  type DispatchPolicyEvaluator,
  type OpenDelegate,
  type OrchestrationIdSource,
  type PlannedWorkOrder,
  type RunAssignment,
  type RunAssignmentSource,
  type RunAssignmentTarget,
  type TaskView,
  type Worker,
  type WorkerDeviceSnapshot,
  type WorkerExecutionInput,
  type WorkerExecutionResult,
} from "@opendelegate/orchestrator";
import {
  createActionFingerprint,
  enforceAction,
  evaluateAction,
  InMemoryOnceGrantConsumptionStore,
  isActionFingerprint,
  type ActionCategory,
  type ActionFingerprint,
  type OwnerGrant,
  type PolicyCode,
} from "@opendelegate/policy";
import {
  PROTOCOL_VERSION,
  parseApplicationRequestEnvelope,
  parseArtifactReference,
  parseEventEnvelope,
  parseForumTaskIntake,
  parseSemanticDeviceSelectionRequest,
  parseSemanticDeviceSelectionResponse,
  parseSemanticPlanningRequest,
  parseSemanticPlanningResponse,
  parseWorkOrder,
  parseWorkerReport,
  type WorkOrderV1,
} from "@opendelegate/protocol";
import {
  DESKTOP_SESSION_RESOURCE,
  ResourceLockKernel,
  type Clock as ResourceClock,
  type ResourceLease,
} from "@opendelegate/resource-locks";
import { type DeviceCandidate } from "@opendelegate/scheduler";
import {
  InMemorySecretStore,
  SecretLeaseBroker,
  type Clock as SecretClock,
  type SecretLeaseIdSource,
} from "@opendelegate/secrets";
import {
  createTransportResolver,
  type TransportConnectionFailed,
  type TransportConnected,
  type TransportProfile,
} from "@opendelegate/transport";

const NOW_ISO = "2026-07-24T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const LEASE_MS = 60_000;
const TASK_ID = "task-rich-phase-1";
const FORUM_ID = "forum-owner-work";
const POST_ID = "post-rich-phase-1";
const OWNER_ID = "owner-primary";
const OWNER_AUTHOR_ID = "discord-owner";
const CLARIFICATION_ID = "clarification-execution-scope";
const CLARIFICATION_QUESTION =
  "Should this Task use only deterministic fake Devices and keep local Knowledge private?";
const CLARIFICATION_ANSWER =
  "Yes. Use only deterministic fake Devices and keep Device-local Knowledge and Secrets off Main.";
const RUN_RESOURCE = "worker-run";
const RESEARCH_DEVICE_ID = "device-research";
const DESKTOP_DEVICE_ID = "device-desktop";
const RESEARCH_WORKER_ID = "worker-research";
const DESKTOP_WORKER_ID = "worker-desktop";
const RESEARCH_SECRET = "research-local-credential";
const DESKTOP_SECRET = "desktop-local-credential";
const COMPUTER_WORK_ORDER_ID = "work-order-computer-use";
const RESEARCH_WORK_ORDER_ID = "work-order-research";
const SUMMARY_WORK_ORDER_ID = "work-order-summary";

export type RichPhase1Scenario =
  | "allowed"
  | "computer-input-denied"
  | "computer-input-once-replay"
  | "computer-input-once-restart-replay"
  | "missing-secret"
  | "policy-denied"
  | "stale-fence";

export interface RichPhase1HarnessOptions {
  readonly eventStoreLifecycle?: RichPhase1EventStoreLifecycle;
  readonly knowledgeRoot: string;
  readonly scenario: RichPhase1Scenario;
}

export interface RichPhase1EventStoreLifecycle {
  open(clock: EventClock): Promise<EventStore>;
  restart(current: EventStore, clock: EventClock): Promise<EventStore>;
  close(current: EventStore): Promise<void>;
}

export interface RichPhase1DesktopEvidence {
  readonly kind: "screenshot";
  readonly mediaType: "image/png";
  readonly state: "success";
  readonly width: 1280;
  readonly height: 720;
}

export interface RichPhase1Evidence {
  readonly selectedDeviceIds: readonly string[];
  readonly transportEndpointIds: readonly string[];
  readonly runFencingTokens: readonly number[];
  readonly policyAllowCount: number;
  readonly policyDecisionCodes: readonly PolicyCode[];
  readonly dispatchPolicyEvaluations: readonly string[];
  readonly secretExecutionCount: number;
  readonly knowledgeRetrievalCount: number;
  readonly agentTurnCount: number;
  readonly maxConcurrentWorkerRuns: number;
  readonly dependencyWaveProven: boolean;
  readonly crossDeviceKnowledgeRejected: boolean;
  readonly restartCount: number;
  readonly coordinatorCallCounts: Readonly<{
    assess: number;
    plan: number;
    synthesize: number;
    review: number;
  }>;
  readonly desktopContentionRejected: boolean;
  readonly desktopEvidence: RichPhase1DesktopEvidence | null;
  readonly computerInputOnceGrant: Readonly<{
    firstUseAllowCount: number;
    competingReplayRejected: boolean;
    consumedGrantCount: number;
  }>;
  readonly replayMatched: boolean;
}

export interface RichPhase1Clarification {
  readonly taskId: string;
  readonly state: "waiting_user";
  readonly clarificationId: string;
  readonly question: string;
  readonly answeredBy: string;
  readonly answer: string;
}

export interface RichPhase1Execution {
  readonly task: TaskView;
  readonly replayedTask: TaskView;
  readonly artifact: ArtifactContent;
  readonly clarification: RichPhase1Clarification;
  readonly evidence: RichPhase1Evidence;
  readonly journalEventTypes: readonly string[];
  readonly orchestrationEvents: readonly {
    readonly type: string;
    readonly workOrderId?: string;
  }[];
}

export interface RichPhase1Diagnostics {
  readonly artifactPublishCount: number;
  readonly transportConnectionCount: number;
  readonly secretExecutionCount: number;
  readonly computerInputPolicyDecisions: readonly PolicyCode[];
  readonly computerInputRequestedAtMs: readonly number[];
  readonly workerSideEffects: readonly string[];
}

export interface RichPhase1Harness {
  execute(): Promise<RichPhase1Execution>;
  diagnostics(): RichPhase1Diagnostics;
}

interface MutableEvidence {
  readonly selectedDeviceIds: string[];
  readonly transportEndpointIds: string[];
  readonly runFencingTokens: number[];
  policyAllowCount: number;
  readonly policyDecisionCodes: PolicyCode[];
  readonly dispatchPolicyEvaluations: string[];
  secretExecutionCount: number;
  knowledgeRetrievalCount: number;
  agentTurnCount: number;
  maxConcurrentWorkerRuns: number;
  crossDeviceKnowledgeRejected: boolean;
  restartCount: number;
  desktopContentionRejected: boolean;
  desktopEvidence: RichPhase1DesktopEvidence | null;
  readonly computerInputOnceGrant: {
    firstUseAllowCount: number;
    competingReplayRejected: boolean;
    consumedGrantCount: number;
  };
  replayMatched: boolean;
}

interface MutableDiagnostics {
  artifactPublishCount: number;
  transportConnectionCount: number;
  readonly computerInputPolicyDecisions: PolicyCode[];
  readonly computerInputRequestedAtMs: number[];
  readonly workerSideEffects: string[];
}

interface FakeTransportConnection {
  readonly endpointId: string;
  readonly deviceId: string;
}

class NumericClock implements ResourceClock, SecretClock {
  private currentTimeMs = NOW_MS;

  public now(): number {
    return this.currentTimeMs;
  }

  public advanceBy(durationMs: number): void {
    this.currentTimeMs += durationMs;
  }
}

class StringClock implements AgentAdapterClock, EventClock {
  public now(): string {
    return NOW_ISO;
  }
}

class DeterministicIds implements AgentAdapterIdSource, SecretLeaseIdSource {
  private event = 0;
  private checkpoint = 0;
  private message = 0;
  private session = 0;
  private secretLease = 0;
  private turn = 0;

  public nextNativeSessionId(): string {
    return `native-session-${String(++this.session)}`;
  }
  public nextTurnId(): string {
    return `agent-turn-${String(++this.turn)}`;
  }
  public nextEventId(): string {
    return `agent-event-${String(++this.event)}`;
  }
  public nextCheckpointId(): string {
    return `checkpoint-${String(++this.checkpoint)}`;
  }
  public nextLeaseId(): string {
    return `secret-lease-${String(++this.secretLease)}`;
  }
  public nextMessageId(): string {
    return `message-${String(++this.message)}`;
  }
}

class ProtocolBoundary {
  private readonly ids: DeterministicIds;

  public constructor(ids: DeterministicIds) {
    this.ids = ids;
  }

  public request<T>(
    type: string,
    senderDeviceId: string,
    payload: unknown,
    parser: (input: unknown) => T,
  ): T {
    return parseApplicationRequestEnvelope(this.envelope(type, senderDeviceId, payload), parser)
      .payload;
  }

  public event<T>(
    type: string,
    senderDeviceId: string,
    payload: unknown,
    parser: (input: unknown) => T,
  ): T {
    return parseEventEnvelope(this.envelope(type, senderDeviceId, payload), parser).payload;
  }

  private envelope(type: string, senderDeviceId: string, payload: unknown): unknown {
    const messageId = this.ids.nextMessageId();
    return {
      protocolVersion: PROTOCOL_VERSION,
      messageId,
      senderDeviceId,
      correlationId: TASK_ID,
      createdAt: NOW_ISO,
      idempotencyKey: `idempotency-${messageId}`,
      type,
      payload,
    };
  }
}

class FixedTaskIds implements OrchestrationIdSource {
  private consumed = false;

  public nextTaskId(): string | undefined {
    if (this.consumed) {
      return undefined;
    }
    this.consumed = true;
    return TASK_ID;
  }
}

class LeasedRunAssignments implements RunAssignmentSource {
  private sequence = 0;
  private readonly locks: ResourceLockKernel;
  private readonly scenario: RichPhase1Scenario;

  public constructor(locks: ResourceLockKernel, scenario: RichPhase1Scenario) {
    this.locks = locks;
    this.scenario = scenario;
  }

  public nextRun(input: RunAssignmentTarget): RunAssignment {
    const runId = `run-${String(++this.sequence)}`;
    const lease = this.locks.acquire({
      commandId: `acquire-${runId}`,
      resourceName: RUN_RESOURCE,
      holderId: runId,
      leaseDurationMs: LEASE_MS,
    });
    if (this.scenario === "stale-fence") {
      this.locks.release({
        resourceName: lease.resourceName,
        holderId: lease.holderId,
        fencingToken: lease.fencingToken,
      });
      this.locks.acquire({
        commandId: `replace-${runId}`,
        resourceName: RUN_RESOURCE,
        holderId: `replacement-${runId}`,
        leaseDurationMs: LEASE_MS,
      });
    }
    return Object.freeze({
      ...input,
      runId,
      idempotencyKey: `dispatch-${runId}`,
      leaseId: leaseId(lease),
      fencingToken: lease.fencingToken,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
    });
  }

  public releaseAll(): void {
    for (const resource of this.locks.snapshot().resources) {
      for (const lease of resource.activeLeases) {
        this.locks.release({
          resourceName: lease.resourceName,
          holderId: lease.holderId,
          fencingToken: lease.fencingToken,
        });
      }
    }
  }
}

class AllowlistedChannel implements ChannelAuthorizer {
  public async authorizeForumPost(input: {
    readonly forumId: string;
    readonly postId: string;
    readonly authorId: string;
  }) {
    return input.forumId === FORUM_ID &&
      input.postId === POST_ID &&
      input.authorId === OWNER_AUTHOR_ID
      ? ({ decision: "allow", principalId: OWNER_ID } as const)
      : ({ decision: "deny", reason: "The Forum author is not allowlisted." } as const);
  }
}

class Phase1Coordinator implements Coordinator {
  public assessCalls = 0;
  public planCalls = 0;
  public synthesisCalls = 0;
  public reviewCalls = 0;
  private readonly protocol: ProtocolBoundary;
  private readonly workOrders: Map<string, WorkOrderV1>;

  public constructor(protocol: ProtocolBoundary, workOrders: Map<string, WorkOrderV1>) {
    this.protocol = protocol;
    this.workOrders = workOrders;
  }

  public async assessIntake(input: CoordinatorIntakeInput): Promise<CoordinatorIntakeDecision> {
    this.assessCalls += 1;
    if (input.taskId !== TASK_ID || input.forumPost.postId !== POST_ID) {
      throw new Error("The Coordinator received unexpected intake.");
    }
    return {
      decision: "clarification",
      clarification: {
        clarificationId: CLARIFICATION_ID,
        question: CLARIFICATION_QUESTION,
      },
    };
  }

  public async plan(input: CoordinatorPlanInput): Promise<CoordinatorPlan> {
    this.planCalls += 1;
    if (
      input.clarification?.clarificationId !== CLARIFICATION_ID ||
      input.clarification.question !== CLARIFICATION_QUESTION ||
      input.clarification.answer !== CLARIFICATION_ANSWER
    ) {
      throw new Error("Planning requires the owner clarification answer.");
    }
    const request = this.protocol.request(
      "planning.requested",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        taskId: input.taskId,
        objective: "Produce a private readiness report through independent Device Workers.",
        completionCriteria: [
          "Collect local readiness evidence.",
          "Complete the deterministic Computer Use fixture.",
          "Reconcile the independent results in a dependent Work Order.",
          "Present one openable Artifact.",
        ],
        constraints: [
          "Keep Device-local Knowledge and Secret values off Main.",
          "Enforce scheduling, Policy, transport, leases, and fencing in code.",
        ],
        selectedInputRefs: [`forum-post:${input.forumPost.postId}`],
        decisions: ["Use deterministic public contracts only."],
        openQuestions: [],
        eligibleDevices: [],
      },
      parseSemanticPlanningRequest,
    );
    const response = this.protocol.event(
      "planning.completed",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        taskId: request.taskId,
        workOrders: [
          {
            protocolVersion: PROTOCOL_VERSION,
            workOrderId: RESEARCH_WORK_ORDER_ID,
            title: "Collect Quasar readiness evidence",
            brief: "Use the quasar readiness procedure.",
            completionCriteria: ["Return a concise readiness result."],
            constraints: ["Do not return local Knowledge content to Main."],
            selectedInputIds: [`forum-post:${POST_ID}`],
            dependsOn: [],
            schedulingHints: {
              preferredDeviceIds: [RESEARCH_DEVICE_ID],
              preferredRoles: ["researcher"],
            },
            requiredCapabilities: ["research"],
            requiredSecretRefs: [RESEARCH_SECRET],
            requiredOsFamily: "linux",
            workspaceId: `workspace-${RESEARCH_DEVICE_ID}`,
          },
          {
            protocolVersion: PROTOCOL_VERSION,
            workOrderId: COMPUTER_WORK_ORDER_ID,
            title: "Complete the Zephyr desktop fixture",
            brief: "Use the zephyr desktop procedure.",
            completionCriteria: ["Reach visible success and return screenshot metadata."],
            constraints: ["Authorize every input and hold desktop-session."],
            selectedInputIds: [`forum-post:${POST_ID}`],
            dependsOn: [],
            schedulingHints: {
              preferredDeviceIds: [DESKTOP_DEVICE_ID],
              preferredRoles: ["desktop-operator"],
            },
            requiredCapabilities: ["computer-use"],
            requiredSecretRefs: [DESKTOP_SECRET],
            requiredOsFamily: "windows",
            workspaceId: `workspace-${DESKTOP_DEVICE_ID}`,
          },
          {
            protocolVersion: PROTOCOL_VERSION,
            workOrderId: SUMMARY_WORK_ORDER_ID,
            title: "Reconcile Device readiness",
            brief: "Use the quasar summary procedure after both prerequisite reports.",
            completionCriteria: ["Return a reconciled readiness statement."],
            constraints: ["Run only after both independent Work Orders."],
            selectedInputIds: [`forum-post:${POST_ID}`],
            dependsOn: [RESEARCH_WORK_ORDER_ID, COMPUTER_WORK_ORDER_ID],
            schedulingHints: {
              preferredDeviceIds: [RESEARCH_DEVICE_ID],
              preferredRoles: ["researcher"],
            },
            requiredCapabilities: ["research"],
            requiredSecretRefs: [RESEARCH_SECRET],
            requiredOsFamily: "linux",
            workspaceId: `workspace-${RESEARCH_DEVICE_ID}`,
          },
        ],
      },
      parseSemanticPlanningResponse,
    );
    for (const workOrder of response.workOrders) {
      this.workOrders.set(workOrder.workOrderId, workOrder);
    }
    return {
      taskBrief: {
        objective: request.objective,
        completionCriteria: request.completionCriteria,
        constraints: request.constraints,
        knownInputIds: request.selectedInputRefs,
        decisions: request.decisions,
        openQuestions: request.openQuestions,
      },
      workOrders: response.workOrders.map(toPlannedWorkOrder),
    };
  }

  public async selectDevice(input: Parameters<Coordinator["selectDevice"]>[0]) {
    const request = this.protocol.request(
      "planning.device-selection.requested",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        taskId: input.taskId,
        workOrder: {
          protocolVersion: PROTOCOL_VERSION,
          ...input.workOrder,
        },
        eligibleDevices: input.eligibleDevices.map((candidate) => ({
          protocolVersion: PROTOCOL_VERSION,
          ...candidate,
        })),
      },
      parseSemanticDeviceSelectionRequest,
    );
    const preferredDevice = request.eligibleDevices[0];
    if (preferredDevice === undefined) {
      throw new Error("Semantic Device selection requires an eligible Device.");
    }
    const response = this.protocol.event(
      "planning.device-selection.completed",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        taskId: request.taskId,
        workOrderId: request.workOrder.workOrderId,
        preferredDeviceId: preferredDevice.deviceId,
      },
      parseSemanticDeviceSelectionResponse,
    );
    return response;
  }

  public async synthesize(input: CoordinatorSynthesisInput): Promise<CoordinatorSynthesis> {
    this.synthesisCalls += 1;
    if (input.reports.length !== 3) {
      throw new Error("Synthesis requires all three Worker reports.");
    }
    return {
      summary: "Both Device Workers and the dependent reconciliation completed.",
      artifact: {
        filename: "phase-1-public-contract-report.html",
        mediaType: "text/html",
        content:
          "<h1>Phase 1 public-contract report</h1><p>Independent Device work and dependent reconciliation completed through deterministic safety gates.</p>",
      },
    };
  }

  public async review(input: CoordinatorReviewInput): Promise<CoordinatorReview> {
    this.reviewCalls += 1;
    if (input.reports.length !== 3 || input.workOrders.length !== 3) {
      throw new Error("Review requires the complete Work Order graph.");
    }
    return {
      decision: "complete",
      verifiedCompletionCriteria: input.taskBrief.completionCriteria,
    };
  }
}

class Phase1ArtifactGateway implements ArtifactGateway {
  private readonly artifacts = new Map<string, ArtifactContent>();
  private readonly publications = new Map<string, ArtifactReference>();
  private readonly diagnostics: MutableDiagnostics;
  private readonly protocol: ProtocolBoundary;

  public constructor(diagnostics: MutableDiagnostics, protocol: ProtocolBoundary) {
    this.diagnostics = diagnostics;
    this.protocol = protocol;
  }

  public async publish(input: ArtifactPublishInput): Promise<ArtifactReference> {
    const prior = this.publications.get(input.idempotencyKey);
    if (prior !== undefined) {
      return prior;
    }
    const reference = this.protocol.event(
      "artifact.presented",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        artifactId: "artifact-rich-phase-1",
        href: "https://artifacts.example.test/phase-1-public-contract-report",
      },
      parseArtifactReference,
    );
    this.artifacts.set(reference.artifactId, {
      filename: input.filename,
      mediaType: input.mediaType,
      content: input.content,
    });
    this.publications.set(input.idempotencyKey, reference);
    this.diagnostics.artifactPublishCount += 1;
    return reference;
  }

  public open(reference: ArtifactReference): ArtifactContent | undefined {
    return this.artifacts.get(reference.artifactId);
  }
}

class Phase1DispatchPolicy implements DispatchPolicyEvaluator {
  private readonly scenario: RichPhase1Scenario;
  private readonly evidence: MutableEvidence;

  public constructor(scenario: RichPhase1Scenario, evidence: MutableEvidence) {
    this.scenario = scenario;
    this.evidence = evidence;
  }

  public evaluate(input: Parameters<DispatchPolicyEvaluator["evaluate"]>[0]) {
    const actionCategory: ActionCategory =
      this.scenario === "policy-denied"
        ? "policy-bypass-attempt"
        : input.workOrder.workOrderId === COMPUTER_WORK_ORDER_ID
          ? "computer-use-input"
          : "read-only-observation";
    const fingerprint = dispatchFingerprint(input.workOrder.workOrderId, input.device.deviceId);
    const grant: OwnerGrant = {
      grantId: "grant-desktop-dispatch",
      issuer: "owner",
      actionCategory: "computer-use-input",
      expiresAt: NOW_MS + LEASE_MS,
      scope: {
        kind: "task",
        taskId: TASK_ID,
        actionFingerprint: dispatchFingerprint(COMPUTER_WORK_ORDER_ID, DESKTOP_DEVICE_ID),
      },
    };
    const decision = evaluateAction(
      {
        requestId: `dispatch:${input.workOrder.workOrderId}:${input.device.deviceId}`,
        actionCategory,
        actionFingerprint: fingerprint,
        taskId: input.taskId,
        deviceId: input.device.deviceId,
      },
      { now: NOW_MS, grants: [grant] },
    );
    this.evidence.dispatchPolicyEvaluations.push(
      `${input.workOrder.workOrderId}:${input.device.deviceId}:${decision.outcome}`,
    );
    return { outcome: decision.outcome, code: decision.code };
  }
}

class ConcurrentRunProbe {
  private active = 0;
  private readonly arrivals = new Set<string>();
  private release!: () => void;
  private readonly released: Promise<void>;
  private readonly evidence: MutableEvidence;

  public constructor(evidence: MutableEvidence) {
    this.evidence = evidence;
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  public async enter(workOrderId: string): Promise<() => void> {
    this.active += 1;
    this.evidence.maxConcurrentWorkerRuns = Math.max(
      this.evidence.maxConcurrentWorkerRuns,
      this.active,
    );
    if (workOrderId === RESEARCH_WORK_ORDER_ID || workOrderId === COMPUTER_WORK_ORDER_ID) {
      this.arrivals.add(workOrderId);
      if (this.arrivals.size === 2) {
        this.release();
      }
      await this.released;
    }
    return () => {
      this.active -= 1;
    };
  }
}

class SimulatedRuntimeInterruption extends Error {
  public constructor() {
    super("simulated runtime interruption before desktop side effects");
  }
}

class DeviceWorker implements Worker {
  public readonly workerId: string;
  public readonly deviceId: string;
  public readonly scheduling: WorkerDeviceSnapshot;
  private interrupted = false;
  private readonly common: WorkerCommon;

  public constructor(
    options: {
      readonly deviceId: string;
      readonly workerId: string;
      readonly scheduling: WorkerDeviceSnapshot;
      readonly secretAlias: string;
      readonly agent: AgentAdapter;
      readonly knowledge: LocalKnowledgeService;
      readonly secretBroker: SecretLeaseBroker;
      readonly computerUse?: FakeComputerUseBackend;
    },
    common: WorkerCommon,
  ) {
    this.deviceId = options.deviceId;
    this.workerId = options.workerId;
    this.scheduling = options.scheduling;
    this.secretAlias = options.secretAlias;
    this.agent = options.agent;
    this.knowledge = options.knowledge;
    this.secretBroker = options.secretBroker;
    this.computerUse = options.computerUse;
    this.common = common;
  }

  private readonly secretAlias: string;
  private readonly agent: AgentAdapter;
  private readonly knowledge: LocalKnowledgeService;
  private readonly secretBroker: SecretLeaseBroker;
  private readonly computerUse: FakeComputerUseBackend | undefined;

  public async execute(input: WorkerExecutionInput): Promise<WorkerExecutionResult> {
    this.assertBinding(input);
    const leave = await this.common.concurrentRuns.enter(input.workOrder.workOrderId);
    let runLease: ResourceLease | undefined;
    try {
      if (
        this.common.scenario === "allowed" &&
        this.deviceId === DESKTOP_DEVICE_ID &&
        !this.interrupted
      ) {
        this.interrupted = true;
        throw new SimulatedRuntimeInterruption();
      }
      runLease = this.validateRunLease(input.run);
      const versioned = this.common.workOrders.get(input.workOrder.workOrderId);
      if (versioned === undefined) {
        throw new Error("The Device Worker received an unplanned Work Order.");
      }
      const workOrder = this.common.protocol.event(
        "work-order.dispatched",
        "main-device",
        versioned,
        parseWorkOrder,
      );
      this.authorizeObservation(input);
      const transport = await this.connectTransport();
      if (transport.endpointId !== input.run.routeId) {
        throw new Error("The Worker transport did not match the bound Run route.");
      }
      this.common.evidence.selectedDeviceIds.push(this.deviceId);
      this.common.evidence.transportEndpointIds.push(transport.endpointId);
      this.common.evidence.runFencingTokens.push(runLease.fencingToken);

      const lease = this.secretBroker.issueLease({
        deviceId: this.deviceId,
        consumerId: this.workerId,
        runId: input.run.runId,
        secretAlias: this.secretAlias,
        ttlMs: LEASE_MS,
      });
      let report: string | undefined;
      await this.secretBroker.executeWithLease(
        {
          leaseId: lease.leaseId,
          deviceId: this.deviceId,
          consumerId: this.workerId,
          runId: input.run.runId,
        },
        async (secret) => {
          if (secret.length === 0) {
            throw new Error("The Device-local Secret is empty.");
          }
          this.common.evidence.secretExecutionCount += 1;
          report = await this.executeLocally(input, workOrder);
        },
      );
      if (report === undefined) {
        throw new Error("The Device Worker did not produce a report.");
      }
      const parsed = this.common.protocol.event(
        "worker.reported",
        this.deviceId,
        {
          protocolVersion: PROTOCOL_VERSION,
          taskId: input.taskId,
          workOrderId: workOrder.workOrderId,
          deviceId: this.deviceId,
          workerId: this.workerId,
          routeId: input.run.routeId,
          runId: input.run.runId,
          leaseId: input.run.leaseId,
          fencingToken: input.run.fencingToken,
          status: "succeeded",
          report,
          artifactRefs: [],
        },
        parseWorkerReport,
      );
      return {
        taskId: parsed.taskId,
        workOrderId: parsed.workOrderId,
        deviceId: parsed.deviceId,
        workerId: parsed.workerId,
        routeId: parsed.routeId,
        runId: parsed.runId,
        leaseId: parsed.leaseId,
        fencingToken: parsed.fencingToken,
        report: parsed.report,
      };
    } finally {
      if (runLease !== undefined) {
        this.common.locks.release({
          resourceName: runLease.resourceName,
          holderId: runLease.holderId,
          fencingToken: runLease.fencingToken,
        });
      }
      leave();
    }
  }

  private assertBinding(input: WorkerExecutionInput): void {
    if (
      input.taskId !== input.run.taskId ||
      input.workOrder.workOrderId !== input.run.workOrderId ||
      input.run.deviceId !== this.deviceId ||
      input.run.workerId !== this.workerId ||
      !this.scheduling.routes.some((route) => route.routeId === input.run.routeId)
    ) {
      throw new Error("The Worker rejected a Run assignment outside its exact binding.");
    }
  }

  private validateRunLease(run: RunAssignment): ResourceLease {
    if (
      run.leaseId !== `${RUN_RESOURCE}:${String(run.fencingToken)}` ||
      Date.parse(run.expiresAt) <= NOW_MS
    ) {
      throw new Error("The Run lease is invalid or expired.");
    }
    return this.common.locks.renew({
      commandId: `renew-run-execution:${run.runId}`,
      resourceName: RUN_RESOURCE,
      holderId: run.runId,
      fencingToken: run.fencingToken,
      leaseDurationMs: LEASE_MS,
    });
  }

  private authorizeObservation(input: WorkerExecutionInput): void {
    const decision = evaluateAction(
      {
        requestId: `observe:${input.run.runId}`,
        actionCategory: "read-only-observation",
        actionFingerprint: createActionFingerprint({
          kind: "device-worker-observation",
          operation: "retrieve-local-context",
          target: {
            taskId: input.taskId,
            deviceId: this.deviceId,
            workOrderId: input.workOrder.workOrderId,
          },
        }),
        taskId: input.taskId,
        deviceId: this.deviceId,
      },
      { now: NOW_MS, grants: [] },
    );
    if (decision.outcome !== "allow") {
      throw new Error("Read-only Worker preparation was not authorized.");
    }
    recordAllowedPolicy(this.common.evidence, decision.code);
  }

  private async connectTransport(): Promise<FakeTransportConnection> {
    const profile: TransportProfile = {
      deviceId: this.deviceId,
      endpoints: [
        {
          endpointId: `endpoint-${this.deviceId}-unhealthy`,
          label: "Unavailable private route",
          kind: "https",
          url: `https://${this.deviceId}.unavailable.test`,
          credentialRef: this.secretAlias,
        },
        {
          endpointId: `endpoint-${this.deviceId}-primary`,
          label: "Authenticated private route",
          kind: "wss",
          url: `wss://${this.deviceId}.private.test`,
          credentialRef: this.secretAlias,
        },
      ],
    };
    return (await this.common.transport.connect(profile)).connection;
  }

  private async executeLocally(
    input: WorkerExecutionInput,
    workOrder: WorkOrderV1,
  ): Promise<string> {
    const candidate = this.knowledge.search(workOrder.brief, { limit: 1 })[0];
    if (candidate === undefined) {
      throw new Error("Device-local Knowledge returned no candidate.");
    }
    const opened = this.knowledge.openNotes([candidate.noteId], {
      totalCharacterBudget: 512,
    });
    const localContext = opened.notes[0]?.content;
    if (localContext === undefined || opened.notes.length !== 1) {
      throw new Error("Device-local Knowledge could not be opened within budget.");
    }
    this.common.evidence.knowledgeRetrievalCount += 1;

    let computerRun: ComputerUseRun | undefined;
    if (workOrder.workOrderId === COMPUTER_WORK_ORDER_ID) {
      if (this.computerUse === undefined) {
        throw new Error("The assigned Device has no Computer Use backend.");
      }
      computerRun = this.computerUse.startRun({
        commandId: `desktop-${input.run.runId}`,
        taskId: input.taskId,
        deviceId: this.deviceId,
        runId: input.run.runId,
        leaseDurationMs: LEASE_MS,
      });
      this.proveDesktopExclusion(input);
    }

    try {
      const session = await this.agent.startSession({
        taskId: input.taskId,
        deviceId: this.deviceId,
        workspaceId: `workspace-${this.deviceId}`,
        workingDirectory: `/workspace/${this.deviceId}`,
      });
      const turn = await this.agent.startTurn({
        session,
        input: `${workOrder.workOrderId}\n${localContext}`,
      });
      this.common.diagnostics.workerSideEffects.push(`agent-turn:${workOrder.workOrderId}`);
      this.common.evidence.agentTurnCount += 1;
      let result: string | undefined;
      for await (const event of turn.events) {
        if (event.type === "completed") {
          result = event.result;
        }
        if (event.type === "failed") {
          throw new Error(`The fake Agent failed: ${event.code}.`);
        }
      }
      if (result === undefined) {
        throw new Error("The fake Agent turn did not complete.");
      }
      if (computerRun !== undefined) {
        computerRun.observe();
        computerRun.typeText({ controlId: "text-input", text: "Zephyr acceptance" });
        if (this.common.scenario === "computer-input-once-restart-replay") {
          this.common.computerInputAuthorizer.restart();
          this.common.clock.advanceBy(1);
          computerRun.typeText({ controlId: "text-input", text: "Zephyr acceptance" });
        } else if (this.common.scenario === "computer-input-once-replay") {
          this.common.clock.advanceBy(1);
          computerRun.typeText({ controlId: "text-input", text: "Zephyr acceptance" });
        }
        computerRun.click({ controlId: "option-alpha" });
        computerRun.click({ controlId: "submit" });
        const evidence = computerRun.captureEvidence();
        this.common.diagnostics.workerSideEffects.push(`computer-use:${workOrder.workOrderId}`);
        this.common.evidence.desktopEvidence = toDesktopEvidence(evidence);
        return `${result} Screenshot evidence reached visible success.`;
      }
      return result;
    } finally {
      computerRun?.release();
    }
  }

  private proveDesktopExclusion(input: WorkerExecutionInput): void {
    try {
      const contender = this.computerUse?.startRun({
        commandId: `desktop-contender-${input.run.runId}`,
        taskId: input.taskId,
        deviceId: this.deviceId,
        runId: `contender-${input.run.runId}`,
        leaseDurationMs: LEASE_MS,
      });
      contender?.release();
      throw new Error("A second Computer Use Run acquired desktop-session.");
    } catch (error: unknown) {
      if (error instanceof ComputerUseError && error.code === "DESKTOP_SESSION_BUSY") {
        this.common.evidence.desktopContentionRejected = true;
        return;
      }
      throw error;
    }
  }
}

interface WorkerCommon {
  readonly scenario: RichPhase1Scenario;
  readonly protocol: ProtocolBoundary;
  readonly workOrders: ReadonlyMap<string, WorkOrderV1>;
  readonly locks: ResourceLockKernel;
  readonly transport: ReturnType<typeof createTransportResolver<FakeTransportConnection>>;
  readonly evidence: MutableEvidence;
  readonly diagnostics: MutableDiagnostics;
  readonly concurrentRuns: ConcurrentRunProbe;
  readonly computerInputAuthorizer: ExactComputerInputAuthorizer;
  readonly clock: NumericClock;
}

class ExactComputerInputAuthorizer implements ComputerUseInputAuthorizer {
  private readonly grants: readonly OwnerGrant[];
  private readonly evidence: MutableEvidence;
  private readonly diagnostics: MutableDiagnostics;
  private consumptions = new InMemoryOnceGrantConsumptionStore();
  private competingProofRecorded = false;

  public constructor(
    expectedInputs: readonly ExpectedComputerInput[],
    evidence: MutableEvidence,
    diagnostics: MutableDiagnostics,
  ) {
    this.evidence = evidence;
    this.diagnostics = diagnostics;
    this.grants = expectedInputs.map((input, index) => ({
      grantId: `computer-input-grant-${String(index + 1)}`,
      issuer: "owner",
      actionCategory: "computer-use-input",
      expiresAt: NOW_MS + LEASE_MS,
      scope: {
        kind: "once",
        requestId: computerInputRequestId(input),
        actionFingerprint: input.fingerprint,
      },
    }));
  }

  public authorize(request: ComputerUseInputAuthorizationRequest) {
    if (!isActionFingerprint(request.fingerprint)) {
      throw new Error("Computer Use produced an invalid action fingerprint.");
    }
    const policyRequest = toComputerInputPolicyRequest(request, request.fingerprint);
    this.diagnostics.computerInputRequestedAtMs.push(request.requestedAtMs);
    const decision = enforceAction(
      policyRequest,
      { now: request.requestedAtMs, grants: this.grants },
      this.consumptions,
    );
    this.diagnostics.computerInputPolicyDecisions.push(decision.code);
    if (decision.outcome === "allow") {
      recordAllowedPolicy(this.evidence, decision.code);
      this.evidence.computerInputOnceGrant.firstUseAllowCount += 1;
      this.recordCompetingProof(policyRequest, request.requestedAtMs);
    }
    this.evidence.computerInputOnceGrant.consumedGrantCount = this.consumptions.snapshot().length;
    return {
      decision: decision.outcome,
      authorizationId: decision.matchedGrant?.grantId ?? decision.code,
      fingerprint: request.fingerprint,
    };
  }

  public restart(): void {
    this.consumptions = InMemoryOnceGrantConsumptionStore.fromSnapshot(
      this.consumptions.snapshot(),
    );
  }

  private recordCompetingProof(
    request: ReturnType<typeof toComputerInputPolicyRequest>,
    requestedAtMs: number,
  ): void {
    if (this.competingProofRecorded) {
      return;
    }
    this.competingProofRecorded = true;

    const competing = enforceAction(
      request,
      { now: requestedAtMs, grants: this.grants },
      this.consumptions,
    );
    this.evidence.computerInputOnceGrant.competingReplayRejected =
      competing.outcome === "require-approval";
  }
}

class RichHarness implements RichPhase1Harness {
  private executed = false;
  private eventStore: EventStore | undefined;
  private journal: InMemoryOrchestrationJournal;
  private readonly eventStoreLifecycle: RichPhase1EventStoreLifecycle | undefined;
  private readonly options: {
    readonly scenario: RichPhase1Scenario;
    readonly authorizer: ChannelAuthorizer;
    readonly coordinator: Phase1Coordinator;
    readonly workers: readonly Worker[];
    readonly artifacts: Phase1ArtifactGateway;
    readonly ids: OrchestrationIdSource;
    readonly runAssignments: LeasedRunAssignments;
    readonly dispatchPolicy: DispatchPolicyEvaluator;
    readonly computerInputAuthorizer: ExactComputerInputAuthorizer;
    readonly evidence: MutableEvidence;
    readonly diagnostics: MutableDiagnostics;
  };

  public constructor(options: {
    readonly scenario: RichPhase1Scenario;
    readonly authorizer: ChannelAuthorizer;
    readonly coordinator: Phase1Coordinator;
    readonly workers: readonly Worker[];
    readonly artifacts: Phase1ArtifactGateway;
    readonly ids: OrchestrationIdSource;
    readonly runAssignments: LeasedRunAssignments;
    readonly dispatchPolicy: DispatchPolicyEvaluator;
    readonly computerInputAuthorizer: ExactComputerInputAuthorizer;
    readonly evidence: MutableEvidence;
    readonly diagnostics: MutableDiagnostics;
    readonly eventStore?: EventStore;
    readonly eventStoreLifecycle?: RichPhase1EventStoreLifecycle;
  }) {
    this.options = options;
    this.eventStore = options.eventStore;
    this.eventStoreLifecycle = options.eventStoreLifecycle;
    this.journal = new InMemoryOrchestrationJournal({
      clock: new StringClock(),
      ...(this.eventStore === undefined ? {} : { eventStore: this.eventStore }),
    });
  }

  public async execute(): Promise<RichPhase1Execution> {
    if (this.executed) {
      throw new Error("A rich Phase 1 harness executes one deterministic Task.");
    }
    this.executed = true;
    const protocol = new ProtocolBoundary(new DeterministicIds());
    const intake = protocol.request(
      "channel.forum-intake",
      "main-device",
      {
        protocolVersion: PROTOCOL_VERSION,
        forumId: FORUM_ID,
        postId: POST_ID,
        authorId: OWNER_AUTHOR_ID,
        title: "Prove the rich Phase 1 public seam",
        body: "Run independent Device work and dependent reconciliation.",
      },
      parseForumTaskIntake,
    );
    try {
      const waiting = await this.runtime().acceptForumPost(intake);
      if (waiting.state !== "waiting_user") {
        throw new Error("The rich Task did not pause for clarification.");
      }
      const clarification: RichPhase1Clarification = Object.freeze({
        taskId: waiting.taskId,
        state: waiting.state,
        clarificationId: waiting.clarification.clarificationId,
        question: waiting.clarification.question,
        answeredBy: OWNER_AUTHOR_ID,
        answer: CLARIFICATION_ANSWER,
      });

      await this.recreateJournal();
      let completed: TaskView;
      try {
        completed = await this.runtime().answerClarification({
          postId: POST_ID,
          clarificationId: CLARIFICATION_ID,
          authorId: OWNER_AUTHOR_ID,
          answer: CLARIFICATION_ANSWER,
        });
      } catch (error: unknown) {
        if (
          !(error instanceof SimulatedRuntimeInterruption) ||
          this.options.scenario !== "allowed"
        ) {
          throw error;
        }
        await this.recreateJournal();
        completed = await this.runtime().answerClarification({
          postId: POST_ID,
          clarificationId: CLARIFICATION_ID,
          authorId: OWNER_AUTHOR_ID,
          answer: CLARIFICATION_ANSWER,
        });
      }
      if (completed.state !== "completed") {
        throw new Error("The rich Task did not complete.");
      }
      const artifactReference = completed.artifactRefs[0];
      if (artifactReference === undefined) {
        throw new Error("The completed Task has no Artifact.");
      }
      const artifact = this.options.artifacts.open(artifactReference);
      if (artifact === undefined) {
        throw new Error("The published Artifact cannot be opened.");
      }

      const events = await this.journal.recordedEvents();
      const replay = new InMemoryOrchestrationJournal({
        clock: new StringClock(),
        recordedEvents: events,
      });
      const replayedTask = await this.runtime(replay).getTaskByForumPost(POST_ID);
      this.options.evidence.replayMatched =
        JSON.stringify(replayedTask) === JSON.stringify(completed);

      return Object.freeze({
        task: completed,
        replayedTask,
        artifact,
        clarification,
        evidence: freezeEvidence(this.options.evidence, this.options.coordinator, events),
        journalEventTypes: Object.freeze(events.map((event) => event.type)),
        orchestrationEvents: Object.freeze(events.map(toOrchestrationEvent)),
      });
    } finally {
      this.options.runAssignments.releaseAll();
      if (this.eventStoreLifecycle !== undefined && this.eventStore !== undefined) {
        await this.eventStoreLifecycle.close(this.eventStore);
        this.eventStore = undefined;
      }
    }
  }

  public diagnostics(): RichPhase1Diagnostics {
    return Object.freeze({
      artifactPublishCount: this.options.diagnostics.artifactPublishCount,
      transportConnectionCount: this.options.diagnostics.transportConnectionCount,
      secretExecutionCount: this.options.evidence.secretExecutionCount,
      computerInputPolicyDecisions: Object.freeze([
        ...this.options.diagnostics.computerInputPolicyDecisions,
      ]),
      computerInputRequestedAtMs: Object.freeze([
        ...this.options.diagnostics.computerInputRequestedAtMs,
      ]),
      workerSideEffects: Object.freeze([...this.options.diagnostics.workerSideEffects].sort()),
    });
  }

  private runtime(journal = this.journal): OpenDelegate {
    return createOpenDelegate({
      authorizer: this.options.authorizer,
      coordinator: this.options.coordinator,
      workers: this.options.workers,
      artifacts: this.options.artifacts,
      ids: this.options.ids,
      runAssignments: this.options.runAssignments,
      dispatchPolicy: this.options.dispatchPolicy,
      clock: new StringClock(),
      journal,
    });
  }

  private async recreateJournal(): Promise<void> {
    const clock = new StringClock();
    if (this.eventStoreLifecycle !== undefined && this.eventStore !== undefined) {
      this.eventStore = await this.eventStoreLifecycle.restart(this.eventStore, clock);
      this.journal = new InMemoryOrchestrationJournal({
        clock,
        eventStore: this.eventStore,
      });
    } else {
      this.journal = new InMemoryOrchestrationJournal({
        clock,
        recordedEvents: await this.journal.recordedEvents(),
      });
    }
    this.options.computerInputAuthorizer.restart();
    this.options.evidence.restartCount += 1;
  }
}

export async function createRichPhase1Harness(
  options: RichPhase1HarnessOptions,
): Promise<RichPhase1Harness> {
  const ids = new DeterministicIds();
  const numericClock = new NumericClock();
  const protocol = new ProtocolBoundary(ids);
  const evidence: MutableEvidence = {
    selectedDeviceIds: [],
    transportEndpointIds: [],
    runFencingTokens: [],
    policyAllowCount: 0,
    policyDecisionCodes: [],
    dispatchPolicyEvaluations: [],
    secretExecutionCount: 0,
    knowledgeRetrievalCount: 0,
    agentTurnCount: 0,
    maxConcurrentWorkerRuns: 0,
    crossDeviceKnowledgeRejected: false,
    restartCount: 0,
    desktopContentionRejected: false,
    desktopEvidence: null,
    computerInputOnceGrant: {
      firstUseAllowCount: 0,
      competingReplayRejected: false,
      consumedGrantCount: 0,
    },
    replayMatched: false,
  };
  const diagnostics: MutableDiagnostics = {
    artifactPublishCount: 0,
    transportConnectionCount: 0,
    computerInputPolicyDecisions: [],
    computerInputRequestedAtMs: [],
    workerSideEffects: [],
  };
  const locks = new ResourceLockKernel({
    clock: numericClock,
    resources: [{ name: RUN_RESOURCE, capacity: 2 }, DESKTOP_SESSION_RESOURCE],
  });
  const secretBrokers = createSecretBrokers(options.scenario, ids, numericClock);
  const knowledge = await createDeviceKnowledge(options.knowledgeRoot);
  proveCrossDeviceKnowledgeIsolation(knowledge, evidence);
  const transport = createTransportResolver<FakeTransportConnection>({
    probeTtlMs: 1_000,
    clock: numericClock,
    async probe(request) {
      return request.endpoint.endpointId.endsWith("-unhealthy")
        ? {
            healthy: false,
            authenticated: false,
            diagnostic: { code: "FAKE_ROUTE_UNAVAILABLE", retryable: true },
          }
        : {
            healthy: true,
            authenticated: true,
            peerDeviceId: request.deviceId,
          };
    },
    async connect(
      request,
    ): Promise<TransportConnected<FakeTransportConnection> | TransportConnectionFailed> {
      diagnostics.transportConnectionCount += 1;
      return {
        connected: true,
        authenticated: true,
        peerDeviceId: request.deviceId,
        connection: {
          endpointId: request.endpoint.endpointId,
          deviceId: request.deviceId,
        },
      };
    },
  });
  const candidates = baselineCandidates(secretBrokers);
  const workOrders = new Map<string, WorkOrderV1>();
  const coordinator = new Phase1Coordinator(protocol, workOrders);
  const concurrentRuns = new ConcurrentRunProbe(evidence);
  const replayScenario =
    options.scenario === "computer-input-once-replay" ||
    options.scenario === "computer-input-once-restart-replay";
  const computerInputAuthorizer = new ExactComputerInputAuthorizer(
    allowedComputerInputGrants(replayScenario ? "run-2" : "run-3"),
    evidence,
    diagnostics,
  );
  const common: WorkerCommon = {
    scenario: options.scenario,
    protocol,
    workOrders,
    locks,
    transport,
    evidence,
    diagnostics,
    concurrentRuns,
    computerInputAuthorizer,
    clock: numericClock,
  };
  const computerUse = new FakeComputerUseBackend({
    clock: numericClock,
    locks,
    authorizer: computerInputAuthorizer,
    readiness: { status: "ready", osFamily: "windows" },
  });
  const researchBroker = secretBrokers.get(RESEARCH_DEVICE_ID);
  const desktopBroker = secretBrokers.get(DESKTOP_DEVICE_ID);
  if (researchBroker === undefined || desktopBroker === undefined) {
    throw new Error("The Device-local Secret brokers are incomplete.");
  }
  const workers = [
    new DeviceWorker(
      {
        deviceId: RESEARCH_DEVICE_ID,
        workerId: RESEARCH_WORKER_ID,
        scheduling: candidateToWorkerSnapshot(candidates[0]),
        secretAlias: RESEARCH_SECRET,
        agent: createAgent(ids, "research"),
        knowledge: requireKnowledge(knowledge, RESEARCH_DEVICE_ID),
        secretBroker: researchBroker,
      },
      common,
    ),
    new DeviceWorker(
      {
        deviceId: DESKTOP_DEVICE_ID,
        workerId: DESKTOP_WORKER_ID,
        scheduling: candidateToWorkerSnapshot(candidates[1]),
        secretAlias: DESKTOP_SECRET,
        agent: createAgent(ids, "desktop"),
        knowledge: requireKnowledge(knowledge, DESKTOP_DEVICE_ID),
        secretBroker: desktopBroker,
        computerUse,
      },
      common,
    ),
  ];
  const artifacts = new Phase1ArtifactGateway(diagnostics, protocol);
  const runAssignments = new LeasedRunAssignments(locks, options.scenario);
  const eventStore =
    options.eventStoreLifecycle === undefined
      ? undefined
      : await options.eventStoreLifecycle.open(new StringClock());
  return new RichHarness({
    scenario: options.scenario,
    authorizer: new AllowlistedChannel(),
    coordinator,
    workers,
    artifacts,
    ids: new FixedTaskIds(),
    runAssignments,
    dispatchPolicy: new Phase1DispatchPolicy(options.scenario, evidence),
    computerInputAuthorizer,
    evidence,
    diagnostics,
    ...(eventStore === undefined ? {} : { eventStore }),
    ...(options.eventStoreLifecycle === undefined
      ? {}
      : { eventStoreLifecycle: options.eventStoreLifecycle }),
  });
}

function createAgent(ids: DeterministicIds, device: string): AgentAdapter {
  return createFakeAgentAdapter({
    provider: "generic-command",
    probe: {
      ready: true,
      version: `phase-1-${device}-v1`,
      authentication: "not-required",
    },
    ids,
    clock: new StringClock(),
    turnScript(input) {
      return [
        { type: "progress", summary: "Applying selected Device-local context." },
        {
          type: "completed",
          result: input.input.includes(COMPUTER_WORK_ORDER_ID)
            ? "The deterministic Computer Use workflow completed."
            : "The deterministic readiness work completed.",
        },
      ];
    },
  });
}

function createSecretBrokers(
  scenario: RichPhase1Scenario,
  ids: SecretLeaseIdSource,
  clock: SecretClock,
): ReadonlyMap<string, SecretLeaseBroker> {
  const missing = scenario === "missing-secret";
  const research = new InMemorySecretStore({
    deviceId: RESEARCH_DEVICE_ID,
    secrets: missing ? {} : { [RESEARCH_SECRET]: "research-secret-value" },
  });
  const desktop = new InMemorySecretStore({
    deviceId: DESKTOP_DEVICE_ID,
    secrets: missing ? {} : { [DESKTOP_SECRET]: "desktop-secret-value" },
  });
  return new Map([
    [
      RESEARCH_DEVICE_ID,
      new SecretLeaseBroker({ deviceId: RESEARCH_DEVICE_ID, store: research, ids, clock }),
    ],
    [
      DESKTOP_DEVICE_ID,
      new SecretLeaseBroker({ deviceId: DESKTOP_DEVICE_ID, store: desktop, ids, clock }),
    ],
  ]);
}

async function createDeviceKnowledge(
  root: string,
): Promise<ReadonlyMap<string, LocalKnowledgeService>> {
  const qualification = {
    deviceSpecific: true,
    repeatedlyUseful: true,
    expensiveToRediscover: true,
    actionable: true,
  } as const;
  const researchRoot = join(root, RESEARCH_DEVICE_ID);
  const desktopRoot = join(root, DESKTOP_DEVICE_ID);
  await mkdir(researchRoot, { recursive: true });
  await mkdir(desktopRoot, { recursive: true });
  const research = new LocalKnowledgeService({
    root: researchRoot,
    maxSearchCandidates: 1,
    maxCandidatePreviewCharacters: 80,
    maxOpenCharacters: 512,
  });
  const desktop = new LocalKnowledgeService({
    root: desktopRoot,
    maxSearchCandidates: 1,
    maxCandidatePreviewCharacters: 80,
    maxOpenCharacters: 512,
  });
  await research.rebuild();
  await desktop.rebuild();
  await research.upsertNote({
    noteId: "quasar-recovery.md",
    contentKind: "durable-device-knowledge",
    qualification,
    content:
      "# Quasar recovery procedure\n\nUse the quasar readiness and summary probe. KNOWLEDGE-QUASAR-PRIVATE",
  });
  await desktop.upsertNote({
    noteId: "zephyr-desktop.md",
    contentKind: "durable-device-knowledge",
    qualification,
    content:
      "# Zephyr desktop procedure\n\nUse the zephyr computer-use fixture. KNOWLEDGE-ZEPHYR-PRIVATE",
  });
  return new Map([
    [RESEARCH_DEVICE_ID, research],
    [DESKTOP_DEVICE_ID, desktop],
  ]);
}

function proveCrossDeviceKnowledgeIsolation(
  knowledge: ReadonlyMap<string, LocalKnowledgeService>,
  evidence: MutableEvidence,
): void {
  try {
    requireKnowledge(knowledge, RESEARCH_DEVICE_ID).openNotes(["zephyr-desktop.md"], {
      totalCharacterBudget: 512,
    });
  } catch (error: unknown) {
    if (error instanceof KnowledgeError && error.code === "KNOWLEDGE_NOTE_NOT_FOUND") {
      evidence.crossDeviceKnowledgeRejected = true;
      return;
    }
    throw error;
  }
  throw new Error("A research Device opened another Device's Knowledge note.");
}

function baselineCandidates(
  brokers: ReadonlyMap<string, SecretLeaseBroker>,
): readonly DeviceCandidate[] {
  return [
    createCandidate({
      deviceId: RESEARCH_DEVICE_ID,
      workerId: RESEARCH_WORKER_ID,
      osFamily: "linux",
      capabilities: ["research"],
      roles: ["researcher"],
      desktop: false,
      workspace: `workspace-${RESEARCH_DEVICE_ID}`,
      secrets: [RESEARCH_SECRET].filter(
        (alias) => brokers.get(RESEARCH_DEVICE_ID)?.availability(alias).ready === true,
      ),
    }),
    createCandidate({
      deviceId: DESKTOP_DEVICE_ID,
      workerId: DESKTOP_WORKER_ID,
      osFamily: "windows",
      capabilities: ["computer-use"],
      roles: ["desktop-operator"],
      desktop: true,
      workspace: `workspace-${DESKTOP_DEVICE_ID}`,
      secrets: [DESKTOP_SECRET].filter(
        (alias) => brokers.get(DESKTOP_DEVICE_ID)?.availability(alias).ready === true,
      ),
    }),
  ];
}

function createCandidate(input: {
  readonly deviceId: string;
  readonly workerId: string;
  readonly osFamily: "linux" | "macos" | "windows";
  readonly capabilities: readonly string[];
  readonly roles: readonly string[];
  readonly desktop: boolean;
  readonly workspace: string;
  readonly secrets: readonly string[];
}): DeviceCandidate {
  return {
    deviceId: input.deviceId,
    workerId: input.workerId,
    enabled: true,
    status: "online",
    draining: false,
    osFamily: input.osFamily,
    capabilities: input.capabilities.map((name) => ({ name, verification: "verified" })),
    roles: input.roles,
    workspaceIds: [input.workspace],
    transports: [
      {
        routeId: `endpoint-${input.deviceId}-primary`,
        priority: 1,
        health: "healthy",
      },
    ],
    availableRunSlots: 2,
    loadRatio: 0.25,
    desktopSessionAvailable: input.desktop,
    executionPolicyDecision: { outcome: "allow", code: "planning-snapshot" },
    availableSecretRefs: input.secrets,
  };
}

function candidateToWorkerSnapshot(candidate: DeviceCandidate | undefined): WorkerDeviceSnapshot {
  if (candidate === undefined) {
    throw new Error("The Worker requires a scheduling candidate.");
  }
  return {
    enabled: candidate.enabled,
    status: candidate.status,
    draining: candidate.draining,
    osFamily: candidate.osFamily,
    capabilities: candidate.capabilities,
    roles: candidate.roles,
    workspaceIds: candidate.workspaceIds,
    routes: candidate.transports,
    availableRunSlots: candidate.availableRunSlots,
    loadRatio: candidate.loadRatio,
    desktopSessionAvailable: candidate.desktopSessionAvailable,
    availableSecretRefs: candidate.availableSecretRefs,
  };
}

function toPlannedWorkOrder(workOrder: WorkOrderV1): PlannedWorkOrder {
  const { protocolVersion, ...plannedWorkOrder } = workOrder;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported Work Order protocol version: ${String(protocolVersion)}`);
  }
  return plannedWorkOrder;
}

function dispatchFingerprint(workOrderId: string, deviceId: string): ActionFingerprint {
  return createActionFingerprint({
    kind: "phase-1-dispatch",
    operation: "execute-work-order",
    target: { taskId: TASK_ID, workOrderId, deviceId },
  });
}

interface ExpectedComputerInput {
  readonly taskId: string;
  readonly deviceId: string;
  readonly runId: string;
  readonly fingerprint: ActionFingerprint;
}

function allowedComputerInputGrants(runId: string): readonly ExpectedComputerInput[] {
  const text = "Zephyr acceptance";
  const scopes = [
    {
      taskId: TASK_ID,
      deviceId: DESKTOP_DEVICE_ID,
      runId,
      action: {
        kind: "type-text" as const,
        controlId: "text-input",
        textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
        textLength: text.length,
      },
    },
    {
      taskId: TASK_ID,
      deviceId: DESKTOP_DEVICE_ID,
      runId,
      action: { kind: "click" as const, controlId: "option-alpha" },
    },
    {
      taskId: TASK_ID,
      deviceId: DESKTOP_DEVICE_ID,
      runId,
      action: { kind: "click" as const, controlId: "submit" },
    },
  ];
  return scopes.map((scope) => {
    const fingerprint = createComputerUseInputFingerprint(scope);
    if (!isActionFingerprint(fingerprint)) {
      throw new Error("Computer Use produced an invalid expected fingerprint.");
    }
    return {
      taskId: scope.taskId,
      deviceId: scope.deviceId,
      runId: scope.runId,
      fingerprint,
    };
  });
}

function toComputerInputPolicyRequest(
  request: ComputerUseInputAuthorizationRequest,
  fingerprint: ActionFingerprint,
) {
  return Object.freeze({
    requestId: computerInputRequestId(request),
    actionCategory: request.actionCategory,
    actionFingerprint: fingerprint,
    taskId: request.taskId,
    deviceId: request.deviceId,
  });
}

function computerInputRequestId(
  input: Readonly<{
    taskId: string;
    deviceId: string;
    runId: string;
    fingerprint: `sha256:${string}`;
  }>,
): string {
  const normalizedScope = [
    "computer-use-input",
    "v1",
    input.taskId,
    input.deviceId,
    input.runId,
    input.fingerprint,
  ].join("\u001f");
  return `computer-input:${createHash("sha256").update(normalizedScope, "utf8").digest("hex")}`;
}

function recordAllowedPolicy(evidence: MutableEvidence, code: PolicyCode): void {
  evidence.policyAllowCount += 1;
  evidence.policyDecisionCodes.push(code);
}

function requireKnowledge(
  knowledge: ReadonlyMap<string, LocalKnowledgeService>,
  deviceId: string,
): LocalKnowledgeService {
  const service = knowledge.get(deviceId);
  if (service === undefined) {
    throw new Error(`Device ${deviceId} has no local Knowledge service.`);
  }
  return service;
}

function leaseId(lease: ResourceLease): string {
  return `${lease.resourceName}:${String(lease.fencingToken)}`;
}

function toDesktopEvidence(evidence: ComputerUseEvidence): RichPhase1DesktopEvidence {
  if (evidence.observation.state !== "success") {
    throw new Error("Computer Use evidence was captured before visible success.");
  }
  return {
    kind: evidence.kind,
    mediaType: evidence.mediaType,
    state: evidence.observation.state,
    width: evidence.width,
    height: evidence.height,
  };
}

function freezeEvidence(
  evidence: MutableEvidence,
  coordinator: Phase1Coordinator,
  events: readonly StoredEvent[],
): RichPhase1Evidence {
  const completionOrder = events
    .filter((event) => event.type === "work-order.completed")
    .map((event) => {
      const payload = event.payload as { readonly workOrderId?: unknown };
      return typeof payload.workOrderId === "string" ? payload.workOrderId : undefined;
    })
    .filter((workOrderId): workOrderId is string => workOrderId !== undefined);
  const summaryIndex = completionOrder.indexOf(SUMMARY_WORK_ORDER_ID);
  const computerIndex = completionOrder.indexOf(COMPUTER_WORK_ORDER_ID);
  const researchIndex = completionOrder.indexOf(RESEARCH_WORK_ORDER_ID);
  return Object.freeze({
    selectedDeviceIds: Object.freeze([...evidence.selectedDeviceIds]),
    transportEndpointIds: Object.freeze([...evidence.transportEndpointIds]),
    runFencingTokens: Object.freeze([...evidence.runFencingTokens]),
    policyAllowCount: evidence.policyAllowCount,
    policyDecisionCodes: Object.freeze([...evidence.policyDecisionCodes]),
    dispatchPolicyEvaluations: Object.freeze([...evidence.dispatchPolicyEvaluations]),
    secretExecutionCount: evidence.secretExecutionCount,
    knowledgeRetrievalCount: evidence.knowledgeRetrievalCount,
    agentTurnCount: evidence.agentTurnCount,
    maxConcurrentWorkerRuns: evidence.maxConcurrentWorkerRuns,
    dependencyWaveProven:
      computerIndex >= 0 &&
      researchIndex >= 0 &&
      summaryIndex > computerIndex &&
      summaryIndex > researchIndex,
    crossDeviceKnowledgeRejected: evidence.crossDeviceKnowledgeRejected,
    restartCount: evidence.restartCount,
    coordinatorCallCounts: Object.freeze({
      assess: coordinator.assessCalls,
      plan: coordinator.planCalls,
      synthesize: coordinator.synthesisCalls,
      review: coordinator.reviewCalls,
    }),
    desktopContentionRejected: evidence.desktopContentionRejected,
    desktopEvidence: evidence.desktopEvidence,
    computerInputOnceGrant: Object.freeze({ ...evidence.computerInputOnceGrant }),
    replayMatched: evidence.replayMatched,
  });
}

function toOrchestrationEvent(event: StoredEvent): {
  readonly type: string;
  readonly workOrderId?: string;
} {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const workOrderId =
    typeof payload["workOrderId"] === "string" ? payload["workOrderId"] : undefined;
  return workOrderId === undefined ? { type: event.type } : { type: event.type, workOrderId };
}
