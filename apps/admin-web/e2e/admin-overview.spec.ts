import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const session = {
  csrfToken: "c".repeat(43),
  session: {
    sessionId: "session_owner_browser",
    ownerId: "owner_primary",
    createdAt: "2026-07-24T01:00:00.000Z",
    authenticatedAt: "2026-07-24T01:00:00.000Z",
    lastUsedAt: "2026-07-24T01:00:00.000Z",
    idleExpiresAt: "2026-07-24T02:00:00.000Z",
    absoluteExpiresAt: "2026-07-25T01:00:00.000Z",
  },
};

const mainDevice = {
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

const runningTask = {
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

test("signed-out Admin is a focused, Discord-independent recovery boundary", async ({ page }) => {
  await installApi(page, { signedIn: false });
  await page.goto("/");

  await expect(page).toHaveTitle("OpenDelegate");
  await expect(page.getByRole("heading", { name: "Sign in to OpenDelegate" })).toBeVisible();
  await expect(page.getByLabel("Owner passphrase")).toBeFocused();
  await expect(page.getByText("Discord is not required for Admin recovery.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tasks" })).toHaveCount(0);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("authenticated Admin lists and controls canonical Tasks without Discord", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, { signedIn: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(
    page.getByText("Discord is not configured. Task control remains available here."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: runningTask.objective, exact: true }),
  ).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 819) {
    await page.getByRole("button", { name: runningTask.objective, exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: runningTask.objective })).toBeVisible();

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  if ((page.viewportSize()?.width ?? 0) <= 819) {
    await page.getByRole("button", { name: "Close Task details" }).click();
  }

  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "What should OpenDelegate accomplish?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Objective")).toBeFocused();
  await dialog.getByRole("button", { name: "Close new Task" }).click();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("Device configuration remains isolated from Task conversations", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, { signedIn: true });
  await page.goto("/");

  await page.getByRole("button", { name: "windows-main, Main, Online" }).click();
  await expect(page.getByRole("heading", { name: "windows-main" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Device facts" }).getByText("Windows 10.0.26200"),
  ).toBeVisible();
  await expect(page.getByText("Not configured (foreground)")).toBeVisible();
  await expect(page.getByText("Run projection not connected")).toBeVisible();
  await expect(page.getByText("Mac Studio")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Configuration Chat" })).toHaveCount(0);

  await page.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog", { name: "Configuration Chat" });
  const composer = page.getByRole("textbox", { name: "Message Configuration Chat" });
  await expect(dialog).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close Configuration Chat" })).toBeFocused();
  await expect(
    dialog.getByText("Device setup stays separate from Task conversations."),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Device assessment and Configuration Agent messaging are not connected in this build. The visible Device facts come only from Main's deterministic runtime report.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Proposed change" })).toHaveCount(0);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Configure" })).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

async function installApi(page: Page, { signedIn }: { readonly signedIn: boolean }): Promise<void> {
  let authenticated = signedIn;
  let task = runningTask;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/api/v1/auth/session") {
      if (!authenticated) {
        await route.fulfill({
          json: {
            type: "about:blank",
            title: "Authentication required",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            detail: "Owner authentication is required.",
          },
          status: 401,
        });
        return;
      }
      await route.fulfill({ json: session });
      return;
    }

    if (path === "/api/v1/auth/login" && request.method() === "POST") {
      authenticated = true;
      await route.fulfill({ json: session });
      return;
    }

    if (path === "/api/v1/devices" && request.method() === "GET") {
      await route.fulfill({ json: { devices: [mainDevice] } });
      return;
    }

    if (path === "/api/v1/runtime/features" && request.method() === "GET") {
      await route.fulfill({
        json: {
          releaseChannel: "development",
          taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
          configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
          discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
        },
      });
      return;
    }

    if (path === "/api/v1/tasks" && request.method() === "GET") {
      await route.fulfill({ json: { tasks: [summary(task)] } });
      return;
    }

    if (path === `/api/v1/tasks/${runningTask.taskId}` && request.method() === "GET") {
      await route.fulfill({ json: task });
      return;
    }

    if (path === `/api/v1/tasks/${runningTask.taskId}/actions` && request.method() === "POST") {
      task = {
        ...task,
        state: "paused",
        version: 2,
        updatedAt: "2026-07-24T01:35:00.000Z",
        events: [
          ...task.events,
          {
            eventId: "event_task_paused",
            type: "task.commanded",
            occurredAt: "2026-07-24T01:35:00.000Z",
            streamVersion: 2,
          },
        ],
      };
      await route.fulfill({ json: task });
      return;
    }

    await route.fulfill({
      json: {
        type: "about:blank",
        title: "Not found",
        status: 404,
        code: "NOT_FOUND",
      },
      status: 404,
    });
  });
}

function summary(task: typeof runningTask) {
  const { completionCriteria, constraints, events, selectedInputRefs, ...taskSummary } = task;
  void completionCriteria;
  void constraints;
  void events;
  void selectedInputRefs;
  return taskSummary;
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}
