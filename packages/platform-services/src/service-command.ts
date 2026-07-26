import { createHash } from "node:crypto";

import type { ServicePlan } from "./plans.ts";
import type { ServicePlanExecutionReport } from "./plan-executor.ts";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type ServiceCommandExecutionErrorCode =
  | "SERVICE_COMMAND_CONFLICT"
  | "SERVICE_COMMAND_IN_PROGRESS"
  | "SERVICE_COMMAND_INVALID"
  | "SERVICE_COMMAND_JOURNAL_CORRUPT"
  | "SERVICE_COMMAND_JOURNAL_UNAVAILABLE"
  | "SERVICE_COMMAND_PREFLIGHT_FAILED"
  | "SERVICE_COMMAND_OUTCOME_UNCERTAIN";

export class ServiceCommandExecutionError extends Error {
  public readonly code: ServiceCommandExecutionErrorCode;
  public readonly mutationMayHaveOccurred: boolean;

  public constructor(
    code: ServiceCommandExecutionErrorCode,
    message: string,
    mutationMayHaveOccurred: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServiceCommandExecutionError";
    this.code = code;
    this.mutationMayHaveOccurred = mutationMayHaveOccurred;
  }
}

export interface ServiceCommandJournalEntry {
  readonly commandId: string;
  readonly planFingerprint: string;
  readonly operation: ServicePlan["operation"];
  readonly platform: ServicePlan["platform"];
  readonly instanceId: string;
  readonly report?: ServicePlanExecutionReport;
}

export type ServiceCommandClaim =
  | {
      readonly disposition: "claimed";
    }
  | {
      readonly disposition: "in-progress";
      readonly planFingerprint: string;
    }
  | {
      readonly disposition: "completed";
      readonly planFingerprint: string;
      readonly report: ServicePlanExecutionReport;
    };

export interface ServiceCommandJournal {
  /**
   * Atomically claims a command ID or returns the durable state already associated with it.
   * Implementations must never replace an entry with a different plan fingerprint.
   */
  claim(entry: ServiceCommandJournalEntry): Promise<ServiceCommandClaim>;

  /**
   * Atomically records the terminal report for the exact claimed command and fingerprint.
   */
  complete(
    entry: ServiceCommandJournalEntry & {
      readonly report: ServicePlanExecutionReport;
    },
  ): Promise<void>;
}

export interface ServicePlanRunContext {
  readonly commandId: string;
  readonly planFingerprint: string;
}

export interface ServicePlanRunner {
  execute(plan: ServicePlan, context: ServicePlanRunContext): Promise<ServicePlanExecutionReport>;
}

export interface ExecuteIdempotentServicePlanInput {
  readonly commandId: string;
  readonly plan: ServicePlan;
  readonly journal: ServiceCommandJournal;
  readonly runner: ServicePlanRunner;
}

export interface IdempotentServicePlanResult {
  readonly replayed: boolean;
  readonly report: ServicePlanExecutionReport;
}

