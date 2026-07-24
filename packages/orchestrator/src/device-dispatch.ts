import {
  SchedulerError,
  isWorkOrderAssignmentEligible,
  scheduleWorkOrder,
  type ScheduleRequest,
  type ScheduleSelection,
} from "@opendelegate/scheduler";

import {
  deepFreeze,
  parseCoordinatorDeviceSelection,
  parseRfc3339Instant,
  parseRunAssignment,
} from "./contract-validation.ts";
import type {
  OpenDelegateDependencies,
  PlannedWorkOrder,
  RunAssignment,
  WorkOrderSchedulingCandidate,
  Worker,
} from "./contracts.ts";
import type { JournaledRunAssignment, OrchestrationJournal } from "./orchestration-journal.ts";
import { OrchestratorError } from "./orchestrator-error.ts";

type DeviceDispatchDependencies = Pick<
  OpenDelegateDependencies,
  "clock" | "coordinator" | "dispatchPolicy" | "runAssignments" | "workers"
>;

export async function resolveDeviceDispatch(input: {
  readonly taskId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly dependencies: DeviceDispatchDependencies;
  readonly journal: OrchestrationJournal;
}): Promise<{
  readonly run: RunAssignment;
  readonly worker: Worker;
}> {
  const durableDispatch =
    (await input.journal.runAssignment(input.taskId, input.workOrder.workOrderId)) ??
    (await createDurableDispatch(input));

  let run: RunAssignment;
  try {
    run = assertRunAssignment(
      durableDispatch.assignment,
      {
        taskId: input.taskId,
        workOrderId: input.workOrder.workOrderId,
        deviceId: durableDispatch.assignment.deviceId,
        workerId: durableDispatch.assignment.workerId,
        routeId: durableDispatch.assignment.routeId,
      },
      input.dependencies,
    );
  } catch (error: unknown) {
    if (error instanceof ExpiredRunAssignmentError) {
      await recordRunFailedIfCurrent(
        input.journal,
        input.taskId,
        input.workOrder.workOrderId,
        durableDispatch.assignment.runId,
      );
    }
    throw error;
  }

  const candidate = createSchedulingCandidates(
    input.taskId,
    input.workOrder,
    input.dependencies,
  ).find((value) => value.deviceId === run.deviceId && value.workerId === run.workerId);
  if (candidate === undefined) {
    await recordRunFailedIfCurrent(
      input.journal,
      input.taskId,
      input.workOrder.workOrderId,
      run.runId,
    );
    throw new OrchestratorError(
      "WORKER_UNAVAILABLE",
      `Durable Run ${run.runId} no longer has its assigned Device-specific Worker.`,
    );
  }

  try {
    assertSelectedCandidateEligible(input.workOrder, candidate, run.routeId);
  } catch (error: unknown) {
    if (error instanceof OrchestratorError && error.code === "SCHEDULING_SELECTION_INVALID") {
      await recordRunFailedIfCurrent(
        input.journal,
        input.taskId,
        input.workOrder.workOrderId,
        run.runId,
      );
    }
    throw error;
  }

  const worker = input.dependencies.workers.find(
    (value) => value.workerId === run.workerId && value.deviceId === run.deviceId,
  );
  if (worker === undefined) {
    await recordRunFailedIfCurrent(
      input.journal,
      input.taskId,
      input.workOrder.workOrderId,
      run.runId,
    );
    throw new OrchestratorError(
      "WORKER_UNAVAILABLE",
      `Run ${run.runId} cannot resolve its assigned Device-specific Worker.`,
    );
  }

  return { run, worker };
}

export async function recordRunFailedIfCurrent(
  journal: OrchestrationJournal,
  taskId: string,
  workOrderId: string,
  runId: string,
): Promise<void> {
  const currentRun = (await journal.runAssignment(taskId, workOrderId))?.assignment;
  if (currentRun?.runId === runId) {
    await journal.recordRunFailed(taskId, workOrderId, runId);
  }
}

async function createDurableDispatch(input: {
  readonly taskId: string;
  readonly workOrder: PlannedWorkOrder;
  readonly dependencies: DeviceDispatchDependencies;
  readonly journal: OrchestrationJournal;
}): Promise<JournaledRunAssignment> {
  const candidates = createSchedulingCandidates(input.taskId, input.workOrder, input.dependencies);
  const request = createScheduleRequest(input.workOrder);
  let selection = selectSchedule(request, candidates);
  if (selection.semanticSelectionCandidates.length > 1) {
    const eligibleDevices = Object.freeze(
      selection.semanticSelectionCandidates.map((candidate) =>
        deepFreeze({
          deviceId: candidate.deviceId,
          roles: candidate.roles,
          verifiedCapabilities: candidate.capabilities
            .filter((capability) => capability.verification === "verified")
            .map((capability) => capability.name),
        }),
      ),
    );
    const semanticSelection = parseCoordinatorDeviceSelection(
      await input.dependencies.coordinator.selectDevice(
        deepFreeze({
          taskId: input.taskId,
          workOrder: input.workOrder,
          eligibleDevices,
        }),
      ),
      {
        taskId: input.taskId,
        workOrderId: input.workOrder.workOrderId,
        eligibleDeviceIds: eligibleDevices.map((candidate) => candidate.deviceId),
      },
    );
    selection = selectSchedule(
      {
        ...request,
        preferredDeviceIds: [semanticSelection.preferredDeviceId],
      },
      candidates,
    );
  }
  const selected = selection.selectedDevice;

  const assignment = assertRunAssignment(
    input.dependencies.runAssignments.nextRun({
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
      deviceId: selected.deviceId,
      workerId: selected.workerId,
      routeId: selection.selectedRoute.routeId,
    }),
    {
      taskId: input.taskId,
      workOrderId: input.workOrder.workOrderId,
      deviceId: selected.deviceId,
      workerId: selected.workerId,
      routeId: selection.selectedRoute.routeId,
    },
    input.dependencies,
  );
  const dispatch = deepFreeze({
    workOrderId: input.workOrder.workOrderId,
    assignment,
  });
  await input.journal.recordRunAssignment(input.taskId, dispatch);
  return dispatch;
}

