import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import test from "node:test";

import {
  NativeBoundaryError,
  ServiceCommandExecutionError,
  createNativeReleaseVerifier,
  createNativeServiceExecutor,
  createNativeServiceInspector,
  createServicePlan,
  preflightNativeServiceOperation,
  renderPlatformServiceArtifacts,
  type NativeDirectoryEntry,
  type NativeFileSystemBoundary,
  type NativePathKind,
  type NativeProcessRequest,
  type NativeProcessResult,
  type NativeReleaseVerifier,
  type NativeServiceBoundaries,
  type PlatformFamily,
  type PlatformServiceConfiguration,
  type ServiceCommandClaim,
  type ServiceCommandJournal,
  type ServiceCommandJournalEntry,
  type ServicePlanExecutionReport,
} from "../src/index.ts";
import { waitForWindowsScheduledTaskStopped } from "../src/native-service-runtime.ts";
import { linuxConfiguration, macOsConfiguration, windowsConfiguration } from "./fixtures.ts";

class MemoryJournal implements ServiceCommandJournal {
  public readonly entries = new Map<string, ServiceCommandJournalEntry>();
  public claims = 0;

  public async claim(entry: ServiceCommandJournalEntry): Promise<ServiceCommandClaim> {
    this.claims += 1;
    const existing = this.entries.get(entry.commandId);
    if (existing?.report !== undefined) {
      return {
        disposition: "completed",
        planFingerprint: existing.planFingerprint,
        report: existing.report,
      };
    }
    if (existing !== undefined) {
      return {
        disposition: "in-progress",
        planFingerprint: existing.planFingerprint,
      };
    }
    this.entries.set(entry.commandId, entry);
    return { disposition: "claimed" };
  }

  public async complete(
    entry: ServiceCommandJournalEntry & {
      readonly report: ServicePlanExecutionReport;
    },
  ): Promise<void> {
    this.entries.set(entry.commandId, entry);
  }
}

class FakeFileSystem implements NativeFileSystemBoundary {
  public readonly kinds = new Map<string, NativePathKind>();
  public readonly files = new Map<string, Buffer>();
  public readonly modes = new Map<string, number>();
  public readonly links = new Map<string, string>();
  public readonly removed: string[] = [];
  public readonly directories = new Map<string, NativeDirectoryEntry[]>();
  public readonly reads: string[] = [];
  public readonly posixAccessChanges: {
    readonly path: string;
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
  }[] = [];

  public async inspect(path: string) {
    const kind =
      this.kinds.get(path) ??
      (this.files.has(path)
        ? "regular-file"
        : this.links.has(path)
          ? "symbolic-link"
          : looksLikeRenderedFile(path)
            ? "missing"
            : "directory");
    return {
      kind,
      ...(kind === "regular-file"
        ? {
            size: this.files.get(path)?.length ?? 0,
            modifiedAtMs: 1,
            mode: this.modes.get(path) ?? 0o640,
          }
        : {}),
    };
  }

  public async realPath(path: string): Promise<string> {
    return path;
  }

  public async list(path: string): Promise<readonly NativeDirectoryEntry[]> {
    return this.directories.get(path) ?? [];
  }

  public async read(path: string, maximumBytes: number): Promise<Buffer> {
    this.reads.push(path);
    const bytes = this.files.get(path);
    if (bytes === undefined || bytes.length > maximumBytes) {
      throw new Error("unsafe read");
    }
    return bytes;
  }

  public async ensureDirectory(path: string, _mode: number): Promise<"changed" | "unchanged"> {
    const before = await this.inspect(path);
    this.kinds.set(path, "directory");
    return before.kind === "directory" ? "unchanged" : "changed";
  }

  public async writeAtomic(
    path: string,
    bytes: Buffer,
    _mode: number,
  ): Promise<"changed" | "unchanged"> {
    const existing = this.files.get(path);
    this.files.set(path, bytes);
    this.kinds.set(path, "regular-file");
    return existing?.equals(bytes) ? "unchanged" : "changed";
  }

  public async copyRegularFile(source: string, destination: string): Promise<void> {
    const sourceBytes = this.files.get(source);
    if (sourceBytes === undefined) {
      throw new Error("missing source");
    }
    this.files.set(destination, Buffer.from(sourceBytes));
    this.kinds.set(destination, "regular-file");
    this.modes.set(destination, this.modes.get(source) ?? 0o640);
  }

  public async renameAtomic(source: string, destination: string, _replace: boolean): Promise<void> {
    const kind = (await this.inspect(source)).kind;
    this.kinds.delete(source);
    this.kinds.set(destination, kind);
  }

  public async createDirectoryLinkAtomic(
    target: string,
    linkPath: string,
    _platform: PlatformFamily,
  ): Promise<"changed" | "unchanged"> {
    if (this.links.get(linkPath) === target) {
      return "unchanged";
    }
    this.links.set(linkPath, target);
    this.kinds.set(linkPath, "symbolic-link");
    return "changed";
  }

  public async readDirectoryLink(path: string): Promise<string | undefined> {
    return this.links.get(path);
  }

  public async remove(path: string, _recursive: boolean): Promise<"changed" | "unchanged"> {
    const before = await this.inspect(path);
    this.kinds.set(path, "missing");
    this.files.delete(path);
    this.modes.delete(path);
    this.links.delete(path);
    this.removed.push(path);
    return before.kind === "missing" ? "unchanged" : "changed";
  }

  public async setPosixOwnershipAndMode(
    path: string,
    uid: number,
    gid: number,
    mode: number,
  ): Promise<void> {
    this.posixAccessChanges.push({ path, uid, gid, mode });
    this.modes.set(path, mode);
  }

  public async sameVolume(_left: string, _right: string): Promise<boolean> {
    return true;
  }
}

class FakeProcess {
  public readonly requests: NativeProcessRequest[] = [];
  public unavailable = new Set<string>();
  public handler: (request: NativeProcessRequest) => NativeProcessResult = () => processResult(0);
  public processAliveHandler: (processId: number) => boolean = () => false;

  public async isExecutable(path: string): Promise<boolean> {
    return !this.unavailable.has(path);
  }

  public async isProcessAlive(processId: number): Promise<boolean> {
    return this.processAliveHandler(processId);
  }

  public async run(request: NativeProcessRequest): Promise<NativeProcessResult> {
    this.requests.push(request);
    const result = this.handler(request);
    return request.executable.toLowerCase().endsWith("sc.exe") &&
      request.arguments[0]?.toLowerCase() === "query" &&
      result.exitCode === 0 &&
      result.stdout.length === 0 &&
      result.stderr.length === 0
      ? processResult(0, "STATE              : 1  STOPPED\r\n")
      : result;
  }
}

const WINDOWS_SERVICE_SID = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";

