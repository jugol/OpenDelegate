import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  type AgentAdapter,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type NativeSessionReference,
  type NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
import {
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import { InMemoryEventStore } from "@opendelegate/event-store";
import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";

import {
  AgentBackedConfigurationAgent,
  ConfigurationServiceAgentToolBroker,
  ManagedSecretExactMatchGuard,
  type ConfigurationAgentSecretLeakGuardPort,
  type ConfigurationAgentToolBroker,
} from "../src/agent-configuration-agent.ts";
import { EventStoreMainNativeSessionRepository } from "../src/agent-task-executor.ts";

const NOW = "2026-07-25T12:00:00.000Z";
const limits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
};

test("Configuration Agent resumes one native session per target Device", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new FakeConfigurationAdapter();
  const agent = await createAgent(adapter, eventStore);

  const first = await agent.sendMessage(message("request_one", "Inspect this Device."));
  const second = await agent.sendMessage(message("request_two", "Propose a safer route."));

  assert.equal(first.content, "I inspected the available configuration context.");
  assert.deepEqual(first.suggestedActions, ["guide-discord", "guide-external-postgresql"]);
  assert.equal(second.content, "I prepared a proposal; it has not been applied.");
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(adapter.starts[0]?.taskId, "configuration:device_worker");
  assert.equal(adapter.starts[0]?.workstreamId, "configuration");
  assert.match(adapter.starts[0]?.prompt ?? "", /Target Device ID: device_worker/);
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /Guide Discord setup in dependency order.*Developer Portal.*Community.*Forum/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /may be creating a Discord bot for the first time.*plain language/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /one Discord Forum post.*one OpenDelegate Task.*replies.*same Task/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /where to go.*what to do.*why.*how to verify.*what.*send back/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /brief roadmap.*current stage.*wait for the owner to confirm.*next stage/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /install link.*add the bot.*server.*member list.*Forum/isu,
  );
  assert.match(adapter.starts[0]?.prompt ?? "", /Developer Mode.*Copy ID.*non-secret/isu);
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /presentationLocale.*en\|ko.*deterministic OpenDelegate Discord/isu,
  );
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /SQLite is the default and needs no database URI/isu,
  );
  assert.match(adapter.resumes[0]?.prompt ?? "", /Propose a safer route\./);
  assert.equal(adapter.resumes[0]?.session.nativeSessionId, "native-configuration-session");
});

test("Configuration Agent binds the response locale to durable idempotency", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new FakeConfigurationAdapter();
  const agent = await createAgent(adapter, eventStore);
  const request = {
    ...message("request_locale_identity", "Inspect this Device."),
    responseLocale: "ko" as const,
  };

  await agent.sendMessage(request);

  const restarted = await createAgent(adapter, eventStore);
  await assert.rejects(
    restarted.sendMessage({
      ...request,
      responseLocale: "ja",
    }),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 0);
});

test("Configuration Agent creates a fresh continuation when the initial native resume fails", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new InitialResumeFailureAdapter();
  const agent = await createAgent(adapter, eventStore);

  await agent.sendMessage(message("request_initial", "Inspect this Device."));
  const recovered = await agent.sendMessage(
    message("request_after_loss", "Continue Discord setup."),
  );

  assert.equal(recovered.content, "I continued safely in a fresh native session.");
  assert.equal(adapter.resumes.length, 1);
  assert.equal(adapter.starts.length, 2);
  assert.match(adapter.starts[1]?.prompt ?? "", /Continue Discord setup\./);
  assert.match(
    adapter.starts[1]?.prompt ?? "",
    /prior provider-native Configuration Agent session is unavailable/iu,
  );
  assert.match(adapter.starts[1]?.prompt ?? "", /Inspect this Device\./u);
  assert.match(adapter.starts[1]?.prompt ?? "", /Durable visible conversation/iu);
  assert.equal(adapter.starts[1]?.runId.endsWith("_continuation_turn_0"), true);
  assert.equal(adapter.starts[1]?.continuationOf?.nativeSessionId, "native-configuration-session");
  assert.match(adapter.starts[1]?.continuationReason ?? "", /resume was unavailable/iu);

  const stored = await new EventStoreMainNativeSessionRepository(eventStore).load(
    "configuration:device_worker:fixture-configuration-agent",
  );
  assert.equal(stored?.nativeSessionId, "native-configuration-continuation");
  assert.equal(stored?.lineage.parentNativeSessionId, "native-configuration-session");
  assert.match(stored?.lineage.continuationReason ?? "", /resume was unavailable/iu);
});

