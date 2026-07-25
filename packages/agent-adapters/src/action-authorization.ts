import { createHash } from "node:crypto";

import { type AgentActionAuthorizationRequest, type AgentActionCategory } from "./contracts.ts";
import { AgentAdapterError } from "./errors.ts";

const MAXIMUM_FINGERPRINT_INPUT_BYTES = 1_048_576;
const MAXIMUM_DESCRIPTOR_TEXT_BYTES = 4_096;
const KNOWLEDGE_TOOL_MARKER = /(?:^|[_:.-])knowledge(?:[_:.-]|$)/iu;
const READ_ONLY_PROVIDER_TOOLS = new Set([
  "glob",
  "grep",
  "read",
  "search",
  "view",
  "websearch",
  "web_search",
]);

export interface ProviderToolAuthorizationInput {
  readonly provider: "codex" | "claude";
  readonly runId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requestedAtMs: number;
  readonly signal: AbortSignal;
  readonly title?: string;
  readonly description?: string;
  readonly decisionReason?: string;
  readonly blockedPath?: string;
  readonly categoryHint?: AgentActionCategory;
}

/**
 * Builds an exact, privacy-preserving authorization request.
 *
 * The fingerprint commits to the complete provider input. The descriptor is a
 * separately bounded projection for Main/Admin presentation. Device-local
 * Knowledge arguments, filenames, snippets, and graph metadata never enter that
 * projection.
 */
export function createProviderToolAuthorizationRequest(
  input: ProviderToolAuthorizationInput,
): AgentActionAuthorizationRequest {
  validateToolInput(input);
  const exact = canonicalJson({
    provider: input.provider,
    toolName: input.toolName,
    input: input.input,
  });
  if (Buffer.byteLength(exact, "utf8") > MAXIMUM_FINGERPRINT_INPUT_BYTES) {
    throw new AgentAdapterError(
      "ACTION_INPUT_TOO_LARGE",
      "The provider action exceeds the exact-authorization input bound.",
    );
  }
  const knowledge = KNOWLEDGE_TOOL_MARKER.test(input.toolName);
  const descriptor = knowledge
    ? Object.freeze({
        provider: input.provider,
        tool: "device-local-knowledge",
        privacy: "arguments-withheld-on-device",
      })
    : createPresentationDescriptor(input);
  return Object.freeze({
    authorizationRequestId: stableAuthorizationRequestId(input),
    actionCategory: input.categoryHint ?? classifyProviderToolAction(input),
    actionType: boundedText(input.toolName, "provider tool name"),
    actionFingerprint: `sha256:${createHash("sha256").update(exact).digest("hex")}`,
    actionDescriptor: descriptor,
    requestedAtMs: input.requestedAtMs,
    signal: input.signal,
  });
}

export function classifyProviderToolAction(
  input: Pick<
    ProviderToolAuthorizationInput,
    "blockedPath" | "decisionReason" | "input" | "toolName"
  >,
): AgentActionCategory {
  const name = input.toolName.toLocaleLowerCase("en-US");
  if (KNOWLEDGE_TOOL_MARKER.test(input.toolName)) {
    return "read-only-observation";
  }
  if (READ_ONLY_PROVIDER_TOOLS.has(name)) {
    return "read-only-observation";
  }
  if (name.includes("computer") || name.includes("desktop")) {
    return "computer-use-input";
  }

  const command = readString(input.input, ["command", "cmd", "script"]);
  if (command !== undefined) {
    const normalized = command.toLocaleLowerCase("en-US");
    if (looksLikeSecretExport(normalized)) {
      return "secret-export";
    }
    if (looksLikeFirewallChange(normalized)) {
      return "firewall-change";
    }
    if (looksLikeVpnChange(normalized)) {
      return "vpn-change";
    }
    if (looksLikeNetworkChange(normalized)) {
      return "os-network-change";
    }
    if (looksLikeRemoteInstaller(normalized)) {
      return "remote-installer-script";
    }
    if (looksLikeRepositoryAddition(normalized)) {
      return "package-repository-addition";
    }
    if (looksLikeDriverInstall(normalized)) {
      return "driver-installation";
    }
  }

  const reason = input.decisionReason?.toLocaleLowerCase("en-US") ?? "";
  if (
    input.blockedPath !== undefined ||
    reason.includes("sandbox") ||
    reason.includes("permission") ||
    name === "bash" ||
    name === "shell" ||
    name === "write" ||
    name === "edit"
  ) {
    return "sandbox-boundary-escalation";
  }
  return "sandbox-boundary-escalation";
}