function windowsConfigurationWithServiceBinding(role: "main" | "worker") {
  return windowsConfiguration({
    role,
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid: WINDOWS_SERVICE_SID,
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
}

test("preflight rejects missing elevation before journal claim or host mutation", async () => {
  const configuration = windowsConfiguration();
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: false,
    loggedIn: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-start-privilege",
      configuration,
      plan: createServicePlan({
        operation: "start",
        configuration,
        activeVersion: "1.2.3",
      }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("Windows Worker service install refuses a missing service-identity Secret binding", async () => {
  const configuration = windowsConfiguration({ role: "worker" });
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-install-worker-dpapi-current-user",
      configuration,
      plan: createServicePlan({ operation: "install", configuration }),
    }),
    (error: unknown) =>
      isPreflightFailure(error) &&
      error.message.includes("service-identity") &&
      error.message.includes("Secret binding"),
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("Windows Main service install also refuses a missing co-located Worker Secret binding", async () => {
  const configuration = windowsConfiguration({ role: "main" });
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-install-main-dpapi-local-worker",
      configuration,
      plan: createServicePlan({ operation: "install", configuration }),
    }),
    (error: unknown) =>
      isPreflightFailure(error) &&
      error.message.includes("service-identity") &&
      error.message.includes("Secret binding"),
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("Windows Worker service install verifies the configured virtual-service SID before mutation", async () => {
  const configuredSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const configuration = windowsConfiguration({
    role: "worker",
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid: configuredSid,
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = (request) =>
    request.arguments[0] === "showsid"
      ? processResult(0, "SERVICE SID: S-1-5-80-1-2-3-4-5")
      : processResult(0);
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-install-worker-service-sid-mismatch",
      configuration,
      plan: createServicePlan({ operation: "install", configuration }),
    }),
    (error: unknown) =>
      isPreflightFailure(error) &&
      error.message.includes("service SID") &&
      !error.message.includes(configuredSid),
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("Windows Worker service preflight accepts a staged binding that matches SCM", async () => {
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const configuration = windowsConfiguration({
    role: "worker",
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid,
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
  const process = new FakeProcess();
  process.handler = (request) =>
    request.arguments[0] === "showsid"
      ? processResult(0, `SERVICE SID: ${serviceSid}`)
      : processResult(0);
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    process,
  });
  const verification = await preflightNativeServiceOperation({
    platform: "windows",
    boundaries,
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
    releaseVerifier: trustedRelease(),
  });

  assert.equal(verification?.productVersion, "1.2.3");
  assert.equal(mutations(), 0);
  assert.equal(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("sc.exe") &&
        request.arguments[0] === "showsid" &&
        request.arguments[1] === "OpenDelegate-personal",
    ),
    true,
  );
});

test("Windows Main service preflight accepts the staged binding for its co-located Worker", async () => {
  const configuration = windowsConfigurationWithServiceBinding("main");
  const process = new FakeProcess();
  process.handler = (request) =>
    request.arguments[0] === "showsid"
      ? processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`)
      : processResult(0);
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    process,
  });
  const verification = await preflightNativeServiceOperation({
    platform: "windows",
    boundaries,
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
    releaseVerifier: trustedRelease(),
  });

  assert.equal(verification?.productVersion, "1.2.3");
  assert.equal(mutations(), 0);
  assert.equal(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("sc.exe") &&
        request.arguments[0] === "showsid" &&
        request.arguments[1] === "OpenDelegate-personal",
    ),
    true,
  );
});

test("Windows Worker install accepts the release and staging root actions after SID preflight", async () => {
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const configuration = windowsConfiguration({
    role: "worker",
    ownerSession: {
      ...windowsConfiguration().ownerSession,
      homeDirectory: "C:\\Users\\owner",
    },
    agentSandbox: {
      codexSandboxBinDirectory: "C:\\Users\\owner\\.codex\\.sandbox-bin",
    },
    agentProviderAccess: {
      codexHomeDirectory: "C:\\Users\\owner\\.codex",
      claudeHomeDirectory: "C:\\Users\\owner\\.claude",
    },
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid,
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  let protectedVaultOwnerAttempts = 0;
  process.handler = (request) => {
    if (request.arguments[0] === "showsid") {
      return processResult(0, `SERVICE SID: ${serviceSid}`);
    }
    if (request.arguments[0] === "query") {
      return processResult(0, "STATE : 4 RUNNING");
    }
    if (request.arguments[0]?.toLowerCase() === "/query") {
      return processResult(0, '"OpenDelegate","Ready","Running"');
    }
    if (
      request.executable.toLowerCase().endsWith("icacls.exe") &&
      request.arguments[0] === "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service" &&
      request.arguments.includes("/setowner")
    ) {
      protectedVaultOwnerAttempts += 1;
      return processResult(protectedVaultOwnerAttempts === 1 ? 5 : 0);
    }
    return processResult(0);
  };
  const fileSystem = new FakeFileSystem();
  const releasesRoot = "C:\\Program Files\\OpenDelegate\\releases";
  const stagingRoot = "C:\\Program Files\\OpenDelegate\\.staging";
  const protectedServiceVault = "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service";
  let protectedVaultEnsureAttempts = 0;
  const ensureDirectory = fileSystem.ensureDirectory.bind(fileSystem);
  fileSystem.ensureDirectory = async (path, mode) => {
    if (path === protectedServiceVault) {
      protectedVaultEnsureAttempts += 1;
      throw new Error("service-only DACL blocks Node directory open");
    }
    return await ensureDirectory(path, mode);
  };
  fileSystem.kinds.set(releasesRoot, "missing");
  fileSystem.kinds.set(stagingRoot, "missing");
  fileSystem.directories.set(releasesRoot, [{ name: "1.2.3", kind: "directory" }]);
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
    healthRole: "worker",
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-install-worker-matching-secret-binding",
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
  });

  assert.equal(
    result.report.outcome,
    "succeeded",
    JSON.stringify({ report: result.report, requests: process.requests }),
  );
  assert.equal(fileSystem.kinds.get(releasesRoot), "directory");
  assert.equal(fileSystem.kinds.get(stagingRoot), "directory");
  assert.equal(protectedVaultEnsureAttempts, 0);
  assert.equal(protectedVaultOwnerAttempts, 2);
  const protectedVaultRepair = process.requests
    .filter(
      (request) =>
        request.arguments.includes(protectedServiceVault) &&
        (request.executable.toLowerCase().endsWith("icacls.exe") ||
          request.executable.toLowerCase().endsWith("takeown.exe")),
    )
    .map((request) => [request.executable.split("\\").at(-1), request.arguments[1]]);
  assert.deepEqual(protectedVaultRepair, [
    ["icacls.exe", "/setowner"],
    ["takeown.exe", protectedServiceVault],
    ["icacls.exe", "/inheritance:r"],
    ["icacls.exe", "/setowner"],
  ]);
  const icaclsRequests = process.requests.filter((request) =>
    request.executable.toLowerCase().endsWith("icacls.exe"),
  );
  assert.ok(icaclsRequests.some((request) => request.arguments.includes("/setowner")));
  assert.ok(icaclsRequests.some((request) => request.arguments.includes("/grant:r")));
  assert.ok(
    icaclsRequests.some(
      (request) =>
        request.arguments[0] === "C:\\Users\\owner\\.codex\\.sandbox-bin" &&
        request.arguments.includes("NT SERVICE\\OpenDelegate-personal:(OI)(CI)F"),
    ),
  );
  assert.ok(
    icaclsRequests.findIndex(
      (request) => request.arguments[0] === "C:\\Users\\owner\\.codex",
    ) <
      icaclsRequests.findIndex(
        (request) => request.arguments[0] === "C:\\Users\\owner\\.codex\\.sandbox-bin",
      ),
  );
  for (const [path, permission] of [
    ["C:\\Users\\owner\\.codex", "(OI)(CI)M"],
    ["C:\\Users\\owner\\.claude", "(OI)(CI)M"],
    ["C:\\Users\\owner\\.local\\bin", "(OI)(CI)RX"],
    ["C:\\Users\\owner\\AppData\\Roaming\\npm", "(OI)(CI)RX"],
  ] as const) {
    const grant = icaclsRequests.find((request) => request.arguments[0] === path);
    assert.ok(grant, path);
    assert.deepEqual(grant.arguments, [
      path,
      "/grant:r",
      `NT SERVICE\\OpenDelegate-personal:${permission}`,
      "/T",
      "/L",
      "/Q",
    ]);
    assert.equal(grant.arguments.includes("/inheritance:r"), false);
    assert.equal(grant.arguments.includes("/reset"), false);
    assert.equal(grant.arguments.includes("/setowner"), false);
  }
  assert.equal(
    icaclsRequests.some(
      (request) =>
        request.arguments.includes("/setowner") && request.arguments.includes("/grant:r"),
    ),
    false,
  );
  assert.ok(
    icaclsRequests.some(
      (request) =>
        request.arguments[0] === "C:\\Program Files\\OpenDelegate\\releases\\1.2.3" &&
        request.arguments.includes("/reset") &&
        request.arguments.includes("/T") &&
        request.arguments.includes("/C") &&
        request.arguments.includes("/Q"),
    ),
  );
  assert.equal(
    icaclsRequests.some(
      (request) =>
        request.arguments[0] === "C:\\Users\\owner\\.codex\\.sandbox-bin" &&
        request.arguments.includes("/grant:r") &&
        request.arguments.includes("/T"),
    ),
    false,
  );
});

test("Windows provider access skips missing paths and rejects linked roots before ACL mutation", async () => {
  const configuration = windowsConfiguration({
    ownerSession: {
      ...windowsConfiguration().ownerSession,
      homeDirectory: "C:\\Users\\owner",
    },
    agentProviderAccess: {
      codexHomeDirectory: "C:\\Users\\owner\\.codex",
      claudeHomeDirectory: "C:\\Users\\owner\\.claude",
    },
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid: WINDOWS_SERVICE_SID,
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });
  const plan = createServicePlan({
    operation: "start",
    configuration,
    activeVersion: "1.2.3",
  });
  const fileSystem = new FakeFileSystem();
  fileSystem.kinds.set("C:\\Users\\owner\\.codex", "missing");
  const process = new FakeProcess();
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => new MemoryJournal() },
    releaseVerifier: trustedRelease(),
  });

  const skipped = await executor.execute({
    commandId: "service-start-provider-access-missing",
    configuration,
    plan,
  });
  assert.equal(skipped.report.outcome, "succeeded");
  assert.equal(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("icacls.exe") &&
        request.arguments[0] === "C:\\Users\\owner\\.codex",
    ),
    false,
  );
  assert.equal(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("icacls.exe") &&
        request.arguments[0] === "C:\\Users\\owner\\.claude",
    ),
    true,
  );

  fileSystem.kinds.set("C:\\Users\\owner\\.claude", "symbolic-link");
  process.requests.length = 0;
  const linkedExecutor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => new MemoryJournal() },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    linkedExecutor.execute({
      commandId: "service-start-provider-access-link",
      configuration,
      plan,
    }),
    (error: unknown) => error instanceof ServiceCommandExecutionError,
  );
  assert.equal(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("icacls.exe") &&
        ["C:\\Users\\owner\\.codex", "C:\\Users\\owner\\.claude"].includes(
          request.arguments[0] ?? "",
        ),
    ),
    false,
  );
});

test("preflight checks every native tool and publisher trust before mutation", async () => {
  const configuration = linuxConfiguration();
  const journal = new MemoryJournal();
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  process.unavailable.add("/usr/sbin/runuser");
  const { boundaries } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
  });
  let trustChecks = 0;
  const verifier = trustedRelease(() => {
    trustChecks += 1;
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: verifier,
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-start-missing-tool",
      configuration,
      plan: createServicePlan({
        operation: "start",
        configuration,
        activeVersion: "1.2.3",
      }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(trustChecks, 0);

  process.unavailable.clear();
  const rejectingTrust: NativeReleaseVerifier = {
    async preflight() {
      throw new ServiceCommandExecutionError(
        "SERVICE_COMMAND_PREFLIGHT_FAILED",
        "publisher signature absent",
        false,
      );
    },
    async verifyBeforeActivation() {},
    async verifyInstalled() {
      throw new ServiceCommandExecutionError(
        "SERVICE_COMMAND_PREFLIGHT_FAILED",
        "publisher signature absent",
        false,
      );
    },
    async verifyStaged() {},
  };
  const trustExecutor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: rejectingTrust,
  });
  await assert.rejects(
    trustExecutor.execute({
      commandId: "service-install-signature",
      configuration,
      plan: createServicePlan({ operation: "install", configuration }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
});

test("preflight rejects a non-executable release host before journal claim or mutation", async () => {
  const configuration = linuxConfiguration();
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.unavailable.add(
    `${configuration.bundle.sourceDirectory}/bin/opendelegate-session-helper`,
  );
  const { boundaries, mutations } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-install-host-mode",
      configuration,
      plan: createServicePlan({ operation: "install", configuration }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("preflight rejects a link in a mutation path before a command claim", async () => {
  const configuration = linuxConfiguration();
  const journal = new MemoryJournal();
  const fileSystem = new FakeFileSystem();
  fileSystem.kinds.set("/opt/opendelegate", "symbolic-link");
  const { boundaries } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-start-link-path",
      configuration,
      plan: createServicePlan({
        operation: "start",
        configuration,
        activeVersion: "1.2.3",
      }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
});

test("fresh install refuses to adopt an existing native service definition", async () => {
  const configuration = linuxConfiguration();
  const plan = createServicePlan({ operation: "install", configuration });
  const rendered = plan.steps.find((step) => step.action.kind === "file.write");
  assert.equal(rendered?.action.kind, "file.write");
  if (rendered?.action.kind !== "file.write") {
    throw new Error("expected a rendered service file");
  }
  const fileSystem = new FakeFileSystem();
  fileSystem.files.set(rendered.action.file.path, Buffer.from(rendered.action.file.content));
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-install-existing-definition",
      configuration,
      plan,
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("upgrade refuses a configuration that does not match installed service definitions", async () => {
  const configuration = linuxConfiguration();
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-upgrade-definition-mismatch",
      configuration,
      plan: createServicePlan({
        operation: "upgrade",
        configuration,
        activeVersion: "1.2.2",
      }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("upgrade accepts an exact installed topology rendered for the active version", async () => {
  const configuration = linuxConfiguration();
  const installedConfiguration = linuxConfiguration({
    bundle: {
      ...configuration.bundle,
      version: "1.2.2",
    },
  });
  const fileSystem = new FakeFileSystem();
  for (const file of renderPlatformServiceArtifacts(installedConfiguration).files) {
    fileSystem.files.set(file.path, Buffer.from(file.content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  fileSystem.directories.set("/opt/opendelegate/releases", [
    { name: "1.2.2", kind: "directory" },
    { name: "1.2.3", kind: "directory" },
  ]);
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.executable === "/usr/bin/id") {
      return processResult(0, "400\n");
    }
    if (request.arguments.includes("is-active")) {
      return processResult(0, "active\n");
    }
    return processResult(0);
  };
  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-upgrade-exact-active-version",
    configuration,
    plan: createServicePlan({
      operation: "upgrade",
      configuration,
      activeVersion: "1.2.2",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  const runtimeConfiguration = renderPlatformServiceArtifacts(configuration).files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(runtimeConfiguration);
  assert.deepEqual(
    fileSystem.files.get(runtimeConfiguration.path),
    Buffer.from(runtimeConfiguration.content),
  );
});

test("Windows upgrade accepts and repairs only the exact legacy restricted SID manifest", async () => {
  const configuration = windowsConfigurationWithServiceBinding("worker");
  const installedConfiguration = windowsConfiguration({
    ...configuration,
    bundle: {
      ...configuration.bundle,
      version: "1.2.2",
    },
  });
  const fileSystem = new FakeFileSystem();
  const installedArtifacts = renderPlatformServiceArtifacts(installedConfiguration);
  for (const file of installedArtifacts.files) {
    const content =
      file.purpose === "core-manifest"
        ? file.content.replace('"serviceSidType": "unrestricted"', '"serviceSidType": "restricted"')
        : file.content;
    fileSystem.files.set(file.path, renderedFileBytes(file.encoding, content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  fileSystem.directories.set("C:\\Program Files\\OpenDelegate\\releases", [
    { name: "1.2.2", kind: "directory" },
    { name: "1.2.3", kind: "directory" },
  ]);
  const process = new FakeProcess();
  process.handler = (request) =>
    request.executable.toLowerCase().endsWith("sc.exe") && request.arguments[0] === "showsid"
      ? processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`)
      : processResult(0);
  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
    healthy: true,
    healthRole: "worker",
  });
  const legacyCoreManifest = installedArtifacts.files.find(
    (file) => file.purpose === "core-manifest",
  );
  assert.ok(legacyCoreManifest);
  const exactLegacyCoreBytes = fileSystem.files.get(legacyCoreManifest.path);
  assert.ok(exactLegacyCoreBytes);
  fileSystem.files.set(
    legacyCoreManifest.path,
    Buffer.concat([exactLegacyCoreBytes, Buffer.from(" ", "utf8")]),
  );
  await assert.rejects(
    preflightNativeServiceOperation({
      platform: "windows",
      boundaries,
      configuration,
      plan: createServicePlan({
        operation: "upgrade",
        configuration,
        activeVersion: "1.2.2",
      }),
      releaseVerifier: trustedRelease(),
    }),
    isPreflightFailure,
  );
  fileSystem.files.set(legacyCoreManifest.path, exactLegacyCoreBytes);
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-upgrade-legacy-windows-restricted-sid",
    configuration,
    plan: createServicePlan({
      operation: "upgrade",
      configuration,
      activeVersion: "1.2.2",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  const targetCoreManifest = renderPlatformServiceArtifacts(configuration).files.find(
    (file) => file.purpose === "core-manifest",
  );
  assert.ok(targetCoreManifest);
  assert.deepEqual(
    fileSystem.files.get(targetCoreManifest.path),
    renderedFileBytes(targetCoreManifest.encoding, targetCoreManifest.content),
  );
  assert.ok(
    process.requests.some(
      (request) =>
        request.executable.toLowerCase().endsWith("sc.exe") &&
        request.arguments.join(" ") === "sidtype OpenDelegate-personal unrestricted",
    ),
  );
});

test("macOS upgrade accepts only the exact legacy core manifest without the service PATH", async () => {
  const configuration = macOsConfiguration();
  const installedConfiguration = macOsConfiguration({
    ...configuration,
    bundle: {
      ...configuration.bundle,
      version: "1.2.2",
    },
  });
  const fileSystem = new FakeFileSystem();
  const installedArtifacts = renderPlatformServiceArtifacts(installedConfiguration);
  const servicePathEntry = [
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    "    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    "  </dict>",
    "",
  ].join("\n");
  for (const file of installedArtifacts.files) {
    const content =
      file.purpose === "core-manifest" ? file.content.replace(servicePathEntry, "") : file.content;
    fileSystem.files.set(file.path, renderedFileBytes(file.encoding, content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  const legacyCoreManifest = installedArtifacts.files.find(
    (file) => file.purpose === "core-manifest",
  );
  assert.ok(legacyCoreManifest);
  const exactLegacyCoreBytes = fileSystem.files.get(legacyCoreManifest.path);
  assert.ok(exactLegacyCoreBytes);
  assert.doesNotMatch(exactLegacyCoreBytes.toString("utf8"), /EnvironmentVariables/u);
  const { boundaries } = fakeBoundaries({
    platform: "macos",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process: new FakeProcess(),
    healthy: true,
    healthRole: "worker",
  });
  const plan = createServicePlan({
    operation: "upgrade",
    configuration,
    activeVersion: "1.2.2",
  });

  fileSystem.files.set(
    legacyCoreManifest.path,
    Buffer.concat([exactLegacyCoreBytes, Buffer.from(" ", "utf8")]),
  );
  await assert.rejects(
    preflightNativeServiceOperation({
      platform: "macos",
      boundaries,
      configuration,
      plan,
      releaseVerifier: trustedRelease(),
    }),
    isPreflightFailure,
  );

  fileSystem.files.set(legacyCoreManifest.path, exactLegacyCoreBytes);
  await preflightNativeServiceOperation({
    platform: "macos",
    boundaries,
    configuration,
    plan,
    releaseVerifier: trustedRelease(),
  });
});

test("Windows Worker upgrade accepts only the exact legacy runtime without the owner home", async () => {
  const base = windowsConfigurationWithServiceBinding("worker");
  const configuration = windowsConfiguration({
    ...base,
    ownerSession: {
      ...base.ownerSession,
      homeDirectory: "C:\\Users\\owner",
    },
  });
  const installedConfiguration = windowsConfiguration({
    ...configuration,
    bundle: { ...configuration.bundle, version: "1.2.2" },
  });
  const fileSystem = new FakeFileSystem();
  const installedArtifacts = renderPlatformServiceArtifacts(installedConfiguration);
  for (const file of installedArtifacts.files) {
    const content =
      file.purpose === "runtime-configuration"
        ? `${JSON.stringify(
            (() => {
              const legacy = JSON.parse(file.content) as {
                ownerSession: { homeDirectory?: string };
              };
              delete legacy.ownerSession.homeDirectory;
              return legacy;
            })(),
            undefined,
            2,
          )}\n`
        : file.content;
    fileSystem.files.set(file.path, renderedFileBytes(file.encoding, content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  fileSystem.directories.set("C:\\Program Files\\OpenDelegate\\releases", [
    { name: "1.2.2", kind: "directory" },
    { name: "1.2.3", kind: "directory" },
  ]);
  const process = new FakeProcess();
  process.handler = (request) =>
    request.executable.toLowerCase().endsWith("sc.exe") && request.arguments[0] === "showsid"
      ? processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`)
      : processResult(0);
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
    healthy: true,
    healthRole: "worker",
  });
  const runtimeFile = installedArtifacts.files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(runtimeFile);
  const exactLegacyBytes = fileSystem.files.get(runtimeFile.path);
  assert.ok(exactLegacyBytes);

  fileSystem.files.set(runtimeFile.path, Buffer.concat([exactLegacyBytes, Buffer.from(" ")]));
  await assert.rejects(
    preflightNativeServiceOperation({
      platform: "windows",
      boundaries,
      configuration,
      plan: createServicePlan({ operation: "upgrade", configuration, activeVersion: "1.2.2" }),
      releaseVerifier: trustedRelease(),
    }),
    isPreflightFailure,
  );

  fileSystem.files.set(runtimeFile.path, exactLegacyBytes);
  await preflightNativeServiceOperation({
    platform: "windows",
    boundaries,
    configuration,
    plan: createServicePlan({ operation: "upgrade", configuration, activeVersion: "1.2.2" }),
    releaseVerifier: trustedRelease(),
  });
});

test("Windows Worker upgrade accepts only a coherent staged credential migration", async () => {
  const targetConfiguration = windowsConfigurationWithServiceBinding("worker");
  const previousCore = {
    keyId: "sha256:e7235c4d3fcae8c6cab1363028a6b65beff1226696f02793f36f8bbe2ed51797",
    publicKeySpkiBase64Url: "MCowBQYDK2VwAyEA1FwCTlBzsp5Dmtumo472upeCAh6Kic4zJmDPtm0N8go",
  } as const;
  const installedConfiguration = windowsConfiguration({
    ...targetConfiguration,
    bundle: {
      ...targetConfiguration.bundle,
      version: "1.2.2",
    },
    helperSecretBinding: {
      backend: "windows-dpapi",
      vaultRoot: "C:\\Users\\owner\\AppData\\Local\\OpenDelegate\\worker\\secrets\\dpapi",
    },
    ipcTrust: {
      ...targetConfiguration.ipcTrust,
      core: previousCore,
    },
  });
  const fileSystem = new FakeFileSystem();
  const installedArtifacts = renderPlatformServiceArtifacts(installedConfiguration);
  for (const file of installedArtifacts.files) {
    fileSystem.files.set(file.path, renderedFileBytes(file.encoding, file.content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  fileSystem.directories.set("C:\\Program Files\\OpenDelegate\\releases", [
    { name: "1.2.2", kind: "directory" },
    { name: "1.2.3", kind: "directory" },
  ]);
  const process = new FakeProcess();
  process.handler = (request) =>
    request.executable.toLowerCase().endsWith("sc.exe") && request.arguments[0] === "showsid"
      ? processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`)
      : processResult(0);
  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
    healthy: true,
    healthRole: "worker",
  });
  const runtimeFile = installedArtifacts.files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(runtimeFile);
  const exactPreviousRuntime = fileSystem.files.get(runtimeFile.path);
  assert.ok(exactPreviousRuntime);
  const incoherent = JSON.parse(exactPreviousRuntime.toString("utf8")) as {
    localIpc: { helper: { peerKeyId: string } };
  };
  incoherent.localIpc.helper.peerKeyId = `sha256:${"d".repeat(64)}`;
  fileSystem.files.set(
    runtimeFile.path,
    Buffer.from(`${JSON.stringify(incoherent, undefined, 2)}\n`),
  );
  await assert.rejects(
    preflightNativeServiceOperation({
      platform: "windows",
      boundaries,
      configuration: targetConfiguration,
      plan: createServicePlan({
        operation: "upgrade",
        configuration: targetConfiguration,
        activeVersion: "1.2.2",
      }),
      releaseVerifier: trustedRelease(),
    }),
    isPreflightFailure,
  );
  const unrelatedDrift = JSON.parse(exactPreviousRuntime.toString("utf8")) as {
    health: { timeoutMs: number };
  };
  unrelatedDrift.health.timeoutMs += 1;
  fileSystem.files.set(
    runtimeFile.path,
    Buffer.from(`${JSON.stringify(unrelatedDrift, undefined, 2)}\n`),
  );
  await assert.rejects(
    preflightNativeServiceOperation({
      platform: "windows",
      boundaries,
      configuration: targetConfiguration,
      plan: createServicePlan({
        operation: "upgrade",
        configuration: targetConfiguration,
        activeVersion: "1.2.2",
      }),
      releaseVerifier: trustedRelease(),
    }),
    isPreflightFailure,
  );
  fileSystem.files.set(runtimeFile.path, exactPreviousRuntime);
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-upgrade-worker-credential-migration",
    configuration: targetConfiguration,
    plan: createServicePlan({
      operation: "upgrade",
      configuration: targetConfiguration,
      activeVersion: "1.2.2",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  const targetRuntime = renderPlatformServiceArtifacts(targetConfiguration).files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(targetRuntime);
  assert.deepEqual(
    fileSystem.files.get(targetRuntime.path),
    renderedFileBytes(targetRuntime.encoding, targetRuntime.content),
  );
});

test("Admin auto-open reconfiguration atomically replaces only the installed runtime configuration", async () => {
  const previousConfiguration = linuxConfiguration({ role: "main" });
  const configuration = linuxConfiguration({
    role: "main",
    ownerSession: {
      ...previousConfiguration.ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "https://admin.example.test/",
      },
    },
  });
  const fileSystem = new FakeFileSystem();
  const previousArtifacts = renderPlatformServiceArtifacts(previousConfiguration);
  for (const file of previousArtifacts.files) {
    fileSystem.files.set(file.path, Buffer.from(file.content));
    fileSystem.kinds.set(file.path, "regular-file");
  }
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.executable === "/usr/bin/id") {
      return processResult(0, "400\n");
    }
    if (request.arguments.includes("is-active")) {
      return processResult(0, "active\n");
    }
    return processResult(0);
  };
  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-reconfigure-admin-auto-open",
    configuration,
    previousConfiguration,
    plan: createServicePlan({
      operation: "reconfigure",
      configuration,
      previousConfiguration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  const runtimeConfiguration = renderPlatformServiceArtifacts(configuration).files.find(
    (file) => file.purpose === "runtime-configuration",
  );
  assert.ok(runtimeConfiguration);
  assert.deepEqual(
    fileSystem.files.get(runtimeConfiguration.path),
    Buffer.from(runtimeConfiguration.content),
  );
  assert.equal(
    process.requests.some((request) =>
      request.arguments.includes(`opendelegate-${configuration.instanceId}.service`),
    ),
    false,
  );
});

test("Admin auto-open reconfiguration refuses unrelated installed definition drift before claim", async () => {
  const previousConfiguration = linuxConfiguration({ role: "main" });
  const configuration = linuxConfiguration({
    role: "main",
    ownerSession: {
      ...previousConfiguration.ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "https://admin.example.test/",
      },
    },
  });
  const fileSystem = new FakeFileSystem();
  const previousArtifacts = renderPlatformServiceArtifacts(previousConfiguration);
  for (const file of previousArtifacts.files) {
    fileSystem.files.set(
      file.path,
      file.purpose === "runtime-configuration"
        ? Buffer.from(file.content)
        : Buffer.from("unrelated installed drift"),
    );
    fileSystem.kinds.set(file.path, "regular-file");
  }
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    fileSystem,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  await assert.rejects(
    executor.execute({
      commandId: "service-reconfigure-definition-drift",
      configuration,
      previousConfiguration,
      plan: createServicePlan({
        operation: "reconfigure",
        configuration,
        previousConfiguration,
        activeVersion: "1.2.3",
      }),
    }),
    isPreflightFailure,
  );
  assert.equal(journal.claims, 0);
  assert.equal(mutations(), 0);
});

test("Linux install rejects an existing service account with a mismatched primary group", async () => {
  const configuration = linuxConfiguration();
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.arguments[0] === "group") {
      return processResult(0, "opendelegate:x:400:\n");
    }
    if (request.arguments[0] === "passwd") {
      return processResult(0, "opendelegate:x:399:401::/nonexistent:/usr/sbin/nologin\n");
    }
    return processResult(0);
  };
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "linux",
    elevated: true,
    loggedIn: true,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "linux",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-install-account-collision",
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
  });

  assert.equal(result.report.outcome, "failed");
  assert.equal(result.report.failedStepId, "ensure-service-account");
  assert.equal(mutations(), 0);
});

test("macOS install accepts the native-prefixed hidden-account attribute", async () => {
  const configuration = macOsConfiguration({ role: "worker" });
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.executable === "/usr/bin/dscl") {
      const attribute = request.arguments[3];
      if (attribute === "PrimaryGroupID") {
        return processResult(0, "PrimaryGroupID: 490\n");
      }
      if (attribute === "UserShell") {
        return processResult(0, "UserShell: /usr/bin/false\n");
      }
      if (attribute === "NFSHomeDirectory") {
        return processResult(0, "NFSHomeDirectory: /var/empty\n");
      }
      if (attribute === "UniqueID") {
        return processResult(0, "UniqueID: 490\n");
      }
      if (attribute === "IsHidden") {
        return processResult(0, "dsAttrTypeNative:IsHidden: 1\n");
      }
      return processResult(0);
    }
    if (request.executable === "/usr/sbin/dseditgroup") {
      return processResult(0, "yes owner is a member of _opendelegate\n");
    }
    if (request.executable === "/usr/bin/id") {
      return processResult(0, "490\n");
    }
    return processResult(0);
  };
  const journal = new MemoryJournal();
  const fileSystem = new FakeFileSystem();
  fileSystem.directories.set("/Library/OpenDelegate/releases", [
    { name: "1.2.3", kind: "directory" },
  ]);
  const { boundaries } = fakeBoundaries({
    platform: "macos",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
    healthRole: "worker",
  });
  const executor = createNativeServiceExecutor({
    platform: "macos",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-install-existing-macos-account",
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
});

test("macOS staging grants the service group access to every copied release path", async () => {
  const configuration = macOsConfiguration({ role: "worker" });
  const plan = createServicePlan({ operation: "install", configuration });
  const stageStep = plan.steps.find((step) => step.action.kind === "release.stage");
  const promoteStep = plan.steps.find((step) => step.action.kind === "release.promote");
  assert.equal(stageStep?.action.kind, "release.stage");
  assert.equal(promoteStep?.action.kind, "release.promote");
  if (
    stageStep?.action.kind !== "release.stage" ||
    promoteStep?.action.kind !== "release.promote"
  ) {
    throw new Error("expected release staging and promotion steps");
  }
  const stagingDirectory = stageStep.action.stagingDirectory;
  const releaseDirectory = promoteStep.action.releaseDirectory;

  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.executable === "/usr/bin/dscl") {
      const attribute = request.arguments[3];
      if (attribute === "PrimaryGroupID") {
        return processResult(0, "PrimaryGroupID: 490\n");
      }
      if (attribute === "UserShell") {
        return processResult(0, "UserShell: /usr/bin/false\n");
      }
      if (attribute === "NFSHomeDirectory") {
        return processResult(0, "NFSHomeDirectory: /var/empty\n");
      }
      if (attribute === "UniqueID") {
        return processResult(0, "UniqueID: 490\n");
      }
      if (attribute === "IsHidden") {
        return processResult(0, "dsAttrTypeNative:IsHidden: 1\n");
      }
    }
    if (request.executable === "/usr/sbin/dseditgroup") {
      return processResult(0, "yes owner is a member of _opendelegate\n");
    }
    if (request.executable === "/usr/bin/id") {
      return processResult(0, "490\n");
    }
    return processResult(0);
  };

  const fileSystem = new FakeFileSystem();
  const source = configuration.bundle.sourceDirectory;
  const sourceBin = `${source}/bin`;
  for (const [path, bytes, mode] of [
    [`${sourceBin}/opendelegate-service-host`, Buffer.from("core"), 0o755],
    [`${sourceBin}/opendelegate-session-helper`, Buffer.from("helper"), 0o755],
    [`${source}/release-metadata.json`, Buffer.from("{}"), 0o644],
  ] as const) {
    fileSystem.files.set(path, bytes);
    fileSystem.kinds.set(path, "regular-file");
    fileSystem.modes.set(path, mode);
  }
  fileSystem.kinds.set(source, "directory");
  fileSystem.kinds.set(sourceBin, "directory");
  fileSystem.directories.set(source, [
    { name: "bin", kind: "directory" },
    { name: "release-metadata.json", kind: "regular-file" },
  ]);
  fileSystem.directories.set(sourceBin, [
    { name: "opendelegate-service-host", kind: "regular-file" },
    { name: "opendelegate-session-helper", kind: "regular-file" },
  ]);
  fileSystem.kinds.set(stagingDirectory, "missing");
  fileSystem.kinds.set(releaseDirectory, "missing");
  fileSystem.directories.set("/Library/OpenDelegate/releases", [
    { name: configuration.bundle.version, kind: "directory" },
  ]);

  const originalInspect = fileSystem.inspect.bind(fileSystem);
  fileSystem.inspect = async (path) => {
    if (
      !fileSystem.kinds.has(path) &&
      path.startsWith(`${stagingDirectory}.`) &&
      path.endsWith(".copying")
    ) {
      return { kind: "missing" as const };
    }
    return await originalInspect(path);
  };

  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "macos",
    elevated: true,
    loggedIn: false,
    fileSystem,
    process,
    healthRole: "worker",
  });
  const executor = createNativeServiceExecutor({
    platform: "macos",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-install-macos-release-access",
    configuration,
    plan,
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  const copyRoot = fileSystem.posixAccessChanges.find(
    (change) => change.path.startsWith(`${stagingDirectory}.`) && change.path.endsWith(".copying"),
  )?.path;
  assert.ok(copyRoot, "the staging copy root must receive canonical POSIX access");
  assert.deepEqual(
    fileSystem.posixAccessChanges
      .filter((change) => change.path === copyRoot || change.path.startsWith(`${copyRoot}/`))
      .map((change) => ({ ...change, path: change.path.slice(copyRoot.length) || "/" })),
    [
      { path: "/", uid: 0, gid: 490, mode: 0o750 },
      { path: "/bin", uid: 0, gid: 490, mode: 0o750 },
      { path: "/bin/opendelegate-service-host", uid: 0, gid: 490, mode: 0o750 },
      { path: "/bin/opendelegate-session-helper", uid: 0, gid: 490, mode: 0o750 },
      { path: "/release-metadata.json", uid: 0, gid: 490, mode: 0o640 },
    ],
  );
});

test("logged-out helpers defer while the core starts and exact replay does not invoke supervisors twice", async () => {
  const configuration = windowsConfiguration();
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.executable.toLowerCase().endsWith("sc.exe")) {
      return processResult(0);
    }
    throw new Error(`unexpected process ${request.executable}`);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    process,
    healthy: true,
  });
  let releaseTrustChecks = 0;
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(() => {
      releaseTrustChecks += 1;
    }),
  });
  const plan = createServicePlan({
    operation: "start",
    configuration,
    activeVersion: "1.2.3",
  });

  const first = await executor.execute({
    commandId: "service-start-replay",
    configuration,
    plan,
  });
  const requestCount = process.requests.length;
  const replay = await executor.execute({
    commandId: "service-start-replay",
    configuration,
    plan,
  });

  assert.equal(first.report.outcome, "succeeded");
  assert.ok(first.report.unchangedStepIds.includes("start-helper"));
  assert.equal(replay.replayed, true);
  assert.equal(process.requests.length, requestCount);
  assert.equal(releaseTrustChecks, 0);
});

