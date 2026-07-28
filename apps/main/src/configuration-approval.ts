import { createHash } from "node:crypto";

import {
  ApprovalPortError,
  type ApprovalDecisionInput,
  type ApprovalPort,
} from "@opendelegate/control-plane";
import {
  type ConfigurationContext,
  type ConfigurationDiff,
  type ConfigurationMutationAuthorizationInput,
  type ConfigurationService,
} from "@opendelegate/configuration";
import {
  ApprovalService,
  ApprovalServiceError,
  createActionFingerprint,
  type ActionTargetDescriptor,
  type ActionTargetValue,
  type ApprovalExecutionContext,
  type ApprovalExecutionPort,
  type ApprovalRepository,
  type ApprovalRequest,
  type ApprovalRisk,
} from "@opendelegate/policy";
import type { ApprovalDetailV1 } from "@opendelegate/protocol";

import type {
  ConfigurationApprovalRequester,
  ConfigurationApprovalRequestInput,
} from "./agent-configuration-agent.ts";

export interface ConfigurationApprovalRuntimeOptions {
  readonly configuration: ConfigurationService;
  readonly repository: ApprovalRepository;
  readonly clock: {
    now(): number;
  };
  readonly idSource: {
    nextId(): string;
  };
  readonly expirationMs?: number;
  readonly lifecycle?: ConfigurationApplyLifecycle;
  readonly additionalExecutors?: readonly {
    readonly kind: string;
    readonly executor: ApprovalExecutionPort;
  }[];
}

export interface PreparedConfigurationApply {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ConfigurationApplyLifecycle {
  prepare(input: {
    readonly context: ConfigurationContext;
    readonly diff: readonly ConfigurationDiff[];
  }): Promise<PreparedConfigurationApply | undefined>;
}

export interface ConfigurationApprovalRuntime {
  readonly service: ApprovalService;
  readonly requester: ConfigurationApprovalRequester;
  readonly controlPlane: ApprovalPort;
}

const DEFAULT_APPROVAL_EXPIRATION_MS = 24 * 60 * 60 * 1_000;

export function createConfigurationApprovalRuntime(
  options: ConfigurationApprovalRuntimeOptions,
): ConfigurationApprovalRuntime {
  const configurationExecutor = new ConfigurationApprovalExecutor(
    options.configuration,
    options.lifecycle,
  );
  const executor = new RoutedApprovalExecutionPort(
    configurationExecutor,
    options.additionalExecutors ?? [],
  );
  const service = new ApprovalService({
    repository: options.repository,
    executor,
    clock: options.clock,
    idSource: options.idSource,
  });
  return {
    service,
    requester: new ConfigurationApprovalRequestBroker({
      service,
      clock: options.clock,
      expirationMs: options.expirationMs ?? DEFAULT_APPROVAL_EXPIRATION_MS,
    }),
    controlPlane: new ApprovalControlPlanePort(service),
  };
}

class RoutedApprovalExecutionPort implements ApprovalExecutionPort {
  readonly #configuration: ApprovalExecutionPort;
  readonly #additional: ReadonlyMap<string, ApprovalExecutionPort>;

  public constructor(
    configuration: ApprovalExecutionPort,
    additional: readonly {
      readonly kind: string;
      readonly executor: ApprovalExecutionPort;
    }[],
  ) {
    const routes = new Map<string, ApprovalExecutionPort>();
    for (const route of additional) {
      if (
        typeof route.kind !== "string" ||
        route.kind.length === 0 ||
        routes.has(route.kind) ||
        typeof route.executor?.execute !== "function" ||
        route.kind === "configuration.apply"
      ) {
        throw new TypeError("An additional Approval executor route is invalid.");
      }
      routes.set(route.kind, route.executor);
    }
    this.#configuration = configuration;
    this.#additional = routes;
  }

  public execute(input: ApprovalExecutionContext): Promise<ActionTargetValue | undefined> {
    if (input.approval.execution.kind === "configuration.apply") {
      return this.#configuration.execute(input);
    }
    const executor = this.#additional.get(input.approval.execution.kind);
    if (executor === undefined) {
      return Promise.reject(new Error("No executor owns this approved action kind."));
    }
    return executor.execute(input);
  }
}

export class ConfigurationApprovalExecutor implements ApprovalExecutionPort {
  readonly #configuration: ConfigurationService;
  readonly #lifecycle: ConfigurationApplyLifecycle | undefined;