test("Configuration Agent safely continues after an inspect-only turn is interrupted", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new ToolThenResumeFailureAdapter();
  const broker = new RecordingToolBroker();
  const agent = await createAgent(adapter, eventStore, broker);
  const interrupted = message(
    "request_tool_then_loss",
    "Inspect configuration and continue Discord setup.",
  );

  await agent.sendMessage(message("request_seed", "Inspect this Device."));
  const recovered = await agent.sendMessage(interrupted);

  assert.equal(recovered.content, "I inspected the available configuration context.");
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 2);
  assert.equal(broker.calls.length, 1);
  assert.match(
    adapter.starts[1]?.prompt ?? "",
    /Inspect configuration and continue Discord setup\./u,
  );
  assert.match(
    adapter.starts[1]?.prompt ?? "",
    /prior provider-native Configuration Agent session is unavailable/iu,
  );
  const interruptedHistory = await agent.listMessages({
    deviceId: "device_worker",
    principalId: "owner_personal",
  });
  assert.deepEqual(
    interruptedHistory.messages
      .filter((item) => item.role === "owner")
      .map(({ content, responseStatus }) => ({ content, responseStatus })),
    [
      { content: "Inspect this Device.", responseStatus: "completed" },
      {
        content: "Inspect configuration and continue Discord setup.",
        responseStatus: "completed",
      },
    ],
  );

  const restarted = await createAgent(adapter, eventStore, broker);
  const replayed = await restarted.sendMessage(interrupted);
  assert.equal(replayed.content, recovered.content);
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 2);
  assert.equal(broker.calls.length, 1);
});

test("Configuration Agent never auto-continues after a mutation-capable tool attempt", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new ProposalThenResumeFailureAdapter();
  const agent = await createAgent(adapter, eventStore);
  const interrupted = message(
    "request_proposal_then_loss",
    "Propose authenticated Artifact access.",
  );

  await agent.sendMessage(message("request_seed", "Inspect this Device."));
  await assert.rejects(agent.sendMessage(interrupted), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 3);

  const restarted = await createAgent(adapter, eventStore);
  await assert.rejects(restarted.sendMessage(interrupted), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 3);
});

test("Configuration Agent persists its one continuation reservation across restart", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new ContinuationStartFailureAdapter();
  const agent = await createAgent(adapter, eventStore);
  const interrupted = message(
    "request_continuation_then_loss",
    "Inspect configuration and continue Discord setup.",
  );

  await agent.sendMessage(message("request_seed", "Inspect this Device."));
  await assert.rejects(agent.sendMessage(interrupted), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 2);

  const restarted = await createAgent(adapter, eventStore);
  await assert.rejects(restarted.sendMessage(interrupted), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 2);
});

test("Configuration Agent keeps legacy inspect-first interruption records fail-closed", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const interrupted = message(
    "request_legacy_inspect_boundary",
    "Inspect configuration and continue Discord setup.",
  );
  const operationKey = testDigest(
    `${interrupted.principalId}\u0000${interrupted.deviceId}\u0000${interrupted.idempotencyKey}`,
  );
  const requestDigest = testDigest(`${interrupted.message}\u0000response-locale:en`);
  await eventStore.append({
    streamId: `configuration-tool-attempt:${operationKey.slice("sha256:".length)}`,
    expectedVersion: 0,
    events: [
      {
        eventId: "event_legacy_inspect_boundary",
        type: "configuration-agent.tool-attempted",
        payload: {
          schemaVersion: 1,
          requestDigest,
          toolOperationId: "configuration-tool:legacy-inspect",
          tool: "inspect",
        },
      },
    ],
  });
  const adapter = new FakeConfigurationAdapter();
  const agent = await createAgent(adapter, eventStore);

  await assert.rejects(agent.sendMessage(interrupted), (error: unknown) => {
    assert.equal((error as { readonly code?: unknown }).code, "CONFIGURATION_AGENT_UNAVAILABLE");
    assert.match((error as { readonly message?: string }).message ?? "", /legacy/iu);
    return true;
  });
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.resumes.length, 0);
});

test("Configuration Agent exposes the terminal adapter diagnostic code at its public failure seam", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const agent = await createAgent(new TerminalFailureConfigurationAdapter(), eventStore);

  await assert.rejects(
    agent.sendMessage(message("request_terminal_failure", "Inspect the current profile.")),
    (error: unknown) => {
      assert.equal((error as { readonly code?: unknown }).code, "CONFIGURATION_AGENT_UNAVAILABLE");
      assert.match(
        (error as { readonly message?: string }).message ?? "",
        /Diagnostic code: PROVIDER_CONNECTION_CLOSED\./u,
      );
      return true;
    },
  );

  const invalidCodeAgent = await createAgent(
    new TerminalFailureConfigurationAdapter("provider failure!"),
    new InMemoryEventStore({ clock: { now: () => NOW } }),
  );
  await assert.rejects(
    invalidCodeAgent.sendMessage(
      message("request_invalid_terminal_code", "Inspect the current profile again."),
    ),
    (error: unknown) => {
      assert.match(
        (error as { readonly message?: string }).message ?? "",
        /Diagnostic code: CONFIGURATION_AGENT_TURN_FAILED\./u,
      );
      return true;
    },
  );
});

