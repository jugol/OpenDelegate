import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApprovalService,
  InMemoryApprovalRepository,
  createActionFingerprint,
  type ActionCategory,
  type ApprovalGrantScope,
  type OwnerGrant,
} from "@opendelegate/policy";
import { SqlActionAuthorizationRepository } from "@opendelegate/storage-sql";

import {
  MainActionAuthorizationRuntime,
  type MainActionAuthorizationRuntimeOptions,
} from "../src/action-authorization-runtime.ts";

test("approval is required before an exact permit can be durably consumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-action-"));
  const filename = join(root, "actions.sqlite3");
  const now = 10_000;
  let id = 0;
  const runtime = await createRuntime(filename, () => now);
  const approvals = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor: runtime,
    clock: { now: () => now },
    idSource: { nextId: () => `approval-id-${++id}` },
  });
  runtime.attachApprovalService(approvals);
  try {
    const pending = await runtime.authorize(authorizationInput("action-request-1"));
    assert.equal(pending.decision, "require-approval");
    assert.equal((await approvals.list({ state: "pending" })).length, 1);
    assert.deepEqual(await runtime.consume(consumptionInput(pending, "action-request-1")), {
      decision: "deny",
      reasonCode: "AUTHORIZATION_NOT_EXECUTABLE",
    });

    const approval = (await approvals.list({ state: "pending" }))[0]!;
    await approvals.decide({
      approvalId: approval.approvalId,
      idempotencyKey: "owner-decision-1",
      decidedBy: "owner",
      decision: { kind: "approve", scope: "once" },
    });
    const allowed = await runtime.authorize(authorizationInput("action-request-1"));
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.authorizationId, pending.authorizationId);

    const consume = consumptionInput(allowed, "action-request-1");
    assert.deepEqual(await runtime.consume(consume), {
      decision: "consumed",
      reasonCode: "AUTHORIZATION_CONSUMED",
    });
    assert.deepEqual(
      await runtime.consume({
        ...consume,
        requestMessageId: "consume-retry-message",
        idempotencyKey: "consume-retry-idempotency",
      }),
      {
        decision: "consumed",
        reasonCode: "CONSUMPTION_REPLAY",
      },
    );
    assert.deepEqual(
      await runtime.consume({
        ...consume,
        request: {
          ...consume.request,
          actionFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
      {
        decision: "deny",
        reasonCode: "AUTHORIZATION_NOT_EXECUTABLE",
      },
    );
    const actionAudit = await runtime.listAudit();
    assert.equal(actionAudit.length, 1);
    assert.deepEqual(
      {
        ...actionAudit[0],
        auditId: "<bounded>",
        authorizationId: "<bounded>",
      },
      {
        auditId: "<bounded>",
        event: "worker.action.computer-use-input.consumed",
        occurredAtMs: now,
        authorizationId: "<bounded>",
        authorizationRequestId: "action-request-1",
        taskId: "task-1",
        runId: "run-1",
        deviceId: "device-1",
        decision: "allow",
        reasonCode: "POLICY_OWNER_GRANT",
        consumed: true,
      },
    );
    assert.match(actionAudit[0]?.auditId ?? "", /^action-authorization-audit:[a-f0-9]{32}$/u);
    assert.match(actionAudit[0]?.authorizationId ?? "", /^authorization:[a-f0-9]{64}$/u);

    await runtime.close();
    const restarted = await createRuntime(filename, () => now);
    try {
      assert.deepEqual(
        await restarted.consume({
          ...consume,
          requestMessageId: "restart-consume-retry",
          idempotencyKey: "restart-consume-retry",
        }),
        {
          decision: "consumed",
          reasonCode: "CONSUMPTION_REPLAY",
        },
      );
      assert.deepEqual(await restarted.listAudit(), actionAudit);
    } finally {
      await restarted.close();
    }
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("separate runtime connections atomically consume one exact authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-action-race-"));
  const filename = join(root, "actions.sqlite3");
  const overrides: RuntimeOverrides = {
    configuredPolicy: {
      async decide() {
        return "allow";
      },
    },
  };
  const first = await createRuntime(filename, () => 10_000, undefined, overrides);
  const second = await createRuntime(filename, () => 10_000, undefined, overrides);
  try {
    const allowed = await first.authorize(authorizationInput("raced-action-request"));
    assert.equal(allowed.decision, "allow");
    const firstConsumption = consumptionInput(allowed, "raced-action-request");
    const secondConsumption = {
      ...firstConsumption,
      requestMessageId: "consume:raced-action-request:competitor",
      idempotencyKey: "consume:raced-action-request:competitor",
      request: {
        ...firstConsumption.request,
        requestedAtMs: firstConsumption.request.requestedAtMs + 1,
      },
    };
    const outcomes = await Promise.all([
      first.consume(firstConsumption),
      second.consume(secondConsumption),
    ]);
    assert.deepEqual(
      outcomes.map((outcome) => `${outcome.decision}:${outcome.reasonCode}`).sort(),
      ["consumed:AUTHORIZATION_CONSUMED", "deny:AUTHORIZATION_ALREADY_CONSUMED"],
    );

    const winningConsumption =
      outcomes[0]?.reasonCode === "AUTHORIZATION_CONSUMED" ? firstConsumption : secondConsumption;
    assert.deepEqual(await second.consume(winningConsumption), {
      decision: "consumed",
      reasonCode: "CONSUMPTION_REPLAY",
    });
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale concurrent authorization write cannot erase a consumed permit", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-action-monotonic-"));
  let releaseAuthorization: (() => void) | undefined;
  let markAuthorizationEntered: (() => void) | undefined;
  const authorizationEntered = new Promise<void>((resolve) => {
    markAuthorizationEntered = resolve;
  });
  const authorizationRelease = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  let blockNextRunCheck = false;
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000, undefined, {
    runAuthority: {
      async authorizeWorkerActionRun() {
        if (blockNextRunCheck) {
          blockNextRunCheck = false;
          markAuthorizationEntered?.();
          await authorizationRelease;
        }
        return { authorized: true, leaseExpiresAtMs: 20_000 };
      },
    },
    configuredPolicy: {
      async decide() {
        return "allow";
      },
    },
  });
  try {
    const input = authorizationInput("monotonic-action-request");
    const allowed = await runtime.authorize(input);
    blockNextRunCheck = true;
    const staleAuthorization = runtime.authorize({
      ...input,
      requestMessageId: "message:monotonic-action-request:stale",
      idempotencyKey: "idempotency:monotonic-action-request:stale",
    });
    await authorizationEntered;

    const consumption = consumptionInput(allowed, "monotonic-action-request");
    assert.deepEqual(await runtime.consume(consumption), {
      decision: "consumed",
      reasonCode: "AUTHORIZATION_CONSUMED",
    });
    releaseAuthorization?.();
    assert.equal((await staleAuthorization).decision, "allow");

    assert.deepEqual(await runtime.consume(consumption), {
      decision: "consumed",
      reasonCode: "CONSUMPTION_REPLAY",
    });
    assert.deepEqual(
      await runtime.consume({
        ...consumption,
        request: {
          ...consumption.request,
          requestedAtMs: consumption.request.requestedAtMs + 1,
        },
      }),
      {
        decision: "deny",
        reasonCode: "AUTHORIZATION_ALREADY_CONSUMED",
      },
    );
  } finally {
    releaseAuthorization?.();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed or unknown Approval execution cannot leave a consumable authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-action-failed-"));
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000);
  const repository = new InMemoryApprovalRepository();
  let id = 0;
  const approvals = new ApprovalService({
    repository,
    executor: {
      async execute(input) {
        await runtime.execute(input);
        throw new Error("simulated outcome loss after the authorization write");
      },
    },
    clock: { now: () => 10_000 },
    idSource: { nextId: () => `failed-execution-id-${++id}` },
  });
  runtime.attachApprovalService(approvals);
  try {
    const pending = await runtime.authorize(authorizationInput("failed-action-request"));
    const approval = (await approvals.list({ state: "pending" }))[0]!;
    await assert.rejects(
      approvals.decide({
        approvalId: approval.approvalId,
        idempotencyKey: "failed-owner-decision",
        decidedBy: "owner",
        decision: { kind: "approve", scope: "once" },
      }),
      /could not be applied/u,
    );
    assert.equal((await approvals.get(approval.approvalId)).executionStatus, "failed");

    assert.deepEqual(await runtime.authorize(authorizationInput("failed-action-request")), {
      authorizationId: pending.authorizationId,
      decision: "deny",
      reasonCode: "APPROVAL_EXECUTION_FAILED",
    });
    assert.deepEqual(await runtime.consume(consumptionInput(pending, "failed-action-request")), {
      decision: "deny",
      reasonCode: "AUTHORIZATION_NOT_EXECUTABLE",
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Task, Device, and Policy grants authorize matching later request identities", async () => {
  for (const scope of [
    "task",
    "device",
    "policy",
  ] as const satisfies readonly ApprovalGrantScope[]) {
    const root = await mkdtemp(join(tmpdir(), `opendelegate-main-${scope}-`));
    let id = 0;
    let now = 10_000;
    const runtime = await createRuntime(join(root, "actions.sqlite3"), () => now, 5_000);
    const approvals = new ApprovalService({
      repository: new InMemoryApprovalRepository(),
      executor: runtime,
      clock: { now: () => now },
      idSource: { nextId: () => `${scope}-approval-${++id}` },
    });
    runtime.attachApprovalService(approvals);
    try {
      assert.equal(
        (await runtime.authorize(authorizationInput(`${scope}-request-1`))).decision,
        "require-approval",
      );
      const approval = (await approvals.list({ state: "pending" }))[0]!;
      await approvals.decide({
        approvalId: approval.approvalId,
        idempotencyKey: `${scope}-decision`,
        decidedBy: "owner",
        decision: { kind: "approve", scope },
      });
      assert.equal(
        (await runtime.authorize(authorizationInput(`${scope}-request-1`))).decision,
        "allow",
      );
      const later =
        scope === "task"
          ? authorizationInput(`${scope}-request-2`, {
              deviceId: "device-2",
              workerId: "worker-2",
              routeId: "route-2",
              runId: "run-2",
              leaseId: "run-lease-2",
              fencingToken: 10,
              leaseExpiresAtMs: 30_000,
            })
          : scope === "device"
            ? authorizationInput(`${scope}-request-2`, {
                taskId: "task-2",
                workOrderId: "work-order-2",
                runId: "run-2",
                leaseId: "run-lease-2",
                fencingToken: 10,
                leaseExpiresAtMs: 30_000,
              })
            : authorizationInput(`${scope}-request-2`, {
                taskId: "task-2",
                workOrderId: "work-order-2",
                deviceId: "device-2",
                workerId: "worker-2",
                routeId: "route-2",
                runId: "run-2",
                leaseId: "run-lease-2",
                fencingToken: 10,
                leaseExpiresAtMs: 30_000,
              });
      now = 11_000;
      assert.equal(
        (await runtime.authorize(later)).decision,
        "allow",
        `${scope} grant should be reused for a matching action fingerprint`,
      );
      assert.equal((await approvals.list()).length, 1);

      now = 15_000;
      assert.equal(
        (
          await runtime.authorize(
            authorizationInput(`${scope}-request-after-expiry`, {
              taskId: later.request.taskId,
              workOrderId: later.request.workOrderId,
              deviceId: later.request.deviceId,
              workerId: later.request.workerId,
              routeId: later.request.routeId,
              runId: "run-3",
              leaseId: "run-lease-3",
              fencingToken: 11,
              leaseExpiresAtMs: 40_000,
            }),
          )
        ).decision,
        "require-approval",
        `${scope} grant must stop at its exact TTL`,
      );
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Run revocation and authorization-request confusion fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-revoked-"));
  let current = true;
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000, undefined, {
    runAuthority: {
      async authorizeWorkerActionRun(_deviceId, scope) {
        return scope.leaseId === "run-lease-1"
          ? { authorized: current, leaseExpiresAtMs: 20_000 }
          : { authorized: false };
      },
    },
  });
  try {
    current = false;
    assert.equal((await runtime.authorize(authorizationInput("revoked-request"))).decision, "deny");
    current = true;
    await assert.rejects(
      runtime.authorize({
        ...authorizationInput("revoked-request"),
        request: {
          ...authorizationInput("revoked-request").request,
          actionType: "type-text",
        },
      }),
      /reused for different input/u,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("configured durable Policy grants use normalized action identity and exact TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-configured-policy-"));
  let now = 10_000;
  const policyFingerprint = createActionFingerprint({
    kind: "worker-action",
    operation: "click",
    target: {
      actionCategory: "computer-use-input",
      exactActionFingerprint: `sha256:${"a".repeat(64)}`,
      actionDescriptor: {
        kind: "click",
        controlId: "option-beta",
      },
    },
  });
  const grant: OwnerGrant = {
    grantId: "configured-policy-1",
    issuer: "owner",
    actionCategory: "computer-use-input",
    expiresAt: 15_000,
    scope: {
      kind: "policy",
      actionFingerprint: policyFingerprint,
    },
  };
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => now, undefined, {
    runAuthority: {
      async authorizeWorkerActionRun(_deviceId, scope) {
        return { authorized: true, leaseExpiresAtMs: scope.leaseId === "run-lease-1" ? 20_000 : 0 };
      },
    },
    configuredGrants: async () => [grant],
  });
  try {
    assert.equal(
      (await runtime.authorize(authorizationInput("configured-policy-request"))).decision,
      "allow",
    );
    assert.equal(
      (
        await runtime.authorize(
          authorizationInput("configured-policy-different-exact-action", {
            actionFingerprint: `sha256:${"b".repeat(64)}`,
          }),
        )
      ).decision,
      "require-approval",
    );
    now = 15_000;
    assert.equal(
      (await runtime.authorize(authorizationInput("configured-policy-expired"))).decision,
      "require-approval",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("current configured action Policy is enforced at authorization and consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-current-policy-"));
  let configuredDecision: "allow" | "require-approval" | "deny" | undefined = "allow";
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000, undefined, {
    runAuthority: {
      async authorizeWorkerActionRun() {
        return { authorized: true, leaseExpiresAtMs: 20_000 };
      },
    },
    configuredPolicy: {
      async decide() {
        return configuredDecision;
      },
    },
  });
  try {
    const officialInput = authorizationInput("configured-official-allow", {
      actionCategory: "configured-official-package-install",
      actionType: "package.install",
    });
    const allowed = await runtime.authorize(officialInput);
    assert.deepEqual(allowed, {
      authorizationId: allowed.authorizationId,
      decision: "allow",
      reasonCode: "CONFIGURATION_POLICY_ALLOWED",
    });

    configuredDecision = "deny";
    assert.deepEqual(
      await runtime.consume(
        consumptionInput(allowed, "configured-official-allow", {
          actionCategory: "configured-official-package-install",
          actionType: "package.install",
        }),
      ),
      {
        decision: "deny",
        reasonCode: "CONFIGURATION_POLICY_DENIED",
      },
    );

    configuredDecision = "allow";
    const approvalChange = await runtime.authorize(
      authorizationInput("configured-official-becomes-approval", {
        actionCategory: "configured-official-package-install",
        actionType: "package.install",
      }),
    );
    configuredDecision = "require-approval";
    assert.deepEqual(
      await runtime.consume(
        consumptionInput(approvalChange, "configured-official-becomes-approval", {
          actionCategory: "configured-official-package-install",
          actionType: "package.install",
        }),
      ),
      {
        decision: "deny",
        reasonCode: "AUTHORIZATION_NOT_EXECUTABLE",
      },
    );

    configuredDecision = "require-approval";
    assert.equal(
      (
        await runtime.authorize(
          authorizationInput("configured-official-approval", {
            actionCategory: "configured-official-package-install",
            actionType: "package.install",
          }),
        )
      ).decision,
      "require-approval",
    );

    configuredDecision = "allow";
    const networkAllowed = await runtime.authorize(
      authorizationInput("configured-network-allow", {
        actionCategory: "vpn-change",
        actionType: "vpn.configure",
      }),
    );
    assert.equal(networkAllowed.decision, "allow");
    assert.deepEqual(
      await runtime.consume(
        consumptionInput(networkAllowed, "configured-network-allow", {
          actionCategory: "vpn-change",
          actionType: "vpn.configure",
        }),
      ),
      {
        decision: "consumed",
        reasonCode: "AUTHORIZATION_CONSUMED",
      },
    );

    configuredDecision = "deny";
    assert.equal(
      (
        await runtime.authorize(
          authorizationInput("configured-network-allow", {
            actionCategory: "vpn-change",
            actionType: "vpn.configure",
          }),
        )
      ).decision,
      "deny",
    );
    configuredDecision = "allow";
    const replayAllowed = await runtime.authorize(
      authorizationInput("configured-network-allow", {
        actionCategory: "vpn-change",
        actionType: "vpn.configure",
      }),
    );
    assert.deepEqual(
      await runtime.consume(
        consumptionInput(replayAllowed, "configured-network-allow", {
          actionCategory: "vpn-change",
          actionType: "vpn.configure",
        }),
      ),
      {
        decision: "consumed",
        reasonCode: "CONSUMPTION_REPLAY",
      },
    );

    configuredDecision = undefined;
    assert.equal(
      (await runtime.authorize(authorizationInput("unconfigured-computer-use"))).decision,
      "require-approval",
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a current configured allow supersedes an older pending approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-policy-now-allow-"));
  let configuredDecision: "allow" | "require-approval" = "require-approval";
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000, undefined, {
    configuredPolicy: {
      async decide() {
        return configuredDecision;
      },
    },
  });
  const approvals = new ApprovalService({
    repository: new InMemoryApprovalRepository(),
    executor: runtime,
    clock: { now: () => 10_000 },
    idSource: { nextId: () => "configured-now-allow-approval" },
  });
  runtime.attachApprovalService(approvals);
  const input = authorizationInput("configured-now-allow", {
    actionCategory: "configured-official-package-install",
    actionType: "package.install",
  });
  try {
    assert.equal((await runtime.authorize(input)).decision, "require-approval");
    assert.equal((await approvals.list({ state: "pending" })).length, 1);

    configuredDecision = "allow";
    const allowed = await runtime.authorize(input);
    assert.equal(allowed.decision, "allow");
    assert.deepEqual(
      await runtime.consume(
        consumptionInput(allowed, "configured-now-allow", {
          actionCategory: "configured-official-package-install",
          actionType: "package.install",
        }),
      ),
      {
        decision: "consumed",
        reasonCode: "AUTHORIZATION_CONSUMED",
      },
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable configured action Policy fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-main-policy-unavailable-"));
  const runtime = await createRuntime(join(root, "actions.sqlite3"), () => 10_000, undefined, {
    runAuthority: {
      async authorizeWorkerActionRun() {
        return { authorized: true, leaseExpiresAtMs: 20_000 };
      },
    },
    configuredPolicy: {
      async decide() {
        throw new Error("configuration storage unavailable");
      },
    },
  });
  try {
    const denied = await runtime.authorize(
      authorizationInput("configured-policy-unavailable", {
        actionCategory: "os-network-change",
        actionType: "network.configure",
      }),
    );
    assert.equal(denied.decision, "deny");
    assert.equal(denied.reasonCode, "CONFIGURATION_POLICY_UNAVAILABLE");
    assert.match(denied.authorizationId, /^authorization:/u);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

type RuntimeOverrides = Partial<
  Pick<
    MainActionAuthorizationRuntimeOptions,
    "approvalExpirationMs" | "configuredGrants" | "configuredPolicy" | "runAuthority"
  >
>;

async function createRuntime(
  filename: string,
  now: () => number,
  approvalExpirationMs?: number,
  overrides: RuntimeOverrides = {},
) {
  const repository = await SqlActionAuthorizationRepository.openSqlite({
    busyTimeoutMs: 100,
    filename,
    migrationMode: "apply",
  });
  try {
    return new MainActionAuthorizationRuntime({
      repository,
      runAuthority: {
        async authorizeWorkerActionRun(_deviceId, scope) {
          const leaseExpiresAtMs =
            scope.leaseId === "run-lease-1"
              ? 20_000
              : scope.leaseId === "run-lease-2"
                ? 30_000
                : scope.leaseId === "run-lease-3"
                  ? 40_000
                  : 0;
          return { authorized: leaseExpiresAtMs > 0, leaseExpiresAtMs };
        },
      },
      clock: { now },
      ...(approvalExpirationMs === undefined ? {} : { approvalExpirationMs }),
      ...overrides,
    });
  } catch (error) {
    await repository.close();
    throw error;
  }
}

function authorizationInput(
  authorizationRequestId: string,
  overrides: Partial<{
    readonly actionCategory: ActionCategory;
    readonly actionType: string;
    readonly taskId: string;
    readonly workOrderId: string;
    readonly deviceId: string;
    readonly workerId: string;
    readonly routeId: string;
    readonly runId: string;
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly leaseExpiresAtMs: number;
    readonly actionFingerprint: `sha256:${string}`;
  }> = {},
) {
  const deviceId = overrides.deviceId ?? "device-1";
  return {
    authenticatedDeviceId: deviceId,
    requestMessageId: `message:${authorizationRequestId}`,
    idempotencyKey: `idempotency:${authorizationRequestId}`,
    request: {
      authorizationRequestId,
      actionCategory: overrides.actionCategory ?? "computer-use-input",
      actionType: overrides.actionType ?? "click",
      actionFingerprint: overrides.actionFingerprint ?? (`sha256:${"a".repeat(64)}` as const),
      actionDescriptor: {
        kind: "click",
        controlId: "option-beta",
      },
      requestedAtMs: 10_000,
      taskId: overrides.taskId ?? "task-1",
      workOrderId: overrides.workOrderId ?? "work-order-1",
      deviceId,
      workerId: overrides.workerId ?? "worker-1",
      routeId: overrides.routeId ?? "route-1",
      runId: overrides.runId ?? "run-1",
      leaseId: overrides.leaseId ?? "run-lease-1",
      fencingToken: overrides.fencingToken ?? 9,
      leaseExpiresAtMs: overrides.leaseExpiresAtMs ?? 20_000,
    },
  };
}

function consumptionInput(
  decision: { readonly authorizationId: string },
  authorizationRequestId: string,
  overrides: Parameters<typeof authorizationInput>[1] = {},
) {
  const authorized = authorizationInput(authorizationRequestId, overrides);
  return {
    authenticatedDeviceId: authorized.authenticatedDeviceId,
    requestMessageId: `consume:${authorizationRequestId}`,
    idempotencyKey: `consume:${authorizationRequestId}`,
    request: {
      authorizationRequestId,
      authorizationId: decision.authorizationId,
      actionCategory: authorized.request.actionCategory,
      actionFingerprint: authorized.request.actionFingerprint,
      requestedAtMs: 10_001,
      taskId: authorized.request.taskId,
      workOrderId: authorized.request.workOrderId,
      deviceId: authorized.request.deviceId,
      workerId: authorized.request.workerId,
      routeId: authorized.request.routeId,
      runId: authorized.request.runId,
      leaseId: authorized.request.leaseId,
      fencingToken: authorized.request.fencingToken,
      leaseExpiresAtMs: authorized.request.leaseExpiresAtMs,
    },
  };
}
