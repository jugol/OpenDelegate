import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentModelCatalog,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentRunLimits,
  type AgentStartRequest,
  type NativeSessionReference,
  type NormalizedAgentEvent,
} from "@opendelegate/agent-adapters";
import {
  PROTOCOL_VERSION,
  createTaskContinuationCheckpoint,
  type TaskContinuationCheckpointV1,
  type WorkOrderV1,
} from "@opendelegate/protocol";

import {
  AgentRunBridgeError,
  AgentRunProcessFactory,
  CompositeWorkerRunCapabilityProvider,
  SqliteNativeSessionReferenceStore,
  WorkerEgressGuard,
  type RunExecutionContext,
  type WorkerAgentExecutionPlan,
  type WorkerArtifactLifecycle,
  type WorkerRunAssignmentV1,
  type WorkerRunCapabilityProvider,
  type WorkerRunLeaseAuthority,
} from "../src/index.ts";

const AGENT_LIMITS: AgentRunLimits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 100,
  leaseTtlMs: 1_000,
  leaseRenewIntervalMs: 250,
  maxBufferedEvents: 8,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 64 * 1024,
};

function artifactRunCapabilityProvider(): WorkerRunCapabilityProvider {
  return {
    prepare(context) {
      if (context.artifact === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        toolServers: [
          {
            serverName: "opendelegate-artifact",
            command: process.execPath,
            args: ["artifact-mcp-bridge", "--capability-file", "opaque.capability"],
            enabledTools: ["artifact_write_chunk", "artifact_commit"],
            startupTimeoutMs: 5_000,
            toolTimeoutMs: 30_000,
          },
        ],
        dispose: () => Promise.resolve(),
      });
    },
  };
}

test("composite Run capabilities merge independent MCP servers and roll back atomically", async () => {
  const disposed: string[] = [];
  const toolServer = (serverName: string, tool: string) => ({
    serverName,
    command: process.execPath,
    args: ["worker-tools.mjs"],
    enabledTools: [tool],
    startupTimeoutMs: 5_000,
    toolTimeoutMs: 30_000,
  });
  const provider = new CompositeWorkerRunCapabilityProvider([
    {
      async prepare() {
        return {
          toolServers: [toolServer("opendelegate_computer_use", "computer_use_capture")],
          async dispose() {
            disposed.push("computer-use");
          },
        };
      },
    },
    {
      async prepare() {
        return {
          toolServers: [toolServer("opendelegate_knowledge", "knowledge_open")],
          async dispose() {
            disposed.push("knowledge");
          },
        };
      },
    },
  ]);
  const lease = await provider.prepare({
    assignment: assignment("run-composite", "work-order-composite"),
    workspace: {
      workspaceId: "workspace-repository",
      cwd: process.cwd(),
      isolation: "none",
    },
    egressGuard: WorkerEgressGuard.empty(),
    leaseAuthority: staticLeaseAuthority(10_000),
    isExecutionCurrent: async () => true,
  });
  assert.deepEqual(
    lease?.toolServers.map((server) => server.serverName),
    ["opendelegate_computer_use", "opendelegate_knowledge"],
  );
  await lease?.dispose();
  await lease?.dispose();
  assert.deepEqual(disposed, ["knowledge", "computer-use"]);

  const rollback: string[] = [];
  const failing = new CompositeWorkerRunCapabilityProvider([
    {
      async prepare() {
        return {
          toolServers: [toolServer("opendelegate_first", "first_tool")],
          async dispose() {
            rollback.push("first");
          },
        };
      },
    },
    {
      async prepare() {
        throw new Error("private preparation failure");
      },
    },
  ]);
  await assert.rejects(
    failing.prepare({
      assignment: assignment("run-composite-failure", "work-order-composite-failure"),
      workspace: {
        workspaceId: "workspace-repository",
        cwd: process.cwd(),
        isolation: "none",
      },
      egressGuard: WorkerEgressGuard.empty(),
      leaseAuthority: staticLeaseAuthority(10_000),
      isExecutionCurrent: async () => true,
    }),
  );
  assert.deepEqual(rollback, ["first"]);
});

function workOrder(workOrderId: string, workspaceId = "workspace-repository"): WorkOrderV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workOrderId,
    title: "Inspect the repository",
    brief: "Inspect the repository and return a concise public report.",
    completionCriteria: ["Return a concise result."],
    constraints: ["Do not modify files."],
    selectedInputIds: [],
    dependsOn: [],
    schedulingHints: {
      preferredDeviceIds: [],
      preferredRoles: [],
    },
    requiredCapabilities: ["codex"],
    requiredSecretRefs: [],
    workspaceId,
  };
}

function assignment(
  runId: string,
  workOrderId: string,
  overrides: Partial<WorkerRunAssignmentV1> = {},
): WorkerRunAssignmentV1 {
  return {
    taskId: "task-release",
    workOrder: workOrder(workOrderId),
    deviceId: "device-worker",
    workerId: "worker-1",
    routeId: "route-main",
    runId,
    leaseId: `lease-${runId}`,
    fencingToken: 1,
    leaseExpiresAtMs: 10_000,
    ...overrides,
  };
}

function executionContext(
  value: WorkerRunAssignmentV1,
  isLeaseCurrent: () => Promise<boolean> = () => Promise.resolve(true),
): RunExecutionContext {
  return {
    assignment: value,
    leaseAuthority: staticLeaseAuthority(value.leaseExpiresAtMs, isLeaseCurrent),
    isLeaseCurrent,
  };
}

function staticLeaseAuthority(
  leaseExpiresAtMs: number,
  isCurrent: () => boolean | Promise<boolean> = () => true,
): WorkerRunLeaseAuthority {
  return {
    snapshot: () => ({
      leaseExpiresAtMs,
      conservativeDeadlineMonotonicMs: leaseExpiresAtMs,
    }),
    isCurrent,
    renewIfDue: () => Promise.resolve(),
  };
}

