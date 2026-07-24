import assert from "node:assert/strict";
import test from "node:test";

import { DomainError, Run, RunId, TaskId, WorkOrderId } from "../src/index.ts";

function createRun(): Run {
  return Run.create({
    id: RunId.from("run-001"),
    taskId: TaskId.from("task-001"),
    workOrderId: WorkOrderId.from("work-order-001"),
  });
}

function dispatchAndClaim(run: Run, workerId: string, fencingToken: number) {
  const leaseId = `lease-${String(fencingToken)}`;
  run.dispatch({
    workerId,
    idempotencyKey: `dispatch-${String(fencingToken)}`,
    leaseId,
    fencingToken,
    dispatchedAtMs: 1_000,
    expiresAtMs: 5_000,
  });
  run.claim({
    workerId,
    leaseId,
    fencingToken,
    claimedAtMs: 2_000,
  });
  return {
    workerId,
    leaseId,
    fencingToken,
    observedAtMs: 2_500,
  };
}

test("a claimed Run can start and succeed only under its current Worker fence", () => {
  const run = createRun();
  const claim = dispatchAndClaim(run, "worker-mac", 4);

  run.start(claim);
  run.succeed(claim);

  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.claimSnapshot, {
    workerId: "worker-mac",
    leaseId: "lease-4",
    fencingToken: 4,
    claimedAtMs: 2_000,
    expiresAtMs: 5_000,
  });
});

