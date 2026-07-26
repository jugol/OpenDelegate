import {
  scheduleWorkOrder,
  type DeviceCandidate,
  type ScheduleRequest,
} from "@opendelegate/scheduler";
import {
  TaskExecutorError,
  type WorkerDispatchTarget,
  type WorkerDispatchTargetResolver,
} from "@opendelegate/task-service";

export interface WorkerCandidateSource {
  list(): Promise<readonly DeviceCandidate[]>;
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
    let candidates: readonly DeviceCandidate[];
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
    const priorDeviceIds = new Set(input.previousRuns.map((run) => run.deviceId));
    const unusedCandidates = candidates.filter(
      (candidate) => !priorDeviceIds.has(candidate.deviceId),
    );
    const selected =
      priorDeviceIds.size > 0 && unusedCandidates.length > 0
        ? (trySchedule(request, unusedCandidates) ?? trySchedule(request, candidates))
        : trySchedule(request, candidates);
    if (selected === undefined) {
      throw unavailable();
    }
    return Object.freeze({
      deviceId: selected.selectedDevice.deviceId,
      workerId: selected.selectedDevice.workerId,
      routeId: selected.selectedRoute.routeId,
    });
  }
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
  } catch {
    return undefined;
  }
}

function unavailable(): TaskExecutorError {
  return new TaskExecutorError(
    "WORKER_OFFLINE",
    "No eligible Worker is online for this Work Order.",
    true,
  );
}

function cancelled(): TaskExecutorError {
  return new TaskExecutorError("EXECUTION_CANCELLED", "Worker target resolution was cancelled.");
}
