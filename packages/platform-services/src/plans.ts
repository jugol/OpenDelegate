import { posix, win32 } from "node:path";

import { renderPlatformServiceArtifacts } from "./render.ts";
import { stableJson } from "./render-common.ts";
import {
  PlatformServiceError,
  type CommandInvocation,
  type PlatformFamily,
  type PlatformServiceArtifacts,
  type PlatformServiceConfiguration,
  type RenderedFile,
  type RuntimePlane,
  type ServiceOperation,
} from "./types.ts";

export interface SupervisorOperation {
  readonly platform: PlatformFamily;
  readonly plane: RuntimePlane;
  readonly verb: "install" | "remove" | "start" | "stop";
  readonly invocations: readonly CommandInvocation[];
  readonly deferWhenLoggedOut: boolean;
}

export type DirectoryPermission = "full-control" | "read-execute" | "read-write";

export interface DirectoryAccessGrant {
  readonly principal: string;
  readonly permission: DirectoryPermission;
}

export interface DirectoryAccessPolicy {
  readonly owner: string;
  readonly grants: readonly DirectoryAccessGrant[];
  readonly denyUnlisted: true;
}

export type PlanAction =
  | {
      readonly kind: "account.ensure";
      readonly platform: "linux" | "macos";
      readonly userName: string;
      readonly groupName: string;
      readonly memberUserNames: readonly string[];
      readonly systemAccount: true;
      readonly interactiveLogin: false;
    }
  | {
      readonly kind: "account.remove";
      readonly platform: "linux" | "macos";
      readonly userName: string;
      readonly groupName: string;
    }
  | {
      readonly kind: "activation.switch";
      readonly activeDirectory: string;
      readonly targetReleaseDirectory: string;
      readonly atomic: true;
    }
  | {
      readonly kind: "directory.ensure";
      readonly path: string;
      readonly mode: "0700" | "0750" | "0770";
      readonly access: DirectoryAccessPolicy;
    }
  | {
      readonly kind: "directory.access-grant";
      readonly path: string;
      readonly principal: string;
      readonly permission: "read-execute" | "read-write";
      readonly recursive: true;
      readonly preserveExistingAccess: true;
      readonly missingPathPolicy: "skip";
    }
  | {
      readonly kind: "file.write";
      readonly file: RenderedFile;
      readonly atomic: true;
    }
  | {
      readonly kind: "health.check";
      readonly plane: RuntimePlane;
      readonly endpoint: string;
      readonly timeoutMs: number;
      readonly policy: "required" | "defer-if-logged-out";
    }
  | {
      readonly kind: "path.remove";
      readonly path: string;
      readonly recursive: boolean;
    }
  | {
      readonly kind: "release.promote";
      readonly stagingDirectory: string;
      readonly releaseDirectory: string;
      readonly atomic: true;
    }
  | {
      readonly kind: "release.prune";
      readonly releasesRoot: string;
      readonly activeVersion: string;
      readonly retainPreviousVersions: number;
    }
  | {
      readonly kind: "release.remove";
      readonly releaseDirectory: string;
    }
  | {
      readonly kind: "release.stage";
      readonly sourceDirectory: string;
      readonly stagingDirectory: string;
      readonly checksum: string;
    }
  | {
      readonly kind: "release.verify";
      readonly stagingDirectory: string;
      readonly checksum: string;
      readonly requireBundledRuntime: true;
      readonly requireSignedManifest: true;
    }
  | {
      readonly kind: "supervisor.invoke";
      readonly command: SupervisorOperation;
    };

export interface ServicePlanStep {
  readonly id: string;
  readonly description: string;
  readonly action: PlanAction;
  readonly rollback?: PlanAction;
}

export interface ServicePlan {
  readonly schemaVersion: 1;
  readonly operation: ServiceOperation;
  readonly platform: PlatformFamily;
  readonly instanceId: string;
  readonly fromVersion?: string;
  readonly toVersion: string;
  readonly requiresElevation: true;
  readonly steps: readonly ServicePlanStep[];
  readonly notes: readonly string[];
}

