const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";
const ACCESSOR = "[ACCESSOR]";
const UNSUPPORTED = "[UNSUPPORTED OBJECT]";

const sensitiveNames = new Set([
  "authorization",
  "claimtoken",
  "cookie",
  "credential",
  "csrftoken",
  "currentpassphrase",
  "hostopendelegatesession",
  "newpassphrase",
  "passphrase",
  "password",
  "passwordphc",
  "recoverycode",
  "recoverycodes",
  "recoverytoken",
  "sessiontoken",
  "setcookie",
  "token",
  "xopendelegatecsrf",
]);

export function redactOwnerAuthCredentials(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}

function redact(value: unknown, active: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return UNSUPPORTED;
  }
  if (active.has(value)) {
    return CIRCULAR;
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => redact(item, active)));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return UNSUPPORTED;
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        continue;
      }
      if (isSensitiveName(key)) {
        output[key] = REDACTED;
      } else if (!("value" in descriptor)) {
        output[key] = ACCESSOR;
      } else {
        output[key] = redact(descriptor.value, active);
      }
    }
    return Object.freeze(output);
  } finally {
    active.delete(value);
  }
}

function isSensitiveName(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return sensitiveNames.has(normalized);
}
