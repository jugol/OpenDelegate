import { randomUUID } from "node:crypto";

import {
  type AgentAdapter,
  type AgentAdapterProbe,
  type AgentAdapterProbeInput,
  type AgentResumeRequest,
  type AgentRunHandle,
  type AgentStartRequest,
  type AgentUsage,
  type WorkspaceIsolation,
} from "./contracts.ts";
import { probeCli } from "./cli-probe.ts";
import { AgentAdapterError } from "./errors.ts";
import { type SpawnCommand } from "./process-utils.ts";
import { isRecord } from "./redaction.ts";
import { processSessionLeaseStore, type SessionLeaseStore } from "./session-leases.ts";
import {
  canonicalizeWorkspace,
  createNativeSessionReference,
  type CanonicalWorkspaceBinding,
  validateAgentRequest,
  validateDangerousGrant,
  validateResumeReference,
} from "./session-reference.ts";
import { startSubprocessTurn, type ProviderSignal } from "./subprocess-turn.ts";

const GENERIC_COMMAND_INPUT_PROTOCOL = "opendelegate.agent-command.v1";
const GENERIC_COMMAND_EVENT_PROTOCOL = "opendelegate.agent-event.v1";

export interface GenericCommandAdapterOptions {
  readonly adapterId: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly versionArgs: readonly string[];
  readonly authProbeArgs?: readonly string[];
  readonly testedVersions: readonly string[];
  readonly allowUntestedVersion?: boolean;
  readonly workspaceIsolation?: readonly WorkspaceIsolation[];
  readonly leaseStore?: SessionLeaseStore;
  readonly now?: () => number;
  readonly lineageId?: () => string;
}

export class GenericCommandAdapter implements AgentAdapter {
  readonly adapterId: string;
  readonly provider = "generic" as const;
  readonly #executable: string;
  readonly #args: readonly string[];
  readonly #versionArgs: readonly string[];
  readonly #authProbeArgs: readonly string[] | undefined;
  readonly #testedVersions: readonly string[];
  readonly #allowUntestedVersion: boolean;
  readonly #workspaceIsolation: readonly WorkspaceIsolation[];
  readonly #leaseStore: SessionLeaseStore;
  readonly #now: () => number;
  readonly #lineageId: () => string;