test("logged-in Windows helper health uses live presence when Task Scheduler text is localized", async () => {
  const configuration = windowsConfiguration();
  const journal = new MemoryJournal();
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  const helperPresencePath = String.raw`C:\ProgramData\OpenDelegate\run\helper-plane-v2.json`;
  fileSystem.kinds.set(helperPresencePath, "regular-file");
  fileSystem.files.set(
    helperPresencePath,
    Buffer.from(
      JSON.stringify({
        payload: {
          plane: "session-helper",
          instanceId: configuration.instanceId,
          deviceId: configuration.deviceId,
          releaseVersion: configuration.bundle.version,
          processId: 4242,
        },
      }),
      "utf8",
    ),
  );
  let helperProcessReads = 0;
  process.processAliveHandler = (processId) => {
    assert.equal(processId, 4242);
    helperProcessReads += 1;
    return helperProcessReads >= 3;
  };
  process.handler = (request) => {
    if (request.executable.toLowerCase().endsWith("schtasks.exe")) {
      if (request.arguments[0]?.toLowerCase() === "/query") {
        return processResult(0, '"\\OpenDelegate-personal-SessionHelper","N/A","���� ��"\r\n');
      }
      return processResult(0);
    }
    if (request.executable.toLowerCase().endsWith("sc.exe")) {
      return processResult(0);
    }
    throw new Error(`unexpected process ${request.executable}`);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-start-waits-for-helper",
    configuration,
    plan: createServicePlan({
      operation: "start",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  assert.equal(helperProcessReads, 3);
});

test("Windows helper stop waits for Task Scheduler to leave Running", async () => {
  const process = new FakeProcess();
  let statusReads = 0;
  let processReads = 0;
  process.processAliveHandler = (processId) => {
    assert.equal(processId, 4242);
    processReads += 1;
    return processReads < 3;
  };
  process.handler = (request) => {
    assert.deepEqual(request.arguments, [
      "/Query",
      "/TN",
      "\\OpenDelegate-personal-SessionHelper",
      "/FO",
      "CSV",
      "/NH",
    ]);
    statusReads += 1;
    return processResult(
      0,
      statusReads < 3
        ? '"\\OpenDelegate-personal-SessionHelper","N/A","Running"\r\n'
        : '"\\OpenDelegate-personal-SessionHelper","N/A","Ready"\r\n',
    );
  };
  let now = 0;
  const sleeps: number[] = [];
  const fileSystem = new FakeFileSystem();
  const helperPresencePath = String.raw`C:\ProgramData\OpenDelegate\run\helper-plane-v2.json`;
  fileSystem.kinds.set(helperPresencePath, "regular-file");
  fileSystem.files.set(
    helperPresencePath,
    Buffer.from(JSON.stringify({ payload: { processId: 4242 } }), "utf8"),
  );

  await waitForWindowsScheduledTaskStopped({
    executable: String.raw`C:\Windows\System32\schtasks.exe`,
    taskName: "\\OpenDelegate-personal-SessionHelper",
    timeoutMs: 30_000,
    process,
    fileSystem,
    helperPresencePath,
    clock: {
      now: () => new Date(now),
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  });

  assert.equal(statusReads, 5);
  assert.equal(processReads, 3);
  assert.deepEqual(sleeps, [500, 500, 500, 500]);
});

test("a partial Windows SCM install is compensated without invoking a shell", async () => {
  const configuration = windowsConfigurationWithServiceBinding("main");
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = (request) => {
    assert.equal(Array.isArray(request.arguments), true);
    const verb = request.arguments[0]?.toLowerCase();
    if (verb === "showsid") {
      return processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`);
    }
    if (verb === "create" || verb === "delete") {
      return processResult(0);
    }
    if (verb === "description") {
      return processResult(5);
    }
    throw new Error(`unexpected command ${request.arguments.join("|")}`);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-install-partial",
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
  });

  assert.equal(result.report.outcome, "failed");
  assert.equal(result.report.failedStepId, "install-core");
  assert.deepEqual(
    process.requests.map((request) => request.arguments[0]),
    ["showsid", "create", "description", "delete"],
  );
});

test("fresh Windows install never adopts or force-overwrites existing registrations", async () => {
  const configuration = windowsConfigurationWithServiceBinding("main");
  const plan = createServicePlan({ operation: "install", configuration });
  const coreInstall = plan.steps.find((step) => step.id === "install-core");
  const helperInstall = plan.steps.find((step) => step.id === "install-helper");
  assert.equal(coreInstall?.action.kind, "supervisor.invoke");
  assert.equal(helperInstall?.action.kind, "supervisor.invoke");
  if (
    coreInstall?.action.kind !== "supervisor.invoke" ||
    helperInstall?.action.kind !== "supervisor.invoke"
  ) {
    throw new Error("expected Windows supervisor install steps");
  }
  assert.deepEqual(coreInstall.action.command.invocations[0]?.expectedExitCodes, [0]);
  assert.equal(
    helperInstall.action.command.invocations.some((invocation) =>
      invocation.arguments.some((argument) => argument.toLowerCase() === "/f"),
    ),
    false,
  );

  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.arguments[0] === "showsid") {
      return processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`);
    }
    return request.executable.toLowerCase().endsWith("sc.exe") && request.arguments[0] === "create"
      ? processResult(1073)
      : processResult(0);
  };
  const journal = new MemoryJournal();
  const { boundaries, mutations } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });
  const result = await executor.execute({
    commandId: "service-install-existing-scm",
    configuration,
    plan,
  });

  assert.equal(result.report.outcome, "failed");
  assert.equal(mutations(), 0);
  assert.deepEqual(
    process.requests
      .filter(
        (request) =>
          request.executable.toLowerCase().endsWith("sc.exe") && request.arguments[0] === "create",
      )
      .map((request) => request.arguments.slice(0, 2)),
    [["create", `OpenDelegate-${configuration.instanceId}`]],
  );
});

test("owner-session command arguments remain discrete even when a path contains shell metacharacters", async () => {
  const configuration = macOsConfiguration({
    ownerSession: {
      userName: "owner",
      stableUserId: "501",
      uid: 501,
      homeDirectory: "/Users/owner;whoami",
      adminAutoOpen: {
        enabled: false,
      },
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = (request) => {
    if (
      request.arguments.includes("print") ||
      request.arguments.includes("kickstart") ||
      request.arguments.includes("bootstrap") ||
      request.arguments.includes("enable")
    ) {
      return processResult(0, "state = running\n");
    }
    return processResult(0);
  };
  const { boundaries } = fakeBoundaries({
    platform: "macos",
    elevated: true,
    loggedIn: true,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "macos",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-start-argv-safe",
    configuration,
    plan: createServicePlan({
      operation: "start",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded");
  const bootstrap = process.requests.find((request) =>
    request.arguments.some((argument) => argument.includes("owner;whoami")),
  );
  assert.ok(bootstrap);
  assert.equal(bootstrap.arguments.filter((argument) => argument === "whoami").length, 0);
});

test("macOS restart waits for each launchd bootout before bootstrapping it again", async () => {
  const configuration = macOsConfiguration();
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  const coreTarget = "system/dev.opendelegate.personal.core";
  const helperTarget = "gui/501/dev.opendelegate.personal.session-helper";
  const loaded = new Map<string, boolean>([
    [coreTarget, true],
    [helperTarget, true],
  ]);
  const pendingBootoutPolls = new Map<string, number>();
  const launchctlArguments = (request: NativeProcessRequest): readonly string[] =>
    request.arguments[0] === "asuser" ? request.arguments.slice(3) : request.arguments;

  process.handler = (request) => {
    if (request.executable !== "/bin/launchctl") {
      return processResult(0);
    }
    const args = launchctlArguments(request);
    const verb = args[0];
    const target = args[1];
    if (verb === "bootout" && target !== undefined) {
      pendingBootoutPolls.set(target, 2);
      return processResult(0);
    }
    if (verb === "print" && target !== undefined) {
      const remaining = pendingBootoutPolls.get(target);
      if (remaining !== undefined) {
        if (remaining > 1) {
          pendingBootoutPolls.set(target, remaining - 1);
          return processResult(0, "state = running\n");
        }
        pendingBootoutPolls.delete(target);
        loaded.set(target, false);
        return processResult(113, "", "Could not find service");
      }
      return loaded.get(target) === true
        ? processResult(0, "state = running\n")
        : processResult(113, "", "Could not find service");
    }
    if (verb === "bootstrap") {
      const manifest = args[2];
      const bootstrapTarget = manifest?.includes("session-helper") ? helperTarget : coreTarget;
      assert.equal(pendingBootoutPolls.has(bootstrapTarget), false);
      loaded.set(bootstrapTarget, true);
      return processResult(0);
    }
    if (verb === "kickstart") {
      const kickstartTarget = args[2];
      assert.ok(kickstartTarget !== undefined);
      assert.equal(loaded.get(kickstartTarget), true);
      return processResult(0);
    }
    return processResult(0);
  };
  const { boundaries } = fakeBoundaries({
    platform: "macos",
    elevated: true,
    loggedIn: true,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "macos",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-restart-macos-bootout-race",
    configuration,
    plan: createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  for (const target of [helperTarget, coreTarget]) {
    const normalized = process.requests.map(launchctlArguments);
    const bootout = normalized.findIndex((args) => args[0] === "bootout" && args[1] === target);
    const bootstrap = normalized.findIndex(
      (args, index) =>
        index > bootout &&
        args[0] === "bootstrap" &&
        (target === helperTarget ? args[2]?.includes("session-helper") : args[2]?.includes("core")),
    );
    assert.ok(bootout >= 0);
    assert.ok(bootstrap > bootout);
    assert.equal(
      normalized
        .slice(bootout + 1, bootstrap)
        .filter((args) => args[0] === "print" && args[1] === target).length,
      2,
    );
  }
});

test("core health failure rolls a restart back through structured supervisor commands", async () => {
  const configuration = windowsConfiguration({
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 1_000,
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = () => processResult(0);
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    process,
    healthy: false,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-restart-health",
    configuration,
    plan: createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "rolled-back");
  assert.equal(result.report.failedStepId, "health-core");
  const serviceVerbs = process.requests
    .filter((request) => request.executable.toLowerCase().endsWith("sc.exe"))
    .map((request) => request.arguments[0]);
  assert.deepEqual(serviceVerbs, ["stop", "query", "start", "stop", "query", "start"]);
});

test("Windows restart reads localized service states before starting the replacement", async () => {
  const configuration = windowsConfiguration({
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 1_000,
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  let statusQueries = 0;
  process.handler = (request) => {
    const verb = request.arguments[0]?.toLowerCase();
    if (request.executable.toLowerCase().endsWith("sc.exe") && verb === "query") {
      statusQueries += 1;
      return processResult(
        0,
        statusQueries < 3
          ? "상태               : 3  중지_대기\r\n"
          : "상태               : 1  중지됨\r\n",
      );
    }
    if (request.executable.toLowerCase().endsWith("sc.exe") && verb === "start") {
      assert.equal(statusQueries, 3);
    }
    return processResult(0);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-restart-stop-pending",
    configuration,
    plan: createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded");
  assert.deepEqual(
    process.requests
      .filter((request) => request.executable.toLowerCase().endsWith("sc.exe"))
      .map((request) => request.arguments[0]),
    ["stop", "query", "query", "query", "start"],
  );
});

test("Windows restart tolerates a transient service status process failure", async () => {
  const configuration = windowsConfiguration({
    health: {
      endpoint: "http://127.0.0.1:43190/health/live",
      timeoutMs: 1_000,
    },
  });
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  let statusQueries = 0;
  process.handler = (request) => {
    const verb = request.arguments[0]?.toLowerCase();
    if (request.executable.toLowerCase().endsWith("sc.exe") && verb === "query") {
      statusQueries += 1;
      if (statusQueries === 1) {
        throw new NativeBoundaryError(
          "NATIVE_PROCESS_FAILED",
          "A transient Windows service status process failed to start.",
        );
      }
      return processResult(0, "STATE              : 1  STOPPED\r\n");
    }
    return processResult(0);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-restart-transient-query-failure",
    configuration,
    plan: createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "succeeded");
  assert.deepEqual(
    process.requests
      .filter((request) => request.executable.toLowerCase().endsWith("sc.exe"))
      .map((request) => request.arguments[0]),
    ["stop", "query", "query", "start"],
  );
});

test("Windows restart compensates an uncertain service stop before reporting failure", async () => {
  const configuration = windowsConfiguration();
  const journal = new MemoryJournal();
  const process = new FakeProcess();
  process.handler = (request) => {
    if (
      request.executable.toLowerCase().endsWith("sc.exe") &&
      request.arguments[0]?.toLowerCase() === "query"
    ) {
      throw new NativeBoundaryError(
        "NATIVE_PROCESS_FAILED",
        "The Windows service status process remained unavailable.",
      );
    }
    return processResult(0);
  };
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: false,
    process,
    healthy: true,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier: trustedRelease(),
  });

  const result = await executor.execute({
    commandId: "service-restart-compensate-uncertain-stop",
    configuration,
    plan: createServicePlan({
      operation: "restart",
      configuration,
      activeVersion: "1.2.3",
    }),
  });

  assert.equal(result.report.outcome, "failed");
  assert.equal(result.report.failedStepId, "stop-core");
  assert.deepEqual(
    process.requests
      .filter((request) => request.executable.toLowerCase().endsWith("sc.exe"))
      .map((request) => request.arguments[0]),
    ["stop", "query", "query", "query", "start"],
  );
});

test("native inspection keeps core health, helper presence, and Computer Use readiness separate", async () => {
  const configuration = windowsConfiguration();
  const process = new FakeProcess();
  process.handler = (request) =>
    request.executable.toLowerCase().endsWith("sc.exe")
      ? processResult(0, "상태               : 4  실행_중\r\n")
      : processResult(1);
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: false,
    loggedIn: false,
    process,
    healthy: true,
  });
  const inspector = createNativeServiceInspector({
    platform: "windows",
    boundaries,
  });

  const diagnostic = await inspector.inspect(configuration);

  assert.equal(diagnostic.core.status, "running");
  assert.equal(diagnostic.helper.status, "not-loaded");
  assert.equal(diagnostic.readiness.session, "logged-out");
  assert.equal(diagnostic.readiness.computerUse, "unavailable");
  assert.equal(diagnostic.readiness.headlessWorkAvailable, true);
  assert.equal(diagnostic.secretValuesIncluded, false);
});

test("native inspection binds core health to the exact configured service identity", async () => {
  const configuration = windowsConfiguration();
  const process = new FakeProcess();
  process.handler = (request) =>
    request.executable.toLowerCase().endsWith("sc.exe")
      ? processResult(0, "STATE              : 4  RUNNING\r\n")
      : processResult(1);
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: false,
    loggedIn: false,
    process,
    healthy: true,
    healthBody: JSON.stringify({
      schemaVersion: 1,
      product: "OpenDelegate",
      plane: "core",
      instanceId: "another-instance",
      deviceId: configuration.deviceId,
      role: configuration.role,
      releaseVersion: configuration.bundle.version,
      status: "running",
      headlessWorkAvailable: true,
    }),
  });
  const inspector = createNativeServiceInspector({
    platform: "windows",
    boundaries,
  });

  const diagnostic = await inspector.inspect(configuration);

  assert.equal(diagnostic.core.status, "failed");
  assert.equal(diagnostic.readiness.headlessWorkAvailable, false);
});

test("candidate v2 preflight accepts publisher-only authority and exposes a full channel seal", async () => {
  const fileSystem = new FakeFileSystem();
  const configuration = linuxConfiguration();
  prepareReleaseTrack(fileSystem, configuration, "release-candidate");
  const calls: string[] = [];
  const verifier = createNativeReleaseVerifier(fileSystem, {
    architecture: "x64",
    async resolveConfiguredRelease(input) {
      calls.push(input.root);
      assert.equal(input.stateRoot, configuration.paths.stateRoot);
      assert.equal(input.expectedManifestSha256, "a".repeat(64));
      assert.deepEqual(input.expectedTarget, { platform: "linux", architecture: "x64" });
      return configuredCandidateResolution("publisher-verified");
    },
  });

  const verification = await verifier.preflight(configuration);

  assert.equal(verification.verificationKind, "candidate-v2");
  assert.equal(verification.declaredChannel, "release-candidate");
  assert.equal(verification.effectiveChannel, "release-candidate");
  assert.equal(verification.supportStatus, "release-candidate");
  assert.equal(verification.seal?.external.status, "publisher-verified");
  assert.equal(verification.seal?.externalVerificationSha256.length, 64);
  assert.deepEqual(calls, [configuration.bundle.sourceDirectory]);
});

test("candidate v2 preflight fails closed on absent, invalid, promotion-invalid, or revoked authority", async () => {
  for (const status of ["absent", "invalid", "promotion-invalid", "revoked"] as const) {
    const fileSystem = new FakeFileSystem();
    const configuration = linuxConfiguration();
    prepareReleaseTrack(fileSystem, configuration, "release-candidate");
    const verifier = createNativeReleaseVerifier(fileSystem, {
      architecture: "x64",
      async resolveConfiguredRelease() {
        return configuredCandidateResolution(status);
      },
    });

    await assert.rejects(
      verifier.preflight(configuration),
      (error: unknown) =>
        isPreflightFailure(error) &&
        error.message.includes("external release authority") &&
        !error.message.includes("/var/lib"),
    );
  }
});

test("candidate v2 never falls back to the legacy preview verifier", async () => {
  const fileSystem = new FakeFileSystem();
  const base = linuxConfiguration();
  const prepared = prepareSignedBundle(fileSystem, base, {
    mutateMetadata(metadata) {
      metadata.supportStatus = "release-candidate";
      metadata.buildMode = "release-candidate";
    },
  });
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });
  const verifier = createNativeReleaseVerifier(fileSystem, {
    architecture: "x64",
    async resolveConfiguredRelease() {
      throw new Error("candidate-v2-rejected");
    },
  });

  await assert.rejects(
    verifier.preflight(configuration),
    (error: unknown) =>
      isPreflightFailure(error) &&
      error.message.includes("candidate v2") &&
      !error.message.includes("candidate-v2-rejected"),
  );
});

test("candidate staged verification re-inspects copied bytes and rejects a changed seal", async () => {
  const fileSystem = new FakeFileSystem();
  const configuration = linuxConfiguration();
  prepareReleaseTrack(fileSystem, configuration, "release-candidate");
  let calls = 0;
  const verifier = createNativeReleaseVerifier(fileSystem, {
    architecture: "x64",
    async resolveConfiguredRelease() {
      calls += 1;
      return configuredCandidateResolution(
        "publisher-verified",
        calls === 1 ? {} : { payloadManifestSha256: "9".repeat(64) },
      );
    },
  });
  const verification = await verifier.preflight(configuration);

  await assert.rejects(
    verifier.verifyStaged(configuration, "/opt/opendelegate/.staging/1.2.3", verification),
    (error: unknown) => isPreflightFailure(error) && error.message.includes("verification seal"),
  );
  assert.equal(calls, 2);
});

test("candidate activation re-runs external authority immediately against installed bytes", async () => {
  const fileSystem = new FakeFileSystem();
  const configuration = linuxConfiguration();
  prepareReleaseTrack(fileSystem, configuration, "release-candidate");
  const roots: string[] = [];
  const verifier = createNativeReleaseVerifier(fileSystem, {
    architecture: "x64",
    async resolveConfiguredRelease(input) {
      roots.push(input.root);
      return roots.length < 2
        ? configuredCandidateResolution("released")
        : configuredCandidateResolution("revoked");
    },
  });
  const verification = await verifier.preflight(configuration);

  await assert.rejects(
    verifier.verifyBeforeActivation(
      configuration,
      "/opt/opendelegate/releases/1.2.3",
      verification,
    ),
    (error: unknown) =>
      isPreflightFailure(error) && error.message.includes("external release authority"),
  );
  assert.deepEqual(roots, [
    configuration.bundle.sourceDirectory,
    "/opt/opendelegate/releases/1.2.3",
  ]);
});

test("failed candidate activation removes only the new seal and preserves a prior release seal", async () => {
  const configuration = windowsConfigurationWithServiceBinding("main");
  const fileSystem = new FakeFileSystem();
  const process = new FakeProcess();
  process.handler = (request) => {
    if (request.arguments[0] === "showsid") {
      return processResult(0, `SERVICE SID: ${WINDOWS_SERVICE_SID}`);
    }
    return processResult(0);
  };
  const releaseDirectory = "C:\\Program Files\\OpenDelegate\\releases\\1.2.3";
  const stagingDirectory = "C:\\Program Files\\OpenDelegate\\.staging\\1.2.3";
  const priorSealPath = "C:\\ProgramData\\OpenDelegate\\state\\release-verification\\1.2.2.json";
  const newSealPath = "C:\\ProgramData\\OpenDelegate\\state\\release-verification\\1.2.3.json";
  const priorSeal = Buffer.from("prior-authenticated-seal", "utf8");
  fileSystem.files.set(priorSealPath, priorSeal);
  fileSystem.kinds.set(priorSealPath, "regular-file");
  fileSystem.kinds.set(`${configuration.bundle.sourceDirectory}\\INTERNAL_PREVIEW.md`, "missing");
  fileSystem.kinds.set(configuration.bundle.sourceDirectory, "directory");
  fileSystem.kinds.set("C:\\Program Files\\OpenDelegate\\releases", "missing");
  fileSystem.kinds.set("C:\\Program Files\\OpenDelegate\\.staging", "missing");
  fileSystem.kinds.set(stagingDirectory, "missing");
  fileSystem.kinds.set(releaseDirectory, "missing");
  const resolverRoots: string[] = [];
  const releaseVerifier = createNativeReleaseVerifier(fileSystem, {
    architecture: "x64",
    async resolveConfiguredRelease(input) {
      resolverRoots.push(input.root);
      return input.root === releaseDirectory
        ? configuredCandidateResolution("revoked", {
            target: { platform: "win32", architecture: "x64" },
          })
        : configuredCandidateResolution("released", {
            target: { platform: "win32", architecture: "x64" },
          });
    },
  });
  const journal = new MemoryJournal();
  const { boundaries } = fakeBoundaries({
    platform: "windows",
    elevated: true,
    loggedIn: true,
    fileSystem,
    process,
  });
  const executor = createNativeServiceExecutor({
    platform: "windows",
    boundaries,
    journalFactory: { create: () => journal },
    releaseVerifier,
  });

  const result = await executor.execute({
    commandId: "service-install-candidate-revoked-before-activation",
    configuration,
    plan: createServicePlan({ operation: "install", configuration }),
  });

  assert.equal(result.report.outcome, "rolled-back", JSON.stringify(result.report));
  assert.equal(fileSystem.links.has("C:\\Program Files\\OpenDelegate\\current"), false);
  assert.deepEqual(fileSystem.files.get(priorSealPath), priorSeal);
  assert.equal(fileSystem.files.has(newSealPath), false);
  assert.equal(resolverRoots.at(-1), releaseDirectory);
});

test("legacy preview start re-authenticates publisher evidence when no persisted seal exists", async () => {
  const fileSystem = new FakeFileSystem();
  const base = linuxConfiguration();
  const prepared = prepareSignedBundle(fileSystem, base);
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });
  const releaseDirectory = "/opt/opendelegate/releases/1.2.3";
  copyFakeReleaseTree(fileSystem, configuration.bundle.sourceDirectory, releaseDirectory, "/");
  const verifier = createNativeReleaseVerifier(fileSystem, { architecture: "x64" });

  const authenticated = await verifier.verifyInstalled(configuration, releaseDirectory);

  assert.equal(authenticated.verificationKind, "legacy-preview");
  assert.equal(authenticated.publisherKeyId, prepared.publisherKeyId);
  assert.notEqual(authenticated.publisherKeyId, `sha256:${"0".repeat(64)}`);

  fileSystem.files.delete(`${configuration.bundle.sourceDirectory}.publisher-attestation.json`);
  await verifier.verifyInstalled(configuration, releaseDirectory, authenticated);
  await assert.rejects(
    verifier.verifyInstalled(configuration, releaseDirectory, {
      ...authenticated,
      publisherAttestation: {
        ...authenticated.publisherAttestation,
        signature: "A".repeat(86),
      },
    }),
    (error: unknown) => isPreflightFailure(error) && error.message.includes("publisher trust root"),
  );
  const rotatedPublisher = generateKeyPairSync("ed25519").publicKey.export({
    format: "pem",
    type: "spki",
  });
  fileSystem.files.set(
    "/var/lib/opendelegate/trust/publisher-ed25519.pem",
    Buffer.from(rotatedPublisher),
  );
  await assert.rejects(
    verifier.verifyInstalled(configuration, releaseDirectory, authenticated),
    (error: unknown) => isPreflightFailure(error) && error.message.includes("publisher trust root"),
  );
  await assert.rejects(
    verifier.verifyInstalled(configuration, releaseDirectory),
    isPreflightFailure,
  );
});

test("release preflight verifies the complete payload and detached Ed25519 publisher attestation", async () => {
  const fileSystem = new FakeFileSystem();
  const source = "/mnt/releases/opendelegate-1.2.3";
  const base = linuxConfiguration({
    bundle: {
      version: "1.2.3",
      sourceDirectory: source,
      checksum: `sha256:${"0".repeat(64)}`,
    },
  });
  const prepared = prepareSignedBundle(fileSystem, base);
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });
  const verifier = createNativeReleaseVerifier(fileSystem, { architecture: "x64" });

  const verified = await verifier.preflight(configuration);
  assert.equal(verified.manifestSha256, prepared.manifestSha256);
  assert.equal(verified.publisherKeyId, prepared.publisherKeyId);

  fileSystem.files.delete(`${source}.publisher-attestation.json`);
  fileSystem.reads.length = 0;
  await assert.rejects(verifier.preflight(configuration), isPreflightFailure);
  assert.equal(fileSystem.reads.includes(`${source}/payload-manifest.json`), false);
  assert.equal(fileSystem.reads.includes(`${source}/release-metadata.json`), false);
});

test("release verification rejects an unlisted link entry even with a valid manifest signature", async () => {
  const fileSystem = new FakeFileSystem();
  const source = "/mnt/releases/opendelegate-1.2.3";
  const base = linuxConfiguration({
    bundle: {
      version: "1.2.3",
      sourceDirectory: source,
      checksum: `sha256:${"0".repeat(64)}`,
    },
  });
  const prepared = prepareSignedBundle(fileSystem, base);
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });
  fileSystem.directories.set(source, [
    ...(fileSystem.directories.get(source) ?? []),
    { name: "escape", kind: "symbolic-link" },
  ]);

  await assert.rejects(
    createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
    isPreflightFailure,
  );
});

