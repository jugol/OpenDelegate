import { posix } from "node:path";

import type { PlistValue } from "./manifest-parsers.ts";
import {
  command,
  renderRuntimeConfiguration,
  renderSecretReferences,
  serviceArguments,
  xmlEscape,
} from "./render-common.ts";
import type {
  LocalIpcDefinition,
  PlatformServiceArtifacts,
  PlatformServiceDefinition,
  RenderedFile,
} from "./types.ts";

export function renderMacOsServiceArtifacts(
  definition: PlatformServiceDefinition & {
    readonly configuration: Extract<
      PlatformServiceDefinition["configuration"],
      { readonly platform: "macos" }
    >;
  },
): PlatformServiceArtifacts {
  const { configuration } = definition;
  const coreLabel = `dev.opendelegate.${configuration.instanceId}.core`;
  const helperLabel = `dev.opendelegate.${configuration.instanceId}.session-helper`;
  const userDomain = `gui/${String(configuration.ownerSession.uid)}`;
  const coreDomainTarget = `system/${coreLabel}`;
  const helperDomainTarget = `${userDomain}/${helperLabel}`;
  const ipc: LocalIpcDefinition = {
    sessionHelper: "enabled",
    kind: "unix-domain-socket",
    endpoint: posix.join(configuration.paths.runtimeRoot, "session-helper.sock"),
    authentication: "ed25519-mutual-signature-v2",
    corePrivateKeyReference: configuration.secretReferences.coreIpcSigningKey ?? "",
    helperPrivateKeyReference: configuration.secretReferences.helperIpcSigningKey ?? "",
    corePublicKey: configuration.ipcTrust.core,
    helperPublicKey: configuration.ipcTrust.helper,
    allowedPeers: [configuration.serviceIdentity.userName, configuration.ownerSession.stableUserId],
    socketMode: "0660",
  };
  const coreManifest: RenderedFile = {
    purpose: "core-manifest",
    path: `/Library/LaunchDaemons/${coreLabel}.plist`,
    content: renderPlist({
      Label: coreLabel,
      ProgramArguments: [definition.coreExecutablePath, ...serviceArguments(definition, "core")],
      UserName: configuration.serviceIdentity.userName,
      GroupName: configuration.serviceIdentity.groupName,
      RunAtLoad: true,
      KeepAlive: true,
      AbandonProcessGroup: false,
      ProcessType: "Background",
      ThrottleInterval: 5,
      ExitTimeOut: 20,
      Umask: 23,
      StandardOutPath: definition.coreStdoutLogPath,
      StandardErrorPath: definition.coreStderrLogPath,
      WorkingDirectory: configuration.paths.runtimeRoot,
    }),
    encoding: "utf8",
    mode: "0644",
  };
  const helperHome = configuration.ownerSession.homeDirectory ?? "";
  const helperManifest: RenderedFile = {
    purpose: "helper-manifest",
    path: posix.join(helperHome, "Library", "LaunchAgents", `${helperLabel}.plist`),
    content: renderPlist({
      Label: helperLabel,
      ProgramArguments: [
        definition.helperExecutablePath,
        ...serviceArguments(definition, "session-helper"),
      ],
      RunAtLoad: true,
      KeepAlive: true,
      AbandonProcessGroup: false,
      ProcessType: "Interactive",
      LimitLoadToSessionType: "Aqua",
      ThrottleInterval: 5,
      ExitTimeOut: 10,
      Umask: 23,
      StandardOutPath: definition.helperStdoutLogPath,
      StandardErrorPath: definition.helperStderrLogPath,
      WorkingDirectory: configuration.paths.runtimeRoot,
    }),
    encoding: "utf8",
    mode: "0644",
  };
  const runtimeConfiguration = renderRuntimeConfiguration(definition, ipc);
  const secretReferences = renderSecretReferences(definition);
  const installCommands = [
    command("/bin/launchctl", ["enable", coreDomainTarget], {
      plane: "core",
      verb: "enable",
      privilege: "elevated",
    }),
    command("/bin/launchctl", ["bootstrap", "system", coreManifest.path], {
      plane: "core",
      verb: "install",
      privilege: "elevated",
      expectedExitCodes: [0, 5],
    }),
    command("/bin/launchctl", ["enable", helperDomainTarget], {
      plane: "session-helper",
      verb: "enable",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/bin/launchctl", ["bootstrap", userDomain, helperManifest.path], {
      plane: "session-helper",
      verb: "install",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 5],
    }),
  ] as const;
  const startCommands = [
    command("/bin/launchctl", ["enable", coreDomainTarget], {
      plane: "core",
      verb: "enable",
      privilege: "elevated",
    }),
    command("/bin/launchctl", ["bootstrap", "system", coreManifest.path], {
      plane: "core",
      verb: "start",
      privilege: "elevated",
      expectedExitCodes: [0, 5],
    }),
    command("/bin/launchctl", ["kickstart", "-k", coreDomainTarget], {
      plane: "core",
      verb: "start",
      privilege: "elevated",
    }),
    command("/bin/launchctl", ["enable", helperDomainTarget], {
      plane: "session-helper",
      verb: "enable",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/bin/launchctl", ["bootstrap", userDomain, helperManifest.path], {
      plane: "session-helper",
      verb: "start",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 5],
    }),
    command("/bin/launchctl", ["kickstart", "-k", helperDomainTarget], {
      plane: "session-helper",
      verb: "start",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
  ] as const;
  const stopCommands = [
    command("/bin/launchctl", ["bootout", helperDomainTarget], {
      plane: "session-helper",
      verb: "stop",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 3, 5],
    }),
    command("/bin/launchctl", ["disable", helperDomainTarget], {
      plane: "session-helper",
      verb: "disable",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/bin/launchctl", ["bootout", coreDomainTarget], {
      plane: "core",
      verb: "stop",
      privilege: "elevated",
      expectedExitCodes: [0, 3, 5],
    }),
    command("/bin/launchctl", ["disable", coreDomainTarget], {
      plane: "core",
      verb: "disable",
      privilege: "elevated",
    }),
  ] as const;
  const removeCommands = [
    command("/bin/launchctl", ["bootout", helperDomainTarget], {
      plane: "session-helper",
      verb: "remove",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
      expectedExitCodes: [0, 3, 5],
    }),
    command("/bin/launchctl", ["disable", helperDomainTarget], {
      plane: "session-helper",
      verb: "remove",
      privilege: "owner-session",
      availabilityPolicy: "defer-if-logged-out",
    }),
    command("/bin/launchctl", ["bootout", coreDomainTarget], {
      plane: "core",
      verb: "remove",
      privilege: "elevated",
      expectedExitCodes: [0, 3, 5],
    }),
    command("/bin/launchctl", ["disable", coreDomainTarget], {
      plane: "core",
      verb: "remove",
      privilege: "elevated",
    }),
  ] as const;
  return {
    platform: "macos",
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
      limitation: "Diagnostic foreground execution does not replace launchd boot persistence.",
    },
  };
}

