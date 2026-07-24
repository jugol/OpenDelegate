import type { EventDraft } from "@opendelegate/event-store";

import type { SimulatorIdSource } from "./contracts.ts";

export function createCanonicalJourneyPlan(ids: SimulatorIdSource): readonly EventDraft[] {
  const taskId = ids.taskId();
  const clarificationId = ids.clarificationId();
  const researchWorkOrderId = ids.workOrderId("research");
  const reportWorkOrderId = ids.workOrderId("report");
  const researchRunId = ids.runId("research");
  const reportRunId = ids.runId("report");
  const artifactId = ids.artifactId();

  return deepFreeze([
    {
      eventId: ids.eventId("task-intake"),
      type: "task.intake-recorded",
      payload: {
        taskId,
        objective: "Produce a cross-platform readiness report.",
      },
    },
    {
      eventId: ids.eventId("clarification-requested"),
      type: "task.clarification-requested",
      payload: {
        clarificationId,
        prompt: "Which Artifact format should the completed Task present?",
      },
    },
    {
      eventId: ids.eventId("clarification-resolved"),
      type: "task.clarification-resolved",
      payload: {
        clarificationId,
        answer: "A static HTML report.",
      },
    },
    {
      eventId: ids.eventId("research-queued"),
      type: "work-order.queued",
      payload: {
        workOrderId: researchWorkOrderId,
        title: "Collect platform readiness evidence",
        required: true,
      },
    },
    {
      eventId: ids.eventId("report-queued"),
      type: "work-order.queued",
      payload: {
        workOrderId: reportWorkOrderId,
        title: "Assemble the readiness report",
        required: true,
      },
    },
    {
      eventId: ids.eventId("research-dispatched"),
      type: "work-order.dispatched",
      payload: {
        workOrderId: researchWorkOrderId,
        runId: researchRunId,
        deviceId: ids.deviceId("research"),
      },
    },
    {
      eventId: ids.eventId("report-dispatched"),
      type: "work-order.dispatched",
      payload: {
        workOrderId: reportWorkOrderId,
        runId: reportRunId,
        deviceId: ids.deviceId("report"),
      },
    },
    {
      eventId: ids.eventId("research-reported"),
      type: "worker.reported",
      payload: {
        workOrderId: researchWorkOrderId,
        runId: researchRunId,
        report: "macOS, Windows, and Linux readiness evidence collected.",
      },
    },
    {
      eventId: ids.eventId("report-reported"),
      type: "worker.reported",
      payload: {
        workOrderId: reportWorkOrderId,
        runId: reportRunId,
        report: "The static HTML readiness report was assembled.",
      },
    },
    {
      eventId: ids.eventId("synthesis-recorded"),
      type: "task.synthesis-recorded",
      payload: {
        synthesis: "Both Worker reports satisfy the Task Brief and completion criteria.",
      },
    },
    {
      eventId: ids.eventId("review-requested"),
      type: "task.review-requested",
      payload: {},
    },
    {
      eventId: ids.eventId("review-approved"),
      type: "task.review-approved",
      payload: {
        decisionId: ids.reviewDecisionId(),
      },
    },
    {
      eventId: ids.eventId("artifact-presented"),
      type: "artifact.presented",
      payload: {
        artifactId,
        kind: "static-html",
        title: "Cross-platform readiness report",
      },
    },
    {
      eventId: ids.eventId("task-completed"),
      type: "task.completed",
      payload: {
        verifiedWorkOrderIds: [researchWorkOrderId, reportWorkOrderId],
        artifactIds: [artifactId],
      },
    },
  ]);
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
