import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { OwnerAuthError } from "@opendelegate/owner-auth";
import type { ProblemDetailsV1 } from "@opendelegate/protocol";
import { TaskServiceError } from "@opendelegate/task-service";

import { ApprovalPortError } from "./approval-port.ts";
import { AdminOperationsPortError } from "./admin-operations-port-error.ts";
import { ConfigurationAgentPortError } from "./configuration-agent-port.ts";
import { PublicHttpError } from "./http-security.ts";
import { SecureSecretIngestPortError } from "./secure-secret-ingest-port.ts";
import { TaskBudgetAdminPortError } from "./task-budget-admin-port.ts";

const PROBLEM_BASE = "https://opendelegate.dev/problems/";

interface MappedProblem {
  readonly code: string;
  readonly detail?: string;
  readonly diagnosticCode?: string;
  readonly status: number;
  readonly title: string;
}

/**
 * A redacted server-failure record. Every field is already safe to expose in the
 * owner-visible problem response, so a diagnostic sink may persist it verbatim.
 */
export interface ServerFailureDiagnostic {
  readonly code: string;
  readonly correlationId: string;
  readonly detail?: string;
  readonly diagnosticCode?: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
}

export function installProblemHandlers(input: {
  readonly app: FastifyInstance;
  readonly correlationIdFor: (request: FastifyRequest) => string;
  readonly onServerFailure?: (diagnostic: ServerFailureDiagnostic) => void;
}): void {
  input.app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    const correlationId = input.correlationIdFor(request);
    reportServerFailure(input.onServerFailure, correlationId, request, mapped);
    sendProblem(reply, correlationId, mapped);
  });

  input.app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, input.correlationIdFor(request), {
      status: 404,
      code: "ROUTE_NOT_FOUND",
      title: "Route not found",
    });
  });
}

function reportServerFailure(
  sink: ((diagnostic: ServerFailureDiagnostic) => void) | undefined,
  correlationId: string,
  request: FastifyRequest,
  mapped: MappedProblem,
): void {
  if (sink === undefined || mapped.status < 500) {
    return;
  }
  // The route template, not request.url, so path parameters and any query
  // string stay out of the diagnostic record.
  const route = request.routeOptions?.url ?? "unrouted";
  try {
    sink({
      code: mapped.code,
      correlationId,
      ...(mapped.detail === undefined ? {} : { detail: mapped.detail }),
      ...(mapped.diagnosticCode === undefined ? {} : { diagnosticCode: mapped.diagnosticCode }),
      method: request.method,
      route,
      status: mapped.status,
    });
  } catch {
    // A failing diagnostic sink must never replace the owner-facing problem
    // response with an unrelated error.
  }
}

function sendProblem(reply: FastifyReply, correlationId: string, mapped: MappedProblem): void {
  const body: ProblemDetailsV1 = {
    type: `${PROBLEM_BASE}${mapped.code.toLowerCase().replaceAll("_", "-")}`,
    title: mapped.title,
    status: mapped.status,
    code: mapped.code,
    correlationId,
    ...(mapped.detail === undefined ? {} : { detail: mapped.detail }),
    ...(mapped.diagnosticCode === undefined ? {} : { diagnosticCode: mapped.diagnosticCode }),
  };

  void reply.status(mapped.status).type("application/problem+json").send(body);
}

