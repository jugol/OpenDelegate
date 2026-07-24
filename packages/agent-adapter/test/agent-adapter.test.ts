import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentAdapterError,
  createFakeAgentAdapter,
  type AgentAdapterIdSource,
  type AgentTurnHandle,
  type FakeAgentEventDraft,
} from "../src/index.ts";

function unusedIds(): AgentAdapterIdSource {
  return {
    nextNativeSessionId: () => "unused-native-session",
    nextTurnId: () => "unused-turn",
    nextEventId: () => "unused-event",
    nextCheckpointId: () => "unused-checkpoint",
  };
}

function sequentialIds(): AgentAdapterIdSource {
  let nativeSession = 0;
  let turn = 0;
  let event = 0;
  let checkpoint = 0;
  return {
    nextNativeSessionId: () => `native-session-${++nativeSession}`,
    nextTurnId: () => `turn-${++turn}`,
    nextEventId: () => `event-${++event}`,
    nextCheckpointId: () => `checkpoint-${++checkpoint}`,
  };
}

test("Codex, Claude, and generic command adapters report readiness through one contract", async () => {
  const common = {
    ids: unusedIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  };
  const codex = createFakeAgentAdapter({
    ...common,
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
  });
  const claude = createFakeAgentAdapter({
    ...common,
    provider: "claude",
    probe: {
      ready: false,
      version: "claude-4.5.0",
      authentication: "missing",
    },
  });
  const generic = createFakeAgentAdapter({
    ...common,
    provider: "generic-command",
    probe: {
      ready: true,
      version: "runner-2.0.0",
      authentication: "not-required",
    },
  });

  const probes = await Promise.all([codex.probe(), claude.probe(), generic.probe()]);

  assert.deepEqual(probes, [
    {
      provider: "codex",
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    {
      provider: "claude",
      ready: false,
      version: "claude-4.5.0",
      authentication: "missing",
    },
    {
      provider: "generic-command",
      ready: true,
      version: "runner-2.0.0",
      authentication: "not-required",
    },
  ]);
});

test("session operations reject an unready or unauthenticated adapter", async () => {
  const common = {
    provider: "claude" as const,
    ids: unusedIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  };
  const unready = createFakeAgentAdapter({
    ...common,
    probe: {
      ready: false,
      version: "claude-4.5.0",
      authentication: "ready",
    },
  });
  const unauthenticated = createFakeAgentAdapter({
    ...common,
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "missing",
    },
  });
  const input = {
    taskId: "task-probe",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  };

  await assert.rejects(
    () => unready.startSession(input),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_NOT_READY");
      return true;
    },
  );
  await assert.rejects(
    () => unauthenticated.startSession(input),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_AUTHENTICATION_REQUIRED");
      return true;
    },
  );
});

test("unrelated Tasks get distinct sessions while a related follow-up resumes the original", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const first = await adapter.startSession({
    taskId: "task-first",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "C:\\work\\project",
  });
  const second = await adapter.startSession({
    taskId: "task-second",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "C:\\work\\project",
  });

  const resumed = await adapter.resumeSession({
    nativeSessionId: first.nativeSessionId,
    taskId: "task-first",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "C:\\work\\project",
  });

  assert.notEqual(first.nativeSessionId, second.nativeSessionId);
  assert.deepEqual(first, {
    provider: "codex",
    adapterVersion: "codex-1.2.3",
    nativeSessionId: "native-session-1",
    taskId: "task-first",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "C:\\work\\project",
    createdAt: "2026-07-24T12:00:00.000Z",
    lineage: {
      rootNativeSessionId: "native-session-1",
      parentNativeSessionId: null,
      checkpointId: null,
      generation: 0,
    },
  });
  assert.deepEqual(resumed, first);
});