function createSchedulingCandidates(
  taskId: string,
  workOrder: PlannedWorkOrder,
  dependencies: Pick<DeviceDispatchDependencies, "dispatchPolicy" | "workers">,
): readonly WorkOrderSchedulingCandidate[] {
  const candidates = dependencies.workers.map((worker) => {
    const device = deepFreeze({
      deviceId: worker.deviceId,
      workerId: worker.workerId,
      ...worker.scheduling,
    });
    const executionPolicyDecision = dependencies.dispatchPolicy.evaluate({
      taskId,
      workOrder,
      device,
    });
    if (
      (executionPolicyDecision.outcome !== "allow" &&
        executionPolicyDecision.outcome !== "require-approval" &&
        executionPolicyDecision.outcome !== "deny") ||
      executionPolicyDecision.code.trim() === ""
    ) {
      throw new OrchestratorError(
        "SCHEDULING_SELECTION_INVALID",
        `Dispatch Policy returned an invalid decision for Device ${worker.deviceId}.`,
      );
    }
    const { routes, ...scheduling } = worker.scheduling;
    return deepFreeze({
      deviceId: worker.deviceId,
      workerId: worker.workerId,
      ...scheduling,
      transports: routes,
      executionPolicyDecision,
    });
  });
  const workerIds = new Set(candidates.map((candidate) => candidate.workerId));
  const deviceIds = new Set(candidates.map((candidate) => candidate.deviceId));
  if (workerIds.size !== candidates.length || deviceIds.size !== candidates.length) {
    throw new OrchestratorError(
      "WORKER_UNAVAILABLE",
      "Worker and Device identifiers must be unique across the dispatch fleet.",
    );
  }
  return Object.freeze(candidates);
}

function assertSelectedCandidateEligible(
  workOrder: PlannedWorkOrder,
  candidate: WorkOrderSchedulingCandidate,
  routeId: string,
): void {
  if (!isWorkOrderAssignmentEligible(createScheduleRequest(workOrder), candidate, routeId)) {
    throw new OrchestratorError(
      "SCHEDULING_SELECTION_INVALID",
      `The scheduler selected ineligible Device ${candidate.deviceId} for Work Order ${workOrder.workOrderId}.`,
    );
  }
}

function createScheduleRequest(workOrder: PlannedWorkOrder): ScheduleRequest {
  return {
    workOrderId: workOrder.workOrderId,
    requiredCapabilities: workOrder.requiredCapabilities,
    preferredCapabilities: workOrder.requiredCapabilities,
    preferredDeviceIds: workOrder.schedulingHints.preferredDeviceIds,
    preferredRoles: workOrder.schedulingHints.preferredRoles,
    requiredSecretRefs: workOrder.requiredSecretRefs,
    ...(workOrder.requiredOsFamily === undefined
      ? {}
      : { requiredOsFamily: workOrder.requiredOsFamily }),
    ...(workOrder.workspaceId === undefined ? {} : { workspaceId: workOrder.workspaceId }),
  };
}

function selectSchedule(
  request: ScheduleRequest,
  candidates: readonly WorkOrderSchedulingCandidate[],
): ScheduleSelection {
  try {
    return scheduleWorkOrder(request, candidates);
  } catch (error: unknown) {
    if (error instanceof SchedulerError && error.code === "SCHEDULER_INPUT_INVALID") {
      throw new OrchestratorError(
        "SCHEDULING_SELECTION_INVALID",
        `Scheduling input is invalid for Work Order ${request.workOrderId}.`,
      );
    }
    throw error;
  }
}

class ExpiredRunAssignmentError extends OrchestratorError {
  public constructor(workOrderId: string) {
    super(
      "RUN_ASSIGNMENT_INVALID",
      `Run assignment for Work Order ${workOrderId} is expired and must be retired.`,
    );
    this.name = "ExpiredRunAssignmentError";
  }
}

function assertRunAssignment(
  value: RunAssignment,
  target: Pick<RunAssignment, "taskId" | "workOrderId" | "deviceId" | "workerId" | "routeId">,
  dependencies: Pick<DeviceDispatchDependencies, "clock">,
): RunAssignment {
  const run = parseRunAssignment(value);
  if (
    run.taskId !== target.taskId ||
    run.workOrderId !== target.workOrderId ||
    run.deviceId !== target.deviceId ||
    run.workerId !== target.workerId ||
    run.routeId !== target.routeId
  ) {
    throw new OrchestratorError(
      "RUN_ASSIGNMENT_INVALID",
      `Run assignment for Work Order ${target.workOrderId} is invalid or incorrectly scoped.`,
    );
  }
  const now = parseRfc3339Instant(dependencies.clock.now(), "orchestration clock").epochMs;
  const expiresAt = parseRfc3339Instant(run.expiresAt, "expiresAt").epochMs;
  if (expiresAt <= now) {
    throw new ExpiredRunAssignmentError(target.workOrderId);
  }
  return run;
}
