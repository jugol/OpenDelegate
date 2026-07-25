import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type ComputerUseReadinessReport,
  type ComputerUseSession,
  type DesktopLease,
  type DesktopLeasePort,
  type DesktopLeaseRequest,
  type DesktopLeaseResult,
  type StartComputerUseInput,
} from "@opendelegate/computer-use-os";
import {
  ComputerUseToolPortError,
  type ComputerUseClickInput,
  type ComputerUseKeyInput,
  type ComputerUseRunAuthority,
  type ComputerUseScrollInput,
  type ComputerUseStopInput,
  type ComputerUseToolActionReceipt,
  type ComputerUseToolCapture,
  type ComputerUseToolContext,
  type ComputerUseToolObservation,
  type ComputerUseToolPort,
  type ComputerUseToolReadiness,
  type ComputerUseToolName,
  type ComputerUseToolStopReceipt,
  type ComputerUseTypeTextInput,
} from "@opendelegate/computer-use-mcp";
import {
  type LocalRunCapabilityBroker,
  type RunCapabilityBinding,
  type RunCapabilityClient,
  type RunCapabilityJsonValue,
  type RunCapabilityLease,
  consumeRunCapabilityFile,
} from "@opendelegate/run-capability-broker";
import type {
  WorkerRunAssignmentV1,
  WorkerRunCapabilityLease,
  WorkerRunCapabilityProvider,
  WorkerRunLeaseAuthority,
} from "@opendelegate/worker-runtime";

import {
  type WorkerDesktopLeaseClaim,
  type WorkerDesktopLeaseClaimInput,
  type WorkerDesktopLeaseReleaseDisposition,
} from "./desktop-lease-authority.ts";

export const WORKER_COMPUTER_USE_TOOL_NAMES = Object.freeze([
  "computer_use_readiness",
  "computer_use_observe",
  "computer_use_capture",
  "computer_use_click",
  "computer_use_type_text",
  "computer_use_stop",
] satisfies readonly ComputerUseToolName[]);
import { WorkerComputerUseToolPort } from "./computer-use-tool-port.ts";

const COMPUTER_USE_CAPABILITY = "computer-use";
const CAPABILITY_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_TIMEOUT_MS = 2 * 60 * 60_000;
const MAXIMUM_IDENTIFIER_BYTES = 512;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export interface WorkerComputerUseBackendPort {
  readiness(
    request: Pick<
      StartComputerUseInput,
      "deviceId" | "helperInstanceId" | "serviceEpoch" | "persistenceGeneration"
    >,
  ): Promise<ComputerUseReadinessReport>;
  start(input: StartComputerUseInput): Promise<ComputerUseSession>;
}

export interface WorkerComputerUseDesktopAuthorityPort extends DesktopLeasePort {
  claim(input: WorkerDesktopLeaseClaimInput): Promise<WorkerDesktopLeaseClaim>;
  renew?(
    request: DesktopLeaseRequest,
    run: Pick<
      WorkerDesktopLeaseClaimInput,
      "runLeaseId" | "runFencingToken" | "runLeaseExpiresAtMs"
    >,
  ): Promise<
    | { readonly disposition: "renewed"; readonly lease: DesktopLease }
    | { readonly disposition: "stale" }
  >;
  release(request: DesktopLeaseRequest): Promise<WorkerDesktopLeaseReleaseDisposition>;
}

export interface WorkerComputerUseDesktopBinding {
  readonly helperInstanceId: string;
  readonly serviceEpoch: number;
  readonly persistenceGeneration: number;
}

export interface WorkerComputerUseRunCapabilityProviderOptions {
  /**
   * Must place the supplied exact-Run lease port inside ComputerUseOsBackend.
   * A shared backend with a wider DesktopLeasePort is intentionally impossible
   * to pass through this production composition seam.
   */
  readonly backendFactory: (context: {
    readonly leases: DesktopLeasePort;
    readonly assignment: WorkerRunAssignmentV1;
    readonly leaseAuthority: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }) => WorkerComputerUseBackendPort;
  readonly broker: LocalRunCapabilityBroker;
  readonly desktopAuthority: WorkerComputerUseDesktopAuthorityPort;
  readonly desktopBinding: WorkerComputerUseDesktopBinding;
  readonly toolServerCommand: string;
  readonly toolServerArgsPrefix?: readonly string[];
  readonly clock?: { now(): number };
  readonly sessionTimeoutMs?: number;
}

