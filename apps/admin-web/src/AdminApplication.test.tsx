import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminApplication } from "./AdminApplication";
import {
  AdminApiError,
  BrowserAdminApi,
  type AdminApi,
  type DeviceSummary,
  type OwnerSession,
  type RuntimeFeatures,
  type TaskDetail,
} from "./admin-api";
import { App } from "./App";
import { firstRunDevice } from "./view-model";

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

const readyFeatures: RuntimeFeatures = {
  releaseChannel: "development",
  taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
  configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
  discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
};

afterEach(() => {
  vi.unstubAllGlobals();
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
        device={firstRunDevice}
        executionAvailable
        initialSection="tasks"
      />,
    );

    expect(
      await screen.findByText("Discord is not configured. Task control remains available here."),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: runningTask.objective })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy());
    expect(api.commandTask).toHaveBeenCalledWith(runningTask.taskId, "pause");
  });

  it("loads the authenticated Main Device without inventing capability or desktop state", async () => {
    const api = createApi({
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

    await user.click(screen.getByRole("button", { name: "Configure" }));
    const chat = screen.getByRole("dialog", { name: "Configuration Chat" });
    expect(
      within(chat).getByText(
        "Device assessment and Configuration Agent messaging are not connected in this build. The visible Device facts come only from Main's deterministic runtime report.",
      ),
    ).toBeTruthy();
    expect(within(chat).queryByRole("region", { name: "Proposed change" })).toBeNull();
    expect(api.listDevices).toHaveBeenCalledOnce();
  });

  it("disables agent-shaped actions when Main reports that production runtimes are unavailable", async () => {
    const api = createApi({
      getTask: vi.fn<AdminApi["getTask"]>().mockResolvedValue(pausedTask),
      listTasks: vi.fn<AdminApi["listTasks"]>().mockResolvedValue([pausedTask]),
      runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue({
        releaseChannel: "internal-preview",
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
        "Agent execution is not connected. Existing Task records remain inspectable, but new work cannot start.",
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
});

function createApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    session: vi.fn<AdminApi["session"]>().mockResolvedValue(ownerSession),
    login: vi.fn<AdminApi["login"]>().mockResolvedValue(ownerSession),
    beginRecovery: vi.fn<AdminApi["beginRecovery"]>(),
    completeRecovery: vi.fn<AdminApi["completeRecovery"]>(),
    listDevices: vi.fn<AdminApi["listDevices"]>().mockResolvedValue([windowsMain]),
    runtimeFeatures: vi.fn<AdminApi["runtimeFeatures"]>().mockResolvedValue(readyFeatures),
    listTasks: vi.fn<AdminApi["listTasks"]>().mockResolvedValue([runningTask]),
    getTask: vi.fn<AdminApi["getTask"]>().mockResolvedValue(runningTask),
    createTask: vi.fn<AdminApi["createTask"]>(),
    commandTask: vi.fn<AdminApi["commandTask"]>().mockResolvedValue(runningTask),
    ...overrides,
  };
}
