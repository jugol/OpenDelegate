import assert from "node:assert/strict";
import test from "node:test";

import {
  EventStoreError,
  InMemoryEventStore,
  type EventClock,
  type EventStore,
} from "../src/index.ts";

class FakeClock implements EventClock {
  private currentIso = "2026-07-24T00:00:00.000Z";

  public now(): string {
    return this.currentIso;
  }

  public set(iso: string): void {
    this.currentIso = iso;
  }
}

test("append assigns stable stream versions and global positions through the async port", async () => {
  const clock = new FakeClock();
  const store: EventStore = new InMemoryEventStore({ clock });

  const first = await store.append({
    streamId: "task-001",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-task-created",
        type: "task.created",
        payload: { title: "Launch report" },
      },
    ],
  });
  clock.set("2026-07-24T00:00:01.000Z");
  const second = await store.append({
    streamId: "task-001",
    expectedVersion: 1,
    events: [
      {
        eventId: "event-task-running",
        type: "task.running",
        payload: { workOrderCount: 2 },
      },
    ],
  });

  assert.deepEqual(
    [...first, ...second],
    [
      {
        eventId: "event-task-created",
        streamId: "task-001",
        streamVersion: 1,
        globalPosition: 1,
        type: "task.created",
        occurredAt: "2026-07-24T00:00:00.000Z",
        payload: { title: "Launch report" },
      },
      {
        eventId: "event-task-running",
        streamId: "task-001",
        streamVersion: 2,
        globalPosition: 2,
        type: "task.running",
        occurredAt: "2026-07-24T00:00:01.000Z",
        payload: { workOrderCount: 2 },
      },
    ],
  );
});

test("a duplicate event delivery is idempotent and does not consume a position", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  const command = {
    streamId: "task-duplicate",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-starter-message",
        type: "discord.forum-post-received",
        payload: { postId: "forum-post-001" },
      },
    ],
  } as const;

  const first = await store.append(command);
  const replay = await store.append(command);

  assert.deepEqual(replay, first);
  assert.equal((await store.readAll()).length, 1);
  assert.equal(await store.streamVersion("task-duplicate"), 1);
});

test("a reused event ID with different content is rejected", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  await store.append({
    streamId: "task-001",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-shared",
        type: "task.created",
        payload: { taskId: "task-001" },
      },
    ],
  });

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-002",
        expectedVersion: 0,
        events: [
          {
            eventId: "event-shared",
            type: "task.created",
            payload: { taskId: "task-002" },
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof EventStoreError, true);
      assert.equal((error as EventStoreError).code, "EVENT_ID_CONFLICT");
      return true;
    },
  );
});

test("optimistic concurrency rejects a stale stream writer", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  await store.append({
    streamId: "task-001",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-first",
        type: "task.created",
        payload: {},
      },
    ],
  });

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-001",
        expectedVersion: 0,
        events: [
          {
            eventId: "event-stale",
            type: "task.cancelled",
            payload: {},
          },
        ],
      }),
    (error: unknown) => {
      assert.equal(error instanceof EventStoreError, true);
      assert.equal((error as EventStoreError).code, "STREAM_VERSION_CONFLICT");
      return true;
    },
  );
});

test("replaying a recorded event sequence produces the same projection", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  await store.append({
    streamId: "task-replay",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-replay-created",
        type: "task.created",
        payload: { state: "intake" },
      },
      {
        eventId: "event-replay-running",
        type: "task.state-changed",
        payload: { state: "running" },
      },
      {
        eventId: "event-replay-completed",
        type: "task.state-changed",
        payload: { state: "completed" },
      },
    ],
  });

  const project = () =>
    store.replay("task-replay", { state: "missing", applied: 0 }, (projection, event) => ({
      state:
        typeof event.payload === "object" &&
        event.payload !== null &&
        "state" in event.payload &&
        typeof event.payload.state === "string"
          ? event.payload.state
          : projection.state,
      applied: projection.applied + 1,
    }));

  assert.deepEqual(await project(), { state: "completed", applied: 3 });
  assert.deepEqual(await project(), { state: "completed", applied: 3 });
});

test("read snapshots cannot mutate stored event payloads", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  await store.append({
    streamId: "task-immutable",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-immutable",
        type: "task.created",
        payload: { nested: { value: "original" } },
      },
    ],
  });

  const [event] = await store.readStream("task-immutable");
  assert.ok(event);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.payload), true);
  assert.equal(Object.isFrozen((event.payload as { nested: object }).nested), true);
});

