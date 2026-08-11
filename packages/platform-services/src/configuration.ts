import { createHash, createPublicKey } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  PlatformServiceError,
  type PlatformFamily,
  type PlatformServiceConfiguration,
  type PlatformServiceDefinition,
} from "./types.ts";
import { parseWindowsOwnerHome } from "./windows-owner-home.ts";

const BASE_KEYS = new Set([
  "platform",
  "instanceId",
  "deviceId",
  "role",
  "bundle",
  "paths",
  "ownerSession",
  "ipcTrust",
  "helperSecretBinding",
  "secretReferences",
  "health",
  "retainPreviousVersions",
]);
const BUNDLE_KEYS = new Set(["version", "sourceDirectory", "checksum"]);
const PATH_KEYS = new Set([
  "sourceCheckoutDirectory",
  "installRoot",
  "stateRoot",
  "authorityRoot",
  "runtimeRoot",
  "logRoot",
]);
const SESSION_KEYS = new Set(["userName", "stableUserId", "uid", "homeDirectory", "adminAutoOpen"]);
const ADMIN_AUTO_OPEN_DISABLED_KEYS = new Set(["enabled"]);
const ADMIN_AUTO_OPEN_ENABLED_KEYS = new Set(["enabled", "url"]);
const SERVICE_IDENTITY_KEYS = new Set(["userName", "groupName"]);
const SYSTEMD_CREDENTIAL_KEYS = new Set(["credentialName", "encryptedSourcePath"]);
const WINDOWS_SERVICE_SECRET_BINDING_KEYS = new Set([
  "backend",
  "handoffRoot",
  "serviceName",
  "serviceSid",
  "vaultRoot",
]);
const WINDOWS_HELPER_SECRET_BINDING_KEYS = new Set(["backend", "vaultRoot"]);
const WINDOWS_AGENT_SANDBOX_KEYS = new Set(["codexSandboxBinDirectory"]);
const MACOS_HELPER_SECRET_BINDING_KEYS = new Set(["backend", "helperPath", "expectedHelperSha256"]);
const MACOS_SERVICE_SECRET_BINDING_KEYS = new Set([
  "backend",
  "bindingPath",
  "helperPath",
  "expectedHelperSha256",
  "keychainPath",
  "serviceUserName",
]);
const LINUX_HELPER_SECRET_BINDING_KEYS = new Set(["backend", "secretToolPath"]);
const HEALTH_KEYS = new Set(["endpoint", "timeoutMs"]);
const CORE_IPC_TRUST_KEYS = new Set(["protocolVersion", "core"]);
const IPC_PUBLIC_KEY_KEYS = new Set(["keyId", "publicKeySpkiBase64Url"]);
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/;
const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;
const SECRET_REFERENCE_PATTERN = /^secret:\/\/[A-Za-z0-9._~/-]+$/;
const SECRET_REFERENCE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function createPlatformServiceDefinition(
  input: PlatformServiceConfiguration,
): PlatformServiceDefinition {
  validateConfiguration(input);
  const path = pathApi(input.platform);
  const activeDirectory = path.join(input.paths.installRoot, "current");
  const releaseDirectory = path.join(input.paths.installRoot, "releases", input.bundle.version);
  const checksumSuffix = input.bundle.checksum.slice("sha256:".length, "sha256:".length + 12);
  const stagingDirectory = path.join(
    input.paths.installRoot,
    ".staging",
    `${input.bundle.version}-${checksumSuffix}`,
  );
  const executableSuffix = input.platform === "windows" ? ".exe" : "";
  return {
    configuration: input,
    activeDirectory,
    releaseDirectory,
    stagingDirectory,
    runtimeConfigurationPath: path.join(input.paths.stateRoot, "config", "service.json"),
    secretReferencesPath: path.join(input.paths.stateRoot, "config", "secret-references.json"),
    coreExecutablePath: path.join(
      activeDirectory,
      "bin",
      `opendelegate-service-host${executableSuffix}`,
    ),
    helperExecutablePath: path.join(
      activeDirectory,
      "bin",
      `opendelegate-session-helper${executableSuffix}`,
    ),
    coreStdoutLogPath: path.join(input.paths.logRoot, "core.stdout.log"),
    coreStderrLogPath: path.join(input.paths.logRoot, "core.stderr.log"),
    helperStdoutLogPath: path.join(input.paths.logRoot, "helper.stdout.log"),
    helperStderrLogPath: path.join(input.paths.logRoot, "helper.stderr.log"),
  };
}

