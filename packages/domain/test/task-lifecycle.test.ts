import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactId, DomainError, RunId, Task, TaskId, WorkOrderId } from "../src/index.ts";

function recordSucceeded(task: Task, id: WorkOrderId, fencingToken = 1): void {
  task.recordWorkOrderSucceeded({
    id,
    runId: RunId.from(`run-for-${id.value}`),
    fencingToken,
  });
}

test("a newly created Task is in intake and keeps an immutable identity", () => {
  const taskId = TaskId.from("task-001");

  const task = Task.create({ id: taskId });

  assert.equal(task.id, taskId);
  assert.equal(task.id.value, "task-001");
  assert.equal(task.state, "intake");
  assert.equal(Object.isFrozen(task.id), true);
});

test("a Task becomes running after required work is dispatched", () => {
  const task = Task.create({ id: TaskId.from("task-002") });

  task.dispatchWorkOrder({
    id: WorkOrderId.from("work-order-001"),
    required: true,
  });

  assert.equal(task.state, "running");
});

test("a Task completes after two required Work Orders succeed and one Artifact result is recorded", () => {
  const firstWorkOrderId = WorkOrderId.from("work-order-004");
  const secondWorkOrderId = WorkOrderId.from("work-order-005");
  const artifactId = ArtifactId.from("artifact-001");
  const task = Task.create({
    id: TaskId.from("task-005"),
    completionRequirements: { minimumArtifactResults: 1 },
  });
  task.dispatchWorkOrder({ id: firstWorkOrderId, required: true });
  task.dispatchWorkOrder({ id: secondWorkOrderId, required: true });
  recordSucceeded(task, firstWorkOrderId);
  recordSucceeded(task, secondWorkOrderId);

  task.recordArtifactResult(artifactId);
  task.complete();

  assert.equal(task.state, "completed");
  assert.equal(artifactId.value, "artifact-001");
  assert.equal(Object.isFrozen(artifactId), true);
});

test("a Task cannot complete while required Work Orders remain unresolved", () => {
  const task = Task.create({ id: TaskId.from("task-003") });
  task.dispatchWorkOrder({
    id: WorkOrderId.from("work-order-002"),
    required: true,
  });

  assert.throws(
    () => task.complete(),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_REQUIRED_WORK_UNRESOLVED");
      return true;
    },
  );
  assert.equal(task.state, "running");
});

test("a Task cannot complete before its required Artifact result is recorded", () => {
  const workOrderId = WorkOrderId.from("work-order-003");
  const task = Task.create({
    id: TaskId.from("task-004"),
    completionRequirements: { minimumArtifactResults: 1 },
  });
  task.dispatchWorkOrder({ id: workOrderId, required: true });
  recordSucceeded(task, workOrderId);

  assert.throws(
    () => task.complete(),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_ARTIFACT_RESULTS_MISSING");
      return true;
    },
  );
  assert.equal(task.state, "running");
});

