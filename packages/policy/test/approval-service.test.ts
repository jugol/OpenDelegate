import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalService,
  ApprovalServiceError,
  InMemoryApprovalRepository,
  exportApprovalRepositorySnapshot,
  importApprovalRepositorySnapshot,
  type ApprovalExecutionContext,
  type ApprovalExecutionPort,
  type RequestApprovalInput,
} from "../src/index.ts";

class RecordingExecutor implements ApprovalExecutionPort {
  readonly calls: ApprovalExecutionContext[] = [];
  readonly operationResults = new Map<string, { readonly revision: number }>();
  failWith: Error | undefined;

  async execute(input: ApprovalExecutionContext): Promise<{ readonly revision: number }> {
    this.calls.push(structuredClone(input));
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const existing = this.operationResults.get(input.operationId);
    if (existing !== undefined) {
      return existing;
    }
    const result = Object.freeze({ revision: 7 });
    this.operationResults.set(input.operationId, result);
    return result;
  }
}

class BlockingExecutor implements ApprovalExecutionPort {
  readonly calls: ApprovalExecutionContext[] = [];
  readonly entered: Promise<void>;
  #resolveEntered: () => void = () => undefined;
  #resolveRelease: () => void = () => undefined;
  readonly #release: Promise<void>;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.#resolveEntered = resolve;
    });
    this.#release = new Promise<void>((resolve) => {
      this.#resolveRelease = resolve;
    });
  }

  async execute(input: ApprovalExecutionContext): Promise<{ readonly revision: number }> {
    this.calls.push(structuredClone(input));
    this.#resolveEntered();
    await this.#release;
    return { revision: 7 };
  }

  release(): void {
    this.#resolveRelease();
  }
}

function fixtureInput(overrides: Partial<RequestApprovalInput> = {}): RequestApprovalInput {
  return {
    idempotencyKey: "configuration-tool-apply-001",
    requestedBy: "owner-personal",
    actionCategory: "policy-relaxation",
    actionType: "configuration.apply",
    targetDeviceId: "device-main",
    resource: "configuration-proposal:proposal-001",
    descriptor: {
      kind: "configuration",
      operation: "apply-proposal",
      target: {
        context: {
          deviceId: "device-main",
          instanceId: "instance-personal",
          mainId: "device-main",
        },
        diff: [
          {
            after: "allow",
            before: "require-approval",
            key: "policy.network-change",
            scope: {
              id: "device-main",
              kind: "device",
            },
          },
        ],
        expectedRevision: 4,
        proposalId: "proposal-001",
      },
    },
    presentation: {
      reason: "Allow automatic network changes on this Device.",
      target: "device-main",
      risk: "high",
      evidence: ["policy.network-change at Device scope"],
    },
    execution: {
      kind: "configuration.apply",
      payload: {
        context: {
          deviceId: "device-main",
          instanceId: "instance-personal",
          mainId: "device-main",
        },
        diff: [
          {
            after: "allow",
            before: "require-approval",
            key: "policy.network-change",
            scope: {
              id: "device-main",
              kind: "device",
            },
          },
        ],
        expectedRevision: 4,
        proposalId: "proposal-001",
      },
    },
    expiresAtMs: 20_000,
    ...overrides,
  };
}

function createHarness(now = 1_000): {
  readonly executor: RecordingExecutor;
  readonly repository: InMemoryApprovalRepository;
  readonly service: ApprovalService;
  setNow(value: number): void;
} {
  let current = now;
  let nextId = 1;
  const executor = new RecordingExecutor();
  const repository = new InMemoryApprovalRepository();
  const service = new ApprovalService({
    repository,
    executor,
    clock: { now: () => current },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  });
  return {
    executor,
    repository,
    service,
    setNow: (value) => {
      current = value;
    },
  };
}

test("a protected action becomes one exact durable pending Approval", async () => {
  const { service } = createHarness();

  const first = await service.request(fixtureInput());
  const replay = await service.request(fixtureInput());

  assert.equal(first.approvalId, "approval-001");
  assert.equal(first.state, "pending");
  assert.match(first.actionFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(replay.approvalId, first.approvalId);
  assert.deepEqual(await service.list({ state: "pending" }), [first]);

  await assert.rejects(
    service.request(
      fixtureInput({
        presentation: {
          reason: "A different action under the same idempotency key.",
          target: "device-main",
          risk: "high",
          evidence: ["different"],
        },
      }),
    ),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
});

test("once approval atomically consumes its exact grant before idempotent execution", async () => {
  const { executor, service } = createHarness();
  const pending = await service.request(fixtureInput());

  const approved = await service.decide({
    approvalId: pending.approvalId,
    idempotencyKey: "owner-decision-001",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve",
      scope: "once",
    },
  });
  const replay = await service.decide({
    approvalId: pending.approvalId,
    idempotencyKey: "owner-decision-001",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve",
      scope: "once",
    },
  });

  assert.equal(approved.state, "approved");
  assert.equal(approved.executionStatus, "succeeded");
  assert.equal(approved.onceGrantConsumedAtMs, 1_000);
  assert.equal(approved.decision?.grant?.scope.kind, "once");
  assert.deepEqual(approved.executionResult, { revision: 7 });
  assert.deepEqual(replay, approved);
  assert.equal(executor.calls.length, 1);
  assert.equal(executor.calls[0]?.grant.scope.kind, "once");
  assert.equal(executor.calls[0]?.onceGrantConsumed, true);
  assert.equal(executor.calls[0]?.operationId, "approval:approval-001:execute");
});

