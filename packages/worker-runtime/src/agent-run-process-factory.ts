import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  AgentAdapterError,
  type AgentAdapter,
  type AgentPermissionInput,
  type AgentProvider,
  type AgentRunHandle,
  type AgentRunLimits,
  type AgentRunResult,
  type AgentUsage,
  type AgentSandbox,
  type AgentStartRequest,
  type AgentToolServer,
  type NativeSessionReference,
  type WorkspaceBinding,
} from "@opendelegate/agent-adapters";
import {
  sanitizeTaskContinuationText,
  serializeTaskContinuationCheckpoint,
  validateTaskContinuationCheckpoint,
  type TaskContinuationCheckpointV1,
  type WorkerAgentRequirementV1,
  type WorkerAgentSessionObservationV1,
  type WorkerProviderUsageV1,
} from "@opendelegate/protocol";

import { AgentRunBridgeError } from "./agent-run-bridge-error.ts";
import {
  type RunExecutionContext,
  type RunProcess,
  type RunProcessFactory,
  type RunProcessOutcome,
  type WorkerRunAssignmentV1,
  type WorkerRunLeaseAuthority,
} from "./contracts.ts";
import type { NativeSessionReferenceStore } from "./native-session-reference-store.ts";
import type { NativeSessionSteeringInstruction } from "./native-session-reference-store.ts";
import {
  WorkerEgressGuard,
  type WorkerEgressBlockReason,
  type WorkerKnowledgeEgressInput,
} from "./worker-egress-guard.ts";

export interface WorkerAgentExecutionPlan {
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly modelId?: string;
  /** Provider tuning pinned by the Run assignment, when the provider exposes it. */
  readonly effort?: string;
  readonly workstreamId: string;
  readonly prompt: string;
  readonly sandbox: AgentSandbox;
  readonly permissions: AgentPermissionInput;
  readonly toolServers?: readonly AgentToolServer[];
  readonly limits: AgentRunLimits;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface WorkerAgentExecutionPlanResolver {
  resolve(context: {
    readonly assignment: WorkerRunAssignmentV1;
    /**
     * Dynamic Device-local authority for the exact Run. Resolvers that create
     * protected action bridges must bind them to this authority instead of the
     * assignment's bootstrap lease expiry.
     */
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    /**
     * Re-checks the authoritative Main assignment, lease, and fencing token.
     * Exact-action authorization bridges must call this immediately before
     * releasing a protected provider action.
     */
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerAgentExecutionPlan>;
}

export interface WorkerRunCapabilityLease {
  readonly toolServers: readonly AgentToolServer[];
  /**
   * Revokes the ephemeral capability, removes any unconsumed capability file,
   * closes its local broker binding, and releases claimed resources. It must be
   * safe to call more than once.
   */
  dispose(): Promise<void>;
}

export interface WorkerRunCapabilityProvider {
  prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    /**
     * The already-resolved authoritative Workspace for this exact Run. Capability
     * providers must use this binding instead of resolving or accepting a path
     * from an Agent tool call.
     */
    readonly workspace: WorkspaceBinding;
    /**
     * Run-local DLP shared by prompt context, native provider output, local tools,
     * and Artifact promotion. Capability providers must register sensitive values
     * before returning them to the native Agent.
     */
    readonly egressGuard: WorkerEgressGuard;
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    readonly artifact?: {
      readonly plan: WorkerArtifactOutputPlan;
      readonly egressGuard: WorkerEgressGuard;
    };
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined>;
}

/**
 * Combines independently owned, Run-scoped capability providers into the single
 * Agent Adapter tool-server contract. Preparation is transactional: if a later
 * provider fails, every earlier lease is revoked in reverse order.
 */
export class CompositeWorkerRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #providers: readonly WorkerRunCapabilityProvider[];

  public constructor(providers: readonly WorkerRunCapabilityProvider[]) {
    if (
      !Array.isArray(providers) ||
      providers.length === 0 ||
      providers.length > 8 ||
      providers.some(
        (provider) =>
          provider === null ||
          typeof provider !== "object" ||
          typeof provider.prepare !== "function",
      )
    ) {
      throw new TypeError("The Worker Run capability providers are invalid.");
    }
    this.#providers = Object.freeze([...providers]);
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly egressGuard: WorkerEgressGuard;
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    readonly artifact?: {
      readonly plan: WorkerArtifactOutputPlan;
      readonly egressGuard: WorkerEgressGuard;
    };
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    const leases: WorkerRunCapabilityLease[] = [];
    try {
      for (const provider of this.#providers) {
        const lease = await provider.prepare({
          assignment: structuredClone(context.assignment),
          workspace: cloneWorkspace(context.workspace),
          egressGuard: context.egressGuard,
          leaseAuthority: context.leaseAuthority,
          ...(context.artifact === undefined
            ? {}
            : {
                artifact: Object.freeze({
                  plan: { ...context.artifact.plan },
                  egressGuard: context.artifact.egressGuard,
                }),
              }),
          isExecutionCurrent: context.isExecutionCurrent,
        });
        if (lease !== undefined) {
          leases.push(lease);
        }
      }
      if (leases.length === 0) {
        return undefined;
      }
      const toolServers = Object.freeze(leases.flatMap((lease) => lease.toolServers));
      validateToolServers(toolServers);
      let disposed = false;
      return Object.freeze({
        toolServers,
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          await disposeCapabilityLeasesReverse(leases);
        },
      });
    } catch (error) {
      await disposeCapabilityLeasesReverse(leases);
      throw error;
    }
  }
}

export interface WorkerWorkspaceResolver {
  resolve(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspaceId?: string;
    readonly workstreamId?: string;
  }): Promise<WorkspaceBinding>;
}

export interface WorkerInitialContextProvider {
  prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workstreamId: string;
    readonly workspaceId: string;
  }): Promise<WorkerPreparedInitialContext | undefined>;
}

export interface WorkerPreparedInitialContext {
  readonly prompt: string;
  readonly knowledgeSources: WorkerKnowledgeEgressInput;
}

export interface WorkerArtifactOutputPlan {
  readonly schemaVersion: 1;
  readonly outputRoot: string;
  readonly manifestPath: string;
  readonly assignmentFingerprint: string;
}

export interface WorkerArtifactLifecycle {
  prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly assignmentFingerprint: string;
  }): Promise<WorkerArtifactOutputPlan>;
  promote(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly workspace: WorkspaceBinding;
    readonly plan: WorkerArtifactOutputPlan;
    readonly egressGuard: WorkerEgressGuard;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<readonly string[]>;
}

export interface AgentRunBridgeLimits {
  readonly leaseCheckIntervalMs: number;
  readonly maxPromptBytes: number;
  readonly maxPublicMessages: number;
  readonly maxReportBytes: number;
}

export const DEFAULT_AGENT_RUN_BRIDGE_LIMITS: AgentRunBridgeLimits = Object.freeze({
  leaseCheckIntervalMs: 1_000,
  maxPromptBytes: 1_048_576,
  maxPublicMessages: 256,
  maxReportBytes: 65_536,
});

export interface AgentRunProcessFactoryOptions {
  readonly adapters: readonly AgentAdapter[];
  readonly executionPlanResolver: WorkerAgentExecutionPlanResolver;
  readonly workspaceResolver: WorkerWorkspaceResolver;
  readonly sessionStore: NativeSessionReferenceStore;
  readonly initialContextProvider?: WorkerInitialContextProvider;
  readonly artifactLifecycle?: WorkerArtifactLifecycle;
  readonly runCapabilityProvider?: WorkerRunCapabilityProvider;
  readonly limits?: Partial<AgentRunBridgeLimits>;
}

interface PreparedRun {
  readonly adapter: AgentAdapter;
  readonly plan: WorkerAgentExecutionPlan;
  readonly workspace: WorkspaceBinding;
  readonly sessionKey: string;
  readonly session?: NativeSessionReference;
  readonly egressGuard: WorkerEgressGuard;
  readonly pendingSteering: readonly NativeSessionSteeringInstruction[];
}

export class AgentRunProcessFactory implements RunProcessFactory {
  readonly #adapters: ReadonlyMap<string, AgentAdapter>;
  readonly #executionPlanResolver: WorkerAgentExecutionPlanResolver;
  readonly #workspaceResolver: WorkerWorkspaceResolver;
  readonly #sessionStore: NativeSessionReferenceStore;
  readonly #initialContextProvider: WorkerInitialContextProvider | undefined;
  readonly #artifactLifecycle: WorkerArtifactLifecycle | undefined;
  readonly #runCapabilityProvider: WorkerRunCapabilityProvider | undefined;
  readonly #limits: AgentRunBridgeLimits;

