import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { OwnerAuthError } from "@opendelegate/owner-auth";
import type { ProblemDetailsV1 } from "@opendelegate/protocol";
import { TaskServiceError } from "@opendelegate/task-service";

import { PublicHttpError } from "./http-security.ts";

const PROBLEM_BASE = "https://opendelegate.dev/problems/";

interface MappedProblem {
  readonly code: string;
  readonly status: number;
  readonly title: string;
}

export function installProblemHandlers(input: {
  readonly app: FastifyInstance;
  readonly correlationIdFor: (request: FastifyRequest) => string;
}): void {
  input.app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    sendProblem(reply, input.correlationIdFor(request), mapped);
  });

  input.app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, input.correlationIdFor(request), {
      status: 404,
      code: "ROUTE_NOT_FOUND",
      title: "Route not found",
    });
  });
}

function sendProblem(reply: FastifyReply, correlationId: string, mapped: MappedProblem): void {
  const body: ProblemDetailsV1 = {
    type: `${PROBLEM_BASE}${mapped.code.toLowerCase().replaceAll("_", "-")}`,
    title: mapped.title,
    status: mapped.status,
    code: mapped.code,
    correlationId,
  };

  void reply.status(mapped.status).type("application/problem+json").send(body);
}

function mapError(error: unknown): MappedProblem {
  if (error instanceof PublicHttpError) {
    return publicProblem(error.statusCode, error.code);
  }

  if (error instanceof OwnerAuthError) {
    return mapOwnerAuthError(error);
  }
  if (error instanceof TaskServiceError) {
    return mapTaskServiceError(error);
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

function publicProblem(status: number, code: string): MappedProblem {
  return {
    status,
    code,
    title: titleFor(code),
  };
}

function titleFor(code: string): string {
  const titles: Readonly<Record<string, string>> = {
    AUTHENTICATION_FAILED: "Authentication failed",
    AUTHENTICATION_REQUIRED: "Authentication required",
    AUTHENTICATION_STALE: "Fresh authentication required",
    AUTHENTICATION_UNAVAILABLE: "Authentication unavailable",
    CLAIM_ALREADY_ACTIVE: "Owner claim already active",
    CLAIM_INVALID: "Owner claim invalid",
    CORRELATION_ID_INVALID: "Correlation ID invalid",
    CSRF_INVALID: "Request origin validation failed",
    HOST_NOT_ALLOWED: "Host not allowed",
    IDEMPOTENCY_CONFLICT: "Idempotency conflict",
    IDEMPOTENCY_KEY_INVALID: "Idempotency key invalid",
    INTERNAL_ERROR: "Internal server error",
    INVALID_REQUEST: "Invalid request",
    LOCAL_ACCESS_REQUIRED: "Local access required",
    PASSPHRASE_INVALID: "Passphrase invalid",
    RATE_LIMITED: "Too many requests",
    RECOVERY_INVALID: "Recovery credential invalid",
    REQUEST_BODY_TOO_LARGE: "Request body too large",
    ROUTE_NOT_FOUND: "Route not found",
    TASK_NOT_FOUND: "Task not found",
    TASK_EXECUTION_UNAVAILABLE: "Task execution unavailable",
    TASK_STORAGE_UNAVAILABLE: "Task storage unavailable",
    TASK_TRANSITION_INVALID: "Task transition invalid",
  };
  return titles[code] ?? "Request failed";
}