test("non-durable payload shapes fail before consuming a stream or global position", async () => {
  const store = new InMemoryEventStore({
    clock: new FakeClock(),
  });
  const circular: { self?: unknown } = {};
  circular.self = circular;

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-unsafe",
        expectedVersion: 0,
        events: [
          {
            eventId: "event-circular",
            type: "TaskUnsafePayloadObserved",
            payload: circular,
          },
        ],
      }),
    (error: unknown) =>
      error instanceof EventStoreError && error.code === "EVENT_PAYLOAD_UNSERIALIZABLE",
  );

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-unsafe",
        expectedVersion: 0,
        events: [
          {
            eventId: "event-map",
            type: "TaskUnsafePayloadObserved",
            payload: new Map([["secret", "value"]]),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof EventStoreError && error.code === "EVENT_PAYLOAD_UNSERIALIZABLE",
  );

  const [stored] = await store.append({
    streamId: "task-safe",
    expectedVersion: 0,
    events: [
      {
        eventId: "event-safe",
        type: "TaskSafePayloadObserved",
        payload: {
          values: ["one", 2, true, null],
        },
      },
    ],
  });

  assert.equal(await store.streamVersion("task-unsafe"), 0);
  assert.equal(stored?.globalPosition, 1);
});

test("an idempotent batch replay must preserve unique event order and stream positions", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });
  const events = [
    {
      eventId: "event-ordered-1",
      type: "task.created",
      payload: { state: "intake" },
    },
    {
      eventId: "event-ordered-2",
      type: "task.state-changed",
      payload: { state: "running" },
    },
  ] as const;
  await store.append({
    streamId: "task-ordered",
    expectedVersion: 0,
    events,
  });

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-ordered",
        expectedVersion: 0,
        events: [events[1], events[0]],
      }),
    (error: unknown) =>
      error instanceof EventStoreError && error.code === "EVENT_BATCH_REPLAY_MISMATCH",
  );
  await assert.rejects(
    () =>
      store.append({
        streamId: "task-ordered",
        expectedVersion: 0,
        events: [events[0], events[0]],
      }),
    (error: unknown) => error instanceof EventStoreError && error.code === "EVENT_ID_CONFLICT",
  );
});

test("blank durable identifiers and event types are rejected before append", async () => {
  const store = new InMemoryEventStore({ clock: new FakeClock() });

  for (const input of [
    {
      streamId: " ",
      expectedVersion: 0,
      events: [{ eventId: "event-valid", type: "task.created", payload: {} }],
    },
    {
      streamId: "task-valid",
      expectedVersion: 0,
      events: [{ eventId: "", type: "task.created", payload: {} }],
    },
    {
      streamId: "task-valid",
      expectedVersion: 0,
      events: [{ eventId: "event-valid", type: " ", payload: {} }],
    },
  ]) {
    await assert.rejects(
      () => store.append(input),
      (error: unknown) => error instanceof EventStoreError && error.code === "EVENT_INPUT_INVALID",
    );
  }
  assert.equal((await store.readAll()).length, 0);
});

test("an authoritative append instant is persisted instead of consulting the fallback clock", async () => {
  const clock = new FakeClock();
  const store = new InMemoryEventStore({ clock });
  clock.set("not-a-clock-value");

  const [stored] = await store.append({
    streamId: "task-authoritative-time",
    expectedVersion: 0,
    occurredAt: "2026-07-24T03:00:00.000Z",
    events: [{ eventId: "event-authoritative-time", type: "task.created", payload: {} }],
  });

  assert.equal(stored?.occurredAt, "2026-07-24T03:00:00.000Z");
});

test("a malformed injected clock cannot create a durable event", async () => {
  const clock = new FakeClock();
  const store = new InMemoryEventStore({ clock });
  clock.set("July 24 2026");

  await assert.rejects(
    () =>
      store.append({
        streamId: "task-clock",
        expectedVersion: 0,
        events: [{ eventId: "event-clock", type: "task.created", payload: {} }],
      }),
    (error: unknown) => error instanceof EventStoreError && error.code === "CLOCK_VALUE_INVALID",
  );
  assert.equal((await store.readAll()).length, 0);
});