test("concurrent decision replays never start a second executable effect", async () => {
  const repository = new InMemoryApprovalRepository();
  const firstExecutor = new BlockingExecutor();
  const secondExecutor = new RecordingExecutor();
  let nextId = 1;
  const common = {
    repository,
    clock: { now: () => 1_000 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  };
  const firstService = new ApprovalService({
    ...common,
    executor: firstExecutor,
  });
  const secondService = new ApprovalService({
    ...common,
    executor: secondExecutor,
  });
  const pending = await firstService.request(fixtureInput());
  const decision = {
    approvalId: pending.approvalId,
    idempotencyKey: "owner-concurrent-decision",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve" as const,
      scope: "once" as const,
    },
  };

  const first = firstService.decide(decision);
  await firstExecutor.entered;
  const replayWhileRunning = await secondService.decide(decision);

  assert.equal(replayWhileRunning.executionStatus, "running");
  assert.equal(firstExecutor.calls.length, 1);
  assert.equal(secondExecutor.calls.length, 0);

  firstExecutor.release();
  const completed = await first;
  assert.equal(completed.executionStatus, "succeeded");
  assert.equal((await secondService.decide(decision)).executionStatus, "succeeded");
  assert.equal(secondExecutor.calls.length, 0);
});

test("startup reconciliation fences an interrupted protected effect without replay", async () => {
  const repository = new InMemoryApprovalRepository();
  const interruptedExecutor = new BlockingExecutor();
  const restartedExecutor = new RecordingExecutor();
  let nextId = 1;
  const common = {
    repository,
    clock: { now: () => 1_000 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  };
  const firstService = new ApprovalService({
    ...common,
    executor: interruptedExecutor,
  });
  const restartedService = new ApprovalService({
    ...common,
    executor: restartedExecutor,
  });
  const pending = await firstService.request(fixtureInput());
  const decision = {
    approvalId: pending.approvalId,
    idempotencyKey: "owner-interrupted-decision",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve" as const,
      scope: "once" as const,
    },
  };

  const interrupted = firstService.decide(decision);
  await interruptedExecutor.entered;
  assert.equal(await restartedService.reconcileInterruptedExecutions(), 1);
  assert.equal(await restartedService.reconcileInterruptedExecutions(), 0);
  const fenced = await restartedService.decide(decision);

  assert.equal(fenced.executionStatus, "failed");
  assert.equal(fenced.executionErrorCode, "APPROVAL_EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(restartedExecutor.calls.length, 0);
  assert.equal(
    (await restartedService.audit()).filter((event) => event.event === "approval.execution-failed")
      .length,
    1,
  );

  interruptedExecutor.release();
  await assert.rejects(interrupted, ApprovalServiceError);
});

test("a Device grant stays fingerprint-bound without reporting once consumption", async () => {
  const { executor, service } = createHarness();
  const pending = await service.request(fixtureInput());

  const approved = await service.decide({
    approvalId: pending.approvalId,
    idempotencyKey: "owner-device-decision",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve",
      scope: "device",
    },
  });

  assert.equal(approved.decision?.grant?.scope.kind, "device");
  assert.equal(approved.onceGrantConsumedAtMs, undefined);
  assert.equal(executor.calls[0]?.onceGrantConsumed, false);
  assert.equal(executor.calls[0]?.grant.scope.actionFingerprint, pending.actionFingerprint);
});

test("an interrupted executing Approval resumes only the same durable operation", async () => {
  const { executor, repository, service } = createHarness();
  const pending = await service.request(fixtureInput());
  executor.failWith = new Error("temporary executor failure");

  await assert.rejects(
    service.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "owner-decision-resume",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "once",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_EXECUTION_FAILED");
      return true;
    },
  );

  const failed = await service.get(pending.approvalId);
  assert.equal(failed.state, "approved");
  assert.equal(failed.executionStatus, "failed");
  assert.equal(failed.onceGrantConsumedAtMs, 1_000);
  assert.equal(executor.calls.length, 1);

  const restartedExecutor = new RecordingExecutor();
  const restarted = new ApprovalService({
    repository,
    executor: restartedExecutor,
    clock: { now: () => 1_100 },
    idSource: { nextId: () => "unused" },
  });
  const replay = await restarted.decide({
    approvalId: pending.approvalId,
    idempotencyKey: "owner-decision-resume",
    decidedBy: "owner-personal",
    decision: {
      kind: "approve",
      scope: "once",
    },
  });

  assert.equal(replay.executionStatus, "failed");
  assert.equal(restartedExecutor.calls.length, 0);
  await assert.rejects(
    restarted.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "different-owner-decision",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "once",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_DECISION_CONFLICT");
      return true;
    },
  );
});

