import { createHash } from "node:crypto";

import type {
  MainActionAuthorizationDecision,
  MainActionAuthorizationRequest,
  MainActionConsumptionDecision,
  MainActionConsumptionRequest,
  WorkerActionAuthorizationRequestV1,
} from "@opendelegate/device-channel";
import { createActionFingerprint, evaluateAction } from "@opendelegate/policy";
import type {
  ActionCategory,
  ActionFingerprint,
  ActionTargetDescriptor,
  ActionTargetValue,
  ApprovalExecutionContext,
  ApprovalExecutionPort,
  ApprovalRequest,
  ApprovalService,
  OwnerGrant,
} from "@opendelegate/policy";
import type {
  ActionAuthorizationRecord,
  ActionAuthorizationRepository,
} from "@opendelegate/storage-sql";

const MAXIMUM_STATE_BYTES = 512 * 1024;
const ACTION_CATEGORIES = new Set<ActionCategory>([
  "read-only-observation",
  "opendelegate-process-retry",
  "opendelegate-process-restart",
  "project-dependency-install",
  "configured-official-package-install",
  "computer-use-input",
  "sandbox-boundary-escalation",
  "package-repository-addition",
  "remote-installer-script",
  "untrusted-installer",
  "driver-installation",
  "kernel-extension-installation",
  "os-network-change",
  "vpn-change",
  "firewall-change",
  "policy-relaxation",
  "secret-export",
  "cross-device-knowledge-transfer",
  "policy-bypass-attempt",
]);

export interface MainActionRunAuthorityPort {
  authorizeWorkerActionRun(
    authenticatedDeviceId: string,
    scope: {
      readonly taskId: string;
      readonly workOrderId: string;
      readonly deviceId: string;
      readonly workerId: string;
      readonly routeId: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
    },
  ): Promise<{ readonly authorized: boolean; readonly leaseExpiresAtMs?: number }>;
}

export type MainConfiguredActionPolicyDecision = "allow" | "require-approval" | "deny" | undefined;

export interface MainConfiguredActionPolicyPort {
  decide(input: {
    readonly deviceId: string;
    readonly actionCategory: ActionCategory;
  }): Promise<MainConfiguredActionPolicyDecision>;
}

export interface MainActionAuthorizationRuntimeOptions {
  readonly repository: ActionAuthorizationRepository;
  readonly runAuthority: MainActionRunAuthorityPort;
  readonly clock?: { now(): number };
  readonly configuredGrants?: () => Promise<readonly OwnerGrant[]>;
  readonly configuredPolicy?: MainConfiguredActionPolicyPort;
  readonly approvalExpirationMs?: number;
}

export interface MainActionAuthorizationAuditRecord {
  readonly auditId: string;
  readonly event: string;
  readonly occurredAtMs: number;
  readonly authorizationId: string;
  readonly authorizationRequestId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly deviceId: string;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly reasonCode: string;
  readonly consumed: boolean;
}

interface StoredActionAuthorization {
  readonly request: WorkerActionAuthorizationRequestV1;
  readonly requestDigest: string;
  readonly authorizationId: string;
  readonly policyFingerprint: ActionFingerprint;
  readonly approvalId?: string;
  readonly decision: "allow" | "deny" | "require-approval";
  readonly reasonCode: string;
  readonly grant?: OwnerGrant;
  readonly approvalExecutionSucceeded?: true;
  readonly consumptionDigest?: string;
  readonly consumedAtMs?: number;
}

