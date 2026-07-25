import assert from "node:assert/strict";
import test from "node:test";

import {
  createActionFingerprint,
  enforceAction,
  evaluateAction,
  InMemoryOnceGrantConsumptionStore,
  type ActionFingerprint,
  type ActionCategory,
  type ActionRequest,
  type GrantScope,
  type OnceGrantConsumption,
  type OnceGrantConsumptionStore,
  type OwnerGrant,
  type PolicyCode,
  type PolicyContext,
} from "../src/index.ts";

const now = Date.parse("2026-07-24T00:00:00.000Z");

const emptyContext: PolicyContext = {
  now,
  grants: [],
};

const defaultActionFingerprint = createActionFingerprint({
  kind: "vpn-route",
  operation: "replace",
  target: {
    cidr: "100.64.0.0/10",
    interface: "opendelegate-private",
  },
  command: {
    executable: "vpnctl",
    arguments: ["route", "replace", "100.64.0.0/10"],
  },
});

type GrantScopeSelector =
  | {
      readonly kind: "once";
      readonly requestId: string;
    }
  | {
      readonly kind: "task";
      readonly taskId: string;
    }
  | {
      readonly kind: "device";
      readonly deviceId: string;
    }
  | {
      readonly kind: "policy";
    };

function ownerGrant(
  grantId: string,
  scope: GrantScopeSelector,
  actionCategory: ActionCategory = "vpn-change",
  actionFingerprint: ActionFingerprint = defaultActionFingerprint,
): OwnerGrant {
  return {
    grantId,
    issuer: "owner",
    actionCategory,
    expiresAt: now + 60_000,
    scope: {
      ...scope,
      actionFingerprint,
    } as GrantScope,
  };
}

function actionRequest<TRequest extends Omit<ActionRequest, "actionFingerprint">>(
  request: TRequest,
  actionFingerprint: ActionFingerprint = defaultActionFingerprint,
): TRequest & { readonly actionFingerprint: ActionFingerprint } {
  return {
    ...request,
    actionFingerprint,
  };
}

const defaultCases: readonly {
  readonly category: ActionCategory;
  readonly outcome: "allow" | "require-approval" | "deny";
  readonly code: PolicyCode;
  readonly explanation: string;
}[] = [
  {
    category: "read-only-observation",
    outcome: "allow",
    code: "POLICY_SAFE_OBSERVATION",
    explanation: "Read-only observation is allowed by default.",
  },
  {
    category: "opendelegate-process-retry",
    outcome: "allow",
    code: "POLICY_OPENDELEGATE_PROCESS_RECOVERY",
    explanation: "Bounded recovery of an OpenDelegate-owned process is allowed by default.",
  },
  {
    category: "opendelegate-process-restart",
    outcome: "allow",
    code: "POLICY_OPENDELEGATE_PROCESS_RECOVERY",
    explanation: "Bounded recovery of an OpenDelegate-owned process is allowed by default.",
  },
  {
    category: "project-dependency-install",
    outcome: "allow",
    code: "POLICY_TRUSTED_PACKAGE_INSTALL",
    explanation: "Installation from an existing trusted package source is allowed by default.",
  },
  {
    category: "configured-official-package-install",
    outcome: "allow",
    code: "POLICY_TRUSTED_PACKAGE_INSTALL",
    explanation: "Installation from an existing trusted package source is allowed by default.",
  },
  {
    category: "computer-use-input",
    outcome: "require-approval",
    code: "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
    explanation: "Computer Use input requires owner approval or an explicit Policy grant.",
  },
  {
    category: "sandbox-boundary-escalation",
    outcome: "require-approval",
    code: "POLICY_SANDBOX_BOUNDARY_APPROVAL_REQUIRED",
    explanation: "Crossing an Agent sandbox boundary requires owner approval.",
  },
  {
    category: "package-repository-addition",
    outcome: "require-approval",
    code: "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
    explanation: "This supply-chain action requires owner approval.",
  },
  {
    category: "remote-installer-script",
    outcome: "require-approval",
    code: "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
    explanation: "This supply-chain action requires owner approval.",
  },
  {
    category: "untrusted-installer",
    outcome: "require-approval",
    code: "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
    explanation: "This supply-chain action requires owner approval.",
  },
  {
    category: "driver-installation",
    outcome: "require-approval",
    code: "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
    explanation: "This supply-chain action requires owner approval.",
  },
  {
    category: "kernel-extension-installation",
    outcome: "require-approval",
    code: "POLICY_SUPPLY_CHAIN_APPROVAL_REQUIRED",
    explanation: "This supply-chain action requires owner approval.",
  },
  {
    category: "os-network-change",
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  },
  {
    category: "vpn-change",
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  },
  {
    category: "firewall-change",
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  },
  {
    category: "policy-relaxation",
    outcome: "require-approval",
    code: "POLICY_RELAXATION_APPROVAL_REQUIRED",
    explanation: "Relaxing executable Policy requires owner approval.",
  },
  {
    category: "secret-export",
    outcome: "deny",
    code: "POLICY_SECRET_EXPORT_DENIED",
    explanation: "Secret values cannot be exported through OpenDelegate.",
  },
  {
    category: "cross-device-knowledge-transfer",
    outcome: "deny",
    code: "POLICY_CROSS_DEVICE_KNOWLEDGE_DENIED",
    explanation: "Device-local Knowledge cannot be transferred to another Device.",
  },
  {
    category: "policy-bypass-attempt",
    outcome: "deny",
    code: "POLICY_BYPASS_ATTEMPT_DENIED",
    explanation: "An action cannot bypass executable Policy.",
  },
];