function mapError(error: unknown): MappedProblem {
  if (error instanceof PublicHttpError) {
    return publicProblem(error.statusCode, error.code, undefined, error.diagnosticCode);
  }

  if (error instanceof OwnerAuthError) {
    return mapOwnerAuthError(error);
  }
  if (error instanceof TaskServiceError) {
    return mapTaskServiceError(error);
  }
  if (error instanceof ConfigurationAgentPortError) {
    switch (error.code) {
      case "SECRET_MATERIAL_REQUIRES_SECURE_INGEST":
        return publicProblem(400, error.code);
      case "IDEMPOTENCY_CONFLICT":
        return publicProblem(409, error.code);
      case "CONFIGURATION_AGENT_UNAVAILABLE":
        return publicProblem(503, error.code, error.message, error.diagnosticCode);
    }
  }
  if (error instanceof SecureSecretIngestPortError) {
    switch (error.code) {
      case "SECRET_INGEST_INVALID":
        return publicProblem(400, error.code);
      case "SECRET_INGEST_IDEMPOTENCY_CONFLICT":
        return publicProblem(409, error.code);
      case "SECRET_INGEST_UNAVAILABLE":
        return publicProblem(503, error.code);
    }
  }
  if (error instanceof ApprovalPortError) {
    switch (error.code) {
      case "APPROVAL_NOT_FOUND":
        return publicProblem(404, error.code);
      case "APPROVAL_EXPIRED":
      case "APPROVAL_IDEMPOTENCY_CONFLICT":
      case "APPROVAL_DECISION_CONFLICT":
      case "APPROVAL_SCOPE_INVALID":
        return publicProblem(409, error.code);
      case "APPROVAL_EXECUTION_FAILED":
      case "APPROVAL_UNAVAILABLE":
        return publicProblem(503, error.code);
    }
  }
  if (error instanceof AdminOperationsPortError) {
    switch (error.code) {
      case "ARTIFACT_NOT_FOUND":
        return publicProblem(404, error.code);
      case "ARTIFACT_IDEMPOTENCY_CONFLICT":
      case "ARTIFACT_POLICY_UNAVAILABLE":
      case "ENROLLMENT_IDEMPOTENCY_CONFLICT":
      case "ENROLLMENT_IDEMPOTENCY_INDETERMINATE":
        return publicProblem(409, error.code);
      case "ARTIFACT_OPEN_UNAVAILABLE":
      case "AUDIT_UNAVAILABLE":
      case "ENROLLMENT_UNAVAILABLE":
        return publicProblem(503, error.code);
    }
  }
  if (error instanceof TaskBudgetAdminPortError) {
    switch (error.code) {
      case "TASK_BUDGET_NOT_FOUND":
        return publicProblem(404, error.code);
      case "TASK_BUDGET_INVALID":
        return publicProblem(400, error.code);
      case "TASK_BUDGET_IDEMPOTENCY_CONFLICT":
      case "TASK_BUDGET_LIMIT_INVALID":
      case "TASK_BUDGET_PARENT_LIMIT_EXCEEDED":
      case "TASK_BUDGET_REVISION_CONFLICT":
        return publicProblem(409, error.code);
      case "TASK_BUDGET_UNAVAILABLE":
        return publicProblem(503, error.code);
    }
  }

  const fastifyError = error as FastifyError;
  if (
    fastifyError.validation !== undefined ||
    fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  ) {
    return publicProblem(400, "INVALID_REQUEST");
  }
  if (fastifyError.statusCode === 413 || fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return publicProblem(413, "REQUEST_BODY_TOO_LARGE");
  }
  if (fastifyError.statusCode === 429) {
    return publicProblem(429, "RATE_LIMITED");
  }

  return publicProblem(500, "INTERNAL_ERROR");
}

function mapTaskServiceError(error: TaskServiceError): MappedProblem {
  switch (error.code) {
    case "CONFIGURATION_UNAVAILABLE":
      return publicProblem(503, "TASK_CONFIGURATION_UNAVAILABLE");
    case "INPUT_INVALID":
      return publicProblem(400, "INVALID_REQUEST");
    case "TASK_NOT_FOUND":
      return publicProblem(404, "TASK_NOT_FOUND");
    case "IDEMPOTENCY_CONFLICT":
      return publicProblem(409, "IDEMPOTENCY_CONFLICT");
    case "TRANSITION_INVALID":
      return publicProblem(409, "TASK_TRANSITION_INVALID");
    case "STORAGE_CONFLICT":
      return publicProblem(503, "TASK_STORAGE_UNAVAILABLE");
  }
}

function mapOwnerAuthError(error: OwnerAuthError): MappedProblem {
  switch (error.code) {
    case "AUTHENTICATION_FAILED":
      return publicProblem(401, "AUTHENTICATION_FAILED");
    case "AUTHENTICATION_REQUIRED":
    case "SESSION_INVALID":
      return publicProblem(401, "AUTHENTICATION_REQUIRED");
    case "AUTHENTICATION_STALE":
      return publicProblem(401, "AUTHENTICATION_STALE");
    case "RATE_LIMITED":
      return publicProblem(429, "RATE_LIMITED");
    case "CSRF_INVALID":
      return publicProblem(403, "CSRF_INVALID");
    case "LOCAL_ACCESS_REQUIRED":
      return publicProblem(403, "LOCAL_ACCESS_REQUIRED");
    case "CLAIM_ALREADY_ACTIVE":
      return publicProblem(409, "CLAIM_ALREADY_ACTIVE");
    case "CLAIM_INVALID":
      return publicProblem(400, "CLAIM_INVALID");
    case "PASSPHRASE_INVALID":
      return publicProblem(400, "PASSPHRASE_INVALID");
    case "RECOVERY_INVALID":
      return publicProblem(400, "RECOVERY_INVALID");
    case "AUTHENTICATION_UNAVAILABLE":
      return publicProblem(503, "AUTHENTICATION_UNAVAILABLE");
  }
}

