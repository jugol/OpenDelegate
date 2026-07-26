import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createServiceDiagnostic,
  evaluateSessionHelperReadiness,
  type PlatformServiceConfiguration,
  type ServiceDiagnostic,
  type ServicePlan,
  type ServicePlanExecutionReport,
} from "@opendelegate/platform-services";

import { parseArguments } from "../src/cli.ts";
import {
  ServiceLifecycleCliError,
  loadServiceConfigurationFile,
  parseServiceLifecycleArguments,
  runServiceLifecycleCommand,
  type ServiceLifecycleAdapters,
} from "../src/service-lifecycle.ts";
import { createMainProcessTestSecretContext } from "../test-fixtures/main-test-secrets.ts";
import { createMainRuntime, initializeMainHome } from "../test-fixtures/portable-main-runtime.ts";

const execFileAsync = promisify(execFile);
const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;

const configuration: PlatformServiceConfiguration = {
  platform: "linux",
  instanceId: "personal",
  deviceId: "device-personal",
  role: "main",
  bundle: {
    version: "1.2.3",
    sourceDirectory: "/mnt/release-input/opendelegate-1.2.3",
    checksum: `sha256:${"a".repeat(64)}`,
  },
  paths: {
    sourceCheckoutDirectory: "/home/owner/src/OpenDelegate",
    installRoot: "/opt/opendelegate",
    stateRoot: "/var/lib/opendelegate",
    authorityRoot: "/var/lib/opendelegate-authority",
    runtimeRoot: "/run/opendelegate",
    logRoot: "/var/log/opendelegate",
  },
  ownerSession: {
    userName: "owner",
    stableUserId: "1000",
    uid: 1000,
    homeDirectory: "/home/owner",
    adminAutoOpen: {
      enabled: false,
    },
  },
  serviceIdentity: {
    userName: "opendelegate",
    groupName: "opendelegate",
  },
  helperSecretBinding: {
    backend: "linux-secret-service",
    secretToolPath: "/usr/bin/secret-tool",
  },
  systemdCredential: null,
  ipcTrust: {
    protocolVersion: 2,
    core: {
      keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
      publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
    },
    helper: {
      keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
      publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
    },
  },
  secretReferences: {
    deviceIdentity: "secret://linux/device-identity",
    coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
    helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
  },
  health: {
    endpoint: "http://127.0.0.1:43190/health/live",
    timeoutMs: 30_000,
  },
  retainPreviousVersions: 2,
};

test("the owner CLI exposes every service lifecycle command with strict options", () => {
  const directCommands = [
    ["install", "--config", "service.json", "--command-id", "service-install-0001"],
    [
      "start",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-start-0001",
    ],
    [
      "stop",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-stop-0001",
    ],
    [
      "restart",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-restart-0001",
    ],
    [
      "reconfigure",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-reconfigure-0001",
    ],
    [
      "uninstall",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-uninstall-0001",
    ],
    [
      "upgrade",
      "--config",
      "service.json",
      "--active-version",
      "1.2.2",
      "--command-id",
      "service-upgrade-0001",
    ],
    ["status", "--config", "service.json"],
    ["diagnose", "--config", "service.json"],
    ["render", "--config", "service.json"],
  ] as const;

  for (const arguments_ of directCommands) {
    assert.equal(parseServiceLifecycleArguments(arguments_).command, arguments_[0]);
  }
  const plan = parseServiceLifecycleArguments([
    "plan",
    "restart",
    "--config",
    "service.json",
    "--active-version",
    "1.2.3",
  ]);
  assert.equal(plan.command, "plan");
  assert.equal(plan.operation, "restart");

  const topLevel = parseArguments(["service", "status", "--config", "service.json"]);
  assert.equal(topLevel.command, "service");
  assert.equal(topLevel.service?.command, "status");
  assert.equal(
    parseServiceLifecycleArguments(["status", "--config", "service.json", "--home", "main-home"])
      .home,
    join(process.cwd(), "main-home"),
  );

  assert.throws(
    () =>
      parseServiceLifecycleArguments([
        "restart",
        "--config",
        "service.json",
        "--active-version",
        "1.2.3",
      ]),
    /command-id/,
  );
  assert.throws(
    () =>
      parseServiceLifecycleArguments([
        "install",
        "--config",
        "service.json",
        "--command-id",
        "service-install-0001",
        "--purge-state",
      ]),
    /purge-state.*uninstall/i,
  );
});