test("release preflight accepts only each platform's exact native component contract", async () => {
  for (const base of [windowsConfiguration(), macOsConfiguration(), linuxConfiguration()]) {
    const fileSystem = new FakeFileSystem();
    const prepared = prepareSignedBundle(fileSystem, base);
    const configuration = {
      ...base,
      bundle: {
        ...base.bundle,
        checksum: `sha256:${prepared.manifestSha256}`,
      },
    } as PlatformServiceConfiguration;

    const verified = await createNativeReleaseVerifier(fileSystem, {
      architecture: "x64",
    }).preflight(configuration);

    assert.equal(verified.manifestSha256, prepared.manifestSha256);
  }
});

test("release preflight requires native-components.json as a signed payload file", async () => {
  const fileSystem = new FakeFileSystem();
  const base = linuxConfiguration();
  const prepared = prepareSignedBundle(fileSystem, base);
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });
  fileSystem.files.delete(`${base.bundle.sourceDirectory}/native-components.json`);

  await assert.rejects(
    createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
    isPreflightFailure,
  );
});

test("release preflight rejects divergent metadata and native component manifests", async () => {
  const fileSystem = new FakeFileSystem();
  const base = linuxConfiguration();
  const prepared = prepareSignedBundle(fileSystem, base, {
    mutateMetadata(metadata) {
      metadata.nativeComponents.components[0]!.sha256 = `sha256:${"f".repeat(64)}`;
    },
  });
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });

  await assert.rejects(
    createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
    (error) =>
      isPreflightFailure(error) &&
      error.message.includes("nativeComponents does not match native-components.json"),
  );
});

