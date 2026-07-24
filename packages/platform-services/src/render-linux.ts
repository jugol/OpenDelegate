import { posix } from "node:path";

import {
  command,
  renderRuntimeConfiguration,
  renderSecretReferences,
  serviceArguments,
} from "./render-common.ts";
import type {
  LocalIpcDefinition,
  PlatformServiceArtifacts,
  PlatformServiceDefinition,
  RenderedFile,
} from "./types.ts";

export function renderLinuxServiceArtifacts(
  definition: PlatformServiceDefinition & {
    readonly configuration: Extract<
      PlatformServiceDefinition["configuration"],
      { readonly platform: "linux" }
    >;
  },
): PlatformServiceArtifacts {
  const { configuration } = definition;
  const coreUnitName = `opendelegate-${configuration.instanceId}.service`;
  const helperUnitName = `opendelegate-${configuration.instanceId}-session-helper.service`;
  const ipc: LocalIpcDefinition = {
    kind: "unix-domain-socket",
    endpoint: posix.join(configuration.paths.runtimeRoot, "session-helper.sock"),
    authentication: "hmac-sha256-challenge",
    credentialReference: configuration.secretReferences.helperIpc ?? "",
    allowedPeers: [configuration.serviceIdentity.userName, configuration.ownerSession.stableUserId],
    socketMode: "0660",
  };
  const coreManifest: RenderedFile = {
    purpose: "core-manifest",
    path: `/etc/systemd/system/${coreUnitName}`,
    content: renderSystemUnit(definition),
    encoding: "utf8",
    mode: "0644",
  };
  const helperManifest: RenderedFile = {
    purpose: "helper-manifest",
    path: posix.join(
      configuration.ownerSession.homeDirectory ?? "",
      ".config",
      "systemd",
      "user",
      helperUnitName,
    ),
    content: renderUserUnit(definition),
    encoding: "utf8",
    mode: "0644",
  };
  const runtimeConfiguration = renderRuntimeConfiguration(definition, ipc);
  const secretReferences = renderSecretReferences(definition);
  const installCommands = [
    command("/usr/bin/systemctl", ["daemon-reload"], {
      plane: "core",
      verb: "reload",
      privilege: "elevated",
    }),
    command("/usr/bin/systemctl", ["enable", coreUnitName], {
      plane: "core",
      verb: "enable",
      privilege: "elevated",
    }),
    command("/usr/bin/systemctl", ["--user", "daemon-reload"], {
      plane: "session-helper",
      verb: "reload",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/usr/bin/systemctl", ["--user", "enable", helperUnitName], {
      plane: "session-helper",
      verb: "enable",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
  ] as const;
  const startCommands = [
    command("/usr/bin/systemctl", ["start", coreUnitName], {
      plane: "core",
      verb: "start",
      privilege: "elevated",
    }),
    command("/usr/bin/systemctl", ["--user", "start", helperUnitName], {
      plane: "session-helper",
      verb: "start",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
  ] as const;
  const stopCommands = [
    command("/usr/bin/systemctl", ["--user", "stop", helperUnitName], {
      plane: "session-helper",
      verb: "stop",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/usr/bin/systemctl", ["stop", coreUnitName], {
      plane: "core",
      verb: "stop",
      privilege: "elevated",
    }),
  ] as const;
  const removeCommands = [
    command("/usr/bin/systemctl", ["--user", "disable", helperUnitName], {
      plane: "session-helper",
      verb: "remove",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 1],
    }),
    command("/usr/bin/systemctl", ["disable", coreUnitName], {
      plane: "core",
      verb: "remove",
      privilege: "elevated",
      expectedExitCodes: [0, 1],
    }),
    command("/usr/bin/systemctl", ["daemon-reload"], {
      plane: "core",
      verb: "reload",
      privilege: "elevated",
    }),
  ] as const;
  return {
    platform: "linux",
    definition,
    core: {
      plane: "core",
      bootSemantics: "boot",
      identity: configuration.serviceIdentity.userName,
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
      arguments: serviceArguments(definition, "core"),
      requiresExternalSupervisor: true,
      restartPolicy: "on-failure",
      limitation:
        "On Linux without systemd, an owner-selected external supervisor must own restart and boot persistence; the helper remains tied to a graphical login session.",
    },
  };
}

function renderSystemUnit(definition: PlatformServiceDefinition): string {
  const configuration = definition.configuration;
  if (configuration.platform !== "linux") {
    throw new TypeError("Linux system unit requires Linux configuration.");
  }
  return `[Unit]
Description=OpenDelegate ${configuration.role} core service
Documentation=https://github.com/opendelegate/opendelegate
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${configuration.serviceIdentity.userName}
Group=${configuration.serviceIdentity.groupName}
ExecStart=${renderExecStart(definition.coreExecutablePath, serviceArguments(definition, "core"))}
WorkingDirectory=${systemdArgument(configuration.paths.runtimeRoot)}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0027
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes
ReadWritePaths=${[
    configuration.paths.stateRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
  ]
    .map((path) => systemdArgument(path))
    .join(" ")}
StandardOutput=append:${configuration.paths.logRoot}/core.stdout.log
StandardError=append:${configuration.paths.logRoot}/core.stderr.log

[Install]
WantedBy=multi-user.target
`;
}

function renderUserUnit(definition: PlatformServiceDefinition): string {
  const configuration = definition.configuration;
  if (configuration.platform !== "linux") {
    throw new TypeError("Linux user unit requires Linux configuration.");
  }
  return `[Unit]
Description=OpenDelegate graphical session helper
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${renderExecStart(definition.helperExecutablePath, serviceArguments(definition, "session-helper"))}
WorkingDirectory=${systemdArgument(configuration.paths.runtimeRoot)}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=10s
UMask=0027
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${[
    configuration.paths.stateRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
  ]
    .map((path) => systemdArgument(path))
    .join(" ")}
StandardOutput=append:${configuration.paths.logRoot}/helper.stdout.log
StandardError=append:${configuration.paths.logRoot}/helper.stderr.log

[Install]
WantedBy=graphical-session.target
`;
}

function renderExecStart(executable: string, arguments_: readonly string[]): string {
  return [executable, ...arguments_].map((value) => systemdArgument(value)).join(" ");
}

function systemdArgument(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$");
  return `"${escaped}"`;
}
