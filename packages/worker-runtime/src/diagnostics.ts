import type { RedactedDiagnostic } from "@opendelegate/transport";

const SAFE_CODES = new Set([
  "AGENT_REQUIREMENT_UNAVAILABLE",
  "ARTIFACT_EGRESS_DENIED",
  "ARTIFACT_PROMOTION_FAILED",
  "LEASE_EXPIRED",
  "PROCESS_CANCELLED",
  "PROCESS_FAILED",
  "PROCESS_START_FAILED",
  "RUN_AUTHORITY_LOST",
  "WORKSPACE_RESOLUTION_FAILED",
  "WORKER_RESTARTED",
]);

export function sanitizeWorkerDiagnostic(input: unknown): RedactedDiagnostic {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return Object.freeze({ code: "WORKER_BOUNDARY_ERROR" });
  }
  const record = input as Record<string, unknown>;
  const output: Record<string, RedactedDiagnostic> = {};
  const code = readOwnValue(record, "code");
  if (typeof code === "string" && SAFE_CODES.has(code)) {
    output["code"] = code;
  } else {
    output["code"] = "WORKER_BOUNDARY_ERROR";
  }
  const retryable = readOwnValue(record, "retryable");
  if (typeof retryable === "boolean") {
    output["retryable"] = retryable;
  }
  const stage = readOwnValue(record, "stage");
  if (
    stage === "artifact" ||
    stage === "cancellation" ||
    stage === "execution" ||
    stage === "lease" ||
    stage === "startup"
  ) {
    output["stage"] = stage;
  }
  return Object.freeze(output);
}

function readOwnValue(record: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return undefined;
  }
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}