test("classifies every default automatic and protected action with stable codes", () => {
  for (const expected of defaultCases) {
    const decision = evaluateAction(
      actionRequest({
        requestId: `request-${expected.category}`,
        actionCategory: expected.category,
        taskId: "task-policy-test",
        deviceId: "device-policy-test",
      }),
      emptyContext,
    );

    assert.deepEqual(decision, {
      outcome: expected.outcome,
      code: expected.code,
      explanation: expected.explanation,
    });
    assert.equal(Object.isFrozen(decision), true);
  }
});

test("allows an exact approval-required action through every matching owner grant scope", () => {
  const cases: readonly {
    readonly grant: OwnerGrant;
    readonly request: ActionRequest;
  }[] = [
    {
      grant: ownerGrant("grant-once", {
        kind: "once",
        requestId: "request-vpn-change",
      }),
      request: actionRequest({
        requestId: "request-vpn-change",
        actionCategory: "vpn-change",
        taskId: "task-networking",
        deviceId: "device-main",
      }),
    },
    {
      grant: ownerGrant("grant-task", {
        kind: "task",
        taskId: "task-networking",
      }),
      request: actionRequest({
        requestId: "request-task-vpn-change",
        actionCategory: "vpn-change",
        taskId: "task-networking",
        deviceId: "device-main",
      }),
    },
    {
      grant: ownerGrant("grant-device", {
        kind: "device",
        deviceId: "device-main",
      }),
      request: actionRequest({
        requestId: "request-device-vpn-change",
        actionCategory: "vpn-change",
        taskId: "task-networking",
        deviceId: "device-main",
      }),
    },
    {
      grant: ownerGrant("grant-policy", {
        kind: "policy",
      }),
      request: actionRequest({
        requestId: "request-policy-vpn-change",
        actionCategory: "vpn-change",
        taskId: "task-networking",
        deviceId: "device-main",
      }),
    },
  ];

  for (const item of cases) {
    const context = {
      now,
      grants: [item.grant],
    };
    const decision =
      item.grant.scope.kind === "once"
        ? enforceAction(item.request, context, new InMemoryOnceGrantConsumptionStore())
        : evaluateAction(item.request, context);

    assert.deepEqual(decision, {
      outcome: "allow",
      code: "POLICY_OWNER_GRANT",
      explanation: "An unexpired owner grant exactly authorizes this action category and scope.",
      matchedGrant: item.grant,
    });
    assert.equal(Object.isFrozen(decision), true);
    assert.equal(Object.isFrozen(decision.matchedGrant), true);
    assert.equal(Object.isFrozen(decision.matchedGrant?.scope), true);
  }
});

