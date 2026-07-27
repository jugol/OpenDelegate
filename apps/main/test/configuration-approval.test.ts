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
import {
  createConfigurationApprovalRuntime,
  type ConfigurationApplyLifecycle,
} from "../src/configuration-approval.ts";
import { DiscordBindingConfigurationLifecycle } from "../src/discord-binding-configuration-lifecycle.ts";
import {
  DiscordBindingController,
  type DiscordBindingRuntime,
} from "../src/discord-binding-controller.ts";
import { authorizeMainConfigurationMutation } from "../src/configuration-policy.ts";
import {
  MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION,
  type MainDiscordBindingConfiguration,
} from "../src/discord-configuration.ts";

const NOW = Date.parse("2026-07-25T00:00:00.000Z");
const CONTEXT = {
  instanceId: "instance_personal",
  mainId: "device_main",
  deviceId: "device_worker",
} as const;
const FIRST_DISCORD_BINDING = discordBinding("discord-token-primary", "22222222222222222");
const SECOND_DISCORD_BINDING = discordBinding("discord-token-replacement", "33333333333333333");

function harness(lifecycle?: ConfigurationApplyLifecycle) {
  let sequence = 0;
  const configuration = new ConfigurationService({
    definitions: [
      ...STANDARD_CONFIGURATION_DEFINITIONS,
      MAIN_DISCORD_BINDING_CONFIGURATION_DEFINITION,
    ],
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration_${++sequence}`,
    clock: () => new Date(NOW).toISOString(),
  });
  const approvals = createConfigurationApprovalRuntime({
    configuration,
    repository: new InMemoryApprovalRepository(),
    clock: { now: () => NOW },
    idSource: { nextId: () => `approval_${++sequence}` },
    ...(lifecycle === undefined ? {} : { lifecycle }),
  });
  const broker = new ConfigurationServiceAgentToolBroker({
    service: configuration,
    contextForDevice: () => CONTEXT,
    authorizeMutation: authorizeMainConfigurationMutation,
    approvalRequester: approvals.requester,
  });
  return { approvals, broker, configuration };
}

test("approved Configuration execution commits its prepared runtime lifecycle", async () => {
  const events: string[] = [];
  const { approvals, broker } = harness({
    async prepare(input) {
      events.push(`prepare:${input.diff[0]?.key}`);
      return {
        async commit() {
          events.push("commit");
        },
        async rollback() {
          events.push("rollback");
        },
      };
    },
  });
  const proposed = await broker.execute({
    operationId: "configuration:propose:lifecycle",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Exercise the approved runtime lifecycle.",
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
      operationId: "configuration:apply:lifecycle",
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

  const approved = await approvals.controlPlane.decide({
    approvalId,
    principalId: "owner_personal",
    idempotencyKey: "approval:decision:lifecycle",
    decision: { decision: "approve", scope: "once" },
  });
  assert.equal(approved.executionStatus, "succeeded");
  assert.deepEqual(events, ["prepare:artifact.exposure", "commit"]);
});

test("a prepared runtime commit failure compensates durable Configuration and runtime state", async () => {
  const events: string[] = [];
  let runtimeExposure: string | undefined;
  const { approvals, broker, configuration } = harness({
    async prepare(input) {
      const before = input.diff[0]?.before as string | undefined;
      runtimeExposure = input.diff[0]?.after as string;
      events.push(`prepare:${runtimeExposure}`);
      return {
        async commit() {
          events.push("commit");
          throw new Error("fixture runtime commit failed");
        },
        async rollback() {
          runtimeExposure = before;
          events.push(`rollback:${before}`);
        },
      };
    },
  });
  const proposed = await broker.execute({
    operationId: "configuration:propose:commit-failure",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Exercise post-apply compensation.",
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
      operationId: "configuration:apply:commit-failure",
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

  await assert.rejects(
    approvals.controlPlane.decide({
      approvalId,
      principalId: "owner_personal",
      idempotencyKey: "approval:decision:commit-failure",
      decision: { decision: "approve", scope: "once" },
    }),
    /approved action could not be applied/u,
  );
  assert.deepEqual(events, ["prepare:authenticated", "commit", "rollback:undefined"]);
  assert.equal(runtimeExposure, undefined);
  assert.equal(
    (await configuration.inspect(CONTEXT))["artifact.exposure"]?.value,
    "private-network",
  );
  assert.equal(await configuration.getRevision(), 2);
});

test("a stale approved Configuration mutation rolls back its prepared runtime lifecycle", async () => {
  const events: string[] = [];
  const { approvals, broker } = harness({
    async prepare() {
      events.push("prepare");
      return {
        async commit() {
          events.push("commit");
        },
        async rollback() {
          events.push("rollback");
        },
      };
    },
  });
  const proposed = await broker.execute({
    operationId: "configuration:propose:stale-lifecycle",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "This proposal will become stale.",
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
      operationId: "configuration:apply:stale-lifecycle",
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
  const automatic = await broker.execute({
    operationId: "configuration:propose:stale-lifecycle-profile",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 0,
      reason: "Advance the revision.",
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
  assert.equal(automatic.tool, "propose");
  await broker.execute({
    operationId: "configuration:apply:stale-lifecycle-profile",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "apply",
      proposalId: automatic.result.proposal.id,
      expectedRevision: 0,
    },
  });

  await assert.rejects(
    approvals.controlPlane.decide({
      approvalId,
      principalId: "owner_personal",
      idempotencyKey: "approval:decision:stale-lifecycle",
      decision: { decision: "approve", scope: "once" },
    }),
    /approved action could not be applied/u,
  );
  const failed = await approvals.controlPlane.get(approvalId);
  assert.equal(failed.executionStatus, "failed");
  assert.deepEqual(events, ["prepare", "rollback"]);
});

test("a stale approved Discord commit restores the live binding and leaves durable state unchanged", async () => {
  const controller = new DiscordBindingController<ReadyDiscordRuntime>({
    credentialCapability: async () => ({
      purpose: "discord-bot-token",
      available: true,
    }),
    createRuntime: async (_configuration, onStatusChange) =>
      new ReadyDiscordRuntime(onStatusChange),
  });
  await controller.start(FIRST_DISCORD_BINDING);
  const lifecycle = new DiscordBindingConfigurationLifecycle(CONTEXT.mainId);
  lifecycle.bind(controller);
  const { approvals, broker, configuration } = harness(lifecycle);
  const initial = await configuration.propose({
    actor: "opendelegate-init",
    reason: "Seed the initial Discord binding.",
    changes: [
      {
        operation: "set",
        key: "discord.binding",
        scope: { kind: "main", id: CONTEXT.mainId },
        value: FIRST_DISCORD_BINDING,
      },
    ],
  });
  await configuration.apply({
    proposalId: initial.id,
    expectedRevision: 0,
    actor: "opendelegate-init",
  });

  const replacement = await broker.execute({
    operationId: "configuration:propose:stale-discord",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 1,
      reason: "Replace the Discord binding.",
      changes: [
        {
          operation: "set",
          key: "discord.binding",
          scope: { kind: "main", id: CONTEXT.mainId },
          value: SECOND_DISCORD_BINDING,
        },
      ],
    },
  });
  assert.equal(replacement.tool, "propose");
  let approvalId = "";
  await assert.rejects(
    broker.execute({
      operationId: "configuration:apply:stale-discord",
      principalId: "owner_personal",
      targetDeviceId: CONTEXT.deviceId,
      request: {
        tool: "apply",
        proposalId: replacement.result.proposal.id,
        expectedRevision: 1,
      },
    }),
    (error: unknown) => {
      approvalId = (error as ConfigurationAgentToolBrokerError).approvalId ?? "";
      return error instanceof ConfigurationAgentToolBrokerError;
    },
  );
  const pending = await approvals.controlPlane.get(approvalId);
  assert.equal(pending.risk, "high");
  assert.equal(pending.action.targetDeviceId, CONTEXT.mainId);
  assert.equal(pending.target, CONTEXT.mainId);

  const revisionAdvance = await broker.execute({
    operationId: "configuration:propose:stale-discord-revision",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "propose",
      expectedRevision: 1,
      reason: "Advance the Configuration revision.",
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
  assert.equal(revisionAdvance.tool, "propose");
  await broker.execute({
    operationId: "configuration:apply:stale-discord-revision",
    principalId: "owner_personal",
    targetDeviceId: CONTEXT.deviceId,
    request: {
      tool: "apply",
      proposalId: revisionAdvance.result.proposal.id,
      expectedRevision: 1,
    },
  });

  await assert.rejects(
    approvals.controlPlane.decide({
      approvalId,
      principalId: "owner_personal",
      idempotencyKey: "approval:decision:stale-discord",
      decision: { decision: "approve", scope: "once" },
    }),
    /approved action could not be applied/u,
  );
  assert.deepEqual(controller.configuration, FIRST_DISCORD_BINDING);
  assert.deepEqual(
    (await configuration.inspect(CONTEXT))["discord.binding"]?.value,
    FIRST_DISCORD_BINDING,
  );
  await controller.close();
});

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

class ReadyDiscordRuntime implements DiscordBindingRuntime {
  readonly #onStatusChange: (status: DiscordBindingRuntime["status"]) => void;
  #status: DiscordBindingRuntime["status"] = {
    status: "unavailable",
    code: "DISCORD_STOPPED",
  };

  public constructor(onStatusChange: (status: DiscordBindingRuntime["status"]) => void) {
    this.#onStatusChange = onStatusChange;
  }

  public get status(): DiscordBindingRuntime["status"] {
    return this.#status;
  }

  public async start(): Promise<DiscordBindingRuntime["status"]> {
    this.#status = { status: "ready", code: "DISCORD_READY" };
    this.#onStatusChange(this.#status);
    return this.#status;
  }

  public async close(): Promise<void> {
    this.#status = { status: "unavailable", code: "DISCORD_STOPPED" };
    this.#onStatusChange(this.#status);
  }
}

function discordBinding(botTokenAlias: string, channelId: string): MainDiscordBindingConfiguration {
  return {
    schemaVersion: 1,
    enabled: true,
    botTokenAlias,
    forum: {
      applicationId: "11111111111111111",
      botUserId: "44444444444444444",
      guildId: "55555555555555555",
      forumBindings: [
        {
          channelId,
          workflowTagIds: {
            done: "60000000000000001",
            failed: "60000000000000002",
            intake: "60000000000000003",
            review: "60000000000000004",
            running: "60000000000000005",
            waiting: "60000000000000006",
          },
        },
      ],
      ownerUserIds: ["70000000000000001"],
      allowedRoleIds: [],
    },
  };
}
