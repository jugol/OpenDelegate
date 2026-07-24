import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentAdapterError,
  GenericCommandAdapter,
  InMemorySessionLeaseStore,
  type AgentRunLimits,
  type AgentStartRequest,
  type NormalizedAgentEvent,
} from "../src/index.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-provider.mjs", import.meta.url));
const defaultLimits: AgentRunLimits = {
  wallTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  cancellationGraceMs: 50,
  leaseTtlMs: 500,
  leaseRenewIntervalMs: 100,
  maxBufferedEvents: 4,
  maxLineBytes: 64 * 1024,
  maxDiagnosticBytes: 4 * 1024,
};

function createAdapter(leaseStore = new InMemorySessionLeaseStore()): GenericCommandAdapter {
  return new GenericCommandAdapter({
    adapterId: "generic-lifecycle",
    executable: process.execPath,
    args: [fixturePath, "generic"],
    versionArgs: [fixturePath, "generic", "--version"],
    testedVersions: ["3.4.5"],
    leaseStore,
  });
}

async function createRequest(
  prompt: string,
  overrides: Partial<AgentStartRequest> = {},
): Promise<AgentStartRequest> {
  const cwd = await realpath(process.cwd());
  return {
    operation: "start",
    requestId: "request-lifecycle",
    runId: "run-lifecycle",
    taskId: "task-lifecycle",
    workstreamId: "worker",
    sessionKey: "task-lifecycle/worker",
    deviceId: "device-worker",
    prompt,
    workspace: {
      workspaceId: "workspace-open-delegate",
      cwd,
      isolation: "custom",
    },
    sandbox: "custom",
    permissions: { mode: "allow-listed", allowedTools: ["safe.read"] },
    limits: defaultLimits,
    ...overrides,
  };
}

async function drain(handle: {
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly result: Promise<unknown>;
}): Promise<NormalizedAgentEvent[]> {
  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  await handle.result;
  return events;
}

test("cancellation terminates a running child and resolves with a cancelled result", async () => {
  const adapter = createAdapter();
  const handle = await adapter.start(await createRequest("slow"));
  const iterator = handle.events[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "session_started");

  await handle.cancel("owner cancelled the run");
  const remaining: NormalizedAgentEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      break;
    }
    remaining.push(next.value);
  }
  const result = await handle.result;

  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "ADAPTER_CANCELLED");
  assert.ok(remaining.some((event) => event.type === "completed" && event.status === "cancelled"));
});

test("wall or idle timeout terminates an unresponsive child", async () => {
  const adapter = createAdapter();
  const request = await createRequest("slow", {
    limits: {
      ...defaultLimits,
      wallTimeoutMs: 250,
      idleTimeoutMs: 100,
      leaseTtlMs: 500,
      leaseRenewIntervalMs: 50,
    },
  });
  const handle = await adapter.start(request);
  await drain(handle);
  const result = await handle.result;

  assert.equal(result.status, "timed_out");
  assert.equal(result.error?.code, "ADAPTER_WALL_OR_IDLE_TIMEOUT");
});

test("malformed, oversized, and incomplete provider output fail closed", async (context) => {
  const cases = [
    ["malformed", "MALFORMED_PROVIDER_OUTPUT", defaultLimits],
    ["oversized", "PROVIDER_LINE_TOO_LARGE", { ...defaultLimits, maxLineBytes: 1_024 }],
    ["never-terminal", "INCOMPLETE_PROVIDER_OUTPUT", defaultLimits],
  ] as const;

  for (const [prompt, code, limits] of cases) {
    await context.test(prompt, async () => {
      const adapter = createAdapter();
      const handle = await adapter.start(await createRequest(prompt, { limits }));
      const events = await drain(handle);
      const result = await handle.result;
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, code);
      assert.ok(events.some((event) => event.type === "diagnostic" && event.code === code));
    });
  }
});

