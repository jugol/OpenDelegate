import {
  SchedulerError,
  scheduleWorkOrder,
  type DeviceCandidate,
  type ScheduleRequest,
} from "@opendelegate/scheduler";
import {
  DEFAULT_AGENT_EXECUTION_PROFILE,
  type AgentBinding,
  type AgentExecutionProfile,
} from "@opendelegate/configuration";
import type { WorkerAgentCompatibilityV1, WorkerAgentRequirementV1 } from "@opendelegate/protocol";
import {
  TaskExecutorError,
  type WorkerDispatchTarget,
  type WorkerDispatchTargetResolver,
} from "@opendelegate/task-service";

export interface WorkerCandidateSource {
  list(): Promise<readonly AgentAwareWorkerCandidate[]>;
}

export interface AgentAwareWorkerCandidate extends DeviceCandidate {
  readonly agentExecutionProfile?: AgentExecutionProfile;
  readonly agentAdapters?: readonly {
    readonly provider: WorkerAgentRequirementV1["provider"];
    readonly adapterId: string;
    readonly readiness: "ready" | "degraded" | "unavailable";
    readonly compatibility: WorkerAgentCompatibilityV1 | "incompatible";
    readonly models: readonly {
      readonly modelId: string;
      readonly isDefault: boolean;
    }[];
  }[];
}

export interface DeterministicWorkerTargetResolverOptions {
  readonly candidates: WorkerCandidateSource;
}

/**
 * Applies the code-owned scheduling gates before any Run assignment is created.
 *
 * Candidate snapshots already contain the effective Policy decision and transport
 * health. The scheduler filters offline, draining, incapable, unauthorized,
 * secret-ineligible, Workspace-ineligible, and saturated Devices, then scores the
 * remaining set with stable tie-breaking. A retry first excludes Devices that
 * already owned the Work Order, but may reuse one only when no other eligible
 * Device exists.
 */
export class DeterministicWorkerTargetResolver implements WorkerDispatchTargetResolver {
  readonly #candidates: WorkerCandidateSource;

  public constructor(options: DeterministicWorkerTargetResolverOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      options.candidates === null ||
      typeof options.candidates !== "object" ||
      typeof options.candidates.list !== "function"
    ) {
      throw new TypeError("A Worker candidate source is required.");
    }
    this.#candidates = options.candidates;
  }

  public async resolve(
    input: Parameters<WorkerDispatchTargetResolver["resolve"]>[0],
  ): Promise<WorkerDispatchTarget> {
    if (input.signal.aborted) {
      throw cancelled();
    }
    let candidates: readonly AgentAwareWorkerCandidate[];
    try {
      candidates = await this.#candidates.list();
    } catch {
      throw unavailable();
    }
    if (input.signal.aborted) {
      throw cancelled();
    }
    if (!Array.isArray(candidates)) {
      throw unavailable();
    }

    const request = toScheduleRequest(input.workOrder);
    const agentSelections = new Map<string, { readonly requirement?: WorkerAgentRequirementV1 }>();
    const agentEligibleCandidates = candidates.filter((candidate) => {
      const selection = resolveCandidateAgentSelection(candidate, input.workOrder.requiredAgent);
      if (selection === undefined) {
        return false;
      }
      agentSelections.set(candidate.deviceId, selection);
      return true;
    });
    if (agentEligibleCandidates.length === 0 && candidates.length > 0) {
      throw agentBindingUnavailable();
    }
    const priorDeviceIds = new Set(input.previousRuns.map((run) => run.deviceId));
    const unusedCandidates = agentEligibleCandidates.filter(
      (candidate) => !priorDeviceIds.has(candidate.deviceId),
    );
    const selected =
      priorDeviceIds.size > 0 && unusedCandidates.length > 0
        ? (trySchedule(request, unusedCandidates) ?? trySchedule(request, agentEligibleCandidates))
        : trySchedule(request, agentEligibleCandidates);
    if (selected === undefined) {
      throw unavailable();
    }
    const agentSelection = agentSelections.get(selected.selectedDevice.deviceId);
    return Object.freeze({
      deviceId: selected.selectedDevice.deviceId,
      workerId: selected.selectedDevice.workerId,
      routeId: selected.selectedRoute.routeId,
      ...(agentSelection?.requirement === undefined
        ? {}
        : { agentRequirement: agentSelection.requirement }),
    });
  }
}