test("resume rejects a different Device or exact working directory", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const session = await adapter.startSession({
    taskId: "task-bound",
    deviceId: "device-original",
    workspaceId: "workspace-project",
    workingDirectory: "/work/original",
  });
  const mismatches = [
    {
      nativeSessionId: session.nativeSessionId,
      taskId: "task-bound",
      deviceId: "device-other",
      workspaceId: "workspace-project",
      workingDirectory: "/work/original",
    },
    {
      nativeSessionId: session.nativeSessionId,
      taskId: "task-bound",
      deviceId: "device-original",
      workspaceId: "workspace-project",
      workingDirectory: "/work/other",
    },
  ];

  for (const mismatch of mismatches) {
    await assert.rejects(
      () => adapter.resumeSession(mismatch),
      (error: unknown) => {
        assert.equal(error instanceof AgentAdapterError, true);
        assert.equal((error as AgentAdapterError).code, "SESSION_BINDING_MISMATCH");
        return true;
      },
    );
  }
});

test("a turn streams normalized public events without private reasoning", async () => {
  const scriptedEvents = [
    {
      type: "message",
      role: "assistant",
      content: "I will verify the workspace.",
      privateReasoning: "must never leave the adapter",
    },
    {
      type: "progress",
      summary: "Workspace verified.",
    },
    {
      type: "tool-outcome",
      toolKind: "tool",
      name: "read_file",
      status: "succeeded",
      summary: "Read the public configuration.",
      rawTranscript: "must never leave the adapter",
    },
    {
      type: "tool-outcome",
      toolKind: "command",
      name: "test",
      status: "succeeded",
      summary: "All checks passed.",
    },
    {
      type: "approval-request",
      approvalId: "approval-001",
      actionType: "package.install",
      summary: "Install an official project dependency.",
      risk: "low",
    },
    {
      type: "usage",
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.012,
    },
    {
      type: "completed",
      result: "Workspace verification completed.",
    },
  ] as const satisfies readonly (FakeAgentEventDraft & Record<string, unknown>)[];
  const adapter = createFakeAgentAdapter({
    provider: "generic-command",
    probe: {
      ready: true,
      version: "runner-2.0.0",
      authentication: "not-required",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => scriptedEvents,
  });
  const session = await adapter.startSession({
    taskId: "task-events",
    deviceId: "device-worker",
    workspaceId: "workspace-events",
    workingDirectory: "/work/events",
  });

  const turn = await adapter.startTurn({
    session,
    input: "Verify the workspace.",
  });
  const events = [];
  for await (const event of turn.events) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "message",
      "progress",
      "tool-outcome",
      "tool-outcome",
      "approval-request",
      "usage",
      "completed",
    ],
  );
  assert.deepEqual(events[0], {
    eventId: "event-1",
    turnId: "turn-1",
    nativeSessionId: "native-session-1",
    occurredAt: "2026-07-24T12:00:00.000Z",
    type: "message",
    role: "assistant",
    content: "I will verify the workspace.",
  });
  assert.deepEqual(events[2], {
    eventId: "event-3",
    turnId: "turn-1",
    nativeSessionId: "native-session-1",
    occurredAt: "2026-07-24T12:00:00.000Z",
    type: "tool-outcome",
    toolKind: "tool",
    name: "read_file",
    status: "succeeded",
    summary: "Read the public configuration.",
  });
  assert.deepEqual(events[4], {
    eventId: "event-5",
    turnId: "turn-1",
    nativeSessionId: "native-session-1",
    occurredAt: "2026-07-24T12:00:00.000Z",
    type: "approval-request",
    approvalId: "approval-001",
    actionType: "package.install",
    summary: "Install an official project dependency.",
    risk: "low",
  });
  assert.deepEqual(events[5], {
    eventId: "event-6",
    turnId: "turn-1",
    nativeSessionId: "native-session-1",
    occurredAt: "2026-07-24T12:00:00.000Z",
    type: "usage",
    inputTokens: 120,
    outputTokens: 45,
    costUsd: 0.012,
  });
  assert.deepEqual(events[6], {
    eventId: "event-7",
    turnId: "turn-1",
    nativeSessionId: "native-session-1",
    occurredAt: "2026-07-24T12:00:00.000Z",
    type: "completed",
    result: "Workspace verification completed.",
  });
  assert.equal(JSON.stringify(events).includes("privateReasoning"), false);
  assert.equal(JSON.stringify(events).includes("rawTranscript"), false);
});

