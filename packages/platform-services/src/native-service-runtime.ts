import { posix, win32 } from "node:path";

import {
  createPlatformServiceDefinition,
  parsePlatformServiceConfiguration,
} from "./configuration.ts";
import { isRunningCoreHealthResponseV1 } from "./core-health-contract.ts";
import { renderPlatformServiceArtifacts } from "./render.ts";
import {
  createServiceDiagnostic,
  type ServiceDiagnostic,
  type SupervisorState,
} from "./diagnostics.ts";
import {
  NativeBoundaryError,
  type NativeClockBoundary,
  type NativeFileSystemBoundary,
  type NativePathMetadata,
  type NativeProcessBoundary,
  type NativeProcessRequest,
  type NativeProcessResult,
  type NativeServiceBoundaries,
} from "./native-service-boundaries.ts";
import {
  createServicePlan,
  type PlanAction,
  type ServicePlan,
  type SupervisorOperation,
} from "./plans.ts";
import { evaluateSessionHelperReadiness } from "./readiness.ts";
import { stableJson } from "./render-common.ts";
import { MACOS_SERVICE_EXECUTABLE_PATH } from "./render-macos.ts";
import {
  assertMatchingNativeReleaseVerification,
  createNativeReleaseVerifier,
  encodeNativeReleaseVerification,
  parseNativeReleaseVerification,
  type NativeReleaseVerification,
  type NativeReleaseVerifier,
} from "./native-release-verifier.ts";
import {
  nativeReleaseVerificationSealDirectory,
  nativeReleaseVerificationSealPath,
} from "./release-verification-seal.ts";
import {
  ServiceCommandExecutionError,
  executeIdempotentServicePlan,
  servicePlanFingerprint,
  type IdempotentServicePlanResult,
  type ServiceCommandJournal,
} from "./service-command.ts";
import {
  createServicePlanRunner,
  type ServiceAccountAdapter,
  type ServiceFilesystemAdapter,
  type ServiceHealthAdapter,
  type ServiceSupervisorAdapter,
} from "./service-plan-runner.ts";
import { validateSupervisorCommands } from "./command-validation.ts";
import type {
  CommandInvocation,
  PlatformFamily,
  PlatformServiceConfiguration,
  RenderedFile,
} from "./types.ts";

const MAXIMUM_RENDERED_FILE_BYTES = 1024 * 1024;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

type AccountAction = Extract<PlanAction, { readonly kind: "account.ensure" | "account.remove" }>;
type FilesystemAction = Exclude<
  PlanAction,
  AccountAction | Extract<PlanAction, { readonly kind: "health.check" | "supervisor.invoke" }>
>;

export interface NativeServiceCommandJournalFactory {
  create(configuration: PlatformServiceConfiguration): ServiceCommandJournal;
}

export interface NativeServiceExecutor {
  execute(input: {
    readonly commandId: string;
    readonly configuration: PlatformServiceConfiguration;
    readonly previousConfiguration?: PlatformServiceConfiguration;
    readonly plan: ServicePlan;
  }): Promise<IdempotentServicePlanResult>;
}

export interface NativeServiceRuntimeOptions {
  readonly platform: PlatformFamily;
  readonly boundaries: NativeServiceBoundaries;
  readonly journalFactory: NativeServiceCommandJournalFactory;
  readonly releaseVerifier?: NativeReleaseVerifier;
}

export interface NativeServiceInspector {
  inspect(configuration: PlatformServiceConfiguration): Promise<ServiceDiagnostic>;
}

export function nativeServiceJournalRoot(configuration: PlatformServiceConfiguration): string {
  return `${configuration.paths.stateRoot}.service-operations-${configuration.instanceId}`;
}

export function createNativeServiceExecutor(
  options: NativeServiceRuntimeOptions,
): NativeServiceExecutor {
  const releaseVerifier =
    options.releaseVerifier ?? createNativeReleaseVerifier(options.boundaries.fileSystem);
  return {
    async execute(input) {
      const configuration = parsePlatformServiceConfiguration(input.configuration);
      const verification = await preflightNativeServiceOperation({
        platform: options.platform,
        configuration,
        ...(input.previousConfiguration === undefined
          ? {}
          : { previousConfiguration: input.previousConfiguration }),
        plan: input.plan,
        boundaries: options.boundaries,
        releaseVerifier,
      });
      const tools = nativeTools();
      const accountAdapter = createNativeAccountAdapter(configuration, options.boundaries, tools);
      const supervisorState = createNativeSupervisorStateReader(
        configuration,
        options.boundaries,
        tools,
      );
      const runner = createServicePlanRunner({
        filesystem: createNativeFilesystemAdapter(
          configuration,
          verification,
          releaseVerifier,
          options.boundaries,
          tools,
        ),
        accounts: accountAdapter,
        supervisor: createNativeSupervisorAdapter(configuration, options.boundaries, tools),
        health: createNativeHealthAdapter(configuration, options.boundaries, supervisorState),
      });
      return await executeIdempotentServicePlan({
        commandId: input.commandId,
        plan: input.plan,
        journal: options.journalFactory.create(configuration),
        runner,
      });
    },
  };
}

export function createNativeServiceInspector(
  input: Pick<NativeServiceRuntimeOptions, "platform" | "boundaries">,
): NativeServiceInspector {
  return {
    async inspect(configurationInput) {
      const configuration = parsePlatformServiceConfiguration(configurationInput);
      if (configuration.platform !== input.platform) {
        failPreflight("The configured service platform does not match this host.");
      }
      const tools = nativeTools();
      const state = createNativeSupervisorStateReader(configuration, input.boundaries, tools);
      const [coreState, helperState, loggedIn, activeVersion, retainedVersions] = await Promise.all(
        [
          state.read("core"),
          state.read("session-helper"),
          input.boundaries.session.isOwnerLoggedIn(ownerSessionProbe(configuration)),
          readActiveVersion(configuration, input.boundaries.fileSystem),
          readRetainedVersions(configuration, input.boundaries.fileSystem),
        ],
      );
      const coreHealthy =
        coreState === "running"
          ? await probeCoreOnce(
              configuration,
              configuration.health.endpoint,
              Math.min(configuration.health.timeoutMs, 5_000),
              input.boundaries,
            )
          : false;
      const normalizedCoreState = coreState === "running" && !coreHealthy ? "failed" : coreState;
      const readiness = evaluateSessionHelperReadiness({
        helperProcess:
          helperState === "running"
            ? "running"
            : helperState === "unknown" || helperState === "starting"
              ? "unknown"
              : "stopped",
        loggedIn,
        desktopUnlocked: false,
        permissions: {
          accessibility: "unknown",
          input: "unknown",
          screenCapture: "unknown",
        },
      });
      return createServiceDiagnostic({
        configuration,
        ...(activeVersion === undefined ? {} : { activeVersion }),
        retainedVersions,
        coreSupervisorState: normalizedCoreState,
        helperSupervisorState: helperState,
        readiness,
      });
    },
  };
}

export async function preflightNativeServiceOperation(input: {
  readonly platform: PlatformFamily;
  readonly configuration: PlatformServiceConfiguration;
  readonly previousConfiguration?: PlatformServiceConfiguration;
  readonly plan: ServicePlan;
  readonly boundaries: NativeServiceBoundaries;
  readonly releaseVerifier: NativeReleaseVerifier;
}): Promise<NativeReleaseVerification | undefined> {
  const configuration = parsePlatformServiceConfiguration(input.configuration);
  const previousConfiguration =
    input.previousConfiguration === undefined
      ? undefined
      : parsePlatformServiceConfiguration(input.previousConfiguration);
  if (configuration.platform !== input.platform || input.plan.platform !== input.platform) {
    failPreflight("The service plan and configuration must match the current host platform.");
  }
  assertCanonicalPlan(configuration, input.plan, previousConfiguration);
  if (
    configuration.platform === "windows" &&
    (input.plan.operation === "install" || input.plan.operation === "upgrade")
  ) {
    if (configuration.serviceSecretBinding === undefined) {
      failPreflight(
        "Windows service installation requires an explicit service-identity Secret binding for the co-located Worker staged for the SCM virtual account.",
      );
    }
  }
  assertJournalRootDisjoint(configuration);
  if (!(await input.boundaries.privilege.isElevated(input.platform, input.boundaries.process))) {
    failPreflight(
      "Native service installation requires an already elevated administrator or root process. OpenDelegate never elevates itself.",
    );
  }
  const tools = nativeTools();
  const requiredTools = requiredNativeTools(configuration, input.plan, tools);
  for (const tool of requiredTools) {
    if (!(await input.boundaries.process.isExecutable(tool))) {
      failPreflight(`Required native service tool is unavailable: ${tool}.`);
    }
  }
  if (
    configuration.platform === "windows" &&
    (input.plan.operation === "install" || input.plan.operation === "upgrade")
  ) {
    await assertWindowsServiceSid(configuration, input.boundaries.process, tools.sc);
  }
  await assertMutationTopologySafe(configuration, input.plan, input.boundaries.fileSystem);
  await assertRenderedFilePreconditions(
    input.plan,
    input.boundaries.fileSystem,
    configuration.platform,
  );
  if (input.plan.operation === "upgrade") {
    const activeVersion = input.plan.fromVersion;
    if (activeVersion === undefined) {
      failPreflight("Upgrade requires the exact active service version.");
    }
    await assertUpgradeConfigurationMatchesInstalled(
      configuration,
      activeVersion,
      input.boundaries.fileSystem,
    );
  }
  if (input.plan.operation === "reconfigure") {
    await assertReconfigurationMatchesInstalled(
      configuration,
      requirePreviousConfiguration(previousConfiguration),
      input.boundaries.fileSystem,
    );
  }
  if (
    configuration.platform === "windows" &&
    (input.plan.operation === "start" || input.plan.operation === "restart")
  ) {
    await assertRuntimeConfigurationMatchesInstalled(configuration, input.boundaries.fileSystem);
  }
  const definition = createPlatformServiceDefinition(configuration);
  if (
    !(await input.boundaries.fileSystem.sameVolume(
      definition.stagingDirectory,
      definition.releaseDirectory,
    )) ||
    !(await input.boundaries.fileSystem.sameVolume(
      definition.releaseDirectory,
      definition.activeDirectory,
    ))
  ) {
    failPreflight(
      "Release staging, versioned releases, and the stable current path must share one volume.",
    );
  }
  if (input.plan.operation !== "install" && input.plan.operation !== "upgrade") {
    if (
      input.plan.operation === "start" ||
      input.plan.operation === "restart" ||
      input.plan.operation === "reconfigure"
    ) {
      const persisted = await readPersistedReleaseVerificationSeal(
        configuration,
        input.boundaries.fileSystem,
        false,
      );
      const installed = await input.releaseVerifier.verifyInstalled(
        configuration,
        definition.releaseDirectory,
        persisted,
      );
      await assertReleaseHostExecutables(
        configuration,
        definition.releaseDirectory,
        input.boundaries.process,
        true,
      );
      return installed;
    }
    return undefined;
  }
  const verification = await input.releaseVerifier.preflight(configuration);
  await assertReleaseHostExecutables(
    configuration,
    configuration.bundle.sourceDirectory,
    input.boundaries.process,
    false,
  );
  return verification;
}

async function assertWindowsServiceSid(
  configuration: Extract<PlatformServiceConfiguration, { readonly platform: "windows" }>,
  process: NativeProcessBoundary,
  scPath: string,
): Promise<void> {
  const binding = configuration.serviceSecretBinding;
  if (binding === undefined) {
    failPreflight("The Windows co-located Worker service Secret binding is missing.");
  }
  const result = await process.run({
    executable: scPath,
    arguments: ["showsid", binding.serviceName],
    timeoutMs: 10_000,
  });
  if (result.timedOut || result.exitCode !== 0) {
    failPreflight("The Windows SCM service SID could not be verified.");
  }
  const matches = result.stdout.match(/S-1-5-80-(?:[0-9]{1,10}-){4}[0-9]{1,10}/gu);
  if (matches?.length !== 1 || matches[0] !== binding.serviceSid) {
    failPreflight("The Windows SCM service SID does not match the staged Secret binding.");
  }
}