export async function executeIdempotentServicePlan(
  input: ExecuteIdempotentServicePlanInput,
): Promise<IdempotentServicePlanResult> {
  validateCommandId(input.commandId);
  const planFingerprint = servicePlanFingerprint(input.plan);
  const entry: ServiceCommandJournalEntry = {
    commandId: input.commandId,
    planFingerprint,
    operation: input.plan.operation,
    platform: input.plan.platform,
    instanceId: input.plan.instanceId,
  };

  let claim: ServiceCommandClaim;
  try {
    claim = await input.journal.claim(entry);
  } catch (error) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_JOURNAL_UNAVAILABLE",
      "The durable service-operation journal could not claim the command. No service mutation was started.",
      false,
      { cause: error },
    );
  }
  if (claim.disposition !== "claimed" && claim.planFingerprint !== planFingerprint) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_CONFLICT",
      "The service command ID is already bound to different lifecycle intent.",
      false,
    );
  }
  if (claim.disposition === "in-progress") {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_IN_PROGRESS",
      "The exact service command is already in progress or has an uncertain interrupted outcome. Inspect and recover it before retrying.",
      true,
    );
  }
  if (claim.disposition === "completed") {
    try {
      validateExecutionReport(input.plan, claim.report, "SERVICE_COMMAND_JOURNAL_CORRUPT");
    } catch (error) {
      if (error instanceof ServiceCommandExecutionError) {
        throw error;
      }
      throw new ServiceCommandExecutionError(
        "SERVICE_COMMAND_JOURNAL_CORRUPT",
        "The durable service-operation journal returned a malformed terminal report.",
        false,
        { cause: error },
      );
    }
    return {
      replayed: true,
      report: claim.report,
    };
  }

  let report: ServicePlanExecutionReport;
  try {
    report = await input.runner.execute(input.plan, {
      commandId: input.commandId,
      planFingerprint,
    });
    validateExecutionReport(input.plan, report, "SERVICE_COMMAND_OUTCOME_UNCERTAIN");
  } catch (error) {
    if (
      error instanceof ServiceCommandExecutionError &&
      error.code === "SERVICE_COMMAND_OUTCOME_UNCERTAIN"
    ) {
      throw error;
    }
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_OUTCOME_UNCERTAIN",
      "The service executor did not return a valid terminal report. Some mutations may have occurred; inspect the host before recovery.",
      true,
      { cause: error },
    );
  }

  try {
    await input.journal.complete({
      ...entry,
      report,
    });
  } catch (error) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_OUTCOME_UNCERTAIN",
      "The service operation finished but its terminal report could not be committed. Do not issue a new command ID until the host is inspected.",
      true,
      { cause: error },
    );
  }
  return {
    replayed: false,
    report,
  };
}

export function servicePlanFingerprint(plan: ServicePlan): string {
  return fingerprintServiceValue(plan);
}

export function fingerprintServiceValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function validateCommandId(commandId: string): void {
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_INVALID",
      "Service command IDs must be 8 to 128 service-safe characters.",
      false,
    );
  }
}

function validateExecutionReport(
  plan: ServicePlan,
  report: ServicePlanExecutionReport,
  errorCode: "SERVICE_COMMAND_JOURNAL_CORRUPT" | "SERVICE_COMMAND_OUTCOME_UNCERTAIN",
): void {
  const stepIds = new Set(plan.steps.map((step) => step.id));
  const completedIds = new Set(report.completedStepIds);
  const unchangedIds = new Set(report.unchangedStepIds);
  const expectedEvent =
    report.outcome === "succeeded"
      ? "platform.service.operation.succeeded"
      : report.outcome === "rolled-back"
        ? "platform.service.operation.rolled_back"
        : "platform.service.operation.failed";
  const valid =
    report.operation === plan.operation &&
    report.platform === plan.platform &&
    report.instanceId === plan.instanceId &&
    completedIds.size === report.completedStepIds.length &&
    unchangedIds.size === report.unchangedStepIds.length &&
    report.completedStepIds.every((stepId) => stepIds.has(stepId)) &&
    report.unchangedStepIds.every((stepId) => completedIds.has(stepId)) &&
    report.rollback.completedStepIds.every((stepId) => stepIds.has(stepId)) &&
    report.rollback.failures.every((failure) => stepIds.has(failure.stepId)) &&
    report.diagnostic.eventName === expectedEvent &&
    (report.outcome === "succeeded"
      ? report.failedStepId === undefined &&
        report.completedStepIds.length === plan.steps.length &&
        report.rollback.attempted === false
      : report.failedStepId !== undefined &&
        stepIds.has(report.failedStepId) &&
        !completedIds.has(report.failedStepId));
  if (!valid) {
    throw new ServiceCommandExecutionError(
      errorCode,
      errorCode === "SERVICE_COMMAND_JOURNAL_CORRUPT"
        ? "The durable service-operation journal returned a report that does not match the claimed plan."
        : "The service executor returned a terminal report that does not match the claimed plan.",
      errorCode === "SERVICE_COMMAND_OUTCOME_UNCERTAIN",
    );
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