test("one native session permits only one active writer", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => [
      { type: "progress", summary: "Working." },
      { type: "completed", result: "Done." },
    ],
  });
  const session = await adapter.startSession({
    taskId: "task-single-writer",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });
  const firstTurn = await adapter.startTurn({
    session,
    input: "First turn",
  });

  await assert.rejects(
    () => adapter.startTurn({ session, input: "Concurrent turn" }),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "NATIVE_SESSION_WRITER_BUSY");
      return true;
    },
  );

  const firstTypes: string[] = [];
  for await (const event of firstTurn.events) {
    firstTypes.push(event.type);
  }
  assert.deepEqual(firstTypes, ["progress", "completed"]);
  const followUp = await adapter.startTurn({
    session,
    input: "Follow-up turn",
  });
  const followUpTypes: string[] = [];
  for await (const event of followUp.events) {
    followUpTypes.push(event.type);
  }
  assert.deepEqual(followUpTypes, ["progress", "completed"]);
});

test("turn-script re-entry cannot start a second writer or interleave one native transcript", async () => {
  let reentrantAttempt: Promise<AgentTurnHandle> | undefined;
  const adapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: (input) => {
      if (input.input === "Outer turn") {
        reentrantAttempt = adapter.startTurn({
          session: input.session,
          input: "Reentrant turn",
        });
        return [
          { type: "message", role: "assistant", content: "Outer transcript only." },
          { type: "completed", result: "Outer complete." },
        ];
      }

      return [
        { type: "message", role: "assistant", content: "Interleaved transcript." },
        { type: "completed", result: "Reentrant complete." },
      ];
    },
  });
  const session = await adapter.startSession({
    taskId: "task-reentrant-writer",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });

  const outerTurn = await adapter.startTurn({ session, input: "Outer turn" });

  assert.ok(reentrantAttempt);
  await assert.rejects(
    reentrantAttempt,
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_WRITER_BUSY",
  );

  const transcript: string[] = [];
  for await (const event of outerTurn.events) {
    if (event.type === "message") {
      transcript.push(`message:${event.content}`);
    }
    if (event.type === "completed") {
      transcript.push(`completed:${event.result}`);
    }
  }

  assert.deepEqual(transcript, ["message:Outer transcript only.", "completed:Outer complete."]);
});

test("turn ID generation re-entry cannot start a second writer for one native session", async () => {
  const baseIds = sequentialIds();
  let turnIdCalls = 0;
  let reentrantAttempt: Promise<AgentTurnHandle> | undefined;
  const adapter = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: {
      ...baseIds,
      nextTurnId: () => {
        turnIdCalls += 1;
        if (turnIdCalls === 1) {
          reentrantAttempt = adapter.startTurn({
            session,
            input: "Reentrant turn from ID generation",
          });
          return "turn-outer";
        }
        return "turn-reentrant";
      },
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: (input) => [
      {
        type: "message",
        role: "assistant",
        content:
          input.input === "Outer turn"
            ? "Outer ID-generation transcript only."
            : "Interleaved ID-generation transcript.",
      },
      { type: "completed", result: "Done." },
    ],
  });
  const session = await adapter.startSession({
    taskId: "task-reentrant-id-source",
    deviceId: "device-main",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });

  const outerTurn = await adapter.startTurn({ session, input: "Outer turn" });

  assert.ok(reentrantAttempt);
  await assert.rejects(
    reentrantAttempt,
    (error: unknown) =>
      error instanceof AgentAdapterError && error.code === "NATIVE_SESSION_WRITER_BUSY",
  );
  const transcript: string[] = [];
  for await (const event of outerTurn.events) {
    if (event.type === "message") {
      transcript.push(event.content);
    }
  }
  assert.deepEqual(transcript, ["Outer ID-generation transcript only."]);
});