export type CreateServicePlanInput =
  | {
      readonly operation: "install";
      readonly configuration: PlatformServiceConfiguration;
    }
  | {
      readonly operation: "reconfigure";
      readonly configuration: PlatformServiceConfiguration;
      readonly previousConfiguration: PlatformServiceConfiguration;
      readonly activeVersion: string;
    }
  | {
      readonly operation: "restart" | "start" | "stop";
      readonly configuration: PlatformServiceConfiguration;
      readonly activeVersion: string;
    }
  | {
      readonly operation: "upgrade";
      readonly configuration: PlatformServiceConfiguration;
      readonly activeVersion: string;
    }
  | {
      readonly operation: "uninstall";
      readonly configuration: PlatformServiceConfiguration;
      readonly activeVersion: string;
      readonly purgeState?: boolean;
    };

export function createServicePlan(input: CreateServicePlanInput): ServicePlan {
  const artifacts = renderPlatformServiceArtifacts(input.configuration);
  if (input.operation === "install") {
    return installPlan(artifacts);
  }
  validateActiveVersion(input.activeVersion);
  if (input.operation !== "upgrade" && input.activeVersion !== input.configuration.bundle.version) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Lifecycle commands require the configured bundle version to match the active version.",
    );
  }
  if (input.operation === "reconfigure") {
    const previousArtifacts = renderPlatformServiceArtifacts(input.previousConfiguration);
    assertAdminAutoOpenOnlyReconfiguration(input.configuration, input.previousConfiguration);
    return reconfigurePlan(artifacts, previousArtifacts, input.activeVersion);
  }
  if (input.operation === "start") {
    return lifecyclePlan(artifacts, "start", input.activeVersion);
  }
  if (input.operation === "stop") {
    return lifecyclePlan(artifacts, "stop", input.activeVersion);
  }
  if (input.operation === "restart") {
    return restartPlan(artifacts, input.activeVersion);
  }
  if (input.operation === "upgrade") {
    return upgradePlan(artifacts, input.activeVersion);
  }
  if (input.operation === "uninstall") {
    return uninstallPlan(artifacts, input.activeVersion, input.purgeState ?? false);
  }
  throw new PlatformServiceError("INVALID_CONFIGURATION", "Unsupported service operation.");
}

function installPlan(artifacts: PlatformServiceArtifacts): ServicePlan {
  const configuration = artifacts.definition.configuration;
  const steps: ServicePlanStep[] = [];
  if (configuration.platform !== "windows") {
    steps.push({
      id: "ensure-service-account",
      description: "Ensure the non-interactive least-privilege core service account.",
      action: {
        kind: "account.ensure",
        platform: configuration.platform,
        userName: configuration.serviceIdentity.userName,
        groupName: configuration.serviceIdentity.groupName,
        memberUserNames: [configuration.ownerSession.userName],
        systemAccount: true,
        interactiveLogin: false,
      },
    });
  } else {
    steps.push(supervisorStep("install-core", artifacts, "core", "install", "remove"));
  }
  steps.push(
    directoryStep(
      "ensure-install-root",
      configuration.paths.installRoot,
      "0750",
      directoryAccess(configuration, "read-execute"),
    ),
    directoryStep(
      "ensure-state-root",
      configuration.paths.stateRoot,
      "0750",
      directoryAccess(configuration, "state"),
    ),
    ...(configuration.platform === "windows" && configuration.serviceSecretBinding !== undefined
      ? [
          directoryStep(
            "ensure-service-secret-vault",
            configuration.serviceSecretBinding.vaultRoot,
            "0700",
            directoryAccess(configuration, "service-secret"),
          ),
        ]
      : []),
    directoryStep(
      "ensure-config-root",
      pathJoin(configuration.platform, configuration.paths.stateRoot, "config"),
      "0750",
      directoryAccess(configuration, "state"),
    ),
    directoryStep(
      "ensure-manifest-root",
      pathJoin(configuration.platform, configuration.paths.stateRoot, "manifests"),
      "0750",
      directoryAccess(configuration, "state"),
    ),
    directoryStep(
      "ensure-authority-root",
      configuration.paths.authorityRoot,
      "0700",
      directoryAccess(configuration, "state"),
    ),
    directoryStep(
      "ensure-runtime-root",
      configuration.paths.runtimeRoot,
      "0770",
      directoryAccess(configuration, "shared"),
    ),
    directoryStep(
      "ensure-log-root",
      configuration.paths.logRoot,
      "0770",
      directoryAccess(configuration, "shared"),
    ),
    directoryStep(
      "ensure-release-root",
      pathJoin(configuration.platform, configuration.paths.installRoot, "releases"),
      "0750",
      directoryAccess(configuration, "read-execute"),
    ),
    directoryStep(
      "ensure-staging-root",
      pathJoin(configuration.platform, configuration.paths.installRoot, ".staging"),
      "0700",
      directoryAccess(configuration, "installer-only"),
    ),
    ...windowsAgentProviderAccessSteps(configuration),
    ...windowsAgentSandboxSteps(configuration),
    ...releaseInstallSteps(artifacts),
    ...artifacts.files.map((file): ServicePlanStep => ({
      id: `write-${file.purpose}`,
      description: `Atomically write ${file.purpose}.`,
      action: { kind: "file.write", file, atomic: true },
      rollback: { kind: "path.remove", path: file.path, recursive: false },
    })),
  );
  if (configuration.platform !== "windows") {
    steps.push(supervisorStep("install-core", artifacts, "core", "install", "remove"));
  }
  if (hasSessionHelper(artifacts)) {
    steps.push(supervisorStep("install-helper", artifacts, "session-helper", "install", "remove"));
  }
  steps.push(supervisorStep("start-core", artifacts, "core", "start", "stop"));
  if (hasSessionHelper(artifacts)) {
    steps.push(supervisorStep("start-helper", artifacts, "session-helper", "start", "stop"));
  }
  steps.push(healthStep("health-core", artifacts, "core"));
  if (hasSessionHelper(artifacts)) {
    steps.push(healthStep("health-helper", artifacts, "session-helper"));
  }
  steps.push(pruneStep(artifacts));
  return plan("install", artifacts, steps, [
    hasSessionHelper(artifacts)
      ? "The core plane starts at boot; the session helper starts only in the configured owner's login session."
      : "This headless Linux installation starts only the core plane; Computer Use is explicitly unavailable.",
    "Release activation uses an atomic current pointer and retains prior healthy versions.",
  ]);
}

