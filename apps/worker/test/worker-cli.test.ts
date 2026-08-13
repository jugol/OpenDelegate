import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  EnrollmentClientError,
  EnrollmentGrantExecutorFailure,
  EnrollmentGrantFileError,
} from "@opendelegate/device-channel";
import {
  WindowsDpapiSecretStore,
  WindowsServiceDpapiSecretHandoff,
  MacOsKeychainSecretStore,
  type NativeSecretCommandRequest,
  type NativeSecretCommandResult,
  type NativeSecretCommandRunner,
} from "@opendelegate/secrets";

import { parseWorkerArguments, sanitizeMcpBridgeEnvironment } from "../src/cli.ts";
import {
  WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
  WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
  WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
  WorkerAppError,
  defaultSecretBackend,
  listWorkerWorkspaces,
  loadWorkerConfiguration,
  loadWorkerSecretBackendConfiguration,
  prepareMacOsServiceSecretBackend,
  prepareWindowsServiceSecretBackend,
  provisionHeadlessLinuxSecretBackend,
  restoreWindowsServiceSecretBackend,
  readWorkerSessionHelperOwnerKeyBinding,
  registerWorkerWorkspace,
  setWorkerWorkspaceIsolation,
  isAutomaticWorkspaceFileAuthoringWorkOrder,
  resolveWorkerAgentPermissions,
  resolveWorkerAgentSandbox,
  resolveWorkerPaths,
  type WorkerConfigurationDocument,
} from "../src/index.ts";
import {
  executeWorkerJoinPhases,
  normalizeWorkerJoinFailure,
  preserveRecredentialedWorkerConfiguration,
} from "../src/worker-app.ts";

const executeFile = promisify(execFile);
const checkout = resolve(import.meta.dirname, "../../..");

test("Worker join phase boundary never submits a Grant after local preparation fails", async () => {
  const observed: string[] = [];
  await assert.rejects(
    executeWorkerJoinPhases({
      validate: () => {
        observed.push("validate");
        return "validated";
      },
      prepare: () => {
        observed.push("prepare");
        throw new Error("local Secret Store failed");
      },
      enroll: () => {
        observed.push("enroll");
      },
      finalize: () => {
        observed.push("finalize");
      },
    }),
    (error: unknown) =>
      error instanceof EnrollmentGrantExecutorFailure && error.kind === "pre-enrollment-secret",
  );
  assert.deepEqual(observed, ["validate", "prepare"]);
});

test("Worker join separates Grant validation failures from Secret Store guidance", async () => {
  const observed: string[] = [];
  await assert.rejects(
    executeWorkerJoinPhases({
      validate: () => {
        observed.push("validate");
        throw new Error("invalid endpoint");
      },
      prepare: () => {
        observed.push("prepare");
      },
      enroll: () => {
        observed.push("enroll");
      },
      finalize: () => {
        observed.push("finalize");
      },
    }),
    (error: unknown) =>
      error instanceof EnrollmentGrantExecutorFailure && error.kind === "pre-enrollment-validation",
  );
  assert.deepEqual(observed, ["validate"]);
});

test("Worker join preserves a Grant when local identity creation fails before submission", async () => {
  const observed: string[] = [];
  await assert.rejects(
    executeWorkerJoinPhases({
      validate: () => "validated",
      prepare: () => "prepared",
      enroll: () => {
        observed.push("enroll");
        throw new EnrollmentClientError(
          "ENROLLMENT_CONFIGURATION_INVALID",
          "The local Device identity request could not be prepared.",
          { localFailureKind: "secret-store", requestDisposition: "not-submitted" },
        );
      },
      finalize: () => {
        observed.push("finalize");
      },
    }),
    (error: unknown) =>
      error instanceof EnrollmentGrantExecutorFailure && error.kind === "pre-enrollment-secret",
  );
  assert.deepEqual(observed, ["enroll"]);
});

test("Worker join phase boundary marks enrollment submission failures as uncertain", async () => {
  const observed: string[] = [];
  await assert.rejects(
    executeWorkerJoinPhases({
      validate: () => "validated",
      prepare: () => {
        observed.push("prepare");
        return "prepared";
      },
      enroll: () => {
        observed.push("enroll");
        throw new Error("response lost");
      },
      finalize: () => {
        observed.push("finalize");
      },
    }),
    (error: unknown) =>
      error instanceof EnrollmentGrantExecutorFailure &&
      error.kind === "enrollment-state-uncertain",
  );
  assert.deepEqual(observed, ["prepare", "enroll"]);
});

test("Worker join phase boundary marks local failures after accepted enrollment", async () => {
  const observed: string[] = [];
  await assert.rejects(
    executeWorkerJoinPhases({
      validate: () => "validated",
      prepare: () => {
        observed.push("prepare");
        return "prepared";
      },
      enroll: () => {
        observed.push("enroll");
        return "enrolled";
      },
      finalize: () => {
        observed.push("finalize");
        throw new Error("configuration write failed");
      },
    }),
    (error: unknown) =>
      error instanceof EnrollmentGrantExecutorFailure && error.kind === "post-enrollment",
  );
  assert.deepEqual(observed, ["prepare", "enroll", "finalize"]);
});

test("Worker re-credentialing replaces identity material without resetting local configuration", () => {
  const current = {
    schemaVersion: 1,
    deviceId: "Windows_5090",
    workerId: "worker-primary",
    mainDeviceId: "device-main-test",
    keyId: "device-key-current",
    certificateGeneration: 9,
    certificatePem: "-----BEGIN CERTIFICATE-----\ncurrent\n-----END CERTIFICATE-----",
    certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
    expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
    transportProfile: {
      deviceId: "device-main-test",
      endpoints: [
        {
          endpointId: "main-private",
          label: "Main private route",
          kind: "wss",
          url: "wss://main.example.test/api/v1/device/channel",
          credentialRef: "device-identity",
        },
      ],
    },
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: resolve("current-owner-vault"),
    },
    agent: {
      provider: "claude",
      allowUntestedVersion: false,
      claudeExecutable: resolve("claude.exe"),
      claudeHome: resolve("claude-home"),
    },
    platformMutation: { executables: { npm: resolve("npm.exe") } },
    workspaces: [
      {
        workspaceId: "workspace-open-delegate",
        alias: "OpenDelegate",
        type: "git",
        rootPath: resolve("workspace-root"),
        isolation: "agent-native-worktree",
        capabilities: ["typescript", "git"],
      },
    ],
    createdAt: "2026-07-25T00:00:00.000Z",
  } satisfies WorkerConfigurationDocument;
  const replacement = {
    schemaVersion: 1,
    deviceId: "Windows_5090",
    workerId: "worker-primary",
    mainDeviceId: "device-main-test",
    keyId: "device-key-recredentialed",
    certificateGeneration: 10,
    certificatePem: "-----BEGIN CERTIFICATE-----\nreplacement\n-----END CERTIFICATE-----",
    certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
    expectedMainSpkiSha256: `sha256:${"C".repeat(43)}`,
    transportProfile: {
      deviceId: "device-main-test",
      endpoints: [
        {
          endpointId: "main-recredentialed",
          label: "Main current route",
          kind: "wss",
          url: "wss://main-current.example.test/api/v1/device/channel",
          credentialRef: "device-identity",
        },
      ],
    },
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: resolve("replacement-owner-vault"),
    },
    agent: { provider: "auto", allowUntestedVersion: false },
    workspaces: [],
    createdAt: "2026-08-10T00:00:00.000Z",
  } satisfies WorkerConfigurationDocument;

  const preserved = preserveRecredentialedWorkerConfiguration(replacement, current);
  assert.equal(preserved.keyId, replacement.keyId);
  assert.equal(preserved.certificateGeneration, 10);
  assert.equal(preserved.expectedMainSpkiSha256, replacement.expectedMainSpkiSha256);
  assert.deepEqual(preserved.transportProfile, replacement.transportProfile);
  assert.deepEqual(preserved.secretBackend, replacement.secretBackend);
  assert.deepEqual(preserved.agent, current.agent);
  assert.deepEqual(preserved.platformMutation, current.platformMutation);
  assert.deepEqual(preserved.workspaces, current.workspaces);
  assert.equal(preserved.createdAt, current.createdAt);
  assert.throws(
    () =>
      preserveRecredentialedWorkerConfiguration(
        { ...replacement, certificateGeneration: current.certificateGeneration },
        current,
      ),
    /newer certificate generation/u,
  );
});

