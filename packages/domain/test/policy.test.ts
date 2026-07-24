import assert from "node:assert/strict";
import test from "node:test";

import { DomainError, Policy, PolicyId } from "../src/index.ts";

test("Policy evaluates normalized action rules deterministically", () => {
  const policy = Policy.create({
    id: PolicyId.from("policy-instance"),
    defaultOutcome: "require-approval",
    rules: [
      {
        id: "rule-observe",
        actionPattern: "observe.*",
        outcome: "allow",
      },
      {
        id: "rule-network-device",
        actionPattern: "network.*",
        targetDeviceId: "device-main",
        outcome: "deny",
      },
    ],
  });

  assert.deepEqual(
    policy.evaluate({
      actionType: "observe.health",
      targetDeviceId: "device-worker",
    }),
    {
      outcome: "allow",
      ruleId: "rule-observe",
    },
  );
  assert.deepEqual(
    policy.evaluate({
      actionType: "network.firewall-change",
      targetDeviceId: "device-main",
    }),
    {
      outcome: "deny",
      ruleId: "rule-network-device",
    },
  );
  assert.deepEqual(
    policy.evaluate({
      actionType: "install.driver",
      targetDeviceId: "device-main",
    }),
    {
      outcome: "require-approval",
    },
  );
  assert.equal(Object.isFrozen(policy.snapshot), true);
  assert.equal(Object.isFrozen(policy.snapshot.rules), true);
  assert.equal(Object.isFrozen(policy.snapshot.rules[0]), true);
});

test("Main may tighten Policy but only the Owner may relax it", () => {
  const policy = Policy.create({
    id: PolicyId.from("policy-device"),
    defaultOutcome: "require-approval",
    rules: [
      {
        id: "rule-network",
        actionPattern: "network.*",
        outcome: "deny",
      },
    ],
  });

  assert.throws(
    () =>
      policy.applyPatch({
        baseRevision: 1,
        authority: { kind: "main-agent", authorityId: "main-agent" },
        upsertRules: [
          {
            id: "rule-network",
            actionPattern: "network.*",
            outcome: "allow",
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "POLICY_RELAXATION_OWNER_REQUIRED");
      return true;
    },
  );

  policy.applyPatch({
    baseRevision: 1,
    authority: { kind: "owner", authorityId: "owner-personal" },
    upsertRules: [
      {
        id: "rule-network",
        actionPattern: "network.*",
        outcome: "allow",
      },
    ],
  });

  assert.equal(policy.snapshot.revision, 2);
  assert.equal(
    policy.evaluate({
      actionType: "network.firewall-change",
      targetDeviceId: "device-main",
    }).outcome,
    "allow",
  );
});

test("Main cannot bypass Owner authority by moving a deny rule without changing its outcome", () => {
  const policy = Policy.create({
    id: PolicyId.from("policy-pattern-bypass"),
    defaultOutcome: "allow",
    rules: [
      {
        id: "rule-network",
        actionPattern: "network.*",
        outcome: "deny",
      },
    ],
  });

  assert.throws(
    () =>
      policy.applyPatch({
        baseRevision: 1,
        authority: { kind: "main-agent", authorityId: "main-agent" },
        upsertRules: [
          {
            id: "rule-network",
            actionPattern: "network.safe-only.*",
            outcome: "deny",
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "POLICY_RELAXATION_OWNER_REQUIRED");
      return true;
    },
  );
  assert.equal(
    policy.evaluate({
      actionType: "network.firewall-change",
      targetDeviceId: "device-main",
    }).outcome,
    "deny",
  );
});

test("Main cannot shadow an Owner deny rule with a new more-specific allow rule", () => {
  const policy = Policy.create({
    id: PolicyId.from("policy-shadow-bypass"),
    defaultOutcome: "allow",
    rules: [
      {
        id: "rule-network",
        actionPattern: "network.*",
        outcome: "deny",
      },
    ],
  });

  assert.throws(
    () =>
      policy.applyPatch({
        baseRevision: 1,
        authority: { kind: "main-agent", authorityId: "main-agent" },
        upsertRules: [
          {
            id: "rule-network-exact",
            actionPattern: "network.firewall-change",
            outcome: "allow",
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, true);
      assert.equal((error as DomainError).code, "POLICY_RELAXATION_OWNER_REQUIRED");
      return true;
    },
  );
  assert.equal(
    policy.evaluate({
      actionType: "network.firewall-change",
      targetDeviceId: "device-main",
    }).outcome,
    "deny",
  );
});

test("equally specific matching rules resolve to the most restrictive outcome", () => {
  const policy = Policy.create({
    id: PolicyId.from("policy-restrictive-tie"),
    defaultOutcome: "allow",
    rules: [
      {
        id: "a-allow",
        actionPattern: "computer-use.type",
        targetDeviceId: "device-main",
        outcome: "allow",
      },
      {
        id: "z-deny",
        actionPattern: "computer-use.type",
        targetDeviceId: "device-main",
        outcome: "deny",
      },
    ],
  });

  assert.deepEqual(
    policy.evaluate({
      actionType: "computer-use.type",
      targetDeviceId: "device-main",
    }),
    {
      outcome: "deny",
      ruleId: "z-deny",
    },
  );
});
