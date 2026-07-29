import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  BrowserAdminApi,
  type ApprovalDetail,
  type ArtifactDetail,
  type AuditEventSummary,
  type DeviceEnrollmentOverview,
  type IssueEnrollmentGrantResult,
  type OwnerSession,
  type TaskBudgetSnapshot,
  type TaskDetail,
} from "./admin-api";

const ownerSession: OwnerSession = {
  sessionId: "session_owner_browser",
  ownerId: "owner_primary",
  createdAt: "2026-07-24T01:00:00.000Z",
  authenticatedAt: "2026-07-24T01:00:00.000Z",
  lastUsedAt: "2026-07-24T01:00:00.000Z",
  idleExpiresAt: "2026-07-24T02:00:00.000Z",
  absoluteExpiresAt: "2026-07-25T01:00:00.000Z",
};

const task: TaskDetail = {
  taskId: "task_shutdown_review",
  state: "paused",
  mode: "auto",
  objective: "Review shutdown behavior.",
  createdAt: "2026-07-24T01:00:00.000Z",
  updatedAt: "2026-07-24T01:01:00.000Z",
  version: 2,
  completionCriteria: ["Shutdown failures are observable."],
  constraints: [],
  selectedInputRefs: [],
  messages: [],
  events: [],
};

const taskBudget: TaskBudgetSnapshot = {
  schemaVersion: 1,
  taskId: task.taskId,
  kind: "requested",
  revision: 2,
  createdAt: "2026-07-24T01:00:00.000Z",
  lastActivityAt: "2026-07-24T01:01:00.000Z",
  limits: {
    wallTimeMs: { soft: 3_000_000, hard: 3_600_000 },
    idleTimeMs: { soft: 480_000, hard: 600_000 },
    retries: { soft: 2, hard: 3 },
    childWorkOrders: { soft: 6, hard: 8 },
    concurrentRuns: { soft: 1, hard: 2 },
    nativeTurns: { soft: 12, hard: 16 },
    tokens: { soft: 200_000, hard: 250_000 },
    costUsdMicros: { soft: 4_000_000, hard: 5_000_000 },
  },
  usage: {},
  workOrders: [],
  activeRunIds: [],
  limitEvents: [],
  extensions: [],
  omitted: {
    workOrders: 0,
    activeRunIds: 0,
    limitEvents: 0,
    extensions: 0,
  },
};

const approval: ApprovalDetail = {
  approvalId: "approval_configuration_001",
  state: "pending",
  executionStatus: "waiting",
  requestedAt: "2026-07-24T01:02:00.000Z",
  expiresAt: "2026-07-25T01:02:00.000Z",
  action: {
    category: "policy-relaxation",
    type: "configuration.apply",
    fingerprint: `sha256:${"a".repeat(64)}`,
    targetDeviceId: "device_main/with space",
    resource: "configuration-proposal:proposal_001",
  },
  reason: "Enable Computer Use for this Device.",
  target: "device_main/with space",
  risk: "high",
  evidence: ["capability.computer-use at device:device_main/with space"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.lang = "en";
});

