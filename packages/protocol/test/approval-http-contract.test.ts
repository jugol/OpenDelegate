import assert from "node:assert/strict";
import test from "node:test";

import Value from "typebox/value";

import {
  ApprovalDecisionRequestSchema,
  ApprovalDetailSchema,
  ApprovalListResponseSchema,
} from "../src/index.ts";

const approval = {
  approvalId: "approval_001",
  state: "pending",
  executionStatus: "waiting",
  requestedAt: "2026-07-25T00:00:00.000Z",
  expiresAt: "2026-07-26T00:00:00.000Z",
  action: {
    category: "policy-relaxation",
    type: "configuration.apply",
    fingerprint: `sha256:${"a".repeat(64)}`,
    targetDeviceId: "device_main",
    resource: "configuration-proposal:proposal_001",
  },
  reason: "Allow automatic network changes.",
  target: "device_main",
  risk: "high",
  evidence: ["policy.network-change at Device scope"],
  configuration: {
    proposalId: "proposal_001",
    baseRevision: 4,
    changes: [
      {
        key: "policy.network-change",
        scope: { kind: "device", id: "device_main" },
        before: { present: true, valueJson: '"require-approval"' },
        after: { present: true, valueJson: '"allow"' },
      },
    ],
  },
};

test("Approval HTTP projection exposes exact review data without executable or Secret payloads", () => {
  assert.equal(Value.Check(ApprovalDetailSchema, approval), true);
  assert.equal(
    Value.Check(ApprovalListResponseSchema, {
      approvals: [approval],
    }),
    true,
  );
  for (const leaked of [
    { secretValue: "hidden" },
    { execution: { kind: "configuration.apply", payload: {} } },
    { actionDescriptor: { kind: "configuration", operation: "apply", target: {} } },
    { idempotencyKey: "internal-key" },
  ]) {
    assert.equal(Value.Check(ApprovalDetailSchema, { ...approval, ...leaked }), false);
  }
});

test("Approval decisions are a strict approve-or-deny union", () => {
  assert.equal(
    Value.Check(ApprovalDecisionRequestSchema, {
      decision: "approve",
      scope: "once",
    }),
    true,
  );
  assert.equal(
    Value.Check(ApprovalDecisionRequestSchema, {
      decision: "deny",
      reason: "Keep the protected default.",
    }),
    true,
  );
  assert.equal(
    Value.Check(ApprovalDecisionRequestSchema, {
      decision: "approve",
      scope: "once",
      reason: "ambiguous",
    }),
    false,
  );
  assert.equal(
    Value.Check(ApprovalDecisionRequestSchema, {
      decision: "deny",
    }),
    false,
  );
  assert.equal(
    Value.Check(ApprovalDecisionRequestSchema, {
      decision: "approve",
      scope: "instance",
    }),
    false,
  );
});