/**
 * Claims the Device's capacity-one desktop and exposes exactly one verified Run
 * through an opaque local Computer Use MCP bridge.
 */
export class WorkerComputerUseRunCapabilityProvider implements WorkerRunCapabilityProvider {
  readonly #options: WorkerComputerUseRunCapabilityProviderOptions;

  public constructor(options: WorkerComputerUseRunCapabilityProviderOptions) {
    validateProviderOptions(options);
    this.#options = options;
  }

  public async prepare(context: {
    readonly assignment: WorkerRunAssignmentV1;
    readonly leaseAuthority?: WorkerRunLeaseAuthority;
    isExecutionCurrent(): Promise<boolean>;
  }): Promise<WorkerRunCapabilityLease | undefined> {
    if (!context.assignment.workOrder.requiredCapabilities.includes(COMPUTER_USE_CAPABILITY)) {
      return undefined;
    }
    if (!(await safeCurrent(context.isExecutionCurrent))) {
      throw new ComputerUseToolPortError("STALE_AUTHORITY");
    }
    const leaseAuthority = context.leaseAuthority ?? staticRunLeaseAuthority(context.assignment);
    const initialLeaseExpiresAtMs = leaseAuthority.snapshot().leaseExpiresAtMs;
    const claim = await this.#options.desktopAuthority.claim({
      taskId: context.assignment.taskId,
      deviceId: context.assignment.deviceId,
      runId: context.assignment.runId,
      runLeaseId: context.assignment.leaseId,
      runFencingToken: context.assignment.fencingToken,
      runLeaseExpiresAtMs: initialLeaseExpiresAtMs,
    });
    if (claim.disposition === "busy") {
      throw new ComputerUseToolPortError("NOT_READY");
    }
    const desktopLease = claim.lease;
    const currentLeases = new CurrentRunDesktopLeasePort({
      desktopAuthority: this.#options.desktopAuthority,
      assignment: context.assignment,
      leaseAuthority,
      desktopLease: claim.lease,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    const backend = this.#options.backendFactory({
      leases: currentLeases,
      assignment: structuredClone(context.assignment),
      leaseAuthority,
      isExecutionCurrent: context.isExecutionCurrent,
    });
    const readinessRequest = {
      deviceId: context.assignment.deviceId,
      ...this.#options.desktopBinding,
    };
    const desktopAuthority = this.#options.desktopAuthority;
    let session: ComputerUseSession | undefined;
    let brokerLease: RunCapabilityLease | undefined;
    try {
      const readiness = await backend.readiness(readinessRequest);
      if (
        readiness.status !== "ready" ||
        readiness.displayFingerprint === null ||
        readiness.checks.some((check) => check.status !== "pass")
      ) {
        throw new ComputerUseToolPortError("NOT_READY");
      }
      if (!(await safeCurrent(context.isExecutionCurrent))) {
        throw new ComputerUseToolPortError("STALE_AUTHORITY");
      }
      session = await backend.start({
        ...readinessRequest,
        commandId: startCommandId(context.assignment),
        taskId: context.assignment.taskId,
        runId: context.assignment.runId,
        lease: desktopLease,
        timeoutMs: Math.min(
          this.#options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
          DEFAULT_SESSION_TIMEOUT_MS,
        ),
      });
      if (!(await safeCurrent(context.isExecutionCurrent))) {
        throw new ComputerUseToolPortError("STALE_AUTHORITY");
      }
      const authority = computerUseAuthority(
        context.assignment,
        desktopLease,
        this.#options.desktopBinding,
        session.executionHandleId,
      );
      const toolPort = new WorkerComputerUseToolPort({
        authority,
        session,
        readiness: () => backend.readiness(readinessRequest),
        isExecutionCurrent: context.isExecutionCurrent,
        leases: currentLeases,
      });
      brokerLease = await this.#options.broker.register({
        capability: COMPUTER_USE_CAPABILITY,
        binding: runCapabilityBinding(
          context.assignment,
          leaseAuthority.snapshot().leaseExpiresAtMs,
        ),
        metadata: authority as unknown as RunCapabilityJsonValue,
        expiresAtMs: leaseAuthority.snapshot().leaseExpiresAtMs,
        currentBinding: () =>
          runCapabilityBinding(context.assignment, leaseAuthority.snapshot().leaseExpiresAtMs),
        isExecutionCurrent: context.isExecutionCurrent,
        handler: (request, requestContext) =>
          dispatchComputerUseRequest(
            toolPort,
            authority,
            request.method,
            request.payload,
            requestContext.signal,
          ),
      });
      const lease = brokerLease;
      const activeSession = session;
      let disposed = false;
      return Object.freeze({
        toolServers: Object.freeze([
          Object.freeze({
            serverName: "opendelegate-computer-use",
            command: this.#options.toolServerCommand,
            args: Object.freeze([
              ...(this.#options.toolServerArgsPrefix ?? []),
              "mcp-bridge",
              "--capability-file",
              lease.capabilityFile,
            ]),
            enabledTools: WORKER_COMPUTER_USE_TOOL_NAMES,
            startupTimeoutMs: 15_000,
            toolTimeoutMs: 60_000,
          }),
        ]),
        async dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          await lease.dispose().catch(() => undefined);
          await activeSession.release().catch(() => undefined);
          await releaseDesktop(context.assignment, currentLeases.snapshot(), desktopAuthority);
        },
      });
    } catch (error) {
      await brokerLease?.dispose().catch(() => undefined);
      await session?.emergencyStop().catch(() => undefined);
      await releaseDesktop(context.assignment, currentLeases.snapshot(), desktopAuthority);
      throw error;
    }
  }
}

