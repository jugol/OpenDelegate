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
  const helperEnabled = configuration.helperSecretBinding !== null;
  const ipc: LocalIpcDefinition = helperEnabled
    ? {
        sessionHelper: "enabled",
        kind: "unix-domain-socket",
        endpoint: posix.join(configuration.paths.runtimeRoot, "session-helper.sock"),
        authentication: "ed25519-mutual-signature-v2",
        corePrivateKeyReference: configuration.secretReferences.coreIpcSigningKey ?? "",
        helperPrivateKeyReference: configuration.secretReferences.helperIpcSigningKey ?? "",
        corePublicKey: configuration.ipcTrust.core,
        helperPublicKey: configuration.ipcTrust.helper!,
        allowedPeers: [
          configuration.serviceIdentity.userName,
          configuration.ownerSession.stableUserId,
        ],
        socketMode: "0660",
      }
    : {
        sessionHelper: "disabled",
        kind: "unix-domain-socket",
        endpoint: posix.join(configuration.paths.runtimeRoot, "session-helper.sock"),
        authentication: "ed25519-mutual-signature-v2",
        corePrivateKeyReference: configuration.secretReferences.coreIpcSigningKey ?? "",
        corePublicKey: configuration.ipcTrust.core,
        allowedPeers: [configuration.serviceIdentity.userName],
        socketMode: "0660",
      };
  const coreManifest: RenderedFile = {
    purpose: "core-manifest",
    path: `/etc/systemd/system/${coreUnitName}`,
    content: renderSystemUnit(definition),
    encoding: "utf8",
    mode: "0644",
  };
  const helperManifest: RenderedFile | null = helperEnabled
    ? {
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
      }
    : null;
  const runtimeConfiguration = renderRuntimeConfiguration(definition, ipc);
  const secretReferences = renderSecretReferences(definition);
  const coreInstallCommands = [
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
  ] as const;
  const helperInstallCommands = helperEnabled
    ? [
        command("/usr/bin/systemctl", ["--user", "daemon-reload"], {
          plane: "session-helper",
          verb: "reload",
          privilege: "owner-session",
          availabilityPolicy: "defer-if-logged-out",
        }),
        command("/usr/bin/systemctl", ["--user", "--no-reload", "enable", helperUnitName], {
          plane: "session-helper",
          verb: "enable",
          privilege: "owner-session",
        }),
      ]
    : [];
  const installCommands = [...coreInstallCommands, ...helperInstallCommands];
  const coreStartCommands = [
    command("/usr/bin/systemctl", ["start", coreUnitName], {
      plane: "core",
      verb: "start",
      privilege: "elevated",
    }),
  ] as const;
  const startCommands = helperEnabled
    ? [
        ...coreStartCommands,
        command("/usr/bin/systemctl", ["--user", "start", helperUnitName], {
          plane: "session-helper",
          verb: "start",
          privilege: "owner-session",
          availabilityPolicy: "defer-if-logged-out",
        }),
      ]
    : [...coreStartCommands];
  const coreStopCommands = [
    command("/usr/bin/systemctl", ["stop", coreUnitName], {
      plane: "core",
      verb: "stop",
      privilege: "elevated",
    }),
  ] as const;
  const stopCommands = helperEnabled
    ? [
        command("/usr/bin/systemctl", ["--user", "stop", helperUnitName], {
          plane: "session-helper",
          verb: "stop",
          privilege: "owner-session",
          availabilityPolicy: "defer-if-logged-out",
        }),
        ...coreStopCommands,
      ]
    : [...coreStopCommands];
  const coreRemoveCommands = [
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
  const removeCommands = helperEnabled
    ? [
        command("/usr/bin/systemctl", ["--user", "--no-reload", "disable", helperUnitName], {
          plane: "session-helper",
          verb: "remove",
          privilege: "owner-session",
          expectedExitCodes: [0, 1],
        }),
        ...coreRemoveCommands,
      ]
    : [...coreRemoveCommands];
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
    helper:
      helperManifest === null
        ? null
        : {
            plane: "session-helper",
            bootSemantics: "login",
            identity: configuration.ownerSession.userName,
            manifest: helperManifest,
            stdoutLogPath: definition.helperStdoutLogPath,
            stderrLogPath: definition.helperStderrLogPath,
          },
    ipc,
    files:
      helperManifest === null
        ? [runtimeConfiguration, secretReferences, coreManifest]
        : [runtimeConfiguration, secretReferences, coreManifest, helperManifest],
    installCommands,
    startCommands,
    stopCommands,
    removeCommands,
    foregroundFallback: {
      command: definition.coreExecutablePath,
      arguments: serviceArguments(definition, "core"),
      requiresExternalSupervisor: true,
      restartPolicy: "on-failure",
      limitation: helperEnabled
        ? "On Linux without systemd, an owner-selected external supervisor must own restart and boot persistence; the helper remains tied to a graphical login session."
        : "On Linux without systemd, an owner-selected external supervisor must own restart and boot persistence; this headless configuration deliberately has no Computer Use helper.",
    },
  };
}

function renderSystemUnit(definition: PlatformServiceDefinition): string {
  const configuration = definition.configuration;
  if (configuration.platform !== "linux") {
    throw new TypeError("Linux system unit requires Linux configuration.");
  }
  const credential =
    configuration.systemdCredential == null
      ? ""
      : `LoadCredentialEncrypted=${systemdArgument(
          `${configuration.systemdCredential.credentialName}:${configuration.systemdCredential.encryptedSourcePath}`,
        )}
PrivateMounts=yes
`;
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
KillMode=control-group
UMask=0027
NoNewPrivileges=yes
PrivateTmp=yes
${credential}ProtectSystem=strict
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
KillMode=control-group
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
