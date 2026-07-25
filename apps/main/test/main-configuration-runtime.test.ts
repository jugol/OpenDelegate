import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentResumeRequest,
  AgentRunHandle,
  AgentStartRequest,
  NativeSessionReference,
  NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
import {
  ConfigurationService,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";
import { SqlConfigurationRepository } from "@opendelegate/storage-sql";

import {
  createMainRuntime,
  initializeMainHome,
  inspectPersistedMainConfiguration,
} from "../src/index.ts";
import {
  createMainTestSecretContext,
  mainTestSecretBackendConfiguration,
} from "../test-fixtures/main-test-secrets.ts";

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

test("production Main auto-applies only Device profile tools through durable SQL state", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-configuration-runtime-"));
  const cleanup: { runtime?: Awaited<ReturnType<typeof createMainRuntime>> } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const mainSecrets = createMainTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "configuration-sql-composition" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    initialAdminAutoOpen: true,
    agentConfiguration: {
      adapter: new DynamicConfigurationAdapter(),
      workspace: {
        workspaceId: "workspace_main_configuration",
        cwd: await realpath("."),
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
    },
  });
  cleanup.runtime = runtime;
  const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
  const owner = await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  const login = await runtime.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const response = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/devices/${initialized.configuration.deviceId}/configuration/messages`,
    headers: {
      host: "127.0.0.1:4380",
      origin: "http://127.0.0.1:4380",
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie: `__Host-opendelegate_session=${login.sessionToken}`,
      "x-opendelegate-csrf": login.csrfToken,
      "idempotency-key": "configuration-sql-apply-1",
    },
    payload: { message: "Name this Device and assign its release Role and Instruction." },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().content, /Verified configuration change: applied revision 2/);
  const devices = await runtime.app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: {
      host: "127.0.0.1:4380",
      cookie: `__Host-opendelegate_session=${login.sessionToken}`,
    },
  });
  assert.equal(devices.statusCode, 200);
  assert.equal(devices.json().devices[0].name, "Release coordinator");
  assert.deepEqual(devices.json().devices[0].roles, ["release-engineering"]);
  assert.deepEqual(devices.json().devices[0].instructions, ["Preserve signed release evidence."]);
  await runtime.close();
  delete cleanup.runtime;

  const persistedValues = await inspectPersistedMainConfiguration({
    configuration: initialized.configuration,
    home,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });
  assert.equal(persistedValues["admin.open-on-login"]?.value, true);
  const resumed = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "configuration-sql-composition" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
    initialAdminAutoOpen: true,
  });
  await resumed.close();
  await assert.rejects(
    createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "configuration-sql-composition" },
      releaseChannel: "development",
      sourceCheckout: resolve("."),
      managedSecretStore: mainSecrets.store,
      initialAdminAutoOpen: false,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONFIG_EXISTS" &&
      /Configuration Chat/u.test(error.message),
  );

  const repository = await SqlConfigurationRepository.openSqlite({
    filename: initialized.paths.sqliteFile,
    migrationMode: "verify",
  });
  try {
    const service = new ConfigurationService({
      definitions: STANDARD_CONFIGURATION_DEFINITIONS,
      repository,
      idSource: () => "unused",
      clock: () => new Date().toISOString(),
    });
    const values = await service.inspect({
      instanceId: initialized.configuration.instanceId,
      mainId: initialized.configuration.deviceId,
      deviceId: initialized.configuration.deviceId,
    });
    assert.equal(values["database.adapter"]?.value, "sqlite");
    assert.deepEqual(values["database.adapter"]?.source, {
      kind: "main",
      id: initialized.configuration.deviceId,
    });
    assert.equal(values["admin.open-on-login"]?.value, true);
    assert.deepEqual(values["admin.open-on-login"]?.source, {
      kind: "main",
      id: initialized.configuration.deviceId,
    });
    assert.equal(values["artifact.exposure"]?.value, "private-network");
    assert.equal(values["device.display-name"]?.value, "Release coordinator");
    assert.deepEqual(values["device.roles"]?.value, ["release-engineering"]);
    assert.deepEqual(values["device.instructions"]?.value, ["Preserve signed release evidence."]);
    const audits = await service.listAudit();
    assert.equal(audits.length, 2);
    assert.equal(audits[0]?.actor, "opendelegate-init");
    assert.equal(audits[1]?.actor, owner.ownerId);
  } finally {
    await repository.close();
  }
});

test("production Main secure ingest makes an exact Main-scoped database reference available to Configuration", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-secret-runtime-"));
  const cleanup: { runtime?: Awaited<ReturnType<typeof createMainRuntime>> } = {};
  const storeValues = new Map<string, Buffer>();
  const secretBackend = mainTestSecretBackendConfiguration(home);
  const store = new RuntimeTestManagedSecretStore(
    "device_main_secret_runtime",
    storeValues,
    secretBackend.backend,
  );
  t.after(async () => {
    await cleanup.runtime?.close();
    for (const value of storeValues.values()) {
      value.fill(0);
    }
    await rm(home, { force: true, recursive: true });
  });
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
    secretBackend,
    managedSecretStore: store,
  });
  const adapter = new DatabaseReferenceConfigurationAdapter();
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "secret-reference-composition" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    managedSecretStore: store,
    agentConfiguration: {
      adapter,
      workspace: {
        workspaceId: "workspace_main_secret_configuration",
        cwd: await realpath("."),
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
    },
  });
  cleanup.runtime = runtime;
  const claim = await runtime.ownerAuth.issueInitialClaim({
    channel: "local-bootstrap",
  });
  await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });
  const login = await runtime.ownerAuth.login({
    passphrase: "correct horse battery staple",
    sourceKey: "127.0.0.1",
  });
  const headers = {
    host: "127.0.0.1:4380",
    origin: "http://127.0.0.1:4380",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    cookie: `__Host-opendelegate_session=${login.sessionToken}`,
    "x-opendelegate-csrf": login.csrfToken,
  };
  const databaseUri = Buffer.from("postgresql://owner:runtime-only@database.test/main", "utf8");
  const ingested = await runtime.app.inject({
    method: "POST",
    url: "/api/v1/secrets/ingest",
    headers: {
      ...headers,
      "idempotency-key": "runtime-database-secret-1",
    },
    payload: {
      purpose: "database-uri",
      secretBase64: databaseUri.toString("base64"),
    },
  });
  databaseUri.fill(0);
  assert.equal(ingested.statusCode, 201);
  adapter.secretRef = ingested.json().secretRef;

  const proposed = await runtime.app.inject({
    method: "POST",
    url: `/api/v1/devices/${initialized.configuration.deviceId}/configuration/messages`,
    headers: {
      ...headers,
      "idempotency-key": "runtime-database-proposal-1",
    },
    payload: {
      message: "Prepare the securely stored database reference for owner approval.",
    },
  });
  assert.equal(proposed.statusCode, 200, proposed.body);
  assert.equal(adapter.proposalStatus, "succeeded", JSON.stringify(adapter.proposalError));
  assert.equal(proposed.json().content, "The secure database reference proposal is ready.");
  assert.match(adapter.proposalId ?? "", /^configuration_/u);
  assert.equal(storeValues.size, 1);
});

class RuntimeTestManagedSecretStore implements ManagedSecretStore {
  public readonly backend: ManagedSecretStore["backend"];
  public readonly deviceId: string;
  private readonly values: Map<string, Buffer>;

  public constructor(
    deviceId: string,
    values: Map<string, Buffer>,
    backend: ManagedSecretStore["backend"],
  ) {
    this.deviceId = deviceId;
    this.values = values;
    this.backend = backend;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return {
      backend: this.backend,
      deviceId: this.deviceId,
      status: "ready",
    };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.values.has(alias) };
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (this.values.has(alias)) {
      throw new Error("alias conflict");
    }
    this.values.set(alias, Buffer.from(value));
    return { status: "stored" };
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (!this.values.has(alias)) {
      throw new Error("alias unavailable");
    }
    this.values.set(alias, Buffer.from(value));
    return { status: "rotated" };
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    return { status: this.values.delete(alias) ? "deleted" : "absent" };
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const stored = this.values.get(alias);
    if (stored === undefined) {
      throw new Error("alias unavailable");
    }
    const copy = Buffer.from(stored);
    try {
      await executor(copy);
    } finally {
      copy.fill(0);
    }
  }
}

class DatabaseReferenceConfigurationAdapter implements AgentAdapter {
  public readonly adapterId = "fixture-database-reference-configuration";
  public readonly provider = "generic" as const;
  public secretRef: string | undefined;
  public proposalId: string | undefined;
  public proposalStatus: "failed" | "succeeded" | undefined;
  public proposalError: unknown;

  public async probe() {
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

  public async start(input: AgentStartRequest): Promise<AgentRunHandle> {
    return handle(
      session(input, this.adapterId),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect-database-reference",
        request: { tool: "inspect" },
      }),
    );
  }

  public async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    const line = input.prompt.split("\n")[2];
    assert.ok(line);
    const toolResult = JSON.parse(line) as {
      readonly status: "failed" | "succeeded";
      readonly tool: "inspect" | "propose";
      readonly receipt?: {
        readonly result?: {
          readonly revision?: number;
          readonly proposal?: { readonly id: string };
        };
      };
    };
    if (toolResult.tool === "inspect") {
      assert.equal(toolResult.status, "succeeded");
      assert.ok(this.secretRef);
      assert.equal(typeof toolResult.receipt?.result?.revision, "number");
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose-database-reference",
          request: {
            tool: "propose",
            expectedRevision: toolResult.receipt?.result?.revision,
            reason: "Prepare a securely ingested database reference.",
            changes: [
              {
                operation: "set",
                key: "database.uri-ref",
                scope: {
                  kind: "main",
                  id: input.session.taskId.slice("configuration:".length),
                },
                value: { secretRef: this.secretRef },
              },
            ],
          },
        }),
      );
    }
    this.proposalStatus = toolResult.status;
    this.proposalError = (toolResult as { readonly error?: unknown }).error;
    if (toolResult.status === "failed") {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "final",
          content: "The secure database reference proposal failed.",
          claimReceiptIds: [],
        }),
      );
    }
    this.proposalId = toolResult.receipt?.result?.proposal?.id;
    assert.ok(this.proposalId);
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The secure database reference proposal is ready.",
        claimReceiptIds: [],
      }),
    );
  }
}

class DynamicConfigurationAdapter implements AgentAdapter {
  readonly adapterId = "fixture-dynamic-configuration";
  readonly provider = "generic" as const;

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
    return handle(
      session(input),
      JSON.stringify({
        schemaVersion: 1,
        type: "tool",
        toolCallId: "inspect-current",
        request: { tool: "inspect" },
      }),
    );
  }

  async resume(input: AgentResumeRequest): Promise<AgentRunHandle> {
    const toolResult = parseToolResult(input.prompt);
    if (toolResult.tool === "inspect") {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "propose-device-profile",
          request: {
            tool: "propose",
            expectedRevision: toolResult.receipt.result.revision,
            reason: "Apply the owner-requested Device profile.",
            changes: [
              {
                operation: "set",
                key: "device.display-name",
                scope: { kind: "device", id: input.session.taskId.slice("configuration:".length) },
                value: "Release coordinator",
              },
              {
                operation: "set",
                key: "device.roles",
                scope: { kind: "device", id: input.session.taskId.slice("configuration:".length) },
                value: ["release-engineering"],
              },
              {
                operation: "set",
                key: "device.instructions",
                scope: { kind: "device", id: input.session.taskId.slice("configuration:".length) },
                value: ["Preserve signed release evidence."],
              },
            ],
          },
        }),
      );
    }
    if (toolResult.tool === "propose") {
      return handle(
        input.session,
        JSON.stringify({
          schemaVersion: 1,
          type: "tool",
          toolCallId: "apply-device-profile",
          request: {
            tool: "apply",
            proposalId: toolResult.receipt.result.proposal.id,
            expectedRevision: toolResult.receipt.result.proposal.baseRevision,
          },
        }),
      );
    }
    assert.equal(toolResult.tool, "apply");
    return handle(
      input.session,
      JSON.stringify({
        schemaVersion: 1,
        type: "final",
        content: "The Device profile is updated.",
        claimReceiptIds: [toolResult.receipt.receiptId],
      }),
    );
  }
}

type ToolResult =
  | {
      readonly tool: "inspect";
      readonly receipt: { readonly result: { readonly revision: number } };
    }
  | {
      readonly tool: "propose";
      readonly receipt: {
        readonly result: {
          readonly proposal: {
            readonly id: string;
            readonly baseRevision: number;
          };
        };
      };
    }
  | {
      readonly tool: "apply";
      readonly receipt: { readonly receiptId: string };
    };

function parseToolResult(prompt: string): ToolResult {
  const line = prompt.split("\n")[2];
  assert.ok(line);
  return JSON.parse(line) as ToolResult;
}

function session(
  input: AgentStartRequest,
  adapterId = "fixture-dynamic-configuration",
): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId,
    adapterVersion: "1.0.0",
    nativeSessionId: "native-configuration-runtime",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-configuration-runtime" },
    createdAt: new Date().toISOString(),
  };
}

function handle(reference: NativeSessionReference, finalText: string): AgentRunHandle {
  const events: readonly NormalizedAgentEvent[] = [
    {
      sequence: 1,
      observedAt: new Date().toISOString(),
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
    async cancel() {},
  };
}

async function createAdminFixture(parent: string): Promise<string> {
  const root = join(parent, "admin-dist");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
  );
  return root;
}