export class MainActionAuthorizationRuntime implements ApprovalExecutionPort {
  readonly #repository: ActionAuthorizationRepository;
  readonly #runAuthority: MainActionRunAuthorityPort;
  readonly #clock: { now(): number };
  readonly #configuredGrants: () => Promise<readonly OwnerGrant[]>;
  readonly #configuredPolicy: MainConfiguredActionPolicyPort | undefined;
  readonly #approvalExpirationMs: number;
  #approvals: ApprovalService | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  public constructor(options: MainActionAuthorizationRuntimeOptions) {
    this.#repository = options.repository;
    this.#runAuthority = options.runAuthority;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#configuredGrants = options.configuredGrants ?? (async () => []);
    this.#configuredPolicy = options.configuredPolicy;
    this.#approvalExpirationMs = options.approvalExpirationMs ?? 24 * 60 * 60_000;
    if (
      options.repository === null ||
      typeof options.repository !== "object" ||
      typeof options.repository.read !== "function" ||
      typeof options.repository.list !== "function" ||
      typeof options.repository.write !== "function" ||
      typeof options.repository.transact !== "function" ||
      typeof options.repository.close !== "function" ||
      typeof options.runAuthority?.authorizeWorkerActionRun !== "function" ||
      (this.#configuredPolicy !== undefined &&
        (this.#configuredPolicy === null ||
          typeof this.#configuredPolicy !== "object" ||
          typeof this.#configuredPolicy.decide !== "function")) ||
      !Number.isSafeInteger(this.#approvalExpirationMs) ||
      this.#approvalExpirationMs <= 0 ||
      this.#approvalExpirationMs > 30 * 24 * 60 * 60_000
    ) {
      throw new TypeError("The Main action authorization runtime configuration is invalid.");
    }
  }

  public attachApprovalService(service: ApprovalService): void {
    if (
      this.#approvals !== undefined ||
      service === null ||
      typeof service !== "object" ||
      typeof service.request !== "function"
    ) {
      throw new TypeError("The Approval Service attachment is invalid.");
    }
    this.#approvals = service;
  }

  public async authorize(
    input: MainActionAuthorizationRequest,
  ): Promise<MainActionAuthorizationDecision> {
    this.#assertOpen();
    const request = validateAuthorizationRequest(input);
    const now = this.#now();
    const descriptor = policyDescriptor(request);
    const policyFingerprint = createActionFingerprint(descriptor);
    const requestDigest = digest(request);
    let stored = await this.#load(request.authorizationRequestId);
    if (stored !== undefined) {
      assertStoredRequest(stored, request, requestDigest, policyFingerprint);
    } else {
      stored = {
        request,
        requestDigest,
        authorizationId: authorizationId(request.authorizationRequestId),
        policyFingerprint,
        decision: "require-approval",
        reasonCode: "POLICY_APPROVAL_REQUIRED",
      };
      await this.#save(stored, now);
    }
    const runCurrent = await this.#authorizeRun(input.authenticatedDeviceId, request);
    if (!runCurrent) {
      const denied = { ...stored, decision: "deny" as const, reasonCode: "RUN_NOT_CURRENT" };
      await this.#save(denied, now);
      return decisionFrom(denied);
    }

    const approvals = this.#approvals;
    const approvalRequests =
      approvals === undefined ? [] : await approvals.list({ state: "approved" });
    const grants = [
      ...(await this.#configuredGrants()),
      ...approvalRequests.flatMap((approval) =>
        approval.executionStatus === "succeeded" &&
        approval.decision?.kind === "approve" &&
        approval.decision.grant !== undefined
          ? [approval.decision.grant]
          : [],
      ),
    ];
    const actionRequest = {
      requestId: request.authorizationRequestId,
      actionCategory: requireActionCategory(request.actionCategory),
      actionFingerprint: policyFingerprint,
      taskId: request.taskId,
      deviceId: request.deviceId,
    };
    const matchingGrant = grants
      .filter((grant) => grantMatches(actionRequest, grant, now))
      .sort(compareGrantScope)[0];
    const configuredDecision = await this.#currentConfiguredDecision(
      request.deviceId,
      actionRequest.actionCategory,
    );
    if (configuredDecision === "unavailable") {
      return await this.#recordTerminal(request, "deny", "CONFIGURATION_POLICY_UNAVAILABLE");
    }
    if (configuredDecision === "deny") {
      return await this.#recordTerminal(request, "deny", "CONFIGURATION_POLICY_DENIED");
    }
    const policy = evaluateAction(actionRequest, { now, grants });
    if (
      matchingGrant !== undefined ||
      configuredDecision === "allow" ||
      (configuredDecision === undefined && policy.outcome === "allow")
    ) {
      const allowed: StoredActionAuthorization = {
        ...stored,
        decision: "allow",
        reasonCode:
          matchingGrant !== undefined
            ? "POLICY_OWNER_GRANT"
            : configuredDecision === "allow"
              ? "CONFIGURATION_POLICY_ALLOWED"
              : policy.code,
        ...(matchingGrant === undefined ? {} : { grant: matchingGrant }),
      };
      await this.#save(allowed, now);
      return decisionFrom(allowed);
    }
    if (configuredDecision === undefined && policy.outcome === "deny") {
      return await this.#recordTerminal(request, "deny", policy.code);
    }
    if (configuredDecision === "require-approval") {
      stored = {
        ...stored,
        decision: "require-approval",
        reasonCode: "CONFIGURATION_POLICY_APPROVAL_REQUIRED",
      };
      await this.#save(stored, now);
    }
    if (approvals === undefined) {
      return decisionFrom(stored);
    }

    let approval: ApprovalRequest;
    if (stored.approvalId === undefined) {
      approval = await approvals.request({
        idempotencyKey: `worker-action:${request.authorizationRequestId}`,
        requestedBy: `worker:${request.deviceId}`,
        // This is the owner-decision/grant TTL, not the originating Run lease.
        // Every authorization and consumption still revalidates its exact current
        // Run, while Task/Device/Policy scopes may intentionally outlive that Run.
        expiresAtMs: now + this.#approvalExpirationMs,
        actionCategory: actionRequest.actionCategory,
        actionType: request.actionType,
        targetDeviceId: request.deviceId,
        taskId: request.taskId,
        resource: `worker-run:${request.runId}`,
        descriptor,
        presentation: {
          reason: "A Worker requested an exact mutating action.",
          target: `${request.deviceId} / ${request.actionType}`,
          risk: request.actionCategory === "computer-use-input" ? "high" : "medium",
          evidence: [
            `Task ${request.taskId}`,
            `Work Order ${request.workOrderId}`,
            `Run ${request.runId}`,
            `Action fingerprint ${request.actionFingerprint}`,
          ],
        },
        execution: {
          kind: "worker-action.authorize",
          payload: {
            actionRequestId: request.authorizationRequestId,
            requestHash: requestDigest,
          },
        },
      });
      stored = { ...stored, approvalId: approval.approvalId };
      await this.#save(stored, now);
    } else {
      approval = await approvals.get(stored.approvalId);
    }

    if (approval.state === "denied" || approval.state === "expired") {
      return await this.#recordTerminal(
        request,
        "deny",
        approval.state === "denied" ? "OWNER_DENIED" : "APPROVAL_EXPIRED",
      );
    }
    if (approval.state === "approved" && approval.executionStatus === "failed") {
      return await this.#recordTerminal(request, "deny", "APPROVAL_EXECUTION_FAILED");
    }
    if (
      approval.state === "approved" &&
      approval.executionStatus === "succeeded" &&
      approval.decision?.kind === "approve" &&
      approval.decision.grant !== undefined
    ) {
      const allowed = {
        ...stored,
        decision: "allow" as const,
        reasonCode: "POLICY_OWNER_GRANT",
        grant: approval.decision.grant,
        approvalExecutionSucceeded: true as const,
      };
      await this.#save(allowed, now);
      return decisionFrom(allowed);
    }
    return decisionFrom(stored);
  }

  public async consume(
    input: MainActionConsumptionRequest,
  ): Promise<MainActionConsumptionDecision> {
    this.#assertOpen();
    const request = validateConsumptionRequest(input);
    const runCurrent = await this.#authorizeRun(input.authenticatedDeviceId, request);
    if (!runCurrent) {
      return { decision: "deny", reasonCode: "RUN_NOT_CURRENT" };
    }
    const consumptionDigest = digest(request);
    const now = this.#now();
    const approvalBound = await this.#load(request.authorizationRequestId);
    const configuredDecision = await this.#currentConfiguredDecision(
      request.deviceId,
      requireActionCategory(request.actionCategory),
    );
    if (configuredDecision === "unavailable") {
      return { decision: "deny", reasonCode: "CONFIGURATION_POLICY_UNAVAILABLE" };
    }
    if (configuredDecision === "deny") {
      return { decision: "deny", reasonCode: "CONFIGURATION_POLICY_DENIED" };
    }
    const approvalExecutionSucceeded =
      configuredDecision === "allow" ||
      approvalBound?.approvalId === undefined ||
      approvalBound.approvalExecutionSucceeded === true ||
      (await this.#approvalExecutionSucceeded(approvalBound.approvalId));
    if (!approvalExecutionSucceeded) {
      return { decision: "deny", reasonCode: "AUTHORIZATION_NOT_EXECUTABLE" };
    }
    return await this.#repository.transact(request.authorizationRequestId, (record) => {
      const stored = record === undefined ? undefined : this.#decodeRecord(record);
      if (
        stored === undefined ||
        stored.authorizationId !== request.authorizationId ||
        stored.request.actionCategory !== request.actionCategory ||
        stored.request.actionFingerprint !== request.actionFingerprint ||
        stored.decision !== "allow" ||
        (stored.grant !== undefined &&
          stored.grant.expiresAt <= now &&
          configuredDecision !== "allow") ||
        (configuredDecision === "require-approval" && stored.grant === undefined) ||
        (stored.approvalId !== undefined &&
          (approvalBound?.approvalId !== stored.approvalId || !approvalExecutionSucceeded))
      ) {
        return {
          result: {
            decision: "deny",
            reasonCode: "AUTHORIZATION_NOT_EXECUTABLE",
          } satisfies MainActionConsumptionDecision,
        };
      }
      assertSameRun(stored.request, request);
      if (stored.consumptionDigest !== undefined) {
        return {
          result:
            stored.consumptionDigest === consumptionDigest
              ? ({
                  decision: "consumed",
                  reasonCode: "CONSUMPTION_REPLAY",
                } satisfies MainActionConsumptionDecision)
              : ({
                  decision: "deny",
                  reasonCode: "AUTHORIZATION_ALREADY_CONSUMED",
                } satisfies MainActionConsumptionDecision),
        };
      }
      const next: StoredActionAuthorization = {
        ...stored,
        ...(stored.approvalId === undefined ? {} : { approvalExecutionSucceeded: true as const }),
        consumptionDigest,
        consumedAtMs: now,
      };
      return {
        result: {
          decision: "consumed",
          reasonCode: "AUTHORIZATION_CONSUMED",
        } satisfies MainActionConsumptionDecision,
        next: this.#encodeRecord(next, now),
      };
    });
  }

  public async execute(input: ApprovalExecutionContext): Promise<ActionTargetValue> {
    this.#assertOpen();
    if (input.approval.execution.kind !== "worker-action.authorize") {
      throw new Error("The Approval execution does not target Worker action authorization.");
    }
    const payload = requireRecord(input.approval.execution.payload);
    const requestId = requireIdentifier(payload["actionRequestId"], "authorization request ID");
    const requestDigest = requireIdentifier(payload["requestHash"], "request digest");
    const now = this.#now();
    const allowed = await this.#repository.transact(requestId, (record) => {
      const stored = record === undefined ? undefined : this.#decodeRecord(record);
      if (
        stored === undefined ||
        stored.requestDigest !== requestDigest ||
        input.approval.actionFingerprint !== stored.policyFingerprint ||
        input.grant.actionCategory !== stored.request.actionCategory ||
        input.grant.scope.actionFingerprint !== stored.policyFingerprint
      ) {
        throw new Error("The approved Worker action no longer matches its exact request.");
      }
      const next: StoredActionAuthorization = {
        ...stored,
        approvalId: input.approval.approvalId,
        decision: "allow",
        reasonCode: "POLICY_OWNER_GRANT",
        grant: input.grant,
      };
      return {
        result: next,
        next: this.#encodeRecord(next, now),
      };
    });
    return {
      requestId: allowed.request.authorizationRequestId,
      state: "authorized",
    };
  }

  public async listAudit(): Promise<readonly MainActionAuthorizationAuditRecord[]> {
    this.#assertOpen();
    const records = await this.#repository.list();
    return Object.freeze(
      records.map((record) => {
        const state = this.#decodeRecord(record);
        const consumed = state.consumptionDigest !== undefined;
        return Object.freeze({
          auditId: `action-authorization-audit:${digestText(
            state.request.authorizationRequestId,
          ).slice(0, 32)}`,
          event: `worker.action.${state.request.actionCategory}.${
            consumed
              ? "consumed"
              : state.decision === "allow"
                ? "authorized"
                : state.decision === "deny"
                  ? "denied"
                  : "approval-required"
          }`,
          occurredAtMs: state.consumedAtMs ?? record.updatedAtMs,
          authorizationId: state.authorizationId,
          authorizationRequestId: state.request.authorizationRequestId,
          taskId: state.request.taskId,
          runId: state.request.runId,
          deviceId: state.request.deviceId,
          decision: state.decision,
          reasonCode: state.reasonCode,
          consumed,
        });
      }),
    );
  }

  public close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closed = true;
      this.#closePromise = this.#repository.close();
    }
    return this.#closePromise;
  }

  async #recordTerminal(
    request: WorkerActionAuthorizationRequestV1,
    decision: "deny" | "require-approval",
    reasonCode: string,
  ): Promise<MainActionAuthorizationDecision> {
    const descriptor = policyDescriptor(request);
    const existing = await this.#load(request.authorizationRequestId);
    const stored: StoredActionAuthorization =
      existing === undefined
        ? {
            request,
            requestDigest: digest(request),
            authorizationId: authorizationId(request.authorizationRequestId),
            policyFingerprint: createActionFingerprint(descriptor),
            decision,
            reasonCode,
          }
        : {
            ...existing,
            decision,
            reasonCode,
          };
    await this.#save(stored, this.#now());
    return decisionFrom(stored);
  }

  async #authorizeRun(
    authenticatedDeviceId: string,
    request: {
      readonly taskId: string;
      readonly workOrderId: string;
      readonly deviceId: string;
      readonly workerId: string;
      readonly routeId: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
      readonly leaseExpiresAtMs: number;
    },
  ): Promise<boolean> {
    if (authenticatedDeviceId !== request.deviceId) {
      return false;
    }
    try {
      const result = await this.#runAuthority.authorizeWorkerActionRun(
        authenticatedDeviceId,
        request,
      );
      return (
        result.authorized === true &&
        result.leaseExpiresAtMs !== undefined &&
        result.leaseExpiresAtMs >= request.leaseExpiresAtMs
      );
    } catch {
      return false;
    }
  }

  async #approvalExecutionSucceeded(approvalId: string): Promise<boolean> {
    try {
      const approval = await this.#approvals?.get(approvalId);
      return (
        approval?.state === "approved" &&
        approval.executionStatus === "succeeded" &&
        approval.decision?.kind === "approve"
      );
    } catch {
      return false;
    }
  }

  async #currentConfiguredDecision(
    deviceId: string,
    actionCategory: ActionCategory,
  ): Promise<MainConfiguredActionPolicyDecision | "unavailable"> {
    if (this.#configuredPolicy === undefined) {
      return undefined;
    }
    try {
      const decision = await this.#configuredPolicy.decide({
        deviceId,
        actionCategory,
      });
      return decision === undefined ||
        decision === "allow" ||
        decision === "require-approval" ||
        decision === "deny"
        ? decision
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async #load(requestId: string): Promise<StoredActionAuthorization | undefined> {
    const record = await this.#repository.read(requestId);
    return record === undefined ? undefined : this.#decodeRecord(record);
  }

  #decodeRecord(record: ActionAuthorizationRecord): StoredActionAuthorization {
    try {
      if (
        digestText(record.stateJson) !== record.stateSha256 ||
        Buffer.byteLength(record.stateJson, "utf8") > MAXIMUM_STATE_BYTES
      ) {
        throw new Error("integrity mismatch");
      }
      const state = JSON.parse(record.stateJson) as StoredActionAuthorization;
      if (
        state === null ||
        typeof state !== "object" ||
        state.request === null ||
        typeof state.request !== "object" ||
        state.request.authorizationRequestId !== record.authorizationRequestId ||
        state.requestDigest !== record.requestDigest ||
        state.authorizationId !== record.authorizationId ||
        state.policyFingerprint !== record.policyFingerprint ||
        (state.consumptionDigest === undefined) !== (state.consumedAtMs === undefined) ||
        (state.consumptionDigest !== undefined &&
          (state.consumedAtMs === undefined ||
            !/^[a-f0-9]{64}$/u.test(state.consumptionDigest) ||
            !Number.isSafeInteger(state.consumedAtMs) ||
            state.consumedAtMs < 0))
      ) {
        throw new Error("column mismatch");
      }
      return state;
    } catch (error) {
      throw new Error("The Main action authorization state is corrupt.", {
        cause: error,
      });
    }
  }

  #encodeRecord(state: StoredActionAuthorization, now: number): ActionAuthorizationRecord {
    const stateJson = canonicalJson(state);
    if (Buffer.byteLength(stateJson, "utf8") > MAXIMUM_STATE_BYTES) {
      throw new Error("The Main action authorization state exceeds its bound.");
    }
    return Object.freeze({
      authorizationRequestId: state.request.authorizationRequestId,
      requestDigest: state.requestDigest,
      authorizationId: state.authorizationId,
      policyFingerprint: state.policyFingerprint,
      stateJson,
      stateSha256: digestText(stateJson),
      updatedAtMs: now,
    });
  }

  async #save(state: StoredActionAuthorization, now: number): Promise<void> {
    await this.#repository.transact(state.request.authorizationRequestId, (currentRecord) => {
      let next = state;
      if (currentRecord !== undefined) {
        const current = this.#decodeRecord(currentRecord);
        assertStoredRequest(current, state.request, state.requestDigest, state.policyFingerprint);
        if (current.consumptionDigest !== undefined) {
          const consumedAtMs = current.consumedAtMs;
          if (consumedAtMs === undefined) {
            throw new Error("The Main action authorization state is corrupt.");
          }
          if (
            state.consumptionDigest !== undefined &&
            state.consumptionDigest !== current.consumptionDigest
          ) {
            throw new Error(
              "The consumed action authorization cannot be replaced by another consumption.",
            );
          }
          next = {
            ...state,
            consumptionDigest: current.consumptionDigest,
            consumedAtMs,
          };
        }
      }
      return {
        result: undefined,
        next: this.#encodeRecord(next, now),
      };
    });
  }

  #now(): number {
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("The Main action authorization clock is invalid.");
    }
    return now;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("The Main action authorization runtime is closed.");
    }
  }
}