test("macOS Worker join gives retry guidance only for pre-enrollment failures", () => {
  const callbackError = new EnrollmentGrantFileError(
    "GRANT_EXECUTOR_FAILED",
    "Enrollment did not complete; the local Grant file was retained for operator recovery.",
    { executorFailureKind: "pre-enrollment-secret" },
  );

  const error = normalizeWorkerJoinFailure(callbackError, {
    backend: "macos-keychain",
    expectedHelperSha256: `sha256:${"a".repeat(64)}`,
    helperPath: "/Applications/OpenDelegate/opendelegate-keychain-helper",
  });

  assert.equal(error.code, "SECRET_BACKEND_UNAVAILABLE");
  assert.match(error.message, /before any request was sent to Main/u);
  assert.match(error.message, /retained Grant remains reusable/u);
  assert.match(error.message, /Terminal\.app/u);

  const validation = normalizeWorkerJoinFailure(
    new EnrollmentGrantFileError(
      "GRANT_EXECUTOR_FAILED",
      "Enrollment did not complete; the local Grant file was retained for operator recovery.",
      { executorFailureKind: "pre-enrollment-validation" },
    ),
    {
      backend: "macos-keychain",
      expectedHelperSha256: `sha256:${"a".repeat(64)}`,
      helperPath: "/Applications/OpenDelegate/opendelegate-keychain-helper",
    },
  );
  assert.equal(validation.code, "CONFIG_INVALID");
  assert.doesNotMatch(validation.message, /Keychain|Terminal\.app/u);

  const uncertain = normalizeWorkerJoinFailure(
    new EnrollmentGrantFileError(
      "GRANT_EXECUTOR_FAILED",
      "Enrollment did not complete; the local Grant file was retained for operator recovery.",
      { executorFailureKind: "enrollment-state-uncertain" },
    ),
    {
      backend: "macos-keychain",
      expectedHelperSha256: `sha256:${"a".repeat(64)}`,
      helperPath: "/Applications/OpenDelegate/opendelegate-keychain-helper",
    },
  );
  assert.equal(uncertain.code, "ENROLLMENT_FAILED");
  assert.match(uncertain.message, /Do not retry/u);
  assert.match(uncertain.message, /issue a fresh Grant/u);
});

test("unattended CLI adapters without a Policy approval bridge receive no native tools", () => {
  assert.deepEqual(
    resolveWorkerAgentPermissions({
      approvalBridge: false,
    }),
    {
      mode: "deny",
    },
  );
  assert.equal(
    resolveWorkerAgentSandbox({
      approvalBridge: false,
      provider: "codex",
    }),
    "read-only",
  );
  assert.equal(
    resolveWorkerAgentSandbox({
      approvalBridge: false,
      provider: "claude",
    }),
    "provider-default",
  );
});

test("programmatic adapters receive the exact-action bridge and a writable sandbox boundary", () => {
  const actionAuthorization = {
    authorizeAndConsume: () =>
      Promise.resolve({
        decision: "allow" as const,
        reasonCode: "POLICY_SAFE_OBSERVATION",
      }),
  };
  const permissions = resolveWorkerAgentPermissions({ approvalBridge: true }, actionAuthorization);

  assert.equal(permissions.mode, "allow-listed");
  assert.equal(permissions.actionAuthorization, actionAuthorization);
  assert.ok(permissions.allowedTools?.includes("Read"));
  assert.ok(permissions.allowedTools?.includes("Bash"));
  assert.equal(
    resolveWorkerAgentSandbox({
      approvalBridge: true,
      provider: "codex",
    }),
    "workspace-write",
  );
  assert.throws(() => resolveWorkerAgentPermissions({ approvalBridge: true }), WorkerAppError);
});

test("workspace file-authoring Runs decline unnecessary sandbox escalation locally", async () => {
  assert.equal(isAutomaticWorkspaceFileAuthoringWorkOrder(["file-authoring", "windows"]), true);
  assert.equal(
    isAutomaticWorkspaceFileAuthoringWorkOrder(["file-authoring", "artifact-upload", "windows"]),
    true,
  );
  assert.equal(
    isAutomaticWorkspaceFileAuthoringWorkOrder(["file-authoring", "code-development"]),
    false,
  );
  let forwarded = 0;
  const permissions = resolveWorkerAgentPermissions(
    { approvalBridge: true },
    {
      authorizeAndConsume: () => {
        forwarded += 1;
        return Promise.resolve({
          decision: "allow" as const,
          reasonCode: "POLICY_OWNER_APPROVED",
        });
      },
    },
    { automaticWorkspaceFileAuthoring: true },
  );

  const decision = await permissions.actionAuthorization?.authorizeAndConsume({
    authorizationRequestId: "agent-action-workspace-file",
    actionCategory: "sandbox-boundary-escalation",
    actionType: "shell",
    actionFingerprint: `sha256:${"1".repeat(64)}`,
    actionDescriptor: { provider: "codex", tool: "shell" },
    requestedAtMs: 1_000,
    signal: new AbortController().signal,
  });

  assert.deepEqual(decision, {
    decision: "deny",
    reasonCode: "POLICY_WORKSPACE_ESCALATION_UNNECESSARY",
  });
  assert.equal(forwarded, 0);
});

