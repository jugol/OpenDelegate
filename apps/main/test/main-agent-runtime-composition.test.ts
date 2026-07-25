import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  AgentAdapter,
  AgentRunHandle,
  AgentStartRequest,
  NativeSessionReference,
  NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";

import { createMainRuntime, initializeMainHome } from "../src/index.ts";

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

test("a ready Main Agent executes local Tasks with the durable production Budget", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-main-agent-composition-"));
  const cleanup: { runtime?: Awaited<ReturnType<typeof createMainRuntime>> } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(home, { force: true, recursive: true });
  });
  const initialized = await initializeMainHome({
    home,
    adminRoot: await createAdminFixture(home),
    sourceCheckout: resolve("."),
  });
  const adapter = new WaitingAgentAdapter();
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "main-agent-budget-composition" },
    releaseChannel: "development",
    sourceCheckout: resolve("."),
    agentExecution: {
      adapter,
      workspace: {
        workspaceId: "workspace_main_agent",
        cwd: await realpath("."),
        isolation: "none",
      },
      sandbox: "read-only",
      permissions: { mode: "deny" },
      limits,
      retryDelayMs: 0,
    },
  });
  cleanup.runtime = runtime;
  const claim = await runtime.ownerAuth.issueInitialClaim({ channel: "local-bootstrap" });
  const owner = await runtime.ownerAuth.claimOwner({
    channel: "local-bootstrap",
    claimToken: claim.claimToken,
    passphrase: "correct horse battery staple",
  });

  const task = await runtime.tasks.create({
    principalId: owner.ownerId,
    idempotencyKey: "main-agent-local-task",
    objective: "Clarify the requested release channel.",
    completionCriteria: ["The owner supplies a release channel."],
    constraints: [],
    selectedInputRefs: [],
    mode: "auto",
  });
  await runtime.taskExecution?.waitForIdle();

  assert.equal((await runtime.tasks.get(task.taskId)).state, "waiting_user");
  assert.equal(adapter.starts.length, 1);
  const budget = await runtime.budget?.snapshot(task.taskId);
  assert.equal(budget?.usage.nativeTurns, 1);
  assert.equal(budget?.kind, "requested");
});

class WaitingAgentAdapter implements AgentAdapter {
  readonly adapterId = "fixture-main-agent-composition";
  readonly provider = "generic" as const;
  readonly starts: AgentStartRequest[] = [];

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
    const reference = session(input);
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
        finalText: JSON.stringify({
          schemaVersion: 1,
          state: "waiting_user",
          ownerQuestion: "Which release channel should I use?",
        }),
      }),
      async cancel() {},
    };
  }

  async resume(): Promise<AgentRunHandle> {
    throw new Error("This fixture expects one first turn.");
  }
}

function session(input: AgentStartRequest): NativeSessionReference {
  return {
    schemaVersion: 1,
    provider: "generic",
    adapterId: "fixture-main-agent-composition",
    adapterVersion: "1.0.0",
    nativeSessionId: "native-main-agent-composition",
    sessionKey: input.sessionKey,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    deviceId: input.deviceId,
    workspaceId: input.workspace.workspaceId,
    cwd: input.workspace.cwd,
    lineage: { lineageId: "lineage-main-agent-composition" },
    createdAt: new Date().toISOString(),
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
