import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformServiceError,
  createServicePlan,
  parseLaunchdPlist,
  parseSystemdUnit,
  parseWindowsTaskXml,
  renderPlatformServiceArtifacts,
  validateSupervisorCommands,
} from "../src/index.ts";
import { linuxConfiguration, macOsConfiguration, windowsConfiguration } from "./fixtures.ts";

test("renders an SCM boot service and least-privilege interactive logon helper on Windows", () => {
  const artifacts = renderPlatformServiceArtifacts(windowsConfiguration());
  assert.equal(artifacts.platform, "windows");
  assert.ok(artifacts.helper);
  assert.equal(artifacts.core.bootSemantics, "boot");
  assert.equal(artifacts.helper.bootSemantics, "login");
  assert.equal(artifacts.core.identity, "NT SERVICE\\OpenDelegate-personal");
  assert.notEqual(artifacts.core.identity, "LocalSystem");
  assert.match(artifacts.ipc.endpoint, /^\\\\\.\\pipe\\/);
  assert.equal(artifacts.ipc.authentication, "ed25519-mutual-signature-v2");

  const task = parseWindowsTaskXml(artifacts.helper.manifest.content);
  assert.equal(task.logonType, "InteractiveToken");
  assert.equal(task.runLevel, "LeastPrivilege");
  assert.equal(task.trigger, "LogonTrigger");
  assert.equal(task.userId, "S-1-5-21-1000");
  assert.equal(artifacts.helper.manifest.encoding, "utf16le-bom");
  assert.match(task.command, /\\current\\bin\\opendelegate-session-helper\.exe$/i);
  assert.match(
    task.arguments,
    /--stdout-log C:\\ProgramData\\OpenDelegate\\logs\\helper\.stdout\.log/u,
  );
  assert.match(
    task.arguments,
    /--stderr-log C:\\ProgramData\\OpenDelegate\\logs\\helper\.stderr\.log/u,
  );
  assert.match(artifacts.helper.manifest.content, /<Interval>PT1M<\/Interval>/u);
  assert.doesNotMatch(artifacts.helper.manifest.content, /<Interval>PT15S<\/Interval>/u);

  const createService = artifacts.installCommands.find(
    (command) =>
      command.executable.toLowerCase() === "sc.exe" && command.arguments.includes("create"),
  );
  assert.ok(createService);
  const imagePath = createService.arguments.at(createService.arguments.indexOf("binPath=") + 1);
  assert.match(
    imagePath ?? "",
    /--stdout-log C:\\ProgramData\\OpenDelegate\\logs\\core\.stdout\.log/u,
  );
  assert.match(
    imagePath ?? "",
    /--stderr-log C:\\ProgramData\\OpenDelegate\\logs\\core\.stderr\.log/u,
  );
  const coreManifest = JSON.parse(artifacts.core.manifest.content) as {
    serviceSidType?: string;
  };
  assert.equal(coreManifest.serviceSidType, "unrestricted");
  assert.ok(
    artifacts.installCommands.some(
      (command) =>
        command.executable.toLowerCase() === "sc.exe" &&
        command.arguments[0] === "sidtype" &&
        command.arguments.at(-1) === "unrestricted",
    ),
  );
  const stopService = artifacts.stopCommands.find(
    (command) => command.executable.toLowerCase() === "sc.exe",
  );
  assert.equal(stopService?.timeoutMs, 45_000);
  assert.ok(
    artifacts.installCommands.some(
      (command) =>
        command.executable.toLowerCase() === "schtasks.exe" && command.arguments.includes("/XML"),
    ),
  );
  validateSupervisorCommands(artifacts.installCommands);

  const rendered = artifacts.files.map((file) => file.content).join("\n");
  assert.match(rendered, /secret:\/\/windows\/core-ipc-signing-v2/);
  assert.match(rendered, /secret:\/\/windows\/helper-ipc-signing-v2/);
  assert.doesNotMatch(rendered, /"helperIpc"/);
  assert.doesNotMatch(rendered, /raw-super-secret/);
  const runtimeFile = artifacts.files.find((file) => file.purpose === "runtime-configuration");
  assert.ok(runtimeFile);
  const runtime = JSON.parse(runtimeFile.content) as {
    logs: {
      core: { stdout: string };
      sessionHelper: { stderr: string };
    };
  };
  assert.equal(runtime.logs.core.stdout, "C:\\ProgramData\\OpenDelegate\\logs\\core.stdout.log");
  assert.equal(
    runtime.logs.sessionHelper.stderr,
    "C:\\ProgramData\\OpenDelegate\\logs\\helper.stderr.log",
  );
});

