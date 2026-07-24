import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";

import {
  OwnerAuthError,
  type BrowserSession,
  type BrowserSessionSummary,
  type OwnerAuth,
  type OwnerLogin,
} from "@opendelegate/owner-auth";
import {
  LiveHealthSchema,
  OwnerClaimRequestSchema,
  OwnerClaimResponseSchema,
  OwnerLoginRequestSchema,
  OwnerSessionListResponseSchema,
  OwnerSessionResponseSchema,
  ProblemDetailsSchema,
  ReadinessSchema,
  RecoveryBeginRequestSchema,
  RecoveryBeginResponseSchema,
  RecoveryCompleteRequestSchema,
  RecoveryCompleteResponseSchema,
  RevokeSessionParamsSchema,
  RuntimeFeaturesResponseSchema,
  CreateTaskRequestSchema,
  DeviceListResponseSchema,
  TaskCommandRequestSchema,
  TaskDetailSchema,
  TaskListResponseSchema,
  TaskParamsSchema,
  type DeviceSummaryV1,
  type ReadinessV1,
  type RuntimeFeaturesResponseV1,
} from "@opendelegate/protocol";
import type { TaskService } from "@opendelegate/task-service";

import { createIngressSecurity, isLoopbackAddress, PublicHttpError } from "./http-security.ts";
import { installProblemHandlers } from "./problem-details.ts";
import { AcknowledgementSchema, EmptyObjectSchema } from "./schemas.ts";

export const OWNER_SESSION_COOKIE_NAME = "__Host-opendelegate_session";

const BODY_LIMIT_BYTES = 256 * 1024;
const AUTH_RATE_LIMIT = Object.freeze({
  max: 60,
  timeWindow: "1 minute",
});
const RECOVERY_COMPLETE_RATE_LIMIT = Object.freeze({
  max: 5,
  timeWindow: "1 minute",
});
const ERROR_RESPONSES = Object.freeze({
  400: ProblemDetailsSchema,
  401: ProblemDetailsSchema,
  403: ProblemDetailsSchema,
  404: ProblemDetailsSchema,
  409: ProblemDetailsSchema,
  413: ProblemDetailsSchema,
  421: ProblemDetailsSchema,
  429: ProblemDetailsSchema,
  500: ProblemDetailsSchema,
  503: ProblemDetailsSchema,
});

type ControlPlaneApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

interface SharedAppOptions {
  readonly allowedOrigins: readonly string[];
  readonly ownerAuth: OwnerAuth;
}

export interface MainControlPlaneAppOptions extends SharedAppOptions {
  readonly build: {
    readonly version: string;
    readonly buildId: string;
  };
  readonly devices?: readonly DeviceSummaryV1[];
  readonly runtimeFeatures?: RuntimeFeaturesResponseV1;
  readonly readiness?: () => ReadinessV1 | Promise<ReadinessV1>;
  readonly tasks?: Pick<TaskService, "command" | "create" | "get" | "list">;
  readonly tls?: {
    readonly certificate: Buffer;
    readonly privateKey: Buffer;
  };
}

export interface LocalClaimAppOptions extends SharedAppOptions {
  readonly onClaimed?: () => void | Promise<void>;
}

export async function createMainControlPlaneApp(
  options: MainControlPlaneAppOptions,
): Promise<ControlPlaneApp> {
  assertBuild(options.build);
  const app = createBaseApp(options.tls);
  const ingress = createIngressSecurity({
    app,
    allowedOrigins: options.allowedOrigins,
  });
  ingress.install();
  installProblemHandlers({
    app,
    correlationIdFor: ingress.correlationIdFor,
  });
  await registerCommonPlugins(app);

  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: LiveHealthSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: false,
      },
    },
    async () => ({
      status: "ok" as const,
      service: "opendelegate-main" as const,
      version: options.build.version,
      buildId: options.build.buildId,
    }),
  );

  registerMainOwnerRoutes(app, options, ingress.validatePublicMutation);
  registerDeviceRoutes(app, options);
  registerRuntimeFeatureRoutes(app, options);
  if (options.tasks !== undefined) {
    registerTaskRoutes(app, options, ingress.validatePublicMutation);
  }
  return app;
}

function registerRuntimeFeatureRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
): void {
  app.get(
    "/api/v1/runtime/features",
    {
      schema: {
        response: {
          200: RuntimeFeaturesResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return runtimeFeaturesFor(options);
    },
  );
}

function runtimeFeaturesFor(options: MainControlPlaneAppOptions): RuntimeFeaturesResponseV1 {
  return (
    options.runtimeFeatures ?? {
      releaseChannel: "development",
      taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
      configurationAgent: {
        status: "unavailable",
        code: "CONFIGURATION_AGENT_NOT_CONNECTED",
      },
      discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
    }
  );
}

function registerDeviceRoutes(app: ControlPlaneApp, options: MainControlPlaneAppOptions): void {
  app.get(
    "/api/v1/devices",
    {
      schema: {
        response: {
          200: DeviceListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return { devices: [...(options.devices ?? [])] };
    },
  );
}

function registerTaskRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions & {
    readonly tasks?: Pick<TaskService, "command" | "create" | "get" | "list">;
  },
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  const tasks = options.tasks;
  if (tasks === undefined) {
    return;
  }

  app.get(
    "/api/v1/tasks",
    {
      schema: {
        response: {
          200: TaskListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return { tasks: [...(await tasks.list())] };
    },
  );

  app.get(
    "/api/v1/tasks/:taskId",
    {
      schema: {
        params: TaskParamsSchema,
        response: {
          200: TaskDetailSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return tasks.get(request.params.taskId);
    },
  );

  app.post(
    "/api/v1/tasks",
    {
      schema: {
        body: CreateTaskRequestSchema,
        response: {
          201: TaskDetailSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request, reply) => {
      const sessionToken = await validateAuthenticatedMutation(request, options.ownerAuth);
      const session = await options.ownerAuth.validateSession(sessionToken);
      if (runtimeFeaturesFor(options).taskExecution.status !== "ready") {
        throw new PublicHttpError(503, "TASK_EXECUTION_UNAVAILABLE");
      }
      const task = await tasks.create({
        ...request.body,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
        completionCriteria: [...request.body.completionCriteria],
        constraints: [...request.body.constraints],
        selectedInputRefs: [...request.body.selectedInputRefs],
      });
      return reply.status(201).send(task);
    },
  );

  app.post(
    "/api/v1/tasks/:taskId/actions",
    {
      schema: {
        params: TaskParamsSchema,
        body: TaskCommandRequestSchema,
        response: {
          200: TaskDetailSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request) => {
      const sessionToken = await validateAuthenticatedMutation(request, options.ownerAuth);
      const session = await options.ownerAuth.validateSession(sessionToken);
      if (
        (request.body.command === "resume" || request.body.command === "retry") &&
        runtimeFeaturesFor(options).taskExecution.status !== "ready"
      ) {
        throw new PublicHttpError(503, "TASK_EXECUTION_UNAVAILABLE");
      }
      return tasks.command({
        taskId: request.params.taskId,
        command: request.body.command,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
}

export async function createLocalClaimApp(options: LocalClaimAppOptions): Promise<ControlPlaneApp> {
  const app = createBaseApp();
  const ingress = createIngressSecurity({
    app,
    allowedOrigins: options.allowedOrigins,
  });
  ingress.install();
  installProblemHandlers({
    app,
    correlationIdFor: ingress.correlationIdFor,
  });
  await registerCommonPlugins(app);

  app.post(
    "/api/v1/auth/claim",
    {
      schema: {
        body: OwnerClaimRequestSchema,
        response: {
          201: OwnerClaimResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        if (!isLoopbackAddress(request.ip)) {
          throw new PublicHttpError(403, "LOCAL_ACCESS_REQUIRED");
        }
        ingress.validatePublicMutation(request);
      },
    },
    async (request, reply) => {
      const claimed = await options.ownerAuth.claimOwner({
        channel: "local-bootstrap",
        claimToken: request.body.claimToken,
        passphrase: request.body.passphrase,
      });
      if (options.onClaimed !== undefined) {
        reply.raw.once("finish", () => {
          void options.onClaimed?.();
        });
      }
      return reply.status(201).send({
        ownerId: claimed.ownerId,
        recoveryCodes: [...claimed.recoveryCodes],
      });
    },
  );

  return app;
}

function createBaseApp(tls?: MainControlPlaneAppOptions["tls"]): ControlPlaneApp {
  return Fastify({
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: BODY_LIMIT_BYTES,
    logger: false,
    trustProxy: false,
    ...(tls === undefined
      ? {}
      : {
          https: {
            cert: tls.certificate,
            key: tls.privateKey,
          },
        }),
  }).withTypeProvider<TypeBoxTypeProvider>();
}

async function registerCommonPlugins(app: ControlPlaneApp): Promise<void> {
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: false,
    hook: "onRequest",
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "OpenDelegate Control Plane API",
        version: "1.0.0",
      },
    },
  });
}

function registerMainOwnerRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: OwnerLoginRequestSchema,
        response: {
          200: OwnerSessionResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request, reply) => {
      const login = await options.ownerAuth.login({
        passphrase: request.body.passphrase,
        sourceKey: request.ip,
      });
      setOwnerSessionCookie(reply, login.sessionToken);
      return ownerSessionResponse(login);
    },
  );

  app.get(
    "/api/v1/auth/session",
    {
      schema: {
        response: {
          200: OwnerSessionResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      const sessionToken = requireSessionToken(request);
      const [session, csrfToken] = await Promise.all([
        options.ownerAuth.validateSession(sessionToken),
        options.ownerAuth.issueCsrfToken(sessionToken),
      ]);
      return {
        csrfToken,
        session: serializeSession(session),
      };
    },
  );

  app.get(
    "/api/v1/readiness",
    {
      schema: {
        response: {
          ...ERROR_RESPONSES,
          200: ReadinessSchema,
          503: ReadinessSchema,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request, reply) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      const readiness =
        (await options.readiness?.()) ??
        ({
          status: "ready",
          checks: [{ status: "ready", code: "CONTROL_PLANE_READY" }],
        } satisfies ReadinessV1);
      return reply.status(readiness.status === "ready" ? 200 : 503).send(readiness);
    },
  );

  app.post(
    "/api/v1/auth/reauthenticate",
    {
      schema: {
        body: OwnerLoginRequestSchema,
        response: {
          200: OwnerSessionResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request, reply) => {
      const sessionToken = await validateAuthenticatedMutation(request, options.ownerAuth);
      const login = await options.ownerAuth.reauthenticate({
        sessionToken,
        passphrase: request.body.passphrase,
        sourceKey: request.ip,
      });
      setOwnerSessionCookie(reply, login.sessionToken);
      return ownerSessionResponse(login);
    },
  );

  app.get(
    "/api/v1/auth/sessions",
    {
      schema: {
        response: {
          200: OwnerSessionListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      const sessions = await options.ownerAuth.listSessions(requireSessionToken(request));
      return {
        sessions: sessions.map(serializeSessionSummary),
      };
    },
  );

  app.post(
    "/api/v1/auth/sessions/:sessionId/revoke",
    {
      schema: {
        params: RevokeSessionParamsSchema,
        body: EmptyObjectSchema,
        response: {
          200: AcknowledgementSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request) => {
      const sessionToken = await validateAuthenticatedMutation(request, options.ownerAuth);
      await options.ownerAuth.revokeSession({
        sessionToken,
        sessionId: request.params.sessionId,
      });
      return { status: "ok" as const };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        body: EmptyObjectSchema,
        response: {
          200: AcknowledgementSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request, reply) => {
      const sessionToken = await validateAuthenticatedMutation(request, options.ownerAuth);
      await options.ownerAuth.logout(sessionToken);
      clearOwnerSessionCookie(reply);
      return { status: "ok" as const };
    },
  );

  app.post(
    "/api/v1/auth/recovery/begin",
    {
      schema: {
        body: RecoveryBeginRequestSchema,
        response: {
          200: RecoveryBeginResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request) => {
      const challenge = await options.ownerAuth.beginRecovery({
        recoveryCode: request.body.recoveryCode,
      });
      return {
        recoveryToken: challenge.recoveryToken,
        expiresAt: toInstant(challenge.expiresAt),
      };
    },
  );

  app.post(
    "/api/v1/auth/recovery/complete",
    {
      schema: {
        body: RecoveryCompleteRequestSchema,
        response: {
          200: RecoveryCompleteResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: RECOVERY_COMPLETE_RATE_LIMIT,
      },
      onRequest: async (request) => {
        validatePublicMutation(request);
      },
    },
    async (request) => {
      const recovered = await options.ownerAuth.completeRecovery({
        recoveryToken: request.body.recoveryToken,
        newPassphrase: request.body.newPassphrase,
      });
      return {
        ownerId: recovered.ownerId,
        recoveryCodes: [...recovered.recoveryCodes],
      };
    },
  );
}

async function validateAuthenticatedMutation(
  request: FastifyRequest,
  ownerAuth: OwnerAuth,
): Promise<string> {
  const sessionToken = requireSessionToken(request);
  const csrfToken = oneHeader(request.headers["x-opendelegate-csrf"]) ?? "";
  const origin = oneHeader(request.headers.origin) ?? "";
  const contentType = oneHeader(request.headers["content-type"]) ?? "";
  const secFetchSite = oneHeader(request.headers["sec-fetch-site"]);

  await ownerAuth.validateUnsafeRequest({
    sessionToken,
    csrfToken,
    origin,
    contentType,
    ...(secFetchSite === undefined ? {} : { secFetchSite }),
  });
  return sessionToken;
}

function requireSessionToken(request: FastifyRequest): string {
  const token = request.cookies[OWNER_SESSION_COOKIE_NAME];
  if (token === undefined || token.length === 0) {
    throw new OwnerAuthError("AUTHENTICATION_REQUIRED", "Owner authentication is required.");
  }
  return token;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = oneHeader(request.headers["idempotency-key"]);
  if (
    value === undefined ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 500 ||
    [...value].some((character) => character.codePointAt(0) === 0)
  ) {
    throw new PublicHttpError(400, "IDEMPOTENCY_KEY_INVALID");
  }
  return value;
}

function setOwnerSessionCookie(reply: FastifyReply, sessionToken: string): void {
  void reply.setCookie(OWNER_SESSION_COOKIE_NAME, sessionToken, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

function clearOwnerSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(OWNER_SESSION_COOKIE_NAME, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

function ownerSessionResponse(login: OwnerLogin): {
  readonly csrfToken: string;
  readonly session: ReturnType<typeof serializeSession>;
} {
  return {
    csrfToken: login.csrfToken,
    session: serializeSession(login.session),
  };
}

function serializeSession(session: BrowserSession) {
  return {
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    createdAt: toInstant(session.createdAt),
    authenticatedAt: toInstant(session.authenticatedAt),
    lastUsedAt: toInstant(session.lastUsedAt),
    idleExpiresAt: toInstant(session.idleExpiresAt),
    absoluteExpiresAt: toInstant(session.absoluteExpiresAt),
  };
}

function serializeSessionSummary(session: BrowserSessionSummary) {
  return {
    ...serializeSession(session),
    current: session.current,
    expired: session.expired,
    ...(session.revokedAt === undefined ? {} : { revokedAt: toInstant(session.revokedAt) }),
  };
}

function toInstant(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function oneHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function assertBuild(build: MainControlPlaneAppOptions["build"]): void {
  if (build.version.trim() === "" || build.buildId.length < 7 || build.buildId.length > 128) {
    throw new Error("A valid version and build identifier are required.");
  }
}
