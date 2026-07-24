import { isDeepStrictEqual } from "node:util";

import type { StoredEvent } from "@opendelegate/event-store";

import {
  SimulatorError,
  type ClarificationProjection,
  type ReviewProjection,
  type SimulatedArtifactProjection,
  type SimulatedWorkOrderProjection,
  type TaskJourneyProjection,
  type TaskState,
} from "./contracts.ts";

interface MutableProjection {
  taskId: string | null;
  state: TaskState | null;
  objective: string | null;
  stateHistory: TaskState[];
  clarification: {
    clarificationId: string;
    prompt: string;
    answer: string | null;
  } | null;
  workOrders: Map<string, MutableWorkOrder>;
  activeWorkOrderCount: number;
  peakParallelWorkOrders: number;
  synthesis: string | null;
  review: ReviewProjection;
  artifacts: SimulatedArtifactProjection[];
  completionCriteriaVerified: boolean;
  appliedEventIds: string[];
}

interface MutableWorkOrder {
  workOrderId: string;
  title: string;
  state: SimulatedWorkOrderProjection["state"];
  runId: string | null;
  deviceId: string | null;
  report: string | null;
  required: boolean;
}

interface SeenEvent {
  readonly type: string;
  readonly payload: unknown;
}

export function projectTaskJourney(events: readonly StoredEvent[]): TaskJourneyProjection {
  const projection = createMutableProjection();
  const seenEvents = new Map<string, SeenEvent>();

  for (const event of events) {
    const seen = seenEvents.get(event.eventId);
    if (seen !== undefined) {
      if (seen.type !== event.type || !isDeepStrictEqual(seen.payload, event.payload)) {
        throw new SimulatorError(
          "SIMULATOR_EVENT_ID_CONFLICT",
          `Event ID ${event.eventId} was delivered with different content.`,
        );
      }
      continue;
    }

    if (projection.state === "completed") {
      invalidOrder(event, "a completed Task cannot accept another journey event");
    }

    applyEvent(projection, event);
    seenEvents.set(event.eventId, {
      type: event.type,
      payload: event.payload,
    });
    projection.appliedEventIds.push(event.eventId);
  }

  return freezeProjection(projection);
}

function createMutableProjection(): MutableProjection {
  return {
    taskId: null,
    state: null,
    objective: null,
    stateHistory: [],
    clarification: null,
    workOrders: new Map(),
    activeWorkOrderCount: 0,
    peakParallelWorkOrders: 0,
    synthesis: null,
    review: { status: "not-requested" },
    artifacts: [],
    completionCriteriaVerified: false,
    appliedEventIds: [],
  };
}