function decisionFrom(state: StoredActionAuthorization): MainActionAuthorizationDecision {
  return Object.freeze({
    decision: state.decision,
    authorizationId: state.authorizationId,
    reasonCode: state.reasonCode,
  });
}

function validateAuthorizationRequest(
  input: MainActionAuthorizationRequest,
): WorkerActionAuthorizationRequestV1 {
  const request = structuredClone(input.request);
  requireIdentifier(input.requestMessageId, "request message ID");
  requireIdentifier(input.idempotencyKey, "idempotency key");
  requireActionCategory(request.actionCategory);
  if (
    input.authenticatedDeviceId !== request.deviceId ||
    !/^sha256:[a-f0-9]{64}$/u.test(request.actionFingerprint)
  ) {
    throw new Error("The Worker action authorization request is invalid.");
  }
  return Object.freeze(request);
}

function validateConsumptionRequest(input: MainActionConsumptionRequest) {
  const request = structuredClone(input.request);
  requireIdentifier(input.requestMessageId, "request message ID");
  requireIdentifier(input.idempotencyKey, "idempotency key");
  requireActionCategory(request.actionCategory);
  if (
    input.authenticatedDeviceId !== request.deviceId ||
    !/^sha256:[a-f0-9]{64}$/u.test(request.actionFingerprint)
  ) {
    throw new Error("The Worker action consumption request is invalid.");
  }
  return Object.freeze(request);
}