  constructor(configuration: ConfigurationService, lifecycle?: ConfigurationApplyLifecycle) {
    if (
      configuration === null ||
      typeof configuration !== "object" ||
      typeof configuration.executeTool !== "function"
    ) {
      throw new TypeError("A Configuration Service is required for Approval execution.");
    }
    if (
      lifecycle !== undefined &&
      (lifecycle === null ||
        typeof lifecycle !== "object" ||
        typeof lifecycle.prepare !== "function")
    ) {
      throw new TypeError("The Configuration apply lifecycle is invalid.");
    }
    this.#configuration = configuration;
    this.#lifecycle = lifecycle;
  }

  async execute(input: ApprovalExecutionContext): Promise<ActionTargetValue> {
    const payload = decodeConfigurationExecution(input.approval);
    const expectedFingerprint = createActionFingerprint(
      actionDescriptor(
        payload.context,
        payload.expectedRevision,
        payload.proposalId,
        payload.changes,
      ),
    );
    if (expectedFingerprint !== input.approval.actionFingerprint) {
      throw new Error("The approved Configuration action fingerprint no longer matches.");
    }
    const actor = input.approval.decision?.decidedBy ?? "owner";
    const prepared = await this.#lifecycle?.prepare({
      context: payload.context,
      diff: decodeDiff(payload.changes),
    });
    let receipt: Awaited<ReturnType<ConfigurationService["executeTool"]>>;
    try {
      receipt = await this.#configuration.executeTool({
        operationId: payload.configurationOperationId,
        actor,
        context: payload.context,
        request: {
          tool: "apply",
          proposalId: payload.proposalId,
          expectedRevision: payload.expectedRevision,
        },
        authorizeMutation: (authorization) => {
          const actual = createActionFingerprint(
            actionDescriptor(
              authorization.context,
              payload.expectedRevision,
              payload.proposalId,
              encodeDiff(authorization.diff),
            ),
          );
          if (
            authorization.tool !== "apply" ||
            authorization.proposalId !== payload.proposalId ||
            actual !== input.approval.actionFingerprint
          ) {
            return {
              decision: "deny",
              code: "APPROVAL_SCOPE_MISMATCH",
            };
          }
          return {
            decision: "allow",
            authority: "owner",
            decisionId: input.approval.approvalId,
          };
        },
      });
    } catch (error) {
      try {
        await prepared?.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "The Configuration mutation and its prepared runtime rollback both failed.",
          { cause: rollbackError },
        );
      }
      throw error;
    }
    if (receipt.tool !== "apply") {
      await prepared?.rollback();
      throw new Error("The approved Configuration action returned an invalid receipt.");
    }
    try {
      await prepared?.commit();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await this.#configuration.rollback({
          changeSetId: receipt.result.commit.changeSetId,
          expectedRevision: receipt.result.commit.revision,
          actor: "opendelegate-runtime-compensation",
          reason: "Restore durable configuration after its prepared runtime commit failed.",
        });
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      try {
        await prepared?.rollback();
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
      throw new AggregateError(
        failures,
        "The prepared Configuration runtime commit could not be finalized.",
        { cause: error },
      );
    }
    return {
      revision: receipt.result.commit.revision,
      changeSetId: receipt.result.commit.changeSetId,
      auditId: receipt.result.commit.audit.id,
    };
  }
}

class ConfigurationApprovalRequestBroker implements ConfigurationApprovalRequester {
  readonly #service: ApprovalService;
  readonly #clock: ConfigurationApprovalRuntimeOptions["clock"];
  readonly #expirationMs: number;

  constructor(input: {
    readonly service: ApprovalService;
    readonly clock: ConfigurationApprovalRuntimeOptions["clock"];
    readonly expirationMs: number;
  }) {
    if (
      !Number.isSafeInteger(input.expirationMs) ||
      input.expirationMs < 60_000 ||
      input.expirationMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError(
        "Configuration Approval expiration must be between one minute and 7 days.",
      );
    }
    this.#service = input.service;
    this.#clock = input.clock;
    this.#expirationMs = input.expirationMs;
  }