function lifecyclePlan(
  artifacts: PlatformServiceArtifacts,
  operation: "start" | "stop",
  activeVersion: string,
): ServicePlan {
  const steps =
    operation === "start"
      ? [
          ...windowsAgentProviderAccessSteps(artifacts.definition.configuration),
          ...windowsAgentSandboxSteps(artifacts.definition.configuration),
          supervisorStep("start-core", artifacts, "core", "start", "stop"),
          ...(hasSessionHelper(artifacts)
            ? [supervisorStep("start-helper", artifacts, "session-helper", "start", "stop")]
            : []),
          healthStep("health-core", artifacts, "core"),
          ...(hasSessionHelper(artifacts)
            ? [healthStep("health-helper", artifacts, "session-helper")]
            : []),
        ]
      : [
          ...(hasSessionHelper(artifacts)
            ? [supervisorStep("stop-helper", artifacts, "session-helper", "stop")]
            : []),
          supervisorStep("stop-core", artifacts, "core", "stop"),
        ];
  return plan(operation, artifacts, steps, [], activeVersion);
}

function restartPlan(artifacts: PlatformServiceArtifacts, activeVersion: string): ServicePlan {
  return plan(
    "restart",
    artifacts,
    [
      ...(hasSessionHelper(artifacts)
        ? [supervisorStep("stop-helper", artifacts, "session-helper", "stop", "start")]
        : []),
      supervisorStep("stop-core", artifacts, "core", "stop", "start"),
      ...windowsAgentProviderAccessSteps(artifacts.definition.configuration),
      ...windowsAgentSandboxSteps(artifacts.definition.configuration),
      supervisorStep("start-core", artifacts, "core", "start", "stop"),
      ...(hasSessionHelper(artifacts)
        ? [supervisorStep("start-helper", artifacts, "session-helper", "start", "stop")]
        : []),
      healthStep("health-core", artifacts, "core"),
      ...(hasSessionHelper(artifacts)
        ? [healthStep("health-helper", artifacts, "session-helper")]
        : []),
    ],
    [],
    activeVersion,
  );
}

