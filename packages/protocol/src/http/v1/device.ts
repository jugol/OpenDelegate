import Type from "typebox";

import { OpaqueIdSchema } from "./common.ts";

export const DeviceOsFamilySchema = Type.Union([
  Type.Literal("macos"),
  Type.Literal("windows"),
  Type.Literal("linux"),
]);

const DeviceCapabilitySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    verification: Type.Union([
      Type.Literal("detected"),
      Type.Literal("verified"),
      Type.Literal("degraded"),
      Type.Literal("unavailable"),
      Type.Literal("disabled"),
    ]),
    observedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    evidenceSource: Type.Optional(
      Type.Union([
        Type.Literal("agent-adapter"),
        Type.Literal("capability-probe"),
        Type.Literal("workspace-registry"),
      ]),
    ),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

const DeviceFactSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("os-family"),
      Type.Literal("platform-release"),
      Type.Literal("architecture"),
      Type.Literal("hostname"),
      Type.Literal("cpu-model"),
      Type.Literal("cpu-logical-cores"),
      Type.Literal("memory-total-bytes"),
      Type.Literal("gpu-model"),
    ]),
    value: Type.String({ minLength: 1, maxLength: 256 }),
    source: Type.Union([
      Type.Literal("enrollment"),
      Type.Literal("authenticated-heartbeat"),
      Type.Literal("node-os"),
      Type.Literal("platform-probe"),
    ]),
    observedAtMs: Type.Integer({ minimum: 0 }),
    verification: Type.Union([Type.Literal("observed"), Type.Literal("verified")]),
  },
  { additionalProperties: false },
);