describe("BrowserAdminApi JSON responses", () => {
  it("sends the active Admin presentation locale without changing API fields", async () => {
    document.documentElement.lang = "fr";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        csrfToken: "csrf-locale",
        session: ownerSession,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new BrowserAdminApi().session();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("Accept-Language")).toBe("fr");
    expect((headers as Headers).get("Accept")).toBe("application/json");
  });

  it("sends Configuration Chat through the authenticated Device-scoped endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ csrfToken: "csrf-configuration", session: ownerSession }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          messageId: "configuration_message_001",
          sessionId: "configuration_session_device_main",
          content: "The Device-scoped proposal is ready for review.",
          suggestedActions: ["guide-discord"],
          occurredAt: "2026-07-24T01:02:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(
      api.sendConfigurationMessage("device_main/with space", "Inspect this Device."),
    ).resolves.toEqual({
      content: "The Device-scoped proposal is ready for review.",
      suggestedActions: ["guide-discord"],
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/devices/device_main%2Fwith%20space/configuration/messages",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ message: "Inspect this Device." }),
    );
    const headers = fetchMock.mock.calls[1]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-opendelegate-csrf")).toBe("csrf-configuration");
    expect((headers as Headers).get("idempotency-key")).toMatch(/^admin-[0-9a-f-]{36}$/);
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
  });

  it("loads the durable Device-scoped Configuration Chat conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ csrfToken: "csrf-configuration-history", session: ownerSession }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              messageId: "configuration_owner_001",
              role: "owner",
              content: "Keep this after restart.",
              responseStatus: "completed",
              occurredAt: "2026-07-24T01:01:00.000Z",
            },
            {
              messageId: "configuration_agent_001",
              role: "agent",
              content: "The conversation is durable.",
              suggestedActions: ["guide-discord"],
              occurredAt: "2026-07-24T01:02:00.000Z",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.listConfigurationMessages("device_main/with space")).resolves.toEqual([
      {
        messageId: "configuration_owner_001",
        role: "owner",
        content: "Keep this after restart.",
        suggestedActions: [],
        responseStatus: "completed",
        occurredAt: "2026-07-24T01:01:00.000Z",
      },
      {
        messageId: "configuration_agent_001",
        role: "agent",
        content: "The conversation is durable.",
        suggestedActions: ["guide-discord"],
        occurredAt: "2026-07-24T01:02:00.000Z",
      },
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/devices/device_main%2Fwith%20space/configuration/messages",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
  });

  it("sends Secret bytes only through the authenticated secure-ingest endpoint", async () => {
    const receipt = {
      schemaVersion: 1 as const,
      secretRef: "secret://main/database_test",
      availability: "ready" as const,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ csrfToken: "csrf-secret-ingest", session: ownerSession }),
      )
      .mockResolvedValueOnce(jsonResponse(receipt));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();
    const material = new TextEncoder().encode("postgresql://owner:browser-only@database.test/main");

    await api.login("correct horse battery staple");
    await expect(api.ingestSecret("database-uri", material)).resolves.toEqual(receipt);

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/secrets/ingest");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      purpose: "database-uri",
      secretBase64: Buffer.from(material).toString("base64"),
    });
    const headers = fetchMock.mock.calls[1]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-opendelegate-csrf")).toBe("csrf-secret-ingest");
    expect((headers as Headers).get("idempotency-key")).toMatch(/^admin-[0-9a-f-]{36}$/);
    expect(new TextDecoder().decode(material)).toContain("browser-only");

    await expect(
      api.ingestSecret("database-uri", new Uint8Array(8 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "SECRET_INGEST_INVALID", status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    material.fill(0);
  });

  it("lists Approval projections and submits an authenticated idempotent owner decision", async () => {
    const decidedApproval: ApprovalDetail = {
      ...approval,
      state: "approved",
      executionStatus: "succeeded",
      decision: {
        decision: "approve",
        scope: "once",
        decidedBy: ownerSession.ownerId,
        decidedAt: "2026-07-24T01:03:00.000Z",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-approval", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse({ approvals: [approval] }))
      .mockResolvedValueOnce(jsonResponse(approval))
      .mockResolvedValueOnce(jsonResponse(decidedApproval));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.listApprovals()).resolves.toEqual([approval]);
    await expect(api.getApproval("approval/with space")).resolves.toEqual(approval);
    await expect(
      api.decideApproval(approval.approvalId, {
        decision: "approve",
        scope: "once",
      }),
    ).resolves.toEqual(decidedApproval);

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/approvals");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/approvals/approval%2Fwith%20space");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/v1/approvals/approval_configuration_001/decision",
    );
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(
      JSON.stringify({ decision: "approve", scope: "once" }),
    );
    const headers = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-opendelegate-csrf")).toBe("csrf-approval");
    expect((headers as Headers).get("idempotency-key")).toMatch(/^admin-[0-9a-f-]{36}$/);
  });

  it("uses the authenticated operations endpoints for enrollment, Artifacts, Audit, and diagnostics", async () => {
    const enrollment: DeviceEnrollmentOverview = {
      available: true,
      mainDeviceId: "device_main",
      expectedMainSpkiSha256: "a".repeat(64),
      enrollmentUrl: "https://main.test:9443/api/v1/device/enroll",
      channelEndpoints: [
        {
          endpointId: "main-worker-channel",
          label: "Main Worker channel",
          kind: "wss",
          url: "wss://main.test:9444/api/v1/device/channel",
        },
      ],
      grants: [],
    };
    const issued = {
      summary: {
        grantId: "grant_001",
        deviceId: "device_worker",
        status: "active" as const,
        allowedBootstrapRoles: ["worker"],
        createdAt: "2026-07-25T00:00:00.000Z",
        expiresAt: "2026-07-25T00:05:00.000Z",
      },
      suggestedFilename: "opendelegate-device_worker-grant.json",
      document: {
        schemaVersion: 1 as const,
        grantId: "grant_001",
        token: "g".repeat(43),
        deviceId: "device_worker",
        mainDeviceId: "device_main",
        expectedMainSpkiSha256: "a".repeat(64),
        certificateAuthorityPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----\n`,
        enrollmentUrl: "https://main.test:9443/api/v1/device/enroll",
        channelEndpoints: enrollment.channelEndpoints ?? [],
        protocolRange: { minimum: 1, maximum: 1 },
        expiresAt: Date.parse("2026-07-25T00:05:00.000Z"),
      },
    } satisfies IssueEnrollmentGrantResult;
    const artifact = {
      artifactId: "artifact_report",
      taskId: "task_release",
      producingRunId: "run_worker",
      mediaType: "text/html",
      originalFilename: "report.html",
      sizeBytes: 4096,
      checksum: { algorithm: "sha256" as const, value: "b".repeat(64) },
      createdAt: "2026-07-25T00:00:00.000Z",
      retentionPolicy: {
        kind: "temporary" as const,
        expiresAt: "2026-07-26T00:00:00.000Z",
      },
      exposurePolicy: { mode: "authenticated" as const },
      provenance: { deviceId: "device_worker", source: "worker-upload" },
      presentation: "static-html" as const,
      state: "available" as const,
    } satisfies ArtifactDetail;
    const auditEvent = {
      auditId: "audit_001",
      source: "artifact" as const,
      type: "artifact.stored",
      occurredAt: "2026-07-25T00:00:00.000Z",
      outcome: "recorded" as const,
      artifactId: artifact.artifactId,
    } satisfies AuditEventSummary;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-operations", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(enrollment))
      .mockResolvedValueOnce(jsonResponse(issued, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ artifacts: [artifact] }))
      .mockResolvedValueOnce(jsonResponse(artifact))
      .mockResolvedValueOnce(
        jsonResponse({
          method: "GET",
          href: "https://static.artifacts.test/artifacts/artifact_report",
          artifactId: artifact.artifactId,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ events: [auditEvent] }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "ready",
          checks: [{ status: "ready", code: "DATABASE_READY" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.deviceEnrollment()).resolves.toEqual(enrollment);
    await expect(
      api.issueEnrollmentGrant({ deviceId: "device_worker", expiresInSeconds: 300 }),
    ).resolves.toEqual(issued);
    await expect(api.listArtifacts()).resolves.toEqual([artifact]);
    await expect(api.getArtifact("artifact/with space")).resolves.toEqual(artifact);
    await expect(api.openArtifact(artifact.artifactId)).resolves.toMatchObject({ method: "GET" });
    await expect(api.listAuditEvents()).resolves.toEqual([auditEvent]);
    await expect(api.readiness()).resolves.toMatchObject({ status: "ready" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/auth/login",
      "/api/v1/device-enrollment",
      "/api/v1/device-enrollment/grants",
      "/api/v1/artifacts",
      "/api/v1/artifacts/artifact%2Fwith%20space",
      "/api/v1/artifacts/artifact_report/open",
      "/api/v1/audit-events",
      "/api/v1/readiness",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ deviceId: "device_worker", expiresInSeconds: 300 }),
    );
    expect(fetchMock.mock.calls[5]?.[1]?.body).toBe(JSON.stringify({}));
    for (const index of [2, 5]) {
      const headers = fetchMock.mock.calls[index]?.[1]?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("x-opendelegate-csrf")).toBe("csrf-operations");
      expect((headers as Headers).get("idempotency-key")).toMatch(/^admin-[0-9a-f-]{36}$/);
    }
  });

  it("reads a Task Budget and sends an authenticated, idempotent exact extension", async () => {
    const extended = {
      ...taskBudget,
      revision: 3,
      limits: {
        ...taskBudget.limits,
        tokens: { soft: 225_000, hard: 300_000 },
      },
    } satisfies TaskBudgetSnapshot;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-budget", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(taskBudget))
      .mockResolvedValueOnce(jsonResponse(extended));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.getTaskBudget("task/with space")).resolves.toEqual(taskBudget);
    await expect(
      api.extendTaskBudget(taskBudget.taskId, taskBudget.revision, extended.limits),
    ).resolves.toEqual(extended);

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/tasks/task%2Fwith%20space/budget");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/v1/tasks/task_shutdown_review/budget/extensions",
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        baseRevision: 2,
        limits: extended.limits,
      }),
    );
    const headers = fetchMock.mock.calls[2]?.[1]?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get("x-opendelegate-csrf")).toBe("csrf-budget");
    expect((headers as Headers).get("idempotency-key")).toMatch(/^admin-[0-9a-f-]{36}$/);
  });

  it("preserves Problem Details and refreshes CSRF state after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            code: "AUTHENTICATION_FAILED",
            detail: "The owner credential is no longer valid.",
            title: "Owner authentication failed.",
          },
          {
            status: 401,
            contentType: "application/problem+json; charset=utf-8",
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.commandTask(task.taskId, "pause")).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "The owner credential is no longer valid.",
      status: 401,
    });

    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it("uses a valid Problem Details title when the server omits detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            type: "https://opendelegate.dev/problems/authentication-required",
            title: "Owner authentication is required.",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            correlationId: "correlation_title_only",
          },
          {
            status: 401,
            contentType: "application/problem+json",
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().session()).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      message: "Owner authentication is required.",
      status: 401,
    });
  });

  it("refreshes CSRF state when a 401 contains a non-JSON body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        new Response("<h1>Unauthorized</h1>", {
          status: 401,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    await expect(api.commandTask(task.taskId, "pause")).rejects.toBeDefined();
    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);

    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it("redacts malformed JSON while preserving status and refreshing CSRF state", async () => {
    const privateSentinel = "PRIVATE_RESPONSE_SENTINEL";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-old", session: ownerSession }))
      .mockResolvedValueOnce(
        new Response(`{"private":"${privateSentinel}"`, {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-new", session: ownerSession }))
      .mockResolvedValueOnce(jsonResponse(task));
    vi.stubGlobal("fetch", fetchMock);
    const api = new BrowserAdminApi();

    await api.login("correct horse battery staple");
    let failure: unknown;
    try {
      await api.commandTask(task.taskId, "pause");
    } catch (cause) {
      failure = cause;
    }
    expect(failure?.constructor).toBe(AdminApiError);
    expect(failure).toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      message: "OpenDelegate returned an unexpected response.",
      status: 401,
    });
    expect(String(failure)).not.toContain(privateSentinel);
    expect(String(failure)).not.toContain("SyntaxError");

    await expect(api.commandTask(task.taskId, "pause")).resolves.toEqual(task);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/auth/session");
    const refreshedCommandHeaders = fetchMock.mock.calls[3]?.[1]?.headers;
    expect(refreshedCommandHeaders).toBeInstanceOf(Headers);
    expect((refreshedCommandHeaders as Headers).get("x-opendelegate-csrf")).toBe("csrf-new");
  });

  it.each([
    "application/json",
    "Application/JSON; Charset=UTF-8",
    "application/problem+json",
    "application/vnd.opendelegate.owner+json; version=1",
  ])("accepts the JSON media type %s", async (contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { csrfToken: "csrf-token", session: ownerSession },
          {
            contentType,
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().login("owner passphrase")).resolves.toEqual(ownerSession);
  });

  it.each([
    "text/json",
    "text/application/json",
    "application/jsonp",
    "application/problem+jsonx",
    "application/json, text/plain",
  ])("rejects the non-JSON media type %s", async (contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { csrfToken: "csrf-token", session: ownerSession },
          {
            contentType,
          },
        ),
      ),
    );

    await expect(new BrowserAdminApi().login("owner passphrase")).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
    });
  });
});

function jsonResponse(
  body: unknown,
  options: {
    readonly contentType?: string;
    readonly status?: number;
  } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json",
    },
  });
}
