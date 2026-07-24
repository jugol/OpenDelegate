import { isDeepStrictEqual } from "node:util";

export interface EventClock {
  now(): string;
}

export interface EventDraft<TPayload = unknown> {
  readonly eventId: string;
  readonly type: string;
  readonly payload: TPayload;
}

export interface StoredEvent<TPayload = unknown> extends EventDraft<TPayload> {
  readonly streamId: string;
  readonly streamVersion: number;
  readonly globalPosition: number;
  readonly occurredAt: string;
}

export interface AppendEvents {
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly events: readonly EventDraft[];
}

export interface InMemoryEventStoreOptions {
  readonly clock: EventClock;
}

export type EventStoreErrorCode =
  | "CLOCK_VALUE_INVALID"
  | "EVENT_BATCH_PARTIAL_REPLAY"
  | "EVENT_BATCH_REPLAY_MISMATCH"
  | "EVENT_ID_CONFLICT"
  | "EVENT_INPUT_INVALID"
  | "EVENT_PAYLOAD_UNSERIALIZABLE"
  | "STREAM_VERSION_CONFLICT";

export class EventStoreError extends Error {
  public readonly code: EventStoreErrorCode;

  public constructor(code: EventStoreErrorCode, message: string) {
    super(message);
    this.name = "EventStoreError";
    this.code = code;
  }
}

export class InMemoryEventStore {
  private readonly clock: EventClock;
  private readonly eventsById = new Map<string, StoredEvent>();
  private readonly eventsByStream = new Map<string, readonly StoredEvent[]>();
  private readonly globalEvents: StoredEvent[] = [];

  public constructor(options: InMemoryEventStoreOptions) {
    this.clock = options.clock;
  }

  public append(input: AppendEvents): readonly StoredEvent[] {
    assertNonBlank(input.streamId, "Stream ID");
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      input.events.length === 0
    ) {
      throw new EventStoreError(
        "EVENT_INPUT_INVALID",
        "An append requires a non-negative expected version and at least one event.",
      );
    }

    const batchIds = new Set<string>();
    for (const event of input.events) {
      assertNonBlank(event.eventId, "Event ID");
      assertNonBlank(event.type, "Event type");
      if (batchIds.has(event.eventId)) {
        throw new EventStoreError(
          "EVENT_ID_CONFLICT",
          `Event ID ${event.eventId} appears more than once in one append batch.`,
        );
      }
      batchIds.add(event.eventId);
      assertDurablePayload(event.payload, new WeakSet<object>());
    }

    const replayedEvents = input.events.map((event) => this.eventsById.get(event.eventId));
    const replayCount = replayedEvents.filter((event) => event !== undefined).length;

    if (replayCount > 0) {
      if (replayCount !== input.events.length) {
        throw new EventStoreError(
          "EVENT_BATCH_PARTIAL_REPLAY",
          "An append batch cannot mix replayed and new event identifiers.",
        );
      }

      return Object.freeze(
        replayedEvents.map((storedEvent, index) => {
          const draft = input.events[index];

          if (
            storedEvent === undefined ||
            draft === undefined ||
            storedEvent.streamId !== input.streamId ||
            (input.events.length > 1 &&
              storedEvent.streamVersion !== input.expectedVersion + index + 1) ||
            storedEvent.type !== draft.type ||
            !isDeepStrictEqual(storedEvent.payload, draft.payload)
          ) {
            throw new EventStoreError(
              storedEvent?.eventId === draft?.eventId &&
                storedEvent?.streamId === input.streamId &&
                storedEvent?.type === draft?.type &&
                isDeepStrictEqual(storedEvent?.payload, draft?.payload)
                ? "EVENT_BATCH_REPLAY_MISMATCH"
                : "EVENT_ID_CONFLICT",
              `Event ID ${draft?.eventId ?? "unknown"} does not match this append position and content.`,
            );
          }

          return storedEvent;
        }),
      );
    }

    const currentVersion = this.streamVersion(input.streamId);

    if (currentVersion !== input.expectedVersion) {
      throw new EventStoreError(
        "STREAM_VERSION_CONFLICT",
        `Stream ${input.streamId} is at version ${currentVersion}, not expected version ${input.expectedVersion}.`,
      );
    }

    const occurredAt = this.clock.now();
    assertRfc3339Instant(occurredAt);
    const storedEvents = input.events.map((event, index) =>
      deepFreeze({
        eventId: event.eventId,
        streamId: input.streamId,
        streamVersion: currentVersion + index + 1,
        globalPosition: this.globalEvents.length + index + 1,
        type: event.type,
        occurredAt,
        payload: cloneAndFreeze(event.payload),
      }),
    );

    for (const event of storedEvents) {
      this.eventsById.set(event.eventId, event);
      this.globalEvents.push(event);
    }

    const currentStream = this.eventsByStream.get(input.streamId) ?? [];
    this.eventsByStream.set(input.streamId, Object.freeze([...currentStream, ...storedEvents]));

    return Object.freeze(storedEvents);
  }

  public readStream(streamId: string): readonly StoredEvent[] {
    return Object.freeze([...(this.eventsByStream.get(streamId) ?? [])]);
  }

  public readAll(): readonly StoredEvent[] {
    return Object.freeze([...this.globalEvents]);
  }

  public streamVersion(streamId: string): number {
    return this.eventsByStream.get(streamId)?.length ?? 0;
  }

  public replay<TProjection>(
    streamId: string,
    initial: TProjection,
    apply: (projection: TProjection, event: StoredEvent) => TProjection,
  ): TProjection {
    return this.readStream(streamId).reduce(apply, initial);
  }
}

const RFC3339_INSTANT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function assertNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventStoreError("EVENT_INPUT_INVALID", `${label} must be a non-blank string.`);
  }
}

function assertRfc3339Instant(value: string): void {
  if (
    typeof value !== "string" ||
    !RFC3339_INSTANT_PATTERN.test(value) ||
    !hasValidCalendarDate(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new EventStoreError(
      "CLOCK_VALUE_INVALID",
      "The event clock must return a valid RFC 3339 instant.",
    );
  }
}

function hasValidCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return daysInMonth !== undefined && day <= daysInMonth;
}

function assertDurablePayload(value: unknown, active: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return;
    }
    throwUnserializablePayload();
  }

  if (typeof value !== "object") {
    throwUnserializablePayload();
  }

  if (active.has(value)) {
    throwUnserializablePayload();
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throwUnserializablePayload();
        }
        assertDurablePayload(value[index], active);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throwUnserializablePayload();
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throwUnserializablePayload();
    }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throwUnserializablePayload();
      }
      assertDurablePayload(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

function throwUnserializablePayload(): never {
  throw new EventStoreError(
    "EVENT_PAYLOAD_UNSERIALIZABLE",
    "Event payloads must be finite JSON-compatible values without cycles or accessors.",
  );
}

function cloneAndFreeze<TValue>(value: TValue): TValue {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}