test("turn ID generation and validation failures roll back the provisional writer", async () => {
  const failures = [
    {
      key: "source-error",
      fail: (): string => {
        throw new Error("Turn ID source failed.");
      },
      matches: (error: unknown) =>
        error instanceof Error && error.message === "Turn ID source failed.",
    },
    {
      key: "invalid-value",
      fail: () => "unsafe\nturn",
      matches: (error: unknown) =>
        error instanceof AgentAdapterError && error.code === "ADAPTER_ID_INVALID",
    },
  ] as const;

  for (const failure of failures) {
    const baseIds = sequentialIds();
    let turnIdCalls = 0;
    const adapter = createFakeAgentAdapter({
      provider: "generic-command",
      probe: {
        ready: true,
        version: "runner-2.0.0",
        authentication: "not-required",
      },
      ids: {
        ...baseIds,
        nextTurnId: () => {
          turnIdCalls += 1;
          return turnIdCalls === 1 ? failure.fail() : `turn-recovered-${failure.key}`;
        },
      },
      clock: { now: () => "2026-07-24T12:00:00.000Z" },
      turnScript: () => [{ type: "completed", result: "Recovered." }],
    });
    const session = await adapter.startSession({
      taskId: `task-${failure.key}`,
      deviceId: "device-worker",
      workspaceId: "workspace-project",
      workingDirectory: "/work/project",
    });

    await assert.rejects(() => adapter.startTurn({ session, input: "Fail once" }), failure.matches);

    const recoveredTurn = await adapter.startTurn({ session, input: "Retry" });
    const recoveredEvents = [];
    for await (const event of recoveredTurn.events) {
      recoveredEvents.push(event.type);
    }
    assert.deepEqual(recoveredEvents, ["completed"]);
  }
});

test("cancellation holds the writer until the old turn emits its terminal event", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => [
      { type: "progress", summary: "Started." },
      { type: "progress", summary: "Still working." },
      { type: "completed", result: "Should not be emitted." },
    ],
  });
  const session = await adapter.startSession({
    taskId: "task-cancel",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });
  const turn = await adapter.startTurn({
    session,
    input: "Long-running work",
  });
  const iterator = turn.events[Symbol.asyncIterator]();

  const first = await iterator.next();
  await turn.cancel();
  await assert.rejects(
    () =>
      adapter.startTurn({
        session,
        input: "Replacement work before cancellation is terminal",
      }),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "NATIVE_SESSION_WRITER_BUSY");
      return true;
    },
  );
  const cancelled = await iterator.next();
  const replacement = await adapter.startTurn({
    session,
    input: "Replacement work after cancellation is terminal",
  });
  await replacement.cancel();

  assert.equal(first.value?.type, "progress");
  assert.deepEqual(cancelled, {
    done: false,
    value: {
      eventId: "event-2",
      turnId: "turn-1",
      nativeSessionId: "native-session-1",
      occurredAt: "2026-07-24T12:00:00.000Z",
      type: "failed",
      code: "CANCELLED",
      message: "Turn cancelled.",
      retryable: false,
    },
  });
});

