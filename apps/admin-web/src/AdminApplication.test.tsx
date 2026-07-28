import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApplication } from "./AdminApplication";
import {
  AdminApiError,
  BrowserAdminApi,
  parseMainSecretReference,
  type AdminApi,
  type ApprovalDetail,
  type DeviceSummary,
  type OwnerSession,
  type RuntimeFeatures,
  type TaskBudgetSnapshot,
  type TaskDetail,
} from "./admin-api";
import { App } from "./App";
import { AdminI18nProvider } from "./i18n";
import { koreanMessages } from "./i18n/messages.ko";
import { firstRunDevice } from "./view-model";

const discordSetupRequest =
  "I may be setting up a Discord bot for the first time. Inspect the current binding and explain how Forum posts become OpenDelegate Tasks. Give me a short roadmap, then guide me through one remaining step at a time. For the current step, tell me where to go, what to do, why it is needed, how to verify it, and what I should send back; wait for my confirmation before continuing. Define unfamiliar terms and ask only for missing non-secret values. Never ask me to paste the bot token into chat; tell me when to use the secure token form.";

const ownerSession: OwnerSession = {
  sessionId: "session_owner_browser",
  ownerId: "owner_primary",
  createdAt: "2026-07-24T01:00:00.000Z",
  authenticatedAt: "2026-07-24T01:00:00.000Z",
  lastUsedAt: "2026-07-24T01:00:00.000Z",
  idleExpiresAt: "2026-07-24T02:00:00.000Z",
  absoluteExpiresAt: "2026-07-25T01:00:00.000Z",
};

const runningTask: TaskDetail = {
  taskId: "task_prepare_release",
  state: "running",
  mode: "auto",
  objective: "Prepare the first milestone release",
  createdAt: "2026-07-24T01:30:00.000Z",
  updatedAt: "2026-07-24T01:32:00.000Z",
  version: 1,
  completionCriteria: ["All automated tests pass", "Release artifacts are published"],
  constraints: ["Do not waive platform acceptance"],
  selectedInputRefs: [],
  messages: [
    {
      messageId: "event_task_owner_input",
      role: "owner",
      content: "Keep the owner-authored release note exactly as written.",
      occurredAt: "2026-07-24T01:30:30.000Z",
    },
    {
      messageId: "event_task_agent_update",
      role: "agent",
      content: "The release checks are running.",
      occurredAt: "2026-07-24T01:31:00.000Z",
    },
  ],
  events: [
    {
      eventId: "event_task_created",
      type: "task.created",
      occurredAt: "2026-07-24T01:30:00.000Z",
      streamVersion: 1,
    },
  ],
};

const pausedTask: TaskDetail = {
  ...runningTask,
  state: "paused",
  updatedAt: "2026-07-24T01:35:00.000Z",
  version: 2,
  events: [
    ...runningTask.events,
    {
      eventId: "event_task_paused",
      type: "task.commanded",
      occurredAt: "2026-07-24T01:35:00.000Z",
      streamVersion: 2,
    },
  ],
};

const runningTaskBudget: TaskBudgetSnapshot = {
  schemaVersion: 1,
  taskId: runningTask.taskId,
  kind: "requested",
  revision: 3,
  createdAt: "2026-07-24T01:30:00.000Z",
  lastActivityAt: "2026-07-24T01:33:00.000Z",
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
  usage: {
    wallTimeMs: 1_200_000,
    idleTimeMs: 20_000,
    retries: 1,
    childWorkOrders: 4,
    concurrentRuns: 1,
    nativeTurns: 8,
    tokens: 210_000,
    costUsdMicros: 2_500_000,
  },
  workOrders: [],
  activeRunIds: ["run_release_checks"],
  limitEvents: [
    {
      eventId: "budget_event_tokens_soft",
      metric: "tokens",
      state: "soft-limit",
      current: 210_000,
      attempted: 210_000,
      hard: 250_000,
      occurredAt: "2026-07-24T01:33:00.000Z",
    },
  ],
  extensions: [],
  omitted: {
    workOrders: 0,
    activeRunIds: 0,
    limitEvents: 0,
    extensions: 0,
  },
};