function resolveCandidateAgentSelection(
  candidate: AgentAwareWorkerCandidate,
  hardRequirement: WorkerAgentRequirementV1 | undefined,
): { readonly requirement?: WorkerAgentRequirementV1 } | undefined {
  const profile = candidate.agentExecutionProfile ?? DEFAULT_AGENT_EXECUTION_PROFILE;
  const adapters = candidate.agentAdapters;
  // Legacy test fixtures and pre-upgrade observations have no adapter directory.
  // Preserve their previous behavior; production fleet projections always provide
  // the field and therefore fail closed on an unavailable exact binding.
  if (adapters === undefined) {
    return Object.freeze({
      ...(hardRequirement === undefined ? {} : { requirement: structuredClone(hardRequirement) }),
    });
  }
  if (profile.mode === "auto") {
    const resolved = selectAutomaticBinding(adapters, hardRequirement);
    return resolved === undefined
      ? undefined
      : Object.freeze({ requirement: bindingRequirement(resolved) });
  }
  const bindings =
    profile.mode === "prefer" ? [profile.primary, ...profile.fallbacks] : [profile.primary];
  const selected = bindings.find(
    (binding) =>
      bindingSatisfiesHardRequirement(binding, hardRequirement) &&
      bindingIsAvailable(binding, adapters),
  );
  return selected === undefined
    ? undefined
    : Object.freeze({ requirement: bindingRequirement(selected) });
}

function selectAutomaticBinding(
  adapters: NonNullable<AgentAwareWorkerCandidate["agentAdapters"]>,
  hardRequirement: WorkerAgentRequirementV1 | undefined,
): AgentBinding | undefined {
  const ordered = adapters
    .filter(
      (adapter) =>
        adapter.readiness === "ready" &&
        adapter.compatibility === "tested" &&
        (adapter.provider === "generic" || adapter.models.length > 0) &&
        (hardRequirement === undefined ||
          (adapter.provider === hardRequirement.provider &&
            (hardRequirement.adapterId === undefined ||
              adapter.adapterId === hardRequirement.adapterId) &&
            (hardRequirement.modelId === undefined ||
              adapter.models.some((model) => model.modelId === hardRequirement.modelId)))),
    )
    .sort(
      (left, right) =>
        Number(right.models.length > 0) - Number(left.models.length > 0) ||
        providerPriority(left.provider) - providerPriority(right.provider) ||
        adapterPriority(left.adapterId) - adapterPriority(right.adapterId) ||
        left.adapterId.localeCompare(right.adapterId, "en"),
    );
  const adapter = ordered[0];
  if (adapter === undefined) {
    return undefined;
  }
  const modelId =
    hardRequirement?.modelId ??
    adapter.models.find((model) => model.isDefault)?.modelId ??
    adapter.models[0]?.modelId;
  return Object.freeze({
    provider: adapter.provider,
    adapterId: adapter.adapterId,
    ...(modelId === undefined ? {} : { modelId }),
  });
}

function bindingSatisfiesHardRequirement(
  binding: AgentBinding,
  required: WorkerAgentRequirementV1 | undefined,
): boolean {
  if (required === undefined) {
    return true;
  }
  return (
    binding.provider === required.provider &&
    (required.adapterId === undefined || binding.adapterId === required.adapterId) &&
    (required.modelId === undefined || binding.modelId === required.modelId) &&
    (required.allowedCompatibilities ?? (["tested"] as const)).includes("tested")
  );
}