function createNativeFilesystemAdapter(
  configuration: PlatformServiceConfiguration,
  verification: NativeReleaseVerification | undefined,
  releaseVerifier: NativeReleaseVerifier,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): ServiceFilesystemAdapter {
  const fileSystem = boundaries.fileSystem;
  const originalRenderedFiles = new Map<string, Buffer | null>();
  return {
    async perform(action: FilesystemAction, context) {
      assertFilesystemActionAllowed(configuration, action);
      switch (action.kind) {
        case "directory.access-grant": {
          if (configuration.platform !== "windows") {
            throw uncertain("Additive provider-directory access is available only on Windows.");
          }
          const existing = await fileSystem.inspect(action.path);
          if (existing.kind === "missing" && action.missingPathPolicy === "skip") {
            return { disposition: "unchanged" };
          }
          if (existing.kind !== "directory") {
            throw uncertain("An owner-managed Agent access path is not a canonical directory.");
          }
          const canonicalPath = await fileSystem.realPath(action.path);
          if (!equalPath("windows", canonicalPath, action.path)) {
            throw uncertain("An owner-managed Agent access path resolves through a link.");
          }
          await runRequired(boundaries.process, {
            executable: tools.icacls,
            arguments: [
              action.path,
              "/grant:r",
              `${windowsPrincipal(action.principal)}:${windowsPermission(action.permission)}`,
              "/T",
              "/L",
              "/Q",
            ],
            timeoutMs: 120_000,
          });
          return { disposition: "changed" };
        }
        case "directory.ensure": {
          if (action.requiredExistingParent !== undefined) {
            if (
              configuration.platform !== "windows" ||
              !equalPath("windows", win32.dirname(action.path), action.requiredExistingParent)
            ) {
              throw uncertain("An owner-managed child directory has an invalid parent binding.");
            }
            const parent = await fileSystem.inspect(action.requiredExistingParent);
            if (parent.kind === "missing") {
              return { disposition: "unchanged" };
            }
            if (parent.kind !== "directory") {
              throw uncertain("An owner-managed parent path is not a canonical directory.");
            }
            const canonicalParent = await fileSystem.realPath(action.requiredExistingParent);
            if (!equalPath("windows", canonicalParent, action.requiredExistingParent)) {
              throw uncertain("An owner-managed parent path resolves through a link.");
            }
          }
          const existing = await fileSystem.inspect(action.path);
          if (configuration.platform === "windows" && existing.kind === "directory") {
            if (action.requiredExistingParent !== undefined) {
              const parent = await fileSystem.inspect(action.requiredExistingParent);
              const child = await fileSystem.inspect(action.path);
              if (parent.kind !== "directory" || child.kind !== "directory") {
                throw uncertain("An owner-managed child directory lost its exact parent binding.");
              }
              const [canonicalParent, canonicalChild] = await Promise.all([
                fileSystem.realPath(action.requiredExistingParent),
                fileSystem.realPath(action.path),
              ]);
              if (
                !equalPath("windows", canonicalParent, action.requiredExistingParent) ||
                !equalPath("windows", canonicalChild, action.path)
              ) {
                throw uncertain("An owner-managed child directory changed through a link.");
              }
            }
            // A running service-owned Secret Store intentionally removes the
            // interactive administrator from its DACL. Reinstallation must let
            // elevated icacls restore the canonical ACL before any Node chmod or
            // mkdir call tries to open that already-existing directory.
            await applyDirectoryAccess(
              configuration,
              action.path,
              Number.parseInt(action.mode, 8),
              action.access.owner,
              boundaries,
              tools,
              true,
              action.requiredExistingParent !== undefined,
              action.requiredExistingParent,
            );
            if ((await fileSystem.inspect(action.path)).kind !== "directory") {
              throw uncertain("A native service directory changed during access repair.");
            }
            return { disposition: "unchanged" };
          }
          const disposition = await fileSystem.ensureDirectory(
            action.path,
            Number.parseInt(action.mode, 8),
            action.requiredExistingParent === undefined,
          );
          if (action.requiredExistingParent !== undefined) {
            const parent = await fileSystem.inspect(action.requiredExistingParent);
            const child = await fileSystem.inspect(action.path);
            if (parent.kind !== "directory" || child.kind !== "directory") {
              if (disposition === "changed") {
                await fileSystem.remove(action.path, false).catch(() => undefined);
              }
              throw uncertain("An owner-managed child directory lost its exact parent binding.");
            }
            const [canonicalParent, canonicalChild] = await Promise.all([
              fileSystem.realPath(action.requiredExistingParent),
              fileSystem.realPath(action.path),
            ]);
            if (
              !equalPath("windows", canonicalParent, action.requiredExistingParent) ||
              !equalPath("windows", canonicalChild, action.path)
            ) {
              if (disposition === "changed") {
                await fileSystem.remove(action.path, false).catch(() => undefined);
              }
              throw uncertain("An owner-managed child directory changed through a link.");
            }
          }
          await applyDirectoryAccess(
            configuration,
            action.path,
            Number.parseInt(action.mode, 8),
            action.access.owner,
            boundaries,
            tools,
            false,
            action.requiredExistingParent !== undefined,
            action.requiredExistingParent,
          );
          return { disposition };
        }
        case "file.symbolic-link.ensure": {
          if (configuration.platform !== "windows" || action.platform !== "windows") {
            throw uncertain("Codex authentication linking is available only on Windows.");
          }
          const sourceHome = configuration.agentProviderAccess.codexHomeDirectory;
          const serviceHome = configuration.agentProviderAccess.codexServiceHomeDirectory;
          const expectedPath = win32.join(serviceHome, "auth.json");
          const expectedTarget = win32.join(sourceHome, "auth.json");
          if (
            !equalPath("windows", action.path, expectedPath) ||
            !equalPath("windows", action.target, expectedTarget) ||
            !equalPath("windows", win32.dirname(action.path), serviceHome) ||
            !equalPath("windows", win32.dirname(action.target), sourceHome)
          ) {
            throw uncertain("The Codex authentication link escaped its declared homes.");
          }
          const [sourceParent, serviceParent, source] = await Promise.all([
            fileSystem.inspect(sourceHome),
            fileSystem.inspect(serviceHome),
            fileSystem.inspect(action.target),
          ]);
          if (sourceParent.kind === "missing") {
            return { disposition: "unchanged" };
          }
          if (sourceParent.kind !== "directory" || serviceParent.kind !== "directory") {
            throw uncertain("A declared Codex home is unavailable during authentication linking.");
          }
          if (source.kind !== "missing" && source.kind !== "regular-file") {
            throw uncertain("The owner Codex authentication source is not a regular file.");
          }
          const [canonicalSourceHome, canonicalServiceHome] = await Promise.all([
            fileSystem.realPath(sourceHome),
            fileSystem.realPath(serviceHome),
          ]);
          if (
            !equalPath("windows", canonicalSourceHome, sourceHome) ||
            !equalPath("windows", canonicalServiceHome, serviceHome)
          ) {
            throw uncertain("A declared Codex home resolves through a link.");
          }
          return {
            disposition: await fileSystem.createFileLinkAtomic(
              action.target,
              action.path,
              action.platform,
            ),
          };
        }
        case "file.write": {
          if (context.phase === "forward") {
            if (action.restoreOriginalBytes === true) {
              throw uncertain("A forward file write cannot request original-byte restoration.");
            }
            if (!originalRenderedFiles.has(action.file.path)) {
              const original = await fileSystem.inspect(action.file.path);
              if (original.kind === "missing") {
                originalRenderedFiles.set(action.file.path, null);
              } else if (
                original.kind === "regular-file" &&
                original.size !== undefined &&
                original.size <= MAXIMUM_RENDERED_FILE_BYTES
              ) {
                originalRenderedFiles.set(
                  action.file.path,
                  Buffer.from(await fileSystem.read(action.file.path, MAXIMUM_RENDERED_FILE_BYTES)),
                );
              } else {
                throw uncertain("A rendered service file could not be snapshotted safely.");
              }
            }
          }
          if (context.phase === "rollback" && action.restoreOriginalBytes === true) {
            if (!originalRenderedFiles.has(action.file.path)) {
              throw uncertain("The exact pre-mutation service file is unavailable for rollback.");
            }
            const original = originalRenderedFiles.get(action.file.path);
            if (original === null) {
              return { disposition: await fileSystem.remove(action.file.path, false) };
            }
            if (original === undefined) {
              throw uncertain("The exact pre-mutation service file is unavailable for rollback.");
            }
            const disposition = await fileSystem.writeAtomic(
              action.file.path,
              original,
              Number.parseInt(action.file.mode, 8),
            );
            await applyRenderedFileAccess(configuration, action.file, boundaries, tools);
            return { disposition };
          }
          const bytes = encodeRenderedFile(action.file);
          const disposition = await fileSystem.writeAtomic(
            action.file.path,
            bytes,
            Number.parseInt(action.file.mode, 8),
          );
          await applyRenderedFileAccess(configuration, action.file, boundaries, tools);
          return { disposition };
        }
        case "release.stage": {
          const posixAccess = await resolvePosixReleaseAccess(configuration, boundaries, tools);
          const existing = await fileSystem.inspect(action.stagingDirectory);
          if (existing.kind === "directory") {
            if (posixAccess !== undefined) {
              await applyPosixReleaseTreeAccess(
                configuration.platform,
                action.stagingDirectory,
                fileSystem,
                posixAccess,
              );
            }
            await releaseVerifier.verifyStaged(
              configuration,
              action.stagingDirectory,
              requireReleaseVerification(verification),
            );
            await assertReleaseHostExecutables(
              configuration,
              action.stagingDirectory,
              boundaries.process,
              true,
            );
            return { disposition: "unchanged" };
          }
          if (existing.kind !== "missing") {
            throw uncertain("The release staging path is occupied by a link or special file.");
          }
          const temporary = `${action.stagingDirectory}.${context.actionId.slice(7, 19)}.copying`;
          if ((await fileSystem.inspect(temporary)).kind !== "missing") {
            throw uncertain("A prior unverified release-copy temporary path remains.");
          }
          await fileSystem.ensureDirectory(temporary, 0o700);
          try {
            if (posixAccess !== undefined) {
              await fileSystem.setPosixOwnershipAndMode(
                temporary,
                posixAccess.uid,
                posixAccess.gid,
                0o750,
              );
            }
            const sourceRealPath = await fileSystem.realPath(action.sourceDirectory);
            await copyReleaseTree(
              configuration.platform,
              action.sourceDirectory,
              temporary,
              fileSystem,
              sourceRealPath,
              posixAccess,
            );
            await releaseVerifier.verifyStaged(
              configuration,
              temporary,
              requireReleaseVerification(verification),
            );
            await assertReleaseHostExecutables(configuration, temporary, boundaries.process, true);
            await fileSystem.renameAtomic(temporary, action.stagingDirectory, false);
          } catch (error) {
            await fileSystem.remove(temporary, true).catch(() => undefined);
            throw error;
          }
          return { disposition: "changed" };
        }
        case "release.verify":
          await releaseVerifier.verifyStaged(
            configuration,
            action.stagingDirectory,
            requireReleaseVerification(verification),
          );
          await assertReleaseHostExecutables(
            configuration,
            action.stagingDirectory,
            boundaries.process,
            true,
          );
          return { disposition: "unchanged" };
        case "release.promote": {
          const release = await fileSystem.inspect(action.releaseDirectory);
          if (release.kind === "directory") {
            const posixAccess = await resolvePosixReleaseAccess(configuration, boundaries, tools);
            if (posixAccess !== undefined) {
              await applyPosixReleaseTreeAccess(
                configuration.platform,
                action.releaseDirectory,
                fileSystem,
                posixAccess,
              );
            }
            await releaseVerifier.verifyStaged(
              configuration,
              action.releaseDirectory,
              requireReleaseVerification(verification),
            );
            await assertReleaseHostExecutables(
              configuration,
              action.releaseDirectory,
              boundaries.process,
              true,
            );
            await persistReleaseVerificationSeal(configuration, verification, fileSystem);
            await fileSystem.remove(action.stagingDirectory, true);
            return { disposition: "unchanged" };
          }
          if (release.kind !== "missing") {
            throw uncertain("The versioned release path is occupied by a link or special file.");
          }
          await releaseVerifier.verifyStaged(
            configuration,
            action.stagingDirectory,
            requireReleaseVerification(verification),
          );
          await assertReleaseHostExecutables(
            configuration,
            action.stagingDirectory,
            boundaries.process,
            true,
          );
          await fileSystem.renameAtomic(action.stagingDirectory, action.releaseDirectory, false);
          try {
            await persistReleaseVerificationSeal(configuration, verification, fileSystem);
          } catch {
            await fileSystem.remove(action.releaseDirectory, true).catch(() => undefined);
            await fileSystem
              .remove(nativeReleaseVerificationSealPath(configuration), false)
              .catch(() => undefined);
            throw uncertain(
              "The promoted release could not be bound to its durable verification seal.",
            );
          }
          return { disposition: "changed" };
        }
        case "activation.switch": {
          if (context.phase === "forward") {
            const expected = requireReleaseVerification(verification);
            await assertPersistedReleaseVerificationSeal(configuration, expected, fileSystem);
            await releaseVerifier.verifyBeforeActivation(
              configuration,
              action.targetReleaseDirectory,
              expected,
            );
          }
          const disposition = await fileSystem.createDirectoryLinkAtomic(
            action.targetReleaseDirectory,
            action.activeDirectory,
            configuration.platform,
          );
          return { disposition };
        }
        case "release.prune":
          return {
            disposition: await pruneReleases(
              configuration.platform,
              action.releasesRoot,
              action.activeVersion,
              action.retainPreviousVersions,
              fileSystem,
            ),
          };
        case "release.remove": {
          const disposition = await fileSystem.remove(action.releaseDirectory, true);
          if (
            verification !== undefined &&
            equalPath(
              configuration.platform,
              action.releaseDirectory,
              createPlatformServiceDefinition(configuration).releaseDirectory,
            )
          ) {
            await fileSystem.remove(nativeReleaseVerificationSealPath(configuration), false);
          }
          return { disposition };
        }
        case "path.remove":
          return {
            disposition: await fileSystem.remove(action.path, action.recursive),
          };
      }
    },
  };
}

async function persistReleaseVerificationSeal(
  configuration: PlatformServiceConfiguration,
  verification: NativeReleaseVerification | undefined,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const required = requireReleaseVerification(verification);
  await fileSystem.ensureDirectory(nativeReleaseVerificationSealDirectory(configuration), 0o700);
  await fileSystem.writeAtomic(
    nativeReleaseVerificationSealPath(configuration),
    encodeNativeReleaseVerification(required),
    0o600,
  );
}

async function assertPersistedReleaseVerificationSeal(
  configuration: PlatformServiceConfiguration,
  verification: NativeReleaseVerification,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const actual = await readPersistedReleaseVerificationSeal(configuration, fileSystem, true);
  assertMatchingNativeReleaseVerification(verification, actual);
}