  public constructor(options: AgentRunProcessFactoryOptions) {
    if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
      throw invalidBridgeConfiguration();
    }
    const adapters = new Map<string, AgentAdapter>();
    for (const adapter of options.adapters) {
      assertIdentifier(adapter.adapterId, "Agent adapter ID", "INVALID_BRIDGE_CONFIGURATION");
      if (
        (adapter.provider !== "codex" &&
          adapter.provider !== "claude" &&
          adapter.provider !== "generic") ||
        adapters.has(adapter.adapterId)
      ) {
        throw invalidBridgeConfiguration();
      }
      adapters.set(adapter.adapterId, adapter);
    }
    this.#adapters = adapters;
    this.#executionPlanResolver = options.executionPlanResolver;
    this.#workspaceResolver = options.workspaceResolver;
    this.#sessionStore = options.sessionStore;
    this.#initialContextProvider = options.initialContextProvider;
    this.#artifactLifecycle = options.artifactLifecycle;
    this.#runCapabilityProvider = options.runCapabilityProvider;
    this.#limits = validateBridgeLimits({
      ...DEFAULT_AGENT_RUN_BRIDGE_LIMITS,
      ...options.limits,
    });
  }

  public async start(context: RunExecutionContext): Promise<RunProcess> {
    if (!(await safeLeaseCurrent(context))) {
      return completedRunProcess(authorityLostOutcome());
    }

    const prepared = await this.#prepare(context);
    if (!(await safeLeaseCurrent(context))) {
      return completedRunProcess(authorityLostOutcome());
    }
    const artifactPlan =
      this.#artifactLifecycle === undefined
        ? undefined
        : await this.#prepareArtifactOutput(context.assignment, prepared.workspace);
    if (!(await safeLeaseCurrent(context))) {
      return completedRunProcess(authorityLostOutcome());
    }
    const sessionAction =
      prepared.session === undefined
        ? ({ kind: "start" } as const)
        : await resolveWorkerSessionAction(
            prepared.adapter,
            prepared.session,
            prepared.plan.environment,
            prepared.plan.secretEnvironment,
          );
    const basePrompt =
      sessionAction.kind === "continuation"
        ? buildWorkerContinuationPrompt(context.assignment, this.#limits.maxPromptBytes)
        : prepared.plan.prompt;
    const promptWithSteering = appendPendingSteeringInstructions(
      basePrompt,
      prepared.pendingSteering,
      this.#limits.maxPromptBytes,
    );
    const prompt =
      artifactPlan === undefined
        ? promptWithSteering
        : appendArtifactOutputContract(promptWithSteering, this.#limits.maxPromptBytes);
    const environment = prepared.plan.environment;
    const capabilityLease = await this.#prepareRunCapabilities(
      context,
      prepared.workspace,
      prepared.egressGuard,
      artifactPlan,
    );
    if (!(await safeLeaseCurrent(context))) {
      await disposeCapabilityLease(capabilityLease);
      return completedRunProcess(authorityLostOutcome());
    }
    let toolServers: readonly AgentToolServer[] | undefined;
    try {
      toolServers = mergeToolServers(prepared.plan.toolServers, capabilityLease?.toolServers);
      if (artifactPlan !== undefined && !hasExactArtifactRunWriter(toolServers)) {
        throw new TypeError("The Artifact Run writer capability is unavailable.");
      }
    } catch {
      await disposeCapabilityLease(capabilityLease);
      throw capabilityPreparationFailed();
    }

    const commonRequest = {
      requestId: `${context.assignment.runId}:agent-turn`,
      runId: context.assignment.runId,
      taskId: context.assignment.taskId,
      workstreamId: prepared.plan.workstreamId,
      sessionKey: prepared.sessionKey,
      deviceId: context.assignment.deviceId,
      ...(prepared.plan.modelId === undefined ? {} : { modelId: prepared.plan.modelId }),
      ...(prepared.plan.effort === undefined ? {} : { effort: prepared.plan.effort }),
      prompt,
      workspace: cloneWorkspace(prepared.workspace),
      sandbox: prepared.plan.sandbox,
      permissions: permissionsForRun(prepared.plan.permissions, toolServers),
      ...(toolServers === undefined ? {} : { toolServers: cloneToolServers(toolServers) }),
      limits: { ...prepared.plan.limits },
      ...(environment === undefined ? {} : { environment: { ...environment } }),
      ...(prepared.plan.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: { ...prepared.plan.secretEnvironment } }),
    } satisfies Omit<AgentStartRequest, "operation">;

    let handle: AgentRunHandle;
    try {
      if (!(await safeLeaseCurrent(context))) {
        await disposeCapabilityLease(capabilityLease);
        return completedRunProcess(authorityLostOutcome());
      }
      if (sessionAction.kind === "start") {
        handle = await prepared.adapter.start({
          operation: "start",
          ...commonRequest,
        });
      } else if (sessionAction.kind === "resume") {
        handle = await prepared.adapter.resume({
          operation: "resume",
          ...commonRequest,
          session: sessionAction.session,
        });
      } else {
        handle = await prepared.adapter.start({
          operation: "start",
          ...commonRequest,
          continuationOf: sessionAction.session,
          continuationReason: sessionAction.reason,
        });
      }
    } catch (error: unknown) {
      await disposeCapabilityLease(capabilityLease);
      if (error instanceof AgentRunBridgeError) {
        throw error;
      }
      throw new AgentRunBridgeError(
        "ADAPTER_START_FAILED",
        error instanceof AgentAdapterError && error.retryable
          ? "The configured Agent Adapter could not start this Run and may be retried."
          : "The configured Agent Adapter could not start this Run.",
        error instanceof AgentAdapterError && error.retryable,
      );
    }
    if (prepared.pendingSteering.length > 0) {
      try {
        await this.#sessionStore.markSteeringInstructionsDispatched(
          prepared.sessionKey,
          prepared.pendingSteering.map((instruction) => instruction.requestId),
        );
      } catch {
        await handle
          .cancel("The next-resume steering audit could not be committed.")
          .catch(() => undefined);
        await disposeCapabilityLease(capabilityLease);
        throw new AgentRunBridgeError(
          "SESSION_STORE_CORRUPT",
          "The Worker could not commit next-resume steering delivery safely.",
        );
      }
    }

    return new AdapterRunProcess({
      context,
      handle,
      sessionStore: this.#sessionStore,
      expected: {
        provider: prepared.plan.provider,
        adapterId: prepared.plan.adapterId,
        ...(prepared.plan.modelId === undefined ? {} : { modelId: prepared.plan.modelId }),
        ...(prepared.plan.effort === undefined ? {} : { effort: prepared.plan.effort }),
        sessionKey: prepared.sessionKey,
        taskId: context.assignment.taskId,
        workstreamId: prepared.plan.workstreamId,
        deviceId: context.assignment.deviceId,
        workspaceId: prepared.workspace.workspaceId,
      },
      leaseCheckIntervalMs: this.#limits.leaseCheckIntervalMs,
      maxPublicMessages: this.#limits.maxPublicMessages,
      maxReportBytes: this.#limits.maxReportBytes,
      secretValues: Object.values(prepared.plan.secretEnvironment ?? {}),
      egressGuard: prepared.egressGuard,
      ...(this.#artifactLifecycle === undefined || artifactPlan === undefined
        ? {}
        : {
            artifactLifecycle: this.#artifactLifecycle,
            artifactPlan,
            workspace: cloneWorkspace(prepared.workspace),
          }),
      ...(capabilityLease === undefined
        ? {}
        : {
            disposeCapability: () => disposeCapabilityLease(capabilityLease),
          }),
    });
  }

  async #prepareRunCapabilities(
    context: RunExecutionContext,
    workspace: WorkspaceBinding,
    egressGuard: WorkerEgressGuard,
    artifactPlan: WorkerArtifactOutputPlan | undefined,
  ): Promise<WorkerRunCapabilityLease | undefined> {
    if (this.#runCapabilityProvider === undefined) {
      return undefined;
    }
    let lease: WorkerRunCapabilityLease | undefined;
    try {
      lease = await this.#runCapabilityProvider.prepare({
        assignment: structuredClone(context.assignment),
        workspace: cloneWorkspace(workspace),
        egressGuard,
        leaseAuthority: context.leaseAuthority,
        ...(artifactPlan === undefined
          ? {}
          : {
              artifact: Object.freeze({
                plan: { ...artifactPlan },
                egressGuard,
              }),
            }),
        isExecutionCurrent: () => safeLeaseCurrent(context),
      });
      if (lease === undefined) {
        return undefined;
      }
      if (lease === null || typeof lease !== "object" || typeof lease.dispose !== "function") {
        throw new TypeError("Invalid capability lease.");
      }
      validateToolServers(lease.toolServers);
      return lease;
    } catch {
      await disposeCapabilityLease(lease);
      throw capabilityPreparationFailed();
    }
  }

  async #prepareArtifactOutput(
    assignment: WorkerRunAssignmentV1,
    workspace: WorkspaceBinding,
  ): Promise<WorkerArtifactOutputPlan> {
    const assignmentFingerprint = workerArtifactAssignmentFingerprint(
      assignment,
      workspace.workspaceId,
    );
    let plan: WorkerArtifactOutputPlan;
    try {
      plan = await this.#artifactLifecycle!.prepare({
        assignment: structuredClone(assignment),
        workspace: cloneWorkspace(workspace),
        assignmentFingerprint,
      });
    } catch {
      throw new AgentRunBridgeError(
        "ARTIFACT_PREPARATION_FAILED",
        "The Worker could not prepare its bounded Artifact output contract.",
        true,
      );
    }
    try {
      return validateArtifactOutputPlan(plan, assignmentFingerprint);
    } catch {
      throw new AgentRunBridgeError(
        "ARTIFACT_PREPARATION_FAILED",
        "The Worker returned an invalid Artifact output contract.",
      );
    }
  }

  async #prepare(context: RunExecutionContext): Promise<PreparedRun> {
    const assignment = context.assignment;
    const immutableAssignment = structuredClone(assignment);
    let plan: WorkerAgentExecutionPlan;
    try {
      plan = await this.#executionPlanResolver.resolve({
        assignment: structuredClone(immutableAssignment),
        leaseAuthority: context.leaseAuthority,
        isExecutionCurrent: () => safeLeaseCurrent(context),
      });
    } catch {
      throw new AgentRunBridgeError(
        "INVALID_EXECUTION_PLAN",
        "The Worker could not resolve a safe Agent execution plan.",
        true,
      );
    }
    try {
      validateExecutionPlan(plan, assignment.taskId, this.#limits.maxPromptBytes);
    } catch (error: unknown) {
      if (error instanceof AgentRunBridgeError) {
        throw error;
      }
      throw invalidExecutionPlan();
    }
    plan = applyWorkOrderTimeBudget(plan, immutableAssignment.workOrder);
    validateExecutionPlan(plan, assignment.taskId, this.#limits.maxPromptBytes);
    let workspace: WorkspaceBinding;
    try {
      workspace = await this.#workspaceResolver.resolve({
        assignment: structuredClone(immutableAssignment),
        ...(immutableAssignment.workOrder.workspaceId === undefined
          ? {}
          : { workspaceId: immutableAssignment.workOrder.workspaceId }),
        workstreamId: plan.workstreamId,
      });
    } catch {
      throw new AgentRunBridgeError(
        "WORKSPACE_RESOLUTION_FAILED",
        "The Worker could not resolve the assigned Workspace.",
        true,
      );
    }
    validateWorkspace(workspace, assignment);

    const adapter = this.#adapters.get(plan.adapterId);
    if (adapter === undefined || adapter.provider !== plan.provider) {
      throw new AgentRunBridgeError(
        "ADAPTER_NOT_FOUND",
        "The execution plan selected an unavailable Agent Adapter.",
        true,
      );
    }
    await assertAgentRequirementAvailable(
      adapter,
      immutableAssignment.agentRequirement,
      plan.modelId,
      plan.effort,
      plan.environment,
      plan.secretEnvironment,
    );
    const sessionKey = createSessionKey({
      taskId: assignment.taskId,
      workstreamId: plan.workstreamId,
      deviceId: assignment.deviceId,
      provider: plan.provider,
      adapterId: plan.adapterId,
      ...(plan.modelId === undefined ? {} : { modelId: plan.modelId }),
      ...(plan.effort === undefined ? {} : { effort: plan.effort }),
      workspaceId: workspace.workspaceId,
    });
    let session: NativeSessionReference | undefined;
    let pendingSteering: readonly NativeSessionSteeringInstruction[];
    let egressGuard: WorkerEgressGuard;
    try {
      session = await this.#sessionStore.load(sessionKey);
      pendingSteering =
        session === undefined
          ? Object.freeze([])
          : await this.#sessionStore.loadPendingSteeringInstructions(sessionKey);
      egressGuard =
        session === undefined
          ? WorkerEgressGuard.empty()
          : WorkerEgressGuard.restore(await this.#sessionStore.loadEgressGuardSnapshot(sessionKey));
    } catch (error: unknown) {
      if (error instanceof AgentRunBridgeError) {
        throw error;
      }
      throw new AgentRunBridgeError(
        "SESSION_STORE_CORRUPT",
        "Native session state could not be read safely.",
      );
    }
    try {
      await egressGuard.protectSecrets(Object.values(plan.secretEnvironment ?? {}));
    } catch {
      throw new AgentRunBridgeError(
        "EGRESS_PROTECTION_FAILED",
        "The Worker could not establish deterministic egress protection.",
      );
    }
    if (session !== undefined) {
      assertSessionBinding(session, {
        provider: plan.provider,
        adapterId: plan.adapterId,
        ...(plan.modelId === undefined ? {} : { modelId: plan.modelId }),
        ...(plan.effort === undefined ? {} : { effort: plan.effort }),
        sessionKey,
        taskId: assignment.taskId,
        workstreamId: plan.workstreamId,
        deviceId: assignment.deviceId,
        workspaceId: workspace.workspaceId,
      });
    } else if (this.#initialContextProvider !== undefined) {
      let preparedInitialContext: WorkerPreparedInitialContext | undefined;
      try {
        preparedInitialContext = await this.#initialContextProvider.prepare({
          assignment: structuredClone(immutableAssignment),
          workstreamId: plan.workstreamId,
          workspaceId: workspace.workspaceId,
        });
      } catch {
        throw new AgentRunBridgeError(
          "INITIAL_CONTEXT_FAILED",
          "The Worker could not prepare bounded Device-local initial context.",
          true,
        );
      }
      if (preparedInitialContext !== undefined) {
        if (
          preparedInitialContext === null ||
          typeof preparedInitialContext !== "object" ||
          Array.isArray(preparedInitialContext)
        ) {
          throw new AgentRunBridgeError(
            "INITIAL_CONTEXT_FAILED",
            "The Worker returned invalid Device-local initial context.",
          );
        }
        const initialContext = preparedInitialContext.prompt;
        if (
          typeof initialContext !== "string" ||
          initialContext.trim().length === 0 ||
          initialContext.includes("\0")
        ) {
          throw new AgentRunBridgeError(
            "INITIAL_CONTEXT_FAILED",
            "The Worker returned invalid Device-local initial context.",
          );
        }
        try {
          await egressGuard.protectKnowledge(preparedInitialContext.knowledgeSources);
        } catch {
          throw new AgentRunBridgeError(
            "INITIAL_CONTEXT_FAILED",
            "The Worker returned unprotected Device-local initial context.",
          );
        }
        if (egressGuard.inspectText(initialContext).safe) {
          throw new AgentRunBridgeError(
            "INITIAL_CONTEXT_FAILED",
            "The Worker returned Device-local initial context that was not covered by its egress guard.",
          );
        }
        plan = Object.freeze({
          ...plan,
          prompt: `${plan.prompt}\n\n${initialContext}`,
        });
        try {
          validateExecutionPlan(plan, assignment.taskId, this.#limits.maxPromptBytes);
        } catch {
          throw new AgentRunBridgeError(
            "INITIAL_CONTEXT_FAILED",
            "The bounded Device-local initial context exceeded the Agent prompt limit.",
          );
        }
      }
    }
    return {
      adapter,
      plan,
      workspace,
      sessionKey,
      egressGuard,
      pendingSteering,
      ...(session === undefined ? {} : { session }),
    };
  }
}