function policyDescriptor(request: WorkerActionAuthorizationRequestV1): ActionTargetDescriptor {
  return {
    kind: "worker-action",
    operation: request.actionType,
    target: {
      actionCategory: request.actionCategory,
      exactActionFingerprint: request.actionFingerprint,
      actionDescriptor: request.actionDescriptor,
    } as ActionTargetValue,
  };
}

function assertStoredRequest(
  stored: StoredActionAuthorization,
  request: WorkerActionAuthorizationRequestV1,
  requestDigest: string,
  policyFingerprint: ActionFingerprint,
): void {
  if (
    stored.requestDigest !== requestDigest ||
    stored.policyFingerprint !== policyFingerprint ||
    canonicalJson(stored.request) !== canonicalJson(request)
  ) {
    throw new Error("The authorization request ID was reused for different input.");
  }
}

function assertSameRun(
  authorized: WorkerActionAuthorizationRequestV1,
  consumed: MainActionConsumptionRequest["request"],
): void {
  for (const key of [
    "taskId",
    "workOrderId",
    "deviceId",
    "workerId",
    "routeId",
    "runId",
    "leaseId",
    "fencingToken",
    "leaseExpiresAtMs",
  ] as const) {
    if (authorized[key] !== consumed[key]) {
      throw new Error("The action consumption escaped its authorized Run.");
    }
  }
}