function reconfigurePlan(
  artifacts: PlatformServiceArtifacts,
  previousArtifacts: PlatformServiceArtifacts,
  activeVersion: string,
): ServicePlan {
  if (!hasSessionHelper(artifacts) || !hasSessionHelper(previousArtifacts)) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Admin login reconfiguration requires an installed owner-session helper.",
    );
  }
  const runtimeConfiguration = requireRenderedFile(artifacts, "runtime-configuration");
  const previousRuntimeConfiguration = requireRenderedFile(
    previousArtifacts,
    "runtime-configuration",
  );
  return plan(
    "reconfigure",
    artifacts,
    [
      supervisorStep("stop-helper", artifacts, "session-helper", "stop", "start"),
      {
        id: "update-runtime-configuration",
        description: "Atomically update the effective owner-session runtime configuration.",
        action: {
          kind: "file.write",
          file: runtimeConfiguration,
          atomic: true,
        },
        rollback: {
          kind: "file.write",
          file: previousRuntimeConfiguration,
          atomic: true,
        },
      },
      supervisorStep("start-helper", artifacts, "session-helper", "start", "stop"),
      healthStep("health-helper", artifacts, "session-helper"),
    ],
    [
      "Only the persisted Main owner Admin auto-open preference may change.",
      "The headless core remains running while the owner-session helper reloads its configuration.",
    ],
    activeVersion,
  );
}

function upgradePlan(artifacts: PlatformServiceArtifacts, activeVersion: string): ServicePlan {
  const { definition } = artifacts;
  if (activeVersion === definition.configuration.bundle.version) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Upgrade target must differ from the active version.",
    );
  }
  const previousReleaseDirectory = pathJoin(
    definition.configuration.platform,
    definition.configuration.paths.installRoot,
    "releases",
    activeVersion,
  );
  const targetRuntimeConfiguration = requireRenderedFile(artifacts, "runtime-configuration");
  const previousArtifacts = renderPlatformServiceArtifacts({
    ...definition.configuration,
    bundle: {
      ...definition.configuration.bundle,
      version: activeVersion,
    },
  });
  const previousRuntimeConfiguration = requireRenderedFile(
    previousArtifacts,
    "runtime-configuration",
  );
  const steps: ServicePlanStep[] = [
    {
      id: "stage-release",
      description: "Copy the new release into an isolated staging directory.",
      action: {
        kind: "release.stage",
        sourceDirectory: definition.configuration.bundle.sourceDirectory,
        stagingDirectory: definition.stagingDirectory,
        checksum: definition.configuration.bundle.checksum,
      },
      rollback: {
        kind: "release.remove",
        releaseDirectory: definition.stagingDirectory,
      },
    },
    {
      id: "verify-release",
      description: "Verify release integrity and the bundled pinned runtime.",
      action: {
        kind: "release.verify",
        stagingDirectory: definition.stagingDirectory,
        checksum: definition.configuration.bundle.checksum,
        requireBundledRuntime: true,
        requireSignedManifest: true,
      },
    },
    {
      id: "promote-release",
      description: "Atomically promote the verified staging directory.",
      action: {
        kind: "release.promote",
        stagingDirectory: definition.stagingDirectory,
        releaseDirectory: definition.releaseDirectory,
        atomic: true,
      },
      rollback: {
        kind: "release.remove",
        releaseDirectory: definition.releaseDirectory,
      },
    },
    ...(definition.configuration.platform === "windows"
      ? [
          directoryStep(
            "secure-release-root",
            definition.releaseDirectory,
            "0750",
            directoryAccess(definition.configuration, "read-execute"),
          ),
        ]
      : []),
    ...(hasSessionHelper(artifacts)
      ? [supervisorStep("stop-helper", artifacts, "session-helper", "stop", "start")]
      : []),
    supervisorStep("stop-core", artifacts, "core", "stop", "start"),
    ...windowsAgentProviderAccessSteps(definition.configuration),
    ...windowsAgentSandboxSteps(definition.configuration),
    ...(definition.configuration.platform === "windows"
      ? [
          windowsServiceSidRepairStep(artifacts),
          {
            id: "write-windows-core-manifest",
            description: "Persist the repaired Windows core service definition.",
            action: {
              kind: "file.write" as const,
              file: requireRenderedFile(artifacts, "core-manifest"),
              atomic: true as const,
            },
          },
        ]
      : []),
    ...(definition.configuration.platform === "macos"
      ? [
          {
            id: "write-macos-core-manifest",
            description: "Persist the bounded macOS core service environment.",
            action: {
              kind: "file.write" as const,
              file: requireRenderedFile(artifacts, "core-manifest"),
              atomic: true as const,
            },
            rollback: {
              kind: "file.write" as const,
              file: requireRenderedFile(previousArtifacts, "core-manifest"),
              atomic: true as const,
            },
          },
        ]
      : []),
    {
      id: "write-runtime-configuration",
      description: "Atomically bind the service runtime configuration to the new release.",
      action: {
        kind: "file.write",
        file: targetRuntimeConfiguration,
        atomic: true,
      },
      rollback: {
        kind: "file.write",
        file: previousRuntimeConfiguration,
        atomic: true,
      },
    },
    {
      id: "activate-release",
      description: "Atomically switch the stable current pointer to the new release.",
      action: {
        kind: "activation.switch",
        activeDirectory: definition.activeDirectory,
        targetReleaseDirectory: definition.releaseDirectory,
        atomic: true,
      },
      rollback: {
        kind: "activation.switch",
        activeDirectory: definition.activeDirectory,
        targetReleaseDirectory: previousReleaseDirectory,
        atomic: true,
      },
    },
    supervisorStep("start-core", artifacts, "core", "start", "stop"),
    ...(hasSessionHelper(artifacts)
      ? [supervisorStep("start-helper", artifacts, "session-helper", "start", "stop")]
      : []),
    healthStep("health-core", artifacts, "core"),
    ...(hasSessionHelper(artifacts)
      ? [healthStep("health-helper", artifacts, "session-helper")]
      : []),
    pruneStep(artifacts),
  ];
  return plan(
    "upgrade",
    artifacts,
    steps,
    [
      "A failed post-activation health check stops the new release, restores the previous current pointer, and restarts the previous release.",
      `The healthy active release plus ${String(definition.configuration.retainPreviousVersions)} previous version(s) are retained.`,
    ],
    activeVersion,
  );
}

