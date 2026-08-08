#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runComputerUseMcpStdioServer } from "@opendelegate/computer-use-mcp";
import { runKnowledgeMcpStdioServer } from "@opendelegate/knowledge-mcp";

import {
  runArtifactMcpStdioServer,
  WorkerAppError,
  consumeArtifactRunCapabilityFile,
  consumeComputerUseRunCapabilityFile,
  consumeKnowledgeRunCapabilityFile,
  consumePlatformMutationRunCapabilityFile,
  defaultSecretBackend,
  diagnoseWorker,
  joinWorker,
  listWorkerWorkspaces,
  loadWorkerConfiguration,
  loadWorkerSecretBackendConfiguration,
  prepareWindowsServiceSecretBackend,
  provisionHeadlessLinuxSecretBackend,
  restoreWindowsServiceSecretBackend,
  registerWorkerWorkspace,
  resolveWorkerPaths,
  runPlatformMutationMcpStdioServer,
  runWorkerDaemon,
  buildWorkerServiceDocument,
  WORKER_COMPUTER_USE_TOOL_NAMES,
  type WorkerAgentConfiguration,
  type WorkerCertificateRenewalOutcome,
  type WorkerConnectionDiagnostic,
  type WorkerPaths,
} from "./index.ts";

const cliPath = fileURLToPath(import.meta.url);
const cliDirectory = dirname(cliPath);
const bundledRelease = extname(cliPath) !== ".ts";
const installationRoot = bundledRelease
  ? resolve(cliDirectory, "../..")
  : resolve(cliDirectory, "../../..");

export type WorkerCliCommand =
  | "artifact-mcp-bridge"
  | "diagnose"
  | "help"
  | "join"
  | "knowledge-mcp-bridge"
  | "mcp-bridge"
  | "platform-mutation-mcp-bridge"
  | "run"
  | "secret-backend-provision"
  | "service-document"
  | "service-host"
  | "status"
  | "version"
  | "windows-service-secret-restore"
  | "windows-service-secret-stage"
  | "workspace-list"
  | "workspace-register";

export interface ParsedWorkerArguments {
  readonly command: WorkerCliCommand;
  readonly home?: string;
  readonly grantFile?: string;
  readonly capabilityFile?: string;
  readonly secretBackendConfigFile?: string;
  readonly agent?: WorkerAgentConfiguration;
  readonly provisioning?: {
    readonly configurationFile: string;
    readonly encryptedCredentialFile: string;
    readonly vaultRoot: string;
    readonly credentialName: string;
    readonly systemdCredsPath: string;
  };
  readonly windowsServiceProvisioning?: {
    readonly handoffRoot: string;
    readonly instanceId: string;
    readonly vaultRoot: string;
  };
  /** Foreground vault a staged Worker is returned to. */
  readonly windowsServiceRestoreVaultRoot?: string;
  readonly serviceDocument?: {
    readonly outputFile: string;
    readonly bundleDirectory: string;
    readonly installRoot: string;
    readonly dataRoot: string;
    readonly instanceId: string;
    readonly healthPort: number;
    readonly ownerSession?: {
      readonly userName: string;
      readonly stableUserId: string;
      readonly uid: number;
      readonly homeDirectory: string;
    };
    readonly serviceIdentity?: {
      readonly userName: string;
      readonly groupName: string;
    };
  };
  readonly workspace?: {
    readonly workspaceId: string;
    readonly alias: string;
    readonly type: "directory" | "git" | "mounted-storage";
    readonly rootPath: string;
    readonly isolation: "agent-native-worktree" | "none";
    readonly capabilities: readonly string[];
  };
}