test("release preflight rejects a self-consistent forged component digest", async () => {
  const fileSystem = new FakeFileSystem();
  const base = linuxConfiguration();
  const componentPath = "bin/opendelegate-service-host";
  const forgedDigest = "f".repeat(64);
  const prepared = prepareSignedBundle(fileSystem, base, {
    mutateNativeComponents(manifest) {
      manifest.components[0]!.sha256 = `sha256:${forgedDigest}`;
    },
    payloadDigestOverrides: {
      [componentPath]: forgedDigest,
    },
  });
  const configuration = linuxConfiguration({
    bundle: {
      ...base.bundle,
      checksum: `sha256:${prepared.manifestSha256}`,
    },
  });

  await assert.rejects(
    createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
    (error) =>
      isPreflightFailure(error) &&
      error.message.includes(`release payload digest is invalid for ${componentPath}`),
  );
});

test("release preflight rejects invalid native component shape, order, target, and digest format", async () => {
  const mutations: readonly ((manifest: MutableNativeComponentsManifest) => void)[] = [
    (manifest) => {
      manifest.components.pop();
    },
    (manifest) => {
      manifest.components.reverse();
    },
    (manifest) => {
      manifest.components[0]!.path = "bin/forged-service-host";
    },
    (manifest) => {
      manifest.platform = "win32";
    },
    (manifest) => {
      manifest.architecture = "arm64";
    },
    (manifest) => {
      manifest.components[0]!.sha256 = "f".repeat(64);
    },
  ];
  for (const mutateNativeComponents of mutations) {
    const fileSystem = new FakeFileSystem();
    const base = linuxConfiguration();
    const prepared = prepareSignedBundle(fileSystem, base, { mutateNativeComponents });
    const configuration = linuxConfiguration({
      bundle: {
        ...base.bundle,
        checksum: `sha256:${prepared.manifestSha256}`,
      },
    });

    await assert.rejects(
      createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
      isPreflightFailure,
    );
  }
});