test("a completed Task rejects further dispatch with a stable domain error", () => {
  const task = Task.create({ id: TaskId.from("task-006") });
  task.dispatchWorkOrder({
    id: WorkOrderId.from("work-order-006"),
    required: false,
  });
  task.complete();

  assert.throws(
    () =>
      task.dispatchWorkOrder({
        id: WorkOrderId.from("work-order-007"),
        required: true,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_TRANSITION_INVALID");
      return true;
    },
  );
  assert.equal(task.state, "completed");
});

test("a Task rejects duplicate Work Order identities instead of resetting their state", () => {
  const workOrderId = WorkOrderId.from("work-order-duplicate");
  const task = Task.create({ id: TaskId.from("task-duplicate-work") });
  task.dispatchWorkOrder({ id: workOrderId, required: true });
  recordSucceeded(task, workOrderId);

  assert.throws(
    () => task.dispatchWorkOrder({ id: workOrderId, required: true }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORK_ORDER_DUPLICATED");
      return true;
    },
  );

  task.complete();
  assert.equal(task.state, "completed");
});

test("duplicate Worker success delivery is idempotent", () => {
  const workOrderId = WorkOrderId.from("work-order-replayed");
  const task = Task.create({ id: TaskId.from("task-replayed-report") });
  task.dispatchWorkOrder({ id: workOrderId, required: true });

  recordSucceeded(task, workOrderId);
  recordSucceeded(task, workOrderId);
  task.complete();

  assert.equal(task.state, "completed");
});

test("a completed Task accepts an exact result replay but rejects new late mutations", () => {
  const workOrderId = WorkOrderId.from("work-order-terminal");
  const task = Task.create({ id: TaskId.from("task-terminal") });
  task.dispatchWorkOrder({ id: workOrderId, required: true });
  recordSucceeded(task, workOrderId);
  task.complete();

  recordSucceeded(task, workOrderId);

  for (const mutate of [
    () =>
      task.recordWorkOrderFailed({
        id: workOrderId,
        runId: RunId.from("run-late"),
        fencingToken: 2,
      }),
    () => task.recordArtifactResult(ArtifactId.from("artifact-late")),
  ]) {
    assert.throws(mutate, (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_TRANSITION_INVALID");
      return true;
    });
  }
});

test("a Task defaults to Auto mode and keeps an immutable compact Brief", () => {
  const task = Task.create({
    id: TaskId.from("task-brief"),
    brief: {
      objective: "Prepare the release report.",
      completionCriteria: ["The report is reviewable."],
      constraints: ["Keep generated HTML isolated."],
      knownInputIds: ["artifact-build-log"],
      decisions: ["Use authenticated exposure."],
      openQuestions: [],
    },
  });

  assert.equal(task.mode, "auto");
  assert.deepEqual(task.snapshot.brief, {
    objective: "Prepare the release report.",
    completionCriteria: ["The report is reviewable."],
    constraints: ["Keep generated HTML isolated."],
    knownInputIds: ["artifact-build-log"],
    decisions: ["Use authenticated exposure."],
    openQuestions: [],
  });
  assert.equal(Object.isFrozen(task.snapshot), true);
  assert.equal(Object.isFrozen(task.snapshot.brief), true);
  assert.equal(Object.isFrozen(task.snapshot.brief.completionCriteria), true);
});

test("canonical Task transitions support waits, review, reopen, pause, resume, and archive", () => {
  const task = Task.create({ id: TaskId.from("task-canonical-states") });

  task.transitionTo("queued");
  task.transitionTo("running");
  task.transitionTo("waiting_user");
  task.transitionTo("running");
  task.transitionTo("review");
  task.complete();
  task.archive();

  assert.equal(task.state, "completed");
  assert.equal(task.snapshot.archived, true);

  task.reopen();
  task.pause();
  assert.equal(task.state, "paused");
  task.resume();
  assert.equal(task.state, "queued");
  assert.equal(task.snapshot.archived, false);
});

test("a terminal Task cannot manufacture a new state without explicit reopen", () => {
  const task = Task.create({ id: TaskId.from("task-terminal-transition") });
  task.transitionTo("failed");

  assert.throws(
    () => task.transitionTo("running"),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_TRANSITION_INVALID");
      return true;
    },
  );
  assert.equal(task.state, "failed");

  task.reopen();
  assert.equal(task.state, "queued");
});

test("Task completion requires every Brief completion criterion to be explicitly verified", () => {
  const task = Task.create({
    id: TaskId.from("task-criteria"),
    brief: {
      objective: "Prepare a verified report.",
      completionCriteria: ["Tests pass", "Artifact opens"],
      constraints: [],
      knownInputIds: [],
      decisions: [],
      openQuestions: [],
    },
  });
  task.verifyCompletionCriterion("Tests pass");

  assert.throws(
    () => task.complete(),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "TASK_COMPLETION_CRITERIA_UNVERIFIED");
      return true;
    },
  );

  task.verifyCompletionCriterion("Artifact opens");
  task.complete();
  assert.equal(task.state, "completed");
});

test("a stale Work Order result cannot replace the result from a newer fenced Run", () => {
  const workOrderId = WorkOrderId.from("work-order-fenced-result");
  const task = Task.create({ id: TaskId.from("task-fenced-result") });
  task.dispatchWorkOrder({ id: workOrderId, required: true });

  task.recordWorkOrderSucceeded({
    id: workOrderId,
    runId: RunId.from("run-new"),
    fencingToken: 12,
  });

  assert.throws(
    () =>
      task.recordWorkOrderFailed({
        id: workOrderId,
        runId: RunId.from("run-old"),
        fencingToken: 11,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORK_ORDER_RESULT_STALE");
      return true;
    },
  );
  assert.equal(task.snapshot.workOrders[0]?.state, "succeeded");
});

test("a Work Order result replay is exact and conflicting use of one fence is rejected", () => {
  const workOrderId = WorkOrderId.from("work-order-result-conflict");
  const runId = RunId.from("run-result-conflict");
  const task = Task.create({ id: TaskId.from("task-result-conflict") });
  task.dispatchWorkOrder({ id: workOrderId, required: true });
  const result = { id: workOrderId, runId, fencingToken: 4 } as const;

  task.recordWorkOrderSucceeded(result);
  task.recordWorkOrderSucceeded(result);

  assert.throws(
    () => task.recordWorkOrderFailed(result),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORK_ORDER_RESULT_CONFLICT");
      return true;
    },
  );
});

test("Task completion requirements reject non-integer and negative Artifact minima", () => {
  for (const minimumArtifactResults of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    assert.throws(
      () =>
        Task.create({
          id: TaskId.from(`task-invalid-artifact-minimum-${String(minimumArtifactResults)}`),
          completionRequirements: { minimumArtifactResults },
        }),
      (error: unknown) => {
        assert.equal(error instanceof DomainError, true);
        assert.equal((error as DomainError).code, "TASK_COMPLETION_REQUIREMENTS_INVALID");
        return true;
      },
    );
  }
});
