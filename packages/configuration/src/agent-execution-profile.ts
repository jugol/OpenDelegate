export type AgentExecutionProvider = "codex" | "claude" | "generic";

export interface AgentBinding {
  readonly provider: AgentExecutionProvider;
  readonly adapterId: string;
  /**
   * Codex and Claude bindings always use the exact provider-native model ID.
   * Generic command adapters do not necessarily expose a model catalog.
   */
  readonly modelId?: string;
  /**
   * Optional provider tuning for the selected model. The value comes from the
   * model's own advertised effort catalog, so it is not a fixed enumeration and
   * a model advertising no efforts simply carries none.
   */
  readonly effort?: string;
}

export type AgentExecutionProfile =
  | {
      readonly schemaVersion: 1;
      readonly mode: "auto";
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: "prefer";
      readonly primary: AgentBinding;
      readonly fallbacks: readonly AgentBinding[];
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: "pinned";
      readonly primary: AgentBinding;
    };

export const DEFAULT_AGENT_EXECUTION_PROFILE = Object.freeze({
  schemaVersion: 1,
  mode: "auto",
}) satisfies AgentExecutionProfile;

export function isAgentExecutionProfile(value: unknown): value is AgentExecutionProfile {
  if (!isRecord(value) || value["schemaVersion"] !== 1) {
    return false;
  }
  if (value["mode"] === "auto") {
    return hasExactKeys(value, ["schemaVersion", "mode"]);
  }
  if (value["mode"] === "pinned") {
    return (
      hasExactKeys(value, ["schemaVersion", "mode", "primary"]) && isAgentBinding(value["primary"])
    );
  }
  if (
    value["mode"] !== "prefer" ||
    !hasExactKeys(value, ["schemaVersion", "mode", "primary", "fallbacks"])
  ) {
    return false;
  }
  if (!isAgentBinding(value["primary"]) || !Array.isArray(value["fallbacks"])) {
    return false;
  }
  if (value["fallbacks"].length > 7 || !value["fallbacks"].every(isAgentBinding)) {
    return false;
  }
  const identities = [value["primary"], ...value["fallbacks"]].map(bindingIdentity);
  return new Set(identities).size === identities.length;
}

function isAgentBinding(value: unknown): value is AgentBinding {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "adapterId"], ["modelId", "effort"])) {
    return false;
  }
  const provider = value["provider"];
  if (provider !== "codex" && provider !== "claude" && provider !== "generic") {
    return false;
  }
  if (!isBoundedIdentifier(value["adapterId"], 160)) {
    return false;
  }
  // Effort values come from a provider's advertised catalog, so this bounds the
  // shape only. The exact value is checked against the target Device's catalog
  // where that catalog is available.
  if (value["effort"] !== undefined && !isBoundedIdentifier(value["effort"], 64)) {
    return false;
  }
  if (provider === "generic") {
    return value["modelId"] === undefined || isBoundedIdentifier(value["modelId"], 256);
  }
  return isBoundedIdentifier(value["modelId"], 256);
}

/**
 * Two bindings that differ only by effort are distinct, so a Prefer chain may
 * fall back from one effort of a model to another.
 */
function bindingIdentity(binding: AgentBinding): string {
  return `${binding.provider}\0${binding.adapterId}\0${binding.modelId ?? ""}\0${binding.effort ?? ""}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
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
