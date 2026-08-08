import { win32 } from "node:path";

import {
  command,
  renderRuntimeConfiguration,
  renderSecretReferences,
  serviceArguments,
  stableJson,
  xmlEscape,
} from "./render-common.ts";
import type {
  LocalIpcDefinition,
  PlatformServiceArtifacts,
  PlatformServiceDefinition,
  RenderedFile,
} from "./types.ts";

export function renderWindowsServiceArtifacts(
  definition: PlatformServiceDefinition & {
    readonly configuration: Extract<
      PlatformServiceDefinition["configuration"],
      { readonly platform: "windows" }
    >;
  },
): PlatformServiceArtifacts {
  const { configuration } = definition;
  const serviceName = `OpenDelegate-${configuration.instanceId}`;
  const taskName = `\\OpenDelegate-${configuration.instanceId}-SessionHelper`;
  const coreIdentity = `NT SERVICE\\${serviceName}`;
  const ipc: LocalIpcDefinition = {
    sessionHelper: "enabled",
    kind: "named-pipe",
    endpoint: `\\\\.\\pipe\\OpenDelegate\\${configuration.instanceId}\\session-helper`,
    authentication: "ed25519-mutual-signature-v2",
    corePrivateKeyReference: configuration.secretReferences.coreIpcSigningKey ?? "",
    helperPrivateKeyReference: configuration.secretReferences.helperIpcSigningKey ?? "",
    corePublicKey: configuration.ipcTrust.core,
    helperPublicKey: configuration.ipcTrust.helper,
    allowedPeers: [coreIdentity, configuration.ownerSession.stableUserId],
  };
  const manifestsRoot = win32.join(configuration.paths.stateRoot, "manifests");
  const coreManifest: RenderedFile = {
    purpose: "core-manifest",
    path: win32.join(manifestsRoot, `${serviceName}.scm.json`),
    content: stableJson({
      schemaVersion: 1,
      serviceName,
      displayName: `OpenDelegate (${configuration.instanceId})`,
      description: `OpenDelegate ${configuration.role} core service`,
      account: coreIdentity,
      startup: "automatic",
      delayedAutoStart: false,
      serviceSidType: "restricted",
      requiredPrivileges: ["SeChangeNotifyPrivilege"],
      executable: definition.coreExecutablePath,
      arguments: windowsServiceArguments(definition, "core"),
      logs: {
        stdout: definition.coreStdoutLogPath,
        stderr: definition.coreStderrLogPath,
      },
    }),
    encoding: "utf8",
    mode: "0640",
  };
  const helperManifest: RenderedFile = {
    purpose: "helper-manifest",
    path: win32.join(manifestsRoot, `${serviceName}.session-helper.task.xml`),
    content: renderTaskXml(definition, configuration.ownerSession.stableUserId),
    encoding: "utf16le-bom",
    mode: "0640",
  };
  const runtimeConfiguration = renderRuntimeConfiguration(definition, ipc);
  const secretReferences = renderSecretReferences(definition);
  const coreImagePath = renderWindowsCommandLine(
    definition.coreExecutablePath,
    windowsServiceArguments(definition, "core"),
  );
  const installCommands = [
    command(
      "sc.exe",
      [
        "create",
        serviceName,
        "start=",
        "auto",
        "obj=",
        coreIdentity,
        "binPath=",
        coreImagePath,
        "DisplayName=",
        `OpenDelegate (${configuration.instanceId})`,
      ],
      {
        plane: "core",
        verb: "install",
        privilege: "elevated",
      },
    ),
    command(
      "sc.exe",
      ["description", serviceName, `OpenDelegate ${configuration.role} core service`],
      { plane: "core", verb: "install", privilege: "elevated" },
    ),
    command("sc.exe", ["sidtype", serviceName, "restricted"], {
      plane: "core",
      verb: "install",
      privilege: "elevated",
    }),
    command("sc.exe", ["privs", serviceName, "SeChangeNotifyPrivilege"], {
      plane: "core",
      verb: "install",
      privilege: "elevated",
    }),
    command(
      "sc.exe",
      ["failure", serviceName, "reset=", "86400", "actions=", "restart/5000/restart/15000"],
      { plane: "core", verb: "install", privilege: "elevated" },
    ),
    command("schtasks.exe", ["/Create", "/TN", taskName, "/XML", helperManifest.path], {
      plane: "session-helper",
      verb: "install",
      privilege: "elevated",
    }),
  ] as const;
  const startCommands = [
    command("sc.exe", ["start", serviceName], {
      plane: "core",
      verb: "start",
      privilege: "elevated",
      expectedExitCodes: [0, 1056],
    }),
    command("schtasks.exe", ["/Run", "/TN", taskName], {
      plane: "session-helper",
      verb: "start",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
  ] as const;
  const stopCommands = [
    command("schtasks.exe", ["/End", "/TN", taskName], {
      plane: "session-helper",
      verb: "stop",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 1],
    }),
    command("sc.exe", ["stop", serviceName], {
      plane: "core",
      verb: "stop",
      privilege: "elevated",
      expectedExitCodes: [0, 1062],
    }),
  ] as const;
  const removeCommands = [
    command("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
      plane: "session-helper",
      verb: "remove",
      privilege: "elevated",
      expectedExitCodes: [0, 1],
    }),
    command("sc.exe", ["delete", serviceName], {
      plane: "core",
      verb: "remove",
      privilege: "elevated",
      expectedExitCodes: [0, 1060],
    }),
  ] as const;
  return {
    platform: "windows",
    definition,
    core: {
      plane: "core",
      bootSemantics: "boot",
      identity: coreIdentity,
      manifest: coreManifest,
      stdoutLogPath: definition.coreStdoutLogPath,
      stderrLogPath: definition.coreStderrLogPath,
    },
    helper: {
      plane: "session-helper",
      bootSemantics: "login",
      identity: configuration.ownerSession.userName,
      manifest: helperManifest,
      stdoutLogPath: definition.helperStdoutLogPath,
      stderrLogPath: definition.helperStderrLogPath,
    },
    ipc,
    files: [runtimeConfiguration, secretReferences, coreManifest, helperManifest],
    installCommands,
    startCommands,
    stopCommands,
    removeCommands,
    foregroundFallback: {
      command: definition.coreExecutablePath,
      arguments: windowsServiceArguments(definition, "core"),
      requiresExternalSupervisor: true,
      restartPolicy: "on-failure",
      limitation: "Diagnostic foreground execution does not replace Windows SCM persistence.",
    },
  };
}

