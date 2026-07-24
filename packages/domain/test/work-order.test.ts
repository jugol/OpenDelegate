import assert from "node:assert/strict";
import test from "node:test";

import { DomainError, RunId, TaskId, WorkOrder, WorkOrderId } from "../src/index.ts";

function createDependentWorkOrder(): WorkOrder {
  return WorkOrder.create({
    id: WorkOrderId.from("work-order-render"),
    taskId: TaskId.from("task-report"),
    required: true,
    brief: {
      objective: "Render the approved report.",
      completionCriteria: ["An HTML Artifact is produced."],
      constraints: ["Do not expose the Worker directly."],
      selectedInputIds: ["artifact-research"],
    },
    dependencyIds: [WorkOrderId.from("work-order-research")],
    requiredCapabilities: ["artifact-rendering"],
    schedulingHints: {
      preferredDeviceIds: ["device-main"],
      preferredRoles: ["reporting"],
    },
  });
}

test("a Work Order becomes ready only after all immutable dependencies are satisfied", () => {
  const workOrder = createDependentWorkOrder();

  assert.throws(
    () => workOrder.markReady([]),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORK_ORDER_DEPENDENCIES_UNRESOLVED");
      return true;
    },
  );

  workOrder.markReady([WorkOrderId.from("work-order-research")]);

  assert.equal(workOrder.state, "ready");
  assert.deepEqual(workOrder.snapshot.brief, {
    objective: "Render the approved report.",
    completionCriteria: ["An HTML Artifact is produced."],
    constraints: ["Do not expose the Worker directly."],
    selectedInputIds: ["artifact-research"],
  });
  assert.equal(Object.isFrozen(workOrder.snapshot), true);
  assert.equal(Object.isFrozen(workOrder.snapshot.brief), true);
  assert.equal(Object.isFrozen(workOrder.snapshot.brief.completionCriteria), true);
  assert.equal(Object.isFrozen(workOrder.snapshot.dependencyIds), true);
  assert.equal(Object.isFrozen(workOrder.snapshot.schedulingHints.preferredRoles), true);
});

test("a Work Order tracks each Run attempt and rejects a stale Run report", () => {
  const workOrder = createDependentWorkOrder();
  const firstRunId = RunId.from("run-render-1");
  const retryRunId = RunId.from("run-render-2");
  workOrder.markReady([WorkOrderId.from("work-order-research")]);
  workOrder.dispatch(firstRunId);
  workOrder.start(firstRunId);
  workOrder.fail(firstRunId, "worker disconnected");
  workOrder.retry(retryRunId);
  workOrder.start(retryRunId);

  assert.throws(
    () => workOrder.succeed(firstRunId),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "WORK_ORDER_RUN_MISMATCH");
      return true;
    },
  );

  workOrder.succeed(retryRunId);
  assert.equal(workOrder.state, "succeeded");
  assert.deepEqual(workOrder.snapshot.runIds, ["run-render-1", "run-render-2"]);
  assert.equal(workOrder.snapshot.failureReason, undefined);
});