test("bounded event streaming preserves ordered output under a slow consumer", async () => {
  const adapter = createAdapter();
  const handle = await adapter.start(
    await createRequest("flood", {
      limits: { ...defaultLimits, maxBufferedEvents: 2 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const events: NormalizedAgentEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const result = await handle.result;
  const progress = events.filter((event) => event.type === "progress");

  assert.equal(result.status, "succeeded");
  assert.equal(progress.length, 50);
  assert.deepEqual(
    progress.map((event) => event.type === "progress" && event.message),
    Array.from({ length: 50 }, (_, index) => `event-${index}`),
  );
});

test("known child credentials are redacted from events, results, and failure diagnostics", async () => {
  const secret = "fixture-super-secret-value";
  const adapter = createAdapter();
  const success = await adapter.start(
    await createRequest("secret", {
      secretEnvironment: { FIXTURE_SECRET: secret },
    }),
  );
  const successEvents = await drain(success);
  const successResult = await success.result;

  assert.doesNotMatch(JSON.stringify({ successEvents, successResult }), new RegExp(secret));
  assert.match(JSON.stringify({ successEvents, successResult }), /\[REDACTED\]/u);

  const failed = await adapter.start(
    await createRequest("exit-failure", {
      runId: "run-failure",
      secretEnvironment: { FIXTURE_SECRET: secret },
    }),
  );
  const failedEvents = await drain(failed);
  const failedResult = await failed.result;
  assert.equal(failedResult.status, "failed");
  assert.doesNotMatch(JSON.stringify({ failedEvents, failedResult }), new RegExp(secret));
});

test("one native session key has one renewable writer lease while unrelated keys stay parallel", async () => {
  const leaseStore = new InMemorySessionLeaseStore();
  const adapter = createAdapter(leaseStore);
  const first = await adapter.start(
    await createRequest("slow", {
      limits: {
        ...defaultLimits,
        wallTimeoutMs: 2_000,
        idleTimeoutMs: 2_000,
        leaseTtlMs: 120,
        leaseRenewIntervalMs: 30,
      },
    }),
  );
  const firstIterator = first.events[Symbol.asyncIterator]();
  await firstIterator.next();
  await new Promise((resolve) => setTimeout(resolve, 200));

  await assert.rejects(
    adapter.start(
      await createRequest("flood", {
        requestId: "request-conflict",
        runId: "run-conflict",
        limits: {
          ...defaultLimits,
          leaseTtlMs: 120,
          leaseRenewIntervalMs: 30,
        },
      }),
    ),
    (error: unknown) => error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_BUSY",
  );

  const unrelated = await adapter.start(
    await createRequest("flood", {
      requestId: "request-unrelated",
      runId: "run-unrelated",
      sessionKey: "task-lifecycle/other-worker",
    }),
  );
  await drain(unrelated);
  assert.equal((await unrelated.result).status, "succeeded");

  await first.cancel();
  for (;;) {
    if ((await firstIterator.next()).done) {
      break;
    }
  }
  assert.equal((await first.result).status, "cancelled");
});

test("secret-like environment keys require the redacted secret channel", async () => {
  const adapter = createAdapter();

  for (const key of ["API_TOKEN", "AWS_ACCESS_KEY_ID", "SIGNING_PRIVATE_KEY"]) {
    await assert.rejects(
      adapter.start(
        await createRequest("flood", {
          environment: { [key]: "must-not-be-plain" },
        }),
      ),
      (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "SECRET_IN_PLAIN_ENVIRONMENT",
    );
  }
});

test("dangerous bypass requires an exact Task-scoped owner or Policy grant", async () => {
  const adapter = createAdapter();
  const withoutGrant = await createRequest("flood", {
    permissions: { mode: "bypass" },
  });

  await assert.rejects(
    adapter.start(withoutGrant),
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "DANGEROUS_BYPASS_GRANT_REQUIRED",
  );

  const withGrant = await adapter.start({
    ...withoutGrant,
    requestId: "request-granted",
    runId: "run-granted",
    permissions: {
      mode: "bypass",
      dangerousBypassGrant: {
        grantId: "grant-1",
        grantedBy: "owner",
        scope: "task",
        taskId: withoutGrant.taskId,
      },
    },
  });
  await drain(withGrant);
  assert.equal((await withGrant.result).status, "succeeded");
});