export function parseWorkerArguments(values: readonly string[]): ParsedWorkerArguments {
  const rawCommand = values[0] ?? "help";
  const command =
    rawCommand === "--help" || rawCommand === "-h"
      ? "help"
      : rawCommand === "--version" || rawCommand === "-v"
        ? "version"
        : rawCommand;
  if (
    command !== "artifact-mcp-bridge" &&
    command !== "diagnose" &&
    command !== "help" &&
    command !== "join" &&
    command !== "knowledge-mcp-bridge" &&
    command !== "mcp-bridge" &&
    command !== "platform-mutation-mcp-bridge" &&
    command !== "run" &&
    command !== "secret-backend-provision" &&
    command !== "service-document" &&
    command !== "service-host" &&
    command !== "status" &&
    command !== "version" &&
    command !== "windows-service-secret-restore" &&
    command !== "windows-service-secret-stage" &&
    command !== "workspace-list" &&
    command !== "workspace-register"
  ) {
    throw new WorkerAppError("CONFIG_INVALID", `Unknown Worker command: ${rawCommand}.`);
  }
  let home: string | undefined;
  let grantFile: string | undefined;
  let capabilityFile: string | undefined;
  let secretBackendConfigFile: string | undefined;
  let encryptedCredentialFile: string | undefined;
  let vaultRoot: string | undefined;
  let credentialName: string | undefined;
  let systemdCredsPath: string | undefined;
  let instanceId: string | undefined;
  let handoffRoot: string | undefined;
  let outputFile: string | undefined;
  let bundleDirectory: string | undefined;
  let installRoot: string | undefined;
  let dataRoot: string | undefined;
  let healthPort: number | undefined;
  let ownerUser: string | undefined;
  let ownerUid: number | undefined;
  let ownerHome: string | undefined;
  let serviceUser: string | undefined;
  let serviceGroup: string | undefined;
  let workspaceId: string | undefined;
  let workspaceAlias: string | undefined;
  let workspaceType: "directory" | "git" | "mounted-storage" | undefined;
  let workspacePath: string | undefined;
  let workspaceIsolation: "agent-native-worktree" | "none" | undefined;
  const workspaceCapabilities: string[] = [];
  let agentProvider: WorkerAgentConfiguration["provider"] | undefined;
  let codexHome: string | undefined;
  let claudeHome: string | undefined;
  const claudeAllowedNetworkDomains: string[] = [];
  const uniqueOptions = new Set<string>();
  for (let index = 1; index < values.length; index += 1) {
    const option = values[index];
    if (
      option !== "--home" &&
      option !== "--grant-file" &&
      option !== "--capability-file" &&
      option !== "--secret-backend-config" &&
      option !== "--encrypted-credential-file" &&
      option !== "--vault-root" &&
      option !== "--credential-name" &&
      option !== "--systemd-creds" &&
      option !== "--instance-id" &&
      option !== "--handoff-root" &&
      option !== "--workspace-id" &&
      option !== "--alias" &&
      option !== "--type" &&
      option !== "--path" &&
      option !== "--isolation" &&
      option !== "--capability" &&
      option !== "--agent" &&
      option !== "--codex-home" &&
      option !== "--claude-home" &&
      option !== "--claude-network-domain" &&
      option !== "--output" &&
      option !== "--bundle" &&
      option !== "--install-root" &&
      option !== "--data-root" &&
      option !== "--health-port" &&
      option !== "--owner-user" &&
      option !== "--owner-uid" &&
      option !== "--owner-home" &&
      option !== "--service-user" &&
      option !== "--service-group"
    ) {
      throw new WorkerAppError("CONFIG_INVALID", `Unknown Worker option: ${String(option)}.`);
    }
    const target = values[index + 1];
    if (target === undefined || target.trim() === "" || target.startsWith("--")) {
      throw new WorkerAppError("CONFIG_INVALID", `${option} requires a value.`);
    }
    if (
      option !== "--capability" &&
      option !== "--claude-network-domain" &&
      uniqueOptions.has(option)
    ) {
      throw new WorkerAppError("CONFIG_INVALID", `${option} may be specified only once.`);
    }
    uniqueOptions.add(option);
    switch (option) {
      case "--home":
        home = resolve(target);
        break;
      case "--grant-file":
        grantFile = resolve(target);
        break;
      case "--capability-file":
        capabilityFile = resolve(target);
        break;
      case "--secret-backend-config":
        secretBackendConfigFile = resolve(target);
        break;
      case "--encrypted-credential-file":
        encryptedCredentialFile = resolve(target);
        break;
      case "--vault-root":
        vaultRoot = resolve(target);
        break;
      case "--credential-name":
        credentialName = target;
        break;
      case "--output":
        outputFile = resolve(target);
        break;
      case "--bundle":
        bundleDirectory = resolve(target);
        break;
      case "--install-root":
        installRoot = resolve(target);
        break;
      case "--data-root":
        dataRoot = resolve(target);
        break;
      case "--health-port":
        healthPort = Number.parseInt(target, 10);
        if (!Number.isSafeInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
          throw new WorkerAppError("CONFIG_INVALID", "--health-port must be a usable TCP port.");
        }
        break;
      case "--owner-user":
        ownerUser = target;
        break;
      case "--owner-uid":
        if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(target)) {
          throw new WorkerAppError("CONFIG_INVALID", "--owner-uid must be a numeric Unix UID.");
        }
        ownerUid = Number(target);
        if (!Number.isSafeInteger(ownerUid)) {
          throw new WorkerAppError("CONFIG_INVALID", "--owner-uid must be a numeric Unix UID.");
        }
        break;
      case "--owner-home":
        ownerHome = resolve(target);
        break;
      case "--service-user":
        serviceUser = target;
        break;
      case "--service-group":
        serviceGroup = target;
        break;
      case "--systemd-creds":
        systemdCredsPath = resolve(target);
        break;
      case "--instance-id":
        instanceId = target;
        break;
      case "--handoff-root":
        handoffRoot = resolve(target);
        break;
      case "--workspace-id":
        workspaceId = target;
        break;
      case "--alias":
        workspaceAlias = target;
        break;
      case "--type":
        if (target !== "directory" && target !== "git" && target !== "mounted-storage") {
          throw new WorkerAppError(
            "CONFIG_INVALID",
            "--type must be directory, git, or mounted-storage.",
          );
        }
        workspaceType = target;
        break;
      case "--path":
        workspacePath = resolve(target);
        break;
      case "--isolation":
        if (target !== "none" && target !== "agent-native-worktree") {
          throw new WorkerAppError(
            "CONFIG_INVALID",
            "--isolation must be none or agent-native-worktree.",
          );
        }
        workspaceIsolation = target;
        break;
      case "--capability":
        if (workspaceCapabilities.length >= 128) {
          throw new WorkerAppError(
            "CONFIG_INVALID",
            "A Workspace may declare at most 128 capabilities.",
          );
        }
        workspaceCapabilities.push(target);
        break;
      case "--agent":
        if (target !== "auto" && target !== "codex" && target !== "claude") {
          throw new WorkerAppError("CONFIG_INVALID", "--agent must be auto, codex, or claude.");
        }
        agentProvider = target;
        break;
      case "--codex-home":
        codexHome = resolve(target);
        break;
      case "--claude-home":
        claudeHome = resolve(target);
        break;
      case "--claude-network-domain":
        if (claudeAllowedNetworkDomains.length >= 128) {
          throw new WorkerAppError(
            "CONFIG_INVALID",
            "At most 128 Claude sandbox network domains may be configured.",
          );
        }
        claudeAllowedNetworkDomains.push(target);
        break;
    }
    index += 1;
  }
  if (command === "join" && grantFile === undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "worker join requires --grant-file with an absolute or resolvable file path.",
    );
  }
  if (command !== "join" && grantFile !== undefined) {
    throw new WorkerAppError("CONFIG_INVALID", "--grant-file is accepted only by worker join.");
  }
  const hasAgentOption =
    agentProvider !== undefined ||
    codexHome !== undefined ||
    claudeHome !== undefined ||
    claudeAllowedNetworkDomains.length > 0;
  if (command !== "join" && hasAgentOption) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Agent bootstrap options are accepted only by worker join.",
    );
  }
  if (
    (command === "artifact-mcp-bridge" ||
      command === "mcp-bridge" ||
      command === "knowledge-mcp-bridge" ||
      command === "platform-mutation-mcp-bridge") &&
    capabilityFile === undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The internal MCP bridge command requires --capability-file.",
    );
  }
  if (
    command !== "artifact-mcp-bridge" &&
    command !== "mcp-bridge" &&
    command !== "knowledge-mcp-bridge" &&
    command !== "platform-mutation-mcp-bridge" &&
    capabilityFile !== undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--capability-file is accepted only by an internal MCP bridge command.",
    );
  }
  if (
    command !== "join" &&
    command !== "secret-backend-provision" &&
    secretBackendConfigFile !== undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--secret-backend-config is accepted only by worker join or secret-backend-provision.",
    );
  }
  const hasHeadlessProvisioningOption =
    encryptedCredentialFile !== undefined ||
    credentialName !== undefined ||
    systemdCredsPath !== undefined;
  if (command !== "secret-backend-provision" && hasHeadlessProvisioningOption) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Headless Secret provisioning options are accepted only by secret-backend-provision.",
    );
  }
  if (command !== "windows-service-secret-stage" && handoffRoot !== undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Windows service Secret options are accepted only by windows-service-secret-stage.",
    );
  }
  if (
    command !== "windows-service-secret-stage" &&
    command !== "service-document" &&
    instanceId !== undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--instance-id is accepted only by windows-service-secret-stage and service-document.",
    );
  }
  const hasServiceDocumentOption =
    outputFile !== undefined ||
    bundleDirectory !== undefined ||
    installRoot !== undefined ||
    dataRoot !== undefined ||
    healthPort !== undefined ||
    ownerUser !== undefined ||
    ownerUid !== undefined ||
    ownerHome !== undefined ||
    serviceUser !== undefined ||
    serviceGroup !== undefined;
  if (command !== "service-document" && hasServiceDocumentOption) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Service document options are accepted only by service-document.",
    );
  }
  if (
    command === "service-document" &&
    (outputFile === undefined ||
      bundleDirectory === undefined ||
      installRoot === undefined ||
      dataRoot === undefined ||
      healthPort === undefined)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "service-document requires --output, --bundle, --install-root, --data-root, and --health-port.",
    );
  }
  if (
    command === "service-document" &&
    [ownerUser, ownerUid, ownerHome].filter((value) => value !== undefined).length !== 0 &&
    [ownerUser, ownerUid, ownerHome].some((value) => value === undefined)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Linux owner identity requires --owner-user, --owner-uid, and --owner-home together.",
    );
  }
  if (
    command === "service-document" &&
    [serviceUser, serviceGroup].filter((value) => value !== undefined).length === 1
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Linux service identity requires --service-user and --service-group together.",
    );
  }
  if (
    command !== "secret-backend-provision" &&
    command !== "windows-service-secret-restore" &&
    command !== "windows-service-secret-stage" &&
    vaultRoot !== undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--vault-root is accepted only by a Secret provisioning command.",
    );
  }
  if (
    command === "secret-backend-provision" &&
    (secretBackendConfigFile === undefined ||
      encryptedCredentialFile === undefined ||
      vaultRoot === undefined)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "secret-backend-provision requires --secret-backend-config, --encrypted-credential-file, and --vault-root.",
    );
  }
  if (command === "secret-backend-provision" && home !== undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--home is not accepted by secret-backend-provision.",
    );
  }
  if (
    command === "windows-service-secret-stage" &&
    (instanceId === undefined || handoffRoot === undefined || vaultRoot === undefined)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "windows-service-secret-stage requires --instance-id, --handoff-root, and --vault-root.",
    );
  }
  // Restoring reads the handoff location from the enrolled configuration, so it
  // needs only the foreground vault to move the Secrets back into.
  if (command === "windows-service-secret-restore" && vaultRoot === undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "windows-service-secret-restore requires --vault-root.",
    );
  }
  if (
    (command === "help" ||
      command === "version" ||
      command === "artifact-mcp-bridge" ||
      command === "mcp-bridge" ||
      command === "knowledge-mcp-bridge" ||
      command === "platform-mutation-mcp-bridge") &&
    home !== undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "--home is not accepted by Worker help, version, or the internal MCP bridge.",
    );
  }
  const hasWorkspaceOption =
    workspaceId !== undefined ||
    workspaceAlias !== undefined ||
    workspaceType !== undefined ||
    workspacePath !== undefined ||
    workspaceIsolation !== undefined ||
    workspaceCapabilities.length > 0;
  if (command !== "workspace-register" && hasWorkspaceOption) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Workspace options are accepted only by worker workspace-register.",
    );
  }
  if (
    command === "workspace-register" &&
    (workspaceId === undefined ||
      workspaceAlias === undefined ||
      workspaceType === undefined ||
      workspacePath === undefined ||
      workspaceIsolation === undefined)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "workspace-register requires --workspace-id, --alias, --type, --path, and --isolation.",
    );
  }
  return {
    command,
    ...(home === undefined ? {} : { home }),
    ...(grantFile === undefined ? {} : { grantFile }),
    ...(capabilityFile === undefined ? {} : { capabilityFile }),
    ...(command !== "join" || secretBackendConfigFile === undefined
      ? {}
      : { secretBackendConfigFile }),
    ...(command !== "join" || !hasAgentOption
      ? {}
      : {
          agent: {
            provider: agentProvider ?? "auto",
            allowUntestedVersion: false,
            ...(codexHome === undefined ? {} : { codexHome }),
            ...(claudeHome === undefined ? {} : { claudeHome }),
            ...(claudeAllowedNetworkDomains.length === 0
              ? {}
              : {
                  claudeAllowedNetworkDomains: Object.freeze([...claudeAllowedNetworkDomains]),
                }),
          },
        }),
    ...(command !== "secret-backend-provision"
      ? {}
      : {
          provisioning: {
            configurationFile: secretBackendConfigFile!,
            encryptedCredentialFile: encryptedCredentialFile!,
            vaultRoot: vaultRoot!,
            credentialName: credentialName ?? "opendelegate-vault-key",
            systemdCredsPath: systemdCredsPath ?? resolve("/usr/bin/systemd-creds"),
          },
        }),
    ...(command !== "windows-service-secret-stage"
      ? {}
      : {
          windowsServiceProvisioning: {
            handoffRoot: handoffRoot!,
            instanceId: instanceId!,
            vaultRoot: vaultRoot!,
          },
        }),
    ...(command !== "windows-service-secret-restore"
      ? {}
      : { windowsServiceRestoreVaultRoot: vaultRoot! }),
    ...(command !== "service-document"
      ? {}
      : {
          serviceDocument: {
            outputFile: outputFile!,
            bundleDirectory: bundleDirectory!,
            installRoot: installRoot!,
            dataRoot: dataRoot!,
            instanceId: instanceId ?? "personal",
            healthPort: healthPort!,
            ...(ownerUser === undefined || ownerUid === undefined || ownerHome === undefined
              ? {}
              : {
                  ownerSession: {
                    userName: ownerUser,
                    stableUserId: String(ownerUid),
                    uid: ownerUid,
                    homeDirectory: ownerHome,
                  },
                }),
            ...(serviceUser === undefined || serviceGroup === undefined
              ? {}
              : {
                  serviceIdentity: {
                    userName: serviceUser,
                    groupName: serviceGroup,
                  },
                }),
          },
        }),
    ...(command !== "workspace-register"
      ? {}
      : {
          workspace: {
            workspaceId: workspaceId!,
            alias: workspaceAlias!,
            type: workspaceType!,
            rootPath: workspacePath!,
            isolation: workspaceIsolation!,
            capabilities: workspaceCapabilities,
          },
        }),
  };
}