  async request(input: ConfigurationApprovalRequestInput): Promise<{
    readonly approvalId: string;
  }> {
    const changes = encodeDiff(input.authorization.diff);
    const context = encodeContext(input.authorization.context);
    const descriptor = actionDescriptor(context, input.expectedRevision, input.proposalId, changes);
    const risk = riskFor(input.authorization);
    const targetDeviceId = approvalTargetDeviceId(input.authorization);
    const idempotencyKey = configurationApprovalIdempotencyKey(
      input.targetDeviceId,
      input.proposalId,
    );
    const expectedApproval = {
      descriptor,
      principalId: input.principalId,
      proposalId: input.proposalId,
      targetDeviceId,
    } as const;
    const existing =
      selectMatchingConfigurationApproval(await this.#service.list(), expectedApproval) ??
      (await this.#service.findByRequestIdempotencyKey(idempotencyKey));
    if (existing !== undefined) {
      assertMatchingConfigurationApproval(existing, expectedApproval);
      return { approvalId: existing.approvalId };
    }
    const request = {
      idempotencyKey,
      requestedBy: input.principalId,
      actionCategory: categoryFor(input.authorization),
      actionType: "configuration.apply",
      ...(targetDeviceId === undefined ? {} : { targetDeviceId }),
      resource: `configuration-proposal:${input.proposalId}`,
      descriptor,
      presentation: {
        reason: input.authorization.reason,
        target:
          targetDeviceId ??
          input.authorization.context.mainId ??
          input.authorization.context.instanceId,
        risk,
        evidence: input.authorization.diff.map(
          (change) => `${change.key} at ${change.scope.kind}:${change.scope.id}`,
        ),
      },
      execution: {
        kind: "configuration.apply",
        payload: {
          configurationOperationId: input.operationId,
          proposalId: input.proposalId,
          expectedRevision: input.expectedRevision,
          context,
          changes,
        } as unknown as ActionTargetValue,
      },
      expiresAtMs: this.#clock.now() + this.#expirationMs,
    } satisfies Parameters<ApprovalService["request"]>[0];
    let approval: ApprovalRequest;
    try {
      approval = await this.#service.request(request);
    } catch (error) {
      if (
        !(error instanceof ApprovalServiceError) ||
        error.code !== "APPROVAL_IDEMPOTENCY_CONFLICT"
      ) {
        throw error;
      }
      const raced = await this.#service.findByRequestIdempotencyKey(idempotencyKey);
      if (raced === undefined) {
        throw error;
      }
      assertMatchingConfigurationApproval(raced, {
        descriptor,
        principalId: input.principalId,
        proposalId: input.proposalId,
        targetDeviceId,
      });
      approval = raced;
    }
    return { approvalId: approval.approvalId };
  }
}

function selectMatchingConfigurationApproval(
  approvals: readonly ApprovalRequest[],
  expected: Parameters<typeof assertMatchingConfigurationApproval>[1],
): ApprovalRequest | undefined {
  const matches = approvals.filter((approval) => {
    try {
      assertMatchingConfigurationApproval(approval, expected);
      return true;
    } catch {
      return false;
    }
  });
  return (
    matches.find(
      (approval) => approval.state === "approved" && approval.executionStatus === "succeeded",
    ) ?? matches[0]
  );
}

function configurationApprovalIdempotencyKey(targetDeviceId: string, proposalId: string): string {
  const identity = createHash("sha256")
    .update(`${targetDeviceId}\u0000${proposalId}`, "utf8")
    .digest("hex");
  return `configuration-approval:${identity}`;
}

function assertMatchingConfigurationApproval(
  approval: ApprovalRequest,
  expected: {
    readonly descriptor: ActionTargetDescriptor;
    readonly principalId: string;
    readonly proposalId: string;
    readonly targetDeviceId: string | undefined;
  },
): void {
  if (
    approval.requestedBy !== expected.principalId ||
    approval.actionType !== "configuration.apply" ||
    approval.resource !== `configuration-proposal:${expected.proposalId}` ||
    approval.targetDeviceId !== expected.targetDeviceId ||
    approval.actionFingerprint !== createActionFingerprint(expected.descriptor)
  ) {
    throw new ApprovalServiceError(
      "APPROVAL_IDEMPOTENCY_CONFLICT",
      "The Configuration Approval identity already belongs to a different action.",
    );
  }
}

class ApprovalControlPlanePort implements ApprovalPort {
  readonly #service: ApprovalService;

  constructor(service: ApprovalService) {
    this.#service = service;
  }

  async list(): Promise<readonly ApprovalDetailV1[]> {
    try {
      return (await this.#service.list()).map(toApprovalDetail);
    } catch (error) {
      throw mapApprovalError(error);
    }
  }

  async get(approvalId: string): Promise<ApprovalDetailV1> {
    try {
      return toApprovalDetail(await this.#service.get(approvalId));
    } catch (error) {
      throw mapApprovalError(error);
    }
  }

  async decide(input: ApprovalDecisionInput): Promise<ApprovalDetailV1> {
    try {
      return toApprovalDetail(
        await this.#service.decide({
          approvalId: input.approvalId,
          idempotencyKey: input.idempotencyKey,
          decidedBy: input.principalId,
          decision:
            input.decision.decision === "approve"
              ? {
                  kind: "approve",
                  scope: input.decision.scope,
                }
              : {
                  kind: "deny",
                  reason: input.decision.reason,
                },
        }),
      );
    } catch (error) {
      throw mapApprovalError(error);
    }
  }
}

interface EncodedConfigurationValue {
  readonly present: boolean;
  readonly value?: ActionTargetValue;
}

interface EncodedConfigurationChange {
  readonly key: string;
  readonly scope: {
    readonly kind: ConfigurationDiff["scope"]["kind"];
    readonly id: string;
  };
  readonly before: EncodedConfigurationValue;
  readonly after: EncodedConfigurationValue;
}

interface ConfigurationExecutionPayload {
  readonly configurationOperationId: string;
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly context: ConfigurationContext;
  readonly changes: readonly EncodedConfigurationChange[];
}

function actionDescriptor(
  context: ConfigurationContext,
  expectedRevision: number,
  proposalId: string,
  changes: readonly EncodedConfigurationChange[],
): ActionTargetDescriptor {
  return {
    kind: "configuration",
    operation: "apply-proposal",
    target: {
      context: context as unknown as ActionTargetValue,
      expectedRevision,
      proposalId,
      changes: changes as unknown as ActionTargetValue,
    },
  };
}

function encodeContext(context: ConfigurationContext): ConfigurationContext {
  return {
    instanceId: context.instanceId,
    ...(context.mainId === undefined ? {} : { mainId: context.mainId }),
    ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
    ...(context.agentAdapterId === undefined ? {} : { agentAdapterId: context.agentAdapterId }),
    ...(context.transportId === undefined ? {} : { transportId: context.transportId }),
    ...(context.channelBindingId === undefined
      ? {}
      : { channelBindingId: context.channelBindingId }),
    ...(context.taskDefaultId === undefined ? {} : { taskDefaultId: context.taskDefaultId }),
    ...(context.artifactId === undefined ? {} : { artifactId: context.artifactId }),
  };
}

function encodeDiff(diff: readonly ConfigurationDiff[]): readonly EncodedConfigurationChange[] {
  return diff.map((change) => ({
    key: change.key,
    scope: {
      kind: change.scope.kind,
      id: change.scope.id,
    },
    before: encodeConfigurationValue(change.before),
    after: encodeConfigurationValue(change.after),
  }));
}

function encodeConfigurationValue(value: unknown): EncodedConfigurationValue {
  return value === undefined
    ? { present: false }
    : {
        present: true,
        value: structuredClone(value) as ActionTargetValue,
      };
}

function decodeDiff(changes: readonly EncodedConfigurationChange[]): readonly ConfigurationDiff[] {
  return changes.map((change) => ({
    key: change.key,
    scope: { ...change.scope },
    before: decodeConfigurationValue(change.before),
    after: decodeConfigurationValue(change.after),
  }));
}

function decodeConfigurationValue(value: EncodedConfigurationValue): unknown {
  return value.present ? structuredClone(value.value) : undefined;
}

function decodeConfigurationExecution(request: ApprovalRequest): ConfigurationExecutionPayload {
  if (request.execution.kind !== "configuration.apply" || !isRecord(request.execution.payload)) {
    throw new Error("The Approval does not contain a Configuration apply action.");
  }
  const payload = request.execution.payload;
  const configurationOperationId = requireIdentifier(
    payload["configurationOperationId"],
    "Configuration operation ID",
  );
  const proposalId = requireIdentifier(payload["proposalId"], "Configuration proposal ID");
  if (
    !Number.isSafeInteger(payload["expectedRevision"]) ||
    Number(payload["expectedRevision"]) < 0
  ) {
    throw new Error("The approved Configuration revision is invalid.");
  }
  const context = decodeContext(payload["context"]);
  const changes = decodeChanges(payload["changes"]);
  return {
    configurationOperationId,
    proposalId,
    expectedRevision: Number(payload["expectedRevision"]),
    context,
    changes,
  };
}

function decodeContext(value: unknown): ConfigurationContext {
  if (!isRecord(value)) {
    throw new Error("The approved Configuration context is invalid.");
  }
  return {
    instanceId: requireIdentifier(value["instanceId"], "Instance ID"),
    ...optionalIdentifier(value, "mainId"),
    ...optionalIdentifier(value, "deviceId"),
    ...optionalIdentifier(value, "agentAdapterId"),
    ...optionalIdentifier(value, "transportId"),
    ...optionalIdentifier(value, "channelBindingId"),
    ...optionalIdentifier(value, "taskDefaultId"),
    ...optionalIdentifier(value, "artifactId"),
  };
}

function optionalIdentifier(
  value: Record<string, unknown>,
  key: Exclude<keyof ConfigurationContext, "instanceId">,
): Partial<ConfigurationContext> {
  const candidate = value[key];
  return candidate === undefined ? {} : { [key]: requireIdentifier(candidate, key) };
}

function decodeChanges(value: unknown): readonly EncodedConfigurationChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error("The approved Configuration diff is invalid.");
  }
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item["scope"])) {
      throw new Error("The approved Configuration diff is invalid.");
    }
    const scope = item["scope"];
    const kind = scope["kind"];
    const kinds = [
      "instance",
      "main",
      "device",
      "agent-adapter",
      "transport",
      "channel-binding",
      "task-default",
      "artifact",
    ] as const;
    if (typeof kind !== "string" || !kinds.includes(kind as (typeof kinds)[number])) {
      throw new Error("The approved Configuration scope is invalid.");
    }
    return {
      key: requireIdentifier(item["key"], "Configuration key"),
      scope: {
        kind: kind as (typeof kinds)[number],
        id: requireIdentifier(scope["id"], "Configuration scope ID"),
      },
      before: decodeValue(item["before"]),
      after: decodeValue(item["after"]),
    };
  });
}