function windowsServiceSidRepairStep(artifacts: PlatformServiceArtifacts): ServicePlanStep {
  const invocations = artifacts.installCommands.filter(
    (invocation) =>
      invocation.plane === "core" &&
      invocation.executable === "sc.exe" &&
      invocation.arguments.length === 3 &&
      invocation.arguments[0] === "sidtype" &&
      invocation.arguments[2] === "unrestricted",
  );
  if (artifacts.platform !== "windows" || invocations.length !== 1) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Windows upgrade requires exactly one canonical unrestricted service SID repair command.",
    );
  }
  return {
    id: "repair-windows-service-sid",
    description: "Repair the Windows core service SID type to the declared unrestricted value.",
    action: {
      kind: "supervisor.invoke",
      command: {
        platform: "windows",
        plane: "core",
        verb: "install",
        invocations,
        deferWhenLoggedOut: false,
      },
    },
  };
}

function uninstallPlan(
  artifacts: PlatformServiceArtifacts,
  activeVersion: string,
  purgeState: boolean,
): ServicePlan {
  const { configuration } = artifacts.definition;
  const steps: ServicePlanStep[] = [
    ...(hasSessionHelper(artifacts)
      ? [supervisorStep("stop-helper", artifacts, "session-helper", "stop")]
      : []),
    supervisorStep("stop-core", artifacts, "core", "stop"),
    ...(hasSessionHelper(artifacts)
      ? [supervisorStep("remove-helper", artifacts, "session-helper", "remove")]
      : []),
    supervisorStep("remove-core", artifacts, "core", "remove"),
    ...(artifacts.helper === null
      ? []
      : [
          {
            id: "remove-helper-manifest",
            description: "Remove the helper supervisor manifest.",
            action: {
              kind: "path.remove" as const,
              path: artifacts.helper.manifest.path,
              recursive: false,
            },
          },
        ]),
    {
      id: "remove-core-manifest",
      description: "Remove the core supervisor manifest.",
      action: {
        kind: "path.remove",
        path: artifacts.core.manifest.path,
        recursive: false,
      },
    },
    {
      id: "remove-active-link",
      description: "Remove the stable current release link without following it.",
      action: {
        kind: "path.remove",
        path: artifacts.definition.activeDirectory,
        recursive: false,
      },
    },
    {
      id: "remove-installation",
      description: "Remove installed release binaries.",
      action: {
        kind: "path.remove",
        path: configuration.paths.installRoot,
        recursive: true,
      },
    },
    {
      id: "remove-runtime-directory",
      description: "Remove ephemeral sockets and runtime files.",
      action: {
        kind: "path.remove",
        path: configuration.paths.runtimeRoot,
        recursive: true,
      },
    },
  ];
  const notes: string[] = [];
  if (purgeState) {
    steps.push(
      {
        id: "purge-state",
        description: "Explicitly purge persistent OpenDelegate runtime state.",
        action: {
          kind: "path.remove",
          path: configuration.paths.stateRoot,
          recursive: true,
        },
      },
      {
        id: "purge-desktop-authority",
        description: "Explicitly purge the external monotonic desktop authority watermark.",
        action: {
          kind: "path.remove",
          path: configuration.paths.authorityRoot,
          recursive: true,
        },
      },
      {
        id: "purge-logs",
        description: "Explicitly purge OpenDelegate service logs.",
        action: {
          kind: "path.remove",
          path: configuration.paths.logRoot,
          recursive: true,
        },
      },
    );
    if (configuration.platform !== "windows") {
      steps.push({
        id: "remove-service-account",
        description: "Remove the dedicated service account after state purge.",
        action: {
          kind: "account.remove",
          platform: configuration.platform,
          userName: configuration.serviceIdentity.userName,
          groupName: configuration.serviceIdentity.groupName,
        },
      });
    }
    notes.push(
      "Persistent state, external desktop authority, and logs are purged because purgeState was explicit.",
    );
  } else {
    notes.push(
      `Persistent state at ${configuration.paths.stateRoot}, desktop authority at ${configuration.paths.authorityRoot}, and logs at ${configuration.paths.logRoot} are preserved for reinstall or recovery.`,
    );
  }
  return plan("uninstall", artifacts, steps, notes, activeVersion);
}

