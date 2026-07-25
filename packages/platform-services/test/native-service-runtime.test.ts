import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import test from "node:test";

import {
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
  public readonly links = new Map<string, string>();
  public readonly removed: string[] = [];
  public readonly directories = new Map<string, NativeDirectoryEntry[]>();
  public readonly reads: string[] = [];

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
        ? { size: this.files.get(path)?.length ?? 0, modifiedAtMs: 1 }
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
    this.links.delete(path);
    this.removed.push(path);
    return before.kind === "missing" ? "unchanged" : "changed";
  }

  public async setPosixOwnershipAndMode(
    _path: string,
    _uid: number,
    _gid: number,
    _mode: number,
  ): Promise<void> {}

  public async sameVolume(_left: string, _right: string): Promise<boolean> {
    return true;
  }
}

class FakeProcess {
  public readonly requests: NativeProcessRequest[] = [];
  public unavailable = new Set<string>();
  public handler: (request: NativeProcessRequest) => NativeProcessResult = () => processResult(0);

  public async isExecutable(path: string): Promise<boolean> {
    return !this.unavailable.has(path);
  }

  public async run(request: NativeProcessRequest): Promise<NativeProcessResult> {
    this.requests.push(request);
    return this.handler(request);
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
    return processResult(0);
  };
  const fileSystem = new FakeFileSystem();
  const releasesRoot = "C:\\Program Files\\OpenDelegate\\releases";
  const stagingRoot = "C:\\Program Files\\OpenDelegate\\.staging";
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

  assert.equal(result.report.outcome, "succeeded", JSON.stringify(result.report));
  assert.equal(fileSystem.kinds.get(releasesRoot), "directory");
  assert.equal(fileSystem.kinds.get(stagingRoot), "directory");
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
  assert.deepEqual(serviceVerbs, ["stop", "start", "stop", "start"]);
});

test("native inspection keeps core health, helper presence, and Computer Use readiness separate", async () => {
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
  return {
    async preflight(configuration: PlatformServiceConfiguration) {
      onPreflight?.();
      return {
        manifestSha256: "a".repeat(64),
        publisherKeyId: `sha256:${"b".repeat(64)}`,
        productVersion: configuration.bundle.version,
        supportStatus: "internal-preview-blocked",
      };
    },
    async verifyStaged() {},
  };
}

function prepareSignedBundle(
  fileSystem: FakeFileSystem,
  configuration: PlatformServiceConfiguration,
): {
  readonly manifestSha256: string;
  readonly publisherKeyId: string;
} {
  const source = configuration.bundle.sourceDirectory;
  const serviceHost = Buffer.from("service-host", "utf8");
  const sessionHelper = Buffer.from("session-helper", "utf8");
  const metadata = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 2,
      product: "OpenDelegate",
      productVersion: configuration.bundle.version,
      protocolVersion: "v1",
      buildId: "internal-preview-blocked-000000000000-linux-x64",
      createdAt: "2026-07-25T00:00:00.000Z",
      timestampPolicy: "wall-clock",
      platform: "linux",
      architecture: "x64",
      bundledNodeVersion: "24.18.0",
      bundledRuntime: {},
      toolchain: {},
      dependencyLockSha256: "a".repeat(64),
      sourcePackageManifestSha256: "b".repeat(64),
      runtimeExternals: [],
      buildCommit: "c".repeat(40),
      auditedSourceCommit: "d".repeat(40),
      changedAttestationPaths: null,
      buildSourceDirty: false,
      supportStatus: "internal-preview-blocked",
      buildMode: "internal-preview",
      releaseEvidence: {},
      entrypoints: ["opendelegate"],
      fileManifest: "payload-manifest.json",
      checksumManifest: "SHA256SUMS",
    })}\n`,
    "utf8",
  );
  const payloadEntries = [
    payloadEntry("bin/opendelegate-service-host", serviceHost),
    payloadEntry("bin/opendelegate-session-helper", sessionHelper),
    payloadEntry("release-metadata.json", metadata),
  ];
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
    [`${source}/bin/opendelegate-service-host`, serviceHost],
    [`${source}/bin/opendelegate-session-helper`, sessionHelper],
    [`${source}/release-metadata.json`, metadata],
    [`${source}/payload-manifest.json`, payloadManifest],
    [`${source}/SHA256SUMS`, checksumManifest],
    [`${source}.publisher-attestation.json`, attestation],
    [
      `${configuration.paths.stateRoot}/trust/publisher-ed25519.pem`,
      Buffer.from(publicKey.export({ format: "pem", type: "spki" })),
    ],
  ]);
  for (const [path, bytes] of paths) {
    fileSystem.files.set(path, bytes);
    fileSystem.kinds.set(path, "regular-file");
  }
  fileSystem.kinds.set(source, "directory");
  fileSystem.kinds.set(`${source}/bin`, "directory");
  fileSystem.directories.set(source, [
    { name: "SHA256SUMS", kind: "regular-file" },
    { name: "bin", kind: "directory" },
    { name: "payload-manifest.json", kind: "regular-file" },
    { name: "release-metadata.json", kind: "regular-file" },
  ]);
  fileSystem.directories.set(`${source}/bin`, [
    { name: "opendelegate-service-host", kind: "regular-file" },
    { name: "opendelegate-session-helper", kind: "regular-file" },
  ]);
  return { manifestSha256, publisherKeyId };
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
