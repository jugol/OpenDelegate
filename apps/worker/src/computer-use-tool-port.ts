import { isDeepStrictEqual } from "node:util";

import {
  ComputerUseOsError,
  type ComputerUseReadinessReport,
  type ComputerUseSession,
  type DesktopLeasePort,
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
  type ComputerUseToolStopReceipt,
  type ComputerUseTypeTextInput,
} from "@opendelegate/computer-use-mcp";

export interface WorkerComputerUseToolPortOptions {
  readonly authority: ComputerUseRunAuthority;
  readonly session: ComputerUseSession;
  readonly readiness: () => Promise<ComputerUseReadinessReport>;
  readonly isExecutionCurrent: () => Promise<boolean>;
  readonly leases: DesktopLeasePort;
}

/**
 * Exact Run-scoped execution broker used behind the Computer Use MCP process.
 *
 * The MCP server owns schemas and stdio only. This port owns the Worker authority
 * check and delegates mutations to `ComputerUseSession`, which re-runs Policy,
 * approval matching, helper epoch, display identity, and desktop fencing at the
 * native boundary.
 */
export class WorkerComputerUseToolPort implements ComputerUseToolPort {
  readonly #authority: ComputerUseRunAuthority;
  readonly #session: ComputerUseSession;
  readonly #readiness: () => Promise<ComputerUseReadinessReport>;
  readonly #isExecutionCurrent: () => Promise<boolean>;
  readonly #leases: DesktopLeasePort;

  public constructor(options: WorkerComputerUseToolPortOptions) {
    if (
      options.session.executionHandleId !== options.authority.executionHandleId ||
      typeof options.readiness !== "function" ||
      typeof options.isExecutionCurrent !== "function" ||
      typeof options.leases?.verify !== "function"
    ) {
      throw new TypeError("The Worker Computer Use tool authority binding is invalid.");
    }
    this.#authority = structuredClone(options.authority);
    this.#session = options.session;
    this.#readiness = options.readiness;
    this.#isExecutionCurrent = options.isExecutionCurrent;
    this.#leases = options.leases;
  }

