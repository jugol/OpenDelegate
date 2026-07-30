import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  AdminApi,
  ArtifactDetail,
  AuditEventSummary,
  DeviceEnrollmentOverview,
  IssueEnrollmentGrantResult,
} from "./admin-api";
import { ArtifactSurface } from "./ArtifactSurface";
import { AuditSurface } from "./AuditSurface";
import { JoinSurface } from "./JoinSurface";
import { AdminI18nProvider, formatMessage } from "./i18n";
import { englishMessages } from "./i18n/messages.en";
import { koreanMessages } from "./i18n/messages.ko";

const NOW = "2026-07-25T00:00:00.000Z";

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

const issued: IssueEnrollmentGrantResult = {
  summary: {
    grantId: "grant_001",
    deviceId: "device_worker",
    status: "active",
    allowedBootstrapRoles: ["worker"],
    createdAt: NOW,
    expiresAt: "2026-07-25T00:05:00.000Z",
  },
  suggestedFilename: "opendelegate-device_worker-grant.json",
  document: {
    schemaVersion: 1,
    grantId: "grant_001",
    token: "PRIVATE_ENROLLMENT_TOKEN_NEVER_RENDER",
    deviceId: "device_worker",
    mainDeviceId: "device_main",
    expectedMainSpkiSha256: "a".repeat(64),
    certificateAuthorityPem: "certificate",
    enrollmentUrl: "https://main.test:9443/api/v1/device/enroll",
    channelEndpoints: enrollment.channelEndpoints ?? [],
    protocolRange: { minimum: 1, maximum: 1 },
    expiresAt: Date.parse("2026-07-25T00:05:00.000Z"),
  },
};

const artifact: ArtifactDetail = {
  artifactId: "artifact_report",
  taskId: "task_release",
  producingRunId: "run_worker",
  mediaType: "text/html",
  originalFilename: "release-report.html",
  sizeBytes: 4096,
  checksum: { algorithm: "sha256", value: "b".repeat(64) },
  createdAt: NOW,
  retentionPolicy: {
    kind: "temporary",
    expiresAt: "2026-07-26T00:00:00.000Z",
  },
  exposurePolicy: { mode: "authenticated" },
  provenance: {
    deviceId: "device_worker",
    source: "worker-upload",
    workspaceId: "workspace_repo",
  },
  presentation: "static-html",
  state: "available",
};

const auditEvent: AuditEventSummary = {
  auditId: "audit_001",
  source: "artifact",
  type: "artifact.stored",
  occurredAt: NOW,
  outcome: "recorded",
  actorId: "worker-agent",
  subjectId: artifact.artifactId,
  correlationId: "correlation_001",
  taskId: artifact.taskId,
  runId: artifact.producingRunId,
  deviceId: artifact.provenance.deviceId,
  artifactId: artifact.artifactId,
};

const routeDiagnosticEvent: AuditEventSummary = {
  auditId: "audit_route_001",
  source: "runtime",
  type: "transport.route-incident.diagnosis-completed.v1",
  occurredAt: "2026-07-25T00:00:01.000Z",
  outcome: "succeeded",
  subjectId: "device_worker",
  deviceId: "device_worker",
  routeIncident: {
    incidentId: `sha256:${"a".repeat(64)}`,
    fingerprint: `sha256:${"b".repeat(64)}`,
    profileRevision: `sha256:${"c".repeat(64)}`,
    recommendation: "Check whether the private route is reachable from this Device.",
    ownerQuestion: "Should OpenDelegate keep using the next configured route?",
    source: "agent",
    reasonCode: "AGENT_COMPLETED",
  },
};

const actionAuthorizationEvent: AuditEventSummary = {
  auditId: "audit_action_001",
  source: "action-authorization",
  type: "worker.action.os-network-change.denied",
  occurredAt: "2026-07-25T00:00:02.000Z",
  outcome: "denied",
  subjectId: `authorization:${"d".repeat(64)}`,
  taskId: "task_release",
  runId: "run_worker",
  deviceId: "device_worker",
  reasonCode: "OWNER_DENIED",
};