function hasSessionHelper(
  artifacts: PlatformServiceArtifacts,
): artifacts is PlatformServiceArtifacts & {
  readonly helper: NonNullable<PlatformServiceArtifacts["helper"]>;
} {
  return artifacts.helper !== null;
}

function releaseInstallSteps(artifacts: PlatformServiceArtifacts): readonly ServicePlanStep[] {
  const { definition } = artifacts;
  return [
    {
      id: "stage-release",
      description: "Copy the release into an isolated staging directory.",
      action: {
        kind: "release.stage",
        sourceDirectory: definition.configuration.bundle.sourceDirectory,
        stagingDirectory: definition.stagingDirectory,
        checksum: definition.configuration.bundle.checksum,
      },
      rollback: {
        kind: "release.remove",
        releaseDirectory: definition.stagingDirectory,
      },
    },
    {
      id: "verify-release",
      description: "Verify release integrity and the bundled pinned runtime.",
      action: {
        kind: "release.verify",
        stagingDirectory: definition.stagingDirectory,
        checksum: definition.configuration.bundle.checksum,
        requireBundledRuntime: true,
        requireSignedManifest: true,
      },
    },
    {
      id: "promote-release",
      description: "Atomically promote the verified staging directory.",
      action: {
        kind: "release.promote",
        stagingDirectory: definition.stagingDirectory,
        releaseDirectory: definition.releaseDirectory,
        atomic: true,
      },
      rollback: {
        kind: "release.remove",
        releaseDirectory: definition.releaseDirectory,
      },
    },
    ...(definition.configuration.platform === "windows"
      ? [
          directoryStep(
            "secure-release-root",
            definition.releaseDirectory,
            "0750",
            directoryAccess(definition.configuration, "read-execute"),
          ),
        ]
      : []),
    {
      id: "activate-release",
      description: "Atomically activate the installed release through current.",
      action: {
        kind: "activation.switch",
        activeDirectory: definition.activeDirectory,
        targetReleaseDirectory: definition.releaseDirectory,
        atomic: true,
      },
      rollback: {
        kind: "path.remove",
        path: definition.activeDirectory,
        recursive: false,
      },
    },
  ];
}

function supervisorStep(
  id: string,
  artifacts: PlatformServiceArtifacts,
  plane: RuntimePlane,
  verb: SupervisorOperation["verb"],
  rollbackVerb?: SupervisorOperation["verb"],
): ServicePlanStep {
  return {
    id,
    description: `${capitalize(verb)} the ${plane} supervisor plane.`,
    action: {
      kind: "supervisor.invoke",
      command: supervisorOperation(artifacts, plane, verb),
    },
    ...(rollbackVerb === undefined
      ? {}
      : {
          rollback: {
            kind: "supervisor.invoke" as const,
            command: supervisorOperation(artifacts, plane, rollbackVerb),
          },
        }),
  };
}

