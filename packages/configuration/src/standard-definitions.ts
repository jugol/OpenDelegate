import type { ConfigurationDefinition } from "./index.ts";

const isOneOf =
  <const T extends readonly unknown[]>(values: T) =>
  (value: unknown): value is T[number] =>
    values.includes(value);

const isNullableSecretReference = (value: unknown): boolean =>
  value === null ||
  (typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { secretRef?: unknown }).secretRef === "string" &&
    (value as { secretRef: string }).secretRef.trim().length > 0);

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
    key: "database.adapter",
    defaultValue: "sqlite",
    scopes: ["main"],
    validate: isOneOf(["sqlite", "postgresql"] as const),
  },
  {
    key: "database.uri-ref",
    defaultValue: null,
    scopes: ["main"],
    validate: isNullableSecretReference,
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