function bindingIsAvailable(
  binding: AgentBinding,
  adapters: NonNullable<AgentAwareWorkerCandidate["agentAdapters"]>,
): boolean {
  const adapter = adapters.find(
    (candidate) =>
      candidate.provider === binding.provider &&
      candidate.adapterId === binding.adapterId &&
      candidate.readiness === "ready" &&
      candidate.compatibility === "tested",
  );
  if (adapter === undefined) {
    return false;
  }
  return (
    binding.modelId === undefined ||
    adapter.models.some((model) => model.modelId === binding.modelId)
  );
}

function bindingRequirement(binding: AgentBinding): WorkerAgentRequirementV1 {
  return Object.freeze({
    provider: binding.provider,
    adapterId: binding.adapterId,
    ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
    allowedCompatibilities: Object.freeze(["tested"] as const),
  });
}

function providerPriority(provider: WorkerAgentRequirementV1["provider"]): number {
  return provider === "codex" ? 0 : provider === "claude" ? 1 : 2;
}

function adapterPriority(adapterId: string): number {
  return /(?:app-server|agent-sdk)/u.test(adapterId) ? 0 : /cli/u.test(adapterId) ? 1 : 2;
}

function toScheduleRequest(
  workOrder: Parameters<WorkerDispatchTargetResolver["resolve"]>[0]["workOrder"],
): ScheduleRequest {
  return {
    workOrderId: workOrder.workOrderId,
    requiredCapabilities: providerCapabilities(workOrder),
    preferredCapabilities: [],
    preferredDeviceIds: [...workOrder.schedulingHints.preferredDeviceIds],
    preferredRoles: [...workOrder.schedulingHints.preferredRoles],
    requiredSecretRefs: [...workOrder.requiredSecretRefs],
    ...(workOrder.requiredOsFamily === undefined
      ? {}
      : { requiredOsFamily: workOrder.requiredOsFamily }),
    ...(workOrder.workspaceId === undefined ? {} : { workspaceId: workOrder.workspaceId }),
  };
}

function providerCapabilities(
  workOrder: Parameters<WorkerDispatchTargetResolver["resolve"]>[0]["workOrder"],
): readonly string[] {
  const required = new Set(workOrder.requiredCapabilities);
  if (workOrder.requiredAgent !== undefined) {
    required.add(
      workOrder.requiredAgent.provider === "claude"
        ? "claude-code"
        : workOrder.requiredAgent.provider,
    );
  }
  return Object.freeze([...required]);
}

function trySchedule(
  request: ScheduleRequest,
  candidates: readonly DeviceCandidate[],
): ReturnType<typeof scheduleWorkOrder> | undefined {
  try {
    return scheduleWorkOrder(request, candidates);
  } catch (error) {
    if (error instanceof SchedulerError && error.code === "SCHEDULER_NO_ELIGIBLE_DEVICE") {
      return undefined;
    }
    throw new TaskExecutorError(
      "WORKER_CANDIDATE_STATE_INVALID",
      "OpenDelegate could not validate the current Worker candidate state. Check Main diagnostics before retrying this Task.",
    );
  }
}

function unavailable(): TaskExecutorError {
  return new TaskExecutorError(
    "WORKER_OFFLINE",
    "No eligible Worker is online for this Work Order.",
    true,
    { retryKind: "resource" },
  );
}

function agentBindingUnavailable(): TaskExecutorError {
  return new TaskExecutorError(
    "AGENT_BINDING_UNAVAILABLE",
    "No eligible Device currently exposes the required Agent Adapter and exact model. Check the Device Agent profile and adapter model catalog, then retry.",
    true,
    { retryKind: "resource" },
  );
}

function cancelled(): TaskExecutorError {
  return new TaskExecutorError("EXECUTION_CANCELLED", "Worker target resolution was cancelled.");
}