async function readPersistedReleaseVerificationSeal(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
  required: true,
): Promise<NativeReleaseVerification>;
async function readPersistedReleaseVerificationSeal(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
  required: false,
): Promise<NativeReleaseVerification | undefined>;
async function readPersistedReleaseVerificationSeal(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
  required: boolean,
): Promise<NativeReleaseVerification | undefined> {
  const path = nativeReleaseVerificationSealPath(configuration);
  const metadata = await fileSystem.inspect(path);
  if (metadata.kind === "missing" && !required) {
    return undefined;
  }
  if (
    metadata.kind !== "regular-file" ||
    metadata.size === undefined ||
    metadata.size <= 0 ||
    metadata.size > 128 * 1024
  ) {
    failPreflight("The installed release verification seal is missing or unsafe.");
  }
  let bytes: Buffer;
  try {
    bytes = await fileSystem.read(path, metadata.size);
  } catch {
    failPreflight("The installed release verification seal cannot be read safely.");
  }
  return parseNativeReleaseVerification(bytes);
}

function createNativeAccountAdapter(
  configuration: PlatformServiceConfiguration,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): ServiceAccountAdapter {
  return {
    async perform(action: AccountAction) {
      if (configuration.platform === "windows") {
        throw uncertain("Windows plans must not contain local account mutation actions.");
      }
      if (
        action.platform !== configuration.platform ||
        action.userName !== configuration.serviceIdentity.userName ||
        action.groupName !== configuration.serviceIdentity.groupName
      ) {
        throw uncertain(
          "A service account action escaped the configured least-privilege identity.",
        );
      }
      return action.kind === "account.ensure"
        ? {
            disposition: await ensureServiceAccount(
              configuration,
              action,
              boundaries.process,
              tools,
            ),
          }
        : {
            disposition: await removeServiceAccount(
              configuration,
              action,
              boundaries.process,
              tools,
            ),
          };
    },
  };
}

function createNativeSupervisorAdapter(
  configuration: PlatformServiceConfiguration,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): ServiceSupervisorAdapter {
  return {
    async perform(operation: SupervisorOperation) {
      validateSupervisorCommands(operation.invocations);
      if (
        operation.platform !== configuration.platform ||
        operation.invocations.some((invocation) => invocation.plane !== operation.plane)
      ) {
        throw uncertain("A supervisor operation does not match the configured platform or plane.");
      }
      const ownerLoggedIn =
        operation.plane === "session-helper"
          ? await boundaries.session.isOwnerLoggedIn(ownerSessionProbe(configuration))
          : true;
      const completed: Array<{
        readonly invocation: CommandInvocation;
        readonly exitCode: number;
      }> = [];
      let activeLifecycleInvocation: CommandInvocation | undefined;
      try {
        for (const invocation of operation.invocations) {
          if (
            invocation.privilege === "owner-session" &&
            invocation.availabilityPolicy === "defer-if-logged-out" &&
            !ownerLoggedIn
          ) {
            continue;
          }
          activeLifecycleInvocation =
            invocation.verb === "start" || invocation.verb === "stop" ? invocation : undefined;
          const result = await runSupervisorInvocation(
            configuration,
            invocation,
            boundaries.process,
            boundaries.clock,
            boundaries.fileSystem,
            tools,
          );
          if (result.timedOut || !invocation.expectedExitCodes.includes(result.exitCode)) {
            throw new NativeSupervisorError("A native supervisor command failed or timed out.");
          }
          completed.push({ invocation, exitCode: result.exitCode });
          activeLifecycleInvocation = undefined;
        }
      } catch (error) {
        await rollbackPartialSupervisorOperation(
          configuration,
          operation,
          activeLifecycleInvocation === undefined
            ? completed
            : [...completed, { invocation: activeLifecycleInvocation, exitCode: 0 }],
          boundaries.process,
          boundaries.clock,
          boundaries.fileSystem,
          tools,
        );
        throw error;
      }
      const unchanged = completed.every(({ invocation, exitCode }) =>
        invocationAlreadySatisfied(configuration.platform, invocation, exitCode),
      );
      return { disposition: unchanged ? "unchanged" : "changed" };
    },
  };
}

function createNativeHealthAdapter(
  configuration: PlatformServiceConfiguration,
  boundaries: NativeServiceBoundaries,
  supervisorState: NativeSupervisorStateReader,
): ServiceHealthAdapter {
  return {
    async perform(action) {
      if (action.plane === "session-helper") {
        const loggedIn = await boundaries.session.isOwnerLoggedIn(ownerSessionProbe(configuration));
        if (!loggedIn && action.policy === "defer-if-logged-out") {
          return { disposition: "unchanged" };
        }
        const deadline = boundaries.clock.now().getTime() + action.timeoutMs;
        for (;;) {
          const state = await supervisorState.read("session-helper");
          if (state === "running") {
            return { disposition: "unchanged" };
          }
          if (boundaries.clock.now().getTime() >= deadline) {
            throw new NativeHealthError(
              "The logged-in user-session helper did not reach a running supervisor state.",
            );
          }
          await boundaries.clock.sleep(250);
        }
      }
      const deadline = boundaries.clock.now().getTime() + action.timeoutMs;
      for (;;) {
        if (
          await probeCoreOnce(
            configuration,
            action.endpoint,
            Math.min(5_000, action.timeoutMs),
            boundaries,
          )
        ) {
          return { disposition: "unchanged" };
        }
        if (boundaries.clock.now().getTime() >= deadline) {
          throw new NativeHealthError(
            "The core service did not pass its loopback health check before timeout.",
          );
        }
        await boundaries.clock.sleep(250);
      }
    },
  };
}

interface NativeSupervisorStateReader {
  read(plane: "core" | "session-helper"): Promise<SupervisorState>;
}

function createNativeSupervisorStateReader(
  configuration: PlatformServiceConfiguration,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): NativeSupervisorStateReader {
  return {
    async read(plane) {
      if (plane === "session-helper") {
        const loggedIn = await boundaries.session.isOwnerLoggedIn(ownerSessionProbe(configuration));
        if (!loggedIn) {
          return "not-loaded";
        }
        if (configuration.platform === "windows") {
          const presenceState = await readWindowsSessionHelperPresenceState(
            configuration,
            boundaries,
          );
          if (presenceState !== undefined) {
            return presenceState;
          }
        }
      }
      const request = supervisorStatusRequest(configuration, plane, tools);
      if (!(await boundaries.process.isExecutable(request.executable))) {
        return "not-installed";
      }
      const result = await boundaries.process.run(request);
      return parseSupervisorState(configuration.platform, plane, result);
    },
  };
}

async function ensureServiceAccount(
  configuration: Exclude<PlatformServiceConfiguration, { readonly platform: "windows" }>,
  action: Extract<AccountAction, { readonly kind: "account.ensure" }>,
  process: NativeProcessBoundary,
  tools: NativeTools,
): Promise<"changed" | "unchanged"> {
  return configuration.platform === "linux"
    ? await ensureLinuxServiceAccount(action, process, tools)
    : await ensureMacOsServiceAccount(action, process, tools);
}

async function ensureLinuxServiceAccount(
  action: Extract<AccountAction, { readonly kind: "account.ensure" }>,
  process: NativeProcessBoundary,
  tools: NativeTools,
): Promise<"changed" | "unchanged"> {
  let changed = false;
  const group = await process.run({
    executable: tools.getent,
    arguments: ["group", action.groupName],
    timeoutMs: 10_000,
  });
  if (group.exitCode !== 0 && group.exitCode !== 2) {
    throw uncertain("The configured Linux service group could not be inspected safely.");
  }
  if (group.exitCode === 2) {
    await runRequired(process, {
      executable: tools.groupadd,
      arguments: ["--system", action.groupName],
      timeoutMs: 30_000,
    });
    changed = true;
  }
  const resolvedGroup =
    group.exitCode === 0
      ? group
      : await runRequired(process, {
          executable: tools.getent,
          arguments: ["group", action.groupName],
          timeoutMs: 10_000,
        });
  const groupFields = resolvedGroup.stdout.trim().split(":");
  const groupId = Number(groupFields[2]);
  if (
    groupFields.length < 4 ||
    groupFields[0] !== action.groupName ||
    !Number.isSafeInteger(groupId) ||
    groupId < 0
  ) {
    throw uncertain("The configured Linux service group has an invalid identity record.");
  }
  const user = await process.run({
    executable: tools.getent,
    arguments: ["passwd", action.userName],
    timeoutMs: 10_000,
  });
  if (user.exitCode !== 0 && user.exitCode !== 2) {
    throw uncertain("The configured Linux service account could not be inspected safely.");
  }
  if (user.exitCode === 2) {
    await runRequired(process, {
      executable: tools.useradd,
      arguments: [
        "--system",
        "--gid",
        action.groupName,
        "--home-dir",
        "/nonexistent",
        "--no-create-home",
        "--shell",
        tools.nologin,
        action.userName,
      ],
      timeoutMs: 30_000,
    });
    changed = true;
  }
  const resolvedUser =
    user.exitCode === 0
      ? user
      : await runRequired(process, {
          executable: tools.getent,
          arguments: ["passwd", action.userName],
          timeoutMs: 10_000,
        });
  const fields = resolvedUser.stdout.trim().split(":");
  const userId = Number(fields[2]);
  const primaryGroupId = Number(fields[3]);
  const home = fields[5];
  const shell = fields[6];
  if (
    fields.length < 7 ||
    fields[0] !== action.userName ||
    !Number.isSafeInteger(userId) ||
    userId < 0 ||
    !Number.isSafeInteger(primaryGroupId) ||
    primaryGroupId !== groupId ||
    home !== "/nonexistent" ||
    (shell !== tools.nologin && shell !== "/bin/false")
  ) {
    throw uncertain(
      "The configured Linux service account exists with interactive or unexpected properties.",
    );
  }
  for (const member of action.memberUserNames) {
    const groups = await runRequired(process, {
      executable: tools.id,
      arguments: ["-nG", member],
      timeoutMs: 10_000,
    });
    if (!groups.stdout.trim().split(/\s+/u).includes(action.groupName)) {
      await runRequired(process, {
        executable: tools.usermod,
        arguments: ["--append", "--groups", action.groupName, member],
        timeoutMs: 30_000,
      });
      changed = true;
    }
  }
  return changed ? "changed" : "unchanged";
}

async function ensureMacOsServiceAccount(
  action: Extract<AccountAction, { readonly kind: "account.ensure" }>,
  process: NativeProcessBoundary,
  tools: NativeTools,
): Promise<"changed" | "unchanged"> {
  let changed = false;
  const groupPath = `/Groups/${action.groupName}`;
  const userPath = `/Users/${action.userName}`;
  const groupExists = await dsclPathExists(process, tools.dscl, groupPath);
  let groupId: number;
  if (!groupExists) {
    groupId = await nextMacSystemId(process, tools.dscl, "Groups");
    for (const arguments_ of [
      [".", "-create", groupPath],
      [".", "-create", groupPath, "PrimaryGroupID", String(groupId)],
      [".", "-create", groupPath, "Password", "*"],
    ]) {
      await runRequired(process, {
        executable: tools.dscl,
        arguments: arguments_,
        timeoutMs: 30_000,
      });
    }
    changed = true;
  } else {
    groupId = await readMacNumericAttribute(process, tools.dscl, groupPath, "PrimaryGroupID");
  }
  if (groupId < 200 || groupId >= 500) {
    throw uncertain("The configured macOS service group is outside the system identity range.");
  }
  const userExists = await dsclPathExists(process, tools.dscl, userPath);
  if (!userExists) {
    const userId = await nextMacSystemId(process, tools.dscl, "Users");
    for (const arguments_ of [
      [".", "-create", userPath],
      [".", "-create", userPath, "UniqueID", String(userId)],
      [".", "-create", userPath, "PrimaryGroupID", String(groupId)],
      [".", "-create", userPath, "UserShell", "/usr/bin/false"],
      [".", "-create", userPath, "NFSHomeDirectory", "/var/empty"],
      [".", "-create", userPath, "IsHidden", "1"],
      [".", "-create", userPath, "Password", "*"],
    ]) {
      await runRequired(process, {
        executable: tools.dscl,
        arguments: arguments_,
        timeoutMs: 30_000,
      });
    }
    changed = true;
  } else {
    const [shell, home, primaryGroup, userId, hidden] = await Promise.all([
      readMacAttribute(process, tools.dscl, userPath, "UserShell"),
      readMacAttribute(process, tools.dscl, userPath, "NFSHomeDirectory"),
      readMacNumericAttribute(process, tools.dscl, userPath, "PrimaryGroupID"),
      readMacNumericAttribute(process, tools.dscl, userPath, "UniqueID"),
      readMacAttribute(process, tools.dscl, userPath, "IsHidden"),
    ]);
    if (
      shell !== "/usr/bin/false" ||
      home !== "/var/empty" ||
      primaryGroup !== groupId ||
      userId < 200 ||
      userId >= 500 ||
      hidden !== "1"
    ) {
      throw uncertain(
        "The configured macOS service account exists with interactive or unexpected properties.",
      );
    }
  }
  for (const member of action.memberUserNames) {
    const membership = await process.run({
      executable: tools.dseditgroup,
      arguments: ["-o", "checkmember", "-m", member, action.groupName],
      timeoutMs: 10_000,
    });
    if (membership.exitCode !== 0 || !/yes/u.test(membership.stdout.toLowerCase())) {
      await runRequired(process, {
        executable: tools.dseditgroup,
        arguments: ["-o", "edit", "-a", member, "-t", "user", action.groupName],
        timeoutMs: 30_000,
      });
      changed = true;
    }
  }
  return changed ? "changed" : "unchanged";
}

