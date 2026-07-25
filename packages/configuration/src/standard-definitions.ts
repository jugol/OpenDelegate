import type { ConfigurationDefinition } from "./index.ts";
import { isNullableCanonicalMainSecretReferenceValue } from "./secret-reference.ts";

const isOneOf =
  <const T extends readonly unknown[]>(values: T) =>
  (value: unknown): value is T[number] =>
    values.includes(value);

const isNullableBoundedText = (value: unknown): boolean =>
  value === null || isBoundedText(value, 253);

const isRoleList = (value: unknown): boolean => isBoundedUniqueTextList(value, 128, 256);

const isInstructionList = (value: unknown): boolean => isBoundedUniqueTextList(value, 128, 4_096);

/**
 * Defaults that are product decisions rather than installation discoveries. Values
 * such as hostnames, database URIs, Discord identifiers, and OS service choices are
 * intentionally absent until init discovers or asks for them.
 */
export const STANDARD_CONFIGURATION_DEFINITIONS = [
  {
    key: "task.default-mode",
    defaultValue: "auto",
    scopes: ["instance", "main", "device", "task-default"],
    validate: isOneOf(["auto", "manual"] as const),
  },
  {
    key: "autonomy.profile",
    defaultValue: "assisted",
    scopes: ["instance", "main", "device"],
    validate: isOneOf(["reactive", "assisted", "autonomous"] as const),
  },
  {
    key: "device.display-name",
    defaultValue: null,
    scopes: ["device"],
    validate: isNullableBoundedText,
  },
  {
    key: "device.roles",
    defaultValue: [],
    scopes: ["device"],
    validate: isRoleList,
  },
  {
    key: "device.instructions",
    defaultValue: [],
    scopes: ["device"],
    validate: isInstructionList,
  },
  {
    key: "database.adapter",
    defaultValue: "sqlite",
    scopes: ["main"],
    validate: isOneOf(["sqlite", "postgresql"] as const),
  },
  {
    key: "database.uri-ref",
    defaultValue: null,
    scopes: ["main"],
    secretReference: {
      locality: "main",
    },
    validate: isNullableCanonicalMainSecretReferenceValue,
  },
  {
    key: "admin.open-on-login",
    defaultValue: false,
    scopes: ["main"],
    validate: (value: unknown): value is boolean => typeof value === "boolean",
  },
  {
    key: "artifact.exposure",
    defaultValue: "private-network",
    scopes: ["instance", "device", "task-default", "artifact"],
    validate: isOneOf([
      "private-network",
      "authenticated",
      "signed-link",
      "public",
      "custom",
    ] as const),
  },
  {
    key: "artifact.interactive-html",
    defaultValue: false,
    scopes: ["instance", "task-default", "artifact"],
    validate: (value: unknown): value is boolean => typeof value === "boolean",
  },
  {
    key: "policy.official-package-install",
    defaultValue: "allow",
    scopes: ["instance", "main", "device"],
    validate: isOneOf(["allow", "require-approval", "deny"] as const),
  },
  {
    key: "policy.network-change",
    defaultValue: "require-approval",
    scopes: ["instance", "main", "device"],
    validate: isOneOf(["allow", "require-approval", "deny"] as const),
  },
  {
    key: "transport.agent-escalation",
    defaultValue: "after-route-exhaustion",
    scopes: ["instance", "device", "transport"],
    validate: isOneOf(["after-route-exhaustion", "disabled"] as const),
  },
] as const satisfies readonly ConfigurationDefinition[];

function isBoundedUniqueTextList(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): boolean {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return false;
  }
  const values = value.filter((entry): entry is string => isBoundedText(entry, maximumLength));
  return values.length === value.length && new Set(values).size === values.length;
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    ![...value].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  );
}