export function parsePlatformServiceConfiguration(input: unknown): PlatformServiceConfiguration {
  createPlatformServiceDefinition(input as PlatformServiceConfiguration);
  return input as PlatformServiceConfiguration;
}

function validateConfiguration(input: PlatformServiceConfiguration): void {
  assertRecord(input, "configuration");
  const expectedKeys =
    input.platform === "windows" ? BASE_KEYS : new Set([...BASE_KEYS, "serviceIdentity"]);
  assertExactKeys(
    input,
    expectedKeys,
    input.platform === "linux"
      ? new Set(["systemdCredential"])
      : input.platform === "windows"
        ? new Set(["agentSandbox", "serviceSecretBinding"])
        : new Set(["serviceSecretBinding"]),
  );

  if (!["windows", "macos", "linux"].includes(input.platform)) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Unsupported platform.");
  }
  if (!INSTANCE_PATTERN.test(input.instanceId)) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Instance ID must be a lowercase service-safe identifier.",
    );
  }
  assertNonEmpty(input.deviceId, "Device ID");
  if (input.role !== "main" && input.role !== "worker") {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Runtime role is invalid.");
  }

  assertRecord(input.bundle, "bundle");
  assertExactKeys(input.bundle, BUNDLE_KEYS);
  if (!VERSION_PATTERN.test(input.bundle.version)) {
    throw new PlatformServiceError("INVALID_BUNDLE", "Bundle version is not release-safe.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.bundle.checksum)) {
    throw new PlatformServiceError(
      "INVALID_BUNDLE",
      "Bundle checksum must be a lowercase SHA-256 reference.",
    );
  }

  assertRecord(input.paths, "paths");
  assertExactKeys(input.paths, PATH_KEYS);
  const path = pathApi(input.platform);
  const pathEntries = Object.entries(input.paths) as Array<[keyof typeof input.paths, string]>;
  for (const [name, value] of pathEntries) {
    assertSafeAbsolutePath(input.platform, value, String(name));
  }
  assertSafeAbsolutePath(input.platform, input.bundle.sourceDirectory, "bundle.sourceDirectory");
  for (const [name, value] of [
    ["installRoot", input.paths.installRoot],
    ["stateRoot", input.paths.stateRoot],
    ["authorityRoot", input.paths.authorityRoot],
    ["runtimeRoot", input.paths.runtimeRoot],
    ["logRoot", input.paths.logRoot],
  ] as const) {
    if (
      samePath(input.platform, value, input.paths.sourceCheckoutDirectory) ||
      isDescendantPath(input.platform, input.paths.sourceCheckoutDirectory, value)
    ) {
      throw new PlatformServiceError(
        "PATH_INSIDE_CHECKOUT",
        `${name} must be outside the source checkout.`,
      );
    }
  }
  const mutableRoots = [
    ["installRoot", input.paths.installRoot],
    ["stateRoot", input.paths.stateRoot],
    ["authorityRoot", input.paths.authorityRoot],
    ["runtimeRoot", input.paths.runtimeRoot],
    ["logRoot", input.paths.logRoot],
  ] as const;
  for (let leftIndex = 0; leftIndex < mutableRoots.length; leftIndex += 1) {
    const left = mutableRoots[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < mutableRoots.length; rightIndex += 1) {
      const right = mutableRoots[rightIndex];
      if (
        right !== undefined &&
        (samePath(input.platform, left[1], right[1]) ||
          isDescendantPath(input.platform, left[1], right[1]) ||
          isDescendantPath(input.platform, right[1], left[1]))
      ) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          `${left[0]} and ${right[0]} must be disjoint service roots.`,
        );
      }
    }
    if (
      samePath(input.platform, left[1], input.bundle.sourceDirectory) ||
      isDescendantPath(input.platform, left[1], input.bundle.sourceDirectory) ||
      isDescendantPath(input.platform, input.bundle.sourceDirectory, left[1])
    ) {
      throw new PlatformServiceError(
        "INVALID_PATH",
        `bundle.sourceDirectory and ${left[0]} must not overlap.`,
      );
    }
  }
  if (path.dirname(input.paths.installRoot) === input.paths.installRoot) {
    throw new PlatformServiceError("INVALID_PATH", "Install root cannot be a volume root.");
  }

  assertRecord(input.ownerSession, "ownerSession");
  assertExactKeys(input.ownerSession, SESSION_KEYS);
  assertNonEmpty(input.ownerSession.userName, "owner session user name");
  assertNonEmpty(input.ownerSession.stableUserId, "owner session stable ID");
  validateAdminAutoOpen(input);
  if (input.platform === "windows") {
    if (!/^(?:[^\\/:*?"<>|\r\n]+\\)?[^\\/:*?"<>|\r\n]+$/.test(input.ownerSession.userName)) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Windows owner session user name is invalid.",
      );
    }
    if (!/^S-\d(?:-\d+)+$/.test(input.ownerSession.stableUserId)) {
      throw new PlatformServiceError("INVALID_IDENTITY", "Windows owner session requires a SID.");
    }
    if (input.ownerSession.uid !== undefined) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Windows owner session cannot declare a Unix UID.",
      );
    }
    if (input.ownerSession.homeDirectory !== undefined) {
      if (parseWindowsOwnerHome(input.ownerSession.homeDirectory) === undefined) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          "ownerSession.homeDirectory must be a normalized absolute non-root Windows path.",
        );
      }
    }
    assertRecord(input.helperSecretBinding, "helperSecretBinding");
    assertExactKeys(input.helperSecretBinding, WINDOWS_HELPER_SECRET_BINDING_KEYS);
    if (input.helperSecretBinding.backend !== "windows-dpapi") {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "The Windows owner helper requires its own DPAPI binding.",
      );
    }
    assertSafeAbsolutePath(
      "windows",
      input.helperSecretBinding.vaultRoot,
      "helperSecretBinding.vaultRoot",
    );
    for (const [name, root] of [
      ["source checkout", input.paths.sourceCheckoutDirectory],
      ["release bundle", input.bundle.sourceDirectory],
      ["install root", input.paths.installRoot],
      ["service state root", input.paths.stateRoot],
      ["desktop authority root", input.paths.authorityRoot],
      ["runtime root", input.paths.runtimeRoot],
      ["log root", input.paths.logRoot],
    ] as const) {
      if (
        samePath("windows", root, input.helperSecretBinding.vaultRoot) ||
        isDescendantPath("windows", root, input.helperSecretBinding.vaultRoot) ||
        isDescendantPath("windows", input.helperSecretBinding.vaultRoot, root)
      ) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          `The owner helper DPAPI vault must remain disjoint from the ${name}.`,
        );
      }
    }
    if (input.serviceSecretBinding !== undefined) {
      assertRecord(input.serviceSecretBinding, "serviceSecretBinding");
      assertExactKeys(input.serviceSecretBinding, WINDOWS_SERVICE_SECRET_BINDING_KEYS);
      if (input.serviceSecretBinding.backend !== "windows-service-dpapi") {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "The Windows service Secret backend is invalid.",
        );
      }
      const expectedServiceName = `OpenDelegate-${input.instanceId}`;
      if (input.serviceSecretBinding.serviceName !== expectedServiceName) {
        throw new PlatformServiceError(
          "INVALID_IDENTITY",
          "The Windows service Secret binding must name the configured SCM service.",
        );
      }
      if (
        !/^S-1-5-80-(?:[0-9]{1,10}-){4}[0-9]{1,10}$/u.test(input.serviceSecretBinding.serviceSid)
      ) {
        throw new PlatformServiceError(
          "INVALID_IDENTITY",
          "The Windows service Secret binding requires a virtual-service SID.",
        );
      }
      for (const [name, value] of [
        ["serviceSecretBinding.handoffRoot", input.serviceSecretBinding.handoffRoot],
        ["serviceSecretBinding.vaultRoot", input.serviceSecretBinding.vaultRoot],
      ] as const) {
        assertSafeAbsolutePath("windows", value, name);
        if (!isDescendantPath("windows", input.paths.stateRoot, value)) {
          throw new PlatformServiceError(
            "INVALID_PATH",
            `${name} must be a strict descendant of the service state root.`,
          );
        }
      }
      if (
        samePath(
          "windows",
          input.serviceSecretBinding.handoffRoot,
          input.serviceSecretBinding.vaultRoot,
        ) ||
        isDescendantPath(
          "windows",
          input.serviceSecretBinding.handoffRoot,
          input.serviceSecretBinding.vaultRoot,
        ) ||
        isDescendantPath(
          "windows",
          input.serviceSecretBinding.vaultRoot,
          input.serviceSecretBinding.handoffRoot,
        )
      ) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          "The Windows service handoff and persistent Secret vault must be disjoint.",
        );
      }
    }
    if (input.agentSandbox !== undefined) {
      assertRecord(input.agentSandbox, "agentSandbox");
      assertExactKeys(input.agentSandbox, WINDOWS_AGENT_SANDBOX_KEYS);
      const sandboxDirectory = input.agentSandbox.codexSandboxBinDirectory;
      assertSafeAbsolutePath("windows", sandboxDirectory, "agentSandbox.codexSandboxBinDirectory");
      if (win32.basename(sandboxDirectory).toLocaleLowerCase("en-US") !== ".sandbox-bin") {
        throw new PlatformServiceError(
          "INVALID_PATH",
          "The Codex sandbox helper path must name the exact .sandbox-bin directory.",
        );
      }
      if (
        samePath("windows", sandboxDirectory, input.paths.sourceCheckoutDirectory) ||
        isDescendantPath("windows", input.paths.sourceCheckoutDirectory, sandboxDirectory)
      ) {
        throw new PlatformServiceError(
          "PATH_INSIDE_CHECKOUT",
          "The Codex sandbox helper directory must remain outside the source checkout.",
        );
      }
    }
  } else {
    assertAccountName(input.ownerSession.userName, "owner session user");
    if (!Number.isSafeInteger(input.ownerSession.uid) || (input.ownerSession.uid ?? -1) < 0) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Unix owner session requires a non-negative UID.",
      );
    }
    if (input.ownerSession.stableUserId !== String(input.ownerSession.uid)) {
      throw new PlatformServiceError("INVALID_IDENTITY", "Unix stable user ID must match the UID.");
    }
    if (input.ownerSession.homeDirectory === undefined) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Unix owner session requires a home directory.",
      );
    }
    assertSafeAbsolutePath(
      input.platform,
      input.ownerSession.homeDirectory,
      "ownerSession.homeDirectory",
    );
    if (
      pathApi(input.platform).dirname(input.ownerSession.homeDirectory) ===
      input.ownerSession.homeDirectory
    ) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Owner session home directory cannot be a volume root.",
      );
    }
    assertRecord(input.serviceIdentity, "serviceIdentity");
    assertExactKeys(input.serviceIdentity, SERVICE_IDENTITY_KEYS);
    assertAccountName(input.serviceIdentity.userName, "service user");
    assertAccountName(input.serviceIdentity.groupName, "service group");
    if (input.serviceIdentity.userName === "root") {
      throw new PlatformServiceError("INVALID_IDENTITY", "The core service must not run as root.");
    }
    if (input.platform === "macos") {
      assertRecord(input.serviceSecretBinding, "serviceSecretBinding");
      assertExactKeys(input.serviceSecretBinding, MACOS_SERVICE_SECRET_BINDING_KEYS);
      if (
        input.serviceSecretBinding.backend !== "macos-system-keychain" ||
        input.serviceSecretBinding.keychainPath !== "/Library/Keychains/System.keychain" ||
        input.serviceSecretBinding.serviceUserName !== input.serviceIdentity.userName ||
        !/^sha256:[a-f0-9]{64}$/u.test(input.serviceSecretBinding.expectedHelperSha256)
      ) {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "The macOS System Keychain service binding is invalid.",
        );
      }
      assertSafeAbsolutePath(
        "macos",
        input.serviceSecretBinding.bindingPath,
        "serviceSecretBinding.bindingPath",
      );
      assertSafeAbsolutePath(
        "macos",
        input.serviceSecretBinding.helperPath,
        "serviceSecretBinding.helperPath",
      );
      if (
        !input.serviceSecretBinding.bindingPath.startsWith(
          "/Library/Application Support/OpenDelegate/",
        ) ||
        !input.serviceSecretBinding.helperPath.startsWith(
          "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-",
        ) ||
        samePath(
          "macos",
          input.paths.sourceCheckoutDirectory,
          input.serviceSecretBinding.helperPath,
        ) ||
        isDescendantPath(
          "macos",
          input.paths.sourceCheckoutDirectory,
          input.serviceSecretBinding.helperPath,
        )
      ) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          "The macOS System Keychain binding must use the root-owned OpenDelegate locations.",
        );
      }
      assertRecord(input.helperSecretBinding, "helperSecretBinding");
      assertExactKeys(input.helperSecretBinding, MACOS_HELPER_SECRET_BINDING_KEYS);
      if (
        input.helperSecretBinding.backend !== "macos-keychain" ||
        !/^sha256:[a-f0-9]{64}$/u.test(input.helperSecretBinding.expectedHelperSha256)
      ) {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "The macOS owner helper Keychain binding is invalid.",
        );
      }
      assertSafeAbsolutePath(
        "macos",
        input.helperSecretBinding.helperPath,
        "helperSecretBinding.helperPath",
      );
      if (
        !isDescendantPath("macos", input.paths.installRoot, input.helperSecretBinding.helperPath) &&
        !samePath(
          "macos",
          input.serviceSecretBinding.helperPath,
          input.helperSecretBinding.helperPath,
        )
      ) {
        throw new PlatformServiceError(
          "INVALID_PATH",
          "The pinned macOS Keychain helper must be inside the immutable installation.",
        );
      }
      if (
        samePath(
          "macos",
          input.serviceSecretBinding.helperPath,
          input.helperSecretBinding.helperPath,
        ) &&
        input.serviceSecretBinding.expectedHelperSha256 !==
          input.helperSecretBinding.expectedHelperSha256
      ) {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "The shared macOS Keychain helper must have one pinned digest.",
        );
      }
    } else if (input.helperSecretBinding !== null) {
      assertRecord(input.helperSecretBinding, "helperSecretBinding");
      assertExactKeys(input.helperSecretBinding, LINUX_HELPER_SECRET_BINDING_KEYS);
      if (input.helperSecretBinding.backend !== "linux-secret-service") {
        throw new PlatformServiceError(
          "INVALID_CONFIGURATION",
          "The Linux owner helper requires a graphical Secret Service binding.",
        );
      }
      assertSafeAbsolutePath(
        "linux",
        input.helperSecretBinding.secretToolPath,
        "helperSecretBinding.secretToolPath",
      );
    }
    if (
      input.platform === "linux" &&
      input.helperSecretBinding === null &&
      input.systemdCredential === null
    ) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "Headless Linux requires its encrypted systemd core credential mapping.",
      );
    }
    if (input.platform === "linux" && input.systemdCredential !== null) {
      assertRecord(input.systemdCredential, "systemdCredential");
      assertExactKeys(input.systemdCredential, SYSTEMD_CREDENTIAL_KEYS);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.systemdCredential.credentialName)) {
        throw new PlatformServiceError(
          "INVALID_SECRET_REFERENCE",
          "The systemd credential name is invalid.",
        );
      }
      assertSafeAbsolutePath(
        "linux",
        input.systemdCredential.encryptedSourcePath,
        "systemdCredential.encryptedSourcePath",
      );
      if (
        samePath(
          "linux",
          input.systemdCredential.encryptedSourcePath,
          input.paths.sourceCheckoutDirectory,
        ) ||
        isDescendantPath(
          "linux",
          input.paths.sourceCheckoutDirectory,
          input.systemdCredential.encryptedSourcePath,
        )
      ) {
        throw new PlatformServiceError(
          "PATH_INSIDE_CHECKOUT",
          "The encrypted systemd credential must remain outside the source checkout.",
        );
      }
      for (const [name, root] of [
        ["bundle.sourceDirectory", input.bundle.sourceDirectory],
        ["installRoot", input.paths.installRoot],
        ["stateRoot", input.paths.stateRoot],
        ["runtimeRoot", input.paths.runtimeRoot],
        ["logRoot", input.paths.logRoot],
      ] as const) {
        if (
          samePath("linux", root, input.systemdCredential.encryptedSourcePath) ||
          isDescendantPath("linux", root, input.systemdCredential.encryptedSourcePath)
        ) {
          throw new PlatformServiceError(
            "INVALID_PATH",
            `The encrypted systemd credential must remain outside ${name}.`,
          );
        }
      }
    }
  }

  assertRecord(input.ipcTrust, "ipcTrust");
  const headlessLinux = input.platform === "linux" && input.helperSecretBinding === null;
  assertExactKeys(
    input.ipcTrust,
    headlessLinux ? CORE_IPC_TRUST_KEYS : new Set([...CORE_IPC_TRUST_KEYS, "helper"]),
  );
  if (input.ipcTrust.protocolVersion !== 2) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Only the signed local IPC protocol v2 is accepted.",
    );
  }
  validateIpcPublicKey(input.ipcTrust.core, "core");
  if (!headlessLinux) {
    const helperTrust = input.ipcTrust.helper;
    if (helperTrust === undefined) {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        "The owner-session helper IPC identity is required.",
      );
    }
    validateIpcPublicKey(helperTrust, "helper");
    if (input.ipcTrust.core.keyId === helperTrust.keyId) {
      throw new PlatformServiceError(
        "INVALID_IDENTITY",
        "Core and helper must use distinct plane-local signing identities.",
      );
    }
  } else if (Object.hasOwn(input.ipcTrust, "helper")) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "A headless Linux service must not claim an owner-session helper identity.",
    );
  }

  assertRecord(input.secretReferences, "secretReferences");
  if (!Object.hasOwn(input.secretReferences, "coreIpcSigningKey")) {
    throw new PlatformServiceError(
      "INVALID_SECRET_REFERENCE",
      "The core signing-key Secret reference is required.",
    );
  }
  if (
    (!headlessLinux && !Object.hasOwn(input.secretReferences, "helperIpcSigningKey")) ||
    (headlessLinux && Object.hasOwn(input.secretReferences, "helperIpcSigningKey"))
  ) {
    throw new PlatformServiceError(
      "INVALID_SECRET_REFERENCE",
      headlessLinux
        ? "A headless Linux service must not claim an owner-session helper Secret."
        : "Distinct core and helper signing-key Secret references are required.",
    );
  }
  if (Object.hasOwn(input.secretReferences, "helperIpc")) {
    throw new PlatformServiceError(
      "INVALID_SECRET_REFERENCE",
      "The legacy shared helperIpc Secret is not accepted without an explicit migration.",
    );
  }
  for (const [name, reference] of Object.entries(input.secretReferences)) {
    if (!SECRET_REFERENCE_KEY_PATTERN.test(name) || !SECRET_REFERENCE_PATTERN.test(reference)) {
      throw new PlatformServiceError(
        "INVALID_SECRET_REFERENCE",
        "Only named opaque secret:// references are accepted.",
      );
    }
  }

  assertRecord(input.health, "health");
  assertExactKeys(input.health, HEALTH_KEYS);
  validateHealth(input.health.endpoint, input.health.timeoutMs);
  if (
    !Number.isSafeInteger(input.retainPreviousVersions) ||
    input.retainPreviousVersions < 1 ||
    input.retainPreviousVersions > 5
  ) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Previous-version retention must be between one and five.",
    );
  }
}

