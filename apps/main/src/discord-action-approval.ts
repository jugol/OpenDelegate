import { DiscordTaskPortError } from "@opendelegate/discord-adapter";
import {
  ApprovalServiceError,
  type ApprovalRequest,
  type ApprovalService,
} from "@opendelegate/policy";

import type { DiscordTaskApprovalProjectionPort } from "./discord-runtime.ts";

export interface DiscordActionApprovalOptions {
  readonly approvals: ApprovalService;
  readonly isCurrent?: (approval: ApprovalRequest) => boolean | Promise<boolean>;
  readonly listDevices: () => Promise<
    readonly { readonly deviceId: string; readonly name: string }[]
  >;
  readonly onChanged?: (taskId: string) => void | Promise<void>;
}

/**
 * Projects only owner-safe Worker action Approvals into the bound Discord Task.
 * Configuration and other Approval kinds remain on their dedicated surfaces.
 */
export class DiscordActionApproval implements DiscordTaskApprovalProjectionPort {
  readonly #approvals: ApprovalService;
  readonly #isCurrent: DiscordActionApprovalOptions["isCurrent"];
  readonly #listDevices: DiscordActionApprovalOptions["listDevices"];
  readonly #onChanged: DiscordActionApprovalOptions["onChanged"];

  public constructor(options: DiscordActionApprovalOptions) {
    if (
      options.approvals === null ||
      typeof options.approvals !== "object" ||
      typeof options.approvals.list !== "function" ||
      typeof options.approvals.get !== "function" ||
      typeof options.approvals.decide !== "function" ||
      (options.isCurrent !== undefined && typeof options.isCurrent !== "function") ||
      typeof options.listDevices !== "function" ||
      (options.onChanged !== undefined && typeof options.onChanged !== "function")
    ) {
      throw new TypeError("Discord action Approval projection requires valid ports.");
    }
    this.#approvals = options.approvals;
    this.#isCurrent = options.isCurrent;
    this.#listDevices = options.listDevices;
    this.#onChanged = options.onChanged;
  }

  public async current(taskId: string) {
    const taskApprovals = (await this.#approvals.list())
      .filter((approval) => isTaskActionApproval(approval, taskId))
      .sort(
        (left, right) =>
          left.requestedAtMs - right.requestedAtMs ||
          left.approvalId.localeCompare(right.approvalId, "en-US"),
      );
    const approvals: ApprovalRequest[] = [];
    for (const candidate of taskApprovals) {
      if (candidate.state !== "pending") {
        continue;
      }
      if (this.#isCurrent !== undefined) {
        const current = await this.#isCurrent(candidate).catch(() => false);
        if (!current) {
          continue;
        }
      }
      approvals.push(candidate);
    }
    const approval = approvals[0];
    if (approval === undefined) {
      return undefined;
    }
    const devices = await this.#listDevices().catch(() => []);
    const deviceLabel =
      devices.find((device) => device.deviceId === approval.targetDeviceId)?.name ??
      "A Worker Device";
    const remaining = approvals.length - 1;
    return Object.freeze({
      approvalId: approval.approvalId,
      description: `${deviceLabel} wants to ${actionDescription(approval)}. Risk: ${approval.presentation.risk}. Evidence: a current Worker Run requested this exact protected action.${
        remaining === 0 ? "" : ` ${remaining.toString()} more approval(s) are waiting.`
      }`,
      sequence:
        taskApprovals.findIndex((candidate) => candidate.approvalId === approval.approvalId) + 1,
      remaining,
      deviceLabel,
      actionCategory: approval.actionCategory,
      risk: approval.presentation.risk,
    });
  }

  public async resolve(input: {
    readonly taskId: string;
    readonly approvalId: string;
    readonly principalId: string;
    readonly idempotencyKey: string;
    readonly decision: "approve" | "reject";
  }): Promise<boolean> {
    let approval: ApprovalRequest;
    try {
      approval = await this.#approvals.get(input.approvalId);
    } catch (error) {
      if (error instanceof ApprovalServiceError && error.code === "APPROVAL_NOT_FOUND") {
        return false;
      }
      throw error;
    }
    if (!isTaskActionApproval(approval, input.taskId)) {
      return false;
    }
    if (this.#isCurrent !== undefined) {
      const current = await this.#isCurrent(approval).catch(() => false);
      if (!current) {
        throw new DiscordTaskPortError(
          "APPROVAL_UNAVAILABLE",
          "This approval belongs to a Worker Run that is no longer current. The Task status will refresh.",
        );
      }
    }
    try {
      await this.#approvals.decide({
        approvalId: input.approvalId,
        idempotencyKey: input.idempotencyKey,
        decidedBy: input.principalId,
        decision:
          input.decision === "approve"
            ? { kind: "approve", scope: "once" }
            : { kind: "deny", reason: "Rejected from the Discord Task." },
      });
    } catch (error) {
      if (
        error instanceof ApprovalServiceError &&
        ["APPROVAL_DECISION_CONFLICT", "APPROVAL_EXPIRED", "APPROVAL_EXECUTION_FAILED"].includes(
          error.code,
        )
      ) {
        throw new DiscordTaskPortError(
          "APPROVAL_UNAVAILABLE",
          "This approval is no longer available. The Task status will refresh.",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await this.#onChanged?.(input.taskId);
    } catch {
      // The durable decision succeeded; periodic Discord reconciliation repairs presentation.
    }
    return true;
  }
}

function isTaskActionApproval(approval: ApprovalRequest, taskId: string): boolean {
  return approval.taskId === taskId && approval.execution.kind === "worker-action.authorize";
}

function actionDescription(approval: ApprovalRequest): string {
  switch (approval.actionCategory) {
    case "project-dependency-install":
    case "configured-official-package-install":
      return "install a package required by this Task";
    case "computer-use-input":
      return "control its desktop for this Task";
    case "sandbox-boundary-escalation":
      return "temporarily expand its sandbox for this Task";
    case "package-repository-addition":
      return "add a package repository";
    case "remote-installer-script":
    case "untrusted-installer":
      return "run an installer that requires your review";
    case "driver-installation":
    case "kernel-extension-installation":
      return "install system-level software";
    case "os-network-change":
    case "vpn-change":
    case "firewall-change":
      return "change Device networking";
    case "policy-relaxation":
      return "relax an execution policy";
    case "secret-export":
      return "export protected Secret material";
    case "cross-device-knowledge-transfer":
      return "transfer Device-local Knowledge";
    case "opendelegate-process-retry":
      return "retry an OpenDelegate process";
    case "opendelegate-process-restart":
      return "restart an OpenDelegate process";
    case "read-only-observation":
      return "perform a protected observation";
    case "policy-bypass-attempt":
      return "perform an action blocked by policy";
    default:
      return "perform a protected action";
  }
}