test("denial is durable and idempotent while conflicting decisions fail closed", async () => {
  const { executor, service } = createHarness();
  const pending = await service.request(fixtureInput());
  const input = {
    approvalId: pending.approvalId,
    idempotencyKey: "owner-denial-001",
    decidedBy: "owner-personal",
    decision: {
      kind: "deny" as const,
      reason: "Keep the protected default.",
    },
  };

  const denied = await service.decide(input);
  const replay = await service.decide(input);

  assert.equal(denied.state, "denied");
  assert.equal(denied.executionStatus, "skipped");
  assert.deepEqual(replay, denied);
  assert.equal(executor.calls.length, 0);

  await assert.rejects(
    service.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "owner-approval-late",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "once",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_DECISION_CONFLICT");
      return true;
    },
  );
});

test("expired requests fail closed and create one expiry audit event", async () => {
  const { service, setNow } = createHarness();
  const pending = await service.request(fixtureInput({ expiresAtMs: 2_000 }));
  setNow(2_000);

  const expired = await service.get(pending.approvalId);
  assert.equal(expired.state, "expired");
  await assert.rejects(
    service.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "owner-too-late",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "once",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_EXPIRED");
      return true;
    },
  );

  const audits = await service.audit();
  assert.equal(audits.filter((event) => event.event === "approval.expired").length, 1);
});

test("a grant that expires between decision and enforcement fails closed", async () => {
  const times = [1_000, 19_999, 20_000, 20_001, 20_002];
  const executor = new RecordingExecutor();
  let nextId = 1;
  const service = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor,
    clock: { now: () => times.shift() ?? 20_002 },
    idSource: { nextId: () => `approval-${String(nextId++).padStart(3, "0")}` },
  });
  const pending = await service.request(fixtureInput());

  await assert.rejects(
    service.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "owner-expiring-decision",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "once",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_EXPIRED");
      return true;
    },
  );

  assert.equal(executor.calls.length, 0);
  const failed = await service.get(pending.approvalId);
  assert.equal(failed.state, "approved");
  assert.equal(failed.executionStatus, "failed");
  assert.equal(failed.executionErrorCode, "APPROVAL_EXPIRED");
  assert.equal(failed.onceGrantConsumedAtMs, 19_999);
});

test("Task grants require a Task and public payloads reject Secret-shaped keys", async () => {
  const { service } = createHarness();
  const pending = await service.request(fixtureInput());

  await assert.rejects(
    service.decide({
      approvalId: pending.approvalId,
      idempotencyKey: "owner-task-scope",
      decidedBy: "owner-personal",
      decision: {
        kind: "approve",
        scope: "task",
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_SCOPE_INVALID");
      return true;
    },
  );

  for (const secretField of [
    "password",
    "ownerPassphrase",
    "apiToken",
    "clientSecret",
    "apiKey",
    "authorization",
    "sessionCookie",
  ]) {
    await assert.rejects(
      service.request(
        fixtureInput({
          idempotencyKey: `secret-rejection-${secretField}`,
          execution: {
            kind: "configuration.apply",
            payload: {
              [secretField]: "must-not-be-stored",
            },
          },
        }),
      ),
      (error: unknown) => {
        assert.equal(error instanceof ApprovalServiceError, true);
        assert.equal((error as ApprovalServiceError).code, "APPROVAL_SECRET_VALUE_REJECTED");
        return true;
      },
    );
  }

  await service.request(
    fixtureInput({
      idempotencyKey: "opaque-secret-reference-is-safe",
      execution: {
        kind: "configuration.apply",
        payload: {
          databaseSecretRef: "secret-ref-database-main",
        },
      },
    }),
  );
});

test("snapshot import rejects impossible Approval state combinations", async () => {
  const { repository, service } = createHarness();
  const pending = await service.request(fixtureInput());
  const snapshot = await repository.read(exportApprovalRepositorySnapshot);
  const corrupted = structuredClone(snapshot);
  const entry = corrupted.requests.find(([approvalId]) => approvalId === pending.approvalId);
  assert.notEqual(entry, undefined);
  if (entry === undefined) {
    return;
  }
  entry[1].state = "approved";
  entry[1].executionStatus = "succeeded";

  assert.throws(
    () => importApprovalRepositorySnapshot(corrupted),
    (error: unknown) => {
      assert.equal(error instanceof ApprovalServiceError, true);
      assert.equal((error as ApprovalServiceError).code, "APPROVAL_DATA_CORRUPT");
      return true;
    },
  );
});
