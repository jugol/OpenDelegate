import { createHash } from "node:crypto";

declare const actionFingerprintBrand: unique symbol;

export type ActionFingerprint = `sha256:${string}` & {
  readonly [actionFingerprintBrand]: true;
};

export type ActionTargetValue =
  | boolean
  | number
  | string
  | null
  | readonly ActionTargetValue[]
  | { readonly [key: string]: ActionTargetValue };

export interface ActionCommandDescriptor {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export interface ActionTargetDescriptor {
  readonly kind: string;
  readonly operation: string;
  readonly target: ActionTargetValue;
  readonly command?: ActionCommandDescriptor;
}

const ACTION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function createActionFingerprint(descriptor: ActionTargetDescriptor): ActionFingerprint {
  const normalized = {
    kind: requireIdentifier(descriptor.kind, "kind"),
    operation: requireIdentifier(descriptor.operation, "operation"),
    target: descriptor.target,
    ...(descriptor.command === undefined
      ? {}
      : {
          command: {
            executable: requireIdentifier(descriptor.command.executable, "command.executable"),
            arguments: descriptor.command.arguments.map((argument, index) => {
              if (typeof argument !== "string") {
                throw new TypeError(`command.arguments[${String(index)}] must be a string.`);
              }
              return argument;
            }),
          },
        }),
  };
  const canonicalDescriptor = canonicalize(normalized, "$");
  const digest = createHash("sha256").update(canonicalDescriptor, "utf8").digest("hex");

  return `sha256:${digest}` as ActionFingerprint;
}

export function isActionFingerprint(value: unknown): value is ActionFingerprint {
  return typeof value === "string" && ACTION_FINGERPRINT_PATTERN.test(value);
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }

  return value.trim();
}

function canonicalize(value: unknown, path: string, active = new WeakSet<object>()): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} must contain only finite numbers.`);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "object":
      break;
    default:
      throw new TypeError(`${path} contains a non-serializable value.`);
  }

  if (Array.isArray(value)) {
    if (active.has(value)) {
      throw new TypeError(`${path} contains a cycle.`);
    }

    active.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError(`${path} must contain only enumerable data properties.`);
        }
        items.push(canonicalize(descriptor.value, `${path}[${String(index)}]`, active));
      }
      return `[${items.join(",")}]`;
    } finally {
      active.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only plain objects.`);
  }

  const record = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new TypeError(`${path} cannot contain symbol keys.`);
  }

  if (active.has(record)) {
    throw new TypeError(`${path} contains a cycle.`);
  }

  active.add(record);
  try {
    const ownNames = Object.getOwnPropertyNames(record);
    const enumerableKeys = Object.keys(record);
    if (ownNames.length !== enumerableKeys.length) {
      throw new TypeError(`${path} must contain only enumerable data properties.`);
    }

    const properties = enumerableKeys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${path} must contain only enumerable data properties.`);
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, active)}`;
    });
    return `{${properties.join(",")}}`;
  } finally {
    active.delete(record);
  }
}
