import { SqlStorageError } from "./errors.ts";

const RFC3339_INSTANT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function encodeCanonicalJson(value: unknown): string {
  return encodeJsonValue(value, new WeakSet<object>());
}

export function decodeCanonicalJson(value: string): unknown {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new SqlStorageError(
      "DATA_CORRUPT",
      "A stored event payload is not valid canonical JSON.",
      { cause: error },
    );
  }

  try {
    if (encodeCanonicalJson(decoded) !== value) {
      throw new Error("The JSON value is not in canonical form.");
    }
  } catch (error) {
    throw new SqlStorageError(
      "DATA_CORRUPT",
      "A stored event payload is outside the durable JSON contract.",
      { cause: error },
    );
  }

  return deepFreeze(decoded);
}

export function assertRfc3339Instant(value: string): void {
  if (
    typeof value !== "string" ||
    !RFC3339_INSTANT_PATTERN.test(value) ||
    !hasValidCalendarDate(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new SqlStorageError(
      "DATA_CORRUPT",
      "A stored event instant is not a valid RFC 3339 timestamp.",
    );
  }
}

export function parseSafeNonNegativeInteger(
  value: number | string | bigint,
  label: string,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SqlStorageError(
      "DATA_CORRUPT",
      `${label} is outside the supported safe integer range.`,
    );
  }
  return parsed;
}

export function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}

function encodeJsonValue(value: unknown, active: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throwUnserializablePayload();
    }
    return Object.is(value, -0) ? "-0" : String(value);
  }

  if (typeof value !== "object" || active.has(value)) {
    throwUnserializablePayload();
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throwUnserializablePayload();
        }
        encoded.push(encodeJsonValue(value[index], active));
      }
      return `[${encoded.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throwUnserializablePayload();
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throwUnserializablePayload();
    }

    const entries: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throwUnserializablePayload();
      }
      entries.push(`${JSON.stringify(key)}:${encodeJsonValue(descriptor.value, active)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function throwUnserializablePayload(): never {
  throw new SqlStorageError(
    "STORAGE_CONFIGURATION_INVALID",
    "Event payloads must be finite JSON-compatible values without cycles or accessors.",
  );
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
