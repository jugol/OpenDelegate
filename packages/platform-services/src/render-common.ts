import { posix, win32 } from "node:path";

import type {
  CommandInvocation,
  LocalIpcDefinition,
  PlatformServiceDefinition,
  RenderedFile,
  RuntimePlane,
} from "./types.ts";

export function renderRuntimeConfiguration(
  definition: PlatformServiceDefinition,
  ipc: LocalIpcDefinition,
): RenderedFile {
  const { configuration } = definition;
  const localIpc =
    ipc.sessionHelper === "disabled"
      ? {
          kind: ipc.kind,
          endpoint: ipc.endpoint,
          authentication: ipc.authentication,
          sessionHelper: "disabled" as const,
          credentialReferenceDocument: definition.secretReferencesPath,
          core: {
            privateKeyReference: ipc.corePrivateKeyReference,
            privateKeyReferenceKey: "coreIpcSigningKey",
            keyId: ipc.corePublicKey.keyId,
            publicKeySpkiBase64Url: ipc.corePublicKey.publicKeySpkiBase64Url,
          },
          allowedPeers: ipc.allowedPeers,
          ...(ipc.socketMode === undefined ? {} : { socketMode: ipc.socketMode }),
        }
      : {
          kind: ipc.kind,
          endpoint: ipc.endpoint,
          authentication: ipc.authentication,
          sessionHelper: "enabled" as const,
          credentialReferenceDocument: definition.secretReferencesPath,
          core: {
            privateKeyReference: ipc.corePrivateKeyReference,
            privateKeyReferenceKey: "coreIpcSigningKey",
            keyId: ipc.corePublicKey.keyId,
            publicKeySpkiBase64Url: ipc.corePublicKey.publicKeySpkiBase64Url,
            peerKeyId: ipc.helperPublicKey.keyId,
            peerPublicKeySpkiBase64Url: ipc.helperPublicKey.publicKeySpkiBase64Url,
            peerIdentity: ipc.allowedPeers[1]!,
          },
          helper: {
            privateKeyReference: ipc.helperPrivateKeyReference,
            privateKeyReferenceKey: "helperIpcSigningKey",
            keyId: ipc.helperPublicKey.keyId,
            publicKeySpkiBase64Url: ipc.helperPublicKey.publicKeySpkiBase64Url,
            peerKeyId: ipc.corePublicKey.keyId,
            peerPublicKeySpkiBase64Url: ipc.corePublicKey.publicKeySpkiBase64Url,
            peerIdentity: ipc.allowedPeers[0]!,
          },
          allowedPeers: ipc.allowedPeers,
          ...(ipc.socketMode === undefined ? {} : { socketMode: ipc.socketMode }),
        };
  return {
    purpose: "runtime-configuration",
    path: definition.runtimeConfigurationPath,
    content: stableJson({
      schemaVersion: 3,
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      platform: configuration.platform,
      role: configuration.role,
      releaseVersion: configuration.bundle.version,
      releaseRoot: definition.activeDirectory,
      stateRoot: configuration.paths.stateRoot,
      authorityRoot: configuration.paths.authorityRoot,
      runtimeRoot: configuration.paths.runtimeRoot,
      ownerSession: {
        ...configuration.ownerSession,
        adminAutoOpen: configuration.ownerSession.adminAutoOpen,
      },
      ...(configuration.platform === "windows"
        ? { agentProviderAccess: configuration.agentProviderAccess }
        : {}),
      helperSecretBinding: configuration.helperSecretBinding,
      logs: {
        core: {
          stdout: definition.coreStdoutLogPath,
          stderr: definition.coreStderrLogPath,
        },
        sessionHelper: {
          stdout: definition.helperStdoutLogPath,
          stderr: definition.helperStderrLogPath,
        },
      },
      localIpc,
      health: configuration.health,
      ...(!("serviceSecretBinding" in configuration) ||
      configuration.serviceSecretBinding === undefined
        ? {}
        : { serviceSecretBinding: configuration.serviceSecretBinding }),
    }),
    encoding: "utf8",
    mode: "0640",
  };
}

export function renderSecretReferences(definition: PlatformServiceDefinition): RenderedFile {
  return {
    purpose: "secret-references",
    path: definition.secretReferencesPath,
    content: stableJson({
      schemaVersion: 1,
      references: definition.configuration.secretReferences,
    }),
    encoding: "utf8",
    mode: "0600",
  };
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), undefined, 2)}\n`;
}

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function command(
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly plane: RuntimePlane;
    readonly verb: CommandInvocation["verb"];
    readonly privilege: CommandInvocation["privilege"];
    readonly availabilityPolicy?: CommandInvocation["availabilityPolicy"];
    readonly expectedExitCodes?: readonly number[];
    readonly timeoutMs?: number;
  },
): CommandInvocation {
  return {
    executable,
    arguments: arguments_,
    plane: options.plane,
    verb: options.verb,
    privilege: options.privilege,
    availabilityPolicy: options.availabilityPolicy ?? "required",
    timeoutMs: options.timeoutMs ?? 30_000,
    expectedExitCodes: options.expectedExitCodes ?? [0],
  };
}

export function serviceArguments(
  definition: PlatformServiceDefinition,
  plane: RuntimePlane,
): readonly string[] {
  return [
    "--plane",
    plane,
    "--role",
    definition.configuration.role,
    "--config",
    definition.runtimeConfigurationPath,
  ];
}

export function joinForPlatform(
  platform: PlatformServiceDefinition["configuration"]["platform"],
  ...parts: string[]
): string {
  return platform === "windows" ? win32.join(...parts) : posix.join(...parts);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}
