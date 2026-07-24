const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const BINARY_REDACTED = "[Binary data redacted]";

export class SecretRedactor {
  readonly #registeredValues: readonly string[];

  public constructor(registeredValues: Iterable<string>) {
    this.#registeredValues = [
      ...new Set([...registeredValues].filter((value) => value.length > 0)),
    ].sort((left, right) => right.length - left.length || compareStableString(left, right));
  }

  public redact(value: unknown): unknown {
    const redacted = redactValue(value, this.#registeredValues, new WeakSet<object>());

    return deepFreeze(redacted, new WeakSet<object>());
  }
}

function redactValue(
  value: unknown,
  registeredValues: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return redactString(value, registeredValues);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return registeredValues.includes(String(value)) ? REDACTED : value;
  }

  if (typeof value === "bigint") {
    const text = value.toString();
    return registeredValues.includes(text) ? REDACTED : `${text}n`;
  }

  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return "[Undefined]";
  }

  if (typeof value === "symbol") {
    return "[Symbol omitted]";
  }

  if (typeof value === "function") {
    return "[Function omitted]";
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }

  seen.add(value);

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return BINARY_REDACTED;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  }

  if (value instanceof Error) {
    return redactError(value, registeredValues, seen);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, registeredValues, seen));
  }

  if (value instanceof Map) {
    return {
      type: "Map",
      entries: [...value.entries()].map(([key, entryValue]) => {
        const sensitiveKey = typeof key === "string" && isSensitiveKey(key);

        return [
          redactValue(key, registeredValues, seen),
          sensitiveKey ? REDACTED : redactValue(entryValue, registeredValues, seen),
        ];
      }),
    };
  }

  if (value instanceof Set) {
    return {
      type: "Set",
      values: [...value.values()].map((entryValue) =>
        redactValue(entryValue, registeredValues, seen),
      ),
    };
  }

  return redactObject(value, registeredValues, seen);
}

function redactError(
  error: Error,
  registeredValues: readonly string[],
  seen: WeakSet<object>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    name: redactString(error.name, registeredValues),
    message: redactString(error.message, registeredValues),
  };

  if (error.stack !== undefined) {
    result.stack = redactString(error.stack, registeredValues);
  }

  copyEnumerableProperties(error, result, registeredValues, seen);
  return result;
}

function redactObject(
  value: object,
  registeredValues: readonly string[],
  seen: WeakSet<object>,
): Readonly<Record<string, unknown>> | string {
  const result: Record<string, unknown> = {};

  try {
    copyEnumerableProperties(value, result, registeredValues, seen);
  } catch {
    return "[Uninspectable object]";
  }

  return result;
}

function copyEnumerableProperties(
  source: object,
  destination: Record<string, unknown>,
  registeredValues: readonly string[],
  seen: WeakSet<object>,
): void {
  for (const key of Object.keys(source)) {
    const outputKey = redactString(key, registeredValues);

    if (isSensitiveKey(key)) {
      destination[outputKey] = REDACTED;
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined) {
      destination[outputKey] = "[Property unavailable]";
    } else if (!("value" in descriptor)) {
      destination[outputKey] = "[Getter omitted]";
    } else {
      destination[outputKey] = redactValue(descriptor.value, registeredValues, seen);
    }
  }
}

function redactString(value: string, registeredValues: readonly string[]): string {
  return registeredValues.reduce(
    (redacted, secret) =>
      redacted.includes(secret) ? redacted.split(secret).join(REDACTED) : redacted,
    value,
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");

  return (
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized === "apikey" ||
    normalized === "authorization" ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("credential") ||
    normalized.includes("privatekey")
  );
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  Object.freeze(value);
  return value;
}

function compareStableString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