describe("owner operations surfaces", () => {
  it("issues a bounded enrollment grant and never renders its credential", async () => {
    const user = userEvent.setup();
    const api = {
      deviceEnrollment: vi.fn().mockResolvedValue(enrollment),
      issueEnrollmentGrant: vi.fn().mockResolvedValue(issued),
    } satisfies Pick<AdminApi, "deviceEnrollment" | "issueEnrollmentGrant">;

    render(<JoinSurface api={api} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Add a Device" })).toBeTruthy();
    expect(screen.getByText("Let the new Device’s Agent install it")).toBeTruthy();
    await user.type(await screen.findByLabelText("Device ID"), "device_worker");
    await user.click(await screen.findByRole("button", { name: "Generate grant" }));

    await waitFor(() => {
      expect(api.issueEnrollmentGrant).toHaveBeenCalledWith({
        deviceId: "device_worker",
        expiresInSeconds: 300,
      });
    });
    expect(await screen.findByRole("heading", { name: "Grant ready to download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download grant file" })).toBeTruthy();
    expect(screen.getByText(/opendelegate worker join --grant-file/u)).toBeTruthy();
    expect(
      screen.getByText(
        formatMessage(englishMessages.join.agentPrompt, {
          filename: issued.suggestedFilename,
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Agent prompt" })).toBeTruthy();
    expect(screen.getByText(/appears in the left list/iu)).toBeTruthy();
    expect(document.body.textContent).not.toContain(issued.document.token);
    expect(screen.getByText(/downloaded file is a credential/iu)).toBeTruthy();
  });

  it("keeps each enrollment field with its own label and hint", async () => {
    const api = {
      deviceEnrollment: vi.fn().mockResolvedValue(enrollment),
      issueEnrollmentGrant: vi.fn().mockResolvedValue(issued),
    } satisfies Pick<AdminApi, "deviceEnrollment" | "issueEnrollmentGrant">;

    render(<JoinSurface api={api} />);

    // Both controls resolve through their own label, and the hint describes the
    // Device ID rather than drifting into the expiry field's cell.
    const deviceId = await screen.findByLabelText("Device ID");
    const expiry = screen.getByLabelText("Grant lifetime");
    expect(deviceId.tagName).toBe("INPUT");
    expect(expiry.tagName).toBe("SELECT");

    const hintId = deviceId.getAttribute("aria-describedby");
    expect(hintId).toBe("join-device-id-hint");
    expect(document.getElementById(hintId ?? "")?.textContent).toContain("stable ID");

    // Each field is one wrapper, so a label cannot be separated from its control.
    expect(deviceId.closest(".join-field")).not.toBeNull();
    expect(expiry.closest(".join-field")).not.toBeNull();
    expect(deviceId.closest(".join-field")).not.toBe(expiry.closest(".join-field"));
    expect(
      deviceId.closest(".join-field")?.querySelector("label[for='join-device-id']"),
    ).not.toBeNull();
    expect(expiry.closest(".join-field")?.querySelector("label[for='join-expiry']")).not.toBeNull();
  });

  it("inspects Artifact metadata and requests isolated-origin access without rendering HTML", async () => {
    const user = userEvent.setup();
    const api = {
      listArtifacts: vi.fn().mockResolvedValue([artifact]),
      getArtifact: vi.fn().mockResolvedValue(artifact),
      openArtifact: vi.fn().mockResolvedValue({
        method: "GET" as const,
        href: "https://static.artifacts.test/artifacts/artifact_report",
        artifactId: artifact.artifactId,
      }),
    } satisfies Pick<AdminApi, "listArtifacts" | "getArtifact" | "openArtifact">;

    render(<ArtifactSurface api={api} />);

    expect(await screen.findByRole("heading", { level: 1, name: "Artifacts" })).toBeTruthy();
    expect((await screen.findAllByText("release-report.html")).length).toBeGreaterThan(0);
    const inspector = screen.getByRole("complementary", {
      name: "Artifact details: release-report.html",
    });
    expect(within(inspector).getAllByText("text/html").length).toBeGreaterThan(0);
    expect(within(inspector).getByText(artifact.checksum.value)).toBeTruthy();
    expect(within(inspector).queryByRole("iframe")).toBeNull();

    await user.click(within(inspector).getByRole("button", { name: "Open Artifact" }));
    await waitFor(() => expect(api.openArtifact).toHaveBeenCalledWith(artifact.artifactId));
  });

  it("localizes deterministic Artifact exposure and presentation values", async () => {
    const api = {
      listArtifacts: vi.fn().mockResolvedValue([artifact]),
      getArtifact: vi.fn().mockResolvedValue(artifact),
      openArtifact: vi.fn(),
    } satisfies Pick<AdminApi, "listArtifacts" | "getArtifact" | "openArtifact">;

    render(
      <AdminI18nProvider initialLocale="ko">
        <ArtifactSurface api={api} />
      </AdminI18nProvider>,
    );

    expect(await screen.findByText(koreanMessages.artifact.exposureAuthenticated)).toBeTruthy();
    expect(screen.getByText(koreanMessages.artifact.presentationStaticHtml)).toBeTruthy();
    expect(screen.queryByText("authenticated")).toBeNull();
    expect(screen.queryByText("static-html")).toBeNull();
  });

  it("focuses the Artifact selected by a credential-free Discord deep link", async () => {
    const other = {
      ...artifact,
      artifactId: "artifact_other",
      originalFilename: "other-report.html",
      createdAt: "2026-07-25T01:00:00.000Z",
    };
    const api = {
      listArtifacts: vi.fn().mockResolvedValue([other, artifact]),
      getArtifact: vi.fn().mockResolvedValue(artifact),
      openArtifact: vi.fn(),
    } satisfies Pick<AdminApi, "listArtifacts" | "getArtifact" | "openArtifact">;

    render(<ArtifactSurface api={api} initialArtifactId={artifact.artifactId} />);

    expect(
      await screen.findByRole("complementary", {
        name: "Artifact details: release-report.html",
      }),
    ).toBeTruthy();
  });

  it("shows readiness and bounded Audit identifiers while filtering client-side", async () => {
    const user = userEvent.setup();
    const api = {
      listAuditEvents: vi
        .fn()
        .mockResolvedValue([auditEvent, routeDiagnosticEvent, actionAuthorizationEvent]),
      readiness: vi.fn().mockResolvedValue({
        status: "not-ready" as const,
        checks: [
          { status: "ready" as const, code: "DATABASE_READY" },
          { status: "not-ready" as const, code: "DISCORD_NOT_CONFIGURED" },
        ],
      }),
    } satisfies Pick<AdminApi, "listAuditEvents" | "readiness">;

    render(<AuditSurface api={api} />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Audit & diagnostics" }),
    ).toBeTruthy();
    expect(await screen.findByText("DISCORD_NOT_CONFIGURED")).toBeTruthy();
    expect(screen.getByText("artifact.stored")).toBeTruthy();
    expect(screen.getByText("correlation_001")).toBeTruthy();
    expect(screen.getByText("OWNER_DENIED")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Connection diagnosis" })).toBeTruthy();
    expect(
      screen.getByText("Check whether the private route is reachable from this Device."),
    ).toBeTruthy();
    expect(
      screen.getByText("Should OpenDelegate keep using the next configured route?"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("rawPayload");

    await user.type(screen.getByLabelText("Search Audit events"), "no-match");
    expect(await screen.findByText("No Audit events match this search.")).toBeTruthy();
    await user.clear(screen.getByLabelText("Search Audit events"));
    await user.type(screen.getByLabelText("Search Audit events"), "next configured route");
    expect(screen.getByRole("region", { name: "Connection diagnosis" })).toBeTruthy();
    await user.clear(screen.getByLabelText("Search Audit events"));
    await user.type(screen.getByLabelText("Search Audit events"), "OWNER_DENIED");
    expect(screen.getByText("worker.action.os-network-change.denied")).toBeTruthy();
  });
});