test("release preflight requires the exact ordered Main and Worker launcher set", async () => {
  const validEntrypoints = [...releaseEntrypoints("linux")];
  const invalidEntrypoints = [
    validEntrypoints.filter((entrypoint) => !entrypoint.includes("worker")),
    [...validEntrypoints].reverse(),
    [...validEntrypoints, "opendelegate-extra"],
  ];
  for (const entrypoints of invalidEntrypoints) {
    const fileSystem = new FakeFileSystem();
    const base = linuxConfiguration();
    const prepared = prepareSignedBundle(fileSystem, base, {
      mutateMetadata(metadata) {
        metadata.entrypoints = entrypoints;
      },
    });
    const configuration = linuxConfiguration({
      bundle: {
        ...base.bundle,
        checksum: `sha256:${prepared.manifestSha256}`,
      },
    });

    await assert.rejects(
      createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
      (error) => isPreflightFailure(error) && error.message.includes("entrypoints do not match"),
    );
  }
});

test("release preflight rejects self-consistent bundles with a missing or empty launcher", async () => {
  const cases: readonly PrepareSignedBundleOptions[] = [
    { omittedLaunchers: ["opendelegate-worker"] },
    { emptyLaunchers: ["opendelegate-worker.cmd"] },
  ];
  for (const options of cases) {
    const fileSystem = new FakeFileSystem();
    const base = linuxConfiguration();
    const prepared = prepareSignedBundle(fileSystem, base, options);
    const configuration = linuxConfiguration({
      bundle: {
        ...base.bundle,
        checksum: `sha256:${prepared.manifestSha256}`,
      },
    });

    await assert.rejects(
      createNativeReleaseVerifier(fileSystem, { architecture: "x64" }).preflight(configuration),
      (error) => isPreflightFailure(error) && error.message.includes("required launcher"),
    );
  }
});