test("enforcement atomically consumes an exact once grant and rejects its replay", () => {
  const request = actionRequest({
    requestId: "request-computer-input-once",
    actionCategory: "computer-use-input" as const,
    taskId: "task-computer-input",
    deviceId: "device-desktop",
  });
  const grant = ownerGrant(
    "grant-computer-input-once",
    {
      kind: "once",
      requestId: request.requestId,
    },
    "computer-use-input",
  );
  const context = { now, grants: [grant] };
  const consumptions = new InMemoryOnceGrantConsumptionStore();

  assert.deepEqual(evaluateAction(request, context), {
    outcome: "require-approval",
    code: "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
    explanation: "Computer Use input requires owner approval or an explicit Policy grant.",
  });
  assert.equal(enforceAction(request, context, consumptions).outcome, "allow");
  assert.deepEqual(enforceAction(request, context, consumptions), {
    outcome: "require-approval",
    code: "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
    explanation: "Computer Use input requires owner approval or an explicit Policy grant.",
  });
  assert.deepEqual(consumptions.snapshot(), [
    {
      grantId: grant.grantId,
      requestId: request.requestId,
      actionCategory: request.actionCategory,
      actionFingerprint: request.actionFingerprint,
      taskId: request.taskId,
      deviceId: request.deviceId,
      consumedAt: now,
    },
  ]);
});

test("competing enforcement attempts authorize exactly one use of a once grant", async () => {
  const request = actionRequest({
    requestId: "request-computer-input-race",
    actionCategory: "computer-use-input" as const,
    taskId: "task-computer-input-race",
    deviceId: "device-desktop",
  });
  const grant = ownerGrant(
    "grant-computer-input-race",
    { kind: "once", requestId: request.requestId },
    "computer-use-input",
  );
  const context = { now, grants: [grant] };
  const consumptions = new InMemoryOnceGrantConsumptionStore();

  const decisions = await Promise.all(
    Array.from({ length: 16 }, async () => enforceAction(request, context, consumptions)),
  );

  assert.equal(decisions.filter((decision) => decision.outcome === "allow").length, 1);
  assert.equal(decisions.filter((decision) => decision.outcome === "require-approval").length, 15);
  assert.equal(consumptions.snapshot().length, 1);
});

test("restoring consumed once grants keeps them unavailable after a policy-engine restart", () => {
  const request = actionRequest({
    requestId: "request-computer-input-restart",
    actionCategory: "computer-use-input" as const,
    taskId: "task-computer-input-restart",
    deviceId: "device-desktop",
  });
  const grant = ownerGrant(
    "grant-computer-input-restart",
    {
      kind: "once",
      requestId: request.requestId,
    },
    "computer-use-input",
  );
  const context = { now, grants: [grant] };
  const beforeRestart = new InMemoryOnceGrantConsumptionStore();

  assert.equal(enforceAction(request, context, beforeRestart).outcome, "allow");

  const afterRestart = InMemoryOnceGrantConsumptionStore.fromSnapshot(beforeRestart.snapshot());

  assert.deepEqual(enforceAction(request, context, afterRestart), {
    outcome: "require-approval",
    code: "POLICY_COMPUTER_USE_APPROVAL_REQUIRED",
    explanation: "Computer Use input requires owner approval or an explicit Policy grant.",
  });
  assert.deepEqual(afterRestart.snapshot(), beforeRestart.snapshot());
});

test("once-grant enforcement exposes only an immutable exact claim and never consumes a fingerprint mismatch", () => {
  const approvedFingerprint = createActionFingerprint({
    kind: "computer-input",
    operation: "click",
    target: {
      taskId: "task-exact-input",
      deviceId: "device-exact-input",
      runId: "run-exact-input",
      controlId: "submit",
    },
  });
  const changedFingerprint = createActionFingerprint({
    kind: "computer-input",
    operation: "click",
    target: {
      taskId: "task-exact-input",
      deviceId: "device-exact-input",
      runId: "run-exact-input",
      controlId: "cancel",
    },
  });
  const request = actionRequest(
    {
      requestId: "request-exact-computer-input",
      actionCategory: "computer-use-input" as const,
      taskId: "task-exact-input",
      deviceId: "device-exact-input",
    },
    approvedFingerprint,
  );
  const grant = ownerGrant(
    "grant-exact-computer-input",
    { kind: "once", requestId: request.requestId },
    "computer-use-input",
    approvedFingerprint,
  );
  const observed: OnceGrantConsumption[] = [];
  const consumptions: OnceGrantConsumptionStore = {
    tryConsume(consumption) {
      observed.push(consumption);
      return "consumed";
    },
  };

  const mismatch = enforceAction(
    actionRequest(request, changedFingerprint),
    { now, grants: [grant] },
    consumptions,
  );

  assert.equal(mismatch.outcome, "require-approval");
  assert.deepEqual(observed, []);
  assert.equal(enforceAction(request, { now, grants: [grant] }, consumptions).outcome, "allow");
  assert.deepEqual(observed, [
    {
      grantId: grant.grantId,
      requestId: request.requestId,
      actionCategory: request.actionCategory,
      actionFingerprint: approvedFingerprint,
      taskId: request.taskId,
      deviceId: request.deviceId,
      consumedAt: now,
    },
  ]);
  assert.equal(Object.isFrozen(observed[0]), true);
});