test("Configuration Agent rejects raw Secret material before adapter, session, or event access", async () => {
  const sentinels = [
    "Use postgresql://owner:correct-horse@example.test/opendelegate for the database.",
    'Set {"apiToken":"sk-opendelegate-secret-material-1234567890"} now.',
    "password=correct-horse-battery-staple",
    "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXktbWF0ZXJpYWw=\n-----END PRIVATE KEY-----",
    'Import {"grantToken":"enrollment-grant-secret-1234567890"}.',
    "Use Discord credential MTIzNDU2Nzg5MDEyMzQ1Njc4.NopQrs.AbCdEfGhIjKlMnOpQrStUvWxYz012345.",
    "Use AWS access key AKIA1234567890ABCDEF.",
    "Use opaque credential Q7vN2xK9pR4mT8wY3cF6hJ1sL5dG0bZqU7eI2oP9.",
  ];

  for (const [index, sentinel] of sentinels.entries()) {
    const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
    const adapter = new FakeConfigurationAdapter();
    const agent = await createAgent(adapter, eventStore);

    await assert.rejects(agent.sendMessage(message(`request_secret_${index}`, sentinel)), {
      code: "SECRET_MATERIAL_REQUIRES_SECURE_INGEST",
    });
    assert.equal(adapter.starts.length, 0);
    assert.equal(adapter.resumes.length, 0);
    assert.deepEqual(await eventStore.readAll(), []);
  }
});

test("Configuration Agent allows canonical references and non-secret identifiers", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new FakeConfigurationAdapter();
  const agent = await createAgent(adapter, eventStore);
  const response = await agent.sendMessage(
    message(
      "request_safe_references",
      [
        "Inspect secret://main/Q7vN2xK9pR4mT8wY3cF6hJ1sL5dG0bZqU7eI2oP9.",
        `Use digest sha256:${"a".repeat(64)}.`,
        "Correlation 550e8400-e29b-41d4-a716-446655440000.",
        "Label ThisIsALongIdentifierVersion2026ThatIsNotSecret.",
      ].join(" "),
    ),
  );

  assert.equal(response.content, "I inspected the available configuration context.");
  assert.equal(adapter.starts.length, 1);
  assert.equal(await eventStore.streamVersion("configuration-response:not-present"), 0);
});

test("Configuration Agent rejects an exact known managed Secret missed by heuristics", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new FakeConfigurationAdapter();
  const secretStore = new ExactMatchSecretStore("violet-apple-7");
  const agent = await createAgent(
    adapter,
    eventStore,
    configurationBroker(configurationService()),
    8,
    new ManagedSecretExactMatchGuard({
      secretStore,
      aliases: () => ["discord-bot"],
    }),
  );

  await assert.rejects(
    agent.sendMessage(
      message("request_exact_managed_secret", "Please keep violet-apple-7 available."),
    ),
    { code: "SECRET_MATERIAL_REQUIRES_SECURE_INGEST" },
  );
  assert.equal(adapter.starts.length, 0);
  assert.deepEqual(await eventStore.readAll(), []);
});

