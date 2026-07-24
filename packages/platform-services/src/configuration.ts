import { posix, win32 } from "node:path";

import {
  PlatformServiceError,
  type PlatformFamily,
  type PlatformServiceConfiguration,
  type PlatformServiceDefinition,
} from "./types.ts";

const BASE_KEYS = new Set([
  "platform",
  "instanceId",
  "role",
  "bundle",
  "paths",
  "ownerSession",
  "secretReferences",
  "health",
  "retainPreviousVersions",
]);
const BUNDLE_KEYS = new Set(["version", "sourceDirectory", "checksum"]);
const PATH_KEYS = new Set([
  "sourceCheckoutDirectory",
  "installRoot",
  "stateRoot",
  "runtimeRoot",
  "logRoot",
]);
const SESSION_KEYS = new Set(["userName", "stableUserId", "uid", "homeDirectory"]);
const SERVICE_IDENTITY_KEYS = new Set(["userName", "groupName"]);
const HEALTH_KEYS = new Set(["endpoint", "timeoutMs"]);
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/;
const INSTANCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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

function validateConfiguration(input: PlatformServiceConfiguration): void {
  assertRecord(input, "configuration");
  const expectedKeys =
    input.platform === "windows" ? BASE_KEYS : new Set([...BASE_KEYS, "serviceIdentity"]);
  assertExactKeys(input, expectedKeys);

  if (!["windows", "macos", "linux"].includes(input.platform)) {
    throw new PlatformServiceError("INVALID_CONFIGURATION", "Unsupported platform.");
  }
  if (!INSTANCE_PATTERN.test(input.instanceId)) {
    throw new PlatformServiceError(
      "INVALID_CONFIGURATION",
      "Instance ID must be a lowercase service-safe slug.",
    );
  }
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
    ["runtimeRoot", input.paths.runtimeRoot],
    ["logRoot", input.paths.logRoot],
    ["bundle.sourceDirectory", input.bundle.sourceDirectory],
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
  if (path.dirname(input.paths.installRoot) === input.paths.installRoot) {
    throw new PlatformServiceError("INVALID_PATH", "Install root cannot be a volume root.");
  }

  assertRecord(input.ownerSession, "ownerSession");
  assertExactKeys(input.ownerSession, SESSION_KEYS);
  assertNonEmpty(input.ownerSession.userName, "owner session user name");
  assertNonEmpty(input.ownerSession.stableUserId, "owner session stable ID");
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
  }

  assertRecord(input.secretReferences, "secretReferences");
  if (!Object.hasOwn(input.secretReferences, "helperIpc")) {
    throw new PlatformServiceError(
      "INVALID_SECRET_REFERENCE",
      "An authenticated helper IPC Secret reference is required.",
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

function assertExactKeys(value: object, expected: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
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