function applyEvent(projection: MutableProjection, event: StoredEvent): void {
  switch (event.type) {
    case "task.intake-recorded": {
      requireOrder(projection.state === null, event, "Task intake must be the first event");
      const payload = payloadRecord(event);
      projection.taskId = stringField(payload, "taskId", event);
      projection.objective = stringField(payload, "objective", event);
      setState(projection, "intake");
      return;
    }

    case "task.clarification-requested": {
      requireOrder(
        projection.state === "intake" && projection.clarification === null,
        event,
        "clarification can only be requested once during intake",
      );
      const payload = payloadRecord(event);
      projection.clarification = {
        clarificationId: stringField(payload, "clarificationId", event),
        prompt: stringField(payload, "prompt", event),
        answer: null,
      };
      setState(projection, "waiting_user");
      return;
    }

    case "task.clarification-resolved": {
      requireOrder(
        projection.state === "waiting_user" &&
          projection.clarification !== null &&
          projection.clarification.answer === null,
        event,
        "clarification resolution requires one pending owner question",
      );
      const payload = payloadRecord(event);
      const clarificationId = stringField(payload, "clarificationId", event);
      requireOrder(
        clarificationId === projection.clarification.clarificationId,
        event,
        "clarification resolution must target the pending question",
      );
      projection.clarification.answer = stringField(payload, "answer", event);
      setState(projection, "intake");
      return;
    }

    case "work-order.queued": {
      requireOrder(
        (projection.state === "intake" || projection.state === "queued") &&
          projection.clarification?.answer !== null &&
          projection.clarification?.answer !== undefined,
        event,
        "Work Orders require resolved intake and must be queued before dispatch",
      );
      const payload = payloadRecord(event);
      const workOrderId = stringField(payload, "workOrderId", event);
      requireOrder(
        !projection.workOrders.has(workOrderId),
        event,
        "a Work Order can only be queued once",
      );
      projection.workOrders.set(workOrderId, {
        workOrderId,
        title: stringField(payload, "title", event),
        state: "queued",
        runId: null,
        deviceId: null,
        report: null,
        required: booleanField(payload, "required", event),
      });
      setState(projection, "queued");
      return;
    }

    case "work-order.dispatched": {
      requireOrder(
        projection.state === "queued" || projection.state === "running",
        event,
        "dispatch requires a queued Task",
      );
      const payload = payloadRecord(event);
      const workOrderId = stringField(payload, "workOrderId", event);
      const workOrder = projection.workOrders.get(workOrderId);
      requireOrder(
        workOrder !== undefined && workOrder.state === "queued",
        event,
        "dispatch requires a matching queued Work Order",
      );
      workOrder.state = "running";
      workOrder.runId = stringField(payload, "runId", event);
      workOrder.deviceId = stringField(payload, "deviceId", event);
      projection.activeWorkOrderCount += 1;
      projection.peakParallelWorkOrders = Math.max(
        projection.peakParallelWorkOrders,
        projection.activeWorkOrderCount,
      );
      setState(projection, "running");
      return;
    }

    case "worker.reported": {
      requireOrder(projection.state === "running", event, "Worker reports require a running Task");
      const payload = payloadRecord(event);
      const workOrderId = stringField(payload, "workOrderId", event);
      const workOrder = projection.workOrders.get(workOrderId);
      requireOrder(
        workOrder !== undefined && workOrder.state === "running",
        event,
        "a Worker report requires its running Work Order",
      );
      requireOrder(
        workOrder.runId === stringField(payload, "runId", event),
        event,
        "a Worker report must match the dispatched Run",
      );
      workOrder.state = "succeeded";
      workOrder.report = stringField(payload, "report", event);
      projection.activeWorkOrderCount -= 1;
      return;
    }

    case "task.synthesis-recorded": {
      requireOrder(
        projection.state === "running" &&
          projection.activeWorkOrderCount === 0 &&
          projection.workOrders.size >= 2 &&
          [...projection.workOrders.values()].every(
            (workOrder) => !workOrder.required || workOrder.state === "succeeded",
          ) &&
          projection.synthesis === null,
        event,
        "synthesis requires every required parallel Work Order report",
      );
      const payload = payloadRecord(event);
      projection.synthesis = stringField(payload, "synthesis", event);
      return;
    }

    case "task.review-requested": {
      requireOrder(
        projection.state === "running" &&
          projection.synthesis !== null &&
          projection.review.status === "not-requested",
        event,
        "review requires completed synthesis",
      );
      payloadRecord(event);
      projection.review = { status: "pending" };
      setState(projection, "review");
      return;
    }

    case "task.review-approved": {
      requireOrder(
        projection.state === "review" && projection.review.status === "pending",
        event,
        "review approval requires a pending review",
      );
      const payload = payloadRecord(event);
      projection.review = {
        status: "approved",
        decisionId: stringField(payload, "decisionId", event),
      };
      return;
    }

    case "artifact.presented": {
      requireOrder(
        projection.state === "review" && projection.review.status === "approved",
        event,
        "Artifact presentation requires approved review",
      );
      const payload = payloadRecord(event);
      const artifactId = stringField(payload, "artifactId", event);
      requireOrder(
        !projection.artifacts.some((artifact) => artifact.artifactId === artifactId),
        event,
        "an Artifact can only be presented once",
      );
      const kind = stringField(payload, "kind", event);
      if (kind !== "static-html") {
        invalidPayload(event, "kind must be static-html");
      }
      projection.artifacts.push({
        artifactId,
        kind,
        title: stringField(payload, "title", event),
        presented: true,
      });
      return;
    }

    case "task.completed": {
      requireOrder(
        projection.state === "review" &&
          projection.review.status === "approved" &&
          projection.synthesis !== null &&
          projection.activeWorkOrderCount === 0 &&
          projection.artifacts.length > 0 &&
          [...projection.workOrders.values()].every(
            (workOrder) => !workOrder.required || workOrder.state === "succeeded",
          ),
        event,
        "completion requires reconciled Work Orders, synthesis, review, and an Artifact",
      );
      const payload = payloadRecord(event);
      const verifiedWorkOrderIds = stringArrayField(payload, "verifiedWorkOrderIds", event);
      const artifactIds = stringArrayField(payload, "artifactIds", event);
      requireOrder(
        sameMembers(verifiedWorkOrderIds, [...projection.workOrders.keys()]) &&
          sameMembers(
            artifactIds,
            projection.artifacts.map((artifact) => artifact.artifactId),
          ),
        event,
        "completion evidence must name every Work Order and presented Artifact",
      );
      projection.completionCriteriaVerified = true;
      setState(projection, "completed");
      return;
    }

    default:
      throw new SimulatorError(
        "SIMULATOR_UNKNOWN_EVENT_TYPE",
        `Unknown Task journey event type ${event.type}.`,
      );
  }
}