function executionPlan(prompt: string): WorkerAgentExecutionPlan {
  return {
    provider: "codex",
    adapterId: "codex-fixture",
    workstreamId: "repository-inspection",
    prompt,
    sandbox: "read-only",
    permissions: {
      mode: "deny",
    },
    limits: AGENT_LIMITS,
  };
}

class RecordingAdapter implements AgentAdapter {
  public readonly adapterId = "codex-fixture";
  public readonly provider = "codex" as const;
  public readonly starts: AgentStartRequest[] = [];
  public readonly resumes: AgentResumeRequest[] = [];
  readonly #workspacePath: string;
  readonly #handleFactory:
    ((request: AgentStartRequest | AgentResumeRequest) => AgentRunHandle) | undefined;
  public resumeAvailable = true;

  public constructor(
    workspacePath: string,
    handleFactory?: (request: AgentStartRequest | AgentResumeRequest) => AgentRunHandle,
  ) {
    this.#workspacePath = workspacePath;
    this.#handleFactory = handleFactory;
  }

  public probe(): Promise<AgentAdapterProbe> {
    return Promise.resolve({
      contractVersion: 1,
      adapterId: this.adapterId,
      provider: this.provider,
      installed: true,
      version: "1.2.3",
      compatibility: "tested",
      auth: { state: "ready" },
      capabilities: {
        start: true,
        resume: this.resumeAvailable,
        streaming: true,
        cancellation: true,
        approvalBridge: false,
        steering: false,
        checkpointContinuation: true,
        workspaceIsolation: ["none"],
      },
      diagnostics: [],
    });
  }

  public listModels(): Promise<AgentModelCatalog> {
    return Promise.resolve({
      observedAt: "2026-07-25T00:00:00.000Z",
      models: [
        {
          modelId: "gpt-fixture",
          displayName: "GPT Fixture",
          isDefault: true,
          supportedEfforts: ["high"],
        },
      ],
    });
  }

  public start(request: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(request);
    return Promise.resolve(
      this.#handleFactory?.(request) ??
        this.#successfulHandle(
          request,
          request.continuationOf === undefined
            ? "native-session-release"
            : "native-session-continuation",
        ),
    );
  }

  public resume(request: AgentResumeRequest): Promise<AgentRunHandle> {
    this.resumes.push(request);
    return Promise.resolve(
      this.#handleFactory?.(request) ??
        this.#successfulHandle(request, request.session.nativeSessionId),
    );
  }

  #successfulHandle(
    request: AgentStartRequest | AgentResumeRequest,
    nativeSessionId: string,
  ): AgentRunHandle {
    const session = nativeSessionFor(request, this.#workspacePath, nativeSessionId);
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "public_message",
          role: "assistant",
          text: "Repository inspection completed.",
        },
        {
          sequence: 3,
          observedAt: "2026-07-25T00:00:02.000Z",
          type: "completed",
          status: "succeeded",
        },
      ]),
      result: Promise.resolve({
        status: "succeeded",
        session,
        finalText: "Repository inspection completed.",
      }),
      cancel: () => Promise.resolve(),
    };
  }
}

class StartFailingAdapter extends RecordingAdapter {
  public override start(request: AgentStartRequest): Promise<AgentRunHandle> {
    this.starts.push(request);
    return Promise.reject(new Error("private provider launch failure"));
  }
}

async function* events(
  values: readonly NormalizedAgentEvent[],
): AsyncGenerator<NormalizedAgentEvent> {
  yield* values;
}

