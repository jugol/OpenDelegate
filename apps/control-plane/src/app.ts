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
  ApprovalDecisionRequestSchema,
  ApprovalDetailSchema,
  ApprovalListResponseSchema,
  ApprovalParamsSchema,
  ArtifactDetailSchema,
  ArtifactListResponseSchema,
  ArtifactOpenInstructionSchema,
  ArtifactParamsSchema,
  AuditEventListResponseSchema,
  ConfigurationAgentConversationResponseSchema,
  ConfigurationAgentMessageParamsSchema,
  ConfigurationAgentMessageRequestSchema,
  ConfigurationAgentMessageResponseSchema,
  CreateTaskRequestSchema,
  DeviceAssessmentParamsSchema,
  DeviceAssessmentRequestSchema,
  DeviceAssessmentResponseSchema,
  DeviceListResponseSchema,
  DeviceEnrollmentOverviewSchema,
  ExtendTaskBudgetRequestSchema,
  IssueEnrollmentGrantRequestSchema,
  IssueEnrollmentGrantResponseSchema,
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
  SecureSecretIngestReceiptSchema,
  SecureSecretIngestRequestSchema,
  TaskCommandRequestSchema,
  TaskBudgetSnapshotSchema,
  TaskDetailSchema,
  TaskListResponseSchema,
  TaskParamsSchema,
  type DeviceSummaryV1,
  type ReadinessV1,
  type RuntimeFeaturesResponseV1,
} from "@opendelegate/protocol";
import type { TaskService } from "@opendelegate/task-service";

import type { ApprovalPort } from "./approval-port.ts";
import type { ArtifactAdminPort } from "./artifact-admin-port.ts";
import type { AuditAdminPort } from "./audit-admin-port.ts";
import type {
  ConfigurationAgentPort,
  ConfigurationAgentResponseLocale,
} from "./configuration-agent-port.ts";
import type { DeviceEnrollmentAdminPort } from "./device-enrollment-admin-port.ts";
import { createIngressSecurity, isLoopbackAddress, PublicHttpError } from "./http-security.ts";
import { installProblemHandlers } from "./problem-details.ts";
import { AcknowledgementSchema, EmptyObjectSchema } from "./schemas.ts";
import type { SecureSecretIngestPort } from "./secure-secret-ingest-port.ts";
import type { TaskBudgetAdminPort } from "./task-budget-admin-port.ts";

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
  readonly deviceDirectory?: {
    list(): Promise<readonly DeviceSummaryV1[]>;
  };
  readonly deviceAssessment?: {
    canAssess(deviceId: string): boolean;
    assess(input: {
      readonly deviceId: string;
      readonly principalId: string;
      readonly idempotencyKey: string;
    }): Promise<void>;
  };
  readonly runtimeFeatures?: RuntimeFeaturesResponseV1;
  readonly readiness?: () => ReadinessV1 | Promise<ReadinessV1>;
  readonly tasks?: Pick<TaskService, "command" | "create" | "get" | "list">;
  readonly configurationAgent?: ConfigurationAgentPort;
  readonly secretIngest?: SecureSecretIngestPort;
  readonly approvals?: ApprovalPort;
  readonly enrollment?: DeviceEnrollmentAdminPort;
  readonly artifacts?: ArtifactAdminPort;
  readonly audit?: AuditAdminPort;
  readonly budgets?: TaskBudgetAdminPort;
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
  registerDeviceRoutes(app, options, ingress.validatePublicMutation);
  registerRuntimeFeatureRoutes(app, options);
  registerSecureSecretIngestRoutes(app, options, ingress.validatePublicMutation);
  registerConfigurationAgentRoutes(app, options, ingress.validatePublicMutation);
  registerApprovalRoutes(app, options, ingress.validatePublicMutation);
  registerDeviceEnrollmentAdminRoutes(app, options, ingress.validatePublicMutation);
  registerArtifactAdminRoutes(app, options, ingress.validatePublicMutation);
  registerAuditAdminRoutes(app, options);
  if (options.tasks !== undefined) {
    registerTaskRoutes(app, options, ingress.validatePublicMutation);
  }
  registerTaskBudgetRoutes(app, options, ingress.validatePublicMutation);
  return app;
}

function registerTaskBudgetRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  const budgets = options.budgets;
  if (budgets === undefined) {
    return;
  }

  app.get(
    "/api/v1/tasks/:taskId/budget",
    {
      schema: {
        params: TaskParamsSchema,
        response: {
          200: TaskBudgetSnapshotSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return budgets.get(request.params.taskId);
    },
  );

  app.post(
    "/api/v1/tasks/:taskId/budget/extensions",
    {
      schema: {
        params: TaskParamsSchema,
        body: ExtendTaskBudgetRequestSchema,
        response: {
          200: TaskBudgetSnapshotSchema,
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
      return budgets.extend({
        taskId: request.params.taskId,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
        baseRevision: request.body.baseRevision,
        limits: structuredClone(request.body.limits),
      });
    },
  );
}

function registerSecureSecretIngestRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  app.post(
    "/api/v1/secrets/ingest",
    {
      schema: {
        body: SecureSecretIngestRequestSchema,
        response: {
          201: SecureSecretIngestReceiptSchema,
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
      if (options.secretIngest === undefined) {
        throw new PublicHttpError(503, "SECRET_INGEST_UNAVAILABLE");
      }
      const secret = decodeCanonicalBase64(request.body.secretBase64);
      clearEncodedSecret(request.body);
      try {
        const receipt = await options.secretIngest.ingest({
          principalId: session.ownerId,
          idempotencyKey: requireIdempotencyKey(request),
          purpose: request.body.purpose,
          secret,
        });
        return reply.status(201).send(receipt);
      } finally {
        secret.fill(0);
        clearEncodedSecret(request.body);
      }
    },
  );
}

function registerDeviceEnrollmentAdminRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  const enrollment = options.enrollment;
  if (enrollment === undefined) {
    return;
  }

  app.get(
    "/api/v1/device-enrollment",
    {
      schema: {
        response: {
          200: DeviceEnrollmentOverviewSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return enrollment.overview();
    },
  );

  app.post(
    "/api/v1/device-enrollment/grants",
    {
      schema: {
        body: IssueEnrollmentGrantRequestSchema,
        response: {
          201: IssueEnrollmentGrantResponseSchema,
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
      const issued = await enrollment.issue({
        deviceId: request.body.deviceId,
        expiresInSeconds: request.body.expiresInSeconds,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
      });
      return reply.status(201).send(issued);
    },
  );
}

function registerArtifactAdminRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  const artifacts = options.artifacts;
  if (artifacts === undefined) {
    return;
  }

  app.get(
    "/api/v1/artifacts",
    {
      schema: {
        response: {
          200: ArtifactListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return { artifacts: [...(await artifacts.list())] };
    },
  );

  app.get(
    "/api/v1/artifacts/:artifactId",
    {
      schema: {
        params: ArtifactParamsSchema,
        response: {
          200: ArtifactDetailSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return artifacts.get(request.params.artifactId);
    },
  );

  app.post(
    "/api/v1/artifacts/:artifactId/open",
    {
      schema: {
        params: ArtifactParamsSchema,
        body: EmptyObjectSchema,
        response: {
          200: ArtifactOpenInstructionSchema,
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
      return artifacts.open({
        artifactId: request.params.artifactId,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
}

function registerAuditAdminRoutes(app: ControlPlaneApp, options: MainControlPlaneAppOptions): void {
  const audit = options.audit;
  if (audit === undefined) {
    return;
  }

  app.get(
    "/api/v1/audit-events",
    {
      schema: {
        response: {
          200: AuditEventListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return { events: [...(await audit.list())] };
    },
  );
}

function registerApprovalRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  const approvals = options.approvals;
  if (approvals === undefined) {
    return;
  }

  app.get(
    "/api/v1/approvals",
    {
      schema: {
        response: {
          200: ApprovalListResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return { approvals: [...(await approvals.list())] };
    },
  );

  app.get(
    "/api/v1/approvals/:approvalId",
    {
      schema: {
        params: ApprovalParamsSchema,
        response: {
          200: ApprovalDetailSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      await options.ownerAuth.validateSession(requireSessionToken(request));
      return approvals.get(request.params.approvalId);
    },
  );

  app.post(
    "/api/v1/approvals/:approvalId/decision",
    {
      schema: {
        params: ApprovalParamsSchema,
        body: ApprovalDecisionRequestSchema,
        response: {
          200: ApprovalDetailSchema,
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
      return approvals.decide({
        approvalId: request.params.approvalId,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
        decision: structuredClone(request.body),
      });
    },
  );
}

function registerConfigurationAgentRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
  app.get(
    "/api/v1/devices/:deviceId/configuration/messages",
    {
      schema: {
        params: ConfigurationAgentMessageParamsSchema,
        response: {
          200: ConfigurationAgentConversationResponseSchema,
          ...ERROR_RESPONSES,
        },
      },
      config: {
        rateLimit: AUTH_RATE_LIMIT,
      },
    },
    async (request) => {
      const session = await options.ownerAuth.validateSession(requireSessionToken(request));
      const devices = await currentDevices(options);
      if (!devices.some((candidate) => candidate.deviceId === request.params.deviceId)) {
        throw new PublicHttpError(404, "DEVICE_NOT_FOUND");
      }
      if (options.configurationAgent?.listMessages === undefined) {
        return { messages: [] };
      }
      return (
        (await options.configurationAgent.listMessages({
          deviceId: request.params.deviceId,
          principalId: session.ownerId,
        })) ?? { messages: [] }
      );
    },
  );

  app.post(
    "/api/v1/devices/:deviceId/configuration/messages",
    {
      schema: {
        params: ConfigurationAgentMessageParamsSchema,
        body: ConfigurationAgentMessageRequestSchema,
        response: {
          200: ConfigurationAgentMessageResponseSchema,
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
        runtimeFeaturesFor(options).configurationAgent.status !== "ready" ||
        options.configurationAgent === undefined
      ) {
        throw new PublicHttpError(503, "CONFIGURATION_AGENT_UNAVAILABLE");
      }
      const devices = await currentDevices(options);
      const device = devices.find((candidate) => candidate.deviceId === request.params.deviceId);
      if (device === undefined) {
        throw new PublicHttpError(404, "DEVICE_NOT_FOUND");
      }
      return options.configurationAgent.sendMessage({
        deviceId: request.params.deviceId,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
        message: request.body.message,
        responseLocale: configurationAgentResponseLocale(request.headers["accept-language"]),
        ...(device.lastObservation === undefined
          ? {}
          : {
              deviceObservation: {
                name: device.name,
                osFamily: device.osFamily,
                platformRelease: device.platformRelease,
                architecture: device.architecture,
                role: device.role,
                observedAtMs: device.lastObservation.observedAtMs,
                capabilities: structuredClone(device.capabilities ?? []),
                agentAdapters: structuredClone(device.agentAdapters ?? []),
                ...(device.agentExecutionProfile === undefined
                  ? {}
                  : {
                      agentExecutionProfile: structuredClone(device.agentExecutionProfile),
                    }),
                ...(device.coordinatorAgentExecutionProfile === undefined
                  ? {}
                  : {
                      coordinatorAgentExecutionProfile: structuredClone(
                        device.coordinatorAgentExecutionProfile,
                      ),
                    }),
                knowledgeHealth: device.knowledgeHealth ?? "unknown",
              },
            }),
      });
    },
  );
}

const CONFIGURATION_AGENT_RESPONSE_LOCALES = [
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "zh-CN",
] as const satisfies readonly ConfigurationAgentResponseLocale[];

function configurationAgentResponseLocale(
  header: string | readonly string[] | undefined,
): ConfigurationAgentResponseLocale {
  const value = typeof header === "string" ? header : header?.join(",");
  if (value === undefined) {
    return "en";
  }
  const candidates = value
    .split(",")
    .map((part, index) => {
      const [rawTag = "", ...parameters] = part.trim().split(";");
      const qualityParameter = parameters.find((parameter) =>
        parameter.trim().toLowerCase().startsWith("q="),
      );
      const quality =
        qualityParameter === undefined
          ? 1
          : Number.parseFloat(qualityParameter.trim().slice("q=".length));
      return {
        index,
        locale: normalizeConfigurationAgentResponseLocale(rawTag),
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly index: number;
        readonly locale: ConfigurationAgentResponseLocale;
        readonly quality: number;
      } => candidate.locale !== undefined && candidate.quality > 0,
    )
    .sort((left, right) => right.quality - left.quality || left.index - right.index);
  return candidates[0]?.locale ?? "en";
}

function normalizeConfigurationAgentResponseLocale(
  value: string,
): ConfigurationAgentResponseLocale | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-cn-") ||
    normalized.startsWith("zh-hans-")
  ) {
    return "zh-CN";
  }
  const primary = normalized.split("-")[0];
  return CONFIGURATION_AGENT_RESPONSE_LOCALES.find(
    (locale) => locale !== "zh-CN" && locale === primary,
  );
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
      declaredReleaseChannel: "development",
      releaseChannel: "development",
      releaseVerification: { status: "not-applicable" },
      taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
      configurationAgent: {
        status: "unavailable",
        code: "CONFIGURATION_AGENT_NOT_CONNECTED",
      },
      discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
    }
  );
}

function registerDeviceRoutes(
  app: ControlPlaneApp,
  options: MainControlPlaneAppOptions,
  validatePublicMutation: (request: FastifyRequest) => void,
): void {
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
      return { devices: await currentDevices(options) };
    },
  );

  app.post(
    "/api/v1/devices/:deviceId/assessment",
    {
      schema: {
        params: DeviceAssessmentParamsSchema,
        body: DeviceAssessmentRequestSchema,
        response: {
          200: DeviceAssessmentResponseSchema,
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
      const devices = await currentDevices(options);
      if (!devices.some((device) => device.deviceId === request.params.deviceId)) {
        throw new PublicHttpError(404, "DEVICE_NOT_FOUND");
      }
      if (
        options.deviceAssessment === undefined ||
        !options.deviceAssessment.canAssess(request.params.deviceId)
      ) {
        throw new PublicHttpError(503, "DEVICE_ASSESSMENT_UNAVAILABLE");
      }
      await options.deviceAssessment.assess({
        deviceId: request.params.deviceId,
        principalId: session.ownerId,
        idempotencyKey: requireIdempotencyKey(request),
      });
      const device = (await currentDevices(options)).find(
        (candidate) => candidate.deviceId === request.params.deviceId,
      );
      if (device === undefined) {
        throw new PublicHttpError(404, "DEVICE_NOT_FOUND");
      }
      return { device };
    },
  );
}

async function currentDevices(
  options: Pick<MainControlPlaneAppOptions, "deviceDirectory" | "devices">,
): Promise<DeviceSummaryV1[]> {
  const devices =
    options.deviceDirectory === undefined
      ? (options.devices ?? [])
      : await options.deviceDirectory.list();
  return devices.map((device) => structuredClone(device));
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

function decodeCanonicalBase64(value: string): Buffer {
  const secret = Buffer.from(value, "base64");
  if (
    secret.byteLength === 0 ||
    secret.byteLength > 65_536 ||
    secret.toString("base64") !== value
  ) {
    secret.fill(0);
    throw new PublicHttpError(400, "SECRET_INGEST_INVALID");
  }
  return secret;
}

function clearEncodedSecret(value: { readonly secretBase64: string }): void {
  try {
    (value as { secretBase64: string }).secretBase64 = "";
  } catch {
    // The route never logs or returns this field; this is best-effort shortening
    // of the immutable JSON string's reachability after decoding.
  }
}

function assertBuild(build: MainControlPlaneAppOptions["build"]): void {
  if (build.version.trim() === "" || build.buildId.length < 7 || build.buildId.length > 128) {
    throw new Error("A valid version and build identifier are required.");
  }
}