const DeviceRouteSchema = Type.Object(
  {
    routeId: OpaqueIdSchema,
    label: Type.String({ minLength: 1, maxLength: 256 }),
    priority: Type.Integer({ minimum: 0, maximum: 65_535 }),
    kind: Type.Optional(Type.Union([Type.Literal("https"), Type.Literal("wss")])),
    profileRevision: Type.Optional(
      Type.String({ pattern: "^sha256:[a-f0-9]{64}$", maxLength: 71 }),
    ),
    health: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unhealthy"),
      Type.Literal("unknown"),
    ]),
    lastAttempt: Type.Optional(
      Type.Object(
        {
          probeSource: Type.Union([
            Type.Literal("cache"),
            Type.Literal("live"),
            Type.Literal("not-run"),
          ]),
          outcome: Type.Union([
            Type.Literal("authentication-rejected"),
            Type.Literal("connect-failed"),
            Type.Literal("connected"),
            Type.Literal("identity-rejected"),
            Type.Literal("probe-unhealthy"),
            Type.Literal("skipped-incompatible"),
          ]),
          observedAtMs: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const DevicePolicySchema = Type.Object(
  {
    policyId: OpaqueIdSchema,
    actionCategory: Type.String({ minLength: 1, maxLength: 160 }),
    decision: Type.Union([
      Type.Literal("allow"),
      Type.Literal("require-approval"),
      Type.Literal("deny"),
    ]),
    source: Type.Union([Type.Literal("built-in"), Type.Literal("configuration")]),
    effectiveScope: Type.Union([
      Type.Literal("instance"),
      Type.Literal("main"),
      Type.Literal("device"),
    ]),
  },
  { additionalProperties: false },
);

const DeviceAgentAdapterSchema = Type.Object(
  {
    provider: Type.Union([
      Type.Literal("codex"),
      Type.Literal("claude"),
      Type.Literal("generic-command"),
    ]),
    adapterId: OpaqueIdSchema,
    readiness: Type.Union([
      Type.Literal("ready"),
      Type.Literal("degraded"),
      Type.Literal("unavailable"),
    ]),
    compatibility: Type.Union([
      Type.Literal("tested"),
      Type.Literal("compatible"),
      Type.Literal("untested"),
      Type.Literal("incompatible"),
    ]),
    version: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    observedAtMs: Type.Integer({ minimum: 0 }),
    modelCatalogObservedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    models: Type.Optional(
      Type.Array(
        Type.Object(
          {
            modelId: Type.String({ minLength: 1, maxLength: 256 }),
            displayName: Type.String({ minLength: 1, maxLength: 256 }),
            isDefault: Type.Optional(Type.Boolean()),
            supportedEfforts: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
                maxItems: 32,
                uniqueItems: true,
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 128 },
      ),
    ),
  },
  { additionalProperties: false },
);

const DeviceAgentBindingSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("codex"), Type.Literal("claude"), Type.Literal("generic")]),
    adapterId: Type.String({ minLength: 1, maxLength: 160 }),
    modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

const DeviceAgentExecutionProfileSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      mode: Type.Literal("auto"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      mode: Type.Literal("prefer"),
      primary: DeviceAgentBindingSchema,
      fallbacks: Type.Array(DeviceAgentBindingSchema, { maxItems: 7 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      mode: Type.Literal("pinned"),
      primary: DeviceAgentBindingSchema,
    },
    { additionalProperties: false },
  ),
]);

const DeviceResourceLockHolderSchema = Type.Object(
  {
    taskId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    expiresAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const DeviceResourceLockSchema = Type.Object(
  {
    resourceName: Type.String({ minLength: 1, maxLength: 160 }),
    capacity: Type.Integer({ minimum: 1, maximum: 1_024 }),
    holders: Type.Array(DeviceResourceLockHolderSchema, {
      maxItems: 1_024,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const DeviceCurrentRunSchema = Type.Object(
  {
    taskId: OpaqueIdSchema,
    workOrderId: OpaqueIdSchema,
    runId: OpaqueIdSchema,
    state: Type.Union([
      Type.Literal("starting"),
      Type.Literal("running"),
      Type.Literal("cancelling"),
    ]),
    acceptedAtMs: Type.Integer({ minimum: 0 }),
    leaseExpiresAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const DeviceWakeOnLanPlatformSourceSchema = Type.Union([
  Type.Literal("windows-netadapter-power"),
  Type.Literal("macos-pmset"),
  Type.Literal("linux-ethtool"),
]);

const DeviceWakeOnLanSchema = Type.Union([
  Type.Object(
    {
      targetState: Type.Literal("enabled"),
      automaticWakeState: Type.Literal("relay-required"),
      source: DeviceWakeOnLanPlatformSourceSchema,
      observedAtMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      targetState: Type.Union([Type.Literal("disabled"), Type.Literal("unsupported")]),
      automaticWakeState: Type.Literal("unavailable"),
      source: DeviceWakeOnLanPlatformSourceSchema,
      observedAtMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      targetState: Type.Literal("unknown"),
      automaticWakeState: Type.Literal("unknown"),
      source: Type.Union([DeviceWakeOnLanPlatformSourceSchema, Type.Literal("probe-unavailable")]),
      observedAtMs: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);

export const DeviceSummarySchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
    name: Type.String({ minLength: 1, maxLength: 253 }),
    osFamily: DeviceOsFamilySchema,
    platformRelease: Type.String({ minLength: 1, maxLength: 256 }),
    architecture: Type.String({ minLength: 1, maxLength: 64 }),
    role: Type.Union([Type.Literal("main"), Type.Literal("worker")]),
    connection: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
    runtime: Type.Union([
      Type.Literal("healthy"),
      Type.Literal("degraded"),
      Type.Literal("unavailable"),
    ]),
    serviceMode: Type.Union([
      Type.Literal("foreground"),
      Type.Literal("system-service"),
      Type.Literal("user-service"),
    ]),
    lastObservation: Type.Optional(
      Type.Object(
        {
          observedAtMs: Type.Integer({ minimum: 0 }),
          acceptedAtMs: Type.Integer({ minimum: 0 }),
          source: Type.Union([
            Type.Literal("authenticated-heartbeat"),
            Type.Literal("local-assessment"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    roles: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    instructions: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    facts: Type.Optional(
      Type.Array(DeviceFactSchema, {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    capabilities: Type.Optional(
      Type.Array(DeviceCapabilitySchema, {
        maxItems: 512,
      }),
    ),
    policies: Type.Optional(
      Type.Array(DevicePolicySchema, {
        maxItems: 256,
        uniqueItems: true,
      }),
    ),
    agentAdapters: Type.Optional(
      Type.Array(DeviceAgentAdapterSchema, {
        maxItems: 64,
        uniqueItems: true,
      }),
    ),
    agentExecutionProfile: Type.Optional(DeviceAgentExecutionProfileSchema),
    coordinatorAgentExecutionProfile: Type.Optional(DeviceAgentExecutionProfileSchema),
    wakeOnLan: Type.Optional(DeviceWakeOnLanSchema),
    routes: Type.Optional(
      Type.Array(DeviceRouteSchema, {
        maxItems: 64,
      }),
    ),
    resourceLocks: Type.Optional(
      Type.Array(DeviceResourceLockSchema, {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    currentRuns: Type.Optional(
      Type.Array(DeviceCurrentRunSchema, {
        maxItems: 1_024,
        uniqueItems: true,
      }),
    ),
    capacity: Type.Optional(
      Type.Object(
        {
          activeRuns: Type.Integer({ minimum: 0, maximum: 1_024 }),
          maximumConcurrentRuns: Type.Integer({ minimum: 1, maximum: 1_024 }),
          acceptingWork: Type.Boolean(),
          maxOutboxEntries: Type.Optional(Type.Integer({ minimum: 2, maximum: 1_000_000 })),
          outboxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
        },
        { additionalProperties: false },
      ),
    ),
    knowledgeHealth: Type.Optional(
      Type.Union([
        Type.Literal("healthy"),
        Type.Literal("degraded"),
        Type.Literal("unavailable"),
        Type.Literal("unknown"),
      ]),
    ),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceSummaryV1",
  },
);

export type DeviceSummaryV1 = Type.Static<typeof DeviceSummarySchema>;

export const DeviceAssessmentParamsSchema = Type.Object(
  {
    deviceId: OpaqueIdSchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceAssessmentParamsV1",
  },
);

export const DeviceAssessmentRequestSchema = Type.Object(
  {},
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceAssessmentRequestV1",
  },
);

export const DeviceAssessmentResponseSchema = Type.Object(
  {
    device: DeviceSummarySchema,
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceAssessmentResponseV1",
  },
);

export type DeviceAssessmentParamsV1 = Type.Static<typeof DeviceAssessmentParamsSchema>;
export type DeviceAssessmentRequestV1 = Type.Static<typeof DeviceAssessmentRequestSchema>;
export type DeviceAssessmentResponseV1 = Type.Static<typeof DeviceAssessmentResponseSchema>;

export const DeviceListResponseSchema = Type.Object(
  {
    devices: Type.Array(DeviceSummarySchema, {
      maxItems: 10_000,
      uniqueItems: true,
    }),
  },
  {
    additionalProperties: false,
    $id: "OpenDelegateDeviceListResponseV1",
  },
);

export type DeviceListResponseV1 = Type.Static<typeof DeviceListResponseSchema>;
