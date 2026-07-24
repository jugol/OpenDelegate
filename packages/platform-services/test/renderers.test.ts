import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformServiceError,
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
  assert.equal(artifacts.core.bootSemantics, "boot");
  assert.equal(artifacts.helper.bootSemantics, "login");
  assert.equal(artifacts.core.identity, "NT SERVICE\\OpenDelegate-personal");
  assert.notEqual(artifacts.core.identity, "LocalSystem");
  assert.match(artifacts.ipc.endpoint, /^\\\\\.\\pipe\\/);
  assert.equal(artifacts.ipc.authentication, "hmac-sha256-challenge");

  const task = parseWindowsTaskXml(artifacts.helper.manifest.content);
  assert.equal(task.logonType, "InteractiveToken");
  assert.equal(task.runLevel, "LeastPrivilege");
  assert.equal(task.trigger, "LogonTrigger");
  assert.equal(task.userId, "S-1-5-21-1000");
  assert.equal(artifacts.helper.manifest.encoding, "utf16le-bom");
  assert.match(task.command, /\\current\\bin\\opendelegate-session-helper\.exe$/i);

  assert.ok(
    artifacts.installCommands.some(
      (command) =>
        command.executable.toLowerCase() === "sc.exe" && command.arguments.includes("create"),
    ),
  );
  assert.ok(
    artifacts.installCommands.some(
      (command) =>
        command.executable.toLowerCase() === "schtasks.exe" && command.arguments.includes("/XML"),
    ),
  );
  validateSupervisorCommands(artifacts.installCommands);

  const rendered = artifacts.files.map((file) => file.content).join("\n");
  assert.match(rendered, /secret:\/\/windows\/helper-ipc/);
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
  const daemon = parseLaunchdPlist(artifacts.core.manifest.content);
  const agent = parseLaunchdPlist(artifacts.helper.manifest.content);

  assert.equal(daemon.Label, "dev.opendelegate.personal.core");
  assert.equal(daemon.UserName, "_opendelegate");
  assert.equal(daemon.GroupName, "_opendelegate");
  assert.equal(daemon.RunAtLoad, true);
  assert.equal(daemon.KeepAlive, true);
  assert.match(String(daemon.StandardOutPath), /core\.stdout\.log$/);
  assert.match(String(daemon.StandardErrorPath), /core\.stderr\.log$/);

  assert.equal(agent.Label, "dev.opendelegate.personal.session-helper");
  assert.equal(agent.LimitLoadToSessionType, "Aqua");
  assert.equal(agent.RunAtLoad, true);
  assert.equal(agent.KeepAlive, true);
  assert.equal(Object.hasOwn(agent, "UserName"), false);
  assert.match(String(agent.StandardOutPath), /helper\.stdout\.log$/);
  assert.match(artifacts.ipc.endpoint, /^\/var\/run\/opendelegate\//);
  assert.equal(artifacts.ipc.socketMode, "0660");
});

test("renders hardened system and graphical-user systemd units", () => {
  const artifacts = renderPlatformServiceArtifacts(linuxConfiguration());
  assert.equal(artifacts.platform, "linux");
  const core = parseSystemdUnit(artifacts.core.manifest.content);
  const helper = parseSystemdUnit(artifacts.helper.manifest.content);

  assert.equal(core.Service?.User, "opendelegate");
  assert.equal(core.Service?.Group, "opendelegate");
  assert.equal(core.Service?.NoNewPrivileges, "yes");
  assert.equal(core.Service?.ProtectSystem, "strict");
  assert.equal(core.Service?.PrivateTmp, "yes");
  assert.equal(core.Service?.StandardOutput, "append:/var/log/opendelegate/core.stdout.log");
  assert.equal(core.Install?.WantedBy, "multi-user.target");

  assert.equal(helper.Service?.User, undefined);
  assert.equal(helper.Unit?.PartOf, "graphical-session.target");
  assert.equal(helper.Install?.WantedBy, "graphical-session.target");
  assert.equal(helper.Service?.NoNewPrivileges, "yes");
  assert.equal(helper.Service?.StandardError, "append:/var/log/opendelegate/helper.stderr.log");
  assert.match(artifacts.foregroundFallback.command, /opendelegate-service-host$/);
  assert.equal(artifacts.foregroundFallback.requiresExternalSupervisor, true);
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

test("manifest parsers reject widened privilege and ambiguous duplicate state", () => {
  const windows = renderPlatformServiceArtifacts(windowsConfiguration());
  assert.throws(
    () =>
      parseWindowsTaskXml(
        windows.helper.manifest.content.replace(
          "<RunLevel>LeastPrivilege</RunLevel>",
          "<RunLevel>HighestAvailable</RunLevel>",
        ),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
  );

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