export class CurrentRunDesktopLeasePort implements DesktopLeasePort {
  readonly #desktopAuthority: DesktopLeasePort &
    Partial<Pick<WorkerComputerUseDesktopAuthorityPort, "renew">>;
  readonly #assignment: WorkerRunAssignmentV1 | undefined;
  readonly #leaseAuthority: WorkerRunLeaseAuthority | undefined;
  readonly #isExecutionCurrent: () => Promise<boolean>;
  #desktopLease: DesktopLease | undefined;
  #verificationTail: Promise<void> = Promise.resolve();

  public constructor(options: {
    readonly desktopAuthority: DesktopLeasePort &
      Partial<Pick<WorkerComputerUseDesktopAuthorityPort, "renew">>;
    readonly assignment?: WorkerRunAssignmentV1;
    readonly leaseAuthority?: WorkerRunLeaseAuthority;
    readonly desktopLease?: DesktopLease;
    readonly isExecutionCurrent: () => Promise<boolean>;
  }) {
    this.#desktopAuthority = options.desktopAuthority;
    this.#assignment =
      options.assignment === undefined ? undefined : structuredClone(options.assignment);
    this.#leaseAuthority = options.leaseAuthority;
    this.#desktopLease =
      options.desktopLease === undefined ? undefined : Object.freeze({ ...options.desktopLease });
    this.#isExecutionCurrent = options.isExecutionCurrent;
  }

  public snapshot(): DesktopLease {
    if (this.#desktopLease === undefined) {
      throw new ComputerUseToolPortError("STALE_AUTHORITY");
    }
    return Object.freeze({ ...this.#desktopLease });
  }

  public async verify(request: DesktopLeaseRequest): Promise<DesktopLeaseResult> {
    const verification = this.#verificationTail.then(() => this.#verifyCurrent(request));
    this.#verificationTail = verification.then(
      () => undefined,
      () => undefined,
    );
    return await verification;
  }

  async #verifyCurrent(request: DesktopLeaseRequest): Promise<DesktopLeaseResult> {
    if (
      this.#assignment === undefined ||
      this.#leaseAuthority === undefined ||
      this.#desktopLease === undefined ||
      this.#desktopAuthority.renew === undefined
    ) {
      const desktop = await this.#desktopAuthority.verify(request);
      if (desktop.status === "current" && !(await safeCurrent(this.#isExecutionCurrent))) {
        return Object.freeze({
          status: "stale" as const,
          reason: "The authoritative Main Run lease is no longer current.",
          verifiedAtMs: desktop.verifiedAtMs,
        });
      }
      return desktop;
    }
    const assignment = this.#assignment;
    const leaseAuthority = this.#leaseAuthority;
    const desktopLease = this.#desktopLease;
    if (
      request.taskId !== assignment.taskId ||
      request.deviceId !== assignment.deviceId ||
      request.runId !== assignment.runId ||
      request.lease.leaseId !== desktopLease.leaseId ||
      request.lease.fencingToken !== desktopLease.fencingToken ||
      !(await safeCurrent(this.#isExecutionCurrent))
    ) {
      return Object.freeze({
        status: "stale" as const,
        reason: "The authoritative Main Run lease is no longer current.",
        verifiedAtMs: Date.now(),
      });
    }
    const leaseExpiresAtMs = leaseAuthority.snapshot().leaseExpiresAtMs;
    const currentRequest: DesktopLeaseRequest = Object.freeze({
      taskId: request.taskId,
      deviceId: request.deviceId,
      runId: request.runId,
      lease: Object.freeze({
        ...desktopLease,
      }),
    });
    const renewal = await this.#desktopAuthority.renew(currentRequest, {
      runLeaseId: assignment.leaseId,
      runFencingToken: assignment.fencingToken,
      runLeaseExpiresAtMs: leaseExpiresAtMs,
    });
    if (renewal.disposition !== "renewed") {
      return Object.freeze({
        status: "stale" as const,
        reason: "The Device-wide desktop lease could not follow the current Run lease.",
        verifiedAtMs: Date.now(),
      });
    }
    this.#desktopLease = renewal.lease;
    return await this.#desktopAuthority.verify({
      ...currentRequest,
      lease: this.#desktopLease,
    });
  }
}