test("Worker CLI exposes the bounded join boundary and never accepts a raw token option", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "join",
      "--grant-file",
      "grant.json",
      "--secret-backend-config",
      "headless-secrets.json",
      "--home",
      "worker-home",
    ]),
    {
      command: "join",
      grantFile: resolve("grant.json"),
      secretBackendConfigFile: resolve("headless-secrets.json"),
      home: resolve("worker-home"),
    },
  );
  assert.throws(
    () => parseWorkerArguments(["join", "--grant-token", "raw-secret"]),
    (error: unknown) =>
      error instanceof WorkerAppError &&
      error.code === "CONFIG_INVALID" &&
      !error.message.includes("raw-secret"),
  );
  assert.throws(() => parseWorkerArguments(["run", "--grant-file", "grant.json"]), WorkerAppError);
  assert.throws(
    () => parseWorkerArguments(["run", "--secret-backend-config", "headless-secrets.json"]),
    WorkerAppError,
  );
});

test("Worker service-document takes only what the document needs and defaults its instance", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "service-document",
      "--output",
      "service.json",
      "--bundle",
      "bundle",
      "--install-root",
      "install",
      "--data-root",
      "data",
      "--health-port",
      "43190",
    ]),
    {
      command: "service-document",
      serviceDocument: {
        outputFile: resolve("service.json"),
        bundleDirectory: resolve("bundle"),
        installRoot: resolve("install"),
        dataRoot: resolve("data"),
        instanceId: "personal",
        healthPort: 43_190,
      },
    },
  );

  assert.deepEqual(
    parseWorkerArguments([
      "service-document",
      "--output",
      "service.json",
      "--bundle",
      "bundle",
      "--install-root",
      "install",
      "--data-root",
      "data",
      "--health-port",
      "43190",
      "--owner-user",
      "owner",
      "--owner-uid",
      "1000",
      "--owner-home",
      "owner-home",
      "--service-user",
      "opendelegate",
      "--service-group",
      "opendelegate",
    ]).serviceDocument,
    {
      outputFile: resolve("service.json"),
      bundleDirectory: resolve("bundle"),
      installRoot: resolve("install"),
      dataRoot: resolve("data"),
      instanceId: "personal",
      healthPort: 43_190,
      ownerSession: {
        userName: "owner",
        stableUserId: "1000",
        uid: 1000,
        homeDirectory: resolve("owner-home"),
      },
      serviceIdentity: {
        userName: "opendelegate",
        groupName: "opendelegate",
      },
    },
  );
  assert.throws(
    () =>
      parseWorkerArguments([
        "service-document",
        "--output",
        "service.json",
        "--bundle",
        "bundle",
        "--install-root",
        "install",
        "--data-root",
        "data",
        "--health-port",
        "43190",
        "--owner-user",
        "owner",
      ]),
    WorkerAppError,
  );

  // Every path the document names is required: a partial document cannot be
  // completed later, because the install reads it as authoritative.
  assert.throws(
    () => parseWorkerArguments(["service-document", "--output", "service.json"]),
    WorkerAppError,
  );
  for (const port of ["0", "70000", "not-a-port"]) {
    assert.throws(
      () =>
        parseWorkerArguments([
          "service-document",
          "--output",
          "service.json",
          "--bundle",
          "bundle",
          "--install-root",
          "install",
          "--data-root",
          "data",
          "--health-port",
          port,
        ]),
      WorkerAppError,
      `expected ${port} to be rejected`,
    );
  }
  // The options belong to one command, so another cannot silently accept them.
  assert.throws(() => parseWorkerArguments(["run", "--output", "service.json"]), WorkerAppError);
  assert.throws(() => parseWorkerArguments(["diagnose", "--health-port", "43190"]), WorkerAppError);
});

test("Worker join accepts bounded provider and Claude sandbox bootstrap settings", () => {
  const parsed = parseWorkerArguments([
    "join",
    "--grant-file",
    "grant.json",
    "--agent",
    "auto",
    "--codex-executable",
    "runtime/bin/codex.exe",
    "--codex-home",
    "runtime/codex",
    "--claude-executable",
    "runtime/bin/claude.exe",
    "--claude-home",
    "runtime/claude",
    "--claude-network-domain",
    "registry.npmjs.org",
    "--claude-network-domain",
    "*.pypi.org",
  ]);

  assert.deepEqual(parsed.agent, {
    provider: "auto",
    allowUntestedVersion: false,
    codexExecutable: resolve("runtime/bin/codex.exe"),
    codexHome: resolve("runtime/codex"),
    claudeExecutable: resolve("runtime/bin/claude.exe"),
    claudeHome: resolve("runtime/claude"),
    claudeAllowedNetworkDomains: ["registry.npmjs.org", "*.pypi.org"],
  });
  assert.throws(
    () => parseWorkerArguments(["run", "--claude-network-domain", "registry.npmjs.org"]),
    WorkerAppError,
  );
  assert.throws(
    () => parseWorkerArguments(["run", "--codex-executable", "runtime/bin/codex.exe"]),
    WorkerAppError,
  );
});

test("Worker CLI exposes the one-use platform mutation bridge only through a capability file", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "platform-mutation-mcp-bridge",
      "--capability-file",
      "platform-mutation.capability",
    ]),
    {
      command: "platform-mutation-mcp-bridge",
      capabilityFile: resolve("platform-mutation.capability"),
    },
  );
  assert.throws(() => parseWorkerArguments(["platform-mutation-mcp-bridge"]), WorkerAppError);
  assert.throws(
    () =>
      parseWorkerArguments([
        "platform-mutation-mcp-bridge",
        "--capability-file",
        "platform-mutation.capability",
        "--home",
        "worker-home",
      ]),
    WorkerAppError,
  );
});

test("Worker CLI exposes the one-use Artifact bridge only through a capability file", () => {
  assert.deepEqual(
    parseWorkerArguments(["artifact-mcp-bridge", "--capability-file", "artifact.capability"]),
    {
      command: "artifact-mcp-bridge",
      capabilityFile: resolve("artifact.capability"),
    },
  );
  assert.throws(() => parseWorkerArguments(["artifact-mcp-bridge"]), WorkerAppError);
  assert.throws(
    () =>
      parseWorkerArguments([
        "artifact-mcp-bridge",
        "--capability-file",
        "artifact.capability",
        "--home",
        "worker-home",
      ]),
    WorkerAppError,
  );
});

test("internal MCP bridge subprocesses clear their inherited environment", () => {
  const environment = {
    PATH: "C:\\trusted-tools",
    OPENDELEGATE_PRIVATE_SENTINEL: "must-not-reach-tool-server",
    HOME: "C:\\private-home",
  } as NodeJS.ProcessEnv;

  sanitizeMcpBridgeEnvironment(environment);

  assert.deepEqual(environment, {});
});

test("Worker CLI provisions a headless systemd vault without a plaintext key option", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "secret-backend-provision",
      "--secret-backend-config",
      "/etc/opendelegate/worker-secret-backend.json",
      "--encrypted-credential-file",
      "/etc/credstore.encrypted/opendelegate-vault-key.cred",
      "--vault-root",
      "/var/lib/opendelegate/secrets/systemd-vault",
      "--credential-name",
      "opendelegate-vault-key",
      "--systemd-creds",
      "/usr/bin/systemd-creds",
    ]),
    {
      command: "secret-backend-provision",
      provisioning: {
        configurationFile: resolve("/etc/opendelegate/worker-secret-backend.json"),
        encryptedCredentialFile: resolve("/etc/credstore.encrypted/opendelegate-vault-key.cred"),
        vaultRoot: resolve("/var/lib/opendelegate/secrets/systemd-vault"),
        credentialName: "opendelegate-vault-key",
        systemdCredsPath: resolve("/usr/bin/systemd-creds"),
      },
    },
  );
  assert.throws(
    () =>
      parseWorkerArguments(["secret-backend-provision", "--secret-key", "plaintext-is-forbidden"]),
    (error: unknown) =>
      error instanceof WorkerAppError &&
      error.code === "CONFIG_INVALID" &&
      !error.message.includes("plaintext-is-forbidden"),
  );
});

