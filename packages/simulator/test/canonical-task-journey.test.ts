import assert from "node:assert/strict";
import test from "node:test";

import type { EventClock, EventDraft, StoredEvent } from "@opendelegate/event-store";

import {
  CanonicalTaskJourneySimulator,
  SimulatorError,
  createCanonicalJourneyPlan,
  projectTaskJourney,
  type CanonicalJourneyStep,
  type SimulatorIdSource,
  type TaskJourneyProjection,
} from "../src/index.ts";

class FixedClock implements EventClock {
  public now(): string {
    return "2026-07-24T12:00:00.000Z";
  }
}

const eventIds: Readonly<Record<CanonicalJourneyStep, string>> = {
  "task-intake": "event-01-task-intake",
  "clarification-requested": "event-02-clarification-requested",
  "clarification-resolved": "event-03-clarification-resolved",
  "research-queued": "event-04-research-queued",
  "report-queued": "event-05-report-queued",
  "research-dispatched": "event-06-research-dispatched",
  "report-dispatched": "event-07-report-dispatched",
  "research-reported": "event-08-research-reported",
  "report-reported": "event-09-report-reported",
  "synthesis-recorded": "event-10-synthesis-recorded",
  "review-requested": "event-11-review-requested",
  "review-approved": "event-12-review-approved",
  "artifact-presented": "event-13-artifact-presented",
  "task-completed": "event-14-task-completed",
};

const ids: SimulatorIdSource = {
  taskId: () => "task-phase-1-canonical",
  clarificationId: () => "clarification-output-format",
  workOrderId: (workstream) => `work-order-${workstream}`,
  runId: (workstream) => `run-${workstream}`,
  deviceId: (workstream) =>
    workstream === "research" ? "device-mac-studio" : "device-windows-dev",
  reviewDecisionId: () => "decision-review-001",
  artifactId: () => "artifact-readiness-html",
  eventId: (step) => eventIds[step],
};

const expectedFinalProjection: TaskJourneyProjection = {
  taskId: "task-phase-1-canonical",
  state: "completed",
  objective: "Produce a cross-platform readiness report.",
  stateHistory: ["intake", "waiting_user", "intake", "queued", "running", "review", "completed"],
  clarification: {
    clarificationId: "clarification-output-format",
    prompt: "Which Artifact format should the completed Task present?",
    answer: "A static HTML report.",
  },
  workOrders: [
    {
      workOrderId: "work-order-research",
      title: "Collect platform readiness evidence",
      state: "succeeded",
      runId: "run-research",
      deviceId: "device-mac-studio",
      report: "macOS, Windows, and Linux readiness evidence collected.",
    },
    {
      workOrderId: "work-order-report",
      title: "Assemble the readiness report",
      state: "succeeded",
      runId: "run-report",
      deviceId: "device-windows-dev",
      report: "The static HTML readiness report was assembled.",
    },
  ],
  activeWorkOrderCount: 0,
  peakParallelWorkOrders: 2,
  synthesis: "Both Worker reports satisfy the Task Brief and completion criteria.",
  review: {
    status: "approved",
    decisionId: "decision-review-001",
  },
  artifacts: [
    {
      artifactId: "artifact-readiness-html",
      kind: "static-html",
      title: "Cross-platform readiness report",
      presented: true,
    },
  ],
  completionCriteriaVerified: true,
  appliedEventIds: Object.values(eventIds),
};

function createSimulator(recordedEvents: readonly EventDraft[] = []) {
  return new CanonicalTaskJourneySimulator({
    clock: new FixedClock(),
    ids,
    recordedEvents,
  });
}

function asStoredEvents(events: readonly EventDraft[]): readonly StoredEvent[] {
  return events.map((event, index) => ({
    ...event,
    streamId: ids.taskId(),
    streamVersion: index + 1,
    globalPosition: index + 1,
    occurredAt: "2026-07-24T12:00:00.000Z",
  }));
}

test("records and projects the complete canonical Task journey", () => {
  const simulator = createSimulator();

  const projection = simulator.runToCompletion();

  assert.deepEqual(projection, expectedFinalProjection);
  assert.deepEqual(
    simulator.recordedEvents().map((event) => event.type),
    [
      "task.intake-recorded",
      "task.clarification-requested",
      "task.clarification-resolved",
      "work-order.queued",
      "work-order.queued",
      "work-order.dispatched",
      "work-order.dispatched",
      "worker.reported",
      "worker.reported",
      "task.synthesis-recorded",
      "task.review-requested",
      "task.review-approved",
      "artifact.presented",
      "task.completed",
    ],
  );
});

test("consumes each injected aggregate ID exactly once", () => {
  let taskIdCalls = 0;
  const simulator = new CanonicalTaskJourneySimulator({
    clock: new FixedClock(),
    ids: {
      ...ids,
      taskId: () => {
        taskIdCalls += 1;
        return `task-generated-${String(taskIdCalls)}`;
      },
    },
  });

  const projection = simulator.runToCompletion();

  assert.equal(taskIdCalls, 1);
  assert.equal(projection.taskId, "task-generated-1");
  assert.equal(
    simulator.recordedEvents().every((event) => event.streamId === "task-generated-1"),
    true,
  );
});

test("restarting at every event boundary reaches an identical final projection", async (t) => {
  const baseline = createSimulator();
  const expected = baseline.runToCompletion();
  const recorded = baseline.recordedEvents();

  for (let boundary = 0; boundary <= recorded.length; boundary += 1) {
    await t.test(`restart after ${String(boundary)} recorded events`, () => {
      const restarted = createSimulator(recorded.slice(0, boundary));

      assert.equal(restarted.restore().appliedEventIds.length, boundary);
      assert.deepEqual(restarted.runToCompletion(), expected);
      assert.deepEqual(restarted.recordedEvents(), recorded);
    });
  }
});

test("duplicate journal and projector deliveries are idempotent", () => {
  const baseline = createSimulator();
  const expected = baseline.runToCompletion();
  const recorded = baseline.recordedEvents();
  const duplicate = recorded[6];
  assert.ok(duplicate);

  const restarted = createSimulator([...recorded, duplicate]);
  const deliveredTwice = [...recorded.slice(0, 7), duplicate, ...recorded.slice(7)];

  assert.equal(restarted.recordedEvents().length, recorded.length);
  assert.deepEqual(restarted.runToCompletion(), expected);
  assert.deepEqual(projectTaskJourney(deliveredTwice), expected);
});

test("invalid event ordering fails with a stable simulator error", async (t) => {
  const plan = createCanonicalJourneyPlan(ids);
  const cases: readonly {
    readonly name: string;
    readonly events: readonly EventDraft[];
  }[] = [
    {
      name: "clarification resolution before request",
      events: [plan[0], plan[2]].filter((event) => event !== undefined),
    },
    {
      name: "dispatch before Work Order queue",
      events: [plan[0], plan[1], plan[2], plan[5]].filter((event) => event !== undefined),
    },
    {
      name: "synthesis before Worker reports",
      events: [...plan.slice(0, 7), plan[9]].filter((event) => event !== undefined),
    },
    {
      name: "completion before Artifact presentation",
      events: [...plan.slice(0, 12), plan[13]].filter((event) => event !== undefined),
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      assert.throws(
        () => projectTaskJourney(asStoredEvents(item.events)),
        (error: unknown) =>
          error instanceof SimulatorError && error.code === "SIMULATOR_INVALID_EVENT_ORDER",
      );
    });
  }
});