function fakeBoundaries(input: {
  readonly platform: PlatformFamily;
  readonly elevated: boolean;
  readonly loggedIn: boolean;
  readonly fileSystem?: FakeFileSystem;
  readonly process?: FakeProcess;
  readonly healthy?: boolean;
  readonly healthBody?: string;
  readonly healthRole?: PlatformServiceConfiguration["role"];
}): {
  readonly boundaries: NativeServiceBoundaries;
  readonly mutations: () => number;
} {
  const fileSystem = input.fileSystem ?? new FakeFileSystem();
  const process = input.process ?? new FakeProcess();
  let now = 0;
  let mutationCount = 0;
  const originalEnsure = fileSystem.ensureDirectory.bind(fileSystem);
  fileSystem.ensureDirectory = async (path, mode) => {
    mutationCount += 1;
    return await originalEnsure(path, mode);
  };
  const originalWrite = fileSystem.writeAtomic.bind(fileSystem);
  fileSystem.writeAtomic = async (path, bytes, mode) => {
    mutationCount += 1;
    return await originalWrite(path, bytes, mode);
  };
  return {
    boundaries: {
      fileSystem,
      process,
      privilege: {
        async isElevated(platform) {
          assert.equal(platform, input.platform);
          return input.elevated;
        },
      },
      clock: {
        now: () => new Date(now),
        async sleep(milliseconds) {
          now += milliseconds;
        },
      },
      http: {
        async get() {
          const role = input.healthRole ?? (input.platform === "linux" ? "worker" : "main");
          return input.healthy === false
            ? { status: 503, body: '{"status":"unavailable"}' }
            : {
                status: 200,
                body:
                  input.healthBody ??
                  JSON.stringify({
                    schemaVersion: 1,
                    product: "OpenDelegate",
                    plane: "core",
                    instanceId: "personal",
                    deviceId: "device-personal",
                    role,
                    releaseVersion: "1.2.3",
                    status: "running",
                    headlessWorkAvailable: true,
                  }),
              };
        },
      },
      session: {
        async isOwnerLoggedIn(session) {
          assert.equal(session.platform, input.platform);
          return input.loggedIn;
        },
      },
    },
    mutations: () => mutationCount,
  };
}

function trustedRelease(onPreflight?: () => void): NativeReleaseVerifier {
  const verification = (configuration: PlatformServiceConfiguration) => ({
    verificationKind: "legacy-preview" as const,
    declaredChannel: "internal-preview" as const,
    effectiveChannel: "internal-preview" as const,
    manifestSha256: "a".repeat(64),
    publisherAttestation: {
      algorithm: "ed25519" as const,
      signature: "A".repeat(86),
    },
    publisherKeyId: `sha256:${"b".repeat(64)}`,
    productVersion: configuration.bundle.version,
    supportStatus: "internal-preview-blocked" as const,
  });
  return {
    async preflight(configuration: PlatformServiceConfiguration) {
      onPreflight?.();
      return verification(configuration);
    },
    async verifyBeforeActivation() {},
    async verifyInstalled(configuration) {
      return verification(configuration);
    },
    async verifyStaged() {},
  };
}

function prepareReleaseTrack(
  fileSystem: FakeFileSystem,
  configuration: PlatformServiceConfiguration,
  supportStatus: "internal-preview-blocked" | "release-candidate",
): void {
  const metadataPath = `${configuration.bundle.sourceDirectory}/release-metadata.json`;
  fileSystem.files.set(metadataPath, Buffer.from(JSON.stringify({ supportStatus }), "utf8"));
  fileSystem.kinds.set(metadataPath, "regular-file");
  fileSystem.kinds.set(
    `${configuration.bundle.sourceDirectory}/INTERNAL_PREVIEW.md`,
    supportStatus === "release-candidate" ? "missing" : "regular-file",
  );
  fileSystem.kinds.set(configuration.bundle.sourceDirectory, "directory");
}

function copyFakeReleaseTree(
  fileSystem: FakeFileSystem,
  source: string,
  destination: string,
  separator: "/" | "\\",
): void {
  const prefix = `${source}${separator}`;
  fileSystem.kinds.set(destination, "directory");
  for (const [path, bytes] of [...fileSystem.files]) {
    if (path.startsWith(prefix)) {
      const target = `${destination}${separator}${path.slice(prefix.length)}`;
      fileSystem.files.set(target, Buffer.from(bytes));
      fileSystem.kinds.set(target, "regular-file");
    }
  }
  for (const [path, entries] of [...fileSystem.directories]) {
    if (path === source || path.startsWith(prefix)) {
      const suffix = path === source ? "" : `${separator}${path.slice(prefix.length)}`;
      const target = `${destination}${suffix}`;
      fileSystem.directories.set(
        target,
        entries.map((entry) => ({ ...entry })),
      );
      fileSystem.kinds.set(target, "directory");
    }
  }
}

function configuredCandidateResolution(
  status:
    "absent" | "invalid" | "promotion-invalid" | "publisher-verified" | "released" | "revoked",
  overrides: {
    readonly payloadManifestSha256?: string;
    readonly target?: {
      readonly architecture: "arm64" | "x64";
      readonly platform: "darwin" | "linux" | "win32";
    };
  } = {},
) {
  const candidate = Object.freeze({
    acceptanceLedgerSha256: "1".repeat(64),
    auditedSourceCommit: "2".repeat(40),
    buildCommit: "3".repeat(40),
    buildId: "release-candidate-333333333333-linux-x64",
    candidateAttestationId: "candidate:fixture:linux-x64",
    checksumManifestSha256: "a".repeat(64),
    declaredChannel: "release-candidate" as const,
    nativeComponentsSha256: "4".repeat(64),
    payloadManifestSha256: overrides.payloadManifestSha256 ?? "5".repeat(64),
    platformAuthenticitySha256: "6".repeat(64),
    platformCertificateIdentities: Object.freeze([]),
    platformProductCertificateIdentity: null,
    productVersion: "1.2.3",
    publisherStatement: Object.freeze({
      canonicalBytes: new Uint8Array([1, 2, 3]),
      domain: "opendelegate.release.publisher-candidate.v2" as const,
      sha256: "7".repeat(64),
    }),
    releaseMetadataSha256: "8".repeat(64),
    target: Object.freeze(
      overrides.target ?? { platform: "linux" as const, architecture: "x64" as const },
    ),
  });
  const base = {
    candidate,
    declaredChannel: "release-candidate" as const,
  };
  if (status === "publisher-verified" || status === "promotion-invalid") {
    return Object.freeze({
      ...base,
      effectiveChannel: "release-candidate" as const,
      external: Object.freeze({
        archive: Object.freeze({
          path: "opendelegate-linux-x64.tar.gz",
          size: 1_024,
          sha256: "9".repeat(64),
        }),
        configurationSha256: "b".repeat(64),
        ...(status === "promotion-invalid"
          ? { diagnosticCode: "PROMOTION_TRUST_INVALID" as const }
          : {}),
        publisherAttestationSha256: "c".repeat(64),
        publisherKeyId: `sha256:${"d".repeat(64)}`,
        status,
      }),
    });
  }
  if (status === "released") {
    return Object.freeze({
      ...base,
      effectiveChannel: "released" as const,
      external: Object.freeze({
        archive: Object.freeze({
          path: "opendelegate-linux-x64.tar.gz",
          size: 1_024,
          sha256: "9".repeat(64),
        }),
        configurationSha256: "b".repeat(64),
        promotionStatementId: "promotion:fixture:release",
        publisherAttestationSha256: "c".repeat(64),
        publisherKeyId: `sha256:${"d".repeat(64)}`,
        receiptId: "receipt:fixture:release",
        status,
      }),
    });
  }
  return Object.freeze({
    ...base,
    effectiveChannel: "release-candidate" as const,
    external: Object.freeze({
      ...(status === "invalid"
        ? {
            configurationSha256: "b".repeat(64),
            diagnosticCode: "RELEASE_CONFIGURATION_INVALID" as const,
          }
        : {}),
      status,
    }),
  });
}