  constructor(options: GenericCommandAdapterOptions) {
    if (!/^[a-z][a-z0-9-]{1,63}$/u.test(options.adapterId)) {
      throw new AgentAdapterError(
        "INVALID_ADAPTER_ID",
        "Generic adapter ID must be a lowercase, hyphenated stable identifier.",
      );
    }
    if (options.executable.length === 0 || options.versionArgs.length === 0) {
      throw new AgentAdapterError(
        "INVALID_COMMAND",
        "Generic runner executable and version command are required.",
      );
    }
    if (options.testedVersions.length === 0) {
      throw new AgentAdapterError(
        "VERSION_POLICY_REQUIRED",
        "Generic runner must pin at least one contract-tested version.",
      );
    }
    this.adapterId = options.adapterId;
    this.#executable = options.executable;
    this.#args = options.args ?? [];
    this.#versionArgs = options.versionArgs;
    this.#authProbeArgs = options.authProbeArgs;
    this.#testedVersions = options.testedVersions;
    this.#allowUntestedVersion = options.allowUntestedVersion ?? false;
    this.#workspaceIsolation = options.workspaceIsolation ?? [
      "none",
      "agent-native-worktree",
      "opendelegate-worktree",
      "container",
      "custom",
    ];
    this.#leaseStore = options.leaseStore ?? processSessionLeaseStore;
    this.#now = options.now ?? Date.now;
    this.#lineageId = options.lineageId ?? randomUUID;
  }

  async probe(input: AgentAdapterProbeInput = {}): Promise<AgentAdapterProbe> {
    const capabilities = {
      start: true,
      resume: true,
      streaming: true,
      cancellation: true,
      approvalBridge: true,
      steering: false,
      checkpointContinuation: true,
      workspaceIsolation: this.#workspaceIsolation,
    } as const;
    return await probeCli({
      adapterId: this.adapterId,
      provider: this.provider,
      providerLabel: "Generic runner",
      capabilities,
      versionCommand: this.#command(
        this.#versionArgs,
        process.cwd(),
        input.environment,
        input.secretEnvironment,
      ),
      ...(this.#authProbeArgs === undefined
        ? {}
        : {
            authCommand: this.#command(
              this.#authProbeArgs,
              process.cwd(),
              input.environment,
              input.secretEnvironment,
            ),
          }),
      testedVersions: this.#testedVersions,
      parseVersion: parseGenericVersion,
    });
  }

  async start(request: AgentStartRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async resume(request: AgentResumeRequest): Promise<AgentRunHandle> {
    return await this.#launch(request);
  }

  async #launch(request: AgentStartRequest | AgentResumeRequest): Promise<AgentRunHandle> {
    validateAgentRequest(request);
    const workspace = await canonicalizeWorkspace(request.workspace);
    const { cwd } = workspace;
    if (request.operation === "resume") {
      validateResumeReference(request, workspace, this.provider, this.adapterId);
    }
    if (!this.#workspaceIsolation.includes(request.workspace.isolation)) {
      throw new AgentAdapterError(
        "WORKSPACE_ISOLATION_UNSUPPORTED",
        "Generic runner does not advertise the requested workspace isolation.",
      );
    }
    if (request.permissions.mode === "bypass") {
      validateDangerousGrant(request);
    }
    const probe = await this.probe({
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.secretEnvironment === undefined
        ? {}
        : { secretEnvironment: request.secretEnvironment }),
    });
    if (!probe.installed) {
      throw new AgentAdapterError("ADAPTER_UNAVAILABLE", "Generic runner is unavailable.", true);
    }
    if (probe.auth.state !== "ready" && probe.auth.state !== "not_required") {
      throw new AgentAdapterError(
        "ADAPTER_AUTH_NOT_READY",
        "Generic runner authentication is not ready.",
        true,
      );
    }
    if (
      probe.version === undefined ||
      (probe.compatibility !== "tested" && !this.#allowUntestedVersion)
    ) {
      throw new AgentAdapterError(
        "ADAPTER_VERSION_UNSUPPORTED",
        "Generic runner version has not passed the configured compatibility policy.",
      );
    }
    const adapterVersion = probe.version;
    const stdin = `${JSON.stringify(createInputEnvelope(request, workspace))}\n`;
    return await startSubprocessTurn({
      adapterId: this.adapterId,
      adapterVersion,
      request,
      cwd,
      command: this.#command(this.#args, cwd, request.environment, request.secretEnvironment),
      stdin,
      leaseStore: this.#leaseStore,
      now: this.#now,
      createSession: (nativeSessionId) =>
        createNativeSessionReference({
          provider: this.provider,
          adapterId: this.adapterId,
          adapterVersion,
          nativeSessionId,
          request,
          workspace,
          lineageId: this.#lineageId,
          now: this.#now,
        }),
      parseLine: parseGenericSignals,
    });
  }

  #command(
    args: readonly string[],
    cwd: string,
    environment?: Readonly<Record<string, string>>,
    secretEnvironment?: Readonly<Record<string, string>>,
  ): SpawnCommand {
    return {
      executable: this.#executable,
      args,
      cwd,
      ...(environment === undefined ? {} : { environment }),
      ...(secretEnvironment === undefined ? {} : { secretEnvironment }),
    };
  }
}

function createInputEnvelope(
  request: AgentStartRequest | AgentResumeRequest,
  workspace: CanonicalWorkspaceBinding,
): object {
  return {
    protocol: GENERIC_COMMAND_INPUT_PROTOCOL,
    operation: request.operation,
    requestId: request.requestId,
    runId: request.runId,
    taskId: request.taskId,
    workstreamId: request.workstreamId,
    sessionKey: request.sessionKey,
    deviceId: request.deviceId,
    prompt: request.prompt,
    workspace: {
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      ...(workspace.worktreePath === undefined ? {} : { worktreePath: workspace.worktreePath }),
      isolation: workspace.isolation,
    },
    execution: {
      sandbox: request.sandbox,
      permissions: {
        mode: request.permissions.mode,
        ...(request.permissions.allowedTools === undefined
          ? {}
          : { allowedTools: request.permissions.allowedTools }),
        ...(request.permissions.deniedTools === undefined
          ? {}
          : { deniedTools: request.permissions.deniedTools }),
      },
    },
    ...(request.operation === "resume" ? { session: request.session } : {}),
    ...(request.operation === "start" && request.continuationOf !== undefined
      ? {
          continuation: {
            parent: request.continuationOf,
            ...(request.continuationReason === undefined
              ? {}
              : { reason: request.continuationReason }),
          },
        }
      : {}),
  };
}