function renderTaskXml(definition: PlatformServiceDefinition, ownerSid: string): string {
  const helperArguments = windowsServiceArguments(definition, "session-helper")
    .map((argument) => quoteWindowsArgument(argument))
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>OpenDelegate</Author>
    <Description>OpenDelegate per-user graphical session helper</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Owner">
      <UserId>${xmlEscape(ownerSid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Owner">
    <Exec>
      <Command>${xmlEscape(definition.helperExecutablePath)}</Command>
      <Arguments>${xmlEscape(helperArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function windowsServiceArguments(
  definition: PlatformServiceDefinition,
  plane: "core" | "session-helper",
): readonly string[] {
  const stdoutLogPath =
    plane === "core" ? definition.coreStdoutLogPath : definition.helperStdoutLogPath;
  const stderrLogPath =
    plane === "core" ? definition.coreStderrLogPath : definition.helperStderrLogPath;
  return [
    ...serviceArguments(definition, plane),
    "--stdout-log",
    stdoutLogPath,
    "--stderr-log",
    stderrLogPath,
  ];
}

function renderWindowsCommandLine(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map((argument) => quoteWindowsArgument(argument)).join(" ");
}

function quoteWindowsArgument(argument: string): string {
  if (argument !== "" && !/[\s"]/u.test(argument)) {
    return argument;
  }
  let output = '"';
  let slashCount = 0;
  for (const character of argument) {
    if (character === "\\") {
      slashCount += 1;
      continue;
    }
    if (character === '"') {
      output += `${"\\".repeat(slashCount * 2 + 1)}"`;
      slashCount = 0;
      continue;
    }
    output += `${"\\".repeat(slashCount)}${character}`;
    slashCount = 0;
  }
  output += `${"\\".repeat(slashCount * 2)}"`;
  return output;
}
