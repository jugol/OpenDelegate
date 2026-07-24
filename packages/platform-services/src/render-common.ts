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
  return {
    purpose: "runtime-configuration",
    path: definition.runtimeConfigurationPath,
    content: stableJson({
      schemaVersion: 1,
      instanceId: configuration.instanceId,
      platform: configuration.platform,
      role: configuration.role,
      stateRoot: configuration.paths.stateRoot,
      runtimeRoot: configuration.paths.runtimeRoot,
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
      localIpc: {
        kind: ipc.kind,
        endpoint: ipc.endpoint,
        authentication: ipc.authentication,
        credentialReference: ipc.credentialReference,
        credentialReferenceDocument: definition.secretReferencesPath,
        credentialReferenceKey: "helperIpc",
        allowedPeers: ipc.allowedPeers,
        ...(ipc.socketMode === undefined ? {} : { socketMode: ipc.socketMode }),
      },
      health: configuration.health,
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
