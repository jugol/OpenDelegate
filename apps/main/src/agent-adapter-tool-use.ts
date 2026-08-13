export type AgentAdapterToolUse = "authorized" | "text-only";

/**
 * Classifies the built-in adapter identities that can route every proposed tool
 * call through OpenDelegate's exact-action Policy bridge. Provider CLI fallbacks
 * intentionally run with all tools denied; generic adapters implement the same
 * callback contract as the first-class bridged adapters.
 */
export function classifyAgentAdapterToolUse(
  provider: "codex" | "claude" | "generic" | "generic-command",
  adapterId: string,
): AgentAdapterToolUse {
  if (
    provider === "generic" ||
    provider === "generic-command" ||
    (provider === "codex" && adapterId === "codex-app-server") ||
    (provider === "claude" && adapterId === "claude-agent-sdk")
  ) {
    return "authorized";
  }
  return "text-only";
}