test("closing an already-cancelled iterator releases its native-session writer", async () => {
  for (const closeMethod of ["return", "throw"] as const) {
    const adapter = createFakeAgentAdapter({
      provider: "claude",
      probe: {
        ready: true,
        version: "claude-4.5.0",
        authentication: "ready",
      },
      ids: sequentialIds(),
      clock: { now: () => "2026-07-24T12:00:00.000Z" },
      turnScript: () => [
        { type: "progress", summary: "Started." },
        { type: "completed", result: "Done." },
      ],
    });
    const session = await adapter.startSession({
      taskId: `task-cancel-then-${closeMethod}`,
      deviceId: "device-worker",
      workspaceId: "workspace-project",
      workingDirectory: "/work/project",
    });
    const turn = await adapter.startTurn({ session, input: "Long-running work" });
    const iterator = turn.events[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, "progress");
    await turn.cancel();
    if (closeMethod === "return") {
      assert.ok(iterator.return);
      await iterator.return();
    } else {
      const throwIntoIterator = iterator.throw?.bind(iterator);
      assert.ok(throwIntoIterator);
      await assert.rejects(() => throwIntoIterator(new Error("Consumer stopped.")));
    }

    const replacement = await adapter.startTurn({
      session,
      input: "Replacement after the cancelled iterator closed",
    });
    const replacementTypes: string[] = [];
    for await (const event of replacement.events) {
      replacementTypes.push(event.type);
    }
    assert.deepEqual(replacementTypes, ["progress", "completed"]);
  }
});

test("cancellation-event creation failures release the native-session writer", async () => {
  const failures = [
    {
      key: "event-id-source-error",
      configureIds: (base: AgentAdapterIdSource): AgentAdapterIdSource => {
        let eventCalls = 0;
        return {
          ...base,
          nextEventId: () => {
            eventCalls += 1;
            if (eventCalls === 2) {
              throw new Error("Cancellation event ID source failed.");
            }
            return `event-${eventCalls}`;
          },
        };
      },
      clock: () => "2026-07-24T12:00:00.000Z",
    },
    {
      key: "invalid-event-id",
      configureIds: (base: AgentAdapterIdSource): AgentAdapterIdSource => {
        let eventCalls = 0;
        return {
          ...base,
          nextEventId: () => (++eventCalls === 2 ? "unsafe\nevent" : `event-${eventCalls}`),
        };
      },
      clock: () => "2026-07-24T12:00:00.000Z",
    },
    {
      key: "duplicate-event-id",
      configureIds: (base: AgentAdapterIdSource): AgentAdapterIdSource => {
        let eventCalls = 0;
        return {
          ...base,
          nextEventId: () => (++eventCalls <= 2 ? "event-duplicate" : `event-${eventCalls}`),
        };
      },
      clock: () => "2026-07-24T12:00:00.000Z",
    },
    {
      key: "clock-source-error",
      configureIds: (base: AgentAdapterIdSource): AgentAdapterIdSource => base,
      clock: (() => {
        let clockCalls = 0;
        return () => {
          clockCalls += 1;
          if (clockCalls === 3) {
            throw new Error("Cancellation event clock failed.");
          }
          return "2026-07-24T12:00:00.000Z";
        };
      })(),
    },
    {
      key: "invalid-clock-value",
      configureIds: (base: AgentAdapterIdSource): AgentAdapterIdSource => base,
      clock: (() => {
        let clockCalls = 0;
        return () => (++clockCalls === 3 ? "2026-02-30T12:00:00.000Z" : "2026-07-24T12:00:00.000Z");
      })(),
    },
  ] as const;

  for (const failure of failures) {
    const adapter = createFakeAgentAdapter({
      provider: "generic-command",
      probe: {
        ready: true,
        version: "runner-2.0.0",
        authentication: "not-required",
      },
      ids: failure.configureIds(sequentialIds()),
      clock: { now: failure.clock },
      turnScript: () => [
        { type: "progress", summary: "Started." },
        { type: "completed", result: "Done." },
      ],
    });
    const session = await adapter.startSession({
      taskId: `task-cancellation-event-${failure.key}`,
      deviceId: "device-worker",
      workspaceId: "workspace-project",
      workingDirectory: "/work/project",
    });
    const turn = await adapter.startTurn({ session, input: "Long-running work" });
    const iterator = turn.events[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value?.type, "progress");
    await turn.cancel();
    await assert.rejects(() => iterator.next());

    const replacement = await adapter.startTurn({
      session,
      input: "Replacement after cancellation-event failure",
    });
    const replacementTypes: string[] = [];
    for await (const event of replacement.events) {
      replacementTypes.push(event.type);
    }
    assert.deepEqual(replacementTypes, ["progress", "completed"]);
  }
});

