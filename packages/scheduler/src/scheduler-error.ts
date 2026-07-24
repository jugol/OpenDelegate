import type { CandidateExplanation } from "./contracts.ts";

export type SchedulerErrorCode = "SCHEDULER_INPUT_INVALID" | "SCHEDULER_NO_ELIGIBLE_DEVICE";

export class SchedulerError extends Error {
  public readonly code: SchedulerErrorCode;
  public readonly workOrderId: string;
  public readonly explanations: readonly CandidateExplanation[];

  public constructor(
    workOrderId: string,
    explanations: readonly CandidateExplanation[],
    code: SchedulerErrorCode = "SCHEDULER_NO_ELIGIBLE_DEVICE",
  ) {
    super(
      code === "SCHEDULER_INPUT_INVALID"
        ? `Scheduling input for Work Order ${workOrderId} is invalid.`
        : `No eligible Device can run Work Order ${workOrderId}.`,
    );
    this.name = "SchedulerError";
    this.code = code;
    this.workOrderId = workOrderId;
    this.explanations = explanations;
  }
}