function decodeValue(value: unknown): EncodedConfigurationValue {
  if (!isRecord(value) || typeof value["present"] !== "boolean") {
    throw new Error("The approved Configuration value is invalid.");
  }
  if (value["present"] === false) {
    return { present: false };
  }
  if (!Object.hasOwn(value, "value")) {
    throw new Error("The approved Configuration value is missing.");
  }
  return {
    present: true,
    value: structuredClone(value["value"]) as ActionTargetValue,
  };
}

function toApprovalDetail(request: ApprovalRequest): ApprovalDetailV1 {
  const configuration =
    request.execution.kind === "configuration.apply"
      ? configurationPreview(decodeConfigurationExecution(request))
      : undefined;
  const decision =
    request.decision?.kind === "approve" && request.decision.grant !== undefined
      ? {
          decision: "approve" as const,
          scope: request.decision.grant.scope.kind,
          decidedBy: request.decision.decidedBy,
          decidedAt: new Date(request.decision.decidedAtMs).toISOString(),
        }
      : request.decision?.kind === "deny" && request.decision.denialReason !== undefined
        ? {
            decision: "deny" as const,
            reason: request.decision.denialReason,
            decidedBy: request.decision.decidedBy,
            decidedAt: new Date(request.decision.decidedAtMs).toISOString(),
          }
        : undefined;
  return {
    approvalId: request.approvalId,
    state: request.state,
    executionStatus: request.executionStatus,
    requestedAt: new Date(request.requestedAtMs).toISOString(),
    expiresAt: new Date(request.expiresAtMs).toISOString(),
    action: {
      category: request.actionCategory,
      type: request.actionType,
      fingerprint: request.actionFingerprint,
      ...(request.targetDeviceId === undefined ? {} : { targetDeviceId: request.targetDeviceId }),
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      resource: request.resource,
    },
    reason: request.presentation.reason,
    target: request.presentation.target,
    risk: request.presentation.risk,
    evidence: [...request.presentation.evidence],
    ...(configuration === undefined ? {} : { configuration }),
    ...(decision === undefined ? {} : { decision }),
    ...(request.executionErrorCode === undefined
      ? {}
      : { executionErrorCode: request.executionErrorCode }),
  };
}