function prepareSignedBundle(
  fileSystem: FakeFileSystem,
  configuration: PlatformServiceConfiguration,
  options: PrepareSignedBundleOptions = {},
): {
  readonly manifestSha256: string;
  readonly publisherKeyId: string;
} {
  const source = configuration.bundle.sourceDirectory;
  const expectedEntrypoints = releaseEntrypoints(configuration.platform);
  const launcherFiles = expectedEntrypoints
    .filter((path) => !options.omittedLaunchers?.includes(path))
    .map((path, index) => ({
      path,
      bytes: options.emptyLaunchers?.includes(path)
        ? Buffer.alloc(0)
        : Buffer.from(`launcher-${String(index + 1)}`, "utf8"),
    }));
  const nativeComponentFiles = nativeComponentDefinitions(configuration.platform).map(
    (component, index) => {
      const bytes = Buffer.from(`native-component-${String(index + 1)}`, "utf8");
      return {
        ...component,
        bytes,
        sha256: `sha256:${sha256(bytes)}`,
      };
    },
  );
  const nativeComponents: MutableNativeComponentsManifest = {
    schemaVersion: 1,
    platform: releasePlatform(configuration.platform),
    architecture: "x64",
    components: nativeComponentFiles.map(({ bytes: _bytes, ...component }) => component),
  };
  options.mutateNativeComponents?.(nativeComponents);
  const nativeManifest = Buffer.from(`${JSON.stringify(nativeComponents)}\n`, "utf8");
  const metadataValue: MutableReleaseMetadata = {
    schemaVersion: 2,
    product: "OpenDelegate",
    productVersion: configuration.bundle.version,
    protocolVersion: "v1",
    buildId: `internal-preview-blocked-000000000000-${releasePlatform(configuration.platform)}-x64`,
    createdAt: "2026-07-25T00:00:00.000Z",
    timestampPolicy: "wall-clock",
    platform: releasePlatform(configuration.platform),
    architecture: "x64",
    bundledNodeVersion: "24.18.0",
    bundledRuntime: {},
    toolchain: {},
    dependencyLockSha256: "a".repeat(64),
    sourcePackageManifestSha256: "b".repeat(64),
    runtimeExternals: [],
    nativeComponents: cloneNativeComponents(nativeComponents),
    buildCommit: "c".repeat(40),
    auditedSourceCommit: "d".repeat(40),
    changedAttestationPaths: null,
    buildSourceDirty: false,
    supportStatus: "internal-preview-blocked",
    buildMode: "internal-preview",
    releaseEvidence: {},
    entrypoints: [...expectedEntrypoints],
    fileManifest: "payload-manifest.json",
    checksumManifest: "SHA256SUMS",
  };
  options.mutateMetadata?.(metadataValue);
  const metadata = Buffer.from(`${JSON.stringify(metadataValue)}\n`, "utf8");
  const previewMarker = Buffer.from("# Unsupported OpenDelegate internal preview\n", "utf8");
  const payloadEntries = [
    payloadEntry("INTERNAL_PREVIEW.md", previewMarker),
    ...launcherFiles.map((launcher) => payloadEntry(launcher.path, launcher.bytes)),
    ...nativeComponentFiles.map((component) => {
      const entry = payloadEntry(component.path, component.bytes);
      const override = options.payloadDigestOverrides?.[component.path];
      return override === undefined ? entry : { ...entry, sha256: override };
    }),
    payloadEntry("native-components.json", nativeManifest),
    payloadEntry("release-metadata.json", metadata),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const payloadManifest = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      excludedSelfReferences: ["SHA256SUMS", "payload-manifest.json"],
      fileCount: payloadEntries.length,
      totalBytes: payloadEntries.reduce((sum, entry) => sum + entry.size, 0),
      files: payloadEntries,
    })}\n`,
    "utf8",
  );
  const checksumLines = [
    ...payloadEntries.map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(payloadManifest)}  payload-manifest.json`,
  ].sort((left, right) => {
    const leftPath = left.slice(left.indexOf("  ") + 2);
    const rightPath = right.slice(right.indexOf("  ") + 2);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const checksumManifest = Buffer.from(`${checksumLines.join("\n")}\n`, "utf8");
  const manifestSha256 = sha256(checksumManifest);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const publisherKeyId = `sha256:${sha256(Buffer.from(publicKeyDer))}`;
  const signature = signPayload(
    null,
    Buffer.from(`OpenDelegate release manifest v1\n${manifestSha256}\n`, "utf8"),
    privateKey,
  ).toString("base64url");
  const attestation = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      product: "OpenDelegate",
      algorithm: "ed25519",
      keyId: publisherKeyId,
      manifestSha256,
      signature,
    })}\n`,
    "utf8",
  );
  const paths = new Map<string, Buffer>([
    ...launcherFiles.map(
      (launcher) =>
        [fixturePath(configuration.platform, source, launcher.path), launcher.bytes] as const,
    ),
    ...nativeComponentFiles.map(
      (component) =>
        [fixturePath(configuration.platform, source, component.path), component.bytes] as const,
    ),
    [fixturePath(configuration.platform, source, "native-components.json"), nativeManifest],
    [fixturePath(configuration.platform, source, "release-metadata.json"), metadata],
    [fixturePath(configuration.platform, source, "INTERNAL_PREVIEW.md"), previewMarker],
    [fixturePath(configuration.platform, source, "payload-manifest.json"), payloadManifest],
    [fixturePath(configuration.platform, source, "SHA256SUMS"), checksumManifest],
    [`${source}.publisher-attestation.json`, attestation],
    [
      fixturePath(
        configuration.platform,
        configuration.paths.stateRoot,
        "trust/publisher-ed25519.pem",
      ),
      Buffer.from(publicKey.export({ format: "pem", type: "spki" })),
    ],
  ]);
  for (const [path, bytes] of paths) {
    fileSystem.files.set(path, bytes);
    fileSystem.kinds.set(path, "regular-file");
  }
  fileSystem.kinds.set(source, "directory");
  for (const path of [
    ...launcherFiles.map((launcher) => launcher.path),
    ...nativeComponentFiles.map((component) => component.path),
    "INTERNAL_PREVIEW.md",
    "native-components.json",
    "release-metadata.json",
    "payload-manifest.json",
    "SHA256SUMS",
  ]) {
    addFixtureDirectoryEntry(fileSystem, configuration.platform, source, path);
  }
  return { manifestSha256, publisherKeyId };
}

interface PrepareSignedBundleOptions {
  readonly mutateNativeComponents?: (manifest: MutableNativeComponentsManifest) => void;
  readonly mutateMetadata?: (metadata: MutableReleaseMetadata) => void;
  readonly payloadDigestOverrides?: Readonly<Record<string, string>>;
  readonly omittedLaunchers?: readonly string[];
  readonly emptyLaunchers?: readonly string[];
}

interface MutableNativeComponentsManifest {
  schemaVersion: number;
  platform: string;
  architecture: string;
  components: {
    kind: string;
    path: string;
    sha256: string;
  }[];
}

interface MutableReleaseMetadata extends Record<string, unknown> {
  nativeComponents: MutableNativeComponentsManifest;
  entrypoints: string[];
}

function cloneNativeComponents(
  manifest: MutableNativeComponentsManifest,
): MutableNativeComponentsManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    components: manifest.components.map((component) => ({ ...component })),
  };
}

function nativeComponentDefinitions(
  platform: PlatformFamily,
): readonly { readonly kind: string; readonly path: string }[] {
  if (platform === "windows") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host.exe" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper.exe" },
      {
        kind: "computer-use-helper",
        path: "libexec/opendelegate-windows-computer-use-helper.exe",
      },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-windows-computer-use-fixture.exe",
      },
    ];
  }
  if (platform === "macos") {
    return [
      { kind: "core-service-host", path: "bin/opendelegate-service-host" },
      { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
      { kind: "computer-use-helper", path: "libexec/opendelegate-macos-computer-use" },
      {
        kind: "computer-use-fixture",
        path: "libexec/opendelegate-macos-computer-use-fixture",
      },
      {
        kind: "secret-store-helper",
        path: "runtime/native/opendelegate-keychain-helper",
      },
    ];
  }
  return [
    { kind: "core-service-host", path: "bin/opendelegate-service-host" },
    { kind: "session-helper-host", path: "bin/opendelegate-session-helper" },
    { kind: "computer-use-helper", path: "libexec/opendelegate-linux-computer-use" },
    {
      kind: "computer-use-fixture",
      path: "libexec/opendelegate-linux-computer-use-fixture",
    },
  ];
}

function releaseEntrypoints(platform: PlatformFamily): readonly string[] {
  return platform === "windows"
    ? ["opendelegate.cmd", "opendelegate-worker.cmd"]
    : ["opendelegate", "opendelegate-worker", "opendelegate.cmd", "opendelegate-worker.cmd"];
}

function releasePlatform(platform: PlatformFamily): "darwin" | "linux" | "win32" {
  return platform === "windows" ? "win32" : platform === "macos" ? "darwin" : "linux";
}

function fixturePath(platform: PlatformFamily, root: string, relativePath: string): string {
  const separator = platform === "windows" ? "\\" : "/";
  return [root, ...relativePath.split("/")].join(separator);
}

function addFixtureDirectoryEntry(
  fileSystem: FakeFileSystem,
  platform: PlatformFamily,
  root: string,
  relativePath: string,
): void {
  const segments = relativePath.split("/");
  let parent = root;
  for (const [index, segment] of segments.entries()) {
    const kind = index === segments.length - 1 ? "regular-file" : "directory";
    const entries = fileSystem.directories.get(parent) ?? [];
    if (!entries.some((entry) => entry.name === segment)) {
      fileSystem.directories.set(parent, [...entries, { name: segment, kind }]);
    }
    if (kind === "directory") {
      parent = fixturePath(platform, parent, segment);
      fileSystem.kinds.set(parent, "directory");
    }
  }
}

function payloadEntry(
  path: string,
  bytes: Buffer,
): {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
} {
  return {
    path,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderedFileBytes(encoding: "utf8" | "utf16le-bom", content: string): Buffer {
  return encoding === "utf8"
    ? Buffer.from(content, "utf8")
    : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

function processResult(exitCode: number, stdout = "", stderr = ""): NativeProcessResult {
  return {
    exitCode,
    stdout,
    stderr,
    timedOut: false,
  };
}

function isPreflightFailure(error: unknown): error is ServiceCommandExecutionError {
  return (
    error instanceof ServiceCommandExecutionError &&
    error.code === "SERVICE_COMMAND_PREFLIGHT_FAILED" &&
    error.mutationMayHaveOccurred === false
  );
}

function looksLikeRenderedFile(path: string): boolean {
  return (
    /\.(?:json|plist|service|xml)$/iu.test(path) ||
    path.includes("LaunchDaemons") ||
    path.includes("LaunchAgents")
  );
}