interface AdapterRunProcessOptions {
  readonly context: RunExecutionContext;
  readonly handle: AgentRunHandle;
  readonly sessionStore: NativeSessionReferenceStore;
  readonly expected: SessionBinding;
  readonly leaseCheckIntervalMs: number;
  readonly maxPublicMessages: number;
  readonly maxReportBytes: number;
  readonly secretValues: readonly string[];
  readonly egressGuard: WorkerEgressGuard;
  readonly artifactLifecycle?: WorkerArtifactLifecycle;
  readonly artifactPlan?: WorkerArtifactOutputPlan;
  readonly workspace?: WorkspaceBinding;
  readonly disposeCapability?: () => Promise<void>;
}

class AdapterRunProcess implements RunProcess {
  public readonly completion: Promise<RunProcessOutcome>;
  readonly #context: RunExecutionContext;
  readonly #handle: AgentRunHandle;
  readonly #sessionStore: NativeSessionReferenceStore;
  readonly #expected: SessionBinding;
  readonly #collector: BoundedPublicReportCollector;
  readonly #egressGuard: WorkerEgressGuard;
  readonly #artifactLifecycle: WorkerArtifactLifecycle | undefined;
  readonly #artifactPlan: WorkerArtifactOutputPlan | undefined;
  readonly #workspace: WorkspaceBinding | undefined;
  readonly #disposeCapability: (() => Promise<void>) | undefined;
  readonly #leaseTimer: NodeJS.Timeout;
  #checkingLease = false;
  #stopped = false;
  #leaseLost = false;
  #cancelRequested = false;
  #cancelPromise: Promise<void> | undefined;
  #latestUsage: AgentUsage | undefined;
  #agentSession: WorkerAgentSessionObservationV1 | undefined;
  #nativeSession: NativeSessionReference | undefined;