function nativeSessionFor(
  request: AgentStartRequest | AgentResumeRequest,
  workspacePath: string,
  nativeSessionId = "native-session-release",
): NativeSessionReference {
  const continuation = request.operation === "start" ? request.continuationOf : undefined;
  const continuationReason = request.operation === "start" ? request.continuationReason : undefined;
  if (continuation !== undefined && continuationReason === undefined) {
    throw new Error("The continuation fixture requires an explicit reason.");
  }
  return {
    schemaVersion: 1,
    provider: "codex",
    adapterId: "codex-fixture",
    adapterVersion: "1.2.3",
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    nativeSessionId,
    sessionKey: request.sessionKey,
    taskId: request.taskId,
    workstreamId: request.workstreamId,
    deviceId: request.deviceId,
    workspaceId: request.workspace.workspaceId,
    cwd: workspacePath,
    lineage:
      continuation === undefined
        ? {
            lineageId: `lineage-${request.taskId}`,
          }
        : {
            lineageId: `lineage-${request.taskId}-continuation`,
            parentNativeSessionId: continuation.nativeSessionId,
            continuationReason: continuationReason ?? "unreachable",
          },
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

function observedAgentSession(nativeSessionId: string) {
  return {
    provider: "codex" as const,
    adapterId: "codex-fixture",
    adapterVersion: "1.2.3",
    nativeSessionId,
    workstreamId: "repository-inspection",
    workspaceId: "workspace-repository",
    lineage: {
      lineageId: "lineage-task-release",
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("Timed out waiting for the Agent bridge.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("an assignment Agent requirement cannot be silently substituted and reports safe lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-binding-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve(
          executionPlan(
            `${current.workOrder.brief}\nPRIVATE-KNOWLEDGE-SENTINEL C:\\Users\\worker\\Knowledge\\private.md`,
          ),
        ),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    await assert.rejects(
      factory.start(
        executionContext(
          assignment("run-provider-mismatch", "work-order-provider-mismatch", {
            agentRequirement: {
              provider: "claude",
              allowedCompatibilities: ["tested"],
            },
          }),
        ),
      ),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "AGENT_REQUIREMENT_UNAVAILABLE",
    );
    await assert.rejects(
      factory.start(
        executionContext(
          assignment("run-adapter-mismatch", "work-order-adapter-mismatch", {
            agentRequirement: {
              provider: "codex",
              adapterId: "codex-app-server",
              allowedCompatibilities: ["tested"],
            },
          }),
        ),
      ),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "AGENT_REQUIREMENT_UNAVAILABLE",
    );
    await assert.rejects(
      factory.start(
        executionContext(
          assignment("run-compatibility-mismatch", "work-order-compatibility-mismatch", {
            agentRequirement: {
              provider: "codex",
              adapterId: "codex-fixture",
              allowedCompatibilities: ["untested"],
            },
          }),
        ),
      ),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "AGENT_REQUIREMENT_UNAVAILABLE",
    );
    assert.equal(adapter.starts.length, 0);

    const process = await factory.start(
      executionContext(
        assignment("run-provider-bound", "work-order-provider-bound", {
          agentRequirement: {
            provider: "codex",
            adapterId: "codex-fixture",
            allowedCompatibilities: ["tested"],
          },
        }),
      ),
    );
    const outcome = await process.completion;
    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(outcome.agentSession, {
      provider: "codex",
      adapterId: "codex-fixture",
      adapterVersion: "1.2.3",
      nativeSessionId: "native-session-release",
      workstreamId: "repository-inspection",
      workspaceId: "workspace-repository",
      lineage: {
        lineageId: "lineage-task-release",
      },
    });
    assert.equal(JSON.stringify(outcome.agentSession).includes("sessionKey"), false);
    assert.equal(JSON.stringify(outcome.agentSession).includes("cwd"), false);
    assert.equal(JSON.stringify(outcome.agentSession).includes("worktreePath"), false);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit model and effort survive Worker session validation and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-model-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(current.workOrder.brief),
          modelId: "gpt-fixture",
          effort: "high",
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(
        assignment("run-model-bound", "work-order-model-bound", {
          agentRequirement: {
            provider: "codex",
            adapterId: "codex-fixture",
            modelId: "gpt-fixture",
            effort: "high",
            allowedCompatibilities: ["tested"],
          },
        }),
      ),
    );
    const outcome = await process.completion;

    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.agentSession?.modelId, "gpt-fixture");
    assert.equal(outcome.agentSession?.effort, "high");
    const request = adapter.starts[0]!;
    assert.equal(request.modelId, "gpt-fixture");
    assert.equal(request.effort, "high");
    const stored = await sessionStore.load(request.sessionKey);
    assert.equal(stored?.modelId, "gpt-fixture");
    assert.equal(stored?.effort, "high");
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported live steering is injected once into the next exact native-session resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-steering-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const filename = join(runtimeDirectory, "worker.sqlite");
  const adapter = new RecordingAdapter(workspacePath);
  const createFactory = (sessionStore: SqliteNativeSessionReferenceStore) =>
    new AgentRunProcessFactory({
      adapters: [adapter],
      sessionStore,
      executionPlanResolver: {
        resolve: ({ assignment: current }) =>
          Promise.resolve(executionPlan(current.workOrder.brief)),
      },
      workspaceResolver: {
        resolve: () =>
          Promise.resolve({
            workspaceId: "workspace-repository",
            cwd: workspacePath,
            isolation: "none",
          }),
      },
    });
  const firstStore = new SqliteNativeSessionReferenceStore({
    filename,
    sourceCheckoutDirectory: checkout,
  });

  try {
    const firstProcess = await createFactory(firstStore).start(
      executionContext(assignment("run-steering-source", "work-order-steering-source")),
    );
    assert.equal((await firstProcess.completion).status, "succeeded");
    const start = adapter.starts[0]!;
    const session = await firstStore.load(start.sessionKey);
    assert.notEqual(session, undefined);
    await firstStore.queueSteeringInstruction({
      schemaVersion: 1,
      requestId: "steer-next-resume-1",
      sourceRunId: "run-steering-source",
      sessionKey: session!.sessionKey,
      nativeSessionId: session!.nativeSessionId,
      taskId: session!.taskId,
      workstreamId: session!.workstreamId,
      deviceId: session!.deviceId,
      workspaceId: session!.workspaceId,
      provider: session!.provider,
      adapterId: session!.adapterId,
      instruction: "Also verify the release manifest before reporting.",
      requestedBy: "owner",
      queuedAt: "2026-07-25T00:03:00.000Z",
    });
    firstStore.close();

    const restartedStore = new SqliteNativeSessionReferenceStore({
      filename,
      sourceCheckoutDirectory: checkout,
    });
    const resumed = await createFactory(restartedStore).start(
      executionContext(assignment("run-steering-resume", "work-order-steering-resume")),
    );
    assert.equal((await resumed.completion).status, "succeeded");
    const resume = adapter.resumes[0]!;
    assert.match(resume.prompt, /Pending OpenDelegate steering/u);
    assert.match(resume.prompt, /steer-next-resume-1/u);
    assert.match(resume.prompt, /Also verify the release manifest before reporting\./u);
    assert.equal(resume.prompt.includes(session!.sessionKey), false);
    assert.deepEqual(await restartedStore.loadPendingSteeringInstructions(session!.sessionKey), []);

    const third = await createFactory(restartedStore).start(
      executionContext(assignment("run-steering-third", "work-order-steering-third")),
    );
    assert.equal((await third.completion).status, "succeeded");
    assert.equal(adapter.resumes[1]!.prompt.includes("steer-next-resume-1"), false);
    restartedStore.close();
  } finally {
    firstStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a related follow-up resumes its Task workstream session after Worker restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const filename = join(runtimeDirectory, "worker.sqlite");
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    const resumed = request.operation === "resume";
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "public_message",
          role: "assistant",
          text: resumed ? "Signed cache" : "Repository inspection completed.",
        },
      ]),
      result: Promise.resolve({
        status: "succeeded",
        session,
        finalText: resumed ? "Safe resumed result." : "Repository inspection completed.",
      }),
      cancel: () => Promise.resolve(),
    };
  });
  let initialContextCalls = 0;
  const resolvedLeaseAuthorities: WorkerRunLeaseAuthority[] = [];
  const createFactory = (sessionStore: SqliteNativeSessionReferenceStore) =>
    new AgentRunProcessFactory({
      adapters: [adapter],
      sessionStore,
      executionPlanResolver: {
        resolve: (context) => {
          resolvedLeaseAuthorities.push(context.leaseAuthority);
          return Promise.resolve(executionPlan(context.assignment.workOrder.brief));
        },
      },
      workspaceResolver: {
        resolve: () =>
          Promise.resolve({
            workspaceId: "workspace-repository",
            cwd: workspacePath,
            isolation: "none",
          }),
      },
      initialContextProvider: {
        prepare: async () => {
          initialContextCalls += 1;
          return {
            prompt: "Device-local Knowledge: use the signed cache.",
            knowledgeSources: {
              noteIds: ["signed-cache.md"],
              titles: ["Signed cache"],
              contents: ["Use the signed cache on this Device."],
            },
          };
        },
      },
    });

  try {
    const firstStore = new SqliteNativeSessionReferenceStore({
      filename,
      sourceCheckoutDirectory: checkout,
    });
    const firstContext = executionContext(assignment("run-1", "work-order-1"));
    const first = await createFactory(firstStore).start(firstContext);
    assert.equal(resolvedLeaseAuthorities[0], firstContext.leaseAuthority);
    assert.deepEqual(await first.completion, {
      status: "succeeded",
      report: "Repository inspection completed.",
      artifactIds: [],
      agentSession: observedAgentSession("native-session-release"),
    });
    firstStore.close();

    const reopenedStore = new SqliteNativeSessionReferenceStore({
      filename,
      sourceCheckoutDirectory: checkout,
    });
    const followUp = await createFactory(reopenedStore).start(
      executionContext(assignment("run-2", "work-order-2")),
    );
    const followUpOutcome = await followUp.completion;
    assert.equal(followUpOutcome.status, "succeeded");
    assert.equal(followUpOutcome.report.includes("Signed cache"), false);
    assert.match(followUpOutcome.report, /Knowledge content withheld/u);
    assert.match(followUpOutcome.report, /Safe resumed result/u);
    reopenedStore.close();

    assert.equal(adapter.starts.length, 1);
    assert.equal(adapter.resumes.length, 1);
    assert.equal(initialContextCalls, 1);
    assert.match(adapter.starts[0]?.prompt ?? "", /Device-local Knowledge/u);
    assert.doesNotMatch(adapter.resumes[0]?.prompt ?? "", /Device-local Knowledge/u);
    assert.equal(
      adapter.resumes[0]?.session.nativeSessionId,
      adapter.starts[0] === undefined ? undefined : "native-session-release",
    );
    assert.equal(adapter.resumes[0]?.workstreamId, "repository-inspection");
    assert.equal(adapter.resumes[0]?.taskId, "task-release");
    assert.equal(adapter.resumes[0]?.workspace.cwd, workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run-scoped OpenDelegate tool servers reach only the exact Agent turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-tools-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const toolServers = [
    {
      serverName: "opendelegate",
      command: process.execPath,
      args: ["opendelegate-worker-tools.mjs", "--capability-file", join(runtimeDirectory, "cap")],
      enabledTools: ["computer_use_capture"],
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 30_000,
    },
  ] as const;
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(current.workOrder.brief),
          toolServers,
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-tools", "work-order-tools")),
    );
    assert.equal((await process.completion).status, "succeeded");
    assert.deepEqual(adapter.starts[0]?.toolServers, toolServers);
    assert.notEqual(adapter.starts[0]?.toolServers, toolServers);
    assert.notEqual(adapter.starts[0]?.toolServers?.[0]?.args, toolServers[0].args);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral Run capability servers are disposed after the exact Agent turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-capability-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  let prepared = 0;
  let disposed = 0;
  let planAuthorityCurrent = false;
  const actionAuthorization = {
    authorizeAndConsume: () =>
      Promise.resolve({
        decision: "allow" as const,
        reasonCode: "POLICY_SAFE_OBSERVATION",
      }),
  };
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: async ({ assignment: current, isExecutionCurrent }) => {
        planAuthorityCurrent = await isExecutionCurrent();
        return {
          ...executionPlan(current.workOrder.brief),
          permissions: {
            mode: "allow-listed",
            allowedTools: ["Read"],
            actionAuthorization,
          },
        };
      },
    },
    runCapabilityProvider: {
      prepare(context) {
        prepared += 1;
        assert.equal(context.assignment.runId, "run-capability");
        return Promise.resolve({
          toolServers: [
            {
              serverName: "opendelegate_computer_use",
              command: process.execPath,
              args: [
                "opendelegate-worker-tools.mjs",
                "--capability-file",
                join(runtimeDirectory, "capability.json"),
              ],
              enabledTools: ["computer_use_capture"],
              startupTimeoutMs: 5_000,
              toolTimeoutMs: 30_000,
            },
          ],
          async dispose() {
            disposed += 1;
          },
        });
      },
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-capability", "work-order-capability")),
    );
    assert.equal(prepared, 1);
    assert.equal(disposed, 0);
    assert.equal(planAuthorityCurrent, true);
    assert.deepEqual(
      adapter.starts[0]?.toolServers?.map((server) => server.serverName),
      ["opendelegate_computer_use"],
    );
    assert.deepEqual(adapter.starts[0]?.permissions.allowedTools, [
      "Read",
      "mcp__opendelegate_computer_use__computer_use_capture",
    ]);
    assert.equal(adapter.starts[0]?.permissions.actionAuthorization, actionAuthorization);
    assert.equal((await process.completion).status, "succeeded");
    assert.equal(disposed, 1);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral Run capabilities are revoked when the Agent Adapter cannot start", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-capability-failure-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  let disposed = 0;
  const factory = new AgentRunProcessFactory({
    adapters: [new StartFailingAdapter(workspacePath)],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    runCapabilityProvider: {
      prepare: () =>
        Promise.resolve({
          toolServers: [
            {
              serverName: "opendelegate_computer_use",
              command: process.execPath,
              args: ["worker-tools.mjs", "--capability-file", join(runtimeDirectory, "cap.json")],
              enabledTools: ["computer_use_capture"],
              startupTimeoutMs: 5_000,
              toolTimeoutMs: 30_000,
            },
          ],
          async dispose() {
            disposed += 1;
          },
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    await assert.rejects(
      factory.start(executionContext(assignment("run-failed-start", "work-order-failed-start"))),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "ADAPTER_START_FAILED",
    );
    assert.equal(disposed, 1);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral Run capabilities are revoked when authority changes immediately before Agent start", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-capability-race-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  let disposed = 0;
  let authorityChecks = 0;
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    runCapabilityProvider: {
      prepare: () =>
        Promise.resolve({
          toolServers: [
            {
              serverName: "opendelegate_computer_use",
              command: process.execPath,
              args: ["worker-tools.mjs", "--capability-file", join(runtimeDirectory, "cap.json")],
              enabledTools: ["computer_use_capture"],
              startupTimeoutMs: 5_000,
              toolTimeoutMs: 30_000,
            },
          ],
          async dispose() {
            disposed += 1;
          },
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-authority-race", "work-order-authority-race"), () => {
        authorityChecks += 1;
        return Promise.resolve(authorityChecks < 5);
      }),
    );

    assert.deepEqual(await process.completion, {
      status: "failed",
      report: "The agent Run did not start because its Worker execution lease was not current.",
      diagnostic: {
        code: "RUN_AUTHORITY_LOST",
        stage: "lease",
        retryable: true,
      },
    });
    assert.equal(adapter.starts.length, 0);
    assert.equal(disposed, 1);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider token and monetary usage is preserved as integer Worker Budget evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-usage-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath, "native-session-usage");
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "usage",
          usage: {
            inputTokens: 120,
            outputTokens: 80,
            cachedInputTokens: 20,
            costUsd: 0.0042,
          },
        },
        {
          sequence: 3,
          observedAt: "2026-07-25T00:00:02.000Z",
          type: "completed",
          status: "succeeded",
        },
      ]),
      result: Promise.resolve({
        status: "succeeded",
        session,
        finalText: "Usage-aware work completed.",
        usage: {
          inputTokens: 120,
          outputTokens: 80,
          cachedInputTokens: 20,
          costUsd: 0.0042,
        },
      }),
      cancel: () => Promise.resolve(),
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: (context) => Promise.resolve(executionPlan(context.assignment.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const boundedAssignment = assignment("run-usage", "work-order-usage", {
      workOrder: {
        ...workOrder("work-order-usage"),
        budgetLimits: {
          wallTimeMs: { hard: 1_000 },
          idleTimeMs: { hard: 500 },
        },
      },
    });
    const process = await factory.start(executionContext(boundedAssignment));
    assert.deepEqual(await process.completion, {
      status: "succeeded",
      report: "Usage-aware work completed.",
      artifactIds: [],
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cachedInputTokens: 20,
        costUsdMicros: 4_200,
      },
      agentSession: observedAgentSession("native-session-usage"),
    });
    assert.equal(adapter.starts[0]?.limits.wallTimeoutMs, 1_000);
    assert.equal(adapter.starts[0]?.limits.idleTimeoutMs, 500);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful native Run promotes its declared Artifacts before terminal success", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-promotion-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const calls: string[] = [];
  const artifactLifecycle: WorkerArtifactLifecycle = {
    prepare(input) {
      calls.push(`prepare:${input.assignment.runId}:${input.workspace.workspaceId}`);
      return Promise.resolve({
        schemaVersion: 1,
        outputRoot: join(runtimeDirectory, "artifacts", input.assignment.runId),
        manifestPath: join(
          runtimeDirectory,
          "artifacts",
          input.assignment.runId,
          "manifest.v1.json",
        ),
        assignmentFingerprint: input.assignmentFingerprint,
      });
    },
    promote(input) {
      calls.push(`promote:${input.assignment.runId}:${input.plan.assignmentFingerprint}`);
      return Promise.resolve(["artifact-report", "artifact-screenshot"]);
    },
  };
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    artifactLifecycle,
    runCapabilityProvider: artifactRunCapabilityProvider(),
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-artifacts", "work-order-artifacts")),
    );
    assert.deepEqual(await process.completion, {
      status: "succeeded",
      report: "Repository inspection completed.",
      artifactIds: ["artifact-report", "artifact-screenshot"],
      agentSession: observedAgentSession("native-session-release"),
    });
    assert.equal(calls[0], "prepare:run-artifacts:workspace-repository");
    assert.match(calls[1] ?? "", /^promote:run-artifacts:[a-f0-9]{64}$/u);
    assert.equal(adapter.starts[0]?.environment?.["OPENDELEGATE_ARTIFACT_OUTPUT_ROOT"], undefined);
    assert.equal(adapter.starts[0]?.environment?.["OPENDELEGATE_ARTIFACT_MANIFEST"], undefined);
    assert.match(adapter.starts[0]?.prompt ?? "", /Artifact output contract/u);
    assert.match(
      adapter.starts[0]?.prompt ?? "",
      /mcp__opendelegate-artifact__artifact_write_chunk/u,
    );
    assert.match(adapter.starts[0]?.prompt ?? "", /mcp__opendelegate-artifact__artifact_commit/u);
    assert.equal(
      adapter.starts[0]?.environment?.["OPENDELEGATE_ARTIFACT_ASSIGNMENT_FINGERPRINT"],
      undefined,
    );
    assert.equal(adapter.starts[0]?.prompt?.includes(runtimeDirectory), false);
    assert.doesNotMatch(adapter.starts[0]?.prompt ?? "", /[a-f0-9]{64}/u);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker terminal success remains pending until Artifact promotion is durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-promotion-wait-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  let finishPromotion!: () => void;
  const promotionBarrier = new Promise<void>((resolve) => {
    finishPromotion = resolve;
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    runCapabilityProvider: artifactRunCapabilityProvider(),
    artifactLifecycle: {
      prepare(input) {
        const outputRoot = join(runtimeDirectory, "artifacts", input.assignment.runId);
        return Promise.resolve({
          schemaVersion: 1,
          outputRoot,
          manifestPath: join(outputRoot, "manifest.v1.json"),
          assignmentFingerprint: input.assignmentFingerprint,
        });
      },
      async promote() {
        await promotionBarrier;
        return ["artifact-durable"];
      },
    },
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-promotion-wait", "work-order-promotion-wait")),
    );
    let settled = false;
    void process.completion.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    finishPromotion();
    assert.deepEqual(await process.completion, {
      status: "succeeded",
      report: "Repository inspection completed.",
      artifactIds: ["artifact-durable"],
      agentSession: observedAgentSession("native-session-release"),
    });
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Artifact egress denial is non-retryable and never leaks local diagnostics into the Run report", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-promotion-fail-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    runCapabilityProvider: artifactRunCapabilityProvider(),
    artifactLifecycle: {
      prepare(input) {
        const outputRoot = join(runtimeDirectory, "artifacts", input.assignment.runId);
        return Promise.resolve({
          schemaVersion: 1,
          outputRoot,
          manifestPath: join(outputRoot, "manifest.v1.json"),
          assignmentFingerprint: input.assignmentFingerprint,
        });
      },
      promote() {
        return Promise.reject(
          Object.assign(new Error("private-local-path C:\\secret\\report.txt"), {
            code: "EGRESS_DENIED",
            egressReason: "secret",
          }),
        );
      },
    },
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-promotion-fail", "work-order-promotion-fail")),
    );
    const outcome = await process.completion;
    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.diagnostic, {
      code: "ARTIFACT_EGRESS_DENIED",
      stage: "artifact",
      retryable: false,
    });
    assert.equal(outcome.report.includes("private-local-path"), false);
    assert.equal("artifactIds" in outcome, false);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a related follow-up starts an explicit bounded continuation when native resume is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-continuation-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const adapter = new RecordingAdapter(workspacePath);
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const first = await factory.start(
      executionContext(assignment("run-original", "work-original")),
    );
    assert.equal((await first.completion).status, "succeeded");

    adapter.resumeAvailable = false;
    const continued = await factory.start(
      executionContext(
        assignment("run-continuation", "work-continuation", {
          continuationCheckpoint: continuationCheckpoint("task-release", "work-continuation"),
        }),
      ),
    );
    assert.equal((await continued.completion).status, "succeeded");

    assert.equal(adapter.resumes.length, 0);
    assert.equal(adapter.starts.length, 2);
    const request = adapter.starts[1];
    assert.equal(request?.continuationOf?.nativeSessionId, "native-session-release");
    assert.equal(request?.continuationReason, "native-session-resume-unavailable");
    assert.match(request?.prompt ?? "", /Durable checkpoint continuation package/u);
    assert.match(request?.prompt ?? "", /"workOrderId":"work-continuation"/u);
    assert.match(request?.prompt ?? "", /Authoritative public continuation message/u);
    assert.match(request?.prompt ?? "", /"checkpointHash":"sha256:[0-9a-f]{64}"/u);
    assert.doesNotMatch(request?.prompt ?? "", /PRIVATE-KNOWLEDGE-SENTINEL/u);
    assert.doesNotMatch(request?.prompt ?? "", /C:\\Users\\worker/u);
    const stored = await sessionStore.load(request?.sessionKey ?? "missing");
    assert.equal(stored?.nativeSessionId, "native-session-continuation");
    assert.equal(stored?.lineage.parentNativeSessionId, "native-session-release");
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