export interface ConsumedComputerUseRunCapability {
  readonly authority: ComputerUseRunAuthority;
  readonly port: ComputerUseToolPort;
  close(): Promise<void>;
}

export async function consumeComputerUseRunCapabilityFile(
  filename: string,
): Promise<ConsumedComputerUseRunCapability> {
  const client = await consumeRunCapabilityFile({
    filename,
    expectedCapability: COMPUTER_USE_CAPABILITY,
  });
  try {
    const authority = parseComputerUseAuthority(client.metadata, client.binding);
    return Object.freeze({
      authority,
      port: new BrokerComputerUseToolPort(client, authority),
      close: () => client.close(),
    });
  } catch (error) {
    await client.close();
    throw error;
  }
}

class BrokerComputerUseToolPort implements ComputerUseToolPort {
  readonly #client: RunCapabilityClient;
  readonly #authority: ComputerUseRunAuthority;

  public constructor(client: RunCapabilityClient, authority: ComputerUseRunAuthority) {
    this.#client = client;
    this.#authority = authority;
  }

  public async readiness(context: ComputerUseToolContext): Promise<ComputerUseToolReadiness> {
    return parseToolReadiness(await this.#request(context, "readiness", null));
  }

  public async observe(context: ComputerUseToolContext): Promise<ComputerUseToolObservation> {
    return parseToolObservation(await this.#request(context, "observe", null));
  }

  public async capture(context: ComputerUseToolContext): Promise<ComputerUseToolCapture> {
    const result = requireRecord(await this.#request(context, "capture", null));
    const pngBase64 = requireString(result["pngBase64"], 8 * 1024 * 1024);
    if (!BASE64_PATTERN.test(pngBase64)) {
      throw new ComputerUseToolPortError("FAILED");
    }
    return Object.freeze({
      png: Buffer.from(pngBase64, "base64"),
      width: requirePositiveInteger(result["width"]),
      height: requirePositiveInteger(result["height"]),
      capturedAtMs: requireTimestamp(result["capturedAtMs"]),
      displayFingerprint: requireString(result["displayFingerprint"]),
    });
  }

  public async click(
    context: ComputerUseToolContext,
    input: ComputerUseClickInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return parseActionReceipt(
      await this.#request(context, "click", input as unknown as RunCapabilityJsonValue),
    );
  }

  public async typeText(
    context: ComputerUseToolContext,
    input: ComputerUseTypeTextInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return parseActionReceipt(
      await this.#request(context, "type-text", input as unknown as RunCapabilityJsonValue),
    );
  }

  public async key(
    context: ComputerUseToolContext,
    input: ComputerUseKeyInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return parseActionReceipt(
      await this.#request(context, "key", input as unknown as RunCapabilityJsonValue),
    );
  }

  public async scroll(
    context: ComputerUseToolContext,
    input: ComputerUseScrollInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return parseActionReceipt(
      await this.#request(context, "scroll", input as unknown as RunCapabilityJsonValue),
    );
  }

  public async stop(
    context: ComputerUseToolContext,
    input: ComputerUseStopInput,
  ): Promise<ComputerUseToolStopReceipt> {
    const result = requireRecord(
      await this.#request(context, "stop", input as unknown as RunCapabilityJsonValue),
    );
    requireExactKeys(result, ["status"]);
    return Object.freeze({ status: requireLiteral(result["status"], "stopped") });
  }

  async #request(
    context: ComputerUseToolContext,
    method: string,
    payload: RunCapabilityJsonValue,
  ): Promise<RunCapabilityJsonValue> {
    requireExactAuthority(context, this.#authority);
    return await this.#client.request({ method, payload, signal: context.signal });
  }
}

async function dispatchComputerUseRequest(
  port: ComputerUseToolPort,
  authority: ComputerUseRunAuthority,
  method: string,
  payload: RunCapabilityJsonValue,
  signal: AbortSignal,
): Promise<RunCapabilityJsonValue> {
  const context = Object.freeze({ authority, signal });
  switch (method) {
    case "readiness":
      requireNull(payload);
      return (await port.readiness(context)) as unknown as RunCapabilityJsonValue;
    case "observe":
      requireNull(payload);
      return (await port.observe(context)) as unknown as RunCapabilityJsonValue;
    case "capture": {
      requireNull(payload);
      const capture = await port.capture(context);
      return {
        pngBase64: Buffer.from(capture.png).toString("base64"),
        width: capture.width,
        height: capture.height,
        capturedAtMs: capture.capturedAtMs,
        displayFingerprint: capture.displayFingerprint,
      };
    }
    case "click":
      return (await port.click(context, parseClick(payload))) as unknown as RunCapabilityJsonValue;
    case "type-text":
      return (await port.typeText(
        context,
        parseTypeText(payload),
      )) as unknown as RunCapabilityJsonValue;
    case "key":
      return (await port.key(context, parseKey(payload))) as unknown as RunCapabilityJsonValue;
    case "scroll":
      return (await port.scroll(
        context,
        parseScroll(payload),
      )) as unknown as RunCapabilityJsonValue;
    case "stop":
      return (await port.stop(context, parseStop(payload))) as unknown as RunCapabilityJsonValue;
    default:
      throw new ComputerUseToolPortError("UNSUPPORTED");
  }
}

function computerUseAuthority(
  assignment: WorkerRunAssignmentV1,
  lease: DesktopLease,
  desktopAuthority: WorkerComputerUseDesktopBinding,
  executionHandleId: string,
): ComputerUseRunAuthority {
  return Object.freeze({
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    runId: assignment.runId,
    deviceId: assignment.deviceId,
    executionHandleId,
    lease: Object.freeze({ ...lease }),
    desktopAuthority: Object.freeze({ ...desktopAuthority }),
  });
}

function runCapabilityBinding(
  assignment: WorkerRunAssignmentV1,
  leaseExpiresAtMs: number,
): RunCapabilityBinding {
  return Object.freeze({
    taskId: assignment.taskId,
    workOrderId: assignment.workOrder.workOrderId,
    runId: assignment.runId,
    deviceId: assignment.deviceId,
    leaseId: assignment.leaseId,
    fencingToken: assignment.fencingToken,
    leaseExpiresAtMs,
  });
}

function startCommandId(assignment: WorkerRunAssignmentV1): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        taskId: assignment.taskId,
        workOrderId: assignment.workOrder.workOrderId,
        runId: assignment.runId,
        deviceId: assignment.deviceId,
        leaseId: assignment.leaseId,
        fencingToken: assignment.fencingToken,
      }),
    )
    .digest("hex");
  return `computer-use:start:${digest}`;
}

