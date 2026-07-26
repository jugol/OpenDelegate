import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

import type {
  ApprovalDetail,
  ArtifactDetail,
  AuditEventSummary,
  DeviceEnrollmentOverview,
  IssueEnrollmentGrantResult,
  TaskBudgetSnapshot,
  TaskDetail,
} from "../src/admin-api";
import { englishMessages } from "../src/i18n/messages.en";
import { spanishMessages } from "../src/i18n/messages.es";
import { frenchMessages } from "../src/i18n/messages.fr";
import { japaneseMessages } from "../src/i18n/messages.ja";
import { koreanMessages } from "../src/i18n/messages.ko";
import { simplifiedChineseMessages } from "../src/i18n/messages.zh-CN";
import type { Messages, SupportedLocale } from "../src/i18n/types";

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
  policies: [
    {
      policyId: "policy-browser-network",
      actionCategory: "os-network-change",
      decision: "require-approval",
      source: "configuration",
      effectiveScope: "device",
    },
  ],
  agentAdapters: [
    {
      provider: "codex",
      adapterId: "codex-app-server",
      readiness: "ready",
      compatibility: "tested",
      version: "0.145.0",
      observedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
    },
  ],
  currentRuns: [
    {
      taskId: "task_prepare_release",
      workOrderId: "work_order_browser_release",
      runId: "run_browser_release",
      state: "running",
      acceptedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
      leaseExpiresAtMs: Date.parse("2026-07-25T00:05:00.000Z"),
    },
  ],
  capacity: {
    activeRuns: 1,
    maximumConcurrentRuns: 2,
    acceptingWork: true,
    maxOutboxEntries: 10_000,
    outboxDepth: 1,
  },
};

const workerDevices = [
  {
    deviceId: "device_macos_worker",
    name: "Design Mac — owner label",
    osFamily: "macos",
    platformRelease: "15.5",
    architecture: "arm64",
    role: "worker",
    connection: "online",
    runtime: "healthy",
    serviceMode: "user-service",
  },
  {
    deviceId: "device_windows_worker",
    name: "Windows Build Rig",
    osFamily: "windows",
    platformRelease: "11 24H2",
    architecture: "x64",
    role: "worker",
    connection: "offline",
    runtime: "unavailable",
    serviceMode: "system-service",
  },
  {
    deviceId: "device_linux_worker",
    name: "NAS 工作站",
    osFamily: "linux",
    platformRelease: "6.12.31",
    architecture: "x86_64",
    role: "worker",
    connection: "online",
    runtime: "degraded",
    serviceMode: "system-service",
  },
] as const;

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
  messages: [],
  events: [
    {
      eventId: "event_task_created",
      type: "task.created",
      occurredAt: "2026-07-24T01:30:00.000Z",
      streamVersion: 1,
    },
  ],
} satisfies TaskDetail;

const runningTaskBudget = {
  schemaVersion: 1,
  taskId: runningTask.taskId,
  kind: "requested",
  revision: 1,
  createdAt: runningTask.createdAt,
  lastActivityAt: runningTask.updatedAt,
  limits: {
    wallTimeMs: { soft: 3_000_000, hard: 3_600_000 },
    idleTimeMs: { soft: 480_000, hard: 600_000 },
    retries: { soft: 2, hard: 3 },
    childWorkOrders: { soft: 6, hard: 8 },
    concurrentRuns: { soft: 2, hard: 3 },
    nativeTurns: { soft: 12, hard: 16 },
    tokens: { soft: 200_000, hard: 250_000 },
    costUsdMicros: { soft: 4_000_000, hard: 5_000_000 },
  },
  usage: {
    wallTimeMs: 120_000,
    retries: 0,
    childWorkOrders: 0,
    concurrentRuns: 1,
    nativeTurns: 2,
    tokens: 12_000,
    costUsdMicros: 200_000,
  },
  workOrders: [],
  activeRunIds: ["run_browser_worker"],
  limitEvents: [],
  extensions: [],
  omitted: {
    workOrders: 0,
    activeRunIds: 0,
    limitEvents: 0,
    extensions: 0,
  },
} satisfies TaskBudgetSnapshot;