function continuationCheckpoint(taskId: string, workOrderId: string): TaskContinuationCheckpointV1 {
  return createTaskContinuationCheckpoint({
    schemaVersion: 1,
    taskId,
    taskVersion: 3,
    summary: {
      state: "running",
      mode: "auto",
      objective: "Finish the release Work Order.",
      rollingSummary: "The Task is waiting for the related Worker follow-up.",
      completionCriteria: ["Return a concise result."],
      constraints: ["Do not modify unrelated files."],
    },
    decisions: [],
    pendingWorkOrders: [
      {
        workOrderId,
        title: "Continue the related Work Order",
        brief: "Inspect current Workspace state and continue safely.",
        completionCriteria: ["Return a concise result."],
        constraints: ["Do not modify unrelated files."],
        dependsOn: [],
        requiredCapabilities: ["codex"],
        omitted: {
          completionCriteria: 0,
          constraints: 0,
          dependsOn: 0,
          requiredCapabilities: 0,
        },
        workspaceId: "workspace-repository",
      },
    ],
    artifacts: [],
    messages: [
      {
        messageId: "message-authoritative-continuation",
        role: "agent",
        content: "Authoritative public continuation message.",
        occurredAt: "2026-07-25T00:00:00.000Z",
      },
    ],
    sessions: [],
    omitted: {
      completionCriteria: 0,
      constraints: 0,
      decisions: 0,
      pendingWorkOrders: 0,
      artifacts: 0,
      messages: 0,
      sessions: 0,
    },
  });
}

