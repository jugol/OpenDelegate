import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import { InMemoryApprovalRepository } from "@opendelegate/policy";

import {
  ConfigurationAgentToolBrokerError,
  ConfigurationServiceAgentToolBroker,
} from "../src/agent-configuration-agent.ts";
import { createConfigurationApprovalRuntime } from "../src/configuration-approval.ts";
import { authorizeMainConfigurationMutation } from "../src/configuration-policy.ts";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const CONTEXT = {
  instanceId: "instance_personal",
  mainId: "device_main",
  deviceId: "device_worker",
} as const;

function harness() {
  let sequence = 0;
  const configuration = new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration_${++sequence}`,
    clock: () => new Date(NOW).toISOString(),
  });
  const approvals = createConfigurationApprovalRuntime({
    configuration,
    repository: new InMemoryApprovalRepository(),
    clock: { now: () => NOW },
    idSource: { nextId: () => `approval_${++sequence}` },
  });
  const broker = new ConfigurationServiceAgentToolBroker({
    service: configuration,
    contextForDevice: () => CONTEXT,
    authorizeMutation: authorizeMainConfigurationMutation,
    approvalRequester: approvals.requester,
  });
  return { approvals, broker, configuration };
}

test("a protected Configuration proposal is previewed, approved once, applied, and replayed", async () => {
  const { approvals, broker, configuration } = harness();
  const proposed = await broker.execute({
    operationId: "configuration:propose:artifact",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Require owner authentication for Worker reports.",
      changes: [
        {
          operation: "set",
          key: "artifact.exposure",
          scope: { kind: "device", id: CONTEXT.deviceId },
          value: "authenticated",
        },
      ],
    },
  });
  assert.equal(proposed.tool, "propose");

  let approvalId = "";
  await assert.rejects(
    broker.execute({
      operationId: "configuration:apply:artifact",
      principalId: "owner_personal",
      targetDeviceId: CONTEXT.deviceId,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof ConfigurationAgentToolBrokerError, true);
      assert.equal(
        (error as ConfigurationAgentToolBrokerError).code,
        "CONFIGURATION_TOOL_APPROVAL_REQUIRED",
      );
      approvalId = (error as ConfigurationAgentToolBrokerError).approvalId ?? "";
      assert.match(approvalId, /^approval_/u);
      return true;
    },
  );

  const pending = await approvals.controlPlane.get(approvalId);
  assert.equal(pending.state, "pending");
  assert.equal(pending.action.type, "configuration.apply");
  assert.equal(pending.configuration?.proposalId, proposed.result.proposal.id);
  assert.deepEqual(pending.configuration?.changes, [
    {
      key: "artifact.exposure",
      scope: { kind: "device", id: CONTEXT.deviceId },
      before: { present: false },
      after: { present: true, valueJson: '"authenticated"' },
    },
  ]);
  assert.equal(Object.hasOwn(pending, "execution"), false);
  assert.equal(Object.hasOwn(pending, "actionDescriptor"), false);

  const decision = {
    approvalId,
    principalId: "owner_personal",
    idempotencyKey: "approval:decision:artifact",
    decision: { decision: "approve" as const, scope: "once" as const },
  };
  const approved = await approvals.controlPlane.decide(decision);
  const replay = await approvals.controlPlane.decide(decision);
  assert.equal(approved.state, "approved");
  assert.equal(approved.executionStatus, "succeeded");
  assert.deepEqual(replay, approved);
  assert.equal((await configuration.inspect(CONTEXT))["artifact.exposure"]?.value, "authenticated");

  const originalOperationReplay = await broker.execute({
    operationId: "configuration:apply:artifact",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "apply",
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
  });
  assert.equal(originalOperationReplay.tool, "apply");
  assert.equal(originalOperationReplay.authorization.authority, "owner");
  assert.equal(originalOperationReplay.authorization.decisionId, approvalId);
});

test("denying a protected Configuration proposal never applies it", async () => {
  const { approvals, broker, configuration } = harness();
  const proposed = await broker.execute({
    operationId: "configuration:propose:policy",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Allow automatic network changes.",
      changes: [
        {
          operation: "set",
          key: "policy.network-change",
          scope: { kind: "device", id: CONTEXT.deviceId },
          value: "allow",
        },
      ],
    },
  });
  assert.equal(proposed.tool, "propose");

  let approvalId = "";
  await assert.rejects(
    broker.execute({
      operationId: "configuration:apply:policy",
      principalId: "owner_personal",
      targetDeviceId: CONTEXT.deviceId,
      request: {
        tool: "apply",
        proposalId: proposed.result.proposal.id,
        expectedRevision: 0,
      },
    }),
    (error: unknown) => {
      approvalId = (error as ConfigurationAgentToolBrokerError).approvalId ?? "";
      return error instanceof ConfigurationAgentToolBrokerError;
    },
  );

  const denied = await approvals.controlPlane.decide({
    approvalId,
    principalId: "owner_personal",
    idempotencyKey: "approval:deny:policy",
    decision: {
      decision: "deny",
      reason: "Keep the protected default.",
    },
  });
  assert.equal(denied.state, "denied");
  assert.equal(denied.executionStatus, "skipped");
  assert.equal(
    (await configuration.inspect(CONTEXT))["policy.network-change"]?.value,
    "require-approval",
  );
});

test("automatic Device profile changes remain automatic and create no Approval", async () => {
  const { approvals, broker, configuration } = harness();
  const proposed = await broker.execute({
    operationId: "configuration:propose:role",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Add a verified development Role.",
      changes: [
        {
          operation: "set",
          key: "device.roles",
          scope: { kind: "device", id: CONTEXT.deviceId },
          value: ["development"],
        },
      ],
    },
  });
  assert.equal(proposed.tool, "propose");
  const applied = await broker.execute({
    operationId: "configuration:apply:role",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "apply",
      proposalId: proposed.result.proposal.id,
      expectedRevision: 0,
    },
  });
  assert.equal(applied.tool, "apply");
  assert.equal(applied.authorization.authority, "policy");
  assert.deepEqual((await configuration.inspect(CONTEXT))["device.roles"]?.value, ["development"]);
  assert.deepEqual(await approvals.controlPlane.list(), []);
});