test("plan and render are read-only and use the validated platform-services contract", async () => {
  let loads = 0;
  const adapters = configurationOnlyAdapters(() => {
    loads += 1;
    return configuration;
  });

  const rendered = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments(["render", "--config", "service.json"]),
    adapters,
  );
  assert.equal(rendered.kind, "render");
  assert.equal(rendered.artifacts.platform, "linux");
  assert.equal(rendered.artifacts.core.plane, "core");
  assert.equal(rendered.artifacts.helper.plane, "session-helper");

  const planned = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments([
      "plan",
      "restart",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
    ]),
    adapters,
  );
  assert.equal(planned.kind, "plan");
  assert.equal(planned.plan.operation, "restart");
  assert.equal(planned.plan.requiresElevation, true);
  assert.equal(loads, 2);
});

test("packaged Main render replaces stale template auto-open with durable Configuration state", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-service-main-effective-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = join(home, "admin-dist");
  await mkdir(join(adminRoot, "assets"), { recursive: true });
  await writeFile(
    join(adminRoot, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
  );
  await writeFile(join(adminRoot, "assets", "app.js"), "console.log('test');");
  const mainSecrets = await createMainProcessTestSecretContext(home);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: process.cwd(),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
    environment: mainSecrets.environment,
  });
  const runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "service-effective-configuration" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: process.cwd(),
    managedSecretStore: mainSecrets.store,
    environment: mainSecrets.environment,
    initialAdminAutoOpen: true,
  });
  await runtime.close();
  const configurationPath = join(home, "service-template.json");
  await writeFile(
    configurationPath,
    `${JSON.stringify({
      ...configuration,
      instanceId: initialized.configuration.instanceId,
      deviceId: initialized.configuration.deviceId,
      ownerSession: {
        ...configuration.ownerSession,
        adminAutoOpen: { enabled: false },
      },
    })}\n`,
    "utf8",
  );

  const execution = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "service",
      "render",
      "--config",
      configurationPath,
      "--home",
      home,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        ...mainSecrets.environment,
      },
    },
  );
  const result = JSON.parse(execution.stdout) as {
    readonly artifacts: {
      readonly files: readonly {
        readonly purpose: string;
        readonly content: string;
      }[];
    };
  };
  const runtimeConfiguration = result.artifacts.files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(runtimeConfiguration);
  const rendered = JSON.parse(runtimeConfiguration.content) as {
    readonly ownerSession: {
      readonly adminAutoOpen: unknown;
    };
  };
  assert.deepEqual(rendered.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "http://127.0.0.1:4380/",
  });
});

test("packaged mutation commands fail before mutation when no approved executor is composed", async () => {
  let mutations = 0;
  const adapters: ServiceLifecycleAdapters = {
    ...configurationOnlyAdapters(() => configuration),
    mutationObserver: {
      onMutationAttempt() {
        mutations += 1;
      },
    },
  };

  await assert.rejects(
    runServiceLifecycleCommand(
      parseServiceLifecycleArguments([
        "install",
        "--config",
        "service.json",
        "--command-id",
        "service-install-0001",
      ]),
      adapters,
    ),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError &&
      error.code === "SERVICE_EXECUTOR_UNAVAILABLE" &&
      error.requiresElevation &&
      error.mutationMayHaveOccurred === false,
  );
  assert.equal(mutations, 0);
});

test("the packaged CLI fails safely before mutation when host preflight cannot pass", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-service-cli-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const configurationPath = join(directory, "service.json");
  await writeFile(
    configurationPath,
    `${JSON.stringify({ ...configuration, role: "worker" })}\n`,
    "utf8",
  );

  let failure: unknown;
  try {
    await execFileAsync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "service",
        "install",
        "--config",
        configurationPath,
        "--command-id",
        "service-install-0001",
      ],
      {
        windowsHide: true,
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error && "stderr" in failure);
  const errorLine = String(failure.stderr)
    .split(/\r?\n/u)
    .findLast((line) => line.startsWith("{"));
  assert.ok(errorLine, String(failure.stderr));
  const payload = JSON.parse(errorLine) as Record<string, unknown>;
  assert.ok(
    payload["code"] === "SERVICE_PLATFORM_MISMATCH" ||
      payload["code"] === "SERVICE_COMMAND_PREFLIGHT_FAILED",
    String(payload["code"]),
  );
  assert.equal(payload["requiresElevation"], true);
  assert.equal(payload["mutationMayHaveOccurred"], false);
});