function parseComputerUseAuthority(
  input: RunCapabilityJsonValue,
  binding: RunCapabilityBinding,
): ComputerUseRunAuthority {
  const record = requireRecord(input);
  requireExactKeys(record, [
    "taskId",
    "workOrderId",
    "runId",
    "deviceId",
    "executionHandleId",
    "lease",
    "desktopAuthority",
  ]);
  const lease = requireRecord(record["lease"]);
  requireExactKeys(lease, ["resourceName", "capacity", "leaseId", "fencingToken", "expiresAtMs"]);
  const desktop = requireRecord(record["desktopAuthority"]);
  requireExactKeys(desktop, ["helperInstanceId", "serviceEpoch", "persistenceGeneration"]);
  const authority: ComputerUseRunAuthority = Object.freeze({
    taskId: requireString(record["taskId"]),
    workOrderId: requireString(record["workOrderId"]),
    runId: requireString(record["runId"]),
    deviceId: requireString(record["deviceId"]),
    executionHandleId: requireString(record["executionHandleId"]),
    lease: Object.freeze({
      resourceName: requireLiteral(lease["resourceName"], "desktop-session"),
      capacity: requireLiteral(lease["capacity"], 1),
      leaseId: requireString(lease["leaseId"]),
      fencingToken: requirePositiveInteger(lease["fencingToken"]),
      expiresAtMs: requireTimestamp(lease["expiresAtMs"]),
    }),
    desktopAuthority: Object.freeze({
      helperInstanceId: requireString(desktop["helperInstanceId"]),
      serviceEpoch: requirePositiveInteger(desktop["serviceEpoch"]),
      persistenceGeneration: requirePositiveInteger(desktop["persistenceGeneration"]),
    }),
  });
  if (
    authority.taskId !== binding.taskId ||
    authority.workOrderId !== binding.workOrderId ||
    authority.runId !== binding.runId ||
    authority.deviceId !== binding.deviceId
  ) {
    throw new ComputerUseToolPortError("STALE_AUTHORITY");
  }
  return authority;
}