function configurationPreview(
  payload: ConfigurationExecutionPayload,
): NonNullable<ApprovalDetailV1["configuration"]> {
  return {
    proposalId: payload.proposalId,
    baseRevision: payload.expectedRevision,
    changes: payload.changes.map((change) => ({
      key: change.key,
      scope: change.scope,
      before: previewValue(change.before),
      after: previewValue(change.after),
    })),
  };
}

function previewValue(
  value: EncodedConfigurationValue,
): NonNullable<ApprovalDetailV1["configuration"]>["changes"][number]["before"] {
  return value.present
    ? {
        present: true,
        valueJson: canonicalJson(value.value ?? null),
      }
    : { present: false };
}

function canonicalJson(value: ActionTargetValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, ActionTargetValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`)
    .join(",")}}`;
}

function categoryFor(
  input: ConfigurationMutationAuthorizationInput,
): "policy-relaxation" | "os-network-change" {
  return input.diff.some((change) => change.key.startsWith("transport."))
    ? "os-network-change"
    : "policy-relaxation";
}

function riskFor(input: ConfigurationMutationAuthorizationInput): ApprovalRisk {
  return input.diff.some(
    (change) =>
      change.key.startsWith("policy.") ||
      change.key.startsWith("transport.") ||
      change.key === "discord.binding" ||
      change.key === "artifact.exposure" ||
      change.key === "artifact.interactive-html",
  )
    ? "high"
    : "medium";
}