function supervisorOperation(
  artifacts: PlatformServiceArtifacts,
  plane: RuntimePlane,
  verb: SupervisorOperation["verb"],
): SupervisorOperation {
  const source =
    verb === "install"
      ? artifacts.installCommands
      : verb === "remove"
        ? artifacts.removeCommands
        : verb === "start"
          ? artifacts.startCommands
          : artifacts.stopCommands;
  const invocations = source.filter((invocation) => invocation.plane === plane);
  return {
    platform: artifacts.platform,
    plane,
    verb,
    invocations,
    deferWhenLoggedOut:
      plane === "session-helper" &&
      invocations.every((invocation) => invocation.availabilityPolicy === "defer-if-logged-out"),
  };
}

function healthStep(
  id: string,
  artifacts: PlatformServiceArtifacts,
  plane: RuntimePlane,
): ServicePlanStep {
  return {
    id,
    description: `Wait for ${plane} health after supervisor activation.`,
    action: {
      kind: "health.check",
      plane,
      endpoint: artifacts.definition.configuration.health.endpoint,
      timeoutMs: artifacts.definition.configuration.health.timeoutMs,
      policy: plane === "core" ? "required" : "defer-if-logged-out",
    },
  };
}

function pruneStep(artifacts: PlatformServiceArtifacts): ServicePlanStep {
  const configuration = artifacts.definition.configuration;
  return {
    id: "prune-old-releases",
    description: "Prune only versions outside the configured healthy retention window.",
    action: {
      kind: "release.prune",
      releasesRoot: pathJoin(configuration.platform, configuration.paths.installRoot, "releases"),
      activeVersion: configuration.bundle.version,
      retainPreviousVersions: configuration.retainPreviousVersions,
    },
  };
}

function requireRenderedFile(
  artifacts: PlatformServiceArtifacts,
  purpose: RenderedFile["purpose"],
): RenderedFile {
  const file = artifacts.files.find((candidate) => candidate.purpose === purpose);
  if (file === undefined) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      `The ${purpose} artifact is unavailable.`,
    );
  }
  return file;
}

function assertAdminAutoOpenOnlyReconfiguration(
  configuration: PlatformServiceConfiguration,
  previousConfiguration: PlatformServiceConfiguration,
): void {
  if (configuration.role !== "main" || previousConfiguration.role !== "main") {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Only the fixed Main owner Admin auto-open preference can be reconfigured.",
    );
  }
  const currentChoice = configuration.ownerSession.adminAutoOpen;
  const previousChoice = previousConfiguration.ownerSession.adminAutoOpen;
  const normalize = (value: PlatformServiceConfiguration) => ({
    ...value,
    ownerSession: {
      ...value.ownerSession,
      adminAutoOpen: { enabled: false as const },
    },
  });
  if (
    stableJson(normalize(configuration)) !== stableJson(normalize(previousConfiguration)) ||
    stableJson(currentChoice) === stableJson(previousChoice)
  ) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Service reconfiguration may change only the Main Admin auto-open preference.",
    );
  }
}

function directoryStep(
  id: string,
  path: string,
  mode: Extract<PlanAction, { kind: "directory.ensure" }>["mode"],
  access: DirectoryAccessPolicy,
): ServicePlanStep {
  return {
    id,
    description: `Ensure external runtime directory ${path}.`,
    action: { kind: "directory.ensure", path, mode, access },
  };
}