function grantMatches(
  request: {
    readonly requestId: string;
    readonly actionCategory: ActionCategory;
    readonly actionFingerprint: ActionFingerprint;
    readonly taskId: string;
    readonly deviceId: string;
  },
  grant: OwnerGrant,
  now: number,
): boolean {
  if (
    grant.issuer !== "owner" ||
    grant.actionCategory !== request.actionCategory ||
    grant.expiresAt <= now ||
    grant.scope.actionFingerprint !== request.actionFingerprint
  ) {
    return false;
  }
  switch (grant.scope.kind) {
    case "once":
      return grant.scope.requestId === request.requestId;
    case "task":
      return grant.scope.taskId === request.taskId;
    case "device":
      return grant.scope.deviceId === request.deviceId;
    case "policy":
      return true;
  }
}

function compareGrantScope(left: OwnerGrant, right: OwnerGrant): number {
  const ranks = { once: 0, task: 1, device: 2, policy: 3 } as const;
  return ranks[left.scope.kind] - ranks[right.scope.kind];
}

function requireActionCategory(value: string): ActionCategory {
  if (!ACTION_CATEGORIES.has(value as ActionCategory)) {
    throw new Error("The action category is unsupported.");
  }
  return value as ActionCategory;
}

function authorizationId(requestId: string): string {
  return `authorization:${digestText(requestId)}`;
}

function digest(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Approval execution payload is invalid.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}