function parseGenericSignals(value: unknown): readonly ProviderSignal[] {
  if (
    !isRecord(value) ||
    value.protocol !== GENERIC_COMMAND_EVENT_PROTOCOL ||
    typeof value.type !== "string"
  ) {
    throw new AgentAdapterError(
      "MALFORMED_PROVIDER_OUTPUT",
      "Generic runner event did not match the v1 JSONL protocol.",
    );
  }
  if (value.type === "session") {
    return [{ kind: "session", nativeSessionId: requiredString(value.sessionId, "sessionId") }];
  }
  if (value.type === "message") {
    return [{ kind: "public_message", text: requiredString(value.text, "text") }];
  }
  if (value.type === "message_delta") {
    return [{ kind: "message_delta", text: requiredString(value.text, "text") }];
  }
  if (value.type === "tool_request") {
    return [
      {
        kind: "tool_request",
        toolName: requiredString(value.toolName, "toolName"),
        ...(value.input === undefined ? {} : { input: value.input }),
      },
    ];
  }
  if (value.type === "tool_result") {
    if (value.status !== "succeeded" && value.status !== "failed") {
      throw malformedGeneric("tool result status");
    }
    return [
      {
        kind: "tool_result",
        toolName: requiredString(value.toolName, "toolName"),
        status: value.status,
        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
      },
    ];
  }
  if (value.type === "approval_request") {
    return [
      {
        kind: "approval_request",
        requestId: requiredString(value.requestId, "requestId"),
        actionType: requiredString(value.actionType, "actionType"),
        summary: requiredString(value.summary, "summary"),
        ...(value.scope === undefined ? {} : { scope: value.scope }),
      },
    ];
  }
  if (value.type === "progress") {
    return [{ kind: "progress", message: requiredString(value.message, "message") }];
  }
  if (value.type === "usage") {
    return [{ kind: "usage", usage: parseGenericUsage(value) }];
  }
  if (value.type === "diagnostic") {
    if (value.level !== "info" && value.level !== "warning" && value.level !== "error") {
      throw malformedGeneric("diagnostic level");
    }
    return [
      {
        kind: "diagnostic",
        level: value.level,
        code: requiredString(value.code, "code"),
        message: requiredString(value.message, "message"),
      },
    ];
  }
  if (value.type === "result") {
    if (value.status !== "succeeded" && value.status !== "failed") {
      throw malformedGeneric("result status");
    }
    const error =
      value.status === "failed"
        ? {
            code: isRecord(value.error)
              ? requiredString(value.error.code, "error.code")
              : "GENERIC_RUNNER_FAILED",
            message: isRecord(value.error)
              ? requiredString(value.error.message, "error.message")
              : "The generic runner reported a failed turn.",
            retryable: isRecord(value.error) && value.error.retryable === true,
          }
        : undefined;
    return [
      {
        kind: "terminal",
        status: value.status,
        ...(typeof value.finalText === "string" ? { finalText: value.finalText } : {}),
        ...(error === undefined ? {} : { error }),
      },
    ];
  }
  throw malformedGeneric(`event type ${value.type}`);
}

function parseGenericUsage(value: Record<string, unknown>): AgentUsage {
  const inputTokens = nonNegativeNumber(value.inputTokens);
  const outputTokens = nonNegativeNumber(value.outputTokens);
  const cachedInputTokens = nonNegativeNumber(value.cachedInputTokens);
  const costUsd = nonNegativeNumber(value.costUsd);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw malformedGeneric(field);
  }
  return value;
}

function malformedGeneric(field: string): AgentAdapterError {
  return new AgentAdapterError(
    "MALFORMED_PROVIDER_OUTPUT",
    `Generic runner emitted an invalid ${field}.`,
  );
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseGenericVersion(output: string): string {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(output.trim());
  if (match?.[1] === undefined) {
    throw new AgentAdapterError(
      "UNRECOGNIZED_PROVIDER_VERSION",
      "Generic runner returned an unrecognized semantic version.",
    );
  }
  return match[1];
}