  public constructor(options: AdapterRunProcessOptions) {
    this.#context = options.context;
    this.#handle = options.handle;
    this.#sessionStore = options.sessionStore;
    this.#expected = options.expected;
    this.#egressGuard = options.egressGuard;
    this.#collector = new BoundedPublicReportCollector({
      maxBytes: options.maxReportBytes,
      maxMessages: options.maxPublicMessages,
      secretValues: options.secretValues,
      egressGuard: options.egressGuard,
    });
    this.#artifactLifecycle = options.artifactLifecycle;
    this.#artifactPlan = options.artifactPlan;
    this.#workspace = options.workspace;
    this.#disposeCapability = options.disposeCapability;
    this.#leaseTimer = setInterval(() => {
      void this.#checkLease();
    }, options.leaseCheckIntervalMs);
    this.#leaseTimer.unref();
    this.completion = this.#complete()
      .catch(() => processFailureOutcome(undefined, this.#agentSession))
      .finally(() => this.#disposeCapability?.());
  }

  public requestCancel(): Promise<void> {
    this.#cancelRequested = true;
    return this.#cancel("The Worker Run was cancelled.");
  }

  public currentAgentSession(): WorkerAgentSessionObservationV1 | undefined {
    return this.#agentSession === undefined ? undefined : structuredClone(this.#agentSession);
  }

  public async steer(request: {
    readonly requestId: string;
    readonly instruction: string;
    readonly requestedBy: "main-agent" | "owner";
    readonly agentSession: WorkerAgentSessionObservationV1;
    isCommandCurrent(): Promise<boolean>;
  }): Promise<{
    readonly delivery: "live" | "next-resume";
    readonly agentSession: WorkerAgentSessionObservationV1;
    readonly providerTurnId?: string;
  }> {
    if (this.#stopped || this.#cancelRequested) {
      throw new AgentRunBridgeError(
        "STEERING_NOT_ACTIVE",
        "A completed or cancelling Agent Run cannot be steered.",
      );
    }
    if (!(await safeLeaseCurrent(this.#context))) {
      throw new AgentRunBridgeError(
        "STEERING_NOT_ACTIVE",
        "The Agent Run lost its exact execution authority before steering.",
      );
    }
    const nativeSession = this.#nativeSession;
    const agentSession = this.#agentSession;
    if (nativeSession === undefined || agentSession === undefined) {
      throw new AgentRunBridgeError(
        "STEERING_NOT_ACTIVE",
        "The Agent Run has not exposed an active native session yet.",
        true,
      );
    }
    if (!sameAgentSessionObservation(agentSession, request.agentSession)) {
      throw new AgentRunBridgeError(
        "STEERING_SCOPE_MISMATCH",
        "The steering command does not match this exact active native session.",
      );
    }
    if (!(await request.isCommandCurrent())) {
      throw new AgentRunBridgeError(
        "STEERING_NOT_ACTIVE",
        "The steering command lost its exact Run authority before provider delivery.",
      );
    }
    const decidedAtMs = Date.now();
    if (this.#handle.steer === undefined) {
      await this.#sessionStore.queueSteeringInstruction({
        schemaVersion: 1,
        requestId: request.requestId,
        sourceRunId: this.#context.assignment.runId,
        sessionKey: nativeSession.sessionKey,
        nativeSessionId: nativeSession.nativeSessionId,
        taskId: nativeSession.taskId,
        workstreamId: nativeSession.workstreamId,
        deviceId: nativeSession.deviceId,
        workspaceId: nativeSession.workspaceId,
        provider: nativeSession.provider,
        adapterId: nativeSession.adapterId,
        instruction: request.instruction,
        requestedBy: request.requestedBy,
        queuedAt: new Date(decidedAtMs).toISOString(),
      });
      return Object.freeze({
        delivery: "next-resume",
        agentSession: structuredClone(agentSession),
      });
    }
    try {
      const receipt = await this.#handle.steer({
        schemaVersion: 1,
        requestId: request.requestId,
        scope: {
          provider: nativeSession.provider,
          adapterId: nativeSession.adapterId,
          runId: this.#context.assignment.runId,
          taskId: nativeSession.taskId,
          workstreamId: nativeSession.workstreamId,
          sessionKey: nativeSession.sessionKey,
          deviceId: nativeSession.deviceId,
          workspaceId: nativeSession.workspaceId,
          nativeSessionId: nativeSession.nativeSessionId,
        },
        instruction: request.instruction,
        requestedBy: request.requestedBy,
      });
      return Object.freeze({
        delivery: "live",
        agentSession: structuredClone(agentSession),
        ...(receipt.providerTurnId === undefined ? {} : { providerTurnId: receipt.providerTurnId }),
      });
    } catch (error: unknown) {
      if (
        error instanceof AgentAdapterError &&
        (error.code === "STEERING_ACTIVE_TURN_REQUIRED" || error.code === "STEERING_TURN_COMPLETED")
      ) {
        throw new AgentRunBridgeError(
          "STEERING_NOT_ACTIVE",
          "The exact provider turn is no longer steerable.",
          error.retryable,
        );
      }
      if (
        error instanceof AgentAdapterError &&
        (error.code === "STEERING_SCOPE_MISMATCH" ||
          error.code === "STEERING_REQUEST_REPLAY_CONFLICT")
      ) {
        throw new AgentRunBridgeError(
          "STEERING_SCOPE_MISMATCH",
          "The provider rejected the steering request scope or replay identity.",
        );
      }
      throw new AgentRunBridgeError(
        "STEERING_OUTCOME_UNKNOWN",
        "The provider steering outcome could not be determined safely.",
      );
    }
  }

  public forceTerminate(): Promise<void> {
    this.#cancelRequested = true;
    return this.#cancel(
      "The Worker Run exceeded its cancellation grace period; the adapter must terminate it.",
    );
  }

  async #checkLease(): Promise<void> {
    if (this.#stopped || this.#checkingLease || this.#leaseLost) {
      return;
    }
    this.#checkingLease = true;
    try {
      if (!(await safeLeaseCurrent(this.#context)) && !this.#stopped) {
        this.#leaseLost = true;
        await this.#cancel("The Worker execution lease was lost.");
      }
    } finally {
      this.#checkingLease = false;
    }
  }

  #cancel(reason: string): Promise<void> {
    if (this.#cancelPromise === undefined) {
      try {
        this.#cancelPromise = Promise.resolve(this.#handle.cancel(reason)).catch(() => undefined);
      } catch {
        this.#cancelPromise = Promise.resolve();
      }
    }
    return this.#cancelPromise;
  }

  async #complete(): Promise<RunProcessOutcome> {
    const eventResult = this.#consumeEvents().then(
      () => undefined,
      () => new AgentRunBridgeError("ADAPTER_START_FAILED", "Agent event streaming failed.", true),
    );
    const terminalResult = this.#handle.result.then(
      (result) => result,
      () => undefined,
    );
    const [eventError, rawResult] = await Promise.all([eventResult, terminalResult]);
    this.#stopMonitoring();

    if (this.#leaseLost || !(await safeLeaseCurrent(this.#context))) {
      this.#leaseLost = true;
      await this.#cancel("The Worker execution lease was lost.");
      return {
        status: "failed",
        report: this.#collector.finish(
          undefined,
          "The agent Run stopped because its Worker execution lease was lost.",
        ),
        diagnostic: {
          code: "RUN_AUTHORITY_LOST",
          stage: "lease",
          retryable: true,
        },
        ...usageProperty(normalizeAgentUsage(this.#latestUsage)),
        ...agentSessionProperty(this.#agentSession),
      };
    }
    if (this.#cancelRequested) {
      return {
        status: "failed",
        report: this.#collector.finish(undefined, "The agent Run was cancelled."),
        diagnostic: {
          code: "PROCESS_CANCELLED",
          stage: "cancellation",
          retryable: true,
        },
        ...usageProperty(normalizeAgentUsage(this.#latestUsage)),
        ...agentSessionProperty(this.#agentSession),
      };
    }
    if (eventError !== undefined || !isAgentRunResult(rawResult)) {
      return processFailureOutcome(
        this.#collector.finish(undefined, "The Agent Adapter returned no valid terminal result."),
        this.#agentSession,
      );
    }
    const result = rawResult;
    const usage = normalizeAgentUsage(result.usage ?? this.#latestUsage);
    if (result.session !== undefined) {
      try {
        assertSessionBinding(result.session, this.#expected);
        await this.#persistSession(result.session);
      } catch {
        return processFailureOutcome(
          this.#collector.finish(
            result.finalText,
            "The native session reference could not be persisted safely.",
          ),
          this.#agentSession,
        );
      }
    }
    if (result.status === "succeeded") {
      if (result.session === undefined) {
        return processFailureOutcome(
          this.#collector.finish(
            result.finalText,
            "The Agent Adapter completed without a resumable native session reference.",
          ),
          this.#agentSession,
        );
      }
      let artifactIds: readonly string[] = Object.freeze([]);
      if (
        this.#artifactLifecycle !== undefined &&
        this.#artifactPlan !== undefined &&
        this.#workspace !== undefined
      ) {
        try {
          artifactIds = validatePromotedArtifactIds(
            await this.#artifactLifecycle.promote({
              assignment: structuredClone(this.#context.assignment),
              workspace: cloneWorkspace(this.#workspace),
              plan: this.#artifactPlan,
              egressGuard: this.#egressGuard,
              isExecutionCurrent: () =>
                this.#cancelRequested ? Promise.resolve(false) : safeLeaseCurrent(this.#context),
            }),
          );
        } catch (error: unknown) {
          if (!(await safeLeaseCurrent(this.#context))) {
            this.#leaseLost = true;
            return {
              status: "failed",
              report: this.#collector.finish(
                result.finalText,
                "Artifact promotion stopped because its Worker execution lease was lost.",
              ),
              diagnostic: {
                code: "RUN_AUTHORITY_LOST",
                stage: "lease",
                retryable: true,
              },
              ...usageProperty(usage),
              ...agentSessionProperty(this.#agentSession),
            };
          }
          if (this.#cancelRequested) {
            return {
              status: "failed",
              report: this.#collector.finish(
                result.finalText,
                "Artifact promotion stopped because the Worker Run was cancelled.",
              ),
              diagnostic: {
                code: "PROCESS_CANCELLED",
                stage: "cancellation",
                retryable: true,
              },
              ...usageProperty(usage),
              ...agentSessionProperty(this.#agentSession),
            };
          }
          const egressDenied = isArtifactEgressDenied(error);
          return {
            status: "failed",
            report: this.#collector.finish(
              result.finalText,
              egressDenied
                ? "Artifact output was withheld by the Worker egress policy."
                : "The Worker could not promote the declared Artifact output safely.",
            ),
            diagnostic: {
              code: egressDenied ? "ARTIFACT_EGRESS_DENIED" : "ARTIFACT_PROMOTION_FAILED",
              stage: "artifact",
              retryable: !egressDenied,
            },
            ...usageProperty(usage),
            ...agentSessionProperty(this.#agentSession),
          };
        }
        if (!(await safeLeaseCurrent(this.#context))) {
          this.#leaseLost = true;
          return {
            status: "failed",
            report: this.#collector.finish(
              result.finalText,
              "Artifact promotion completed after its Worker execution lease was lost.",
            ),
            diagnostic: {
              code: "RUN_AUTHORITY_LOST",
              stage: "lease",
              retryable: true,
            },
            ...usageProperty(usage),
            ...agentSessionProperty(this.#agentSession),
          };
        }
        if (this.#cancelRequested) {
          return {
            status: "failed",
            report: this.#collector.finish(
              result.finalText,
              "The Worker Run was cancelled during Artifact promotion.",
            ),
            diagnostic: {
              code: "PROCESS_CANCELLED",
              stage: "cancellation",
              retryable: true,
            },
            ...usageProperty(usage),
            ...agentSessionProperty(this.#agentSession),
          };
        }
      }
      return {
        status: "succeeded",
        report: this.#collector.finish(
          result.finalText,
          "The agent completed without a public report.",
        ),
        artifactIds,
        ...usageProperty(usage),
        ...agentSessionProperty(this.#agentSession),
      };
    }
    if (result.status === "cancelled") {
      return {
        status: "failed",
        report: this.#collector.finish(result.finalText, "The Agent Adapter cancelled the Run."),
        diagnostic: {
          code: "PROCESS_CANCELLED",
          stage: "cancellation",
          retryable: result.error?.retryable ?? true,
        },
        ...usageProperty(usage),
        ...agentSessionProperty(this.#agentSession),
      };
    }
    if (result.status === "lease_lost") {
      return {
        status: "failed",
        report: this.#collector.finish(
          result.finalText,
          "The native agent session writer lease was lost.",
        ),
        diagnostic: {
          code: "RUN_AUTHORITY_LOST",
          stage: "lease",
          retryable: result.error?.retryable ?? true,
        },
        ...usageProperty(usage),
        ...agentSessionProperty(this.#agentSession),
      };
    }
    return {
      status: "failed",
      report: this.#collector.finish(
        result.finalText ?? result.error?.message,
        result.status === "timed_out"
          ? "The Agent Adapter exceeded its execution limit."
          : "The Agent Adapter reported a failed Run.",
      ),
      diagnostic: {
        code: "PROCESS_FAILED",
        stage: "execution",
        retryable: result.error?.retryable ?? result.status === "timed_out",
      },
      ...usageProperty(usage),
      ...agentSessionProperty(this.#agentSession),
    };
  }

  async #consumeEvents(): Promise<void> {
    for await (const event of this.#handle.events) {
      if (event.type === "session_started") {
        assertSessionBinding(event.session, this.#expected);
        await this.#persistSession(event.session);
      } else if (event.type === "public_message") {
        this.#collector.add(event.text);
      } else if (event.type === "usage") {
        this.#latestUsage = event.usage;
      }
    }
  }

  #stopMonitoring(): void {
    this.#stopped = true;
    clearInterval(this.#leaseTimer);
  }

  async #persistSession(session: NativeSessionReference): Promise<void> {
    await this.#egressGuard.bindPersistence((snapshot) =>
      this.#sessionStore.save(session, snapshot),
    );
    this.#agentSession = toWorkerAgentSessionObservation(session);
    this.#nativeSession = structuredClone(session);
  }
}

interface SessionBinding {
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly sessionKey: string;
  readonly taskId: string;
  readonly workstreamId: string;
  readonly deviceId: string;
  readonly workspaceId: string;
}

function assertSessionBinding(session: NativeSessionReference, expected: SessionBinding): void {
  if (
    session.schemaVersion !== 1 ||
    session.provider !== expected.provider ||
    session.adapterId !== expected.adapterId ||
    session.modelId !== expected.modelId ||
    session.effort !== expected.effort ||
    session.sessionKey !== expected.sessionKey ||
    session.taskId !== expected.taskId ||
    session.workstreamId !== expected.workstreamId ||
    session.deviceId !== expected.deviceId ||
    session.workspaceId !== expected.workspaceId
  ) {
    throw new AgentRunBridgeError(
      "SESSION_BINDING_MISMATCH",
      "Native session reference does not belong to this Task workstream and Workspace.",
    );
  }
}

type WorkerSessionAction =
  | {
      readonly kind: "start";
    }
  | {
      readonly kind: "resume";
      readonly session: NativeSessionReference;
    }
  | {
      readonly kind: "continuation";
      readonly session: NativeSessionReference;
      readonly reason: "native-session-resume-unavailable";
    };

async function resolveWorkerSessionAction(
  adapter: AgentAdapter,
  session: NativeSessionReference,
  environment?: Readonly<Record<string, string>>,
  secretEnvironment?: Readonly<Record<string, string>>,
): Promise<WorkerSessionAction> {
  let probe;
  try {
    probe = await adapter.probe({
      ...(environment === undefined ? {} : { environment }),
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    });
  } catch {
    throw new AgentRunBridgeError(
      "ADAPTER_NOT_READY",
      "The Agent Adapter readiness probe failed before native session resume.",
      true,
    );
  }
  if (
    probe.contractVersion !== 1 ||
    probe.adapterId !== adapter.adapterId ||
    probe.provider !== adapter.provider
  ) {
    throw new AgentRunBridgeError(
      "ADAPTER_NOT_READY",
      "The Agent Adapter readiness identity does not match the configured adapter.",
    );
  }
  const ready =
    probe.installed &&
    probe.compatibility !== "incompatible" &&
    (probe.auth.state === "ready" || probe.auth.state === "not_required") &&
    probe.version !== undefined;
  if (ready && probe.capabilities.resume && probe.version === session.adapterVersion) {
    return {
      kind: "resume",
      session,
    };
  }
  if (ready && probe.capabilities.start && probe.capabilities.checkpointContinuation) {
    return {
      kind: "continuation",
      session,
      reason: "native-session-resume-unavailable",
    };
  }
  throw new AgentRunBridgeError(
    "ADAPTER_NOT_READY",
    "The Agent Adapter cannot safely resume or continue the persisted native session.",
    true,
  );
}

async function assertAgentRequirementAvailable(
  adapter: AgentAdapter,
  requirement: WorkerAgentRequirementV1 | undefined,
  modelId?: string,
  effort?: string,
  environment?: Readonly<Record<string, string>>,
  secretEnvironment?: Readonly<Record<string, string>>,
): Promise<void> {
  if (requirement === undefined) {
    return;
  }
  if (
    adapter.provider !== requirement.provider ||
    (requirement.adapterId !== undefined && adapter.adapterId !== requirement.adapterId) ||
    (requirement.modelId !== undefined && modelId !== requirement.modelId) ||
    (requirement.effort !== undefined && effort !== requirement.effort)
  ) {
    throw agentRequirementUnavailable();
  }
  let probe;
  try {
    probe = await adapter.probe({
      ...(environment === undefined ? {} : { environment }),
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    });
  } catch {
    throw agentRequirementUnavailable();
  }
  const allowedCompatibilities: ReadonlySet<string> = new Set(
    requirement.allowedCompatibilities ?? (["tested"] as const),
  );
  if (
    probe.contractVersion !== 1 ||
    probe.provider !== requirement.provider ||
    probe.adapterId !== adapter.adapterId ||
    !probe.installed ||
    probe.version === undefined ||
    !allowedCompatibilities.has(probe.compatibility) ||
    (probe.auth.state !== "ready" && probe.auth.state !== "not_required") ||
    !probe.capabilities.start
  ) {
    throw agentRequirementUnavailable();
  }
  if (requirement.modelId !== undefined) {
    if (adapter.listModels === undefined) {
      throw agentRequirementUnavailable();
    }
    let catalog;
    try {
      catalog = await adapter.listModels({
        ...(environment === undefined ? {} : { environment }),
        ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
      });
    } catch {
      throw agentRequirementUnavailable();
    }
    const model = catalog.models.find((candidate) => candidate.modelId === requirement.modelId);
    if (
      model === undefined ||
      (requirement.effort !== undefined &&
        !(model.supportedEfforts ?? []).includes(requirement.effort))
    ) {
      throw agentRequirementUnavailable();
    }
  } else if (requirement.effort !== undefined) {
    throw agentRequirementUnavailable();
  }
}

function agentRequirementUnavailable(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "AGENT_REQUIREMENT_UNAVAILABLE",
    "The Worker cannot satisfy the immutable Agent requirement for this Run.",
    true,
  );
}

function toWorkerAgentSessionObservation(
  session: NativeSessionReference,
): WorkerAgentSessionObservationV1 {
  return Object.freeze({
    provider: session.provider,
    adapterId: session.adapterId,
    adapterVersion: session.adapterVersion,
    ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
    ...(session.effort === undefined ? {} : { effort: session.effort }),
    nativeSessionId: session.nativeSessionId,
    workstreamId: session.workstreamId,
    workspaceId: session.workspaceId,
    lineage: Object.freeze({
      lineageId: session.lineage.lineageId,
      ...(session.lineage.parentNativeSessionId === undefined
        ? {}
        : { parentNativeSessionId: session.lineage.parentNativeSessionId }),
      ...(session.lineage.continuationReason === undefined
        ? {}
        : { continuationReason: session.lineage.continuationReason }),
    }),
  });
}

function sameAgentSessionObservation(
  left: WorkerAgentSessionObservationV1,
  right: WorkerAgentSessionObservationV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function buildWorkerContinuationPrompt(
  assignment: WorkerRunAssignmentV1,
  maximumBytes: number,
): string {
  let checkpoint: TaskContinuationCheckpointV1;
  try {
    checkpoint = validateTaskContinuationCheckpoint(assignment.continuationCheckpoint);
  } catch {
    throw new AgentRunBridgeError(
      "INVALID_EXECUTION_PLAN",
      "The authoritative Task continuation checkpoint is unavailable or invalid.",
    );
  }
  if (
    checkpoint.taskId !== assignment.taskId ||
    !checkpoint.pendingWorkOrders.some(
      (workOrder) => workOrder.workOrderId === assignment.workOrder.workOrderId,
    )
  ) {
    throw new AgentRunBridgeError(
      "INVALID_EXECUTION_PLAN",
      "The authoritative continuation checkpoint does not bind this Task and Work Order.",
    );
  }
  const order = assignment.workOrder;
  const artifactIds = new Set(checkpoint.artifacts.map((artifact) => artifact.artifactId));
  const publicOrder = {
    protocolVersion: order.protocolVersion,
    workOrderId: order.workOrderId,
    title: boundedCheckpointText(order.title, 1_024),
    brief: boundedCheckpointText(order.brief, 4_096),
    completionCriteria: order.completionCriteria.map((criterion) =>
      boundedCheckpointText(criterion, 1_024),
    ),
    constraints: order.constraints.map((constraint) => boundedCheckpointText(constraint, 1_024)),
    selectedArtifactIds: order.selectedInputIds.filter((inputId) => artifactIds.has(inputId)),
    dependsOn: order.dependsOn,
    requiredCapabilities: order.requiredCapabilities,
    ...(order.requiredAgent === undefined ? {} : { requiredAgent: order.requiredAgent }),
    ...(assignment.agentRequirement === undefined
      ? {}
      : { effectiveAgentBinding: assignment.agentRequirement }),
    ...(order.requiredOsFamily === undefined ? {} : { requiredOsFamily: order.requiredOsFamily }),
    ...(order.workspaceId === undefined ? {} : { workspaceId: order.workspaceId }),
  };
  const prompt = [
    "You are an OpenDelegate Worker Agent continuing exactly one Work Order after its provider-native session became unavailable.",
    "Use only the versioned, hash-verified public Task checkpoint and current Work Order below.",
    "Do not use another Task, omitted content, Device Knowledge, a raw transcript, a Secret reference, a local filesystem path, lease authority, or fencing data as remembered context.",
    "Do not infer that a prior side effect completed. Re-check current Workspace state through the tools already authorized for this Run.",
    "Durable checkpoint continuation package:",
    serializeTaskContinuationCheckpoint(checkpoint),
    `Current Work Order JSON: ${JSON.stringify(publicOrder)}`,
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw new AgentRunBridgeError(
      "INVALID_EXECUTION_PLAN",
      "The bounded native-session continuation package exceeds the Agent prompt limit.",
    );
  }
  return prompt;
}

function boundedCheckpointText(input: string, maximumBytes: number): string {
  const sanitized = sanitizeTaskContinuationText(input).trim();
  if (sanitized.length === 0) {
    return "[redacted public text]";
  }
  if (Buffer.byteLength(sanitized, "utf8") <= maximumBytes) {
    return sanitized;
  }
  const suffix = "…";
  const available = maximumBytes - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of sanitized) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > available) {
      break;
    }
    output += character;
    bytes += next;
  }
  return `${output.trimEnd()}${suffix}`;
}

export function workerArtifactAssignmentFingerprint(
  assignment: WorkerRunAssignmentV1,
  workspaceId: string,
): string {
  assertIdentifier(workspaceId, "Workspace ID", "INVALID_EXECUTION_PLAN");
  return createHash("sha256")
    .update(
      canonicalJson({
        schema: "opendelegate.worker-artifact-assignment.v1",
        assignment,
        workspaceId,
      }),
    )
    .digest("hex");
}

function validateArtifactOutputPlan(
  plan: WorkerArtifactOutputPlan,
  expectedFingerprint: string,
): WorkerArtifactOutputPlan {
  if (
    plan === null ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.schemaVersion !== 1 ||
    plan.assignmentFingerprint !== expectedFingerprint ||
    !/^[a-f0-9]{64}$/u.test(plan.assignmentFingerprint) ||
    !isNormalizedAbsolutePath(plan.outputRoot) ||
    !isNormalizedAbsolutePath(plan.manifestPath) ||
    !isWithin(plan.outputRoot, plan.manifestPath)
  ) {
    throw new TypeError("Invalid Artifact output plan.");
  }
  return Object.freeze({
    schemaVersion: 1,
    outputRoot: plan.outputRoot,
    manifestPath: plan.manifestPath,
    assignmentFingerprint: plan.assignmentFingerprint,
  });
}

function appendArtifactOutputContract(prompt: string, maximumBytes: number): string {
  const instructions = [
    prompt,
    "",
    "## Artifact output contract",
    "",
    "If this Run produces durable files for the owner, use only the exact Run-scoped mcp__opendelegate-artifact__artifact_write_chunk tool to append bounded base64-encoded bytes at explicit offsets. After every file is complete, call mcp__opendelegate-artifact__artifact_commit once with the exact relative paths, media types, original filenames, and optional presentation modes. Do not attempt to discover or write an Artifact staging path directly. Do not include credentials, Device-local Knowledge, hidden reasoning, raw transcripts, or temporary files. If there are no durable files, do not call either Artifact tool.",
    "relativePath must use forward slashes and remain within this Run capability. requestedPresentation may be omitted or be download, inline, static-html, or interactive-html.",
  ].join("\n");
  if (Buffer.byteLength(instructions, "utf8") > maximumBytes) {
    throw new AgentRunBridgeError(
      "ARTIFACT_PREPARATION_FAILED",
      "The bounded Artifact output contract exceeds the Agent prompt limit.",
    );
  }
  return instructions;
}

function appendPendingSteeringInstructions(
  prompt: string,
  pending: readonly NativeSessionSteeringInstruction[],
  maximumBytes: number,
): string {
  if (pending.length === 0) {
    return prompt;
  }
  const instructions = [
    prompt,
    "",
    "## Pending OpenDelegate steering for this exact Task workstream",
    "",
    "Apply each instruction below during this resumed provider turn. Request IDs are audit identities, not tool authority. Do not apply these instructions to another Task, Device, Workspace, workstream, or native-session lineage.",
    JSON.stringify(
      pending.map((entry) => ({
        requestId: entry.requestId,
        requestedBy: entry.requestedBy,
        instruction: entry.instruction,
      })),
    ),
  ].join("\n");
  if (Buffer.byteLength(instructions, "utf8") > maximumBytes) {
    throw new AgentRunBridgeError(
      "INVALID_EXECUTION_PLAN",
      "The bounded next-resume steering input exceeds the Agent prompt limit.",
    );
  }
  return instructions;
}

function validatePromotedArtifactIds(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (artifactId, index) =>
        typeof artifactId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(artifactId) ||
        value.indexOf(artifactId) !== index,
    )
  ) {
    throw new TypeError("Invalid promoted Artifact identifiers.");
  }
  return Object.freeze([...value]);
}

function isArtifactEgressDenied(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "code" in error && error.code === "EGRESS_DENIED"
  );
}

function isNormalizedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

function isWithin(parent: string, child: string): boolean {
  const relationship = relative(parent, child);
  return (
    relationship !== "" &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`) &&
    !isAbsolute(relationship)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateExecutionPlan(
  plan: WorkerAgentExecutionPlan,
  taskId: string,
  maxPromptBytes: number,
): void {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw invalidExecutionPlan();
  }
  assertIdentifier(plan.adapterId, "Agent adapter ID", "INVALID_EXECUTION_PLAN");
  if (plan.modelId !== undefined) {
    assertIdentifier(plan.modelId, "Agent model ID", "INVALID_EXECUTION_PLAN");
  }
  assertIdentifier(plan.workstreamId, "Workstream ID", "INVALID_EXECUTION_PLAN");
  if (
    (plan.provider !== "codex" && plan.provider !== "claude" && plan.provider !== "generic") ||
    typeof plan.prompt !== "string" ||
    plan.prompt.trim().length === 0 ||
    plan.prompt.includes("\0") ||
    Buffer.byteLength(plan.prompt, "utf8") > maxPromptBytes ||
    !isSandbox(plan.sandbox)
  ) {
    throw invalidExecutionPlan();
  }
  validatePermissions(plan.permissions, taskId);
  validateToolServers(plan.toolServers);
  validateAgentLimits(plan.limits);
  validateEnvironment(plan.environment);
  validateEnvironment(plan.secretEnvironment);
}

function validateToolServers(toolServers: readonly AgentToolServer[] | undefined): void {
  if (toolServers === undefined) {
    return;
  }
  if (
    !Array.isArray(toolServers) ||
    toolServers.length === 0 ||
    toolServers.length > 8 ||
    new Set(toolServers.map((server) => server.serverName)).size !== toolServers.length
  ) {
    throw invalidExecutionPlan();
  }
  for (const server of toolServers) {
    if (
      server === null ||
      typeof server !== "object" ||
      !/^[a-z][a-z0-9_-]{0,63}$/u.test(server.serverName) ||
      typeof server.command !== "string" ||
      !isAbsolute(server.command) ||
      server.command.includes("\0") ||
      !Array.isArray(server.args) ||
      server.args.length > 64 ||
      server.args.some(
        (argument: unknown) =>
          typeof argument !== "string" || argument.length > 8_192 || argument.includes("\0"),
      ) ||
      !Array.isArray(server.enabledTools) ||
      server.enabledTools.length === 0 ||
      server.enabledTools.length > 64 ||
      new Set(server.enabledTools).size !== server.enabledTools.length ||
      server.enabledTools.some(
        (tool: unknown) => typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(tool),
      ) ||
      !Number.isSafeInteger(server.startupTimeoutMs) ||
      server.startupTimeoutMs < 1_000 ||
      server.startupTimeoutMs > 120_000 ||
      !Number.isSafeInteger(server.toolTimeoutMs) ||
      server.toolTimeoutMs < 1_000 ||
      server.toolTimeoutMs > 300_000
    ) {
      throw invalidExecutionPlan();
    }
  }
}

function mergeToolServers(
  configured: readonly AgentToolServer[] | undefined,
  ephemeral: readonly AgentToolServer[] | undefined,
): readonly AgentToolServer[] | undefined {
  if (configured === undefined && ephemeral === undefined) {
    return undefined;
  }
  const merged = [...(configured ?? []), ...(ephemeral ?? [])];
  validateToolServers(merged);
  return Object.freeze(merged);
}

async function disposeCapabilityLease(lease: WorkerRunCapabilityLease | undefined): Promise<void> {
  if (lease === undefined || typeof lease.dispose !== "function") {
    return;
  }
  try {
    await lease.dispose();
  } catch {
    // Capability cleanup is fail-closed at its broker/resource boundary. Provider
    // diagnostics remain private and cannot replace the authoritative Run result.
  }
}

async function disposeCapabilityLeasesReverse(
  leases: readonly WorkerRunCapabilityLease[],
): Promise<void> {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    await disposeCapabilityLease(leases[index]);
  }
}

function capabilityPreparationFailed(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "CAPABILITY_PREPARATION_FAILED",
    "The Worker could not prepare a bounded Run capability.",
    true,
  );
}

function validateWorkspace(workspace: WorkspaceBinding, assignment: WorkerRunAssignmentV1): void {
  if (
    workspace === null ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    typeof workspace.workspaceId !== "string" ||
    workspace.workspaceId.length === 0 ||
    typeof workspace.cwd !== "string" ||
    workspace.cwd.length === 0 ||
    !isWorkspaceIsolation(workspace.isolation) ||
    (assignment.workOrder.workspaceId !== undefined &&
      workspace.workspaceId !== assignment.workOrder.workspaceId)
  ) {
    throw new AgentRunBridgeError(
      "WORKSPACE_RESOLUTION_FAILED",
      "The resolved Workspace does not match the Work Order.",
    );
  }
}

function validatePermissions(permissions: AgentPermissionInput, taskId: string): void {
  if (
    permissions === null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    (permissions.mode !== "deny" &&
      permissions.mode !== "allow-listed" &&
      permissions.mode !== "bypass")
  ) {
    throw invalidExecutionPlan();
  }
  validateStringList(permissions.allowedTools);
  validateStringList(permissions.deniedTools);
  if (
    permissions.actionAuthorization !== undefined &&
    (permissions.actionAuthorization === null ||
      typeof permissions.actionAuthorization !== "object" ||
      typeof permissions.actionAuthorization.authorizeAndConsume !== "function")
  ) {
    throw invalidExecutionPlan();
  }
  if (permissions.mode === "bypass") {
    const grant = permissions.dangerousBypassGrant;
    if (
      grant === undefined ||
      (grant.grantedBy !== "owner" && grant.grantedBy !== "policy") ||
      grant.scope !== "task" ||
      grant.taskId !== taskId ||
      typeof grant.grantId !== "string" ||
      grant.grantId.length === 0
    ) {
      throw invalidExecutionPlan();
    }
  } else if (permissions.dangerousBypassGrant !== undefined) {
    throw invalidExecutionPlan();
  }
}

function validateStringList(values: readonly string[] | undefined): void {
  if (
    values !== undefined &&
    (!Array.isArray(values) ||
      values.length > 256 ||
      values.some(
        (value, index) =>
          typeof value !== "string" ||
          value.length === 0 ||
          value !== value.trim() ||
          values.indexOf(value) !== index,
      ))
  ) {
    throw invalidExecutionPlan();
  }
}

function validateAgentLimits(limits: AgentRunLimits): void {
  const requiredKeys = [
    "wallTimeoutMs",
    "idleTimeoutMs",
    "cancellationGraceMs",
    "leaseTtlMs",
    "leaseRenewIntervalMs",
    "maxBufferedEvents",
    "maxLineBytes",
    "maxDiagnosticBytes",
  ] as const;
  if (
    limits === null ||
    typeof limits !== "object" ||
    Array.isArray(limits) ||
    Object.keys(limits).some(
      (key) => !requiredKeys.includes(key as (typeof requiredKeys)[number]),
    ) ||
    requiredKeys.some((key) => !Number.isSafeInteger(limits[key]) || limits[key] < 1) ||
    limits.leaseRenewIntervalMs >= limits.leaseTtlMs
  ) {
    throw invalidExecutionPlan();
  }
}

function validateEnvironment(values: Readonly<Record<string, string>> | undefined): void {
  if (values === undefined) {
    return;
  }
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw invalidExecutionPlan();
  }
  const entries = Object.entries(values);
  if (entries.length > 256) {
    throw invalidExecutionPlan();
  }
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key.length > 256 ||
      key.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw invalidExecutionPlan();
    }
    totalBytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > 1_048_576) {
      throw invalidExecutionPlan();
    }
  }
}

function validateBridgeLimits(limits: AgentRunBridgeLimits): AgentRunBridgeLimits {
  if (
    !Number.isSafeInteger(limits.leaseCheckIntervalMs) ||
    limits.leaseCheckIntervalMs < 1 ||
    limits.leaseCheckIntervalMs > 60_000 ||
    !Number.isSafeInteger(limits.maxPromptBytes) ||
    limits.maxPromptBytes < 1 ||
    limits.maxPromptBytes > 16_777_216 ||
    !Number.isSafeInteger(limits.maxPublicMessages) ||
    limits.maxPublicMessages < 1 ||
    limits.maxPublicMessages > 4_096 ||
    !Number.isSafeInteger(limits.maxReportBytes) ||
    limits.maxReportBytes < 256 ||
    limits.maxReportBytes > 262_144
  ) {
    throw invalidBridgeConfiguration();
  }
  return Object.freeze({ ...limits });
}

function createSessionKey(input: {
  readonly taskId: string;
  readonly workstreamId: string;
  readonly deviceId: string;
  readonly provider: AgentProvider;
  readonly adapterId: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly workspaceId: string;
}): string {
  const version = input.effort !== undefined ? "v3" : input.modelId === undefined ? "v1" : "v2";
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        `opendelegate.worker-session.${version}`,
        input.taskId,
        input.workstreamId,
        input.deviceId,
        input.provider,
        input.adapterId,
        ...(input.modelId === undefined ? [] : [input.modelId]),
        ...(input.effort === undefined ? [] : [input.effort]),
        input.workspaceId,
      ]),
    )
    .digest("hex");
  return `opendelegate.worker-session.${version}:${digest}`;
}

function cloneWorkspace(workspace: WorkspaceBinding): WorkspaceBinding {
  return {
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    ...(workspace.worktreePath === undefined ? {} : { worktreePath: workspace.worktreePath }),
    isolation: workspace.isolation,
  };
}

function permissionsForRun(
  permissions: AgentPermissionInput,
  toolServers: readonly AgentToolServer[] | undefined,
): AgentPermissionInput {
  const capabilityTools =
    permissions.mode === "allow-listed"
      ? (toolServers ?? []).flatMap((server) =>
          server.enabledTools.map((tool) => `mcp__${server.serverName}__${tool}`),
        )
      : [];
  const allowedTools =
    permissions.allowedTools === undefined && capabilityTools.length === 0
      ? undefined
      : [...new Set([...(permissions.allowedTools ?? []), ...capabilityTools])];
  return {
    mode: permissions.mode,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(permissions.deniedTools === undefined ? {} : { deniedTools: [...permissions.deniedTools] }),
    ...(permissions.dangerousBypassGrant === undefined
      ? {}
      : { dangerousBypassGrant: { ...permissions.dangerousBypassGrant } }),
    ...(permissions.actionAuthorization === undefined
      ? {}
      : { actionAuthorization: permissions.actionAuthorization }),
  };
}

function cloneToolServers(toolServers: readonly AgentToolServer[]): readonly AgentToolServer[] {
  return toolServers.map((server) => ({
    serverName: server.serverName,
    command: server.command,
    args: [...server.args],
    enabledTools: [...server.enabledTools],
    startupTimeoutMs: server.startupTimeoutMs,
    toolTimeoutMs: server.toolTimeoutMs,
  }));
}

function hasExactArtifactRunWriter(toolServers: readonly AgentToolServer[] | undefined): boolean {
  return (toolServers ?? []).some(
    (server) =>
      server.serverName === "opendelegate-artifact" &&
      server.enabledTools.includes("artifact_write_chunk") &&
      server.enabledTools.includes("artifact_commit"),
  );
}

function completedRunProcess(outcome: RunProcessOutcome): RunProcess {
  return {
    completion: Promise.resolve(outcome),
    requestCancel: () => Promise.resolve(),
    forceTerminate: () => Promise.resolve(),
  };
}

function authorityLostOutcome(): RunProcessOutcome {
  return {
    status: "failed",
    report: "The agent Run did not start because its Worker execution lease was not current.",
    diagnostic: {
      code: "RUN_AUTHORITY_LOST",
      stage: "lease",
      retryable: true,
    },
  };
}

function processFailureOutcome(
  report = "The Agent Adapter failed without exposing provider internals.",
  agentSession?: WorkerAgentSessionObservationV1,
): RunProcessOutcome {
  return {
    status: "failed",
    report,
    diagnostic: {
      code: "PROCESS_FAILED",
      stage: "execution",
      retryable: true,
    },
    ...agentSessionProperty(agentSession),
  };
}

async function safeLeaseCurrent(context: RunExecutionContext): Promise<boolean> {
  try {
    return (await context.isLeaseCurrent()) === true;
  } catch {
    return false;
  }
}

function isAgentRunResult(value: unknown): value is AgentRunResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    (result["status"] === "succeeded" ||
      result["status"] === "failed" ||
      result["status"] === "cancelled" ||
      result["status"] === "timed_out" ||
      result["status"] === "lease_lost") &&
    (result["finalText"] === undefined || typeof result["finalText"] === "string")
  );
}

function applyWorkOrderTimeBudget(
  plan: WorkerAgentExecutionPlan,
  workOrder: WorkerRunAssignmentV1["workOrder"],
): WorkerAgentExecutionPlan {
  const wallHard = workOrder.budgetLimits?.wallTimeMs?.hard;
  const idleHard = workOrder.budgetLimits?.idleTimeMs?.hard;
  if (wallHard === undefined && idleHard === undefined) {
    return plan;
  }
  const wallTimeoutMs =
    wallHard === undefined
      ? plan.limits.wallTimeoutMs
      : Math.min(plan.limits.wallTimeoutMs, wallHard);
  const idleTimeoutMs =
    idleHard === undefined
      ? plan.limits.idleTimeoutMs
      : Math.min(plan.limits.idleTimeoutMs, idleHard);
  if (wallTimeoutMs < 1 || idleTimeoutMs < 1) {
    throw new AgentRunBridgeError(
      "INVALID_EXECUTION_PLAN",
      "The Work Order time Budget is already exhausted.",
    );
  }
  return Object.freeze({
    ...plan,
    limits: Object.freeze({
      ...plan.limits,
      wallTimeoutMs,
      idleTimeoutMs,
    }),
  });
}

function normalizeAgentUsage(value: AgentUsage | undefined): WorkerProviderUsageV1 | undefined {
  if (value === undefined) {
    return undefined;
  }
  const usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsdMicros?: number;
  } = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"] as const) {
    const amount = value[key];
    if (amount === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return undefined;
    }
    usage[key] = amount;
  }
  if (value.costUsd !== undefined) {
    if (!Number.isFinite(value.costUsd) || value.costUsd < 0) {
      return undefined;
    }
    const costUsdMicros = Math.ceil(value.costUsd * 1_000_000);
    if (!Number.isSafeInteger(costUsdMicros)) {
      return undefined;
    }
    usage.costUsdMicros = costUsdMicros;
  }
  return Object.keys(usage).length === 0 ? undefined : Object.freeze(usage);
}

function usageProperty(usage: WorkerProviderUsageV1 | undefined): {
  readonly usage?: WorkerProviderUsageV1;
} {
  return usage === undefined ? {} : { usage };
}

function agentSessionProperty(agentSession: WorkerAgentSessionObservationV1 | undefined): {
  readonly agentSession?: WorkerAgentSessionObservationV1;
} {
  return agentSession === undefined ? {} : { agentSession };
}

function isSandbox(value: unknown): value is AgentSandbox {
  return (
    value === "provider-default" ||
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access" ||
    value === "container" ||
    value === "custom"
  );
}

function isWorkspaceIsolation(value: unknown): boolean {
  return (
    value === "none" ||
    value === "agent-native-worktree" ||
    value === "opendelegate-worktree" ||
    value === "container" ||
    value === "custom"
  );
}

function assertIdentifier(
  value: unknown,
  label: string,
  code: "INVALID_BRIDGE_CONFIGURATION" | "INVALID_EXECUTION_PLAN",
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new AgentRunBridgeError(code, `${label} is invalid.`);
  }
}

function invalidExecutionPlan(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "INVALID_EXECUTION_PLAN",
    "The Worker Agent execution plan is invalid or exceeds its configured limits.",
  );
}

function invalidBridgeConfiguration(): AgentRunBridgeError {
  return new AgentRunBridgeError(
    "INVALID_BRIDGE_CONFIGURATION",
    "Agent Run bridge configuration is invalid.",
  );
}

interface ReportCollectorOptions {
  readonly maxBytes: number;
  readonly maxMessages: number;
  readonly secretValues: readonly string[];
  readonly egressGuard: WorkerEgressGuard;
}

class BoundedPublicReportCollector {
  readonly #maxBytes: number;
  readonly #maxMessages: number;
  readonly #redactor: ReportRedactor;
  readonly #egressGuard: WorkerEgressGuard;
  readonly #messages: string[] = [];
  #collectedBytes = 0;
  #truncated = false;

  public constructor(options: ReportCollectorOptions) {
    this.#maxBytes = options.maxBytes;
    this.#maxMessages = options.maxMessages;
    this.#redactor = new ReportRedactor(options.secretValues);
    this.#egressGuard = options.egressGuard;
  }

  public add(value: string): void {
    let redacted = this.#redactor.redact(value).replaceAll("\r\n", "\n").trim();
    if (redacted.length === 0) {
      return;
    }
    const inspection = this.#egressGuard.inspectText(redacted);
    if (!inspection.safe) {
      redacted = withheldReportMarker(inspection.reason);
    }
    if (this.#messages.length >= this.#maxMessages) {
      this.#truncated = true;
      return;
    }
    const separatorBytes = this.#messages.length === 0 ? 0 : 2;
    const remaining = this.#maxBytes - this.#collectedBytes - separatorBytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const selected = truncateUtf8(redacted, remaining);
    if (selected.length === 0) {
      this.#truncated = true;
      return;
    }
    this.#messages.push(selected);
    this.#collectedBytes += separatorBytes + Buffer.byteLength(selected, "utf8");
    if (selected !== redacted) {
      this.#truncated = true;
    }
  }

  public finish(finalText: string | undefined, fallback: string): string {
    if (finalText !== undefined) {
      const prior = this.#messages.at(-1);
      const redactedFinal = this.#redactor.redact(finalText).replaceAll("\r\n", "\n").trim();
      if (redactedFinal.length > 0 && redactedFinal !== prior) {
        this.add(redactedFinal);
      }
    }
    if (this.#messages.length === 0) {
      this.#messages.push(this.#redactor.redact(fallback));
    }
    const marker = "\n\n[Report truncated by OpenDelegate.]";
    let report = this.#messages.join("\n\n");
    if (Buffer.byteLength(report, "utf8") > this.#maxBytes) {
      this.#truncated = true;
    }
    if (this.#truncated) {
      const contentBudget = Math.max(0, this.#maxBytes - Buffer.byteLength(marker, "utf8"));
      report = `${truncateUtf8(report, contentBudget)}${marker}`;
    }
    return truncateUtf8(report, this.#maxBytes);
  }
}

function withheldReportMarker(reason: WorkerEgressBlockReason): string {
  switch (reason) {
    case "device-local-knowledge":
      return "[Device-local Knowledge content withheld by OpenDelegate.]";
    case "device-local-secret":
      return "[Device-local Secret content withheld by OpenDelegate.]";
    case "unscannable-artifact":
      return "[Unscannable local output withheld by OpenDelegate.]";
    case "unverifiable-knowledge-history":
      return "[Free-form output withheld because native-session Knowledge history could not be verified.]";
    case "unverifiable-secret-history":
      return "[Free-form output withheld because native-session Secret exposure history could not be verified.]";
  }
}

class ReportRedactor {
  readonly #needles: readonly string[];

  public constructor(secretValues: readonly string[]) {
    const needles = new Set<string>();
    for (const value of secretValues) {
      if (value.length === 0) {
        continue;
      }
      needles.add(value);
      needles.add(JSON.stringify(value).slice(1, -1));
      try {
        needles.add(encodeURIComponent(value));
      } catch {
        // Literal and JSON encodings remain protected.
      }
      needles.add(Buffer.from(value, "utf8").toString("base64"));
    }
    this.#needles = [...needles].sort((left, right) => right.length - left.length);
  }

  public redact(value: string): string {
    let result = value;
    for (const needle of this.#needles) {
      result = result.split(needle).join("[REDACTED]");
    }
    return result;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}
