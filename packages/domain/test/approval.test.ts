import assert from "node:assert/strict";
import test from "node:test";

import { Approval, ApprovalId, DomainError, TaskId } from "../src/index.ts";

function createApproval(): Approval {
  return Approval.create({
    id: ApprovalId.from("approval-install-driver"),
    taskId: TaskId.from("task-device-setup"),
    actionCategory: "install-driver",
    actionScope: {
      actionType: "install.driver",
      targetDeviceId: "device-windows-dev",
      resource: "driver:example",
    },
    requestedAtMs: 1_000,
    expiresAtMs: 5_000,
  });
}

test("an Owner approval yields a scoped immutable grant", () => {
  const approval = createApproval();

  const grant = approval.approve({
    decisionId: "decision-owner-001",
    decidedBy: "owner-personal",
    decidedAtMs: 2_000,
    scope: "device",
    scopeTargetId: "device-windows-dev",
  });

  assert.equal(approval.state, "approved");
  assert.deepEqual(grant, {
    approvalId: "approval-install-driver",
    taskId: "task-device-setup",
    actionCategory: "install-driver",
    actionScope: {
      actionType: "install.driver",
      targetDeviceId: "device-windows-dev",
      resource: "driver:example",
    },
    decidedBy: "owner-personal",
    decidedAtMs: 2_000,
    scope: "device",
    scopeTargetId: "device-windows-dev",
  });
  assert.equal(Object.isFrozen(grant), true);
});

test("replaying the same approval decision is idempotent", () => {
  const approval = createApproval();
  const decision = {
    decisionId: "decision-owner-002",
    decidedBy: "owner-personal",
    decidedAtMs: 2_000,
    scope: "once" as const,
  };

  const first = approval.approve(decision);
  const replay = approval.approve(decision);

  assert.equal(replay, first);
  assert.equal(approval.state, "approved");
});

test("a conflicting decision cannot replace a completed approval", () => {
  const approval = createApproval();
  approval.deny({
    decisionId: "decision-owner-deny",
    decidedBy: "owner-personal",
    decidedAtMs: 2_000,
    reason: "Use a user-space alternative.",
  });

  assert.throws(
    () =>
      approval.approve({
        decisionId: "decision-owner-late-allow",
        decidedBy: "owner-personal",
        decidedAtMs: 2_100,
        scope: "once",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_DECISION_CONFLICT");
      return true;
    },
  );
  assert.equal(approval.state, "denied");
});

test("an expired approval cannot be approved later", () => {
  const approval = createApproval();

  approval.expire(5_000);

  assert.equal(approval.state, "expired");
  assert.throws(
    () =>
      approval.approve({
        decisionId: "decision-too-late",
        decidedBy: "owner-personal",
        decidedAtMs: 5_001,
        scope: "once",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_EXPIRED");
      return true;
    },
  );
});

test("expiry before the deadline is rejected without changing state", () => {
  const approval = createApproval();

  assert.throws(
    () => approval.expire(4_999),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_EXPIRY_NOT_REACHED");
      return true;
    },
  );
  assert.equal(approval.state, "pending");
});

test("a pending Approval rejects a decision at or after its deadline", () => {
  const approval = createApproval();

  assert.throws(
    () =>
      approval.approve({
        decisionId: "decision-after-deadline",
        decidedBy: "owner-personal",
        decidedAtMs: 5_000,
        scope: "once",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_EXPIRED");
      return true;
    },
  );
  assert.equal(approval.state, "expired");
});

test("Device and Policy approval scopes require an exact normalized target", () => {
  const approval = createApproval();

  assert.throws(
    () =>
      approval.approve({
        decisionId: "decision-invalid-scope",
        decidedBy: "owner-personal",
        decidedAtMs: 2_000,
        scope: "device",
        scopeTargetId: "",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_SCOPE_INVALID");
      return true;
    },
  );
  assert.equal(approval.state, "pending");
});

test("Approval creation rejects non-finite and reversed deadlines", () => {
  for (const [requestedAtMs, expiresAtMs] of [
    [Number.NaN, 5_000],
    [1_000, Number.POSITIVE_INFINITY],
    [5_000, 5_000],
    [5_001, 5_000],
  ] as const) {
    assert.throws(
      () =>
        Approval.create({
          id: ApprovalId.from(`approval-invalid-clock-${String(requestedAtMs)}`),
          taskId: TaskId.from("task-device-setup"),
          actionCategory: "install-driver",
          actionScope: {
            actionType: "install.driver",
            targetDeviceId: "device-windows-dev",
            resource: "driver:example",
          },
          requestedAtMs,
          expiresAtMs,
        }),
      (error: unknown) => {
        assert.equal(error instanceof DomainError, true);
        assert.equal((error as DomainError).code, "APPROVAL_TIME_INVALID");
        return true;
      },
    );
  }
});

test("Approval decisions reject non-finite clocks and times before the request", () => {
  for (const decidedAtMs of [Number.NaN, Number.NEGATIVE_INFINITY, 999]) {
    const approval = createApproval();

    assert.throws(
      () =>
        approval.approve({
          decisionId: `decision-invalid-clock-${String(decidedAtMs)}`,
          decidedBy: "owner-personal",
          decidedAtMs,
          scope: "once",
        }),
      (error: unknown) => {
        assert.equal(error instanceof DomainError, true);
        assert.equal((error as DomainError).code, "APPROVAL_TIME_INVALID");
        return true;
      },
    );
    assert.equal(approval.state, "pending");
  }
});

test("Approval expiry rejects a non-finite observation clock", () => {
  const approval = createApproval();

  assert.throws(
    () => approval.expire(Number.NaN),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "APPROVAL_TIME_INVALID");
      return true;
    },
  );
  assert.equal(approval.state, "pending");
});