function validateAdminAutoOpen(input: PlatformServiceConfiguration): void {
  const configuration = input.ownerSession.adminAutoOpen;
  assertRecord(configuration, "ownerSession.adminAutoOpen");
  assertExactKeys(
    configuration,
    configuration.enabled === true ? ADMIN_AUTO_OPEN_ENABLED_KEYS : ADMIN_AUTO_OPEN_DISABLED_KEYS,
  );
  if (configuration.enabled !== true && configuration.enabled !== false) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Admin auto-open requires an explicit boolean choice.",
    );
  }
  if (!configuration.enabled) {
    return;
  }
  if (input.role !== "main") {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Admin auto-open is available only to the fixed Main owner session.",
    );
  }
  validateAdminUrl(configuration.url);
}

function validateAdminUrl(value: unknown): void {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Admin auto-open URL is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Admin auto-open URL is invalid.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    (parsed.protocol === "http:" && !loopback) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.href !== value
  ) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Admin auto-open accepts only a canonical HTTPS origin or loopback HTTP origin.",
    );
  }
}

function validateIpcPublicKey(value: unknown, plane: "core" | "helper"): void {
  assertRecord(value, `${plane} IPC public key`);
  assertExactKeys(value, IPC_PUBLIC_KEY_KEYS);
  if (
    typeof value.keyId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.keyId) ||
    typeof value.publicKeySpkiBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value.publicKeySpkiBase64Url)
  ) {
    throw new PlatformServiceError(
      "INVALID_IDENTITY",
      `The ${plane} IPC signing-key pin is invalid.`,
    );
  }
  const spki = Buffer.from(value.publicKeySpkiBase64Url, "base64url");
  try {
    if (
      spki.length === 0 ||
      spki.length > 256 ||
      spki.toString("base64url") !== value.publicKeySpkiBase64Url
    ) {
      throw new Error("encoding");
    }
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const keyId = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
    if (publicKey.asymmetricKeyType !== "ed25519" || keyId !== value.keyId) {
      throw new Error("binding");
    }
  } catch {
    throw new PlatformServiceError(
      "INVALID_IDENTITY",
      `The ${plane} IPC signing-key pin is invalid.`,
    );
  } finally {
    spki.fill(0);
  }
}