async function removeServiceAccount(
  configuration: Exclude<PlatformServiceConfiguration, { readonly platform: "windows" }>,
  action: Extract<AccountAction, { readonly kind: "account.remove" }>,
  process: NativeProcessBoundary,
  tools: NativeTools,
): Promise<"changed" | "unchanged"> {
  if (configuration.platform === "linux") {
    let changed = false;
    const user = await process.run({
      executable: tools.getent,
      arguments: ["passwd", action.userName],
      timeoutMs: 10_000,
    });
    if (user.exitCode === 0) {
      await runRequired(process, {
        executable: tools.userdel,
        arguments: [action.userName],
        timeoutMs: 30_000,
      });
      changed = true;
    }
    const group = await process.run({
      executable: tools.getent,
      arguments: ["group", action.groupName],
      timeoutMs: 10_000,
    });
    if (group.exitCode === 0) {
      await runRequired(process, {
        executable: tools.groupdel,
        arguments: [action.groupName],
        timeoutMs: 30_000,
      });
      changed = true;
    }
    return changed ? "changed" : "unchanged";
  }
  let changed = false;
  for (const path of [`/Users/${action.userName}`, `/Groups/${action.groupName}`]) {
    if (await dsclPathExists(process, tools.dscl, path)) {
      await runRequired(process, {
        executable: tools.dscl,
        arguments: [".", "-delete", path],
        timeoutMs: 30_000,
      });
      changed = true;
    }
  }
  return changed ? "changed" : "unchanged";
}

async function applyDirectoryAccess(
  configuration: PlatformServiceConfiguration,
  path: string,
  mode: number,
  owner: string,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
  recoverProtectedOwner = false,
  doNotFollowLinks = false,
  requiredExistingParent?: string,
): Promise<void> {
  if (configuration.platform === "windows") {
    const action = findDirectoryAccess(configuration, path);
    const releaseDirectory = pathJoin(
      configuration.platform,
      configuration.paths.installRoot,
      "releases",
      configuration.bundle.version,
    );
    const resetReleaseTree = equalPath(configuration.platform, path, releaseDirectory);
    // icacls treats /setowner as a separate operation. Combining it with
    // /inheritance and /grant exits with ERROR_INVALID_PARAMETER (87) on a
    // real Windows host even though mocked process boundaries accept it.
    const ownerRequest: NativeProcessRequest = {
      executable: tools.icacls,
      arguments: [
        path,
        "/setowner",
        windowsPrincipal(action.owner),
        ...(doNotFollowLinks ? ["/L"] : []),
      ],
      timeoutMs: 30_000,
    };
    let ownerNeedsFinalTransfer = false;
    if (recoverProtectedOwner) {
      const ownerResult = await boundaries.process.run(ownerRequest);
      if (ownerResult.timedOut) {
        throw new NativeSupervisorError("A protected Windows directory owner repair timed out.");
      }
      if (ownerResult.exitCode !== 0) {
        if (requiredExistingParent !== undefined) {
          await assertOwnerManagedChildBinding(boundaries.fileSystem, requiredExistingParent, path);
        }
        await runRequired(boundaries.process, {
          executable: tools.takeown,
          arguments:
            requiredExistingParent === undefined
              ? ["/F", path, "/A"]
              : ["/F", path, "/A", "/R", "/D", "N", "/SKIPSL"],
          timeoutMs: 30_000,
        });
        if (requiredExistingParent !== undefined) {
          await assertOwnerManagedChildBinding(boundaries.fileSystem, requiredExistingParent, path);
        }
        ownerNeedsFinalTransfer = true;
      }
    } else {
      await runRequired(boundaries.process, ownerRequest);
    }
    const arguments_: string[] = [path, "/inheritance:r"];
    for (const grant of action.grants) {
      arguments_.push(
        "/grant:r",
        `${windowsPrincipal(grant.principal)}:${windowsPermission(grant.permission)}`,
      );
    }
    if (doNotFollowLinks) {
      arguments_.push("/L");
    }
    await runRequired(boundaries.process, {
      executable: tools.icacls,
      arguments: arguments_,
      timeoutMs: 30_000,
    });
    if (ownerNeedsFinalTransfer) {
      await runRequired(boundaries.process, ownerRequest);
    }
    if (resetReleaseTree) {
      await runRequired(boundaries.process, {
        executable: tools.icacls,
        arguments: [path, "/reset", "/T", "/C", "/Q", ...(doNotFollowLinks ? ["/L"] : [])],
        timeoutMs: 30_000,
      });
    }
    return;
  }
  const serviceUid = await resolveUnixId(
    boundaries.process,
    tools.id,
    "-u",
    configuration.serviceIdentity.userName,
  );
  const serviceGid = await resolveUnixId(
    boundaries.process,
    tools.id,
    "-g",
    configuration.serviceIdentity.userName,
  );
  await boundaries.fileSystem.setPosixOwnershipAndMode(
    path,
    owner === "platform-installer" ? 0 : serviceUid,
    serviceGid,
    mode,
  );
}

async function assertOwnerManagedChildBinding(
  fileSystem: NativeServiceBoundaries["fileSystem"],
  parentPath: string,
  childPath: string,
): Promise<void> {
  if (!equalPath("windows", win32.dirname(childPath), parentPath)) {
    throw uncertain("An owner-managed child directory has an invalid parent binding.");
  }
  const [parent, child] = await Promise.all([
    fileSystem.inspect(parentPath),
    fileSystem.inspect(childPath),
  ]);
  if (parent.kind !== "directory" || child.kind !== "directory") {
    throw uncertain("An owner-managed child directory lost its exact parent binding.");
  }
  const [canonicalParent, canonicalChild] = await Promise.all([
    fileSystem.realPath(parentPath),
    fileSystem.realPath(childPath),
  ]);
  if (
    !equalPath("windows", canonicalParent, parentPath) ||
    !equalPath("windows", canonicalChild, childPath)
  ) {
    throw uncertain("An owner-managed child directory changed through a link.");
  }
}

async function applyRenderedFileAccess(
  configuration: PlatformServiceConfiguration,
  file: RenderedFile,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): Promise<void> {
  if (configuration.platform === "windows") {
    return;
  }
  const ownerUid =
    file.purpose === "helper-manifest"
      ? (configuration.ownerSession.uid ?? 0)
      : file.purpose === "core-manifest"
        ? 0
        : await resolveUnixId(
            boundaries.process,
            tools.id,
            "-u",
            configuration.serviceIdentity.userName,
          );
  const groupGid =
    file.purpose === "helper-manifest"
      ? await resolveUnixId(boundaries.process, tools.id, "-g", configuration.ownerSession.userName)
      : file.purpose === "core-manifest"
        ? 0
        : await resolveUnixId(
            boundaries.process,
            tools.id,
            "-g",
            configuration.serviceIdentity.userName,
          );
  await boundaries.fileSystem.setPosixOwnershipAndMode(
    file.path,
    ownerUid,
    groupGid,
    Number.parseInt(file.mode, 8),
  );
}

async function copyReleaseTree(
  platform: PlatformFamily,
  source: string,
  destination: string,
  fileSystem: NativeFileSystemBoundary,
  sourceRootRealPath: string,
  posixAccess?: PosixReleaseAccess,
): Promise<void> {
  const currentRealPath = await fileSystem.realPath(source);
  if (
    !equalPath(platform, currentRealPath, sourceRootRealPath) &&
    !isDescendant(platform, sourceRootRealPath, currentRealPath)
  ) {
    throw uncertain("Release staging detected a source path escaping its verified root.");
  }
  for (const entry of await fileSystem.list(source)) {
    const sourcePath = pathJoin(platform, source, entry.name);
    const destinationPath = pathJoin(platform, destination, entry.name);
    if (entry.kind === "symbolic-link" || entry.kind === "special") {
      throw uncertain("Release staging refused a symbolic link or special file.");
    }
    if (entry.kind === "directory") {
      await fileSystem.ensureDirectory(destinationPath, 0o750);
      if (posixAccess !== undefined) {
        await fileSystem.setPosixOwnershipAndMode(
          destinationPath,
          posixAccess.uid,
          posixAccess.gid,
          0o750,
        );
      }
      await copyReleaseTree(
        platform,
        sourcePath,
        destinationPath,
        fileSystem,
        sourceRootRealPath,
        posixAccess,
      );
    } else {
      const fileRealPath = await fileSystem.realPath(sourcePath);
      if (!isDescendant(platform, sourceRootRealPath, fileRealPath)) {
        throw uncertain("Release staging detected a file escaping its verified root.");
      }
      await fileSystem.copyRegularFile(sourcePath, destinationPath);
      if (posixAccess !== undefined) {
        const metadata = await fileSystem.inspect(sourcePath);
        await fileSystem.setPosixOwnershipAndMode(
          destinationPath,
          posixAccess.uid,
          posixAccess.gid,
          canonicalPosixReleaseFileMode(metadata),
        );
      }
    }
  }
}

interface PosixReleaseAccess {
  readonly uid: number;
  readonly gid: number;
}

async function resolvePosixReleaseAccess(
  configuration: PlatformServiceConfiguration,
  boundaries: NativeServiceBoundaries,
  tools: NativeTools,
): Promise<PosixReleaseAccess | undefined> {
  if (configuration.platform === "windows") {
    return undefined;
  }
  return {
    uid: 0,
    gid: await resolveUnixId(
      boundaries.process,
      tools.id,
      "-g",
      configuration.serviceIdentity.userName,
    ),
  };
}

async function applyPosixReleaseTreeAccess(
  platform: PlatformFamily,
  root: string,
  fileSystem: NativeFileSystemBoundary,
  access: PosixReleaseAccess,
): Promise<void> {
  const rootMetadata = await fileSystem.inspect(root);
  if (rootMetadata.kind !== "directory") {
    throw uncertain("Release access normalization requires a regular directory root.");
  }
  await fileSystem.setPosixOwnershipAndMode(root, access.uid, access.gid, 0o750);
  for (const entry of await fileSystem.list(root)) {
    const path = pathJoin(platform, root, entry.name);
    if (entry.kind === "symbolic-link" || entry.kind === "special") {
      throw uncertain("Release access normalization refused a symbolic link or special file.");
    }
    if (entry.kind === "directory") {
      await applyPosixReleaseTreeAccess(platform, path, fileSystem, access);
      continue;
    }
    const metadata = await fileSystem.inspect(path);
    await fileSystem.setPosixOwnershipAndMode(
      path,
      access.uid,
      access.gid,
      canonicalPosixReleaseFileMode(metadata),
    );
  }
}

function canonicalPosixReleaseFileMode(metadata: NativePathMetadata): number {
  if (metadata.kind !== "regular-file" || metadata.mode === undefined) {
    throw uncertain("Release access normalization could not inspect a regular file mode.");
  }
  return (metadata.mode & 0o111) === 0 ? 0o640 : 0o750;
}

async function pruneReleases(
  platform: PlatformFamily,
  releasesRoot: string,
  activeVersion: string,
  retainPreviousVersions: number,
  fileSystem: NativeFileSystemBoundary,
): Promise<"changed" | "unchanged"> {
  const metadata = await fileSystem.inspect(releasesRoot);
  if (metadata.kind === "missing") {
    return "unchanged";
  }
  if (metadata.kind !== "directory") {
    throw uncertain("The release retention root is not a regular directory.");
  }
  const versions: string[] = [];
  for (const entry of await fileSystem.list(releasesRoot)) {
    if (entry.kind !== "directory" || !SEMVER_PATTERN.test(entry.name)) {
      throw uncertain("Release pruning refused a linked, special, or unversioned entry.");
    }
    versions.push(entry.name);
  }
  if (!versions.includes(activeVersion)) {
    throw uncertain("Release pruning could not find the active version.");
  }
  versions.sort(compareSemanticVersionsDescending);
  const previous = versions
    .filter((version) => version !== activeVersion)
    .slice(0, retainPreviousVersions);
  const retained = new Set([activeVersion, ...previous]);
  let changed = false;
  for (const version of versions) {
    if (!retained.has(version)) {
      await fileSystem.remove(pathJoin(platform, releasesRoot, version), true);
      changed = true;
    }
  }
  return changed ? "changed" : "unchanged";
}

async function rollbackPartialSupervisorOperation(
  configuration: PlatformServiceConfiguration,
  operation: SupervisorOperation,
  completed: readonly {
    readonly invocation: CommandInvocation;
    readonly exitCode: number;
  }[],
  process: NativeProcessBoundary,
  clock: NativeClockBoundary,
  fileSystem: NativeFileSystemBoundary,
  tools: NativeTools,
): Promise<void> {
  for (const entry of [...completed].reverse()) {
    if (invocationAlreadySatisfied(configuration.platform, entry.invocation, entry.exitCode)) {
      continue;
    }
    const inverse = inverseSupervisorInvocation(entry.invocation);
    if (inverse === undefined) {
      continue;
    }
    const result = await runSupervisorInvocation(
      configuration,
      inverse,
      process,
      clock,
      fileSystem,
      tools,
    );
    if (result.timedOut || !inverse.expectedExitCodes.includes(result.exitCode)) {
      throw uncertain(`A partial ${operation.plane} supervisor mutation could not be rolled back.`);
    }
  }
}