  public async readiness(context: ComputerUseToolContext): Promise<ComputerUseToolReadiness> {
    return this.#execute(context, async () => {
      const report = await this.#readiness();
      return Object.freeze({
        status: report.status,
        osFamily: report.osFamily,
        backendId: report.backendId,
        displayFingerprint: report.displayFingerprint,
        checks: Object.freeze(
          report.checks.map((check) =>
            Object.freeze({
              name: check.name,
              status: check.status,
              evidence: check.evidence,
              ...(check.remediation === undefined ? {} : { remediation: check.remediation }),
            }),
          ),
        ),
      });
    });
  }

  public async observe(context: ComputerUseToolContext): Promise<ComputerUseToolObservation> {
    return this.#execute(context, async () => {
      const observation = await this.#session.observe();
      return Object.freeze({
        displayFingerprint: observation.displayFingerprint,
        summary: `${String(observation.accessibilityTree.length)} accessible controls are available on the current display.`,
        controls: Object.freeze(
          observation.accessibilityTree.map((control) =>
            Object.freeze({
              controlId: control.controlId,
              role: control.role,
              label: control.label,
              ...(control.value === undefined ? {} : { value: control.value }),
              ...(control.selected === undefined ? {} : { selected: control.selected }),
            }),
          ),
        ),
      });
    });
  }

  public async capture(context: ComputerUseToolContext): Promise<ComputerUseToolCapture> {
    return this.#execute(context, async () => {
      const evidence = await this.#session.capture();
      return Object.freeze({
        png: evidence.bytes.slice(),
        width: evidence.width,
        height: evidence.height,
        capturedAtMs: evidence.capturedAtMs,
        displayFingerprint: evidence.displayFingerprint,
      });
    });
  }

  public async click(
    context: ComputerUseToolContext,
    input: ComputerUseClickInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return this.#execute(context, async () => {
      const observation = await this.#session.observe();
      await this.#session.click(input);
      return this.#latestActionReceipt("click", input.controlId, observation.displayFingerprint);
    });
  }

  public async typeText(
    context: ComputerUseToolContext,
    input: ComputerUseTypeTextInput,
  ): Promise<ComputerUseToolActionReceipt> {
    return this.#execute(context, async () => {
      const observation = await this.#session.observe();
      await this.#session.typeText(input);
      return this.#latestActionReceipt(
        "type-text",
        input.controlId,
        observation.displayFingerprint,
      );
    });
  }

  public async key(
    context: ComputerUseToolContext,
    _input: ComputerUseKeyInput,
  ): Promise<ComputerUseToolActionReceipt> {
    await this.#requireCurrent(context);
    throw new ComputerUseToolPortError("UNSUPPORTED");
  }

  public async scroll(
    context: ComputerUseToolContext,
    _input: ComputerUseScrollInput,
  ): Promise<ComputerUseToolActionReceipt> {
    await this.#requireCurrent(context);
    throw new ComputerUseToolPortError("UNSUPPORTED");
  }

  public async stop(
    context: ComputerUseToolContext,
    input: ComputerUseStopInput,
  ): Promise<ComputerUseToolStopReceipt> {
    await this.#requireCurrent(context);
    try {
      if (input.mode === "emergency-stop") {
        await this.#session.emergencyStop();
      } else {
        await this.#session.cancel();
      }
      return Object.freeze({ status: "stopped" as const });
    } catch (error: unknown) {
      throw normalizeToolError(error);
    }
  }

  async #execute<T>(context: ComputerUseToolContext, operation: () => Promise<T>): Promise<T> {
    await this.#requireCurrent(context);
    try {
      const result = await operation();
      await this.#requireCurrent(context);
      return result;
    } catch (error: unknown) {
      throw normalizeToolError(error);
    }
  }

  async #requireCurrent(context: ComputerUseToolContext): Promise<void> {
    if (context.signal.aborted) {
      throw new ComputerUseToolPortError("CANCELLED");
    }
    if (!isDeepStrictEqual(context.authority, this.#authority)) {
      throw new ComputerUseToolPortError("STALE_AUTHORITY");
    }
    const current = await this.#isExecutionCurrent().catch(() => false);
    if (!current) {
      throw new ComputerUseToolPortError("STALE_AUTHORITY");
    }
    let lease;
    try {
      lease = await this.#leases.verify({
        taskId: this.#authority.taskId,
        deviceId: this.#authority.deviceId,
        runId: this.#authority.runId,
        lease: this.#authority.lease,
      });
    } catch {
      throw new ComputerUseToolPortError("STALE_LEASE");
    }
    if (
      lease.status !== "current" ||
      lease.leaseId !== this.#authority.lease.leaseId ||
      lease.fencingToken !== this.#authority.lease.fencingToken
    ) {
      throw new ComputerUseToolPortError("STALE_LEASE");
    }
    if (this.#session.status() !== "active") {
      throw new ComputerUseToolPortError("CANCELLED");
    }
  }

  #latestActionReceipt(
    kind: "click" | "type-text",
    controlId: string,
    displayFingerprint: string,
  ): ComputerUseToolActionReceipt {
    const entry = this.#session.actionSummary().entries.at(-1);
    if (
      entry === undefined ||
      entry.kind !== kind ||
      entry.controlId !== controlId ||
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence <= 0 ||
      !Number.isSafeInteger(entry.executedAtMs) ||
      entry.executedAtMs < 0
    ) {
      throw new ComputerUseToolPortError("FAILED");
    }
    return Object.freeze({
      sequence: entry.sequence,
      executedAtMs: entry.executedAtMs,
      displayFingerprint,
    });
  }
}

function normalizeToolError(error: unknown): ComputerUseToolPortError {
  if (error instanceof ComputerUseToolPortError) {
    return error;
  }
  if (!(error instanceof ComputerUseOsError)) {
    return new ComputerUseToolPortError("FAILED");
  }
  switch (error.code) {
    case "LEASE_STALE":
      return new ComputerUseToolPortError("STALE_LEASE");
    case "EPOCH_STALE":
    case "START_COMMAND_CONFLICT":
    case "START_HISTORY_UNRECOVERABLE":
      return new ComputerUseToolPortError("STALE_AUTHORITY");
    case "SESSION_TIMEOUT":
      return new ComputerUseToolPortError("TIMEOUT");
    case "AUTHORIZATION_DENIED":
    case "AUTHORIZATION_INVALID":
    case "AUTHORIZATION_REQUIRED":
    case "PERMISSION_DENIED":
      return new ComputerUseToolPortError("PERMISSION_DENIED");
    case "SESSION_CANCELLED":
    case "SESSION_EMERGENCY_STOPPED":
    case "SESSION_RELEASED":
      return new ComputerUseToolPortError("CANCELLED");
    case "HELPER_CRASHED":
    case "NOT_READY":
    case "SESSION_LOCKED":
      return new ComputerUseToolPortError("NOT_READY");
    default:
      return new ComputerUseToolPortError("FAILED");
  }
}