const pendingApproval = {
  approvalId: "approval_configuration_browser",
  state: "pending",
  executionStatus: "waiting",
  requestedAt: "2026-07-24T01:36:00.000Z",
  expiresAt: "2026-07-25T01:36:00.000Z",
  action: {
    category: "policy-relaxation",
    type: "configuration.apply",
    fingerprint: `sha256:${"c".repeat(64)}`,
    targetDeviceId: mainDevice.deviceId,
    resource: "configuration-proposal:proposal_browser",
  },
  reason: "Enable the verified Computer Use capability.",
  target: mainDevice.name,
  risk: "high",
  evidence: ["Computer Use was detected and verified."],
  configuration: {
    proposalId: "proposal_browser",
    baseRevision: 4,
    changes: [
      {
        key: "capability.computer-use",
        scope: { kind: "device", id: mainDevice.deviceId },
        before: { present: false },
        after: { present: true, valueJson: '{"enabled":true}' },
      },
    ],
  },
} satisfies ApprovalDetail;

const enrollmentOverview = {
  available: true,
  mainDeviceId: mainDevice.deviceId,
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
} satisfies DeviceEnrollmentOverview;

const issuedEnrollmentGrant = {
  summary: {
    grantId: "grant_browser_001",
    deviceId: "device_browser_worker",
    status: "active",
    allowedBootstrapRoles: ["worker"],
    createdAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2026-07-25T00:05:00.000Z",
  },
  suggestedFilename: "opendelegate-device_browser_worker-grant.json",
  document: {
    schemaVersion: 1,
    grantId: "grant_browser_001",
    token: "PRIVATE_BROWSER_GRANT_TOKEN_NEVER_RENDER",
    deviceId: "device_browser_worker",
    mainDeviceId: mainDevice.deviceId,
    expectedMainSpkiSha256: "a".repeat(64),
    certificateAuthorityPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----\n`,
    enrollmentUrl: enrollmentOverview.enrollmentUrl,
    channelEndpoints: enrollmentOverview.channelEndpoints,
    protocolRange: { minimum: 1, maximum: 1 },
    expiresAt: Date.parse("2026-07-25T00:05:00.000Z"),
  },
} satisfies IssueEnrollmentGrantResult;

const artifact = {
  artifactId: "artifact_browser_report",
  taskId: runningTask.taskId,
  producingRunId: "run_browser_worker",
  mediaType: "text/html",
  originalFilename: "release-report.html",
  sizeBytes: 4096,
  checksum: { algorithm: "sha256", value: "b".repeat(64) },
  createdAt: "2026-07-25T00:00:00.000Z",
  retentionPolicy: {
    kind: "temporary",
    expiresAt: "2026-07-26T00:00:00.000Z",
  },
  exposurePolicy: { mode: "authenticated" },
  provenance: {
    deviceId: "device_linux_worker",
    source: "worker-upload",
    workspaceId: "workspace_release",
  },
  presentation: "static-html",
  state: "available",
} satisfies ArtifactDetail;

const auditEvent = {
  auditId: "audit_browser_001",
  source: "artifact",
  type: "artifact.stored",
  occurredAt: "2026-07-25T00:00:00.000Z",
  outcome: "recorded",
  actorId: "worker-agent",
  correlationId: "correlation_browser_001",
  taskId: artifact.taskId,
  runId: artifact.producingRunId,
  deviceId: artifact.provenance.deviceId,
  artifactId: artifact.artifactId,
} satisfies AuditEventSummary;

const localeFixtures: ReadonlyArray<{
  readonly catalog: Messages;
  readonly locale: SupportedLocale;
}> = [
  { catalog: englishMessages, locale: "en" },
  { catalog: koreanMessages, locale: "ko" },
  { catalog: japaneseMessages, locale: "ja" },
  { catalog: frenchMessages, locale: "fr" },
  { catalog: spanishMessages, locale: "es" },
  { catalog: simplifiedChineseMessages, locale: "zh-CN" },
];

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

test("an explicit signed-out language choice persists without replacing the English default", async ({
  page,
}) => {
  await installApi(page, { signedIn: false });
  await page.goto("/");

  const languageSelector = page.locator(".language-selector select");
  await expect(languageSelector).toHaveValue("en");
  await languageSelector.selectOption("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("heading", { name: koreanMessages.auth.signInTitle })).toBeVisible();

  await page.reload();
  await expect(page.locator(".language-selector select")).toHaveValue("ko");
  await expect(page.getByRole("heading", { name: koreanMessages.auth.signInTitle })).toBeVisible();

  await page.locator(".language-selector select").selectOption("fr");
  await page.getByRole("button", { name: frenchMessages.auth.useRecoveryCode }).click();
  await expect(
    page.getByRole("heading", { name: frenchMessages.auth.recoveryTitle }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("all Admin locales update loaded chrome while preserving owner content", async ({
  page,
}, testInfo) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, { signedIn: true });
  await page.goto("/");

  for (const { catalog, locale } of localeFixtures) {
    await page.locator(".language-selector select").selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { name: catalog.device.facts })).toBeVisible();
    await expect(page.getByRole("heading", { name: mainDevice.name })).toBeVisible();

    await page.getByRole("tab", { name: catalog.device.authority }).click();
    await expect(page.getByText(catalog.approvalCategory.osNetworkChange)).toBeVisible();
    await expect(
      page.getByText(`${catalog.device.configuredPolicy} · ${catalog.device.policyScopeDevice}`),
    ).toBeVisible();
    await expect(
      page.getByText(
        `${catalog.device.adapterReadinessReady} · ${catalog.device.adapterCompatibilityTested}`,
      ),
    ).toBeVisible();

    await page.getByRole("tab", { name: catalog.device.runs }).click();
    await expect(
      page.getByText(
        new RegExp(`^${escapeRegularExpression(catalog.device.runStateRunning)} ·`, "u"),
      ),
    ).toBeVisible();

    await page.getByRole("button", { name: catalog.navigation.tasks }).click();
    await expect(
      page.getByRole("heading", { name: catalog.task.title, exact: true }),
    ).toBeVisible();
    const objective = page.getByRole("button", {
      name: runningTask.objective,
      exact: true,
    });
    await expect(objective).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) <= 819) {
      await objective.click();
    }
    await expect(page.getByRole("heading", { name: runningTask.objective })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: catalog.task.completionCriteria }),
    ).toBeVisible();
    const expectedDate = await page.evaluate(
      ({ dateValue, dateLocale }) =>
        new Intl.DateTimeFormat(dateLocale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(dateValue)),
      { dateLocale: locale, dateValue: runningTask.updatedAt },
    );
    await expect(page.locator(".task-table time").first()).toHaveText(expectedDate);
    if ((page.viewportSize()?.width ?? 0) <= 819) {
      await page.getByRole("button", { name: catalog.task.closeDetails }).click();
    }

    await page.getByRole("button", { name: catalog.task.newTask }).click();
    const taskDialog = page.getByRole("dialog", { name: catalog.task.dialogTitle });
    await expect(taskDialog).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await taskDialog.getByRole("button", { name: catalog.task.closeNew }).click();

    await page.getByRole("button", { name: catalog.navigation.approvals }).click();
    await expect(page.getByRole("heading", { name: catalog.approval.title })).toBeVisible();
    await expect(page.getByText(catalog.approval.intro)).toBeVisible();
    await expect(page.getByText(pendingApproval.reason)).toBeVisible();
    await expect(page.getByText(pendingApproval.action.fingerprint)).toBeVisible();
    await page.getByRole("button", { name: catalog.approval.closeDetails }).click();

    await page.getByRole("button", { name: catalog.navigation.artifacts }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: catalog.artifact.title }),
    ).toBeVisible();
    await expect(page.getByText(catalog.artifact.isolatedNotice)).toBeVisible();
    await expect(page.getByText(catalog.artifact.exposureAuthenticated)).toBeVisible();
    await expect(page.getByText(catalog.artifact.presentationStaticHtml)).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) <= 819) {
      await page.getByRole("button", { name: catalog.artifact.closeDetails }).click();
    }

    await page.getByRole("button", { name: catalog.navigation.audit }).click();
    await expect(page.getByRole("heading", { level: 1, name: catalog.audit.title })).toBeVisible();
    await expect(page.getByLabel(catalog.audit.search)).toBeVisible();

    await page.getByRole("button", { name: catalog.navigation.joinDevice }).click();
    await expect(page.getByRole("heading", { level: 1, name: catalog.join.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: catalog.join.stepsTitle })).toBeVisible();

    await page.locator(".device-selector").click();
    await page.getByRole("button", { name: catalog.device.configure, exact: true }).click();
    const configurationDialog = page.getByRole("dialog", { name: catalog.chat.title });
    await expect(configurationDialog).toBeVisible();
    await expect(configurationDialog.getByText(catalog.chat.subtitle)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Escape");
  }

  await page.locator(".language-selector select").selectOption("ko");
  await page.getByRole("button", { name: koreanMessages.navigation.tasks }).click();
  await expect(
    page.getByRole("button", { name: runningTask.objective, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(koreanMessages.task.discordNotice)).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);

  if (
    process.env["OPENDELEGATE_CAPTURE_LOCALIZATION"] === "1" &&
    page.viewportSize()?.width === 1600
  ) {
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("admin-localization-ko.png"),
    });
  }
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
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("authenticated owner reviews an exact Approval and approves it once", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, { signedIn: true });
  await page.goto("/");

  await page.getByRole("button", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  const inspector = page.getByRole("complementary", {
    name: "Approval details: configuration.apply",
  });
  await expect(inspector.getByText(pendingApproval.reason)).toBeVisible();
  await expect(inspector.getByText(pendingApproval.action.fingerprint)).toBeVisible();
  await expect(inspector.getByText("Computer Use was detected and verified.")).toBeVisible();
  await expect(inspector.getByLabel("Approval scope")).toHaveValue("once");

  await inspector.getByRole("button", { name: "Approve once" }).click();
  await expect(inspector.getByText("Execution succeeded")).toBeVisible();
  await expect(inspector.getByText("Approved · Once")).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Approve once" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("authenticated owner can enroll a Device, inspect Artifacts, and diagnose Main safely", async ({
  page,
}) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, { signedIn: true });
  await page.goto("/");

  await page.getByRole("button", { name: "Join a device" }).click();
  await expect(page.getByRole("heading", { name: "Join a device" })).toBeVisible();
  await page.getByLabel("Device ID").fill("device_browser_worker");
  await page.getByRole("button", { name: "Generate grant" }).click();
  await expect(page.getByRole("heading", { name: "Grant ready to download" })).toBeVisible();
  await expect(page.getByText(/opendelegate worker join --grant-file/u)).toBeVisible();
  await expect(page.getByText(issuedEnrollmentGrant.document.token)).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download grant file" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(issuedEnrollmentGrant.suggestedFilename);

  await page.getByRole("button", { name: "Artifacts" }).click();
  await expect(page.getByRole("heading", { name: "Artifacts" })).toBeVisible();
  const artifactInspector = page.getByRole("complementary", {
    name: "Artifact details: release-report.html",
  });
  await expect(artifactInspector).toBeVisible();
  await expect(artifactInspector.getByText(artifact.checksum.value)).toBeVisible();
  await expect(artifactInspector.locator("iframe")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) <= 819) {
    await page.getByRole("button", { name: "Close Artifact details" }).click();
  }

  await page.getByRole("button", { name: "Audit" }).click();
  await expect(page.getByRole("heading", { name: "Audit & diagnostics" })).toBeVisible();
  await expect(page.getByText("DATABASE_READY")).toBeVisible();
  await expect(page.getByText("artifact.stored")).toBeVisible();
  await expect(page.getByText(auditEvent.correlationId)).toBeVisible();
  await expect(page.getByText(/raw event payloads/iu)).toBeVisible();
  await expectNoHorizontalOverflow(page);

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
  await expect(page.getByText("1 of 2 Run slots active")).toBeVisible();
  await expect(page.getByText("Run run_browser_release")).toBeVisible();
  await expect(page.getByText("Mac Studio")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Configuration Chat" })).toHaveCount(0);

  await page.getByRole("button", { name: "Configure" }).click();
  const dialog = page.getByRole("dialog", { name: "Configuration Chat" });
  const composer = page.getByRole("textbox", { name: "Message Configuration Chat" });
  await expect(dialog).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(composer).toBeFocused();
  await expect(
    dialog.getByText("Device setup stays separate from Task conversations."),
  ).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Proposed change" })).toHaveCount(0);

  await composer.fill("Recommend a safe role for this Device");
  await dialog.getByRole("button", { name: "Send message" }).click();
  await expect(dialog.getByText("I reviewed the deterministic Device facts.")).toBeVisible();
  await expect(dialog.getByText("Recommend a safe role for this Device")).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Configure" })).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("Device navigation keeps one Main and selects macOS, Windows, and Linux Workers", async ({
  page,
}) => {
  const consoleErrors = collectConsoleErrors(page);
  await installApi(page, {
    devices: [mainDevice, ...workerDevices],
    signedIn: true,
  });
  await page.goto("/");

  const deviceList = page.getByRole("list", { name: "Devices" });
  const expectedButtons = [
    "windows-main, Main, Online",
    "Design Mac — owner label, Worker, Online",
    "Windows Build Rig, Worker, Offline",
    "NAS 工作站, Worker, Online",
  ];
  await expect(deviceList.getByRole("button")).toHaveCount(expectedButtons.length);
  for (const accessibleName of expectedButtons) {
    await expect(deviceList.getByRole("button", { name: accessibleName })).toBeVisible();
  }
  await expect(deviceList.getByRole("button").first()).toHaveAttribute("aria-current", "page");

  const selections = [
    {
      button: "Design Mac — owner label, Worker, Online",
      heading: "Design Mac — owner label",
      operatingSystem: "macOS 15.5",
    },
    {
      button: "Windows Build Rig, Worker, Offline",
      heading: "Windows Build Rig",
      operatingSystem: "Windows 11 24H2",
    },
    {
      button: "NAS 工作站, Worker, Online",
      heading: "NAS 工作站",
      operatingSystem: "Linux 6.12.31",
    },
  ] as const;

  for (const selection of selections) {
    const button = deviceList.getByRole("button", { name: selection.button });
    if ((page.viewportSize()?.width ?? 0) <= 819) {
      await button.click();
    } else {
      await button.focus();
      await page.keyboard.press("Enter");
    }
    await expect(page.getByRole("heading", { level: 1, name: selection.heading })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Device facts" }).getByText(selection.operatingSystem),
    ).toBeVisible();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalOverflow(page);
  }

  await page.locator(".language-selector select").selectOption("ko");
  await expect(page.getByRole("heading", { name: "NAS 工作站" })).toBeVisible();
  await expect(
    page.getByRole("list", { name: koreanMessages.navigation.devices }).getByRole("button", {
      name: `NAS 工作站, ${koreanMessages.known.worker}, ${koreanMessages.known.online}`,
    }),
  ).toHaveAttribute("aria-current", "page");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

async function installApi(
  page: Page,
  {
    devices = [mainDevice],
    signedIn,
  }: {
    readonly devices?: readonly (typeof mainDevice | (typeof workerDevices)[number])[];
    readonly signedIn: boolean;
  },
): Promise<void> {
  let authenticated = signedIn;
  let task: TaskDetail = runningTask;
  let approval: ApprovalDetail = pendingApproval;

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
      await route.fulfill({ json: { devices } });
      return;
    }

    if (path === "/api/v1/runtime/features" && request.method() === "GET") {
      await route.fulfill({
        json: {
          declaredReleaseChannel: "development",
          releaseChannel: "development",
          releaseVerification: { status: "not-applicable" },
          taskExecution: { status: "ready", code: "TASK_EXECUTION_READY" },
          configurationAgent: { status: "ready", code: "CONFIGURATION_AGENT_READY" },
          discord: { status: "unavailable", code: "DISCORD_NOT_CONFIGURED" },
        },
      });
      return;
    }

    if (
      path === `/api/v1/devices/${mainDevice.deviceId}/configuration/messages` &&
      request.method() === "POST"
    ) {
      await route.fulfill({
        json: {
          messageId: "message_configuration_browser",
          sessionId: "configuration_browser",
          content: "I reviewed the deterministic Device facts.",
          occurredAt: "2026-07-24T01:34:00.000Z",
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

    if (path === `/api/v1/tasks/${runningTask.taskId}/budget` && request.method() === "GET") {
      await route.fulfill({ json: runningTaskBudget });
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

    if (path === "/api/v1/approvals" && request.method() === "GET") {
      await route.fulfill({ json: { approvals: [approval] } });
      return;
    }

    if (path === `/api/v1/approvals/${pendingApproval.approvalId}` && request.method() === "GET") {
      await route.fulfill({ json: approval });
      return;
    }

    if (
      path === `/api/v1/approvals/${pendingApproval.approvalId}/decision` &&
      request.method() === "POST"
    ) {
      const headers = request.headers();
      const body = request.postDataJSON() as unknown;
      if (
        headers["x-opendelegate-csrf"] !== session.csrfToken ||
        !/^admin-[0-9a-f-]{36}$/u.test(headers["idempotency-key"] ?? "") ||
        JSON.stringify(body) !== JSON.stringify({ decision: "approve", scope: "once" })
      ) {
        await route.fulfill({
          json: {
            title: "Invalid approval decision",
            status: 400,
            code: "INVALID_APPROVAL_DECISION",
          },
          status: 400,
        });
        return;
      }
      approval = {
        ...approval,
        state: "approved",
        executionStatus: "succeeded",
        decision: {
          decision: "approve",
          scope: "once",
          decidedBy: session.session.ownerId,
          decidedAt: "2026-07-24T01:37:00.000Z",
        },
      };
      await route.fulfill({ json: approval });
      return;
    }

    if (path === "/api/v1/device-enrollment" && request.method() === "GET") {
      await route.fulfill({ json: enrollmentOverview });
      return;
    }

    if (path === "/api/v1/device-enrollment/grants" && request.method() === "POST") {
      const headers = request.headers();
      const body = request.postDataJSON() as unknown;
      if (
        headers["x-opendelegate-csrf"] !== session.csrfToken ||
        !/^admin-[0-9a-f-]{36}$/u.test(headers["idempotency-key"] ?? "") ||
        JSON.stringify(body) !==
          JSON.stringify({ deviceId: "device_browser_worker", expiresInSeconds: 300 })
      ) {
        await route.fulfill({
          json: {
            title: "Invalid enrollment request",
            status: 400,
            code: "INVALID_ENROLLMENT_REQUEST",
          },
          status: 400,
        });
        return;
      }
      await route.fulfill({ json: issuedEnrollmentGrant, status: 201 });
      return;
    }

    if (path === "/api/v1/artifacts" && request.method() === "GET") {
      await route.fulfill({ json: { artifacts: [artifact] } });
      return;
    }

    if (path === `/api/v1/artifacts/${artifact.artifactId}` && request.method() === "GET") {
      await route.fulfill({ json: artifact });
      return;
    }

    if (path === `/api/v1/artifacts/${artifact.artifactId}/open` && request.method() === "POST") {
      await route.fulfill({
        json: {
          method: "GET",
          href: `https://static.artifacts.test/artifacts/${artifact.artifactId}`,
          artifactId: artifact.artifactId,
        },
      });
      return;
    }

    if (path === "/api/v1/audit-events" && request.method() === "GET") {
      await route.fulfill({ json: { events: [auditEvent] } });
      return;
    }

    if (path === "/api/v1/readiness" && request.method() === "GET") {
      await route.fulfill({
        json: {
          status: "ready",
          checks: [{ status: "ready", code: "DATABASE_READY" }],
        },
      });
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

function summary(task: TaskDetail) {
  const { completionCriteria, constraints, events, messages, selectedInputRefs, ...taskSummary } =
    task;
  void completionCriteria;
  void constraints;
  void events;
  void messages;
  void selectedInputRefs;
  return taskSummary;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}