test("ignores grants whose action category or scope does not exactly match", () => {
  const decision = evaluateAction(
    actionRequest({
      requestId: "request-vpn-change",
      actionCategory: "vpn-change",
      taskId: "task-networking",
      deviceId: "device-main",
    }),
    {
      now,
      grants: [
        ownerGrant("grant-wrong-request", {
          kind: "once",
          requestId: "request-other",
        }),
        ownerGrant("grant-wrong-task", {
          kind: "task",
          taskId: "task-other",
        }),
        ownerGrant("grant-wrong-device", {
          kind: "device",
          deviceId: "device-other",
        }),
        ownerGrant("grant-wrong-category", { kind: "policy" }, "firewall-change"),
      ],
    },
  );

  assert.deepEqual(decision, {
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  });
});

test("treats a grant as expired at its exact expiration instant", () => {
  const expiredGrant: OwnerGrant = {
    ...ownerGrant("grant-expired", { kind: "policy" }),
    expiresAt: now,
  };

  const decision = evaluateAction(
    actionRequest({
      requestId: "request-expired-grant",
      actionCategory: "vpn-change",
      taskId: "task-networking",
      deviceId: "device-main",
    }),
    {
      now,
      grants: [expiredGrant],
    },
  );

  assert.deepEqual(decision, {
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  });
});

test("never authorizes a grant when the policy clock or grant expiry is non-finite", () => {
  const request = actionRequest({
    requestId: "request-invalid-policy-clock",
    actionCategory: "vpn-change",
    taskId: "task-networking",
    deviceId: "device-main",
  });
  const expected = {
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  };

  for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      evaluateAction(request, {
        now: invalidNow,
        grants: [ownerGrant("grant-invalid-policy-clock", { kind: "policy" })],
      }),
      expected,
    );
  }

  for (const invalidExpiry of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      evaluateAction(request, {
        now,
        grants: [
          {
            ...ownerGrant("grant-invalid-expiry", { kind: "policy" }),
            expiresAt: invalidExpiry,
          },
        ],
      }),
      expected,
    );
  }
});

test("never permits a hard-deny action even with an exact owner policy grant", () => {
  const hardDenials: readonly {
    readonly actionCategory:
      "secret-export" | "cross-device-knowledge-transfer" | "policy-bypass-attempt";
    readonly code: PolicyCode;
  }[] = [
    {
      actionCategory: "secret-export",
      code: "POLICY_SECRET_EXPORT_DENIED",
    },
    {
      actionCategory: "cross-device-knowledge-transfer",
      code: "POLICY_CROSS_DEVICE_KNOWLEDGE_DENIED",
    },
    {
      actionCategory: "policy-bypass-attempt",
      code: "POLICY_BYPASS_ATTEMPT_DENIED",
    },
  ];

  for (const item of hardDenials) {
    const grant = ownerGrant(
      `grant-${item.actionCategory}`,
      { kind: "policy" },
      item.actionCategory,
    );
    const decision = evaluateAction(
      actionRequest({
        requestId: `request-${item.actionCategory}`,
        actionCategory: item.actionCategory,
        taskId: "task-policy-test",
        deviceId: "device-policy-test",
      }),
      {
        now,
        grants: [grant],
      },
    );

    assert.equal(decision.outcome, "deny");
    assert.equal(decision.code, item.code);
    assert.equal("matchedGrant" in decision, false);
  }
});

test("selects the same most-specific grant regardless of grant input order", () => {
  const request = actionRequest({
    requestId: "request-deterministic-grant",
    actionCategory: "vpn-change" as const,
    taskId: "task-networking",
    deviceId: "device-main",
  });
  const grants: readonly OwnerGrant[] = [
    ownerGrant("grant-policy", { kind: "policy" }),
    ownerGrant("grant-once-z", {
      kind: "once",
      requestId: request.requestId,
    }),
    ownerGrant("grant-device", {
      kind: "device",
      deviceId: request.deviceId,
    }),
    ownerGrant("grant-once-a", {
      kind: "once",
      requestId: request.requestId,
    }),
    ownerGrant("grant-task", {
      kind: "task",
      taskId: request.taskId,
    }),
  ];

  const forward = enforceAction(request, { now, grants }, new InMemoryOnceGrantConsumptionStore());
  const reverse = enforceAction(
    request,
    {
      now,
      grants: [...grants].reverse(),
    },
    new InMemoryOnceGrantConsumptionStore(),
  );

  assert.equal(forward.matchedGrant?.grantId, "grant-once-a");
  assert.deepEqual(forward, reverse);
});

