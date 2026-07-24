import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSessionId,
  ApprovalId,
  ArtifactId,
  AuditEventId,
  BudgetId,
  CapabilityId,
  DeviceId,
  DomainError,
  InstanceId,
  OwnerId,
  PolicyId,
  RunId,
  TaskId,
  WorkOrderId,
  WorkspaceId,
} from "../src/index.ts";

test("all public identifiers reject blank values with one stable domain error", () => {
  const factories = [
    AgentSessionId.from,
    ApprovalId.from,
    ArtifactId.from,
    AuditEventId.from,
    BudgetId.from,
    CapabilityId.from,
    DeviceId.from,
    InstanceId.from,
    OwnerId.from,
    PolicyId.from,
    RunId.from,
    TaskId.from,
    WorkOrderId.from,
    WorkspaceId.from,
  ];

  for (const from of factories) {
    assert.throws(
      () => from(" \t"),
      (error: unknown) => {
        assert.equal(error instanceof DomainError, true);
        assert.equal((error as DomainError).code, "IDENTIFIER_INVALID");
        return true;
      },
    );
  }
});

test("public identifiers preserve their concrete class and immutable value", () => {
  const identifierTypesAreNominal: TaskId extends RunId ? false : true = true;
  const taskId = TaskId.from("task-001");
  const runId = RunId.from("run-001");

  assert.equal(taskId instanceof TaskId, true);
  assert.equal(runId instanceof RunId, true);
  assert.equal(taskId.value, "task-001");
  assert.equal(runId.value, "run-001");
  assert.equal(Object.isFrozen(taskId), true);
  assert.equal(Object.isFrozen(runId), true);
  assert.equal(identifierTypesAreNominal, true);
});