test("renders a LaunchDaemon and Aqua LaunchAgent with separate privilege planes", () => {
  const artifacts = renderPlatformServiceArtifacts(macOsConfiguration());
  assert.equal(artifacts.platform, "macos");
  assert.ok(artifacts.helper);
  for (const manifest of [artifacts.core.manifest, artifacts.helper.manifest]) {
    assert.match(manifest.content, /<true\/>/u);
    assert.match(manifest.content, /<false\/>/u);
    assert.doesNotMatch(manifest.content, /<(true|false)><\/\1>/u);
  }
  const daemon = parseLaunchdPlist(artifacts.core.manifest.content);
  const agent = parseLaunchdPlist(artifacts.helper.manifest.content);

  assert.equal(daemon.Label, "dev.opendelegate.personal.core");
  assert.equal(daemon.UserName, "_opendelegate");
  assert.equal(daemon.GroupName, "_opendelegate");
  assert.ok(
    typeof daemon.EnvironmentVariables === "object" &&
      daemon.EnvironmentVariables !== null &&
      !Array.isArray(daemon.EnvironmentVariables),
  );
  const environmentVariables = daemon.EnvironmentVariables as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(environmentVariables), ["PATH"]);
  assert.equal(
    environmentVariables["PATH"],
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  assert.equal(daemon.RunAtLoad, true);
  assert.equal(daemon.KeepAlive, true);
  assert.equal(daemon.AbandonProcessGroup, false);
  assert.match(String(daemon.StandardOutPath), /core\.stdout\.log$/);
  assert.match(String(daemon.StandardErrorPath), /core\.stderr\.log$/);

  assert.equal(agent.Label, "dev.opendelegate.personal.session-helper");
  assert.equal(agent.LimitLoadToSessionType, "Aqua");
  assert.equal(agent.RunAtLoad, true);
  assert.equal(agent.KeepAlive, true);
  assert.equal(agent.AbandonProcessGroup, false);
  assert.equal(Object.hasOwn(agent, "UserName"), false);
  assert.match(String(agent.StandardOutPath), /helper\.stdout\.log$/);
  assert.match(artifacts.ipc.endpoint, /^\/private\/var\/run\/opendelegate\//);
  assert.equal(artifacts.ipc.socketMode, "0660");
});

test("renders hardened system and graphical-user systemd units", () => {
  const artifacts = renderPlatformServiceArtifacts(
    linuxConfiguration({
      systemdCredential: {
        credentialName: "opendelegate-vault-key",
        encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
      },
    }),
  );
  assert.equal(artifacts.platform, "linux");
  assert.ok(artifacts.helper);
  const core = parseSystemdUnit(artifacts.core.manifest.content);
  const helper = parseSystemdUnit(artifacts.helper.manifest.content);

  assert.equal(core.Service?.User, "opendelegate");
  assert.equal(core.Service?.Group, "opendelegate");
  assert.equal(core.Service?.NoNewPrivileges, "yes");
  assert.equal(core.Service?.KillMode, "control-group");
  assert.equal(core.Service?.ProtectSystem, "strict");
  assert.equal(core.Service?.PrivateTmp, "yes");
  assert.equal(core.Service?.PrivateMounts, "yes");
  assert.equal(
    core.Service?.LoadCredentialEncrypted,
    '"opendelegate-vault-key:/etc/credstore.encrypted/opendelegate-vault-key.cred"',
  );
  assert.equal(core.Service?.StandardOutput, "append:/var/log/opendelegate/core.stdout.log");
  assert.equal(core.Install?.WantedBy, "multi-user.target");

  assert.equal(helper.Service?.User, undefined);
  assert.equal(helper.Unit?.PartOf, "graphical-session.target");
  assert.equal(helper.Install?.WantedBy, "graphical-session.target");
  assert.equal(helper.Service?.NoNewPrivileges, "yes");
  assert.equal(helper.Service?.KillMode, "control-group");
  assert.equal(helper.Service?.StandardError, "append:/var/log/opendelegate/helper.stderr.log");
  const helperEnable = artifacts.installCommands.find(
    (invocation) => invocation.plane === "session-helper" && invocation.verb === "enable",
  );
  const helperReload = artifacts.installCommands.find(
    (invocation) => invocation.plane === "session-helper" && invocation.verb === "reload",
  );
  assert.equal(helperEnable?.availabilityPolicy, "required");
  assert.equal(helperReload?.availabilityPolicy, "defer-if-logged-out");
  assert.match(artifacts.foregroundFallback.command, /opendelegate-service-host$/);
  assert.equal(artifacts.foregroundFallback.requiresExternalSupervisor, true);
});

test("renders an explicit headless Linux core without a phantom helper", () => {
  const graphical = linuxConfiguration({
    systemdCredential: {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    },
  });
  const configuration = linuxConfiguration({
    helperSecretBinding: null,
    ipcTrust: {
      protocolVersion: 2,
      core: graphical.ipcTrust.core,
    },
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
    },
    systemdCredential: {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    },
  });
  const artifacts = renderPlatformServiceArtifacts(configuration);

  assert.equal(artifacts.helper, null);
  assert.equal(artifacts.ipc.sessionHelper, "disabled");
  assert.equal(
    artifacts.files.some((file) => file.purpose === "helper-manifest"),
    false,
  );
  assert.equal(
    [...artifacts.installCommands, ...artifacts.startCommands].some(
      (command) => command.plane === "session-helper",
    ),
    false,
  );
  const runtimeFile = artifacts.files.find((file) => file.purpose === "runtime-configuration");
  assert.ok(runtimeFile);
  const runtime = JSON.parse(runtimeFile.content) as {
    helperSecretBinding: unknown;
    localIpc: { sessionHelper: string; helper?: unknown };
  };
  assert.equal(runtime.helperSecretBinding, null);
  assert.equal(runtime.localIpc.sessionHelper, "disabled");
  assert.equal(Object.hasOwn(runtime.localIpc, "helper"), false);

  const plan = createServicePlan({ operation: "install", configuration });
  assert.equal(
    plan.steps.some((step) => step.id.includes("helper")),
    false,
  );
  assert.match(plan.notes.join("\n"), /Computer Use is explicitly unavailable/u);
});