test("an injected executor receives the deterministic plan and command ID", async () => {
  const seen: Array<{ readonly commandId: string; readonly plan: ServicePlan }> = [];
  const adapters: ServiceLifecycleAdapters = {
    ...configurationOnlyAdapters(() => configuration),
    executor: {
      async execute(input) {
        seen.push(input);
        return {
          replayed: false,
          report: successfulReport(input.plan),
        };
      },
    },
  };

  const result = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments([
      "restart",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-restart-0001",
    ]),
    adapters,
  );

  assert.equal(result.kind, "operation");
  assert.equal(result.report.outcome, "succeeded");
  assert.equal(result.replayed, false);
  assert.equal(seen[0]?.commandId, "service-restart-0001");
  assert.equal(seen[0]?.plan.operation, "restart");
});

test("reconfigure binds the effective and prior Admin preference into one deterministic helper restart", async () => {
  const previousConfiguration = configuration;
  const effectiveConfiguration: PlatformServiceConfiguration = {
    ...configuration,
    ownerSession: {
      ...configuration.ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "http://127.0.0.1:4380/",
      },
    },
  };
  const seen: Array<{
    readonly configuration: PlatformServiceConfiguration;
    readonly previousConfiguration?: PlatformServiceConfiguration;
    readonly plan: ServicePlan;
  }> = [];
  const result = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments([
      "reconfigure",
      "--config",
      "service.json",
      "--active-version",
      "1.2.3",
      "--command-id",
      "service-reconfigure-0001",
    ]),
    {
      configurationReader: {
        async read() {
          return effectiveConfiguration;
        },
      },
      reconfigurationReader: {
        async readPrevious() {
          return previousConfiguration;
        },
      },
      hostPlatform: "linux",
      executor: {
        async execute(input) {
          seen.push(input);
          return {
            replayed: false,
            report: successfulReport(input.plan),
          };
        },
      },
    },
  );

  assert.equal(result.kind, "operation");
  assert.equal(result.report.operation, "reconfigure");
  assert.deepEqual(
    seen[0]?.configuration.ownerSession.adminAutoOpen,
    effectiveConfiguration.ownerSession.adminAutoOpen,
  );
  assert.deepEqual(
    seen[0]?.previousConfiguration?.ownerSession.adminAutoOpen,
    previousConfiguration.ownerSession.adminAutoOpen,
  );
  assert.deepEqual(
    seen[0]?.plan.steps.flatMap((step) =>
      step.action.kind === "supervisor.invoke" ? [step.action.command.plane] : [],
    ),
    ["session-helper", "session-helper"],
  );
});

test("audit failure prevents executor entry and an unstructured executor failure is marked uncertain", async () => {
  let executorCalls = 0;
  const baseCommand = parseServiceLifecycleArguments([
    "install",
    "--config",
    "service.json",
    "--command-id",
    "service-install-0002",
  ]);
  await assert.rejects(
    runServiceLifecycleCommand(baseCommand, {
      ...configurationOnlyAdapters(() => configuration),
      mutationObserver: {
        onMutationAttempt() {
          throw new Error("audit unavailable");
        },
      },
      executor: {
        async execute(input) {
          executorCalls += 1;
          return {
            replayed: false,
            report: successfulReport(input.plan),
          };
        },
      },
    }),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError &&
      error.code === "SERVICE_MUTATION_AUDIT_FAILED" &&
      error.mutationMayHaveOccurred === false,
  );
  assert.equal(executorCalls, 0);

  await assert.rejects(
    runServiceLifecycleCommand(baseCommand, {
      ...configurationOnlyAdapters(() => configuration),
      executor: {
        async execute() {
          throw new Error("unexpected adapter failure");
        },
      },
    }),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError &&
      error.code === "SERVICE_EXECUTOR_FAILED" &&
      error.mutationMayHaveOccurred,
  );
});

test("an injected executor cannot apply a configuration for a different host platform", async () => {
  let executorCalls = 0;
  await assert.rejects(
    runServiceLifecycleCommand(
      parseServiceLifecycleArguments([
        "install",
        "--config",
        "service.json",
        "--command-id",
        "service-install-0003",
      ]),
      {
        ...configurationOnlyAdapters(() => configuration),
        hostPlatform: "windows",
        executor: {
          async execute(input) {
            executorCalls += 1;
            return {
              replayed: false,
              report: successfulReport(input.plan),
            };
          },
        },
      },
    ),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError &&
      error.code === "SERVICE_PLATFORM_MISMATCH" &&
      error.mutationMayHaveOccurred === false,
  );
  assert.equal(executorCalls, 0);
});