test("Configuration Agent durably replays an idempotent response after restart", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const firstAdapter = new FakeConfigurationAdapter();
  const firstAgent = await createAgent(firstAdapter, eventStore);
  const input = message("request_replay", "Inspect this Device.");
  const original = await firstAgent.sendMessage(input);

  const restartedAdapter = new FakeConfigurationAdapter();
  const restartedAgent = await createAgent(restartedAdapter, eventStore);
  const replay = await restartedAgent.sendMessage(input);

  assert.deepEqual(replay, original);
  assert.equal(restartedAdapter.starts.length, 0);
  assert.equal(restartedAdapter.resumes.length, 0);
  await assert.rejects(restartedAgent.sendMessage({ ...input, message: "A different mutation." }), {
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("Configuration Chat restores its visible Device conversation after restart", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const firstAgent = await createAgent(new FakeConfigurationAdapter(), eventStore);

  await firstAgent.sendMessage(message("request_history_one", "Inspect this Device."));
  await firstAgent.sendMessage(message("request_history_two", "Propose a safer route."));

  const restartedAgent = await createAgent(new FakeConfigurationAdapter(), eventStore);
  const history = await restartedAgent.listMessages({
    deviceId: "device_worker",
    principalId: "owner_personal",
  });

  assert.deepEqual(
    history.messages.map((item) => ({
      role: item.role,
      content: item.content,
      suggestedActions: item.role === "agent" ? item.suggestedActions : undefined,
    })),
    [
      {
        role: "owner",
        content: "Inspect this Device.",
        suggestedActions: undefined,
      },
      {
        role: "agent",
        content: "I inspected the available configuration context.",
        suggestedActions: ["guide-discord", "guide-external-postgresql"],
      },
      {
        role: "owner",
        content: "Propose a safer route.",
        suggestedActions: undefined,
      },
      {
        role: "agent",
        content: "I prepared a proposal; it has not been applied.",
        suggestedActions: undefined,
      },
    ],
  );
});

test("Configuration Chat exposes an accepted owner message while its Agent response is pending", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new DeferredConfigurationAdapter();
  const agent = await createAgent(adapter, eventStore);
  const response = agent.sendMessage(
    message("request_pending_history", "Keep this visible during reload."),
  );

  await adapter.started;
  const pending = await agent.listMessages({
    deviceId: "device_worker",
    principalId: "owner_personal",
  });

  assert.equal(pending.messages[0]?.role, "owner");
  assert.equal(pending.messages[0]?.content, "Keep this visible during reload.");
  assert.equal(
    (pending.messages[0] as { readonly responseStatus?: string } | undefined)?.responseStatus,
    "pending",
  );

  adapter.complete();
  await response;
  const completed = await agent.listMessages({
    deviceId: "device_worker",
    principalId: "owner_personal",
  });
  assert.deepEqual(
    completed.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "owner", content: "Keep this visible during reload." },
      { role: "agent", content: "The deferred response completed." },
    ],
  );
});

test("Configuration Agent rejects a terminal response that can impersonate applied state", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new FakeConfigurationAdapter("invalid");
  const agent = await createAgent(adapter, eventStore);

  await assert.rejects(agent.sendMessage(message("request_invalid", "Apply it.")), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /Mutation claims must reference the exact successful durable receipt/,
  );
});

test("Configuration Agent executes bounded typed tool turns and exposes only verified mutation receipts", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new ToolUsingConfigurationAdapter();
  const service = configurationService();
  const broker = configurationBroker(service);
  const agent = await createAgent(adapter, eventStore, broker);

  const response = await agent.sendMessage(
    message("request_tools", "Require authenticated Artifact access on this Device."),
  );

  assert.match(response.content, /The Device now requires authenticated Artifact access\./);
  assert.match(
    response.content,
    /Verified configuration change: applied revision 1 \(receipt configuration-7, change set configuration-5\)\./,
  );
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 4);
  assert.match(adapter.resumes[0]?.prompt ?? "", /"tool":"inspect"/);
  assert.match(adapter.resumes[1]?.prompt ?? "", /"tool":"propose"/);
  assert.match(adapter.resumes[2]?.prompt ?? "", /"tool":"diff"/);
  assert.match(adapter.resumes[3]?.prompt ?? "", /"tool":"apply"/);

  const effective = await service.inspect({
    instanceId: "instance_personal",
    mainId: "device_main",
    deviceId: "device_worker",
  });
  assert.equal(effective["artifact.exposure"]?.value, "authenticated");
});

test("Configuration Agent carries the selected response locale and completes a proposed change through Approval creation", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new ProposalStoppingConfigurationAdapter();
  const service = configurationService();
  const broker = new ConfigurationServiceAgentToolBroker({
    service,
    contextForDevice: (deviceId) => ({
      instanceId: "instance_personal",
      mainId: "device_main",
      deviceId,
    }),
    authorizeMutation: () => ({
      decision: "require-approval",
      code: "OWNER_APPROVAL_REQUIRED",
    }),
    approvalRequester: {
      async request() {
        return { approvalId: "approval_profile_change" };
      },
    },
  });
  const agent = await createAgent(adapter, eventStore, broker);

  const response = await agent.sendMessage({
    ...message("request_proposal_approval", "Change this Device profile."),
    responseLocale: "ko",
  });

  assert.equal(response.pendingApprovalId, "approval_profile_change");
  assert.equal(adapter.resumes.length, 4);
  assert.match(
    adapter.starts[0]?.prompt ?? "",
    /Respond to the owner in Korean \(ko\).*even when the owner message is in another language/isu,
  );
  assert.match(adapter.resumes[2]?.prompt ?? "", /configuration-2.*apply.*Approval/isu);
  assert.match(adapter.resumes[3]?.prompt ?? "", /approval_profile_change/u);
  const history = await agent.listMessages({
    deviceId: "device_worker",
    principalId: "owner_personal",
  });
  const restoredResponse = history.messages.at(-1);
  assert.equal(restoredResponse?.role, "agent");
  assert.equal(
    restoredResponse?.role === "agent" ? restoredResponse.pendingApprovalId : undefined,
    "approval_profile_change",
  );
});