test("Worker CLI exposes an explicit Windows service Secret staging boundary", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "windows-service-secret-stage",
      "--home",
      "worker-home",
      "--instance-id",
      "personal",
      "--handoff-root",
      "service-handoff",
      "--vault-root",
      "service-secrets",
    ]),
    {
      command: "windows-service-secret-stage",
      home: resolve("worker-home"),
      windowsServiceProvisioning: {
        handoffRoot: resolve("service-handoff"),
        instanceId: "personal",
        vaultRoot: resolve("service-secrets"),
      },
    },
  );
  assert.throws(
    () =>
      parseWorkerArguments([
        "windows-service-secret-stage",
        "--instance-id",
        "personal",
        "--handoff-root",
        "service-handoff",
      ]),
    WorkerAppError,
  );
});

test("Worker CLI exposes an owner-session macOS System Keychain staging boundary", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "macos-service-secret-stage",
      "--home",
      "worker-home",
      "--binding-path",
      "/Library/Application Support/OpenDelegate/personal/system-keychain-binding.json",
      "--system-helper",
      "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal",
      "--service-user",
      "_opendelegate",
      "--service-group",
      "_opendelegate",
    ]),
    {
      command: "macos-service-secret-stage",
      home: resolve("worker-home"),
      macOsServiceProvisioning: {
        bindingPath: resolve(
          "/Library/Application Support/OpenDelegate/personal/system-keychain-binding.json",
        ),
        serviceGroup: "_opendelegate",
        serviceUser: "_opendelegate",
        systemHelperPath: resolve(
          "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal",
        ),
      },
    },
  );
  assert.throws(
    () =>
      parseWorkerArguments([
        "macos-service-secret-stage",
        "--binding-path",
        "/Library/Application Support/OpenDelegate/personal/system-keychain-binding.json",
        "--system-helper",
        "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-personal",
      ]),
    WorkerAppError,
  );
});

class WindowsWorkerSecretFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  readonly #protected = new Map<string, Buffer>();
  readonly #handoffProtected = new Map<string, Buffer>();
  #protectionSequence = 0;
  #handoffSequence = 0;
  readonly #serviceSid: string;

  public constructor(serviceSid: string) {
    this.#serviceSid = serviceSid;
  }

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    if (request.args[0] === "showsid") {
      return { exitCode: 0, stdout: Buffer.from(`SERVICE SID: ${this.#serviceSid}`) };
    }
    const script = request.args.at(-1) ?? "";
    if (script.includes("OpenDelegate Windows service DPAPI-NG protect v1")) {
      // stdin is [sidLength][sid][binding(32)][material].
      const stdin = Buffer.from(request.stdin);
      const sidLength = stdin.readUInt16LE(0);
      const material = Buffer.from(stdin.subarray(2 + sidLength + 32));
      const sealed = Buffer.from(`service-handoff-ciphertext-${++this.#handoffSequence}`, "utf8");
      this.#handoffProtected.set(sealed.toString("hex"), material);
      // Leading byte names the descriptor: 1 seals to the service SID.
      return { exitCode: 0, stdout: Buffer.concat([Buffer.from([1]), sealed]) };
    }
    if (script.includes("OpenDelegate Windows service DPAPI-NG unprotect v1")) {
      const sealed = Buffer.from(request.stdin).subarray(32);
      const material = this.#handoffProtected.get(sealed.toString("hex"));
      return material === undefined
        ? { exitCode: 43, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.from(material) };
    }
    if (script.includes("DirectorySecurity")) {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (script.includes("OpenDelegate DPAPI probe")) {
      return { exitCode: 0, stdout: Buffer.from("ready") };
    }
    if (script.includes("ProtectedData]::Protect")) {
      const material = Buffer.from(request.stdin.subarray(32));
      const protectedValue = Buffer.from(
        `owner-dpapi-ciphertext-${++this.#protectionSequence}`,
        "utf8",
      );
      this.#protected.set(protectedValue.toString("hex"), material);
      return { exitCode: 0, stdout: protectedValue };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      const protectedValue = request.stdin.subarray(32);
      const material = this.#protected.get(Buffer.from(protectedValue).toString("hex"));
      return material === undefined
        ? { exitCode: 71, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.from(material) };
    }
    return { exitCode: 70, stdout: Buffer.alloc(0) };
  }
}

class MacOsWorkerSecretFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  readonly #loginValues = new Map<string, Buffer>();
  readonly #systemValues = new Map<string, Buffer>();

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    if (request.executable.endsWith("codesign")) {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    const wrapped = request.args[0] === "--";
    const operation = request.args[wrapped ? 2 : 0];
    if (operation === "prepare-system-binding") {
      const sourceHelper = request.args[1];
      const bindingPath = request.args[request.args.indexOf("--binding") + 1];
      const targetHelper = request.args[request.args.indexOf("--trusted-helper") + 1];
      if (sourceHelper === undefined || bindingPath === undefined || targetHelper === undefined) {
        return { exitCode: 64, stdout: Buffer.alloc(0) };
      }
      await mkdir(join(targetHelper, ".."), { recursive: true });
      await mkdir(join(bindingPath, ".."), { recursive: true });
      await copyFile(sourceHelper, targetHelper);
      await chmod(targetHelper, 0o755);
      await writeFile(bindingPath, "{}\n", { encoding: "utf8", mode: 0o644 });
      return { exitCode: 0, stdout: Buffer.from("ready") };
    }
    const values = request.args.includes("--system-binding")
      ? this.#systemValues
      : this.#loginValues;
    const accountIndex = request.args.indexOf("--account");
    const alias = accountIndex < 0 ? "" : (request.args[accountIndex + 1] ?? "");
    if (operation === "status") {
      return { exitCode: 0, stdout: Buffer.from("ready") };
    }
    if (operation === "has") {
      return values.has(alias)
        ? { exitCode: 0, stdout: Buffer.from("ready") }
        : { exitCode: 11, stdout: Buffer.alloc(0) };
    }
    if (operation === "create") {
      if (values.has(alias)) {
        return { exitCode: 10, stdout: Buffer.alloc(0) };
      }
      values.set(alias, Buffer.from(request.stdin));
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (operation === "read") {
      const value = values.get(alias);
      return value === undefined
        ? { exitCode: 11, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.from(value) };
    }
    if (operation === "delete") {
      return values.delete(alias)
        ? { exitCode: 0, stdout: Buffer.alloc(0) }
        : { exitCode: 11, stdout: Buffer.alloc(0) };
    }
    return { exitCode: 70, stdout: Buffer.alloc(0) };
  }
}