async function releaseDesktop(
  assignment: WorkerRunAssignmentV1,
  lease: DesktopLease,
  authority: WorkerComputerUseDesktopAuthorityPort,
): Promise<void> {
  await authority
    .release({
      taskId: assignment.taskId,
      deviceId: assignment.deviceId,
      runId: assignment.runId,
      lease,
    })
    .catch(() => undefined);
}

function requireExactAuthority(
  context: ComputerUseToolContext,
  authority: ComputerUseRunAuthority,
): void {
  if (context.signal.aborted) {
    throw new ComputerUseToolPortError("CANCELLED");
  }
  if (!isDeepStrictEqual(context.authority, authority)) {
    throw new ComputerUseToolPortError("STALE_AUTHORITY");
  }
}

function parseToolReadiness(value: RunCapabilityJsonValue): ComputerUseToolReadiness {
  const record = requireRecord(value);
  requireExactKeys(record, ["status", "osFamily", "backendId", "displayFingerprint", "checks"]);
  const status = record["status"];
  const osFamily = record["osFamily"];
  const checks = record["checks"];
  if (
    (status !== "ready" && status !== "unavailable") ||
    (osFamily !== "windows" && osFamily !== "macos" && osFamily !== "linux") ||
    !Array.isArray(checks) ||
    checks.length > 64
  ) {
    throw new ComputerUseToolPortError("FAILED");
  }
  const displayFingerprint =
    record["displayFingerprint"] === null ? null : requireString(record["displayFingerprint"]);
  return Object.freeze({
    status,
    osFamily,
    backendId: requireString(record["backendId"]),
    displayFingerprint,
    checks: Object.freeze(
      checks.map((value) => {
        const check = requireRecord(value);
        requireExactKeys(check, ["name", "status", "evidence"], ["remediation"]);
        const checkStatus = check["status"];
        if (checkStatus !== "pass" && checkStatus !== "fail" && checkStatus !== "unknown") {
          throw new ComputerUseToolPortError("FAILED");
        }
        return Object.freeze({
          name: requireString(check["name"]),
          status: checkStatus,
          evidence: requireString(check["evidence"], 16 * 1024),
          ...(check["remediation"] === undefined
            ? {}
            : { remediation: requireString(check["remediation"], 16 * 1024) }),
        });
      }),
    ),
  });
}

function parseToolObservation(value: RunCapabilityJsonValue): ComputerUseToolObservation {
  const record = requireRecord(value);
  requireExactKeys(record, ["displayFingerprint", "summary", "controls"]);
  const controls = record["controls"];
  if (!Array.isArray(controls) || controls.length > 4_096) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return Object.freeze({
    displayFingerprint: requireString(record["displayFingerprint"]),
    summary: requireString(record["summary"], 64 * 1024),
    controls: Object.freeze(
      controls.map((value) => {
        const control = requireRecord(value);
        requireExactKeys(control, ["controlId", "role", "label"], ["value", "selected"]);
        if (control["selected"] !== undefined && typeof control["selected"] !== "boolean") {
          throw new ComputerUseToolPortError("FAILED");
        }
        return Object.freeze({
          controlId: requireString(control["controlId"]),
          role: requireString(control["role"]),
          label: requireString(control["label"], 8 * 1024),
          ...(control["value"] === undefined
            ? {}
            : { value: requireString(control["value"], 64 * 1024) }),
          ...(control["selected"] === undefined ? {} : { selected: control["selected"] }),
        });
      }),
    ),
  });
}