test("Configuration Chat discovers and changes Main Admin auto-open through typed durable tools", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new AdminAutoOpenConfigurationAdapter();
  const service = configurationService();
  const agent = await createAgent(adapter, eventStore, configurationBroker(service));

  const response = await agent.sendMessage({
    deviceId: "device_main",
    principalId: "owner_personal",
    idempotencyKey: "request_admin_auto_open",
    message: "Open the Admin page automatically after I log in.",
  });

  assert.match(response.content, /Admin will open once per owner login session\./);
  assert.match(response.content, /Verified configuration change: applied revision 1/);
  assert.match(response.content, /service reconfigure --home MAIN_HOME/);
  assert.match(response.content, /never elevates or restarts native services/);
  assert.match(adapter.starts[0]?.prompt ?? "", /admin\.open-on-login/);
  assert.match(adapter.resumes[0]?.prompt ?? "", /"admin.open-on-login"/);
  const effective = await service.inspect({
    instanceId: "instance_personal",
    mainId: "device_main",
    deviceId: "device_main",
  });
  assert.equal(effective["admin.open-on-login"]?.value, true);
  assert.deepEqual(effective["admin.open-on-login"]?.source, {
    kind: "main",
    id: "device_main",
  });
});

test("Configuration Agent fails closed when a final mutation claim lacks its durable receipt", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new UnknownReceiptClaimAdapter();
  const agent = await createAgent(adapter, eventStore);

  await assert.rejects(agent.sendMessage(message("request_unknown_receipt", "Apply a setting.")), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
    diagnosticCode: "CONFIGURATION_CLAIM_RECEIPT_MISMATCH",
  });
});

test("Configuration Agent stops a runner that exceeds the typed tool-turn budget", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new EndlessToolAdapter();
  const broker = new RecordingToolBroker();
  const agent = await createAgent(adapter, eventStore, broker, 2);

  await assert.rejects(agent.sendMessage(message("request_runaway", "Keep inspecting.")), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
    diagnosticCode: "CONFIGURATION_TOOL_TURN_BUDGET_EXCEEDED",
  });
  assert.equal(broker.calls.length, 2);
  assert.equal(adapter.cancelCount, 0);
});

test("Configuration Agent recovers the typed object when a runner appends prose after it", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new TrailingProseAdapter();
  const broker = new RecordingToolBroker();
  const agent = await createAgent(adapter, eventStore, broker);

  const response = await agent.sendMessage(
    message("request_trailing_prose", "Change the Worker profile."),
  );

  assert.equal(response.content, "I inspected the current Device configuration.");
  // The typed tool request inside the object still executed, so the trailing
  // prose changed nothing about which deterministic tool ran.
  assert.equal(broker.calls.length, 1);
  assert.equal(broker.calls[0]?.request.tool, "inspect");
});

test("Configuration Agent still fails closed when a response holds no single typed object", async () => {
  for (const text of [
    "no JSON at all, just prose",
    '{"schemaVersion":1,"type":"tool","toolCallId":"a","request":{"tool":"inspect"}} {"second":"object"}',
  ]) {
    const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
    const agent = await createAgent(new FixedTextAdapter(text), eventStore);
    await assert.rejects(
      agent.sendMessage(message(`request_${digestSuffix(text)}`, "Change the Worker profile.")),
      {
        code: "CONFIGURATION_AGENT_UNAVAILABLE",
        diagnosticCode: "CONFIGURATION_AGENT_RESPONSE_INVALID",
      },
    );
  }
});

test("every Configuration Agent unavailability names the boundary that refused the request", async () => {
  const cases: readonly {
    readonly adapter: AgentAdapter;
    readonly idempotencyKey: string;
    readonly toolBroker?: ConfigurationAgentToolBroker;
    readonly maximumToolTurns?: number;
  }[] = [
    { adapter: new FakeConfigurationAdapter("invalid"), idempotencyKey: "request_invalid_shape" },
    { adapter: new UnknownReceiptClaimAdapter(), idempotencyKey: "request_unknown_claim" },
    {
      adapter: new EndlessToolAdapter(),
      idempotencyKey: "request_endless",
      toolBroker: new RecordingToolBroker(),
      maximumToolTurns: 1,
    },
  ];

  for (const entry of cases) {
    const agent = await createAgent(
      entry.adapter,
      new InMemoryEventStore({ clock: { now: () => NOW } }),
      entry.toolBroker ?? configurationBroker(configurationService()),
      entry.maximumToolTurns ?? 8,
    );
    const error: unknown = await agent
      .sendMessage(message(entry.idempotencyKey, "Change the Coordinator profile."))
      .then(
        () => undefined,
        (rejection: unknown) => rejection,
      );

    assert.notEqual(error, undefined, `${entry.idempotencyKey} unexpectedly succeeded`);
    assert.equal((error as { readonly code?: unknown }).code, "CONFIGURATION_AGENT_UNAVAILABLE");
    const diagnosticCode = (error as { readonly diagnosticCode?: unknown }).diagnosticCode;
    assert.equal(
      typeof diagnosticCode === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(diagnosticCode),
      true,
      `${entry.idempotencyKey} produced no publishable diagnostic code: ${String(diagnosticCode)}`,
    );
  }
});