function renderPlist(dictionary: Readonly<Record<string, PlistValue>>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${renderDictionary(dictionary, 0)}
</plist>
`;
}

function renderDictionary(
  dictionary: Readonly<Record<string, PlistValue>>,
  indent: number,
): string {
  const padding = "  ".repeat(indent);
  const children = Object.entries(dictionary)
    .map(
      ([key, value]) =>
        `${padding}  <key>${xmlEscape(key)}</key>\n${renderPlistValue(value, indent + 1)}`,
    )
    .join("\n");
  return `${padding}<dict>\n${children}\n${padding}</dict>`;
}

function renderPlistValue(value: PlistValue, indent: number): string {
  const padding = "  ".repeat(indent);
  if (typeof value === "string") {
    return `${padding}<string>${xmlEscape(value)}</string>`;
  }
  if (typeof value === "boolean") {
    const tag = value ? "true" : "false";
    return `${padding}<${tag}></${tag}>`;
  }
  if (typeof value === "number") {
    return `${padding}<integer>${String(value)}</integer>`;
  }
  if (Array.isArray(value)) {
    const children = value.map((entry) => renderPlistValue(entry, indent + 1)).join("\n");
    return `${padding}<array>\n${children}\n${padding}</array>`;
  }
  return renderDictionary(value as Readonly<Record<string, PlistValue>>, indent);
}