function payloadRecord(event: StoredEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    invalidPayload(event, "payload must be an object");
  }
  return event.payload as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string, event: StoredEvent): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    invalidPayload(event, `${field} must be a non-empty string`);
  }
  return value;
}

function booleanField(
  payload: Record<string, unknown>,
  field: string,
  event: StoredEvent,
): boolean {
  const value = payload[field];
  if (typeof value !== "boolean") {
    invalidPayload(event, `${field} must be a boolean`);
  }
  return value;
}

function stringArrayField(
  payload: Record<string, unknown>,
  field: string,
  event: StoredEvent,
): readonly string[] {
  const value = payload[field];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    invalidPayload(event, `${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function setState(projection: MutableProjection, state: TaskState): void {
  if (projection.state !== state) {
    projection.state = state;
    projection.stateHistory.push(state);
  }
}

function requireOrder(
  condition: boolean,
  event: StoredEvent,
  explanation: string,
): asserts condition {
  if (!condition) {
    invalidOrder(event, explanation);
  }
}

function invalidOrder(event: StoredEvent, explanation: string): never {
  throw new SimulatorError(
    "SIMULATOR_INVALID_EVENT_ORDER",
    `Event ${event.type} at stream version ${String(event.streamVersion)} is invalid: ${explanation}.`,
  );
}

function invalidPayload(event: StoredEvent, explanation: string): never {
  throw new SimulatorError(
    "SIMULATOR_INVALID_EVENT_PAYLOAD",
    `Event ${event.type} has an invalid payload: ${explanation}.`,
  );
}

function freezeProjection(projection: MutableProjection): TaskJourneyProjection {
  const clarification: ClarificationProjection | null =
    projection.clarification === null ? null : { ...projection.clarification };

  return deepFreeze({
    taskId: projection.taskId,
    state: projection.state,
    objective: projection.objective,
    stateHistory: [...projection.stateHistory],
    clarification,
    workOrders: [...projection.workOrders.values()].map(
      ({ required: _required, ...workOrder }) => workOrder,
    ),
    activeWorkOrderCount: projection.activeWorkOrderCount,
    peakParallelWorkOrders: projection.peakParallelWorkOrders,
    synthesis: projection.synthesis,
    review: { ...projection.review },
    artifacts: projection.artifacts.map((artifact) => ({ ...artifact })),
    completionCriteriaVerified: projection.completionCriteriaVerified,
    appliedEventIds: [...projection.appliedEventIds],
  });
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}