test("a stale Run fencing token cannot report completion", () => {
  const run = createRun();
  const claim = dispatchAndClaim(run, "worker-linux", 8);
  run.start(claim);

  assert.throws(
    () =>
      run.succeed({
        workerId: "worker-linux",
        leaseId: claim.leaseId,
        fencingToken: 7,
        observedAtMs: 3_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_FENCE_STALE");
      return true;
    },
  );
  assert.equal(run.state, "running");
});

test("a different Worker cannot use another Worker's Run claim", () => {
  const run = createRun();
  dispatchAndClaim(run, "worker-windows", 2);

  assert.throws(
    () =>
      run.start({
        workerId: "worker-linux",
        leaseId: "lease-2",
        fencingToken: 2,
        observedAtMs: 2_500,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_WORKER_MISMATCH");
      return true;
    },
  );
  assert.equal(run.state, "claimed");
});

test("cancellation is idempotent and prevents a late Worker start", () => {
  const run = createRun();
  dispatchAndClaim(run, "worker-mac", 3);

  run.cancel("owner-requested");
  run.cancel("duplicate-delivery");

  assert.equal(run.state, "cancelled");
  assert.equal(run.cancellationReason, "owner-requested");
  assert.throws(
    () =>
      run.start({
        workerId: "worker-mac",
        leaseId: "lease-3",
        fencingToken: 3,
        observedAtMs: 2_500,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_TRANSITION_INVALID");
      return true;
    },
  );
});

test("a Run records an approval wait without relinquishing its claim", () => {
  const run = createRun();
  const claim = dispatchAndClaim(run, "worker-windows", 12);
  run.start(claim);

  run.waitForApproval(claim, "approval-install-package");
  assert.equal(run.state, "waiting-for-approval");
  assert.equal(run.pendingApprovalId, "approval-install-package");

  run.resumeAfterApproval({
    approvalId: "approval-install-package",
    workerId: "worker-windows",
    leaseId: claim.leaseId,
    fencingToken: 12,
    observedAtMs: 3_000,
  });
  assert.equal(run.state, "running");
  assert.equal(run.pendingApprovalId, undefined);
});

test("a Run exposes the canonical dispatch, blocked, retryable failure lifecycle", () => {
  const run = createRun();
  const claim = {
    workerId: "worker-linux",
    leaseId: "lease-run-001",
    fencingToken: 21,
    observedAtMs: 2_500,
  };

  assert.equal(run.state, "created");
  run.dispatch({
    workerId: "worker-linux",
    idempotencyKey: "dispatch-run-001",
    leaseId: "lease-run-001",
    fencingToken: 21,
    dispatchedAtMs: 1_000,
    expiresAtMs: 5_000,
  });
  assert.equal(run.state, "dispatched");
  run.claim({
    ...claim,
    leaseId: "lease-run-001",
    claimedAtMs: 2_000,
  });
  run.start(claim);
  run.block(claim, "waiting for package manager lock");
  assert.equal(run.state, "blocked");
  assert.equal(run.blockedReason, "waiting for package manager lock");
  run.resume(claim);
  run.fail(claim, "tool exited with status 1");

  assert.equal(run.state, "failed");
  assert.equal(run.failureReason, "tool exited with status 1");
  assert.deepEqual(run.dispatchSnapshot, {
    workerId: "worker-linux",
    idempotencyKey: "dispatch-run-001",
    leaseId: "lease-run-001",
    fencingToken: 21,
    dispatchedAtMs: 1_000,
    expiresAtMs: 5_000,
  });
  assert.equal(Object.isFrozen(run.dispatchSnapshot), true);
});

test("a lost Run is terminal and rejects a late Worker completion", () => {
  const run = createRun();
  const claim = dispatchAndClaim(run, "worker-mac", 31);
  run.start(claim);
  run.markLost("claim lease expired");

  assert.equal(run.state, "lost");
  assert.equal(run.lostReason, "claim lease expired");
  assert.throws(
    () => run.succeed(claim),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_TRANSITION_INVALID");
      return true;
    },
  );
});

test("a created Run can enter the queued state before deterministic dispatch", () => {
  const run = createRun();

  run.queue();
  run.queue();

  assert.equal(run.state, "queued");
});

test("a Run cannot be claimed before a leased dispatch or with a stale assignment", () => {
  const run = createRun();

  assert.throws(
    () =>
      run.claim({
        workerId: "worker-linux",
        leaseId: "lease-unissued",
        fencingToken: 1,
        claimedAtMs: 2_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_TRANSITION_INVALID");
      return true;
    },
  );

  run.dispatch({
    workerId: "worker-linux",
    idempotencyKey: "dispatch-expiring",
    leaseId: "lease-current",
    fencingToken: 9,
    dispatchedAtMs: 1_000,
    expiresAtMs: 2_000,
  });

  assert.throws(
    () =>
      run.claim({
        workerId: "worker-linux",
        leaseId: "lease-current",
        fencingToken: 9,
        claimedAtMs: 2_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_LEASE_EXPIRED");
      return true;
    },
  );
  assert.equal(run.state, "dispatched");
});

test("a dispatch idempotency key cannot be reused with a different lease", () => {
  const run = createRun();
  const dispatch = {
    workerId: "worker-linux",
    idempotencyKey: "dispatch-stable",
    leaseId: "lease-1",
    fencingToken: 1,
    dispatchedAtMs: 1_000,
    expiresAtMs: 5_000,
  } as const;

  run.dispatch(dispatch);
  run.dispatch(dispatch);

  assert.throws(
    () =>
      run.dispatch({
        ...dispatch,
        leaseId: "lease-2",
        fencingToken: 2,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_DISPATCH_CONFLICT");
      return true;
    },
  );
});

test("a duplicate Run claim still validates its observation time", () => {
  const run = createRun();
  dispatchAndClaim(run, "worker-linux", 14);

  assert.throws(
    () =>
      run.claim({
        workerId: "worker-linux",
        leaseId: "lease-14",
        fencingToken: 14,
        claimedAtMs: Number.NaN,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_ASSIGNMENT_INVALID");
      return true;
    },
  );
});

test("dispatch and claim delivery remain idempotent after the Run has progressed", () => {
  const run = createRun();
  const dispatch = {
    workerId: "worker-linux",
    idempotencyKey: "dispatch-progressed",
    leaseId: "lease-progressed",
    fencingToken: 18,
    dispatchedAtMs: 1_000,
    expiresAtMs: 5_000,
  } as const;
  const claim = {
    workerId: "worker-linux",
    leaseId: "lease-progressed",
    fencingToken: 18,
    claimedAtMs: 2_000,
  } as const;

  run.dispatch(dispatch);
  run.claim(claim);
  run.start({
    workerId: claim.workerId,
    leaseId: claim.leaseId,
    fencingToken: claim.fencingToken,
    observedAtMs: 2_500,
  });

  run.dispatch(dispatch);
  run.claim(claim);

  assert.equal(run.state, "running");
});

test("a claimed Run lease is enforced at every Worker lifecycle mutation", () => {
  const run = createRun();
  const claim = dispatchAndClaim(run, "worker-linux", 19);

  assert.throws(
    () =>
      run.start({
        ...claim,
        observedAtMs: 5_000,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_LEASE_EXPIRED");
      return true;
    },
  );
  assert.equal(run.state, "claimed");

  run.start(claim);
  assert.throws(
    () =>
      run.succeed({
        ...claim,
        observedAtMs: 5_001,
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "RUN_LEASE_EXPIRED");
      return true;
    },
  );
  assert.equal(run.state, "running");
});