function createPresentationDescriptor(
  input: ProviderToolAuthorizationInput,
): Readonly<Record<string, string>> {
  return Object.freeze({
    provider: input.provider,
    tool: boundedText(input.toolName, "provider tool name"),
    privacy: "provider-input-committed-on-device",
  });
}

function stableAuthorizationRequestId(input: ProviderToolAuthorizationInput): string {
  const digest = createHash("sha256")
    .update(`${input.provider}\0${input.runId}\0${input.toolUseId}\0${input.toolName}`)
    .digest("hex");
  return `agent-action:${digest}`;
}

function canonicalJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidActionInput();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw invalidActionInput();
    }
    const nested = new Set(ancestors);
    nested.add(value);
    return `[${value.map((entry) => canonicalJson(entry, nested)).join(",")}]`;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw invalidActionInput();
    }
    const record = value as Readonly<Record<string, unknown>>;
    const nested = new Set(ancestors);
    nested.add(value);
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw invalidActionInput();
        }
        return `${JSON.stringify(key)}:${canonicalJson(entry, nested)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw invalidActionInput();
}

function validateToolInput(input: ProviderToolAuthorizationInput): void {
  if (
    (input.provider !== "codex" && input.provider !== "claude") ||
    input.runId.length === 0 ||
    input.toolName.length === 0 ||
    input.toolUseId.length === 0 ||
    !Number.isSafeInteger(input.requestedAtMs) ||
    input.requestedAtMs < 0 ||
    input.signal === null ||
    typeof input.signal !== "object"
  ) {
    throw invalidActionInput();
  }
}

function invalidActionInput(): AgentAdapterError {
  return new AgentAdapterError(
    "ACTION_INPUT_INVALID",
    "The provider action cannot be represented by the exact authorization protocol.",
  );
}

function boundedText(value: string, label: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    Buffer.byteLength(trimmed, "utf8") > MAXIMUM_DESCRIPTOR_TEXT_BYTES
  ) {
    throw new AgentAdapterError(
      "ACTION_INPUT_INVALID",
      `The ${label} is invalid for authorization presentation.`,
    );
  }
  return trimmed;
}

function readString(
  input: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function looksLikeRepositoryAddition(command: string): boolean {
  return /add-apt-repository|apt-key|brew\s+tap|winget\s+source\s+add|choco\s+source\s+add|dnf\s+config-manager\s+--add-repo/u.test(
    command,
  );
}

function looksLikeRemoteInstaller(command: string): boolean {
  return /(?:curl|wget|invoke-webrequest|iwr)\b[^;&|\n]*(?:\||;)\s*(?:sh|bash|zsh|pwsh|powershell)\b/u.test(
    command,
  );
}

function looksLikeDriverInstall(command: string): boolean {
  return /\b(?:pnputil|devcon|modprobe|insmod|kextload|kmutil)\b/u.test(command);
}

function looksLikeFirewallChange(command: string): boolean {
  return /\b(?:netsh\s+advfirewall|new-netfirewallrule|set-netfirewallprofile|ufw|firewall-cmd|iptables|nft)\b/u.test(
    command,
  );
}

function looksLikeVpnChange(command: string): boolean {
  return /\b(?:tailscale|wg-quick|wireguard|openvpn|networksetup\s+-connectpppoeservice)\b/u.test(
    command,
  );
}

function looksLikeNetworkChange(command: string): boolean {
  return /\b(?:netsh\s+interface|new-netroute|set-netipinterface|ip\s+(?:addr|route|link)|route\s+(?:add|delete)|nmcli\s+connection)\b/u.test(
    command,
  );
}

function looksLikeSecretExport(command: string): boolean {
  return /\b(?:printenv|set)\b.*(?:token|secret|password|api[_-]?key)|\b(?:cat|type|get-content)\b.*(?:credentials|\.env|id_rsa|id_ed25519)/u.test(
    command,
  );
}