test("abandoning an event iterator keeps the writer until cancellation is confirmed", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => [
      { type: "progress", summary: "Started." },
      { type: "completed", result: "Done." },
    ],
  });
  const session = await adapter.startSession({
    taskId: "task-abandoned-iterator",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });
  const turn = await adapter.startTurn({
    session,
    input: "Long-running work",
  });
  const iterator = turn.events[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "progress");
  assert.ok(iterator.return);
  await iterator.return();

  await assert.rejects(
    () => adapter.startTurn({ session, input: "Unsafe replacement" }),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "NATIVE_SESSION_WRITER_BUSY");
      return true;
    },
  );

  await turn.cancel();
  const replacement = await adapter.startTurn({
    session,
    input: "Replacement after confirmed cancellation",
  });
  const replacementEvents = [];
  for await (const event of replacement.events) {
    replacementEvents.push(event.type);
  }

  assert.deepEqual(replacementEvents, ["progress", "completed"]);
});

test("an unavailable native session continues from a public checkpoint with explicit lineage", async () => {
  const adapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const original = await adapter.startSession({
    taskId: "task-continuation",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
  });
  const checkpoint = await adapter.checkpointSession({
    session: original,
    context: {
      taskBrief: "Verify release readiness.",
      rollingSummary: "Static checks have completed.",
      decisions: ["Use the existing release branch."],
      pendingWork: ["Run the final smoke test."],
      artifactRefs: ["artifact-static-checks"],
    },
  });

  adapter.markNativeSessionUnavailable(original.nativeSessionId);
  await assert.rejects(
    () =>
      adapter.resumeSession({
        nativeSessionId: original.nativeSessionId,
        taskId: original.taskId,
        deviceId: original.deviceId,
        workspaceId: original.workspaceId,
        workingDirectory: original.workingDirectory,
      }),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "NATIVE_SESSION_UNAVAILABLE");
      return true;
    },
  );

  const continuation = await adapter.continueFromCheckpoint({
    checkpoint,
  });
  const resumed = await adapter.resumeSession({
    nativeSessionId: continuation.nativeSessionId,
    taskId: continuation.taskId,
    deviceId: continuation.deviceId,
    workspaceId: continuation.workspaceId,
    workingDirectory: continuation.workingDirectory,
  });

  assert.deepEqual(checkpoint, {
    checkpointId: "checkpoint-1",
    provider: "claude",
    sourceNativeSessionId: "native-session-1",
    taskId: "task-continuation",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
    createdAt: "2026-07-24T12:00:00.000Z",
    context: {
      taskBrief: "Verify release readiness.",
      rollingSummary: "Static checks have completed.",
      decisions: ["Use the existing release branch."],
      pendingWork: ["Run the final smoke test."],
      artifactRefs: ["artifact-static-checks"],
    },
  });
  assert.deepEqual(continuation, {
    provider: "claude",
    adapterVersion: "claude-4.5.0",
    nativeSessionId: "native-session-2",
    taskId: "task-continuation",
    deviceId: "device-worker",
    workspaceId: "workspace-project",
    workingDirectory: "/work/project",
    createdAt: "2026-07-24T12:00:00.000Z",
    lineage: {
      rootNativeSessionId: "native-session-1",
      parentNativeSessionId: "native-session-1",
      checkpointId: "checkpoint-1",
      generation: 1,
    },
  });
  assert.deepEqual(resumed, continuation);
});