async function createAgent(
  adapter: AgentAdapter,
  eventStore: InMemoryEventStore,
  toolBroker: ConfigurationAgentToolBroker = configurationBroker(configurationService()),
  maximumToolTurns = 8,
  secretLeakGuard?: ConfigurationAgentSecretLeakGuardPort,
): Promise<AgentBackedConfigurationAgent> {
  return new AgentBackedConfigurationAgent({
    adapter,
    sessionRepository: new EventStoreMainNativeSessionRepository(eventStore),
    eventStore,
    mainDeviceId: "device_main",
    workspace: {
      workspaceId: "workspace_main_configuration",
      cwd: await realpath("."),
      isolation: "none",
    },
    sandbox: "read-only",
    permissions: { mode: "deny" },
    limits,
    clock: { now: () => NOW },
    toolBroker,
    maximumToolTurns,
    ...(secretLeakGuard === undefined ? {} : { secretLeakGuard }),
  });
}

class ExactMatchSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi";
  public readonly deviceId = "device_main";
  readonly #value: Buffer;

  public constructor(value: string) {
    this.#value = Buffer.from(value, "utf8");
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return { backend: this.backend, deviceId: this.deviceId, status: "ready" };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: true };
  }

  public async store(): Promise<ManagedSecretMutation> {
    return { status: "stored" };
  }

  public async rotate(): Promise<ManagedSecretMutation> {
    return { status: "rotated" };
  }

  public async delete(): Promise<ManagedSecretDeletion> {
    return { status: "absent" };
  }

  public async executeWithSecretBytes(
    _alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const copy = Buffer.from(this.#value);
    try {
      await executor(copy);
    } finally {
      copy.fill(0);
    }
  }
}

function message(idempotencyKey: string, value: string) {
  return {
    deviceId: "device_worker",
    principalId: "owner_personal",
    idempotencyKey,
    message: value,
  };
}

class FakeConfigurationAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];
  readonly #mode: "normal" | "invalid";

  constructor(mode: "normal" | "invalid" = "normal") {
    this.#mode = mode;
  }

  async probe() {
    return {
      contractVersion: 1 as const,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.0.0",
      compatibility: "tested" as const,
      auth: { state: "ready" as const },
      capabilities: {
        start: true,
        resume: true,
        streaming: true,
        cancellation: true,
        approvalBridge: true,
        steering: false,
        checkpointContinuation: true,
        workspaceIsolation: ["none" as const],
      },
      diagnostics: [],
    };
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(
      session(input),
      this.#mode === "invalid"
        ? JSON.stringify({
            schemaVersion: 1,
            type: "final",
            content: "Applied everything.",
            claimReceiptIds: ["receipt_that_does_not_exist"],
          })
        : JSON.stringify({
            schemaVersion: 1,
            type: "final",
            content: "I inspected the available configuration context.",
            claimReceiptIds: [],
            suggestedActions: ["guide-discord", "guide-external-postgresql"],
          }),
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "I prepared a proposal; it has not been applied.",
        claimReceiptIds: [],
      }),
    );
  }
}

class TerminalFailureConfigurationAdapter extends FakeConfigurationAdapter {
  readonly #failureCode: string;

  constructor(failureCode = "PROVIDER_CONNECTION_CLOSED") {
    super();
    this.#failureCode = failureCode;
  }

  override async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return failedHandle(session(input), this.#failureCode);
  }
}