function validateHealth(endpoint: string, timeoutMs: number): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new PlatformServiceError(
      "INVALID_HEALTH_ENDPOINT",
      "Health endpoint is not a valid URL.",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new PlatformServiceError(
      "INVALID_HEALTH_ENDPOINT",
      "Service health must use an unauthenticated loopback HTTP endpoint.",
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new PlatformServiceError(
      "INVALID_HEALTH_ENDPOINT",
      "Health timeout must be between 1 and 120 seconds.",
    );
  }
}

function assertSafeAbsolutePath(platform: PlatformFamily, value: string, name: string): void {
  const path = pathApi(platform);
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\n") ||
    path.normalize(value) !== value
  ) {
    throw new PlatformServiceError(
      "INVALID_PATH",
      `${name} must be a normalized absolute ${platform} path.`,
    );
  }
}

function samePath(platform: PlatformFamily, left: string, right: string): boolean {
  if (platform === "windows") {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
  }
  return posix.normalize(left) === posix.normalize(right);
}

function isDescendantPath(platform: PlatformFamily, parent: string, candidate: string): boolean {
  const path = pathApi(platform);
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathApi(platform: PlatformFamily): typeof posix | typeof win32 {
  return platform === "windows" ? win32 : posix;
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", `${name} must be an object.`);
  }
}

function assertExactKeys(
  value: object,
  expected: ReadonlySet<string>,
  optional: ReadonlySet<string> = new Set(),
): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key) && !optional.has(key)) {
      throw new PlatformServiceError(
        "UNKNOWN_CONFIGURATION_FIELD",
        `Unknown service configuration field: ${key}.`,
      );
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key) && key !== "uid" && key !== "homeDirectory") {
      throw new PlatformServiceError(
        "INVALID_CONFIGURATION",
        `Missing service configuration field: ${key}.`,
      );
    }
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    value.includes("\n")
  ) {
    throw new PlatformServiceError("INVALID_IDENTITY", `${name} is invalid.`);
  }
}

function assertAccountName(value: string, name: string): void {
  if (!/^_?[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(value)) {
    throw new PlatformServiceError("INVALID_IDENTITY", `${name} is invalid.`);
  }
}
