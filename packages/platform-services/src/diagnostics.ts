import { createPlatformServiceDefinition } from "./configuration.ts";
import type { SessionHelperReadiness } from "./readiness.ts";
import type { PlatformServiceConfiguration } from "./types.ts";

export type SupervisorState =
  "failed" | "not-installed" | "not-loaded" | "running" | "starting" | "stopped" | "unknown";

export interface RollbackDiagnostic {
  readonly attemptedAt: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly outcome: "failed" | "succeeded";
  readonly failedStepId: string;
}

export interface CreateServiceDiagnosticInput {
  readonly configuration: PlatformServiceConfiguration;
  readonly activeVersion?: string;
  readonly retainedVersions: readonly string[];
  readonly coreSupervisorState: SupervisorState;
  readonly helperSupervisorState: SupervisorState;
  readonly readiness: SessionHelperReadiness;
  readonly lastRollback?: RollbackDiagnostic;
}

export interface ServiceDiagnostic {
  readonly schemaVersion: 1;
  readonly platform: PlatformServiceConfiguration["platform"];
  readonly instanceId: string;
  readonly role: PlatformServiceConfiguration["role"];
  readonly core: {
    readonly status: SupervisorState;
    readonly bootSemantics: "boot";
    readonly identity: string;
  };
  readonly helper: {
    readonly status: SupervisorState;
    readonly bootSemantics: "login";
    readonly identity: string;
  };
  readonly readiness: SessionHelperReadiness;
  readonly versions: {
    readonly active?: string;
    readonly retained: readonly string[];
  };
  readonly logs: {
    readonly core: { readonly stdout: string; readonly stderr: string };
    readonly helper: { readonly stdout: string; readonly stderr: string };
  };
  readonly ipc: {
    readonly kind: "named-pipe" | "unix-domain-socket";
    readonly endpoint: string;
    readonly authenticated: boolean;
  };
  readonly rollback?: RollbackDiagnostic;
  readonly secretValuesIncluded: false;
}

export function createServiceDiagnostic(input: CreateServiceDiagnosticInput): ServiceDiagnostic {
  const definition = createPlatformServiceDefinition(input.configuration);
  const helperConfigured = input.configuration.helperSecretBinding !== null;
  const coreIdentity =
    input.configuration.platform === "windows"
      ? `NT SERVICE\\OpenDelegate-${input.configuration.instanceId}`
      : input.configuration.serviceIdentity.userName;
  const ipc =
    input.configuration.platform === "windows"
      ? {
          kind: "named-pipe" as const,
          endpoint: `\\\\.\\pipe\\OpenDelegate\\${input.configuration.instanceId}\\session-helper`,
        }
      : {
          kind: "unix-domain-socket" as const,
          endpoint: `${input.configuration.paths.runtimeRoot}/session-helper.sock`,
        };
  return {
    schemaVersion: 1,
    platform: input.configuration.platform,
    instanceId: input.configuration.instanceId,
    role: input.configuration.role,
    core: {
      status: input.coreSupervisorState,
      bootSemantics: "boot",
      identity: coreIdentity,
    },
    helper: {
      status: helperConfigured ? input.helperSupervisorState : "not-installed",
      bootSemantics: "login",
      identity: input.configuration.ownerSession.userName,
    },
    readiness: helperConfigured
      ? {
          ...input.readiness,
          headlessWorkAvailable: input.coreSupervisorState === "running",
        }
      : {
          ...input.readiness,
          session: "helper-unavailable",
          computerUse: "unavailable",
          headlessWorkAvailable: input.coreSupervisorState === "running",
          helperProcess: "stopped",
          reason:
            "This Device is configured for headless core-only work; no Computer Use helper is installed.",
        },
    versions: {
      ...(input.activeVersion === undefined ? {} : { active: input.activeVersion }),
      retained: [...input.retainedVersions].sort((left, right) => left.localeCompare(right)),
    },
    logs: {
      core: {
        stdout: definition.coreStdoutLogPath,
        stderr: definition.coreStderrLogPath,
      },
      helper: {
        stdout: definition.helperStdoutLogPath,
        stderr: definition.helperStderrLogPath,
      },
    },
    ipc: {
      ...ipc,
      authenticated: helperConfigured,
    },
    ...(input.lastRollback === undefined ? {} : { rollback: input.lastRollback }),
    secretValuesIncluded: false,
  };
}
