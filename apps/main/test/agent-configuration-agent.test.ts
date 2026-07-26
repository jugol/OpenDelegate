import assert from "node:assert/strict";
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
  assert.equal(second.content, "I prepared a proposal; it has not been applied.");
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(adapter.starts[0]?.taskId, "configuration:device_worker");
  assert.equal(adapter.starts[0]?.workstreamId, "configuration");
  assert.match(adapter.starts[0]?.prompt ?? "", /Target Device ID: device_worker/);
  assert.match(adapter.resumes[0]?.prompt ?? "", /Propose a safer route\./);
  assert.equal(adapter.resumes[0]?.session.nativeSessionId, "native-configuration-session");
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
  });
});

test("Configuration Agent stops a runner that exceeds the typed tool-turn budget", async () => {
  const eventStore = new InMemoryEventStore({ clock: { now: () => NOW } });
  const adapter = new EndlessToolAdapter();
  const broker = new RecordingToolBroker();
  const agent = await createAgent(adapter, eventStore, broker, 2);

  await assert.rejects(agent.sendMessage(message("request_runaway", "Keep inspecting.")), {
    code: "CONFIGURATION_AGENT_UNAVAILABLE",
  });
  assert.equal(broker.calls.length, 2);
  assert.equal(adapter.cancelCount, 0);
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