function approvalTargetDeviceId(
  input: ConfigurationMutationAuthorizationInput,
): string | undefined {
  const discordChanges = input.diff.filter((change) => change.key === "discord.binding");
  if (discordChanges.length === 0) {
    return input.context.deviceId;
  }
  if (
    discordChanges.length !== 1 ||
    discordChanges[0]?.scope.kind !== "main" ||
    discordChanges[0].scope.id !== input.context.mainId
  ) {
    throw new TypeError("A Discord binding Approval must target the current Main Device.");
  }
  return discordChanges[0].scope.id;
}

function mapApprovalError(error: unknown): ApprovalPortError {
  if (!(error instanceof ApprovalServiceError)) {
    return new ApprovalPortError("APPROVAL_UNAVAILABLE", "The Approval service is unavailable.");
  }
  switch (error.code) {
    case "APPROVAL_NOT_FOUND":
    case "APPROVAL_EXPIRED":
    case "APPROVAL_IDEMPOTENCY_CONFLICT":
    case "APPROVAL_DECISION_CONFLICT":
    case "APPROVAL_SCOPE_INVALID":
    case "APPROVAL_EXECUTION_FAILED":
      return new ApprovalPortError(error.code, error.message);
    case "APPROVAL_INPUT_INVALID":
    case "APPROVAL_SECRET_VALUE_REJECTED":
    case "APPROVAL_DATA_CORRUPT":
      return new ApprovalPortError("APPROVAL_UNAVAILABLE", "The Approval service is unavailable.");
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 500 ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, ActionTargetValue | undefined> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