function inverseSupervisorInvocation(invocation: CommandInvocation): CommandInvocation | undefined {
  const args = invocation.arguments;
  if (invocation.executable === "sc.exe" && args[0] === "start" && args[1] !== undefined) {
    return {
      ...invocation,
      arguments: ["stop", args[1]],
      verb: "stop",
      expectedExitCodes: [0, 1060, 1062],
    };
  }
  if (invocation.executable === "sc.exe" && args[0] === "stop" && args[1] !== undefined) {
    return {
      ...invocation,
      arguments: ["start", args[1]],
      verb: "start",
      expectedExitCodes: [0, 1056, 1060],
    };
  }
  if (invocation.executable === "sc.exe" && args[0] === "create" && args[1] !== undefined) {
    return {
      ...invocation,
      arguments: ["delete", args[1]],
      verb: "remove",
      expectedExitCodes: [0, 1060],
    };
  }
  if (invocation.executable === "schtasks.exe" && args[0]?.toLowerCase() === "/create") {
    const taskIndex = args.findIndex((value) => value.toLowerCase() === "/tn");
    const taskName = args[taskIndex + 1];
    return taskName === undefined
      ? undefined
      : {
          ...invocation,
          arguments: ["/Delete", "/TN", taskName, "/F"],
          verb: "remove",
          expectedExitCodes: [0, 1],
        };
  }
  if (args[0] === "enable" && args[1] !== undefined) {
    return {
      ...invocation,
      arguments: ["disable", args[1]],
      verb: "disable",
      expectedExitCodes: [0],
    };
  }
  if (args[0] === "bootstrap" && args[1] !== undefined) {
    const label = launchdLabelFromManifest(args[2]);
    return label === undefined
      ? undefined
      : {
          ...invocation,
          arguments: ["bootout", `${args[1]}/${label}`],
          verb: "remove",
          expectedExitCodes: [0, 3, 5],
        };
  }
  const systemdOffset =
    args[0] === "--user" && args[1] === "--no-reload" ? 2 : args[0] === "--user" ? 1 : 0;
  const systemdPrefix =
    args[0] === "--user"
      ? args[1] === "--no-reload"
        ? ["--user", "--no-reload"]
        : ["--user"]
      : [];
  if (args[systemdOffset] === "enable" && args[systemdOffset + 1] !== undefined) {
    return {
      ...invocation,
      arguments: [...systemdPrefix, "disable", args[systemdOffset + 1]!],
      verb: "remove",
      expectedExitCodes: [0, 1],
    };
  }
  if (args[systemdOffset] === "start" && args[systemdOffset + 1] !== undefined) {
    return {
      ...invocation,
      arguments: [...systemdPrefix, "stop", args[systemdOffset + 1]!],
      verb: "stop",
      expectedExitCodes: [0],
    };
  }
  return undefined;
}

async function runSupervisorInvocation(
  configuration: PlatformServiceConfiguration,
  invocation: CommandInvocation,
  process: NativeProcessBoundary,
  clock: NativeClockBoundary,
  fileSystem: NativeFileSystemBoundary,
  tools: NativeTools,
): Promise<NativeProcessResult> {
  const executable = resolveSupervisorExecutable(invocation.executable, tools);
  if (invocation.privilege !== "owner-session" || configuration.platform === "windows") {
    const result = await process.run({
      executable,
      arguments: invocation.arguments,
      timeoutMs: invocation.timeoutMs,
    });
    if (
      configuration.platform === "windows" &&
      invocation.executable.toLowerCase() === "sc.exe" &&
      invocation.arguments[0]?.toLowerCase() === "stop" &&
      result.exitCode === 0 &&
      !result.timedOut
    ) {
      const serviceName = invocation.arguments[1];
      if (serviceName === undefined) {
        throw new NativeSupervisorError("A Windows service stop command has no service name.");
      }
      await waitForWindowsServiceStopped({
        executable,
        serviceName,
        timeoutMs: invocation.timeoutMs,
        process,
        clock,
      });
    }
    if (
      configuration.platform === "windows" &&
      invocation.executable.toLowerCase() === "schtasks.exe" &&
      invocation.arguments[0]?.toLowerCase() === "/end" &&
      result.exitCode === 0 &&
      !result.timedOut
    ) {
      const taskIndex = invocation.arguments.findIndex((value) => value.toLowerCase() === "/tn");
      const taskName = invocation.arguments[taskIndex + 1];
      if (taskName === undefined) {
        throw new NativeSupervisorError("A Windows scheduled-task stop command has no task name.");
      }
      await waitForWindowsScheduledTaskStopped({
        executable,
        taskName,
        timeoutMs: invocation.timeoutMs,
        process,
        clock,
        fileSystem,
        helperPresencePath: win32.join(configuration.paths.runtimeRoot, "helper-plane-v2.json"),
      });
    }
    if (
      configuration.platform === "macos" &&
      invocation.executable === "/bin/launchctl" &&
      invocation.arguments[0] === "bootout" &&
      result.exitCode === 0 &&
      !result.timedOut
    ) {
      await waitForMacOsLaunchdBootout({
        configuration,
        invocation,
        process,
        clock,
        tools,
      });
    }
    return result;
  }
  if (configuration.platform === "macos") {
    const result = await process.run({
      executable: tools.launchctl,
      arguments: [
        "asuser",
        String(configuration.ownerSession.uid),
        executable,
        ...invocation.arguments,
      ],
      timeoutMs: invocation.timeoutMs,
      environment: ownerEnvironment(configuration),
    });
    if (
      invocation.executable === "/bin/launchctl" &&
      invocation.arguments[0] === "bootout" &&
      result.exitCode === 0 &&
      !result.timedOut
    ) {
      await waitForMacOsLaunchdBootout({
        configuration,
        invocation,
        process,
        clock,
        tools,
      });
    }
    return result;
  }
  return await process.run({
    executable: tools.runuser,
    arguments: [
      "-u",
      configuration.ownerSession.userName,
      "--",
      executable,
      ...invocation.arguments,
    ],
    timeoutMs: invocation.timeoutMs,
    environment: ownerEnvironment(configuration),
  });
}

async function waitForMacOsLaunchdBootout(input: {
  readonly configuration: Extract<PlatformServiceConfiguration, { readonly platform: "macos" }>;
  readonly invocation: CommandInvocation;
  readonly process: NativeProcessBoundary;
  readonly clock: NativeClockBoundary;
  readonly tools: NativeTools;
}): Promise<void> {
  const target = input.invocation.arguments[1];
  if (target === undefined) {
    throw new NativeSupervisorError("A macOS launchd bootout command has no service target.");
  }
  const deadline = input.clock.now().getTime() + input.invocation.timeoutMs;
  for (;;) {
    const remainingMs = deadline - input.clock.now().getTime();
    if (remainingMs <= 0) {
      throw new NativeSupervisorError("The macOS launchd service did not unload before timeout.");
    }
    let status: NativeProcessResult | undefined;
    try {
      status = await input.process.run({
        executable: input.tools.launchctl,
        arguments:
          input.invocation.privilege === "owner-session"
            ? [
                "asuser",
                String(input.configuration.ownerSession.uid),
                input.tools.launchctl,
                "print",
                target,
              ]
            : ["print", target],
        timeoutMs: Math.max(1, Math.min(5_000, remainingMs)),
        ...(input.invocation.privilege === "owner-session"
          ? { environment: ownerEnvironment(input.configuration) }
          : {}),
      });
    } catch {
      // A transient status-process failure is not proof that launchd unloaded the
      // service. Retry within the original bounded lifecycle timeout.
    }
    if (status !== undefined && !status.timedOut && status.exitCode === 113) {
      return;
    }
    await input.clock.sleep(Math.max(1, Math.min(250, remainingMs)));
  }
}

export async function waitForWindowsScheduledTaskStopped(input: {
  readonly executable: string;
  readonly taskName: string;
  readonly timeoutMs: number;
  readonly process: NativeProcessBoundary;
  readonly clock: NativeClockBoundary;
  readonly fileSystem: NativeFileSystemBoundary;
  readonly helperPresencePath: string;
}): Promise<void> {
  const deadline = input.clock.now().getTime() + input.timeoutMs;
  for (;;) {
    const remainingMs = deadline - input.clock.now().getTime();
    if (remainingMs <= 0) {
      throw new NativeSupervisorError("The Windows scheduled task did not stop before timeout.");
    }
    const status = await input.process.run({
      executable: input.executable,
      arguments: ["/Query", "/TN", input.taskName, "/FO", "CSV", "/NH"],
      timeoutMs: Math.max(1, Math.min(5_000, remainingMs)),
    });
    let supervisorStopped = !status.timedOut && status.exitCode === 1;
    if (!status.timedOut && status.exitCode === 0) {
      const state = parseSupervisorState("windows", "session-helper", status);
      supervisorStopped = state !== "running";
    } else if (!status.timedOut) {
      if (status.exitCode !== 1) {
        throw new NativeSupervisorError(
          "The Windows scheduled-task stop state could not be inspected.",
        );
      }
    }
    if (
      supervisorStopped &&
      (await windowsHelperPresenceProcessStopped(
        input.fileSystem,
        input.process,
        input.helperPresencePath,
      ))
    ) {
      return;
    }
    const sleepMs = Math.min(500, deadline - input.clock.now().getTime());
    if (sleepMs <= 0) {
      throw new NativeSupervisorError("The Windows scheduled task did not stop before timeout.");
    }
    await input.clock.sleep(sleepMs);
  }
}

async function windowsHelperPresenceProcessStopped(
  fileSystem: NativeFileSystemBoundary,
  process: NativeProcessBoundary,
  presencePath: string,
): Promise<boolean> {
  const processId = await readWindowsHelperPresenceProcessId(fileSystem, presencePath);
  return processId === undefined || !(await process.isProcessAlive(processId));
}

async function readWindowsSessionHelperPresenceState(
  configuration: Extract<PlatformServiceConfiguration, { readonly platform: "windows" }>,
  boundaries: NativeServiceBoundaries,
): Promise<SupervisorState | undefined> {
  try {
    const processId = await readWindowsHelperPresenceProcessId(
      boundaries.fileSystem,
      win32.join(configuration.paths.runtimeRoot, "helper-plane-v2.json"),
      {
        instanceId: configuration.instanceId,
        deviceId: configuration.deviceId,
        releaseVersion: configuration.bundle.version,
      },
    );
    return processId === undefined
      ? undefined
      : (await boundaries.process.isProcessAlive(processId))
        ? "running"
        : "stopped";
  } catch {
    return "unknown";
  }
}