test("rendering is byte-for-byte deterministic", () => {
  assert.deepEqual(
    renderPlatformServiceArtifacts(windowsConfiguration()),
    renderPlatformServiceArtifacts(windowsConfiguration()),
  );
  assert.deepEqual(
    renderPlatformServiceArtifacts(macOsConfiguration()),
    renderPlatformServiceArtifacts(macOsConfiguration()),
  );
  assert.deepEqual(
    renderPlatformServiceArtifacts(linuxConfiguration()),
    renderPlatformServiceArtifacts(linuxConfiguration()),
  );
});

test("persists the owner Admin auto-open choice for every login-session renderer", () => {
  const configurations = [
    windowsConfiguration({
      ownerSession: {
        ...windowsConfiguration().ownerSession,
        adminAutoOpen: {
          enabled: true,
          url: "http://127.0.0.1:43180/",
        },
      },
    }),
    macOsConfiguration({
      ownerSession: {
        ...macOsConfiguration().ownerSession,
        adminAutoOpen: {
          enabled: true,
          url: "https://admin.example.test/",
        },
      },
    }),
    linuxConfiguration({
      role: "main",
      ownerSession: {
        ...linuxConfiguration().ownerSession,
        adminAutoOpen: {
          enabled: true,
          url: "http://localhost:43180/",
        },
      },
    }),
  ] as const;

  for (const configuration of configurations) {
    const artifacts = renderPlatformServiceArtifacts(configuration);
    const runtimeFile = artifacts.files.find((file) => file.purpose === "runtime-configuration");
    assert.ok(runtimeFile);
    const runtime = JSON.parse(runtimeFile.content) as {
      role: string;
      ownerSession: {
        adminAutoOpen: {
          enabled: boolean;
          url: string;
        };
      };
    };
    assert.equal(runtime.role, "main");
    assert.deepEqual(runtime.ownerSession.adminAutoOpen, configuration.ownerSession.adminAutoOpen);
    assert.ok(artifacts.helper);
    assert.equal(artifacts.helper.bootSemantics, "login");
    assert.doesNotMatch(artifacts.core.manifest.content, /admin\.example|43180/u);
  }
});