test("normalizes equivalent machine-readable action targets into the same fingerprint", () => {
  const first = createActionFingerprint({
    kind: "firewall-rule",
    operation: "add",
    target: {
      direction: "inbound",
      port: 443,
      protocol: "tcp",
    },
    command: {
      executable: "firewallctl",
      arguments: ["allow", "--protocol=tcp", "--port=443"],
    },
  });
  const reordered = createActionFingerprint({
    operation: "add",
    kind: "firewall-rule",
    command: {
      arguments: ["allow", "--protocol=tcp", "--port=443"],
      executable: "firewallctl",
    },
    target: {
      protocol: "tcp",
      port: 443,
      direction: "inbound",
    },
  });
  const widerRule = createActionFingerprint({
    kind: "firewall-rule",
    operation: "add",
    target: {
      direction: "inbound",
      port: "*",
      protocol: "tcp",
    },
    command: {
      executable: "firewallctl",
      arguments: ["allow", "--protocol=tcp", "--port=*"],
    },
  });

  assert.equal(first, reordered);
  assert.notEqual(first, widerRule);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("never widens a scoped approval to a different target or command fingerprint", () => {
  const approvedFingerprint = createActionFingerprint({
    kind: "firewall-rule",
    operation: "add",
    target: {
      direction: "inbound",
      port: 443,
      protocol: "tcp",
    },
    command: {
      executable: "firewallctl",
      arguments: ["allow", "--protocol=tcp", "--port=443"],
    },
  });
  const differentMutationFingerprint = createActionFingerprint({
    kind: "firewall-rule",
    operation: "add",
    target: {
      direction: "inbound",
      port: 22,
      protocol: "tcp",
    },
    command: {
      executable: "firewallctl",
      arguments: ["allow", "--protocol=tcp", "--port=22"],
    },
  });
  const grant = ownerGrant(
    "grant-task-firewall-443",
    {
      kind: "task",
      taskId: "task-networking",
    },
    "firewall-change",
    approvedFingerprint,
  );
  const baseRequest = {
    requestId: "request-firewall-change",
    actionCategory: "firewall-change" as const,
    taskId: "task-networking",
    deviceId: "device-main",
  };

  const exact = evaluateAction(actionRequest(baseRequest, approvedFingerprint), {
    now,
    grants: [grant],
  });
  const changed = evaluateAction(actionRequest(baseRequest, differentMutationFingerprint), {
    now,
    grants: [grant],
  });

  assert.equal(exact.outcome, "allow");
  assert.deepEqual(changed, {
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  });
});

test("human text or a malformed digest cannot define an executable approval scope", () => {
  const malformedFingerprint = "allow the requested firewall work";
  const request = {
    requestId: "request-malformed-fingerprint",
    actionCategory: "firewall-change",
    actionFingerprint: malformedFingerprint,
    taskId: "task-networking",
    deviceId: "device-main",
  } as unknown as ActionRequest;
  const grant = {
    grantId: "grant-malformed-fingerprint",
    issuer: "owner",
    actionCategory: "firewall-change",
    expiresAt: now + 60_000,
    scope: {
      kind: "task",
      taskId: "task-networking",
      actionFingerprint: malformedFingerprint,
    },
  } as unknown as OwnerGrant;

  assert.deepEqual(evaluateAction(request, { now, grants: [grant] }), {
    outcome: "require-approval",
    code: "POLICY_SYSTEM_CONFIGURATION_APPROVAL_REQUIRED",
    explanation: "This system connectivity change requires owner approval.",
  });
});

test("action fingerprinting rejects cycles and accessors without invoking target code", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  assert.throws(
    () =>
      createActionFingerprint({
        kind: "firewall-rule",
        operation: "add",
        target: circular as never,
      }),
    /cycle/,
  );

  let getterCalls = 0;
  const accessorTarget = {};
  Object.defineProperty(accessorTarget, "credential", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });

  assert.throws(
    () =>
      createActionFingerprint({
        kind: "firewall-rule",
        operation: "add",
        target: accessorTarget as never,
      }),
    /data properties/,
  );
  assert.equal(getterCalls, 0);
});