test("rejects duplicate generated native session, turn, checkpoint, and event identifiers", async () => {
  const duplicateNative = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: {
      ...sequentialIds(),
      nextNativeSessionId: () => "native-duplicate",
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const binding = {
    taskId: "task-duplicate",
    deviceId: "device-duplicate",
    workspaceId: "workspace-duplicate",
    workingDirectory: "/work/duplicate",
  };
  await duplicateNative.startSession(binding);
  await assert.rejects(
    () => duplicateNative.startSession(binding),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_ID_DUPLICATE");
      return true;
    },
  );

  const duplicateTurn = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: {
      ...sequentialIds(),
      nextTurnId: () => "turn-duplicate",
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => [{ type: "completed", result: "Done." }],
  });
  const turnSession = await duplicateTurn.startSession(binding);
  const firstTurn = await duplicateTurn.startTurn({ session: turnSession, input: "First" });
  for await (const event of firstTurn.events) {
    assert.ok(event.type.length > 0);
  }
  await assert.rejects(
    () => duplicateTurn.startTurn({ session: turnSession, input: "Second" }),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_ID_DUPLICATE");
      return true;
    },
  );

  const duplicateCheckpoint = createFakeAgentAdapter({
    provider: "generic-command",
    probe: {
      ready: true,
      version: "runner-2.0.0",
      authentication: "not-required",
    },
    ids: {
      ...sequentialIds(),
      nextCheckpointId: () => "checkpoint-duplicate",
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const checkpointSession = await duplicateCheckpoint.startSession(binding);
  const checkpointInput = {
    session: checkpointSession,
    context: {
      taskBrief: "Brief",
      rollingSummary: "Summary",
      decisions: [],
      pendingWork: [],
      artifactRefs: [],
    },
  };
  await duplicateCheckpoint.checkpointSession(checkpointInput);
  await assert.rejects(
    () => duplicateCheckpoint.checkpointSession(checkpointInput),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_ID_DUPLICATE");
      return true;
    },
  );

  const duplicateEvent = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: {
      ...sequentialIds(),
      nextEventId: () => "event-duplicate",
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
    turnScript: () => [
      { type: "progress", summary: "First." },
      { type: "completed", result: "Second." },
    ],
  });
  const eventSession = await duplicateEvent.startSession(binding);
  const eventTurn = await duplicateEvent.startTurn({ session: eventSession, input: "Run" });
  const eventIterator = eventTurn.events[Symbol.asyncIterator]();
  assert.equal((await eventIterator.next()).value?.type, "progress");
  await assert.rejects(
    () => eventIterator.next(),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_ID_DUPLICATE");
      return true;
    },
  );
});

test("rejects invalid generated identifiers and timestamps before exposing adapter state", async () => {
  const invalidIdAdapter = createFakeAgentAdapter({
    provider: "codex",
    probe: {
      ready: true,
      version: "codex-1.2.3",
      authentication: "ready",
    },
    ids: {
      ...sequentialIds(),
      nextNativeSessionId: () => "unsafe\nsession",
    },
    clock: { now: () => "2026-07-24T12:00:00.000Z" },
  });
  const binding = {
    taskId: "task-validation",
    deviceId: "device-validation",
    workspaceId: "workspace-validation",
    workingDirectory: "/work/validation",
  };

  await assert.rejects(
    () => invalidIdAdapter.startSession(binding),
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_ID_INVALID");
      return true;
    },
  );

  let timestamp = "2026-07-24T12:00:00.000Z";
  const invalidClockAdapter = createFakeAgentAdapter({
    provider: "claude",
    probe: {
      ready: true,
      version: "claude-4.5.0",
      authentication: "ready",
    },
    ids: sequentialIds(),
    clock: { now: () => timestamp },
    turnScript: () => [{ type: "completed", result: "Done." }],
  });
  const session = await invalidClockAdapter.startSession(binding);
  timestamp = "2026-02-30T12:00:00.000Z";
  const turn = await invalidClockAdapter.startTurn({ session, input: "Run" });

  await assert.rejects(
    async () => {
      for await (const event of turn.events) {
        assert.fail(`Invalid timestamp exposed ${event.type}.`);
      }
    },
    (error: unknown) => {
      assert.equal(error instanceof AgentAdapterError, true);
      assert.equal((error as AgentAdapterError).code, "ADAPTER_TIMESTAMP_INVALID");
      return true;
    },
  );
});