async function readWindowsHelperPresenceProcessId(
  fileSystem: NativeFileSystemBoundary,
  presencePath: string,
  expected?: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly releaseVersion: string;
  },
): Promise<number | undefined> {
  const metadata = await fileSystem.inspect(presencePath);
  if (metadata.kind === "missing") {
    return undefined;
  }
  if (
    metadata.kind !== "regular-file" ||
    typeof metadata.size !== "number" ||
    metadata.size > 4_096
  ) {
    throw new NativeSupervisorError("The Windows helper presence record is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse((await fileSystem.read(presencePath, 4_096)).toString("utf8"));
  } catch {
    throw new NativeSupervisorError("The Windows helper presence record could not be read.");
  }
  const processId =
    parsed !== null &&
    typeof parsed === "object" &&
    "payload" in parsed &&
    parsed.payload !== null &&
    typeof parsed.payload === "object" &&
    "processId" in parsed.payload
      ? parsed.payload.processId
      : undefined;
  if (!Number.isSafeInteger(processId) || Number(processId) <= 0) {
    throw new NativeSupervisorError("The Windows helper presence process identity is invalid.");
  }
  if (expected !== undefined) {
    const payload = (parsed as { readonly payload: Readonly<Record<string, unknown>> }).payload;
    if (
      payload["plane"] !== "session-helper" ||
      payload["instanceId"] !== expected.instanceId ||
      payload["deviceId"] !== expected.deviceId ||
      payload["releaseVersion"] !== expected.releaseVersion
    ) {
      throw new NativeSupervisorError("The Windows helper presence identity is invalid.");
    }
  }
  return Number(processId);
}

async function waitForWindowsServiceStopped(input: {
  readonly executable: string;
  readonly serviceName: string;
  readonly timeoutMs: number;
  readonly process: NativeProcessBoundary;
  readonly clock: NativeClockBoundary;
}): Promise<void> {
  const deadline = input.clock.now().getTime() + input.timeoutMs;
  let transientInspectionFailures = 0;
  for (;;) {
    const remainingMs = deadline - input.clock.now().getTime();
    if (remainingMs <= 0) {
      throw new NativeSupervisorError(
        "The Windows service did not reach a terminal stopped state before timeout.",
      );
    }
    let status: NativeProcessResult;
    try {
      status = await input.process.run({
        executable: input.executable,
        arguments: ["query", input.serviceName],
        timeoutMs: Math.max(1, Math.min(5_000, remainingMs)),
      });
      transientInspectionFailures = 0;
    } catch (error) {
      if (!(error instanceof NativeBoundaryError) || transientInspectionFailures >= 2) {
        throw error;
      }
      transientInspectionFailures += 1;
      const retryDelayMs = Math.min(500, deadline - input.clock.now().getTime());
      if (retryDelayMs <= 0) {
        throw error;
      }
      await input.clock.sleep(retryDelayMs);
      continue;
    }
    if (!status.timedOut && status.exitCode === 1060) {
      return;
    }
    if (
      !status.timedOut &&
      status.exitCode === 0 &&
      windowsServiceStateCode(status.stdout) === "1"
    ) {
      return;
    }
    if (!status.timedOut && status.exitCode !== 0) {
      throw new NativeSupervisorError("The Windows service stop state could not be inspected.");
    }
    const sleepMs = Math.min(500, deadline - input.clock.now().getTime());
    if (sleepMs <= 0) {
      throw new NativeSupervisorError(
        "The Windows service did not reach a terminal stopped state before timeout.",
      );
    }
    await input.clock.sleep(sleepMs);
  }
}

function supervisorStatusRequest(
  configuration: PlatformServiceConfiguration,
  plane: "core" | "session-helper",
  tools: NativeTools,
): NativeProcessRequest {
  const instanceId = configuration.instanceId;
  if (configuration.platform === "windows") {
    return plane === "core"
      ? {
          executable: tools.sc,
          arguments: ["query", `OpenDelegate-${instanceId}`],
          timeoutMs: 10_000,
        }
      : {
          executable: tools.schtasks,
          arguments: [
            "/Query",
            "/TN",
            `\\OpenDelegate-${instanceId}-SessionHelper`,
            "/FO",
            "CSV",
            "/NH",
          ],
          timeoutMs: 10_000,
        };
  }
  if (configuration.platform === "macos") {
    const label =
      plane === "core"
        ? `system/dev.opendelegate.${instanceId}.core`
        : `gui/${String(configuration.ownerSession.uid)}/dev.opendelegate.${instanceId}.session-helper`;
    return {
      executable: tools.launchctl,
      arguments: ["print", label],
      timeoutMs: 10_000,
      ...(plane === "session-helper" ? { environment: ownerEnvironment(configuration) } : {}),
    };
  }
  const unit =
    plane === "core"
      ? `opendelegate-${instanceId}.service`
      : `opendelegate-${instanceId}-session-helper.service`;
  if (plane === "core") {
    return {
      executable: tools.systemctl,
      arguments: ["is-active", unit],
      timeoutMs: 10_000,
    };
  }
  return {
    executable: tools.runuser,
    arguments: [
      "-u",
      configuration.ownerSession.userName,
      "--",
      tools.systemctl,
      "--user",
      "is-active",
      unit,
    ],
    timeoutMs: 10_000,
    environment: ownerEnvironment(configuration),
  };
}

function parseSupervisorState(
  platform: PlatformFamily,
  plane: "core" | "session-helper",
  result: NativeProcessResult,
): SupervisorState {
  if (platform === "windows") {
    if (plane === "core") {
      if (result.exitCode === 1060) {
        return "not-installed";
      }
      const numeric = windowsServiceStateCode(result.stdout);
      return numeric === "4"
        ? "running"
        : numeric === "2"
          ? "starting"
          : numeric === undefined
            ? result.exitCode === 0
              ? "unknown"
              : "not-installed"
            : "stopped";
    }
    if (result.exitCode !== 0) {
      return "not-installed";
    }
    const normalized = result.stdout.toLowerCase();
    return normalized.includes('"running"') || normalized.includes(",running,")
      ? "running"
      : "unknown";
  }
  if (platform === "macos") {
    if (result.exitCode !== 0) {
      return "not-loaded";
    }
    const state = /\bstate\s*=\s*([a-z-]+)/u.exec(result.stdout)?.[1];
    return state === "running" ? "running" : state === undefined ? "unknown" : "stopped";
  }
  const state = result.stdout.trim();
  if (state === "active" && result.exitCode === 0) {
    return "running";
  }
  if (state === "activating") {
    return "starting";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "inactive" || state === "deactivating") {
    return "stopped";
  }
  return result.exitCode === 4 ? "not-installed" : "unknown";
}

function windowsServiceStateCode(output: string): string | undefined {
  const named =
    /\b(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/iu
      .exec(output)?.[1]
      ?.toUpperCase();
  if (named !== undefined) {
    return {
      STOPPED: "1",
      START_PENDING: "2",
      STOP_PENDING: "3",
      RUNNING: "4",
      CONTINUE_PENDING: "5",
      PAUSE_PENDING: "6",
      PAUSED: "7",
    }[named];
  }
  return /^\s*[^:\r\n]+:\s*([1-7])(?:\s|$)/mu.exec(output)?.[1];
}

async function probeCoreOnce(
  configuration: PlatformServiceConfiguration,
  endpoint: string,
  timeoutMs: number,
  boundaries: Pick<NativeServiceBoundaries, "http">,
): Promise<boolean> {
  try {
    const response = await boundaries.http.get(endpoint, timeoutMs);
    if (response.status < 200 || response.status >= 300) {
      return false;
    }
    const body = JSON.parse(response.body) as unknown;
    return isRunningCoreHealthResponseV1(body, {
      instanceId: configuration.instanceId,
      deviceId: configuration.deviceId,
      role: configuration.role,
      releaseVersion: configuration.bundle.version,
    });
  } catch {
    return false;
  }
}

async function readActiveVersion(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
): Promise<string | undefined> {
  const definition = createPlatformServiceDefinition(configuration);
  try {
    const target = await fileSystem.readDirectoryLink(definition.activeDirectory);
    if (target === undefined) {
      return undefined;
    }
    const path = configuration.platform === "windows" ? win32 : posix;
    const version = path.basename(target);
    return SEMVER_PATTERN.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

async function readRetainedVersions(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
): Promise<readonly string[]> {
  const releasesRoot = pathJoin(
    configuration.platform,
    configuration.paths.installRoot,
    "releases",
  );
  try {
    const metadata = await fileSystem.inspect(releasesRoot);
    if (metadata.kind !== "directory") {
      return [];
    }
    const versions: string[] = [];
    for (const entry of await fileSystem.list(releasesRoot)) {
      if (entry.kind === "directory" && SEMVER_PATTERN.test(entry.name)) {
        versions.push(entry.name);
      }
    }
    return versions.sort(compareSemanticVersionsDescending);
  } catch {
    return [];
  }
}

async function assertMutationTopologySafe(
  configuration: PlatformServiceConfiguration,
  plan: ServicePlan,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const paths = new Set<string>([
    configuration.paths.installRoot,
    configuration.paths.stateRoot,
    configuration.paths.authorityRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
    nativeServiceJournalRoot(configuration),
  ]);
  const allowedLeafLinks = new Set<string>();
  if (plan.operation === "install" || plan.operation === "upgrade") {
    paths.add(configuration.bundle.sourceDirectory);
    paths.add(`${configuration.bundle.sourceDirectory}.publisher-attestation.json`);
    paths.add(
      pathJoin(
        configuration.platform,
        configuration.paths.stateRoot,
        "trust",
        "publisher-ed25519.pem",
      ),
    );
  }
  if (plan.operation === "upgrade") {
    for (const file of renderPlatformServiceArtifacts(configuration).files) {
      paths.add(file.path);
    }
  }
  for (const step of plan.steps) {
    collectActionPaths(step.action, paths);
    if (step.action.kind === "file.symbolic-link.ensure") {
      allowedLeafLinks.add(normalizedPathKey(configuration.platform, step.action.path));
    }
    if (step.rollback !== undefined) {
      collectActionPaths(step.rollback, paths);
      if (step.rollback.kind === "file.symbolic-link.ensure") {
        allowedLeafLinks.add(normalizedPathKey(configuration.platform, step.rollback.path));
      }
    }
  }
  for (const path of paths) {
    await assertNoLinkedAncestor(
      configuration.platform,
      path,
      fileSystem,
      path.endsWith(`${pathSeparator(configuration.platform)}current`) ||
        allowedLeafLinks.has(normalizedPathKey(configuration.platform, path)),
    );
  }
}

async function assertNoLinkedAncestor(
  platform: PlatformFamily,
  path: string,
  fileSystem: NativeFileSystemBoundary,
  allowLeafLink: boolean,
): Promise<void> {
  const pathApi = platform === "windows" ? win32 : posix;
  const root = pathApi.parse(path).root;
  const relative = pathApi.relative(root, path);
  let current = root;
  const segments = relative === "" ? [] : relative.split(pathApi.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = pathApi.join(current, segments[index]!);
    const metadata = await fileSystem.inspect(current);
    if (metadata.kind === "missing") {
      return;
    }
    if (metadata.kind === "symbolic-link" && allowLeafLink && index === segments.length - 1) {
      return;
    }
    if (metadata.kind !== "directory" && index < segments.length - 1) {
      failPreflight("A native service mutation path has a non-directory ancestor.");
    }
    if (metadata.kind === "symbolic-link" || metadata.kind === "special") {
      failPreflight("A native service mutation path crosses a link or special entry.");
    }
  }
}

async function assertRenderedFilePreconditions(
  plan: ServicePlan,
  fileSystem: NativeFileSystemBoundary,
  platform: PlatformFamily,
): Promise<void> {
  if (plan.operation === "reconfigure" || plan.operation === "upgrade") {
    return;
  }
  for (const step of plan.steps) {
    if (step.action.kind !== "file.write") {
      continue;
    }
    const file = step.action.file;
    const metadata = await fileSystem.inspect(file.path);
    if (metadata.kind === "missing") {
      continue;
    }
    if (metadata.kind !== "regular-file") {
      failPreflight("A rendered service file path is occupied by a link or special file.");
    }
    failPreflight(
      `Install refused to adopt or overwrite an existing ${platform} service file without an explicit recovery operation.`,
    );
  }
}

async function assertReconfigurationMatchesInstalled(
  configuration: PlatformServiceConfiguration,
  previousConfiguration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const desiredFiles = renderPlatformServiceArtifacts(configuration).files;
  const previousFiles = new Map(
    renderPlatformServiceArtifacts(previousConfiguration).files.map((file) => [file.path, file]),
  );
  for (const file of desiredFiles) {
    const previousFile = previousFiles.get(file.path);
    if (previousFile === undefined || previousFile.purpose !== file.purpose) {
      failPreflight(
        "Service reconfiguration requires the installed service topology to remain unchanged.",
      );
    }
    let existing: Buffer;
    try {
      existing = await fileSystem.read(file.path, MAXIMUM_RENDERED_FILE_BYTES);
    } catch (error) {
      throw new ServiceCommandExecutionError(
        "SERVICE_COMMAND_PREFLIGHT_FAILED",
        "Service reconfiguration requires every installed service definition to be readable.",
        false,
        { cause: error },
      );
    }
    const desired = encodeRenderedFile(file);
    const previous = encodeRenderedFile(previousFile);
    const matchesExpected =
      file.purpose === "runtime-configuration"
        ? existing.equals(desired) || existing.equals(previous)
        : existing.equals(desired);
    if (!matchesExpected) {
      failPreflight(
        "Service reconfiguration refused unrelated installed service-definition drift.",
      );
    }
  }
}

async function assertRuntimeConfigurationMatchesInstalled(
  configuration: PlatformServiceConfiguration,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const expected = renderPlatformServiceArtifacts(configuration).files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  if (expected === undefined) {
    failPreflight("The canonical runtime configuration is unavailable.");
  }
  let existing: Buffer;
  try {
    existing = await fileSystem.read(expected.path, MAXIMUM_RENDERED_FILE_BYTES);
  } catch (error) {
    throw new ServiceCommandExecutionError(
      "SERVICE_COMMAND_PREFLIGHT_FAILED",
      "Windows start and restart require the installed runtime configuration to be readable.",
      false,
      { cause: error },
    );
  }
  if (!existing.equals(encodeRenderedFile(expected))) {
    failPreflight(
      "Windows start and restart refused installed runtime-configuration drift before Agent access repair.",
    );
  }
}

async function assertUpgradeConfigurationMatchesInstalled(
  configuration: PlatformServiceConfiguration,
  activeVersion: string,
  fileSystem: NativeFileSystemBoundary,
): Promise<void> {
  const installedConfiguration = parsePlatformServiceConfiguration({
    ...configuration,
    bundle: {
      ...configuration.bundle,
      version: activeVersion,
    },
  });
  const installedFiles = new Map(
    renderPlatformServiceArtifacts(installedConfiguration).files.map((file) => [file.path, file]),
  );
  for (const targetFile of renderPlatformServiceArtifacts(configuration).files) {
    const installedFile = installedFiles.get(targetFile.path);
    if (installedFile === undefined || installedFile.purpose !== targetFile.purpose) {
      failPreflight("Upgrade requires the installed service topology to match the target version.");
    }
    const expected = encodeRenderedFile(installedFile);
    let existing: Buffer;
    try {
      existing = await fileSystem.read(targetFile.path, MAXIMUM_RENDERED_FILE_BYTES);
    } catch (error) {
      throw new ServiceCommandExecutionError(
        "SERVICE_COMMAND_PREFLIGHT_FAILED",
        "Upgrade requires every installed service definition to match the target configuration.",
        false,
        { cause: error },
      );
    }
    if (
      !existing.equals(expected) &&
      !matchesLegacyWindowsRestrictedSidManifest(configuration, installedFile, existing) &&
      !matchesLegacyWindowsVisibleHelperTask(configuration, installedFile, existing) &&
      !matchesLegacyMacOsManifestWithoutServicePath(configuration, installedFile, existing) &&
      !matchesCombinedWindowsRuntimeMigrations(configuration, installedFile, existing) &&
      !matchesLegacyWindowsRuntimeWithoutOwnerBindings(configuration, installedFile, existing) &&
      !matchesWindowsWorkerCredentialMigrationRuntimeConfiguration(
        configuration,
        installedFile,
        existing,
      )
    ) {
      failPreflight(
        "Upgrade refused a configuration that does not exactly match the installed service definitions.",
      );
    }
  }
}

function matchesLegacyWindowsVisibleHelperTask(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  if (
    configuration.platform !== "windows" ||
    installedFile.purpose !== "helper-manifest" ||
    installedFile.encoding !== "utf16le-bom"
  ) {
    return false;
  }
  const hiddenSetting = "    <Hidden>true</Hidden>\n";
  const markerOffset = installedFile.content.indexOf(hiddenSetting);
  if (markerOffset < 0 || markerOffset !== installedFile.content.lastIndexOf(hiddenSetting)) {
    return false;
  }
  const legacyContent =
    installedFile.content.slice(0, markerOffset) +
    installedFile.content.slice(markerOffset + hiddenSetting.length);
  return existing.equals(
    encodeRenderedFile({
      ...installedFile,
      content: legacyContent,
    }),
  );
}

function matchesLegacyWindowsRuntimeWithoutOwnerBindings(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  const migrated = migrateLegacyWindowsRuntimeOwnerBindings(configuration, installedFile, existing);
  return migrated !== undefined && migrated.equals(encodeRenderedFile(installedFile));
}

function matchesCombinedWindowsRuntimeMigrations(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  const ownerBindingMigration = migrateLegacyWindowsRuntimeOwnerBindings(
    configuration,
    installedFile,
    existing,
  );
  return (
    ownerBindingMigration !== undefined &&
    matchesWindowsWorkerCredentialMigrationRuntimeConfiguration(
      configuration,
      installedFile,
      ownerBindingMigration,
    )
  );
}

function migrateLegacyWindowsRuntimeOwnerBindings(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): Buffer | undefined {
  if (
    configuration.platform !== "windows" ||
    installedFile.purpose !== "runtime-configuration" ||
    installedFile.encoding !== "utf8" ||
    configuration.ownerSession.homeDirectory === undefined
  ) {
    return undefined;
  }
  let previous: Record<string, unknown>;
  let expected: Record<string, unknown>;
  try {
    previous = requireJsonRecord(JSON.parse(existing.toString("utf8")) as unknown);
    expected = requireJsonRecord(JSON.parse(installedFile.content) as unknown);
  } catch {
    return undefined;
  }
  const previousOwner = nestedRecord(previous, "ownerSession");
  const expectedOwner = nestedRecord(expected, "ownerSession");
  if (
    previousOwner === undefined ||
    expectedOwner === undefined ||
    existing.toString("utf8") !== stableJson(previous)
  ) {
    return undefined;
  }
  let migrated = false;
  if (!Object.hasOwn(previousOwner, "homeDirectory")) {
    if (expectedOwner["homeDirectory"] !== configuration.ownerSession.homeDirectory) {
      return undefined;
    }
    previousOwner["homeDirectory"] = expectedOwner["homeDirectory"];
    migrated = true;
  }
  if (!Object.hasOwn(previous, "agentProviderAccess")) {
    if (!Object.hasOwn(expected, "agentProviderAccess")) {
      return undefined;
    }
    previous["agentProviderAccess"] = expected["agentProviderAccess"];
    migrated = true;
  } else {
    const previousAccess = nestedRecord(previous, "agentProviderAccess");
    const expectedAccess = nestedRecord(expected, "agentProviderAccess");
    if (previousAccess === undefined || expectedAccess === undefined) {
      return undefined;
    }
    if (!Object.hasOwn(previousAccess, "codexServiceHomeDirectory")) {
      if (
        expectedAccess["codexServiceHomeDirectory"] !==
        configuration.agentProviderAccess.codexServiceHomeDirectory
      ) {
        return undefined;
      }
      previousAccess["codexServiceHomeDirectory"] = expectedAccess["codexServiceHomeDirectory"];
      migrated = true;
    }
  }
  return migrated ? Buffer.from(stableJson(previous), "utf8") : undefined;
}

function matchesWindowsWorkerCredentialMigrationRuntimeConfiguration(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  if (
    configuration.platform !== "windows" ||
    configuration.role !== "worker" ||
    installedFile.purpose !== "runtime-configuration" ||
    installedFile.encoding !== "utf8"
  ) {
    return false;
  }
  let previous: Record<string, unknown>;
  let expected: Record<string, unknown>;
  try {
    previous = requireJsonRecord(JSON.parse(existing.toString("utf8")) as unknown);
    expected = requireJsonRecord(JSON.parse(installedFile.content) as unknown);
  } catch {
    return false;
  }
  const previousHelperBinding = nestedRecord(previous, "helperSecretBinding");
  const expectedHelperBinding = nestedRecord(expected, "helperSecretBinding");
  const previousIpc = nestedRecord(previous, "localIpc");
  const expectedIpc = nestedRecord(expected, "localIpc");
  if (previousIpc === undefined || expectedIpc === undefined) {
    return false;
  }
  const previousCore = nestedRecord(previousIpc, "core");
  const expectedCore = nestedRecord(expectedIpc, "core");
  const previousHelper = nestedRecord(previousIpc, "helper");
  const expectedHelper = nestedRecord(expectedIpc, "helper");
  if (
    previousHelperBinding === undefined ||
    expectedHelperBinding === undefined ||
    previousCore === undefined ||
    expectedCore === undefined ||
    previousHelper === undefined ||
    expectedHelper === undefined ||
    previousHelperBinding["backend"] !== "windows-dpapi" ||
    expectedHelperBinding["backend"] !== "windows-dpapi"
  ) {
    return false;
  }
  const previousVaultRoot = previousHelperBinding["vaultRoot"];
  const expectedVaultRoot = expectedHelperBinding["vaultRoot"];
  if (
    typeof previousVaultRoot !== "string" ||
    typeof expectedVaultRoot !== "string" ||
    !safeWindowsOwnerVault(configuration, previousVaultRoot) ||
    !safeWindowsOwnerVault(configuration, expectedVaultRoot) ||
    !coherentIpcCredentialPair(previousCore, previousHelper) ||
    !coherentIpcCredentialPair(expectedCore, expectedHelper)
  ) {
    return false;
  }
  const changed =
    previousVaultRoot !== expectedVaultRoot ||
    previousCore["keyId"] !== expectedCore["keyId"] ||
    previousCore["publicKeySpkiBase64Url"] !== expectedCore["publicKeySpkiBase64Url"];
  if (!changed) {
    return false;
  }

  // The elevated upgrade target is authoritative for the staged owner vault
  // and core IPC identity. Normalize only those mutually redundant fields;
  // stable equality below still rejects every unrelated installed drift.
  previousHelperBinding["vaultRoot"] = expectedVaultRoot;
  previousCore["keyId"] = expectedCore["keyId"];
  previousCore["publicKeySpkiBase64Url"] = expectedCore["publicKeySpkiBase64Url"];
  previousHelper["peerKeyId"] = expectedHelper["peerKeyId"];
  previousHelper["peerPublicKeySpkiBase64Url"] = expectedHelper["peerPublicKeySpkiBase64Url"];
  return stableJson(previous) === stableJson(expected);
}

function requireJsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  try {
    return requireJsonRecord(value[key]);
  } catch {
    return undefined;
  }
}

function coherentIpcCredentialPair(
  core: Record<string, unknown>,
  helper: Record<string, unknown>,
): boolean {
  const keyId = core["keyId"];
  const publicKey = core["publicKeySpkiBase64Url"];
  return (
    typeof keyId === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(keyId) &&
    typeof publicKey === "string" &&
    /^[A-Za-z0-9_-]{40,256}$/u.test(publicKey) &&
    helper["peerKeyId"] === keyId &&
    helper["peerPublicKeySpkiBase64Url"] === publicKey
  );
}

function safeWindowsOwnerVault(
  configuration: PlatformServiceConfiguration,
  vaultRoot: string,
): boolean {
  if (!win32.isAbsolute(vaultRoot)) {
    return false;
  }
  return [
    configuration.paths.installRoot,
    configuration.paths.stateRoot,
    configuration.paths.authorityRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
  ].every((controlledRoot) => !windowsPathsOverlap(controlledRoot, vaultRoot));
}

function windowsPathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = win32.resolve(left).toLocaleLowerCase("en-US");
  const normalizedRight = win32.resolve(right).toLocaleLowerCase("en-US");
  const leftToRight = win32.relative(normalizedLeft, normalizedRight);
  const rightToLeft = win32.relative(normalizedRight, normalizedLeft);
  return pathRelationshipIsWithin(leftToRight) || pathRelationshipIsWithin(rightToLeft);
}

function pathRelationshipIsWithin(relationship: string): boolean {
  return (
    relationship === "" ||
    (!relationship.startsWith(`..${win32.sep}`) &&
      relationship !== ".." &&
      !win32.isAbsolute(relationship))
  );
}

function matchesLegacyWindowsRestrictedSidManifest(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  if (
    configuration.platform !== "windows" ||
    installedFile.purpose !== "core-manifest" ||
    installedFile.encoding !== "utf8"
  ) {
    return false;
  }
  const declared = '"serviceSidType": "unrestricted"';
  const legacy = '"serviceSidType": "restricted"';
  const first = installedFile.content.indexOf(declared);
  if (first < 0 || installedFile.content.indexOf(declared, first + declared.length) >= 0) {
    return false;
  }
  const legacyFile: RenderedFile = {
    ...installedFile,
    content: `${installedFile.content.slice(0, first)}${legacy}${installedFile.content.slice(first + declared.length)}`,
  };
  return existing.equals(encodeRenderedFile(legacyFile));
}

function matchesLegacyMacOsManifestWithoutServicePath(
  configuration: PlatformServiceConfiguration,
  installedFile: RenderedFile,
  existing: Buffer,
): boolean {
  if (
    configuration.platform !== "macos" ||
    installedFile.purpose !== "core-manifest" ||
    installedFile.encoding !== "utf8"
  ) {
    return false;
  }
  const declared = [
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${MACOS_SERVICE_EXECUTABLE_PATH}</string>`,
    "  </dict>",
    "",
  ].join("\n");
  const first = installedFile.content.indexOf(declared);
  if (first < 0 || installedFile.content.indexOf(declared, first + declared.length) >= 0) {
    return false;
  }
  const legacyFile: RenderedFile = {
    ...installedFile,
    content: `${installedFile.content.slice(0, first)}${installedFile.content.slice(first + declared.length)}`,
  };
  return existing.equals(encodeRenderedFile(legacyFile));
}

function assertCanonicalPlan(
  configuration: PlatformServiceConfiguration,
  actual: ServicePlan,
  previousConfiguration?: PlatformServiceConfiguration,
): void {
  const expected =
    actual.operation === "install"
      ? createServicePlan({ operation: "install", configuration })
      : actual.operation === "uninstall"
        ? createServicePlan({
            operation: "uninstall",
            configuration,
            activeVersion: requireFromVersion(actual),
            purgeState: actual.steps.some((step) => step.id === "purge-state"),
          })
        : actual.operation === "upgrade"
          ? createServicePlan({
              operation: "upgrade",
              configuration,
              activeVersion: requireFromVersion(actual),
            })
          : actual.operation === "reconfigure"
            ? createServicePlan({
                operation: "reconfigure",
                configuration,
                previousConfiguration: requirePreviousConfiguration(previousConfiguration),
                activeVersion: requireFromVersion(actual),
              })
            : createServicePlan({
                operation: actual.operation,
                configuration,
                activeVersion: requireFromVersion(actual),
              });
  if (servicePlanFingerprint(expected) !== servicePlanFingerprint(actual)) {
    failPreflight("The lifecycle plan is not the canonical plan for this configuration.");
  }
}

function requirePreviousConfiguration(
  configuration: PlatformServiceConfiguration | undefined,
): PlatformServiceConfiguration {
  if (configuration === undefined) {
    failPreflight("Service reconfiguration requires the exact previous configuration.");
  }
  return configuration;
}

function assertJournalRootDisjoint(configuration: PlatformServiceConfiguration): void {
  const journalRoot = nativeServiceJournalRoot(configuration);
  for (const path of [
    configuration.bundle.sourceDirectory,
    configuration.paths.installRoot,
    configuration.paths.stateRoot,
    configuration.paths.authorityRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
  ]) {
    if (
      equalPath(configuration.platform, journalRoot, path) ||
      isDescendant(configuration.platform, journalRoot, path) ||
      isDescendant(configuration.platform, path, journalRoot)
    ) {
      failPreflight(
        "The durable service-operation journal root must be disjoint from bundle and runtime roots.",
      );
    }
  }
}

function requireFromVersion(plan: ServicePlan): string {
  if (plan.fromVersion === undefined) {
    failPreflight("The lifecycle plan is missing its active source version.");
  }
  return plan.fromVersion;
}

function assertFilesystemActionAllowed(
  configuration: PlatformServiceConfiguration,
  action: FilesystemAction,
): void {
  const definition = createPlatformServiceDefinition(configuration);
  const allowedExact = new Set([
    configuration.paths.installRoot,
    configuration.paths.stateRoot,
    configuration.paths.authorityRoot,
    configuration.paths.runtimeRoot,
    configuration.paths.logRoot,
    pathJoin(configuration.platform, configuration.paths.installRoot, "releases"),
    pathJoin(configuration.platform, configuration.paths.installRoot, ".staging"),
    definition.activeDirectory,
    definition.releaseDirectory,
    definition.stagingDirectory,
    definition.runtimeConfigurationPath,
    definition.secretReferencesPath,
  ]);
  const artifacts = createServicePlan({
    operation: "install",
    configuration,
  }).steps;
  for (const step of artifacts) {
    if (step.action.kind === "directory.ensure" || step.action.kind === "directory.access-grant") {
      allowedExact.add(step.action.path);
    } else if (step.action.kind === "file.write") {
      allowedExact.add(step.action.file.path);
    } else if (step.action.kind === "file.symbolic-link.ensure") {
      allowedExact.add(step.action.path);
    }
  }
  const path =
    action.kind === "directory.ensure" ||
    action.kind === "directory.access-grant" ||
    action.kind === "path.remove"
      ? action.path
      : action.kind === "file.write"
        ? action.file.path
        : action.kind === "file.symbolic-link.ensure"
          ? action.path
          : action.kind === "release.remove"
            ? action.releaseDirectory
            : action.kind === "release.stage" || action.kind === "release.verify"
              ? action.stagingDirectory
              : action.kind === "release.promote"
                ? action.releaseDirectory
                : action.kind === "release.prune"
                  ? action.releasesRoot
                  : action.activeDirectory;
  if (
    !allowedExact.has(path) &&
    !isDescendant(
      configuration.platform,
      pathJoin(configuration.platform, configuration.paths.installRoot, "releases"),
      path,
    ) &&
    !isDescendant(
      configuration.platform,
      pathJoin(configuration.platform, configuration.paths.installRoot, ".staging"),
      path,
    )
  ) {
    throw uncertain("A filesystem action escaped the configured service roots.");
  }
}

function collectActionPaths(action: PlanAction, paths: Set<string>): void {
  switch (action.kind) {
    case "directory.access-grant":
    case "directory.ensure":
    case "path.remove":
      paths.add(action.path);
      return;
    case "file.write":
      paths.add(action.file.path);
      return;
    case "file.symbolic-link.ensure":
      paths.add(action.path);
      paths.add(action.target);
      return;
    case "activation.switch":
      paths.add(action.activeDirectory);
      paths.add(action.targetReleaseDirectory);
      return;
    case "release.promote":
      paths.add(action.stagingDirectory);
      paths.add(action.releaseDirectory);
      return;
    case "release.prune":
      paths.add(action.releasesRoot);
      return;
    case "release.remove":
      paths.add(action.releaseDirectory);
      return;
    case "release.stage":
      paths.add(action.sourceDirectory);
      paths.add(action.stagingDirectory);
      return;
    case "release.verify":
      paths.add(action.stagingDirectory);
      return;
    case "account.ensure":
    case "account.remove":
    case "health.check":
    case "supervisor.invoke":
      return;
  }
}

function normalizedPathKey(platform: PlatformFamily, path: string): string {
  const normalized = (platform === "windows" ? win32 : posix).normalize(path);
  return platform === "windows" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

interface NativeTools {
  readonly sc: string;
  readonly schtasks: string;
  readonly icacls: string;
  readonly takeown: string;
  readonly launchctl: string;
  readonly systemctl: string;
  readonly runuser: string;
  readonly getent: string;
  readonly groupadd: string;
  readonly useradd: string;
  readonly usermod: string;
  readonly userdel: string;
  readonly groupdel: string;
  readonly id: string;
  readonly nologin: string;
  readonly dscl: string;
  readonly dseditgroup: string;
}

function nativeTools(): NativeTools {
  const systemRoot = globalThis.process.env["SystemRoot"] ?? "C:\\Windows";
  return {
    sc: win32.join(systemRoot, "System32", "sc.exe"),
    schtasks: win32.join(systemRoot, "System32", "schtasks.exe"),
    icacls: win32.join(systemRoot, "System32", "icacls.exe"),
    takeown: win32.join(systemRoot, "System32", "takeown.exe"),
    launchctl: "/bin/launchctl",
    systemctl: "/usr/bin/systemctl",
    runuser: "/usr/sbin/runuser",
    getent: "/usr/bin/getent",
    groupadd: "/usr/sbin/groupadd",
    useradd: "/usr/sbin/useradd",
    usermod: "/usr/sbin/usermod",
    userdel: "/usr/sbin/userdel",
    groupdel: "/usr/sbin/groupdel",
    id: "/usr/bin/id",
    nologin: "/usr/sbin/nologin",
    dscl: "/usr/bin/dscl",
    dseditgroup: "/usr/sbin/dseditgroup",
  };
}

function requiredNativeTools(
  configuration: PlatformServiceConfiguration,
  plan: ServicePlan,
  tools: NativeTools,
): readonly string[] {
  const required = new Set<string>();
  for (const step of plan.steps) {
    if (step.action.kind === "supervisor.invoke") {
      for (const invocation of step.action.command.invocations) {
        required.add(resolveSupervisorExecutable(invocation.executable, tools));
        if (invocation.privilege === "owner-session" && configuration.platform === "linux") {
          required.add(tools.runuser);
        }
      }
    }
    if (step.action.kind === "directory.ensure") {
      if (configuration.platform === "windows") {
        required.add(tools.icacls);
        required.add(tools.takeown);
      } else {
        required.add(tools.id);
      }
    }
    if (step.action.kind === "directory.access-grant") {
      required.add(tools.icacls);
    }
    if (step.action.kind === "file.write" && configuration.platform !== "windows") {
      required.add(tools.id);
    }
    if (step.action.kind === "account.ensure" || step.action.kind === "account.remove") {
      if (configuration.platform === "linux") {
        for (const tool of [
          tools.getent,
          tools.groupadd,
          tools.useradd,
          tools.usermod,
          tools.userdel,
          tools.groupdel,
          tools.id,
          tools.nologin,
        ]) {
          required.add(tool);
        }
      } else if (configuration.platform === "macos") {
        required.add(tools.dscl);
        required.add(tools.dseditgroup);
        required.add(tools.id);
      }
    }
  }
  return [...required].sort(compareCodeUnits);
}

function resolveSupervisorExecutable(executable: string, tools: NativeTools): string {
  if (executable === "sc.exe") {
    return tools.sc;
  }
  if (executable === "schtasks.exe") {
    return tools.schtasks;
  }
  if (executable === "/bin/launchctl") {
    return tools.launchctl;
  }
  if (executable === "/usr/bin/systemctl") {
    return tools.systemctl;
  }
  throw uncertain("A supervisor command escaped the native executable allowlist.");
}

function ownerEnvironment(
  configuration: Exclude<PlatformServiceConfiguration, { readonly platform: "windows" }>,
): Readonly<Record<string, string>> {
  const uid = String(configuration.ownerSession.uid);
  return {
    HOME: configuration.ownerSession.homeDirectory ?? "/",
    USER: configuration.ownerSession.userName,
    LOGNAME: configuration.ownerSession.userName,
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
}

function ownerSessionProbe(configuration: PlatformServiceConfiguration): {
  readonly platform: PlatformFamily;
  readonly userName: string;
  readonly stableUserId: string;
  readonly uid?: number;
} {
  return {
    platform: configuration.platform,
    userName: configuration.ownerSession.userName,
    stableUserId: configuration.ownerSession.stableUserId,
    ...(configuration.ownerSession.uid === undefined
      ? {}
      : { uid: configuration.ownerSession.uid }),
  };
}

async function runRequired(
  process: NativeProcessBoundary,
  request: NativeProcessRequest,
): Promise<NativeProcessResult> {
  const result = await process.run(request);
  if (result.timedOut || result.exitCode !== 0) {
    throw new NativeSupervisorError("A required native service command failed.");
  }
  return result;
}

async function resolveUnixId(
  process: NativeProcessBoundary,
  idTool: string,
  flag: "-g" | "-u",
  user: string,
): Promise<number> {
  const result = await runRequired(process, {
    executable: idTool,
    arguments: [flag, user],
    timeoutMs: 10_000,
  });
  const value = Number(result.stdout.trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw uncertain("A native service account has an invalid numeric identity.");
  }
  return value;
}

async function dsclPathExists(
  process: NativeProcessBoundary,
  dscl: string,
  path: string,
): Promise<boolean> {
  const result = await process.run({
    executable: dscl,
    arguments: [".", "-read", path],
    timeoutMs: 10_000,
  });
  return result.exitCode === 0;
}

async function nextMacSystemId(
  process: NativeProcessBoundary,
  dscl: string,
  collection: "Groups" | "Users",
): Promise<number> {
  const attribute = collection === "Groups" ? "PrimaryGroupID" : "UniqueID";
  const result = await runRequired(process, {
    executable: dscl,
    arguments: [".", "-list", `/${collection}`, attribute],
    timeoutMs: 10_000,
  });
  const used = new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => Number(/\s(\d+)\s*$/u.exec(line)?.[1]))
      .filter((value) => Number.isSafeInteger(value)),
  );
  for (let candidate = 200; candidate < 500; candidate += 1) {
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  throw uncertain("No unused macOS system identity remains in the supported range.");
}

async function readMacNumericAttribute(
  process: NativeProcessBoundary,
  dscl: string,
  path: string,
  attribute: string,
): Promise<number> {
  const value = Number(await readMacAttribute(process, dscl, path, attribute));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw uncertain("A macOS service identity has an invalid numeric attribute.");
  }
  return value;
}

async function readMacAttribute(
  process: NativeProcessBoundary,
  dscl: string,
  path: string,
  attribute: string,
): Promise<string> {
  const result = await runRequired(process, {
    executable: dscl,
    arguments: [".", "-read", path, attribute],
    timeoutMs: 10_000,
  });
  const prefixes = [`${attribute}:`, `dsAttrTypeNative:${attribute}:`];
  for (const candidate of result.stdout.split(/\r?\n/u)) {
    const line = candidate.trimStart();
    const prefix = prefixes.find((value) => line.startsWith(value));
    if (prefix !== undefined) {
      return line.slice(prefix.length).trim();
    }
  }
  throw uncertain("A macOS service identity is missing a required attribute.");
}

function findDirectoryAccess(
  configuration: PlatformServiceConfiguration,
  path: string,
): Extract<PlanAction, { readonly kind: "directory.ensure" }>["access"] {
  const plan = createServicePlan({ operation: "install", configuration });
  const step = plan.steps.find(
    (candidate) =>
      candidate.action.kind === "directory.ensure" &&
      candidate.action.path.toLowerCase() === path.toLowerCase(),
  );
  if (step?.action.kind !== "directory.ensure") {
    throw uncertain("A directory access action is not part of the canonical install plan.");
  }
  return step.action.access;
}

function windowsPermission(permission: "full-control" | "read-execute" | "read-write"): string {
  return permission === "full-control"
    ? "(OI)(CI)F"
    : permission === "read-write"
      ? "(OI)(CI)M"
      : "(OI)(CI)RX";
}

function windowsPrincipal(principal: string): string {
  return /^S-\d(?:-\d+)+$/u.test(principal) ? `*${principal}` : principal;
}

function encodeRenderedFile(file: RenderedFile): Buffer {
  const bytes =
    file.encoding === "utf8"
      ? Buffer.from(file.content, "utf8")
      : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, "utf16le")]);
  if (bytes.length > MAXIMUM_RENDERED_FILE_BYTES) {
    throw uncertain("A rendered native service file exceeds the safe size limit.");
  }
  return bytes;
}

function invocationAlreadySatisfied(
  platform: PlatformFamily,
  invocation: CommandInvocation,
  exitCode: number,
): boolean {
  if (platform === "windows" && invocation.executable === "sc.exe") {
    return (
      (invocation.arguments[0] === "create" && exitCode === 1073) ||
      (invocation.arguments[0] === "start" && exitCode === 1056) ||
      (invocation.arguments[0] === "stop" && exitCode === 1062) ||
      (invocation.arguments[0] === "delete" && exitCode === 1060)
    );
  }
  const systemdVerbIndex =
    invocation.arguments[0] === "--user" && invocation.arguments[1] === "--no-reload"
      ? 2
      : invocation.arguments[0] === "--user"
        ? 1
        : 0;
  return (
    (invocation.executable === "schtasks.exe" && exitCode === 1) ||
    (invocation.executable === "/bin/launchctl" && exitCode === 5) ||
    (invocation.executable === "/usr/bin/systemctl" &&
      exitCode === 1 &&
      (invocation.arguments[systemdVerbIndex] === "disable" ||
        invocation.arguments[systemdVerbIndex] === "stop"))
  );
}

function launchdLabelFromManifest(path: string | undefined): string | undefined {
  if (path === undefined) {
    return undefined;
  }
  const name = posix.basename(path);
  return name.endsWith(".plist") ? name.slice(0, -".plist".length) : undefined;
}

function compareSemanticVersionsDescending(left: string, right: string): number {
  const leftParts = left.split(/[.-]/u);
  const rightParts = right.split(/[.-]/u);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
      return rightNumber - leftNumber;
    }
    return compareCodeUnits(rightPart, leftPart);
  }
  return 0;
}

function isDescendant(platform: PlatformFamily, parent: string, candidate: string): boolean {
  const path = platform === "windows" ? win32 : posix;
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function equalPath(platform: PlatformFamily, left: string, right: string): boolean {
  const path = platform === "windows" ? win32 : posix;
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "windows"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathJoin(platform: PlatformFamily, ...parts: string[]): string {
  return platform === "windows" ? win32.join(...parts) : posix.join(...parts);
}

function pathSeparator(platform: PlatformFamily): string {
  return platform === "windows" ? win32.sep : posix.sep;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function assertReleaseHostExecutables(
  configuration: PlatformServiceConfiguration,
  root: string,
  process: NativeProcessBoundary,
  mutationMayHaveOccurred: boolean,
): Promise<void> {
  const suffix = configuration.platform === "windows" ? ".exe" : "";
  for (const name of [
    `opendelegate-service-host${suffix}`,
    `opendelegate-session-helper${suffix}`,
  ]) {
    const path = pathJoin(configuration.platform, root, "bin", name);
    if (!(await process.isExecutable(path))) {
      if (!mutationMayHaveOccurred) {
        failPreflight(`The release service host is missing or not executable: ${path}.`);
      }
      throw uncertain(`A staged release service host is missing or not executable: ${path}.`);
    }
  }
}

function requireReleaseVerification(
  verification: NativeReleaseVerification | undefined,
): NativeReleaseVerification {
  if (verification === undefined) {
    throw uncertain(
      "A release mutation reached execution without a completed publisher-trust preflight.",
    );
  }
  return verification;
}

function failPreflight(message: string): never {
  throw new ServiceCommandExecutionError("SERVICE_COMMAND_PREFLIGHT_FAILED", message, false);
}

function uncertain(message: string): ServiceCommandExecutionError {
  return new ServiceCommandExecutionError("SERVICE_COMMAND_OUTCOME_UNCERTAIN", message, true);
}

class NativeSupervisorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NativeSupervisorError";
  }
}

class NativeHealthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NativeHealthError";
  }
}