async function run(arguments_: readonly string[]): Promise<void> {
  const parsed = parseWorkerArguments(arguments_);
  if (parsed.command === "help") {
    printHelp();
    return;
  }
  if (parsed.command === "version") {
    process.stdout.write(`OpenDelegate Worker ${await readProductVersion()}\n`);
    return;
  }
  if (isInternalMcpBridge(parsed.command)) {
    sanitizeMcpBridgeEnvironment(process.env);
  }
  if (parsed.command === "artifact-mcp-bridge") {
    const capability = await consumeArtifactRunCapabilityFile(parsed.capabilityFile!);
    try {
      await runArtifactMcpStdioServer({
        authority: capability.authority,
        port: capability.port,
      });
    } finally {
      await capability.close();
    }
    return;
  }
  if (parsed.command === "mcp-bridge") {
    const capability = await consumeComputerUseRunCapabilityFile(parsed.capabilityFile!);
    try {
      await runComputerUseMcpStdioServer({
        authority: capability.authority,
        port: capability.port,
        enabledTools: WORKER_COMPUTER_USE_TOOL_NAMES,
      });
    } finally {
      await capability.close();
    }
    return;
  }
  if (parsed.command === "knowledge-mcp-bridge") {
    const capability = await consumeKnowledgeRunCapabilityFile(parsed.capabilityFile!);
    try {
      await runKnowledgeMcpStdioServer({
        authority: capability.authority,
        port: capability.port,
        limits: capability.limits,
      });
    } finally {
      await capability.close();
    }
    return;
  }
  if (parsed.command === "platform-mutation-mcp-bridge") {
    const capability = await consumePlatformMutationRunCapabilityFile(parsed.capabilityFile!);
    try {
      await runPlatformMutationMcpStdioServer({
        authority: capability.authority,
        platform: capability.platform,
        executableIds: capability.executableIds,
        port: capability.port,
      });
    } finally {
      await capability.close();
    }
    return;
  }
  if (parsed.command === "secret-backend-provision") {
    const backend = await provisionHeadlessLinuxSecretBackend({
      ...parsed.provisioning!,
      sourceCheckoutRoot: installationRoot,
    });
    writeJson({
      event: "worker.secret-backend.provisioned",
      backend,
      loadCredentialEncrypted: `${backend.credentialName}:${backend.encryptedCredentialFile}`,
    });
    return;
  }
  const paths = pathsFor(parsed);
  if (parsed.command === "service-document") {
    const request = parsed.serviceDocument!;
    const configuration = await buildWorkerServiceDocument({
      paths,
      bundleDirectory: request.bundleDirectory,
      installRoot: request.installRoot,
      dataRoot: request.dataRoot,
      instanceId: request.instanceId,
      healthPort: request.healthPort,
      sourceCheckoutRoot: installationRoot,
      ...(request.ownerSession === undefined ? {} : { ownerSession: request.ownerSession }),
      ...(request.serviceIdentity === undefined
        ? {}
        : { serviceIdentity: request.serviceIdentity }),
    });
    // The document carries no Secret values. Create-new prevents a repeated CLI
    // invocation from silently replacing input the owner already reviewed; the
    // elevated installer still revalidates the bundle and service SID.
    try {
      await writeFile(request.outputFile, `${JSON.stringify(configuration, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      throw new WorkerAppError(
        "CONFIG_PATH_UNSAFE",
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "The service document output already exists; OpenDelegate will not overwrite privileged install input."
          : "The service document could not be created safely.",
      );
    }
    writeJson({
      event: "worker.service-document.written",
      path: request.outputFile,
      deviceId: configuration.deviceId,
      instanceId: configuration.instanceId,
      role: configuration.role,
      bundleVersion: configuration.bundle.version,
      bundleChecksum: configuration.bundle.checksum,
      nextStep:
        "Run 'opendelegate service install --config <path> --command-id <id>' from an elevated shell on this Device.",
    });
    return;
  }
  if (parsed.command === "windows-service-secret-restore") {
    const restored = await restoreWindowsServiceSecretBackend({
      paths,
      vaultRoot: parsed.windowsServiceRestoreVaultRoot!,
    });
    writeJson({
      event: "worker.windows-service-secret.restored",
      backend: restored.backend.backend,
      vaultRoot: restored.backend.vaultRoot,
      restoredAliases: restored.restoredAliases,
    });
    return;
  }
  if (parsed.command === "windows-service-secret-stage") {
    const backend = await prepareWindowsServiceSecretBackend({
      ...parsed.windowsServiceProvisioning!,
      paths,
    });
    writeJson({
      event: "worker.windows-service-secret.staged",
      backend: backend.backend.backend,
      handoffRoot: backend.backend.handoffRoot,
      serviceName: backend.backend.serviceName,
      serviceSid: backend.backend.serviceSid,
      vaultRoot: backend.backend.vaultRoot,
      servicePreparation: backend.backend.servicePreparation,
      sealing: backend.sealing,
      ...(backend.sealing === "machine"
        ? {
            sealingNotice:
              "This computer has no domain key service, so staged Secrets are sealed to the machine instead of the service account. Any process able to read the handoff directory could decrypt them; the directory ACL admits only this account and the service account. Join a domain to restore service-account sealing.",
          }
        : {}),
      nextStep:
        "Run 'opendelegate worker service-document ...' from the same packaged build, then review 'opendelegate service plan install --config <path>' before elevated installation.",
    });
    return;
  }
  if (parsed.command === "join") {
    const secretBackend =
      parsed.secretBackendConfigFile === undefined
        ? await defaultSecretBackend({
            paths,
            installationRoot,
          })
        : await loadWorkerSecretBackendConfiguration(
            parsed.secretBackendConfigFile,
            installationRoot,
          );
    const configuration = await joinWorker({
      grantFile: parsed.grantFile!,
      paths,
      secretBackend,
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
    });
    writeJson({
      event: "worker.joined",
      deviceId: configuration.deviceId,
      workerId: configuration.workerId,
      mainDeviceId: configuration.mainDeviceId,
      home: paths.home,
    });
    return;
  }
  if (parsed.command === "status") {
    await printStatus(paths);
    return;
  }
  if (parsed.command === "diagnose") {
    writeJson(await diagnoseWorker({ paths }));
    return;
  }
  if (parsed.command === "workspace-register") {
    const workspace = await registerWorkerWorkspace({
      paths,
      workspace: parsed.workspace!,
    });
    writeJson({
      event: "worker.workspace.registered",
      workspace: {
        workspaceId: workspace.workspaceId,
        alias: workspace.alias,
        type: workspace.type,
        rootPath: workspace.rootPath,
        isolation: workspace.isolation,
        capabilities: workspace.capabilities,
        revision: workspace.revision,
      },
    });
    return;
  }
  if (parsed.command === "workspace-list") {
    writeJson({
      workspaces: await listWorkerWorkspaces(paths),
    });
    return;
  }
  await runForeground(paths);
}

function pathsFor(parsed: ParsedWorkerArguments): WorkerPaths {
  const configuredHome = process.env["OPENDELEGATE_WORKER_HOME"]?.trim();
  if (
    parsed.home === undefined &&
    configuredHome !== undefined &&
    configuredHome.length > 0 &&
    !isAbsolute(configuredHome)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "OPENDELEGATE_WORKER_HOME must be an absolute path.",
    );
  }
  return resolveWorkerPaths({
    sourceCheckoutRoot: installationRoot,
    ...(parsed.home !== undefined
      ? { home: parsed.home }
      : configuredHome === undefined || configuredHome.length === 0
        ? {}
        : { home: configuredHome }),
  });
}

async function printStatus(paths: WorkerPaths): Promise<void> {
  try {
    const configuration = await loadWorkerConfiguration(paths);
    writeJson({
      enrolled: true,
      deviceId: configuration.deviceId,
      workerId: configuration.workerId,
      mainDeviceId: configuration.mainDeviceId,
      certificateGeneration: configuration.certificateGeneration,
      channelEndpointCount: configuration.transportProfile.endpoints.length,
      home: paths.home,
    });
  } catch (error) {
    if (error instanceof WorkerAppError && error.code === "CONFIG_MISSING") {
      writeJson({ enrolled: false, home: paths.home });
      return;
    }
    throw error;
  }
}

export function sanitizeMcpBridgeEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    delete environment[key];
  }
}

function isInternalMcpBridge(command: WorkerCliCommand): boolean {
  return (
    command === "artifact-mcp-bridge" ||
    command === "knowledge-mcp-bridge" ||
    command === "mcp-bridge" ||
    command === "platform-mutation-mcp-bridge"
  );
}

async function runForeground(paths: WorkerPaths): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    writeJson({ event: "worker.starting", home: paths.home });
    await runWorkerDaemon({
      paths,
      signal: controller.signal,
      onCertificateRenewal: (outcome: WorkerCertificateRenewalOutcome) => {
        if (outcome.status === "renewed") {
          writeJson({
            event: "worker.certificate-renewed",
            certificateGeneration: outcome.generation,
            expiresAt: new Date(outcome.notAfter).toISOString(),
          });
          return;
        }
        if (outcome.status === "unavailable") {
          writeJson({
            event: "worker.certificate-renewal-deferred",
            reason: outcome.reason,
          });
        }
      },
      onConnectionDiagnostic: (diagnostic) => {
        writeJson({
          event: "worker.connection-blocked",
          code: diagnostic.code,
          retryable: diagnostic.retryable,
          remedy: connectionRemedy(diagnostic.code),
        });
      },
    });
    writeJson({ event: "worker.stopped" });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function connectionRemedy(code: WorkerConnectionDiagnostic["code"]): string {
  return code === "CERTIFICATE_EXPIRED"
    ? "This Device certificate has expired. Issue a new enrollment grant from Admin Web and run 'opendelegate worker join --grant-file <path>' on this Device."
    : "Main rejected this Device's credential. Inspect the Device in Admin Web before reconnecting.";
}

async function readProductVersion(): Promise<string> {
  if (!bundledRelease) {
    const manifest = JSON.parse(
      await readFile(resolve(installationRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "development";
  }
  const metadata = JSON.parse(
    await readFile(resolve(installationRoot, "release-metadata.json"), "utf8"),
  ) as { productVersion?: unknown };
  if (typeof metadata.productVersion !== "string") {
    throw new WorkerAppError("CONFIG_INVALID", "Bundled release metadata is invalid.");
  }
  return metadata.productVersion;
}

function printHelp(): void {
  process.stdout.write(`OpenDelegate Worker

Usage:
  opendelegate worker join --grant-file <absolute-path> [--home <path>]
    [--secret-backend-config <absolute-path>]
    [--agent auto|codex|claude] [--codex-home <absolute-path>]
    [--claude-home <absolute-path>]
    [--claude-network-domain <dns-name> ...]
  opendelegate worker secret-backend-provision
    --secret-backend-config ABSOLUTE_PATH
    --encrypted-credential-file ABSOLUTE_PATH --vault-root ABSOLUTE_PATH
    [--credential-name NAME] [--systemd-creds ABSOLUTE_PATH]
  opendelegate worker windows-service-secret-stage
    --instance-id INSTANCE_ID --handoff-root ABSOLUTE_PATH
    --vault-root ABSOLUTE_PATH [--home <path>]
  opendelegate worker windows-service-secret-restore
    --vault-root ABSOLUTE_PATH [--home <path>]
  opendelegate worker service-document --output ABSOLUTE_PATH
    --bundle ABSOLUTE_PATH --install-root ABSOLUTE_PATH --data-root ABSOLUTE_PATH
    --health-port PORT [--instance-id INSTANCE_ID] [--home <path>]
    [--owner-user USER --owner-uid UID --owner-home ABSOLUTE_PATH]
    [--service-user USER --service-group GROUP]
  opendelegate worker run [--home <path>]
  opendelegate worker service-host [--home <path>]
  opendelegate worker status [--home <path>]
  opendelegate worker diagnose [--home <path>]
  opendelegate worker workspace-register --workspace-id ID --alias NAME
    --type directory|git|mounted-storage --path ABSOLUTE_PATH
    --isolation none|agent-native-worktree [--capability NAME ...] [--home <path>]
  opendelegate worker workspace-list [--home <path>]
  opendelegate worker version

The one-use Enrollment Grant token is accepted only inside the protected grant
file. It is never accepted in argv or environment variables. Worker state,
Device-local Knowledge, and managed credentials remain outside the installation.

service-document composes a staged Windows Worker or an explicitly headless Linux
Worker from durable public IPC bindings and the bundle checksum manifest. Linux
requires the owner arguments shown above and deliberately emits no graphical helper.
The optional service-account arguments only verify the identity captured at join.
It writes only a create-new document and never elevates or
registers a service. Graphical Linux and macOS remain fail-closed until their
separate owner-session Secret migration is implemented. Installing the reviewed
document is a separate, elevated step:
'opendelegate service install --config <path> --command-id <id>'.
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reportFailure(error: unknown): void {
  const publicError =
    error instanceof WorkerAppError
      ? { level: "error", code: error.code, message: error.message }
      : {
          level: "error",
          code: "INTERNAL_ERROR",
          message: "OpenDelegate Worker could not complete the command.",
        };
  process.stderr.write(`${JSON.stringify(publicError)}\n`);
  process.exitCode = 1;
}

const invokedFile = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedFile === resolve(cliPath)) {
  void run(process.argv.slice(2)).catch(reportFailure);
}