function parseActionReceipt(value: RunCapabilityJsonValue): ComputerUseToolActionReceipt {
  const record = requireRecord(value);
  requireExactKeys(record, ["sequence", "executedAtMs", "displayFingerprint"]);
  return Object.freeze({
    sequence: requirePositiveInteger(record["sequence"]),
    executedAtMs: requireTimestamp(record["executedAtMs"]),
    displayFingerprint: requireString(record["displayFingerprint"]),
  });
}

function parseClick(value: RunCapabilityJsonValue): ComputerUseClickInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["controlId"]);
  return Object.freeze({ controlId: requireString(record["controlId"]) });
}

function parseTypeText(value: RunCapabilityJsonValue): ComputerUseTypeTextInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["controlId", "text"]);
  return Object.freeze({
    controlId: requireString(record["controlId"]),
    text: requireString(record["text"], 64 * 1024),
  });
}

function parseKey(value: RunCapabilityJsonValue): ComputerUseKeyInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["key"], ["modifiers"]);
  const modifiers = record["modifiers"];
  if (
    modifiers !== undefined &&
    (!Array.isArray(modifiers) ||
      modifiers.some(
        (entry) => entry !== "alt" && entry !== "control" && entry !== "meta" && entry !== "shift",
      ))
  ) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return Object.freeze({
    key: requireString(record["key"]),
    ...(modifiers === undefined
      ? {}
      : {
          modifiers: Object.freeze([...modifiers] as ("alt" | "control" | "meta" | "shift")[]),
        }),
  });
}

function parseScroll(value: RunCapabilityJsonValue): ComputerUseScrollInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["deltaX", "deltaY"]);
  return Object.freeze({
    deltaX: requireFiniteNumber(record["deltaX"]),
    deltaY: requireFiniteNumber(record["deltaY"]),
  });
}

function parseStop(value: RunCapabilityJsonValue): ComputerUseStopInput {
  const record = requireRecord(value);
  requireExactKeys(record, ["mode"]);
  if (record["mode"] !== "cancel" && record["mode"] !== "emergency-stop") {
    throw new ComputerUseToolPortError("FAILED");
  }
  return Object.freeze({ mode: record["mode"] });
}

function requireNull(value: RunCapabilityJsonValue): void {
  if (value !== null) {
    throw new ComputerUseToolPortError("FAILED");
  }
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new ComputerUseToolPortError("FAILED");
  }
}

function requireString(value: unknown, maximumBytes = MAXIMUM_IDENTIFIER_BYTES): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return value;
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return value;
}

function requireLiteral<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) {
    throw new ComputerUseToolPortError("FAILED");
  }
  return expected;
}

function validateProviderOptions(options: WorkerComputerUseRunCapabilityProviderOptions): void {
  if (
    typeof options.backendFactory !== "function" ||
    !validIdentifier(options.toolServerCommand) ||
    !validIdentifier(options.desktopBinding.helperInstanceId) ||
    !Number.isSafeInteger(options.desktopBinding.serviceEpoch) ||
    options.desktopBinding.serviceEpoch <= 0 ||
    !Number.isSafeInteger(options.desktopBinding.persistenceGeneration) ||
    options.desktopBinding.persistenceGeneration <= 0 ||
    (options.sessionTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.sessionTimeoutMs) ||
        options.sessionTimeoutMs <= 0 ||
        options.sessionTimeoutMs > 24 * 60 * 60_000))
  ) {
    throw new TypeError("The Worker Computer Use Run capability configuration is invalid.");
  }
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 4_096
  );
}

function staticRunLeaseAuthority(assignment: WorkerRunAssignmentV1): WorkerRunLeaseAuthority {
  return Object.freeze({
    snapshot: () =>
      Object.freeze({
        leaseExpiresAtMs: assignment.leaseExpiresAtMs,
        conservativeDeadlineMonotonicMs: assignment.leaseExpiresAtMs,
      }),
    isCurrent: () => true,
    renewIfDue: async () => undefined,
  });
}

async function safeCurrent(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

export const WORKER_COMPUTER_USE_CAPABILITY_MAX_FRAME_BYTES = CAPABILITY_MAX_FRAME_BYTES;