class DeferredConfigurationAdapter extends FakeConfigurationAdapter {
  readonly started: Promise<void>;
  #complete: ((result: Awaited<AgentRunHandle["result"]>) => void) | undefined;
  #markStarted: (() => void) | undefined;
  #reference: NativeSessionReference | undefined;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  override async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    const reference = session(input);
    this.#reference = reference;
    const result = new Promise<Awaited<AgentRunHandle["result"]>>((resolve) => {
      this.#complete = resolve;
    });
    this.#markStarted?.();
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            sequence: 1,
            observedAt: NOW,
            type: "session_started" as const,
            session: reference,
          };
        },
      },
      result,
      async cancel() {
        return undefined;
      },
    };
  }

  complete(): void {
    assert.ok(this.#reference);
    this.#complete?.({
      status: "succeeded",
      session: this.#reference,
      finalText: JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The deferred response completed.",
        claimReceiptIds: [],
      }),
    });
  }
}

class InitialResumeFailureAdapter extends FakeConfigurationAdapter {
  override async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    const reference = {
      ...session(input),
      nativeSessionId:
        this.starts.length === 1
          ? "native-configuration-session"
          : "native-configuration-continuation",
      lineage: {
        lineageId:
          this.starts.length === 1
            ? "lineage-configuration-device"
            : "lineage-configuration-continuation",
        ...(input.continuationOf === undefined
          ? {}
          : {
              parentNativeSessionId: input.continuationOf.nativeSessionId,
              continuationReason: input.continuationReason,
            }),
      },
    };
    return handle(
      reference,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content:
          this.starts.length === 1
            ? "I inspected the available configuration context."
            : "I continued safely in a fresh native session.",
        claimReceiptIds: [],
        suggestedActions: [],
      }),
    );
  }

  override async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    return failedHandle(input.session);
  }
}

class ToolThenResumeFailureAdapter extends FakeConfigurationAdapter {
  override async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    if (this.resumes.length === 1) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "inspect_before_loss",
          request: { tool: "inspect" },
        }),
      );
    }
    return failedHandle(input.session);
  }
}

class ContinuationStartFailureAdapter extends ToolThenResumeFailureAdapter {
  override async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    if (this.starts.length === 0) {
      return super.start(input);
    }
    this.starts.push(structuredClone(input));
    return failedHandle(session(input));
  }
}

class ProposalThenResumeFailureAdapter extends FakeConfigurationAdapter {
  override async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    if (this.resumes.length === 1) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "inspect_before_proposal",
          request: { tool: "inspect" },
        }),
      );
    }
    if (this.resumes.length === 2) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "proposal_before_loss",
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Require authenticated Artifact access on this Device.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "authenticated",
              },
            ],
          },
        }),
      );
    }
    return failedHandle(input.session);
  }
}

class ToolUsingConfigurationAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(
      session(input),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect_current",
        request: { tool: "inspect" },
      }),
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    const turn = this.resumes.length;
    if (turn === 1) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose_authenticated",
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Require authenticated Artifact access on this Device.",
            changes: [
              {
                operation: "set",
                key: "artifact.exposure",
                scope: { kind: "device", id: "device_worker" },
                value: "authenticated",
              },
            ],
          },
        }),
      );
    }
    if (turn === 2) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "diff_authenticated",
          request: {
            tool: "diff",
            proposalId: "configuration-2",
            expectedRevision: 0,
          },
        }),
      );
    }
    if (turn === 3) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "apply_authenticated",
          request: {
            tool: "apply",
            proposalId: "configuration-2",
            expectedRevision: 0,
          },
        }),
      );
    }
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The Device now requires authenticated Artifact access.",
        claimReceiptIds: ["configuration-7"],
      }),
    );
  }
}

class ProposalStoppingConfigurationAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(
      session(input),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect_profile",
        request: { tool: "inspect" },
      }),
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    const turn = this.resumes.length;
    if (turn === 1) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose_profile",
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Change the Device Worker profile.",
            changes: [
              {
                operation: "set",
                key: "agent.worker-profile",
                scope: { kind: "device", id: "device_worker" },
                value: { schemaVersion: 1, mode: "auto" },
              },
            ],
          },
        }),
      );
    }
    if (turn === 2) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "final",
          content: "Review and approve proposal configuration-2.",
          claimReceiptIds: [],
        }),
      );
    }
    if (turn === 3) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "apply_profile",
          request: {
            tool: "apply",
            proposalId: "configuration-2",
            expectedRevision: 0,
          },
        }),
      );
    }
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "승인 요청을 준비했습니다.",
        claimReceiptIds: [],
      }),
    );
  }
}

class AdminAutoOpenConfigurationAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(
      session(input),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect_admin_auto_open",
        request: { tool: "inspect" },
      }),
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    if (this.resumes.length === 1) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose_admin_auto_open",
          request: {
            tool: "propose",
            expectedRevision: 0,
            reason: "Open Admin once in each owner login session.",
            changes: [
              {
                operation: "set",
                key: "admin.open-on-login",
                scope: { kind: "main", id: "device_main" },
                value: true,
              },
            ],
          },
        }),
      );
    }
    if (this.resumes.length === 2) {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "apply_admin_auto_open",
          request: {
            tool: "apply",
            proposalId: "configuration-2",
            expectedRevision: 0,
          },
        }),
      );
    }
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "Admin will open once per owner login session.",
        claimReceiptIds: ["configuration-6"],
      }),
    );
  }
}