const pendingApproval: ApprovalDetail = {
  approvalId: "approval_configuration_001",
  state: "pending",
  executionStatus: "waiting",
  requestedAt: "2026-07-24T01:36:00.000Z",
  expiresAt: "2026-07-25T01:36:00.000Z",
  action: {
    category: "policy-relaxation",
    type: "configuration.apply",
    fingerprint: `sha256:${"b".repeat(64)}`,
    targetDeviceId: "device_windows_main",
    resource: "configuration-proposal:proposal_approval_001",
  },
  reason: "Enable the verified Computer Use capability.",
  target: "windows-main",
  risk: "high",
  evidence: ["Computer Use was detected and verified."],
};

const windowsMain: DeviceSummary = {
  deviceId: "device_windows_main",
  name: "windows-main",
  osFamily: "windows",
  platformRelease: "10.0.26200",
  architecture: "x64",
  role: "main",
  connection: "online",
  runtime: "healthy",
  serviceMode: "foreground",
};

const assessedWindowsMain: DeviceSummary = {
  ...windowsMain,
  lastObservation: {
    observedAtMs: 1_753_000_000_000,
    acceptedAtMs: 1_753_000_000_000,
    source: "local-assessment",
  },
  capabilities: [
    { name: "browser-automation", verification: "detected" },
    { name: "claude-code", verification: "degraded" },
    { name: "codex", verification: "verified" },
    { name: "computer-use", verification: "unavailable" },
  ],
  agentAdapters: [
    {
      provider: "codex",
      adapterId: "codex-app-server",
      readiness: "ready",
      compatibility: "tested",
      version: "0.145.0",
      observedAtMs: 1_753_000_000_000,
    },
  ],
  knowledgeHealth: "healthy",
};

const macosWorker: DeviceSummary = {
  deviceId: "device_macos_worker",
  name: "Design Mac — owner label",
  osFamily: "macos",
  platformRelease: "15.5",
  architecture: "arm64",
  role: "worker",
  connection: "online",
  runtime: "healthy",
  serviceMode: "user-service",
};

const windowsWorker: DeviceSummary = {
  deviceId: "device_windows_worker",
  name: "Windows Build Rig",
  osFamily: "windows",
  platformRelease: "11 24H2",
  architecture: "x64",
  role: "worker",
  connection: "offline",
  runtime: "unavailable",
  serviceMode: "system-service",
};

const linuxWorker: DeviceSummary = {
  deviceId: "device_linux_worker",
  name: "NAS 工作站",
  osFamily: "linux",
  platformRelease: "6.12.31",
  architecture: "x86_64",
  role: "worker",
  connection: "online",
  runtime: "degraded",
  serviceMode: "system-service",
  roles: ["Storage maintenance"],
  instructions: ["Keep owner-authored mount labels unchanged."],
  capabilities: [
    { name: "codex", verification: "verified" },
    { name: "computer-use", verification: "unavailable" },
    { name: "container-build", verification: "detected" },
  ],
  routes: [
    {
      routeId: "omada-main",
      label: "Omada VPN",
      priority: 0,
      health: "degraded",
    },
  ],
  capacity: {
    activeRuns: 2,
    maximumConcurrentRuns: 4,
    acceptingWork: true,
  },
  knowledgeHealth: "healthy",
};

const discordUnconfiguredFeatures: RuntimeFeatures = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
  taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
  configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
  discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
};

const connectedFeatures: RuntimeFeatures = {
  ...discordUnconfiguredFeatures,
  discord: { status: "ready", code: "DISCORD_READY" },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.lang = "en";
});