function publicProblem(
  status: number,
  code: string,
  detail?: string,
  diagnosticCode?: string,
): MappedProblem {
  return {
    status,
    code,
    title: titleFor(code),
    ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
    ...(isPublicDiagnosticCode(diagnosticCode) ? { diagnosticCode } : {}),
  };
}

function isPublicDiagnosticCode(value: string | undefined): value is string {
  return value !== undefined && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value);
}

function titleFor(code: string): string {
  const titles: Readonly<Record<string, string>> = {
    AUTHENTICATION_FAILED: "Authentication failed",
    AUTHENTICATION_REQUIRED: "Authentication required",
    AUTHENTICATION_STALE: "Fresh authentication required",
    AUTHENTICATION_UNAVAILABLE: "Authentication unavailable",
    APPROVAL_DECISION_CONFLICT: "Approval decision conflict",
    APPROVAL_EXECUTION_FAILED: "Approved action failed",
    APPROVAL_EXPIRED: "Approval expired",
    APPROVAL_IDEMPOTENCY_CONFLICT: "Approval idempotency conflict",
    APPROVAL_NOT_FOUND: "Approval not found",
    APPROVAL_SCOPE_INVALID: "Approval scope invalid",
    APPROVAL_UNAVAILABLE: "Approval service unavailable",
    ARTIFACT_IDEMPOTENCY_CONFLICT: "Artifact idempotency conflict",
    ARTIFACT_NOT_FOUND: "Artifact not found",
    ARTIFACT_OPEN_UNAVAILABLE: "Artifact access unavailable",
    ARTIFACT_POLICY_UNAVAILABLE: "Artifact policy unavailable",
    AUDIT_UNAVAILABLE: "Audit unavailable",
    CLAIM_ALREADY_ACTIVE: "Owner claim already active",
    CLAIM_INVALID: "Owner claim invalid",
    CONFIGURATION_AGENT_UNAVAILABLE: "Configuration Agent unavailable",
    CORRELATION_ID_INVALID: "Correlation ID invalid",
    CSRF_INVALID: "Request origin validation failed",
    HOST_NOT_ALLOWED: "Host not allowed",
    IDEMPOTENCY_CONFLICT: "Idempotency conflict",
    IDEMPOTENCY_KEY_INVALID: "Idempotency key invalid",
    ENROLLMENT_IDEMPOTENCY_CONFLICT: "Enrollment idempotency conflict",
    ENROLLMENT_IDEMPOTENCY_INDETERMINATE: "Enrollment outcome indeterminate",
    ENROLLMENT_UNAVAILABLE: "Device enrollment unavailable",
    INTERNAL_ERROR: "Internal server error",
    INVALID_REQUEST: "Invalid request",
    LOCAL_ACCESS_REQUIRED: "Local access required",
    PASSPHRASE_INVALID: "Passphrase invalid",
    RATE_LIMITED: "Too many requests",
    RECOVERY_INVALID: "Recovery credential invalid",
    REQUEST_BODY_TOO_LARGE: "Request body too large",
    ROUTE_NOT_FOUND: "Route not found",
    SECRET_MATERIAL_REQUIRES_SECURE_INGEST: "Use secure Secret ingest",
    SECRET_INGEST_IDEMPOTENCY_CONFLICT: "Secret ingest idempotency conflict",
    SECRET_INGEST_INVALID: "Secret material is invalid",
    SECRET_INGEST_UNAVAILABLE: "Secure Secret ingest unavailable",
    TASK_NOT_FOUND: "Task not found",
    TASK_CONFIGURATION_UNAVAILABLE: "Task configuration unavailable",
    TASK_BUDGET_IDEMPOTENCY_CONFLICT: "Task Budget idempotency conflict",
    TASK_BUDGET_INVALID: "Task Budget request invalid",
    TASK_BUDGET_LIMIT_INVALID: "Task Budget limit invalid",
    TASK_BUDGET_NOT_FOUND: "Task Budget not found",
    TASK_BUDGET_PARENT_LIMIT_EXCEEDED: "Instance Budget ceiling exceeded",
    TASK_BUDGET_REVISION_CONFLICT: "Task Budget revision conflict",
    TASK_BUDGET_UNAVAILABLE: "Task Budget unavailable",
    TASK_EXECUTION_UNAVAILABLE: "Task execution unavailable",
    TASK_STORAGE_UNAVAILABLE: "Task storage unavailable",
    TASK_TRANSITION_INVALID: "Task transition invalid",
  };
  return titles[code] ?? "Request failed";
}