class UnknownReceiptClaimAdapter extends FakeConfigurationAdapter {
  override async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(
      session(input),
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The change was applied.",
        claimReceiptIds: ["unknown-receipt"],
      }),
    );
  }
}

class EndlessToolAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];
  cancelCount = 0;

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return this.#next(input, session(input));
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    return this.#next(input, input.session);
  }

  #next(
    _input: AgentStartRequest | AgentResumeRequest,
    reference: NativeSessionReference,
  ): AgentRunHandle {
    const result = handle(
      reference,
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: `inspect_${this.starts.length + this.resumes.length}`,
        request: { tool: "inspect" },
      }),
    );
    return {
      ...result,
      cancel: async () => {
        this.cancelCount += 1;
      },
    };
  }
}

/**
 * Reproduces an observed Codex turn that returned a correct typed object with
 * its own prose appended after the closing brace.
 */
class TrailingProseAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];
  readonly resumes: AgentResumeRequest[] = [];

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(structuredClone(input));
    return handle(session(input), this.#text());
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(structuredClone(input));
    return handle(input.session, this.#text());
  }

  #text(): string {
    const turn = this.starts.length + this.resumes.length;
    const payload =
      turn === 1
        ? {
            schemaVersion: 1,
            type: "tool",
            toolCallId: "inspect-worker-profile",
            request: { tool: "inspect" },
          }
        : {
            schemaVersion: 1,
            type: "final",
            content: "I inspected the current Device configuration.",
            claimReceiptIds: [],
          };
    // The exact shape observed on the Main Device: one balanced object, then prose.
    return `${JSON.stringify(payload)} any trailing? no. \n`;
  }
}

/** Returns one fixed final text for every turn. */
class FixedTextAdapter implements AgentAdapter {
  readonly adapterId = "fixture-configuration-agent";
  readonly provider = "generic" as const;
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  async probe() {
    return new FakeConfigurationAdapter().probe();
  }

  async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    return handle(session(input), this.#text);
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    return handle(input.session, this.#text);
  }
}

function digestSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

class RecordingToolBroker implements ConfigurationAgentToolBroker {
  readonly calls: Parameters<ConfigurationAgentToolBroker["execute"]>[0][] = [];
  #sequence = 0;

  async execute(input: Parameters<ConfigurationAgentToolBroker["execute"]>[0]) {
    this.calls.push(structuredClone(input));
    this.#sequence += 1;
    return {
      schemaVersion: 1 as const,
      receiptId: `receipt-${this.#sequence}`,
      operationId: input.operationId,
      requestDigest: `sha256:${"0".repeat(64)}`,
      actor: input.principalId,
      occurredAt: NOW,
      tool: "inspect" as const,
      result: {
        revision: 0,
        values: {},
      },
    };
  }
}

function configurationService(): ConfigurationService {
  let sequence = 0;
  return new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration-${++sequence}`,
    clock: () => NOW,
  });
}

function configurationBroker(service: ConfigurationService): ConfigurationAgentToolBroker {
  return new ConfigurationServiceAgentToolBroker({
    service,
    contextForDevice: (deviceId) => ({
      instanceId: "instance_personal",
      mainId: "device_main",
      deviceId,
    }),
    authorizeMutation: () => ({
      decision: "allow",
      authority: "owner",
    }),
  });
}

function session(input: AgentStartRequest): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId: "fixture-configuration-agent",
    adapterVersion: "1.0.0",
    nativeSessionId: "native-configuration-session",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-configuration-device" },
    createdAt: NOW,
  };
}

function handle(reference: NativeSessionReference, finalText: string): AgentRunHandle {
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: NOW,
      type: "session_started",
      session: reference,
    },
  ];
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve({
      status: "succeeded" as const,
      session: reference,
      finalText,
    }),
    async cancel() {
      return undefined;
    },
  };
}

function failedHandle(
  reference: NativeSessionReference,
  code = "NATIVE_SESSION_UNAVAILABLE",
): AgentRunHandle {
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: NOW,
      type: "session_started",
      session: reference,
    },
  ];
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: Promise.resolve({
      status: "failed" as const,
      session: reference,
      error: {
        code,
        message: "The native session cannot accept another turn.",
        retryable: false,
      },
    }),
    async cancel() {
      return undefined;
    },
  };
}

function testDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
