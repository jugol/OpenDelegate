import type { AuditEventId, DeviceId, RunId, TaskId } from "./identifiers.ts";

export type AuditOutcome = "success" | "failure" | "denied" | "pending";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface AuditPrincipal {
  readonly type: "owner" | "main-agent" | "worker-agent" | "system" | "device";
  readonly id: string;
}

export interface AuditSubject {
  readonly type: string;
  readonly id: string;
}

export interface CreateAuditEvent {
  readonly id: AuditEventId;
  readonly eventType: string;
  readonly occurredAtMs: number;
  readonly actor: AuditPrincipal;
  readonly subject: AuditSubject;
  readonly correlationId: string;
  readonly taskId?: TaskId;
  readonly runId?: RunId;
  readonly deviceId?: DeviceId;
  readonly outcome: AuditOutcome;
  readonly details: JsonObject;
}

export interface AuditEventSnapshot {
  readonly id: string;
  readonly eventType: string;
  readonly occurredAtMs: number;
  readonly actor: AuditPrincipal;
  readonly subject: AuditSubject;
  readonly correlationId: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly deviceId?: string;
  readonly outcome: AuditOutcome;
  readonly details: JsonObject;
}

export class AuditEvent {
  public readonly id: AuditEventId;
  private readonly eventSnapshot: AuditEventSnapshot;

  private constructor(input: CreateAuditEvent) {
    this.id = input.id;
    this.eventSnapshot = Object.freeze({
      id: input.id.value,
      eventType: input.eventType,
      occurredAtMs: input.occurredAtMs,
      actor: Object.freeze({ ...input.actor }),
      subject: Object.freeze({ ...input.subject }),
      correlationId: input.correlationId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId.value }),
      ...(input.runId === undefined ? {} : { runId: input.runId.value }),
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId.value }),
      outcome: input.outcome,
      details: freezeJsonObject(input.details),
    });
  }

  public static create(input: CreateAuditEvent): AuditEvent {
    return new AuditEvent(input);
  }

  public get snapshot(): AuditEventSnapshot {
    return this.eventSnapshot;
  }
}

function freezeJsonObject(value: JsonObject): JsonObject {
  const copy: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = freezeJsonValue(item);
  }
  return Object.freeze(copy);
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }
  return freezeJsonObject(value as JsonObject);
}