test("manifest parsers reject widened privilege and ambiguous duplicate state", () => {
  const windows = renderPlatformServiceArtifacts(windowsConfiguration());
  const helper = windows.helper;
  assert.ok(helper);
  assert.throws(
    () =>
      parseWindowsTaskXml(
        helper.manifest.content.replace(
          "<RunLevel>LeastPrivilege</RunLevel>",
          "<RunLevel>HighestAvailable</RunLevel>",
        ),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      parseWindowsTaskXml(
        helper.manifest.content
          .replace("<Principals>", "<Settings>")
          .replace("</Principals>", "</Settings>"),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      parseWindowsTaskXml(
        helper.manifest.content.replace(
          "</LogonTrigger>",
          `${"0".repeat(70 * 1024)}</LogonTrigger>`,
        ),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      parseWindowsTaskXml(
        helper.manifest.content.replace("</LogonTrigger>", "</Principal></LogonTrigger>"),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  for (const content of [
    helper.manifest.content.replace("<Principals>", "<Principals>JUNK"),
    helper.manifest.content.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
    helper.manifest.content.replace(
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>",
    ),
  ]) {
    assert.throws(
      () => parseWindowsTaskXml(content),
      (error: unknown) =>
        error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
    );
  }

  const macos = renderPlatformServiceArtifacts(macOsConfiguration());
  assert.throws(
    () =>
      parseLaunchdPlist(
        macos.core.manifest.content.replace(
          "<key>Label</key>",
          "<key>Label</key><string>shadow</string><key>Label</key>",
        ),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () =>
      parseLaunchdPlist(
        macos.core.manifest.content.replace(
          "<dict>",
          "<dict><key>Injected</key><string>&entity;</string>",
        ),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
  const prototypeKey = parseLaunchdPlist(
    macos.core.manifest.content.replace(
      "<dict>",
      "<dict><key>__proto__</key><string>ordinary-data</string>",
    ),
  );
  assert.equal(Object.getPrototypeOf(prototypeKey), null);
  assert.equal(Object.hasOwn(prototypeKey, "__proto__"), true);
  assert.equal(prototypeKey["__proto__"], "ordinary-data");

  const linux = renderPlatformServiceArtifacts(linuxConfiguration());
  assert.throws(
    () =>
      parseSystemdUnit(
        linux.core.manifest.content.replace("User=opendelegate", "User=opendelegate\nUser=root"),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );
});

test("supervisor argv validation rejects shells and Secret references", () => {
  const windows = renderPlatformServiceArtifacts(windowsConfiguration());
  assert.throws(
    () =>
      validateSupervisorCommands([
        {
          ...windows.installCommands[0]!,
          executable: "powershell.exe",
        },
      ]),
    PlatformServiceError,
  );
  assert.throws(
    () =>
      validateSupervisorCommands([
        {
          ...windows.installCommands[0]!,
          arguments: ["create", "secret://raw-value"],
        },
      ]),
    PlatformServiceError,
  );
});