test("status and diagnostics preserve core/helper separation and never infer Computer Use from core", async () => {
  const diagnostic = loggedOutDiagnostic();
  const adapters: ServiceLifecycleAdapters = {
    ...configurationOnlyAdapters(() => configuration),
    inspector: {
      async inspect() {
        return diagnostic;
      },
    },
  };

  const status = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments(["status", "--config", "service.json"]),
    adapters,
  );
  assert.equal(status.kind, "status");
  assert.equal(status.core.status, "running");
  assert.equal(status.helper.status, "not-loaded");
  assert.equal(status.readiness.computerUse, "unavailable");
  assert.equal(status.readiness.headlessWorkAvailable, true);

  const diagnosed = await runServiceLifecycleCommand(
    parseServiceLifecycleArguments(["diagnose", "--config", "service.json"]),
    adapters,
  );
  assert.equal(diagnosed.kind, "diagnostic");
  assert.deepEqual(diagnosed.diagnostic, diagnostic);
  assert.equal(JSON.stringify(diagnosed).includes("secret://"), false);
});

test("an inspector cannot claim Computer Use readiness from core health alone", async () => {
  const diagnostic = loggedOutDiagnostic();
  const contradictory: ServiceDiagnostic = {
    ...diagnostic,
    helper: {
      ...diagnostic.helper,
      status: "not-loaded",
    },
    readiness: evaluateSessionHelperReadiness({
      helperProcess: "running",
      loggedIn: true,
      desktopUnlocked: true,
      permissions: {
        accessibility: "granted",
        input: "granted",
        screenCapture: "granted",
      },
    }),
  };

  await assert.rejects(
    runServiceLifecycleCommand(
      parseServiceLifecycleArguments(["status", "--config", "service.json"]),
      {
        ...configurationOnlyAdapters(() => configuration),
        inspector: {
          async inspect() {
            return contradictory;
          },
        },
      },
    ),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError && error.code === "SERVICE_INSPECTOR_INVALID",
  );
});

test("service configuration loading is stable-file bounded and strictly validated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opendelegate-service-config-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const validPath = join(directory, "valid.json");
  await writeFile(validPath, `${JSON.stringify(configuration)}\n`, "utf8");

  const loaded = await loadServiceConfigurationFile(validPath);
  assert.equal(loaded.platform, "linux");
  assert.equal(loaded.instanceId, "personal");

  const invalidPath = join(directory, "invalid.json");
  await writeFile(
    invalidPath,
    `${JSON.stringify({ ...configuration, unexpected: "field" })}\n`,
    "utf8",
  );
  await assert.rejects(
    loadServiceConfigurationFile(invalidPath),
    (error: unknown) =>
      error instanceof ServiceLifecycleCliError && error.code === "SERVICE_CONFIGURATION_INVALID",
  );
});

function configurationOnlyAdapters(
  value: () => PlatformServiceConfiguration,
): ServiceLifecycleAdapters {
  return {
    configurationReader: {
      async read() {
        return value();
      },
    },
    hostPlatform: "linux",
  };
}

function successfulReport(plan: ServicePlan): ServicePlanExecutionReport {
  return {
    outcome: "succeeded",
    operation: plan.operation,
    platform: plan.platform,
    instanceId: plan.instanceId,
    completedStepIds: plan.steps.map((step) => step.id),
    unchangedStepIds: [],
    rollback: {
      attempted: false,
      completedStepIds: [],
      failures: [],
    },
    diagnostic: {
      eventName: "platform.service.operation.succeeded",
      summary: `${plan.operation} completed and all required health checks passed.`,
    },
  };
}

function loggedOutDiagnostic(): ServiceDiagnostic {
  return createServiceDiagnostic({
    configuration,
    activeVersion: "1.2.3",
    retainedVersions: ["1.2.2"],
    coreSupervisorState: "running",
    helperSupervisorState: "not-loaded",
    readiness: evaluateSessionHelperReadiness({
      helperProcess: "stopped",
      loggedIn: false,
      desktopUnlocked: false,
      permissions: {
        accessibility: "unknown",
        input: "unknown",
        screenCapture: "unknown",
      },
    }),
  });
}