function directoryAccess(
  configuration: PlatformServiceConfiguration,
  profile:
    "installer-only" | "provider-sandbox" | "read-execute" | "service-secret" | "shared" | "state",
): DirectoryAccessPolicy {
  const installer =
    configuration.platform === "windows" ? "BUILTIN\\Administrators" : "platform-installer";
  const core =
    configuration.platform === "windows"
      ? `NT SERVICE\\OpenDelegate-${configuration.instanceId}`
      : configuration.serviceIdentity.userName;
  const owner =
    configuration.platform === "windows"
      ? configuration.ownerSession.stableUserId
      : configuration.ownerSession.userName;
  const grants: DirectoryAccessGrant[] = [{ principal: installer, permission: "full-control" }];
  if (profile === "provider-sandbox") {
    if (configuration.platform !== "windows") {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "Provider sandbox access is available only for Windows services.",
      );
    }
    grants.push(
      { principal: "S-1-5-18", permission: "full-control" },
      { principal: owner, permission: "full-control" },
      { principal: core, permission: "full-control" },
    );
    return {
      owner,
      grants,
      denyUnlisted: true,
    };
  }
  if (profile === "service-secret") {
    grants.push({ principal: core, permission: "full-control" });
    return {
      owner: core,
      grants,
      denyUnlisted: true,
    };
  }
  if (profile !== "installer-only") {
    grants.push({
      principal: core,
      permission: profile === "read-execute" ? "read-execute" : "read-write",
    });
    grants.push({
      principal: owner,
      permission: profile === "shared" ? "read-write" : "read-execute",
    });
  }
  return {
    owner: profile === "installer-only" || profile === "read-execute" ? installer : core,
    grants,
    denyUnlisted: true,
  };
}

function windowsAgentSandboxSteps(
  configuration: PlatformServiceConfiguration,
): readonly ServicePlanStep[] {
  if (configuration.platform !== "windows" || configuration.agentSandbox === undefined) {
    return [];
  }
  return [
    directoryStep(
      "ensure-codex-sandbox-helper",
      configuration.agentSandbox.codexSandboxBinDirectory,
      "0700",
      directoryAccess(configuration, "provider-sandbox"),
    ),
  ];
}

function windowsAgentProviderAccessSteps(
  configuration: PlatformServiceConfiguration,
): readonly ServicePlanStep[] {
  if (configuration.platform !== "windows" || configuration.agentProviderAccess === undefined) {
    return [];
  }
  const ownerHome = configuration.ownerSession.homeDirectory;
  if (ownerHome === undefined) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Windows Agent provider access requires the verified owner profile directory.",
    );
  }
  const principal = `NT SERVICE\\OpenDelegate-${configuration.instanceId}`;
  const grants = new Map<
    string,
    {
      readonly id: string;
      readonly path: string;
      permission: "read-execute" | "read-write";
    }
  >();
  const add = (id: string, path: string, permission: "read-execute" | "read-write"): void => {
    const key = win32.resolve(path).toLocaleLowerCase("en-US");
    const existing = grants.get(key);
    if (existing === undefined) {
      grants.set(key, { id, path, permission });
    } else if (permission === "read-write") {
      existing.permission = permission;
    }
  };
  add(
    "grant-codex-home-service-access",
    configuration.agentProviderAccess.codexHomeDirectory,
    "read-write",
  );
  add(
    "grant-claude-home-service-access",
    configuration.agentProviderAccess.claudeHomeDirectory,
    "read-write",
  );
  add(
    "grant-owner-local-bin-service-access",
    win32.join(ownerHome, ".local", "bin"),
    "read-execute",
  );
  add(
    "grant-owner-npm-bin-service-access",
    win32.join(ownerHome, "AppData", "Roaming", "npm"),
    "read-execute",
  );
  return [...grants.values()].map((grant): ServicePlanStep => ({
    id: grant.id,
    description: `Preserve existing access and grant the core service ${grant.permission} access to ${grant.path}.`,
    action: {
      kind: "directory.access-grant",
      path: grant.path,
      principal,
      permission: grant.permission,
      recursive: true,
      preserveExistingAccess: true,
      missingPathPolicy: "skip",
    },
  }));
}

function plan(
  operation: ServiceOperation,
  artifacts: PlatformServiceArtifacts,
  steps: readonly ServicePlanStep[],
  notes: readonly string[],
  fromVersion?: string,
): ServicePlan {
  return {
    schemaVersion: 1,
    operation,
    platform: artifacts.platform,
    instanceId: artifacts.definition.configuration.instanceId,
    ...(fromVersion === undefined ? {} : { fromVersion }),
    toVersion: artifacts.definition.configuration.bundle.version,
    requiresElevation: true,
    steps,
    notes,
  };
}

function pathJoin(platform: PlatformFamily, ...parts: string[]): string {
  return platform === "windows" ? win32.join(...parts) : posix.join(...parts);
}

function validateActiveVersion(version: string): void {
  if (!/^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Active service version is invalid.");
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