test("Task identity isolates native sessions while policy, limits, and Workspace stay explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(`Task ${current.taskId}: ${current.workOrder.brief}`),
          sandbox: "workspace-write",
          permissions: {
            mode: "allow-listed",
            allowedTools: ["repo.read", "repo.write"],
            deniedTools: ["network.mutate"],
          },
        }),
    },
    workspaceResolver: {
      resolve: ({ workspaceId }) =>
        Promise.resolve({
          workspaceId: workspaceId ?? "unexpected-workspace",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const first = await factory.start(executionContext(assignment("run-a", "work-order-a")));
    assert.equal((await first.completion).status, "succeeded");
    const second = await factory.start(
      executionContext(
        assignment("run-b", "work-order-b", {
          taskId: "task-unrelated",
        }),
      ),
    );
    assert.equal((await second.completion).status, "succeeded");

    assert.equal(adapter.starts.length, 2);
    assert.equal(adapter.resumes.length, 0);
    assert.notEqual(adapter.starts[0]?.sessionKey, adapter.starts[1]?.sessionKey);
    assert.equal(adapter.starts[1]?.prompt.startsWith("Task task-unrelated:"), true);
    assert.deepEqual(adapter.starts[1]?.permissions, {
      mode: "allow-listed",
      allowedTools: ["repo.read", "repo.write"],
      deniedTools: ["network.mutate"],
    });
    assert.deepEqual(adapter.starts[1]?.limits, AGENT_LIMITS);
    assert.equal(adapter.starts[1]?.workspace.cwd, workspacePath);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a dangerous provider bypass fails closed without an exact Task grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const adapter = new RecordingAdapter(workspacePath);
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(current.workOrder.brief),
          sandbox: "danger-full-access",
          permissions: {
            mode: "bypass",
            dangerousBypassGrant: {
              grantId: "grant-wrong-task",
              grantedBy: "owner",
              scope: "task",
              taskId: "task-unrelated",
            },
          },
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    await assert.rejects(
      factory.start(executionContext(assignment("run-bypass", "work-order-bypass"))),
      (error: unknown) =>
        error instanceof AgentRunBridgeError && error.code === "INVALID_EXECUTION_PLAN",
    );
    assert.equal(adapter.starts.length, 0);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease loss cancels the native turn and cannot produce a successful Worker report", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  let resolveEvents!: () => void;
  let resolveResult!: (result: Awaited<AgentRunHandle["result"]>) => void;
  const eventDone = new Promise<void>((resolve) => {
    resolveEvents = resolve;
  });
  const result = new Promise<Awaited<AgentRunHandle["result"]>>((resolve) => {
    resolveResult = resolve;
  });
  const cancelReasons: string[] = [];
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    return {
      events: (async function* () {
        yield {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        } satisfies NormalizedAgentEvent;
        await eventDone;
      })(),
      result,
      cancel(reason) {
        cancelReasons.push(reason ?? "");
        resolveEvents();
        resolveResult({
          status: "cancelled",
          session,
          finalText: "This stale success must not be accepted.",
        });
        return Promise.resolve();
      },
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
    limits: {
      leaseCheckIntervalMs: 2,
    },
  });
  let current = true;

  try {
    const process = await factory.start(
      executionContext(assignment("run-lease", "work-order-lease"), () => Promise.resolve(current)),
    );
    current = false;
    await waitFor(() => cancelReasons.length === 1);
    const outcome = await process.completion;

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.report.includes("stale success"), false);
    assert.deepEqual(outcome.diagnostic, {
      code: "RUN_AUTHORITY_LOST",
      stage: "lease",
      retryable: true,
    });
    assert.equal(cancelReasons[0], "The Worker execution lease was lost.");
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker cancellation delegates bounded termination to the Agent Adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  let resolveEvents!: () => void;
  let resolveResult!: (result: Awaited<AgentRunHandle["result"]>) => void;
  const eventDone = new Promise<void>((resolve) => {
    resolveEvents = resolve;
  });
  const result = new Promise<Awaited<AgentRunHandle["result"]>>((resolve) => {
    resolveResult = resolve;
  });
  const cancelReasons: string[] = [];
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    return {
      events: (async function* () {
        yield {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        } satisfies NormalizedAgentEvent;
        await eventDone;
      })(),
      result,
      cancel(reason) {
        cancelReasons.push(reason ?? "");
        resolveEvents();
        resolveResult({ status: "cancelled", session });
        return Promise.resolve();
      },
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-cancel", "work-order-cancel")),
    );
    await process.requestCancel();
    await process.forceTerminate();
    const outcome = await process.completion;

    assert.equal(outcome.status, "failed");
    assert.deepEqual(outcome.diagnostic, {
      code: "PROCESS_CANCELLED",
      stage: "cancellation",
      retryable: true,
    });
    assert.deepEqual(cancelReasons, ["The Worker Run was cancelled."]);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("public reports are bounded and redact local Secret values and common encodings", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const secret = "owner-token+/=private";
  const encoded = Buffer.from(secret).toString("base64");
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "message_delta",
          text: "PRIVATE_DELTA",
        },
        {
          sequence: 3,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "tool_request",
          toolName: "internal.fixture",
          input: {
            privateValue: "PRIVATE_TOOL_INPUT",
          },
        },
        {
          sequence: 4,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "public_message",
          role: "assistant",
          text: `${secret} ${encodeURIComponent(secret)} ${encoded} ${"x".repeat(800)}`,
        },
      ]),
      result: Promise.resolve({
        status: "succeeded",
        session,
        finalText: `${secret} ${"y".repeat(800)}`,
      }),
      cancel: () => Promise.resolve(),
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(current.workOrder.brief),
          secretEnvironment: {
            OPENDELEGATE_FIXTURE_TOKEN: secret,
          },
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
    limits: {
      maxPublicMessages: 1,
      maxReportBytes: 256,
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-redact", "work-order-redact")),
    );
    const outcome = await process.completion;
    assert.equal(outcome.status, "succeeded");
    assert.equal(Buffer.byteLength(outcome.report, "utf8") <= 256, true);
    assert.equal(outcome.report.includes(secret), false);
    assert.equal(outcome.report.includes(encodeURIComponent(secret)), false);
    assert.equal(outcome.report.includes(encoded), false);
    assert.equal(outcome.report.includes("[REDACTED]"), true);
    assert.equal(outcome.report.includes("PRIVATE_DELTA"), false);
    assert.equal(outcome.report.includes("PRIVATE_TOOL_INPUT"), false);
    assert.equal(outcome.report.endsWith("[Report truncated by OpenDelegate.]"), true);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("selected Knowledge path, title, and body cannot enter the public Worker report", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-knowledge-egress-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const pathSentinel = "private/KNOWLEDGE_PATH_SENTINEL.md";
  const titleSentinel = "KNOWLEDGE_TITLE_SENTINEL";
  const bodySentinel =
    "Use KNOWLEDGE_BODY_SENTINEL with the private signed cache before packaging.";
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "public_message",
          role: "assistant",
          text: `${pathSentinel}\n${titleSentinel}`,
        },
        {
          sequence: 3,
          observedAt: "2026-07-25T00:00:02.000Z",
          type: "public_message",
          role: "assistant",
          text: bodySentinel,
        },
      ]),
      result: Promise.resolve({
        status: "succeeded",
        session,
        finalText: "Release checks completed safely.",
      }),
      cancel: () => Promise.resolve(),
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
    initialContextProvider: {
      async prepare() {
        return {
          prompt: `## Device-local Knowledge\n\n### ${titleSentinel}\n\n${bodySentinel}`,
          knowledgeSources: {
            noteIds: [pathSentinel],
            titles: [titleSentinel],
            contents: [bodySentinel],
          },
        };
      },
    },
  });

  try {
    const outcome = await (
      await factory.start(
        executionContext(assignment("run-knowledge-egress", "work-order-knowledge-egress")),
      )
    ).completion;
    assert.equal(outcome.status, "succeeded");
    for (const sentinel of [pathSentinel, titleSentinel, bodySentinel]) {
      assert.equal(outcome.report.includes(sentinel), false);
    }
    assert.match(outcome.report, /Knowledge content withheld/u);
    assert.match(outcome.report, /Release checks completed safely/u);
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed native turn returns only bounded redacted public failure evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const secret = "terminal-provider-secret";
  const adapter = new RecordingAdapter(workspacePath, (request) => {
    const session = nativeSessionFor(request, workspacePath);
    return {
      events: events([
        {
          sequence: 1,
          observedAt: "2026-07-25T00:00:00.000Z",
          type: "session_started",
          session,
        },
        {
          sequence: 2,
          observedAt: "2026-07-25T00:00:01.000Z",
          type: "public_message",
          role: "assistant",
          text: `Unable to complete with ${secret}.`,
        },
      ]),
      result: Promise.resolve({
        status: "failed",
        session,
        error: {
          code: "PROVIDER_FAILED",
          message: `Private diagnostic ${secret}.`,
          retryable: false,
        },
      }),
      cancel: () => Promise.resolve(),
    };
  });
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [adapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) =>
        Promise.resolve({
          ...executionPlan(current.workOrder.brief),
          secretEnvironment: {
            PROVIDER_TOKEN: secret,
          },
        }),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    const process = await factory.start(
      executionContext(assignment("run-terminal-fail", "work-order-terminal-fail")),
    );
    const outcome = await process.completion;

    assert.equal(outcome.status, "failed");
    assert.equal(
      outcome.report,
      "Unable to complete with [REDACTED].\n\nPrivate diagnostic [REDACTED].",
    );
    assert.equal(outcome.report.includes(secret), false);
    assert.deepEqual(outcome.diagnostic, {
      code: "PROCESS_FAILED",
      stage: "execution",
      retryable: false,
    });
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter startup failures do not expose provider internals", async () => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-worker-agent-"));
  const checkout = join(root, "checkout");
  const runtimeDirectory = join(root, "runtime");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(checkout, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const workspacePath = await realpath(workspaceDirectory);
  const secret = "provider-internal-secret";
  const failingAdapter = new RecordingAdapter(workspacePath);
  failingAdapter.start = () => Promise.reject(new Error(`spawn failed: ${secret}`));
  const sessionStore = new SqliteNativeSessionReferenceStore({
    filename: join(runtimeDirectory, "worker.sqlite"),
    sourceCheckoutDirectory: checkout,
  });
  const factory = new AgentRunProcessFactory({
    adapters: [failingAdapter],
    sessionStore,
    executionPlanResolver: {
      resolve: ({ assignment: current }) => Promise.resolve(executionPlan(current.workOrder.brief)),
    },
    workspaceResolver: {
      resolve: () =>
        Promise.resolve({
          workspaceId: "workspace-repository",
          cwd: workspacePath,
          isolation: "none",
        }),
    },
  });

  try {
    await assert.rejects(
      factory.start(executionContext(assignment("run-fail", "work-order-fail"))),
      (error: unknown) =>
        error instanceof AgentRunBridgeError &&
        error.code === "ADAPTER_START_FAILED" &&
        !error.message.includes(secret),
    );
  } finally {
    sessionStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