describe("Admin authentication and Task control", () => {
  it("treats a malformed JSON 401 from Main as signed-out without exposing its body", async () => {
    const privateSentinel = "PRIVATE_SIGNED_OUT_SENTINEL";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`{"private":"${privateSentinel}"`, {
          status: 401,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );

    render(<AdminApplication api={new BrowserAdminApi()} />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenDelegate" })).toBeTruthy();
    expect(screen.getByText("Release status is verified after sign-in.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Admin is temporarily unavailable" })).toBeNull();
    expect(document.body.textContent).not.toContain(privateSentinel);
  });

  it("keeps the signed-out boundary in front of Tasks and signs in through the real API seam", async () => {
    const api = createApi({
      session: vi
        .fn<AdminApi["session"]>()
        .mockRejectedValue(
          new AdminApiError(401, "AUTHENTICATION_REQUIRED", "Owner authentication is required."),
        ),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenDelegate" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Tasks" })).toBeNull();

    await user.type(screen.getByLabelText("Owner passphrase"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect((await screen.findAllByText(runningTask.objective)).length).toBeGreaterThan(0);
    expect(api.login).toHaveBeenCalledWith("correct horse battery staple");
  });

  it("opens the authenticated Approvals surface instead of a disabled placeholder", async () => {
    const api = createApi({
      listApprovals: vi.fn<AdminApi["listApprovals"]>().mockResolvedValue([pendingApproval]),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    const approvals = screen.getByRole("button", { name: "Approvals" });
    expect((approvals as HTMLButtonElement).disabled).toBe(false);
    await user.click(approvals);

    expect(await screen.findByRole("heading", { level: 1, name: "Approvals" })).toBeTruthy();
    expect(screen.getByText("Enable the verified Computer Use capability.")).toBeTruthy();
    expect(api.listApprovals).toHaveBeenCalledTimes(1);
  });

  it("keeps Join, Artifacts, and Audit available as authenticated owner operations", async () => {
    const api = createApi({
      deviceEnrollment: vi.fn<AdminApi["deviceEnrollment"]>().mockResolvedValue({
        available: true,
        mainDeviceId: windowsMain.deviceId,
        grants: [],
      }),
      listArtifacts: vi.fn<AdminApi["listArtifacts"]>().mockResolvedValue([]),
      listAuditEvents: vi.fn<AdminApi["listAuditEvents"]>().mockResolvedValue([]),
      readiness: vi.fn<AdminApi["readiness"]>().mockResolvedValue({
        status: "ready",
        checks: [{ status: "ready", code: "DATABASE_READY" }],
      }),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    const artifacts = screen.getByRole("button", { name: "Artifacts" });
    const audit = screen.getByRole("button", { name: "Audit" });
    const join = screen.getByRole("button", { name: "Add Device" });
    for (const control of [artifacts, audit, join]) {
      expect((control as HTMLButtonElement).disabled).toBe(false);
    }

    await user.click(artifacts);
    expect(await screen.findByRole("heading", { level: 1, name: "Artifacts" })).toBeTruthy();
    expect(await screen.findByText("No Artifacts yet")).toBeTruthy();

    await user.click(audit);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Audit & diagnostics" }),
    ).toBeTruthy();
    expect(await screen.findByText("DATABASE_READY")).toBeTruthy();

    await user.click(join);
    expect(await screen.findByRole("heading", { level: 1, name: "Add a Device" })).toBeTruthy();
    expect(await screen.findByText("Secure join flow")).toBeTruthy();
  });

  it("routes Configuration Chat to the selected Device without translating owner content", async () => {
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValue({
        content: "Agent-authored response stays unchanged.",
        suggestedActions: [],
      });
    const api = createApi({ sendConfigurationMessage });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    const composer = screen.getByRole("textbox", { name: "Message Configuration Chat" });
    await user.type(composer, "Keep 이 owner-authored text unchanged.");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Agent-authored response stays unchanged.")).toBeTruthy();
    expect(sendConfigurationMessage).toHaveBeenCalledWith(
      windowsMain.deviceId,
      "Keep 이 owner-authored text unchanged.",
    );
  });

  it("starts Agent-guided Discord onboarding once when Main reports no binding", async () => {
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValue({
        content: "Discord is not connected. I inspected the binding and can guide setup.",
        suggestedActions: ["guide-discord"],
      });
    const api = createApi({
      runtimeFeatures: vi
        .fn<AdminApi["runtimeFeatures"]>()
        .mockResolvedValue(discordUnconfiguredFeatures),
      sendConfigurationMessage,
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    expect(sendConfigurationMessage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Configure" }));

    expect(
      await screen.findByText(
        "Discord is not connected yet. I’m checking the current binding and preparing setup guidance.",
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(sendConfigurationMessage).toHaveBeenCalledWith(
        windowsMain.deviceId,
        discordSetupRequest,
      ),
    );
    expect(
      await screen.findByText(
        "Discord is not connected. I inspected the binding and can guide setup.",
      ),
    ).toBeTruthy();
    const agentMessages = screen.getAllByRole("article", { name: "OpenDelegate" });
    expect(
      within(agentMessages.at(-1)!).getByRole("button", {
        name: "Set up or review Discord",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close Configuration Chat" }));
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(sendConfigurationMessage).toHaveBeenCalledTimes(1);
  });

  it("retries initial Discord guidance on the next open after an Agent failure", async () => {
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockRejectedValueOnce(new Error("Configuration Agent fixture failure."))
      .mockResolvedValueOnce({
        content: "Discord guidance recovered on the next open.",
        suggestedActions: ["guide-discord"],
      });
    const api = createApi({
      runtimeFeatures: vi
        .fn<AdminApi["runtimeFeatures"]>()
        .mockResolvedValue(discordUnconfiguredFeatures),
      sendConfigurationMessage,
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(
      await screen.findByText(
        "The local Configuration Agent was unavailable or interrupted. OpenDelegate did not replay an uncertain setup action. Completed changes remain durable; inspect the current settings, then try again.",
      ),
    ).toBeTruthy();
    expect(sendConfigurationMessage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close Configuration Chat" }));
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(await screen.findByText("Discord guidance recovered on the next open.")).toBeTruthy();
    expect(sendConfigurationMessage).toHaveBeenCalledTimes(2);
  });

  it("stores a database URI through secure ingest and sends only its reference to Configuration Chat", async () => {
    const rawDatabaseUri = "postgresql://owner:must-not-enter-chat@database.test/main";
    let observedMaterial = "";
    const ingestSecret = vi
      .fn<AdminApi["ingestSecret"]>()
      .mockImplementation(async (_purpose, secret) => {
        observedMaterial = new TextDecoder().decode(secret);
        return {
          schemaVersion: 1,
          secretRef: parseMainSecretReference("secret://main/database_secure_fixture"),
          availability: "ready",
        };
      });
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValueOnce({
        content: "The database URI is the next missing value.",
        suggestedActions: ["ingest-database-uri"],
      })
      .mockResolvedValueOnce({
        content: "The secure reference is ready for owner review.",
        suggestedActions: [],
      });
    const api = createApi({ ingestSecret, sendConfigurationMessage });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.queryByLabelText("Database URI")).toBeNull();
    expect(screen.queryByRole("button", { name: "External PostgreSQL credential" })).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "Help me configure external PostgreSQL.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("The database URI is the next missing value.")).toBeTruthy();
    const agentMessages = screen.getAllByRole("article", { name: "OpenDelegate" });
    const contextualAction = within(agentMessages.at(-1)!).getByRole("button", {
      name: "External PostgreSQL credential",
    });
    await user.click(contextualAction);
    const input = screen.getByLabelText("Database URI") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.type(input, rawDatabaseUri);
    await user.click(screen.getByRole("button", { name: "Store securely" }));

    expect(await screen.findByText("The secure reference is ready for owner review.")).toBeTruthy();
    expect(observedMaterial).toBe(rawDatabaseUri);
    expect(ingestSecret.mock.calls[0]?.[0]).toBe("database-uri");
    const scopedBytes = ingestSecret.mock.calls[0]?.[1];
    expect(ArrayBuffer.isView(scopedBytes)).toBe(true);
    expect(scopedBytes?.every((byte) => byte === 0)).toBe(true);
    expect(sendConfigurationMessage).toHaveBeenCalledWith(
      windowsMain.deviceId,
      "Use this secure database reference: secret://main/database_secure_fixture",
    );
    expect(sendConfigurationMessage).toHaveBeenNthCalledWith(
      1,
      windowsMain.deviceId,
      "Help me configure external PostgreSQL.",
    );
    expect(
      sendConfigurationMessage.mock.calls.every(
        ([, message]) => !message.includes("must-not-enter-chat"),
      ),
    ).toBe(true);
    expect(input.value).toBe("");
    expect(
      screen.getByText("Stored locally as secret://main/database_secure_fixture"),
    ).toBeTruthy();
  });

  it("stores a Discord bot token through secure ingest and sends only its alias reference to Configuration Chat", async () => {
    const rawToken = "discord.bot.token.must-not-enter-chat";
    let observedMaterial = "";
    const ingestSecret = vi
      .fn<AdminApi["ingestSecret"]>()
      .mockImplementation(async (_purpose, secret) => {
        observedMaterial = new TextDecoder().decode(secret);
        return {
          schemaVersion: 1,
          secretRef: parseMainSecretReference("secret://main/discord_secure_fixture"),
          availability: "ready",
        };
      });
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValueOnce({
        content: "Discord setup is available.",
        suggestedActions: ["guide-discord"],
      })
      .mockResolvedValueOnce({
        content: "The bot token is now the next missing value.",
        suggestedActions: ["ingest-discord-bot-token"],
      })
      .mockResolvedValueOnce({
        content: "The Discord credential alias is ready for binding setup.",
        suggestedActions: [],
      });
    const api = createApi({ ingestSecret, sendConfigurationMessage });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.queryByLabelText("Discord bot token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up or review Discord" })).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "Help me set up Discord.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(await screen.findByRole("button", { name: "Set up or review Discord" }));
    await user.click(
      await screen.findByRole("button", { name: "Store the Discord token securely" }),
    );
    const input = screen.getByLabelText("Discord bot token") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.type(input, rawToken);
    await user.click(screen.getByRole("button", { name: "Store securely" }));

    expect(
      await screen.findByText("The Discord credential alias is ready for binding setup."),
    ).toBeTruthy();
    expect(observedMaterial).toBe(rawToken);
    expect(ingestSecret.mock.calls[0]?.[0]).toBe("discord-bot-token");
    expect(ingestSecret.mock.calls[0]?.[1]?.every((byte) => byte === 0)).toBe(true);
    expect(sendConfigurationMessage).toHaveBeenNthCalledWith(
      1,
      windowsMain.deviceId,
      "Help me set up Discord.",
    );
    expect(sendConfigurationMessage).toHaveBeenNthCalledWith(
      2,
      windowsMain.deviceId,
      discordSetupRequest,
    );
    expect(sendConfigurationMessage).toHaveBeenNthCalledWith(
      3,
      windowsMain.deviceId,
      "Use this secure Discord bot token reference: secret://main/discord_secure_fixture. Its botTokenAlias is discord_secure_fixture.",
    );
    expect(
      sendConfigurationMessage.mock.calls.every(([, message]) => !message.includes(rawToken)),
    ).toBe(true);
    expect(input.value).toBe("");
  });

  it("clears an unsubmitted secure credential when Configuration Chat closes", async () => {
    const sendConfigurationMessage = vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValue({
        content: "Use secure intake for the token.",
        suggestedActions: ["ingest-discord-bot-token"],
      });
    const user = userEvent.setup();
    render(<AdminApplication api={createApi({ sendConfigurationMessage })} />);

    expect(await screen.findByRole("heading", { name: "windows-main" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Configure" }));
    await user.type(
      screen.getByRole("textbox", { name: "Message Configuration Chat" }),
      "I am ready to enter the Discord bot token.",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(
      await screen.findByRole("button", { name: "Store the Discord token securely" }),
    );
    await user.type(screen.getByLabelText("Discord bot token"), "unsubmitted.discord.token");
    await user.click(screen.getByRole("button", { name: "Close Configuration Chat" }));

    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.queryByLabelText("Discord bot token")).toBeNull();
  });

  it("re-renders a deterministic authentication error when the locale changes", async () => {
    const api = createApi({
      session: vi
        .fn<AdminApi["session"]>()
        .mockRejectedValue(
          new AdminApiError(401, "AUTHENTICATION_REQUIRED", "Owner authentication is required."),
        ),
      login: vi
        .fn<AdminApi["login"]>()
        .mockRejectedValue(new AdminApiError(429, "RATE_LIMITED", "Raw server detail.")),
    });
    const user = userEvent.setup();
    render(
      <AdminI18nProvider initialLocale="en">
        <AdminApplication api={api} />
      </AdminI18nProvider>,
    );

    await user.type(await screen.findByLabelText("Owner passphrase"), "incorrect passphrase");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("Too many attempts. Wait a moment before trying again."),
    ).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Language"), "ko");
    expect(await screen.findByText(koreanMessages.auth.rateLimited)).toBeTruthy();
    expect(screen.queryByText("Raw server detail.")).toBeNull();
  });

  it("completes Discord-independent recovery and requires the new codes to be acknowledged", async () => {
    const recoveryCodes = Array.from(
      { length: 10 },
      (_, index) => `odr_${String(index).padStart(22, "a")}`,
    );
    const api = createApi({
      session: vi
        .fn<AdminApi["session"]>()
        .mockRejectedValue(
          new AdminApiError(401, "AUTHENTICATION_REQUIRED", "Owner authentication is required."),
        ),
      beginRecovery: vi.fn<AdminApi["beginRecovery"]>().mockResolvedValue({
        recoveryToken: "r".repeat(43),
      }),
      completeRecovery: vi.fn<AdminApi["completeRecovery"]>().mockResolvedValue({
        ownerId: "owner_primary",
        recoveryCodes,
      }),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    await user.click(await screen.findByRole("button", { name: "Use a recovery code" }));
    await user.type(screen.getByLabelText("Recovery code"), `odr_${"z".repeat(22)}`);
    await user.type(screen.getByLabelText("New owner passphrase"), "a new owner passphrase");
    await user.type(screen.getByLabelText("Confirm new passphrase"), "a new owner passphrase");
    await user.click(screen.getByRole("button", { name: "Recover access" }));

    expect(
      await screen.findByRole("heading", { name: "Save your new recovery codes" }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "New recovery codes" })).getAllByRole("listitem"),
    ).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: "I saved the codes" }));
    expect(screen.getByRole("heading", { name: "Sign in to OpenDelegate" })).toBeTruthy();
  });

  it("loads canonical Task state and sends a state-valid command with no Discord dependency", async () => {
    const api = createApi({
      commandTask: vi.fn<AdminApi["commandTask"]>().mockResolvedValue(pausedTask),
    });
    const user = userEvent.setup();
    render(
      <App
        api={api}
        configurationAgentAvailable
        deviceFleet={{ devices: [firstRunDevice], mainDeviceId: firstRunDevice.deviceId }}
        executionAvailable
        initialSection="tasks"
      />,
    );

    expect(
      await screen.findByText("Discord is not configured. Task control remains available here."),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: runningTask.objective })).toBeTruthy();
    expect(
      screen.getByText("Keep the owner-authored release note exactly as written."),
    ).toBeTruthy();
    expect(screen.getByText("The release checks are running.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());
    expect(api.commandTask).toHaveBeenCalledWith(runningTask.taskId, "pause");
  });

  it("loads the authenticated Main Device without inventing capability or desktop state", async () => {
    const assessDevice = vi.fn<AdminApi["assessDevice"]>().mockResolvedValue(assessedWindowsMain);
    const api = createApi({
      assessDevice,
      listDevices: vi.fn<AdminApi["listDevices"]>().mockResolvedValue([windowsMain]),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "windows-main, Main, Online",
      }),
    );

    expect(screen.getByRole("heading", { level: 1, name: "windows-main" })).toBeTruthy();
    expect(screen.getByLabelText("Main computer · Windows 10.0.26200 · Online")).toBeTruthy();
    expect(screen.getByText("x64")).toBeTruthy();
    expect(screen.getByText("Main Coordinator")).toBeTruthy();
    expect(screen.getByText("Not configured (foreground)")).toBeTruthy();
    expect(screen.getByText("Run projection not connected")).toBeTruthy();
    expect(screen.getAllByText("Not assessed")).toHaveLength(5);
    expect(screen.queryByText("Mac Studio")).toBeNull();
    expect(screen.queryByText("Apple silicon")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Assess device" }));
    await waitFor(() => expect(assessDevice).toHaveBeenCalledWith(windowsMain.deviceId));
    expect(await screen.findByText("Local Agent setup")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Configure" }));
    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(
      within(chat).getByText(
        "Device assessment is current. I can now explain the observed Codex, Claude, browser automation, Computer Use, and local Knowledge status and help you propose Roles or Instructions. Provider credentials must stay out of messages.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(chat).getByRole("textbox", {
          name: "Message Configuration Chat",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(within(chat).queryByRole("region", { name: "Proposed change" })).toBeNull();
    expect(api.listDevices).toHaveBeenCalledOnce();
  });

  it("keeps the fixed Main first and renders every enrolled Worker through keyboard selection", async () => {
    const api = createApi({
      listDevices: vi
        .fn<AdminApi["listDevices"]>()
        .mockResolvedValue([linuxWorker, windowsWorker, windowsMain, macosWorker]),
    });
    const user = userEvent.setup();
    render(
      <AdminI18nProvider initialLocale="en">
        <AdminApplication api={api} />
      </AdminI18nProvider>,
    );

    const deviceList = await screen.findByRole("list", { name: "Devices" });
    const deviceButtons = within(deviceList).getAllByRole("button");
    expect(deviceButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "windows-main, Main, Online",
      "NAS 工作站, Worker, Online",
      "Windows Build Rig, Worker, Offline",
      "Design Mac — owner label, Worker, Online",
    ]);
    expect(deviceButtons[0]?.getAttribute("aria-current")).toBe("page");

    const macosButton = within(deviceList).getByRole("button", {
      name: "Design Mac — owner label, Worker, Online",
    });
    macosButton.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("heading", { level: 1, name: "Design Mac — owner label" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Worker computer · macOS 15.5 · Online")).toBeTruthy();
    expect(screen.getByText("arm64")).toBeTruthy();
    expect(screen.getByText("Configured (user service)")).toBeTruthy();
    expect(screen.queryByText("Main Coordinator")).toBeNull();
    expect(screen.queryByText("Loopback")).toBeNull();
    expect(macosButton.getAttribute("aria-current")).toBe("page");

    await user.selectOptions(screen.getByLabelText("Language"), "ko");
    expect(screen.getByRole("heading", { name: "Design Mac — owner label" })).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: koreanMessages.navigation.devices })).getByRole(
        "button",
        {
          name: `Design Mac — owner label, ${koreanMessages.known.worker}, ${koreanMessages.known.online}`,
        },
      ),
    ).toBeTruthy();
  });

  it("projects authenticated Worker scheduling metadata into operational Device tabs", async () => {
    const api = createApi({
      listDevices: vi.fn<AdminApi["listDevices"]>().mockResolvedValue([windowsMain, linuxWorker]),
    });
    const user = userEvent.setup();
    render(
      <AdminI18nProvider initialLocale="en">
        <AdminApplication api={api} />
      </AdminI18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "NAS 工作站, Worker, Online" }));
    expect(screen.getByText("Storage maintenance")).toBeTruthy();
    expect(screen.getByText("Keep owner-authored mount labels unchanged.")).toBeTruthy();
    expect(screen.getByText("2 active Runs")).toBeTruthy();
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("tab", { name: "Capabilities" }));
    expect(screen.getByText("container-build")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Routes" }));
    expect(screen.getByText("Omada VPN")).toBeTruthy();
    expect(screen.getByText("Degraded · Priority 1")).toBeTruthy();
  });

  it.each([
    ["no Main", [linuxWorker]],
    ["more than one Main", [windowsMain, { ...windowsMain, deviceId: "device_second_main" }]],
  ])("rejects a Device collection with %s", async (_case, devices) => {
    const api = createApi({
      listDevices: vi.fn<AdminApi["listDevices"]>().mockResolvedValue(devices),
    });

    render(<AdminApplication api={api} />);

    expect(
      await screen.findByText("OpenDelegate Main did not return exactly one fixed Main Device."),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Devices" })).toBeNull();
  });

  it("disables agent-shaped actions when Main reports that production runtimes are unavailable", async () => {
    const api = createApi({
      getTask: vi.fn<AdminApi["getTask"]>().mockResolvedValue(pausedTask),
      listTasks: vi.fn<AdminApi["listTasks"]>().mockResolvedValue([pausedTask]),
      runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue({
        declaredReleaseChannel: "internal-preview",
        releaseChannel: "internal-preview",
        releaseVerification: { status: "not-applicable" },
        taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
        configurationAgent: {
          status: "unavailable",
          code: "CONFIGURATION_AGENT_NOT_CONNECTED",
        },
        discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
      }),
    });
    const user = userEvent.setup();
    render(<AdminApplication api={api} />);

    expect(await screen.findByText("Unsupported internal preview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    expect((screen.getByRole("button", { name: "New task" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText(
        "Main reports that Agent execution is not ready. Existing Task records remain inspectable, but new work cannot start.",
      ),
    ).toBeTruthy();
    expect(
      ((await screen.findByRole("button", { name: "Resume" })) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "windows-main, Main, Online" }));
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message Configuration Chat",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("shows a sanitized warning when external release verification is invalid", async () => {
    const api = createApi({
      runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue({
        declaredReleaseChannel: "release-candidate",
        releaseChannel: "release-candidate",
        releaseVerification: {
          status: "promotion-invalid",
          code: "PROMOTION_TRUST_INVALID",
        },
        taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
        configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
        discord: { status: "ready", code: "DISCORD_READY" },
      }),
    });

    render(<AdminApplication api={api} />);

    expect(await screen.findByText("Unpromoted release candidate")).toBeTruthy();
    expect(
      screen.getByText(
        "Publisher verification may have succeeded, but the promotion and supported-channel receipt chain did not verify. Main has kept this installation at release-candidate status.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("PROMOTION_TRUST_INVALID")).toBeNull();
  });

  it("distinguishes revoked release authority without exposing verifier internals", async () => {
    const api = createApi({
      runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue({
        declaredReleaseChannel: "release-candidate",
        releaseChannel: "release-candidate",
        releaseVerification: {
          status: "revoked",
          code: "RELEASE_REVOKED",
        },
        taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
        configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
        discord: { status: "ready", code: "DISCORD_READY" },
      }),
    });

    render(<AdminApplication api={api} />);

    expect(
      await screen.findByText(
        "Release authority for this candidate has been revoked. Main has kept this installation at release-candidate status.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("RELEASE_REVOKED")).toBeNull();
  });

  it("states verified release authority without an unresolved support disclaimer", async () => {
    const api = createApi({
      runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue({
        declaredReleaseChannel: "release-candidate",
        releaseChannel: "released",
        releaseVerification: { status: "released" },
        taskExecution: { status: "unavailable", code: "ORCHESTRATION_NOT_CONNECTED" },
        configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
        discord: { status: "ready", code: "DISCORD_READY" },
      }),
    });

    render(<AdminApplication api={api} />);

    expect(
      await screen.findByText(
        "The complete external publisher, platform-authenticity, promotion, and supported-channel chain is verified for this installation.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/support status still depends/iu)).toBeNull();
  });
});

function createApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    session: vi.fn<AdminApi["session"]>().mockResolvedValue(ownerSession),
    login: vi.fn<AdminApi["login"]>().mockResolvedValue(ownerSession),
    beginRecovery: vi.fn<AdminApi["beginRecovery"]>(),
    completeRecovery: vi.fn<AdminApi["completeRecovery"]>(),
    listDevices: vi.fn<AdminApi["listDevices"]>().mockResolvedValue([windowsMain]),
    assessDevice: vi.fn<AdminApi["assessDevice"]>().mockResolvedValue(windowsMain),
    runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue(connectedFeatures),
    sendConfigurationMessage: vi
      .fn<AdminApi["sendConfigurationMessage"]>()
      .mockResolvedValue({ content: "Configuration response.", suggestedActions: [] }),
    ingestSecret: vi.fn<AdminApi["ingestSecret"]>().mockResolvedValue({
      schemaVersion: 1,
      secretRef: parseMainSecretReference("secret://main/database_fixture"),
      availability: "ready",
    }),
    listTasks: vi.fn<AdminApi["listTasks"]>().mockResolvedValue([runningTask]),
    getTask: vi.fn<AdminApi["getTask"]>().mockResolvedValue(runningTask),
    getTaskBudget: vi.fn<AdminApi["getTaskBudget"]>().mockResolvedValue(runningTaskBudget),
    extendTaskBudget: vi.fn<AdminApi["extendTaskBudget"]>().mockResolvedValue(runningTaskBudget),
    createTask: vi.fn<AdminApi["createTask"]>(),
    commandTask: vi.fn<AdminApi["commandTask"]>().mockResolvedValue(runningTask),
    listApprovals: vi.fn<AdminApi["listApprovals"]>().mockResolvedValue([]),
    getApproval: vi.fn<AdminApi["getApproval"]>(),
    decideApproval: vi.fn<AdminApi["decideApproval"]>(),
    deviceEnrollment: vi.fn<AdminApi["deviceEnrollment"]>().mockResolvedValue({
      available: false,
      grants: [],
    }),
    issueEnrollmentGrant: vi.fn<AdminApi["issueEnrollmentGrant"]>(),
    listArtifacts: vi.fn<AdminApi["listArtifacts"]>().mockResolvedValue([]),
    getArtifact: vi.fn<AdminApi["getArtifact"]>(),
    openArtifact: vi.fn<AdminApi["openArtifact"]>(),
    listAuditEvents: vi.fn<AdminApi["listAuditEvents"]>().mockResolvedValue([]),
    readiness: vi.fn<AdminApi["readiness"]>().mockResolvedValue({
      status: "not-ready",
      checks: [],
    }),
    ...overrides,
  };
}