test(
  "macOS Worker staging separates boot and login Keychain identities idempotently",
  { skip: process.platform !== "darwin" },
  async () => {
    const fixtureRoot = await realpath(
      await mkdtemp(join(tmpdir(), "opendelegate-worker-macos-service-secret-")),
    );
    const bundleRoot = join(fixtureRoot, "bundle");
    const packagedHelperPath = join(
      bundleRoot,
      "runtime",
      "native",
      "opendelegate-keychain-helper",
    );
    const legacyHelperPath = join(fixtureRoot, "legacy", "opendelegate-keychain-helper");
    const systemHelperPath = join(
      fixtureRoot,
      "privileged",
      "opendelegate-keychain-helper-personal",
    );
    const bindingPath = join(fixtureRoot, "system", "system-keychain-binding.json");
    const paths = resolveWorkerPaths({
      sourceCheckoutRoot: bundleRoot,
      home: join(fixtureRoot, "state", "worker"),
    });
    const helperBytes = Buffer.from("signed-macos-keychain-helper", "utf8");
    const helperDigest = `sha256:${createHash("sha256").update(helperBytes).digest("hex")}`;
    const keyId = "device-key_0123456789012345678901";
    const runner = new MacOsWorkerSecretFixtureRunner();

    try {
      await mkdir(join(packagedHelperPath, ".."), { recursive: true });
      await mkdir(join(legacyHelperPath, ".."), { recursive: true });
      await writeFile(packagedHelperPath, helperBytes, { mode: 0o755 });
      await writeFile(legacyHelperPath, helperBytes, { mode: 0o755 });
      await mkdir(paths.configDirectory, { recursive: true });
      await writeFile(
        paths.configFile,
        `${JSON.stringify({
          schemaVersion: 1,
          deviceId: "device-worker-macos-service",
          workerId: "worker-macos",
          mainDeviceId: "device-main-test",
          keyId,
          certificateGeneration: 1,
          certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
          certificateAuthorityPem:
            "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
          expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
          transportProfile: {
            deviceId: "device-main-test",
            endpoints: [
              {
                endpointId: "main-private",
                label: "Main private route",
                kind: "wss",
                url: "wss://main.example.test/api/v1/device/channel",
                credentialRef: "device-identity",
              },
            ],
          },
          secretBackend: {
            backend: "macos-keychain",
            helperPath: legacyHelperPath,
            expectedHelperSha256: helperDigest,
          },
          agent: { provider: "auto", allowUntestedVersion: false },
          workspaces: [],
          createdAt: "2026-08-11T00:00:00.000Z",
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const sourceStore = new MacOsKeychainSecretStore({
        codesignPath: "/usr/bin/codesign",
        deviceId: "device-worker-macos-service",
        expectedHelperSha256: helperDigest,
        helperPath: legacyHelperPath,
        hostPlatform: "darwin",
        runner,
      });
      await sourceStore.store(`identity-p256.${keyId}`, Buffer.from("device-private-key"));
      await sourceStore.store(WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS, Buffer.alloc(32, 0xa5));
      const { privateKey: corePrivateKey } = generateKeyPairSync("ed25519");
      const coreMaterial = Buffer.from(corePrivateKey.export({ format: "der", type: "pkcs8" }));
      try {
        await sourceStore.store(WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS, coreMaterial);
      } finally {
        coreMaterial.fill(0);
      }

      const input = {
        bindingPath,
        hostPlatform: "darwin" as const,
        paths,
        runner,
        serviceGroup: "_opendelegate",
        serviceUser: "_opendelegate",
        sudoPath: "/usr/bin/sudo",
        systemHelperPath,
      };
      const first = await prepareMacOsServiceSecretBackend(input);
      const firstHelperKey = first.backend.servicePreparation.ipcTrust.helper.keyId;
      const replay = await prepareMacOsServiceSecretBackend(input);
      assert.deepEqual(replay.backend, first.backend);
      assert.equal(replay.backend.servicePreparation.ipcTrust.helper.keyId, firstHelperKey);
      assert.equal(first.backend.backend, "macos-system-keychain");
      assert.equal(first.backend.bindingPath, bindingPath);
      assert.equal(first.backend.helperPath, systemHelperPath);
      for (const alias of [
        `identity-p256.${keyId}`,
        WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
        WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
      ]) {
        assert.equal((await sourceStore.availability(alias)).ready, false);
      }
      const persisted = await readFile(paths.configFile, "utf8");
      assert.equal(persisted.includes("device-private-key"), false);
      assert.equal(
        JSON.stringify(
          runner.requests.map(({ args, environment }) => ({ args, environment })),
        ).includes("device-private-key"),
        false,
      );
    } finally {
      helperBytes.fill(0);
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  },
);

test("Windows Worker staging moves the enrolled identity to a service-only handoff idempotently", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "opendelegate-worker-service-secret-"));
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: checkout,
    home: join(fixtureRoot, "worker"),
  });
  const ownerVaultRoot = join(paths.home, "secrets", "dpapi");
  const localAppData = join(fixtureRoot, "local-app-data");
  const ownerHelperVaultRoot = join(
    localAppData,
    "OpenDelegate",
    "owner-session",
    "personal",
    "secrets",
    "dpapi",
  );
  const handoffRoot = join(fixtureRoot, "service-handoff");
  const serviceVaultRoot = join(fixtureRoot, "service-secrets");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const keyId = "device-key_0123456789012345678901";
  const secret = Buffer.from("worker-service-private-key", "utf8");
  const runner = new WindowsWorkerSecretFixtureRunner(serviceSid);
  const powershellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  try {
    await mkdir(paths.configDirectory, { recursive: true });
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        schemaVersion: 1,
        deviceId: "device-worker-service",
        workerId: "worker-primary",
        mainDeviceId: "device-main-test",
        keyId,
        certificateGeneration: 1,
        certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
        certificateAuthorityPem:
          "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
        expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
        transportProfile: {
          deviceId: "device-main-test",
          endpoints: [
            {
              endpointId: "main-private",
              label: "Main private route",
              kind: "wss",
              url: "wss://main.example.test/api/v1/device/channel",
              credentialRef: "device-identity",
            },
          ],
        },
        secretBackend: {
          backend: "windows-dpapi",
          vaultRoot: ownerVaultRoot,
        },
        agent: {
          provider: "auto",
          allowUntestedVersion: false,
        },
        workspaces: [],
        createdAt: "2026-07-25T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const ownerStore = new WindowsDpapiSecretStore({
      deviceId: "device-worker-service",
      hostPlatform: "win32",
      powershellPath,
      runner,
      sourceCheckoutRoot: checkout,
      vaultRoot: ownerVaultRoot,
    });
    const alias = `identity-p256.${keyId}`;
    await ownerStore.store(alias, secret);
    await ownerStore.store(WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS, Buffer.alloc(32, 0xa5));
    const { privateKey: coreSigningPrivateKey } = generateKeyPairSync("ed25519");
    const coreSigningMaterial = Buffer.from(
      coreSigningPrivateKey.export({ format: "der", type: "pkcs8" }),
    );
    try {
      await ownerStore.store(WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS, coreSigningMaterial);
    } finally {
      coreSigningMaterial.fill(0);
    }

    const input = {
      environment: { LOCALAPPDATA: localAppData },
      handoffRoot,
      hostPlatform: "win32" as const,
      instanceId: "personal",
      paths,
      powershellPath,
      runner,
      scPath: "C:\\Windows\\System32\\sc.exe",
      vaultRoot: serviceVaultRoot,
    };
    const first = await prepareWindowsServiceSecretBackend(input);
    const helperStore = new WindowsDpapiSecretStore({
      deviceId: "device-worker-service",
      hostPlatform: "win32",
      powershellPath,
      runner,
      sourceCheckoutRoot: checkout,
      vaultRoot: ownerHelperVaultRoot,
    });
    // Recreate the durable shape emitted by older builds: the helper key and
    // its public binding still point inside DATA_ROOT/state. An exact replay of
    // staging must migrate that same identity before service-document runs.
    await helperStore.executeWithSecretBytes(
      WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
      async (value) => {
        await ownerStore.store(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS, value);
      },
    );
    await helperStore.delete(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS);
    const legacyConfiguration = JSON.parse(await readFile(paths.configFile, "utf8")) as {
      secretBackend: {
        servicePreparation: { ownerHelperSecretBinding: { vaultRoot: string } };
      };
    };
    legacyConfiguration.secretBackend.servicePreparation.ownerHelperSecretBinding.vaultRoot =
      ownerVaultRoot;
    await writeFile(paths.configFile, `${JSON.stringify(legacyConfiguration)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const migratedReplay = await prepareWindowsServiceSecretBackend(input);
    assert.deepEqual(migratedReplay.backend, first.backend);
    assert.equal(
      (await ownerStore.availability(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS)).ready,
      false,
    );
    assert.equal(
      (await helperStore.availability(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS)).ready,
      true,
    );
    // Simulate a crash after the durable service binding was written but before
    // the owner-vault duplicates were deleted. Replay must finish that cleanup
    // without reopening the service-account-sealed handoff for public-key data.
    await helperStore.store(alias, secret);
    await helperStore.store(WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS, Buffer.alloc(32, 0xa5));
    await helperStore.store(
      WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
      Buffer.alloc(48, 0x5a),
    );
    const replay = await prepareWindowsServiceSecretBackend(input);
    const exactReplay = await prepareWindowsServiceSecretBackend(input);
    // The durable backend is idempotent across every repetition.
    assert.deepEqual(replay.backend, first.backend);
    assert.deepEqual(exactReplay.backend, first.backend);
    assert.equal(first.backend.backend, "windows-service-dpapi");
    assert.equal(first.backend.handoffRoot, handoffRoot);
    assert.equal(first.backend.serviceName, "OpenDelegate-personal");
    assert.equal(first.backend.serviceSid, serviceSid);
    assert.equal(first.backend.vaultRoot, serviceVaultRoot);
    assert.equal(
      first.backend.servicePreparation?.ownerHelperSecretBinding.vaultRoot,
      ownerHelperVaultRoot,
    );
    assert.equal(first.backend.servicePreparation?.sealing, "service-account");
    assert.match(
      first.backend.servicePreparation?.ipcTrust.core.keyId ?? "",
      /^sha256:[0-9a-f]{64}$/u,
    );
    assert.match(
      first.backend.servicePreparation?.ipcTrust.helper.keyId ?? "",
      /^sha256:[0-9a-f]{64}$/u,
    );
    // Sealing is a durable non-secret observation, so interrupted replay cannot
    // lose a weaker machine-sealing warning.
    assert.equal(first.sealing, "service-account");
    assert.equal(replay.sealing, "service-account");
    assert.equal(exactReplay.sealing, "service-account");
    assert.equal((await ownerStore.availability(alias)).ready, false);
    assert.equal((await helperStore.availability(alias)).ready, false);
    const handoff = new WindowsServiceDpapiSecretHandoff({
      deviceId: "device-worker-service",
      handoffRoot,
      hostPlatform: "win32",
      powershellPath,
      runner,
      serviceSid,
      sourceCheckoutRoot: checkout,
    });
    assert.equal((await handoff.availability(alias)).ready, true);
    for (const coreAlias of [
      WORKER_DESKTOP_AUTHORITY_SECRET_ALIAS,
      WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
    ]) {
      assert.equal((await helperStore.availability(coreAlias)).ready, false);
      assert.equal((await handoff.availability(coreAlias)).ready, true);
    }
    assert.equal(
      (await ownerStore.availability(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS)).ready,
      false,
    );
    assert.equal(
      (await helperStore.availability(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS)).ready,
      true,
    );
    assert.equal(
      (await handoff.availability(WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS)).ready,
      false,
    );
    const ownerBinding = await readWorkerSessionHelperOwnerKeyBinding(helperStore);
    assert.equal(ownerBinding.alias, WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS);
    assert.match(ownerBinding.keyId, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(ownerBinding.publicKeySpkiBase64Url.length > 0);
    // A partial handoff cannot rebind the Worker to foreground operation.
    await handoff.delete(alias);
    await assert.rejects(
      restoreWindowsServiceSecretBackend({
        hostPlatform: "win32",
        paths,
        powershellPath,
        runner,
        vaultRoot: ownerHelperVaultRoot,
      }),
      (error: unknown) =>
        error instanceof WorkerAppError && error.code === "SECRET_BACKEND_UNAVAILABLE",
    );
    assert.equal(
      (await loadWorkerConfiguration(paths)).secretBackend.backend,
      "windows-service-dpapi",
    );
    await handoff.stage(alias, secret);
    // Core Secrets must return to the vault that retained the owner-session key;
    // accepting another vault would produce an incomplete foreground Worker.
    await assert.rejects(
      restoreWindowsServiceSecretBackend({
        hostPlatform: "win32",
        paths,
        powershellPath,
        runner,
        vaultRoot: join(fixtureRoot, "different-owner-vault"),
      }),
      (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_INVALID",
    );
    // This fixture makes the handoff owner-restorable, so an owner who cannot
    // finish service installation is not left with an unrunnable Device.
    const restored = await restoreWindowsServiceSecretBackend({
      hostPlatform: "win32",
      paths,
      powershellPath,
      runner,
      vaultRoot: ownerHelperVaultRoot,
    });
    assert.equal(restored.backend.backend, "windows-dpapi");
    assert.equal(restored.backend.vaultRoot, ownerHelperVaultRoot);
    assert.equal(restored.restoredAliases, 3);
    assert.equal((await helperStore.availability(alias)).ready, true);
    assert.equal((await loadWorkerConfiguration(paths)).secretBackend.backend, "windows-dpapi");
    // A Worker that was never staged is refused rather than silently rebound.
    await assert.rejects(
      restoreWindowsServiceSecretBackend({
        hostPlatform: "win32",
        paths,
        powershellPath,
        runner,
        vaultRoot: ownerHelperVaultRoot,
      }),
      (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_INVALID",
    );
    // Put the staged binding back so the remaining assertions still apply.
    await prepareWindowsServiceSecretBackend(input);

    const persisted = await readFile(paths.configFile, "utf8");
    assert.equal(persisted.includes(secret.toString("utf8")), false);
    assert.equal(
      JSON.stringify(
        runner.requests.map(({ args, environment }) => ({ args, environment })),
      ).includes(secret.toString("utf8")),
      false,
    );

    await handoff.delete(alias);
    const unavailableConfiguration = JSON.parse(await readFile(paths.configFile, "utf8")) as Record<
      string,
      unknown
    >;
    unavailableConfiguration["secretBackend"] = {
      backend: "windows-dpapi",
      vaultRoot: ownerVaultRoot,
    };
    await writeFile(paths.configFile, `${JSON.stringify(unavailableConfiguration)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await assert.rejects(
      prepareWindowsServiceSecretBackend(input),
      (error: unknown) =>
        error instanceof WorkerAppError && error.code === "SECRET_BACKEND_UNAVAILABLE",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("headless Linux provisioning encrypts a generated key over stdin and persists only metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-headless-secret-"));
  const configurationFile = join(home, "config", "worker-secret-backend.json");
  const encryptedCredentialFile = join(home, "credentials", "worker-vault.cred");
  const vaultRoot = join(home, "vault");
  let command:
    | {
        readonly args: readonly string[];
        readonly environment: Readonly<Record<string, string>>;
        readonly executable: string;
        readonly stdin: Uint8Array;
      }
    | undefined;
  let commandCount = 0;
  try {
    const result = await provisionHeadlessLinuxSecretBackend({
      configurationFile,
      encryptedCredentialFile,
      vaultRoot,
      credentialName: "opendelegate-vault-key",
      systemdCredsPath: "/usr/bin/systemd-creds",
      sourceCheckoutRoot: checkout,
      hostPlatform: "linux",
      randomKey: () => Buffer.alloc(32, 0xab),
      runner: {
        async run(request) {
          commandCount += 1;
          command = request;
          return {
            exitCode: 0,
            stdout: Buffer.from("encrypted-systemd-credential", "utf8"),
          };
        },
      },
    });
    assert.deepEqual(result, {
      backend: "linux-systemd-credential-vault",
      credentialName: "opendelegate-vault-key",
      encryptedCredentialFile,
      vaultRoot,
    });
    const persistedLinuxResult = {
      ...result,
      encryptedCredentialFile: posixTestPath(encryptedCredentialFile),
      vaultRoot: posixTestPath(vaultRoot),
    };
    if (process.platform === "win32") {
      await writeFile(configurationFile, `${JSON.stringify(persistedLinuxResult, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
    }
    assert.deepEqual(command?.args, ["encrypt", "--name=opendelegate-vault-key", "-", "-"]);
    assert.equal(command?.executable, resolve("/usr/bin/systemd-creds"));
    assert.deepEqual(command?.environment, {});
    assert.equal(command?.stdin.byteLength, 32);
    assert.equal(
      command?.stdin.every((byte) => byte === 0),
      true,
    );
    assert.equal(
      (await readFile(encryptedCredentialFile)).equals(
        Buffer.from("encrypted-systemd-credential", "utf8"),
      ),
      true,
    );
    assert.deepEqual(
      await loadWorkerSecretBackendConfiguration(configurationFile, checkout),
      persistedLinuxResult,
    );
    const persisted = Buffer.concat([
      await readFile(configurationFile),
      await readFile(encryptedCredentialFile),
    ]);
    assert.equal(persisted.indexOf(Buffer.alloc(32, 0xab)), -1);
    await assert.rejects(
      provisionHeadlessLinuxSecretBackend({
        configurationFile,
        encryptedCredentialFile,
        vaultRoot,
        sourceCheckoutRoot: checkout,
        hostPlatform: "linux",
        randomKey: () => Buffer.alloc(32, 0xcd),
        runner: {
          async run() {
            commandCount += 1;
            return { exitCode: 0, stdout: Buffer.from("replacement") };
          },
        },
      }),
      (error: unknown) =>
        error instanceof WorkerAppError &&
        error.code === "CONFIG_PATH_UNSAFE" &&
        error.message.includes("never overwrites"),
    );
    assert.equal(commandCount, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function posixTestPath(value: string): string {
  return process.platform === "win32"
    ? value.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/")
    : value;
}

test("Worker CLI registers and lists explicit Device-local Workspaces without an opaque patch", () => {
  assert.deepEqual(
    parseWorkerArguments([
      "workspace-register",
      "--workspace-id",
      "workspace-open-delegate",
      "--alias",
      "OpenDelegate",
      "--type",
      "git",
      "--path",
      "workspace-root",
      "--isolation",
      "agent-native-worktree",
      "--capability",
      "typescript",
      "--capability",
      "git",
      "--home",
      "worker-home",
    ]),
    {
      command: "workspace-register",
      home: resolve("worker-home"),
      workspace: {
        workspaceId: "workspace-open-delegate",
        alias: "OpenDelegate",
        type: "git",
        rootPath: resolve("workspace-root"),
        isolation: "agent-native-worktree",
        capabilities: ["typescript", "git"],
      },
    },
  );
  assert.deepEqual(parseWorkerArguments(["workspace-list", "--home", "worker-home"]), {
    command: "workspace-list",
    home: resolve("worker-home"),
  });
  assert.deepEqual(
    parseWorkerArguments([
      "workspace-set-isolation",
      "--workspace-id",
      "workspace-open-delegate",
      "--isolation",
      "opendelegate-worktree",
      "--home",
      "worker-home",
    ]),
    {
      command: "workspace-set-isolation",
      home: resolve("worker-home"),
      workspaceIsolationUpdate: {
        workspaceId: "workspace-open-delegate",
        isolation: "opendelegate-worktree",
      },
    },
  );
  assert.throws(
    () =>
      parseWorkerArguments([
        "workspace-register",
        "--workspace-id",
        "workspace-open-delegate",
        "--alias",
        "OpenDelegate",
        "--type",
        "git",
        "--path",
        "workspace-root",
      ]),
    WorkerAppError,
  );
  assert.throws(
    () => parseWorkerArguments(["workspace-list", "--capability", "typescript"]),
    WorkerAppError,
  );
});

test("Worker paths and Auto backend keep persistent state outside the checkout", async () => {
  const home = join(tmpdir(), "opendelegate-worker-path-test");
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: checkout,
    home,
  });
  assert.equal(paths.home, home);
  assert.equal(paths.configFile.startsWith(checkout), false);
  assert.equal(paths.managedWorktreeStateFile, join(home, "state", "managed-worktrees.sqlite3"));
  assert.equal(paths.managedWorktreeDirectory, join(home, "state", "worktrees"));
  assert.deepEqual(
    await defaultSecretBackend({
      paths,
      installationRoot: checkout,
      hostPlatform: "win32",
      environment: {},
    }),
    {
      backend: "windows-dpapi",
      vaultRoot: join(home, "secrets", "dpapi"),
    },
  );
  assert.deepEqual(
    await defaultSecretBackend({
      paths,
      installationRoot: checkout,
      hostPlatform: "linux",
      environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    }),
    {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
  );
});

test("Worker configuration accepts only known platform mutation tools at absolute paths", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "opendelegate-worker-mutations-"));
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: checkout,
    home: join(fixtureRoot, "runtime"),
  });
  const configuration = {
    schemaVersion: 1,
    deviceId: "device-worker-test",
    workerId: "worker-primary",
    mainDeviceId: "device-main-test",
    keyId: "device-key-test",
    certificateGeneration: 1,
    certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
    certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
    expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
    transportProfile: {
      deviceId: "device-main-test",
      endpoints: [
        {
          endpointId: "main-private",
          label: "Main private route",
          kind: "wss",
          url: "wss://main.example.test/api/v1/device/channel",
          credentialRef: "device-identity",
        },
      ],
    },
    secretBackend: {
      backend: "windows-dpapi",
      vaultRoot: join(fixtureRoot, "runtime", "secrets"),
    },
    agent: {
      provider: "auto",
      allowUntestedVersion: false,
    },
    platformMutation: {
      executables: {
        npm: process.execPath,
      },
    },
    workspaces: [],
    createdAt: "2026-07-25T00:00:00.000Z",
  };
  try {
    await mkdir(paths.configDirectory, { recursive: true });
    await writeFile(paths.configFile, `${JSON.stringify(configuration)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    assert.deepEqual((await loadWorkerConfiguration(paths)).platformMutation, {
      executables: { npm: process.execPath },
    });

    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        ...configuration,
        platformMutation: { executables: { arbitraryShell: process.execPath } },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await assert.rejects(loadWorkerConfiguration(paths), WorkerAppError);

    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        ...configuration,
        platformMutation: { executables: { npm: "npm" } },
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await assert.rejects(loadWorkerConfiguration(paths), WorkerAppError);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Worker configuration distinguishes a missing file from an unreadable or unsafe path", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "opendelegate-worker-config-read-"));
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: checkout,
    home: join(fixtureRoot, "runtime"),
  });
  try {
    await assert.rejects(
      loadWorkerConfiguration(paths),
      (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_MISSING",
    );

    await mkdir(paths.configFile, { recursive: true });
    await assert.rejects(
      loadWorkerConfiguration(paths),
      (error: unknown) => error instanceof WorkerAppError && error.code === "CONFIG_PATH_UNSAFE",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Workspace registration is durable, idempotent, and lists no Device-local path", async () => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-worker-workspaces-"));
  const workspaceRoot = join(home, "registered-project");
  const paths = resolveWorkerPaths({
    sourceCheckoutRoot: checkout,
    home: join(home, "runtime"),
  });
  try {
    await Promise.all([
      mkdir(paths.configDirectory, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeFile(
      paths.configFile,
      `${JSON.stringify({
        schemaVersion: 1,
        deviceId: "device-worker-test",
        workerId: "worker-primary",
        mainDeviceId: "device-main-test",
        keyId: "device-key-test",
        certificateGeneration: 1,
        certificatePem: "-----BEGIN CERTIFICATE-----\nworker\n-----END CERTIFICATE-----",
        certificateAuthorityPem:
          "-----BEGIN CERTIFICATE-----\nauthority\n-----END CERTIFICATE-----",
        expectedMainSpkiSha256: `sha256:${"A".repeat(43)}`,
        transportProfile: {
          deviceId: "device-main-test",
          endpoints: [
            {
              endpointId: "main-private",
              label: "Main private route",
              kind: "wss",
              url: "wss://main.example.test/api/v1/device/channel",
              credentialRef: "device-identity",
            },
          ],
        },
        secretBackend: {
          backend: "windows-dpapi",
          vaultRoot: join(home, "runtime", "secrets"),
        },
        agent: {
          provider: "auto",
          allowUntestedVersion: false,
        },
        workspaces: [],
        createdAt: "2026-07-25T00:00:00.000Z",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const input = {
      paths,
      workspace: {
        workspaceId: "workspace-open-delegate",
        alias: "OpenDelegate",
        type: "git" as const,
        rootPath: workspaceRoot,
        isolation: "agent-native-worktree" as const,
        capabilities: ["typescript", "git"],
      },
    };
    const first = await registerWorkerWorkspace(input);
    const replay = await registerWorkerWorkspace(input);
    assert.deepEqual(replay, first);
    assert.deepEqual(await listWorkerWorkspaces(paths), [
      {
        workspaceId: "workspace-open-delegate",
        alias: "OpenDelegate",
        type: "git",
        isolation: "agent-native-worktree",
        capabilities: ["git", "typescript"],
        state: "active",
        revision: 1,
      },
    ]);
    const isolated = await setWorkerWorkspaceIsolation({
      paths,
      workspaceId: "workspace-open-delegate",
      isolation: "opendelegate-worktree",
    });
    assert.equal(isolated.isolation, "opendelegate-worktree");
    assert.equal(isolated.revision, 2);
    assert.deepEqual(await listWorkerWorkspaces(paths), [
      {
        workspaceId: "workspace-open-delegate",
        alias: "OpenDelegate",
        type: "git",
        isolation: "opendelegate-worktree",
        capabilities: ["git", "typescript"],
        state: "active",
        revision: 2,
      },
    ]);
    assert.equal(JSON.stringify(await listWorkerWorkspaces(paths)).includes(workspaceRoot), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("source Worker CLI help, version, and unenrolled status are executable", async () => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-worker-cli-"));
  try {
    const cli = resolve(import.meta.dirname, "../src/cli.ts");
    const help = await executeFile(process.execPath, ["--experimental-strip-types", cli, "help"], {
      cwd: checkout,
    });
    assert.match(help.stdout, /opendelegate worker join --grant-file/iu);
    const version = await executeFile(
      process.execPath,
      ["--experimental-strip-types", cli, "version"],
      { cwd: checkout },
    );
    const packageDocument = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as {
      readonly version: string;
    };
    assert.equal(version.stdout.trim(), `OpenDelegate Worker ${packageDocument.version}`);
    const status = await executeFile(
      process.execPath,
      ["--experimental-strip-types", cli, "status"],
      {
        cwd: checkout,
        env: { ...process.env, OPENDELEGATE_WORKER_HOME: home },
      },
    );
    assert.deepEqual(JSON.parse(status.stdout), { enrolled: false, home });
    await assert.rejects(
      executeFile(process.execPath, ["--experimental-strip-types", cli, "status"], {
        cwd: checkout,
        env: { ...process.env, OPENDELEGATE_WORKER_HOME: "relative-worker-home" },
      }),
      (error: unknown) => {
        const stderr = (error as { stderr?: unknown }).stderr;
        return (
          typeof stderr === "string" &&
          stderr.includes("CONFIG_INVALID") &&
          stderr.includes("must be an absolute path")
        );
      },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
