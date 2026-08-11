import { createHash, createPublicKey } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parseWindowsOwnerHome } from "@opendelegate/platform-services";

const MAX_CONFIG_BYTES = 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SECRET_REFERENCE_PATTERN = /^secret:\/\/[A-Za-z0-9._~/-]+$/u;

export type ServiceHostPlane = "core" | "session-helper";
export type ServiceHostRole = "main" | "worker";

export interface ServiceHostArguments {
  readonly plane: ServiceHostPlane;
  readonly role: ServiceHostRole;
  readonly configPath: string;
}

export interface ServiceHostConfiguration {
  readonly schemaVersion: 3;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly platform: "linux" | "macos" | "windows";
  readonly role: ServiceHostRole;
  readonly releaseVersion: string;
  readonly releaseRoot: string;
  readonly stateRoot: string;
  readonly authorityRoot: string;
  readonly runtimeRoot: string;
  readonly ownerSession: {
    readonly userName: string;
    readonly stableUserId: string;
    readonly uid?: number;
    readonly homeDirectory?: string;
    readonly adminAutoOpen:
      | {
          readonly enabled: false;
        }
      | {
          readonly enabled: true;
          readonly url: string;
        };
  };
  readonly helperSecretBinding:
    | {
        readonly backend: "windows-dpapi";
        readonly vaultRoot: string;
      }
    | {
        readonly backend: "macos-keychain";
        readonly helperPath: string;
        readonly expectedHelperSha256: `sha256:${string}`;
      }
    | {
        readonly backend: "linux-secret-service";
        readonly secretToolPath: string;
      }
    | null;
  readonly logs: {
    readonly core: { readonly stdout: string; readonly stderr: string };
    readonly sessionHelper: { readonly stdout: string; readonly stderr: string };
  };
  readonly localIpc:
    | {
        readonly kind: "unix-domain-socket";
        readonly endpoint: string;
        readonly authentication: "ed25519-mutual-signature-v2";
        readonly sessionHelper: "disabled";
        readonly credentialReferenceDocument: string;
        readonly core: ServiceHostCoreIpcPlaneBinding;
        readonly allowedPeers: readonly string[];
        readonly socketMode?: "0660";
      }
    | {
        readonly kind: "named-pipe" | "unix-domain-socket";
        readonly endpoint: string;
        readonly authentication: "ed25519-mutual-signature-v2";
        readonly sessionHelper: "enabled";
        readonly credentialReferenceDocument: string;
        readonly core: ServiceHostIpcPlaneBinding;
        readonly helper: ServiceHostIpcPlaneBinding;
        readonly allowedPeers: readonly string[];
        readonly socketMode?: "0660";
      };
  readonly health: {
    readonly endpoint: string;
    readonly timeoutMs: number;
  };
  readonly serviceSecretBinding?:
    | {
        readonly backend: "macos-system-keychain";
        readonly bindingPath: string;
        readonly helperPath: string;
        readonly expectedHelperSha256: `sha256:${string}`;
        readonly keychainPath: "/Library/Keychains/System.keychain";
        readonly serviceUserName: string;
      }
    | Readonly<Record<string, unknown>>;
}

export interface ServiceHostIpcPlaneBinding {
  readonly peerKeyId: `sha256:${string}`;
  readonly peerPublicKeySpkiBase64Url: string;
  readonly peerIdentity: string;
  readonly privateKeyReference: string;
  readonly privateKeyReferenceKey: "coreIpcSigningKey" | "helperIpcSigningKey";
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}

export interface ServiceHostCoreIpcPlaneBinding {
  readonly privateKeyReference: string;
  readonly privateKeyReferenceKey: "coreIpcSigningKey";
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}

export class ServiceHostError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServiceHostError";
  }
}

export function parseServiceHostArguments(values: readonly string[]): ServiceHostArguments {
  if (values.length !== 6) {
    throw new ServiceHostError("The native service-host argument contract is invalid.");
  }
  const entries = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !["--plane", "--role", "--config"].includes(key) ||
      entries.has(key)
    ) {
      throw new ServiceHostError("The native service-host argument contract is invalid.");
    }
    entries.set(key, value);
  }
  const plane = entries.get("--plane");
  const role = entries.get("--role");
  const configPath = entries.get("--config");
  if (
    (plane !== "core" && plane !== "session-helper") ||
    (role !== "main" && role !== "worker") ||
    configPath === undefined ||
    !isAbsolute(configPath) ||
    configPath.includes("\0")
  ) {
    throw new ServiceHostError("The native service-host argument contract is invalid.");
  }
  return Object.freeze({ plane, role, configPath: resolve(configPath) });
}

export async function loadServiceHostConfiguration(
  path: string,
): Promise<ServiceHostConfiguration> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ServiceHostError("The service configuration path is unsafe.");
  }
  let handle;
  try {
    const canonical = await realpath(path);
    if (!samePath(canonical, resolve(path))) {
      throw new Error("linked");
    }
    handle = await open(path, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CONFIG_BYTES) {
      throw new Error("invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      bytes.fill(0);
      throw new Error("unstable");
    }
    try {
      return parseServiceHostConfiguration(JSON.parse(bytes.toString("utf8")));
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof ServiceHostError) {
      throw error;
    }
    throw new ServiceHostError("The service configuration is missing, unsafe, or invalid.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function parseServiceHostConfiguration(input: unknown): ServiceHostConfiguration {
  const record = requireRecord(input, "service configuration");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "instanceId",
      "deviceId",
      "platform",
      "role",
      "releaseVersion",
      "releaseRoot",
      "stateRoot",
      "authorityRoot",
      "runtimeRoot",
      "ownerSession",
      "helperSecretBinding",
      "logs",
      "localIpc",
      "health",
    ],
    ["serviceSecretBinding"],
    "service configuration",
  );
  if (
    record["schemaVersion"] !== 3 ||
    !isIdentifier(record["instanceId"]) ||
    !isIdentifier(record["deviceId"]) ||
    !["windows", "macos", "linux"].includes(String(record["platform"])) ||
    !["main", "worker"].includes(String(record["role"])) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(String(record["releaseVersion"]))
  ) {
    throw new ServiceHostError("The service configuration identity is invalid.");
  }
  const platform = record["platform"] as ServiceHostConfiguration["platform"];
  const pathFields = ["releaseRoot", "stateRoot", "authorityRoot", "runtimeRoot"] as const;
  for (const field of pathFields) {
    requirePlatformPath(platform, record[field], field);
  }
  const roots = pathFields.map((field) => record[field] as string);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (pathsOverlap(platform, roots[left]!, roots[right]!)) {
        throw new ServiceHostError("The service configuration roots must be disjoint.");
      }
    }
  }
  const ownerSession = parseOwnerSession(record["ownerSession"], platform);
  if (record["role"] !== "main" && ownerSession.adminAutoOpen.enabled) {
    throw new ServiceHostError(
      "Admin auto-open is available only to the fixed Main owner session.",
    );
  }
  const logs = parseLogs(record["logs"], platform);
  const serviceSecretBinding = parseServiceSecretBinding(record["serviceSecretBinding"], platform);
  const sharedMacOsHelper =
    platform === "macos" && serviceSecretBinding?.backend === "macos-system-keychain"
      ? (serviceSecretBinding as {
          readonly backend: "macos-system-keychain";
          readonly helperPath: string;
          readonly expectedHelperSha256: `sha256:${string}`;
        })
      : undefined;
  const helperSecretBinding = parseHelperSecretBinding(record["helperSecretBinding"], platform, {
    releaseRoot: record["releaseRoot"] as string,
    disjointRoots: [
      record["releaseRoot"] as string,
      record["stateRoot"] as string,
      record["authorityRoot"] as string,
      record["runtimeRoot"] as string,
      logs.core.stdout,
      logs.core.stderr,
      logs.sessionHelper.stdout,
      logs.sessionHelper.stderr,
    ],
    ...(sharedMacOsHelper === undefined ? {} : { sharedMacOsHelper }),
  });
  const localIpc = parseLocalIpc(record["localIpc"], platform, helperSecretBinding !== null);
  const health = parseHealth(record["health"]);
  return deepFreeze({
    schemaVersion: 3 as const,
    instanceId: record["instanceId"] as string,
    deviceId: record["deviceId"] as string,
    platform,
    role: record["role"] as ServiceHostRole,
    releaseVersion: record["releaseVersion"] as string,
    releaseRoot: record["releaseRoot"] as string,
    stateRoot: record["stateRoot"] as string,
    authorityRoot: record["authorityRoot"] as string,
    runtimeRoot: record["runtimeRoot"] as string,
    ownerSession,
    helperSecretBinding,
    logs,
    localIpc,
    health,
    ...(serviceSecretBinding === undefined ? {} : { serviceSecretBinding }),
  });
}

function parseServiceSecretBinding(
  input: unknown,
  platform: ServiceHostConfiguration["platform"],
): ServiceHostConfiguration["serviceSecretBinding"] {
  if (input === undefined) {
    if (platform === "macos") {
      throw new ServiceHostError("The macOS core System Keychain binding is required.");
    }
    return undefined;
  }
  const record = requireRecord(input, "Secret binding");
  if (platform !== "macos") {
    if (platform === "linux") {
      throw new ServiceHostError("Linux does not accept a service Secret binding document.");
    }
    return Object.freeze({ ...record });
  }
  requireExactKeys(
    record,
    [
      "backend",
      "bindingPath",
      "helperPath",
      "expectedHelperSha256",
      "keychainPath",
      "serviceUserName",
    ],
    [],
    "macOS System Keychain binding",
  );
  requirePlatformPath("macos", record["bindingPath"], "System Keychain binding document");
  requirePlatformPath("macos", record["helperPath"], "System Keychain helper");
  if (
    record["backend"] !== "macos-system-keychain" ||
    record["keychainPath"] !== "/Library/Keychains/System.keychain" ||
    typeof record["expectedHelperSha256"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record["expectedHelperSha256"]) ||
    typeof record["serviceUserName"] !== "string" ||
    !/^_?[A-Za-z][A-Za-z0-9_-]{0,30}$/u.test(record["serviceUserName"]) ||
    !(record["bindingPath"] as string).startsWith("/Library/Application Support/OpenDelegate/") ||
    !(record["helperPath"] as string).startsWith(
      "/Library/PrivilegedHelperTools/opendelegate-keychain-helper-",
    )
  ) {
    throw new ServiceHostError("The macOS System Keychain binding is invalid.");
  }
  return Object.freeze({
    backend: "macos-system-keychain" as const,
    bindingPath: record["bindingPath"] as string,
    helperPath: record["helperPath"] as string,
    expectedHelperSha256: record["expectedHelperSha256"] as `sha256:${string}`,
    keychainPath: "/Library/Keychains/System.keychain" as const,
    serviceUserName: record["serviceUserName"] as string,
  });
}

function parseHelperSecretBinding(
  input: unknown,
  platform: ServiceHostConfiguration["platform"],
  roots: {
    readonly releaseRoot: string;
    readonly disjointRoots: readonly string[];
    readonly sharedMacOsHelper?: {
      readonly helperPath: string;
      readonly expectedHelperSha256: `sha256:${string}`;
    };
  },
): ServiceHostConfiguration["helperSecretBinding"] {
  if (input === null) {
    if (platform !== "linux") {
      throw new ServiceHostError("Only Linux may explicitly disable the session helper.");
    }
    return null;
  }
  const record = requireRecord(input, "owner helper Secret binding");
  if (platform === "windows") {
    requireExactKeys(record, ["backend", "vaultRoot"], [], "owner helper Secret binding");
    requirePlatformPath(platform, record["vaultRoot"], "owner helper DPAPI vault");
    if (
      record["backend"] !== "windows-dpapi" ||
      roots.disjointRoots.some((root) =>
        pathsOverlap(platform, root, record["vaultRoot"] as string),
      )
    ) {
      throw new ServiceHostError("The Windows owner helper Secret binding is invalid.");
    }
    return {
      backend: "windows-dpapi",
      vaultRoot: record["vaultRoot"] as string,
    };
  }
  if (platform === "macos") {
    requireExactKeys(
      record,
      ["backend", "helperPath", "expectedHelperSha256"],
      [],
      "owner helper Secret binding",
    );
    requirePlatformPath(platform, record["helperPath"], "pinned Keychain helper");
    const helperPath = record["helperPath"] as string;
    const expectedHelperSha256 = record["expectedHelperSha256"];
    const sharedSystemHelper =
      roots.sharedMacOsHelper !== undefined &&
      samePath(roots.sharedMacOsHelper.helperPath, helperPath) &&
      roots.sharedMacOsHelper.expectedHelperSha256 === expectedHelperSha256;
    if (
      record["backend"] !== "macos-keychain" ||
      typeof expectedHelperSha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(expectedHelperSha256) ||
      (!isDescendantPath(platform, roots.releaseRoot, helperPath) && !sharedSystemHelper)
    ) {
      throw new ServiceHostError("The macOS owner helper Secret binding is invalid.");
    }
    return {
      backend: "macos-keychain",
      helperPath,
      expectedHelperSha256: expectedHelperSha256 as `sha256:${string}`,
    };
  }
  requireExactKeys(record, ["backend", "secretToolPath"], [], "owner helper Secret binding");
  requirePlatformPath(platform, record["secretToolPath"], "Secret Service tool");
  if (record["backend"] !== "linux-secret-service") {
    throw new ServiceHostError("The Linux owner helper Secret binding is invalid.");
  }
  return {
    backend: "linux-secret-service",
    secretToolPath: record["secretToolPath"] as string,
  };
}

function parseOwnerSession(
  input: unknown,
  platform: ServiceHostConfiguration["platform"],
): ServiceHostConfiguration["ownerSession"] {
  const record = requireRecord(input, "owner session");
  requireExactKeys(
    record,
    ["userName", "stableUserId", "adminAutoOpen"],
    ["uid", "homeDirectory"],
    "owner session",
  );
  if (!isText(record["userName"], 256) || !isIdentifier(record["stableUserId"])) {
    throw new ServiceHostError("The owner session identity is invalid.");
  }
  if (platform !== "windows") {
    if (
      !Number.isSafeInteger(record["uid"]) ||
      typeof record["uid"] !== "number" ||
      record["uid"] < 0 ||
      record["stableUserId"] !== String(record["uid"])
    ) {
      throw new ServiceHostError("The Unix owner session identity is invalid.");
    }
    requirePlatformPath(platform, record["homeDirectory"], "owner home");
  } else {
    if (record["uid"] !== undefined) {
      throw new ServiceHostError("The Windows owner session identity is invalid.");
    }
    if (record["homeDirectory"] !== undefined) {
      if (parseWindowsOwnerHome(record["homeDirectory"]) === undefined) {
        throw new ServiceHostError("The Windows owner session identity is invalid.");
      }
    }
  }
  const adminAutoOpen = parseAdminAutoOpen(record["adminAutoOpen"]);
  return {
    userName: record["userName"],
    stableUserId: record["stableUserId"],
    adminAutoOpen,
    ...(record["uid"] === undefined ? {} : { uid: record["uid"] as number }),
    ...(record["homeDirectory"] === undefined
      ? {}
      : { homeDirectory: record["homeDirectory"] as string }),
  };
}

function parseAdminAutoOpen(
  input: unknown,
): ServiceHostConfiguration["ownerSession"]["adminAutoOpen"] {
  const record = requireRecord(input, "Admin auto-open");
  if (record["enabled"] === false) {
    requireExactKeys(record, ["enabled"], [], "Admin auto-open");
    return { enabled: false };
  }
  requireExactKeys(record, ["enabled", "url"], [], "Admin auto-open");
  if (record["enabled"] !== true) {
    throw new ServiceHostError("The Admin auto-open choice is invalid.");
  }
  return {
    enabled: true,
    url: parseAdminUrl(record["url"]),
  };
}

function parseAdminUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ServiceHostError("The Admin auto-open URL is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServiceHostError("The Admin auto-open URL is invalid.");
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
    throw new ServiceHostError(
      "Admin auto-open accepts only a canonical HTTPS origin or loopback HTTP origin.",
    );
  }
  return parsed.href;
}

function parseLogs(
  input: unknown,
  platform: ServiceHostConfiguration["platform"],
): ServiceHostConfiguration["logs"] {
  const record = requireRecord(input, "service logs");
  requireExactKeys(record, ["core", "sessionHelper"], [], "service logs");
  const parsePlane = (value: unknown) => {
    const plane = requireRecord(value, "service log plane");
    requireExactKeys(plane, ["stdout", "stderr"], [], "service log plane");
    requirePlatformPath(platform, plane["stdout"], "stdout log");
    requirePlatformPath(platform, plane["stderr"], "stderr log");
    return { stdout: plane["stdout"] as string, stderr: plane["stderr"] as string };
  };
  return { core: parsePlane(record["core"]), sessionHelper: parsePlane(record["sessionHelper"]) };
}

function parseLocalIpc(
  input: unknown,
  platform: ServiceHostConfiguration["platform"],
  helperEnabled: boolean,
): ServiceHostConfiguration["localIpc"] {
  const record = requireRecord(input, "local IPC");
  const sessionHelper = record["sessionHelper"] ?? "enabled";
  requireExactKeys(
    record,
    sessionHelper === "disabled"
      ? [
          "kind",
          "endpoint",
          "authentication",
          "sessionHelper",
          "credentialReferenceDocument",
          "core",
          "allowedPeers",
        ]
      : [
          "kind",
          "endpoint",
          "authentication",
          "credentialReferenceDocument",
          "core",
          "helper",
          "allowedPeers",
        ],
    sessionHelper === "disabled" ? ["socketMode"] : ["socketMode", "sessionHelper"],
    "local IPC",
  );
  const expectedKind = platform === "windows" ? "named-pipe" : "unix-domain-socket";
  if (
    record["kind"] !== expectedKind ||
    record["authentication"] !== "ed25519-mutual-signature-v2" ||
    (sessionHelper !== "enabled" && sessionHelper !== "disabled") ||
    helperEnabled !== (sessionHelper === "enabled") ||
    (sessionHelper === "disabled" && platform !== "linux") ||
    !Array.isArray(record["allowedPeers"]) ||
    record["allowedPeers"].length === 0 ||
    record["allowedPeers"].some((value) => !isText(value, 256))
  ) {
    throw new ServiceHostError("The local IPC configuration is invalid.");
  }
  requirePlatformPath(platform, record["credentialReferenceDocument"], "Secret reference document");
  if (sessionHelper === "disabled") {
    if ((record["allowedPeers"] as string[]).length !== 1) {
      throw new ServiceHostError("The headless local IPC configuration is invalid.");
    }
    const core = parseCoreIpcPlane(record["core"]);
    requireUnixIpcEndpoint(record, platform);
    return {
      kind: "unix-domain-socket",
      endpoint: record["endpoint"] as string,
      authentication: "ed25519-mutual-signature-v2",
      sessionHelper: "disabled",
      credentialReferenceDocument: record["credentialReferenceDocument"] as string,
      core,
      allowedPeers: Object.freeze([...(record["allowedPeers"] as string[])]),
      ...(record["socketMode"] === undefined ? {} : { socketMode: "0660" as const }),
    };
  }
  const core = parseIpcPlane(record["core"], "core", record["allowedPeers"]);
  const helper = parseIpcPlane(record["helper"], "helper", record["allowedPeers"]);
  if (
    core.privateKeyReference === helper.privateKeyReference ||
    core.keyId === helper.keyId ||
    core.peerKeyId !== helper.keyId ||
    helper.peerKeyId !== core.keyId ||
    core.peerPublicKeySpkiBase64Url !== helper.publicKeySpkiBase64Url ||
    helper.peerPublicKeySpkiBase64Url !== core.publicKeySpkiBase64Url
  ) {
    throw new ServiceHostError("The local IPC plane trust binding is invalid.");
  }
  if (platform === "windows") {
    if (
      typeof record["endpoint"] !== "string" ||
      !/^\\\\\.\\pipe\\OpenDelegate\\[A-Za-z0-9._-]+\\session-helper$/u.test(record["endpoint"]) ||
      record["socketMode"] !== undefined
    ) {
      throw new ServiceHostError("The local IPC endpoint is invalid.");
    }
  } else {
    requirePlatformPath(platform, record["endpoint"], "IPC endpoint");
    if (record["socketMode"] !== undefined && record["socketMode"] !== "0660") {
      throw new ServiceHostError("The local IPC endpoint is invalid.");
    }
  }
  return {
    kind: expectedKind,
    endpoint: record["endpoint"] as string,
    authentication: "ed25519-mutual-signature-v2",
    sessionHelper: "enabled",
    credentialReferenceDocument: record["credentialReferenceDocument"] as string,
    core,
    helper,
    allowedPeers: Object.freeze([...(record["allowedPeers"] as string[])]),
    ...(record["socketMode"] === undefined ? {} : { socketMode: "0660" as const }),
  };
}

function parseCoreIpcPlane(input: unknown): ServiceHostCoreIpcPlaneBinding {
  const record = requireRecord(input, "core IPC plane");
  requireExactKeys(
    record,
    ["privateKeyReference", "privateKeyReferenceKey", "keyId", "publicKeySpkiBase64Url"],
    [],
    "core IPC plane",
  );
  if (
    typeof record["privateKeyReference"] !== "string" ||
    !SECRET_REFERENCE_PATTERN.test(record["privateKeyReference"]) ||
    record["privateKeyReferenceKey"] !== "coreIpcSigningKey"
  ) {
    throw new ServiceHostError("The core IPC plane identity is invalid.");
  }
  validateEd25519Pin(record["keyId"], record["publicKeySpkiBase64Url"], "core IPC signing key");
  return {
    privateKeyReference: record["privateKeyReference"],
    privateKeyReferenceKey: "coreIpcSigningKey",
    keyId: record["keyId"] as `sha256:${string}`,
    publicKeySpkiBase64Url: record["publicKeySpkiBase64Url"] as string,
  };
}

function requireUnixIpcEndpoint(
  record: Record<string, unknown>,
  platform: ServiceHostConfiguration["platform"],
): void {
  if (platform === "windows") {
    throw new ServiceHostError("The headless local IPC endpoint is invalid.");
  }
  requirePlatformPath(platform, record["endpoint"], "IPC endpoint");
  if (record["socketMode"] !== undefined && record["socketMode"] !== "0660") {
    throw new ServiceHostError("The local IPC endpoint is invalid.");
  }
}

function parseIpcPlane(
  input: unknown,
  plane: "core" | "helper",
  allowedPeers: unknown,
): ServiceHostIpcPlaneBinding {
  const record = requireRecord(input, `${plane} IPC plane`);
  requireExactKeys(
    record,
    [
      "privateKeyReference",
      "privateKeyReferenceKey",
      "keyId",
      "publicKeySpkiBase64Url",
      "peerKeyId",
      "peerPublicKeySpkiBase64Url",
      "peerIdentity",
    ],
    [],
    `${plane} IPC plane`,
  );
  const expectedReferenceKey = plane === "core" ? "coreIpcSigningKey" : "helperIpcSigningKey";
  if (
    typeof record["privateKeyReference"] !== "string" ||
    !SECRET_REFERENCE_PATTERN.test(record["privateKeyReference"]) ||
    record["privateKeyReferenceKey"] !== expectedReferenceKey ||
    !isText(record["peerIdentity"], 256) ||
    !Array.isArray(allowedPeers) ||
    !allowedPeers.includes(record["peerIdentity"])
  ) {
    throw new ServiceHostError(`The ${plane} IPC plane identity is invalid.`);
  }
  validateEd25519Pin(record["keyId"], record["publicKeySpkiBase64Url"], `${plane} IPC signing key`);
  validateEd25519Pin(
    record["peerKeyId"],
    record["peerPublicKeySpkiBase64Url"],
    `${plane} IPC peer key`,
  );
  return {
    privateKeyReference: record["privateKeyReference"],
    privateKeyReferenceKey: expectedReferenceKey,
    keyId: record["keyId"] as `sha256:${string}`,
    publicKeySpkiBase64Url: record["publicKeySpkiBase64Url"] as string,
    peerKeyId: record["peerKeyId"] as `sha256:${string}`,
    peerPublicKeySpkiBase64Url: record["peerPublicKeySpkiBase64Url"] as string,
    peerIdentity: record["peerIdentity"],
  };
}

function validateEd25519Pin(keyId: unknown, encodedSpki: unknown, label: string): void {
  if (
    typeof keyId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(keyId) ||
    typeof encodedSpki !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedSpki)
  ) {
    throw new ServiceHostError(`The ${label} pin is invalid.`);
  }
  const spki = Buffer.from(encodedSpki, "base64url");
  try {
    if (spki.length === 0 || spki.length > 256 || spki.toString("base64url") !== encodedSpki) {
      throw new Error("encoding");
    }
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const actualKeyId = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
    if (publicKey.asymmetricKeyType !== "ed25519" || actualKeyId !== keyId) {
      throw new Error("binding");
    }
  } catch {
    throw new ServiceHostError(`The ${label} pin is invalid.`);
  } finally {
    spki.fill(0);
  }
}

function parseHealth(input: unknown): ServiceHostConfiguration["health"] {
  const record = requireRecord(input, "health configuration");
  requireExactKeys(record, ["endpoint", "timeoutMs"], [], "health configuration");
  let endpoint: URL;
  try {
    endpoint = new URL(String(record["endpoint"]));
  } catch {
    throw new ServiceHostError("The local health endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/health/live" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.port === "" ||
    !Number.isSafeInteger(record["timeoutMs"]) ||
    typeof record["timeoutMs"] !== "number" ||
    record["timeoutMs"] <= 0 ||
    record["timeoutMs"] > 120_000
  ) {
    throw new ServiceHostError("The local health endpoint is invalid.");
  }
  return { endpoint: endpoint.toString(), timeoutMs: record["timeoutMs"] };
}

function requirePlatformPath(
  platform: ServiceHostConfiguration["platform"],
  value: unknown,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    (platform === "windows"
      ? !/^[A-Za-z]:\\[^<>:"|?*\r\n]+$/u.test(value)
      : !value.startsWith("/") || value.includes("\\"))
  ) {
    throw new ServiceHostError(`The ${label} path is invalid.`);
  }
}

function pathsOverlap(
  platform: ServiceHostConfiguration["platform"],
  left: string,
  right: string,
): boolean {
  const normalize = (value: string) =>
    stripTrailingPathSeparators(platform === "windows" ? value.toLowerCase() : value);
  const first = normalize(left);
  const second = normalize(right);
  const separator = platform === "windows" ? "\\" : "/";
  return (
    first === second ||
    first.startsWith(`${second}${separator}`) ||
    second.startsWith(`${first}${separator}`)
  );
}

function isDescendantPath(
  platform: ServiceHostConfiguration["platform"],
  parent: string,
  child: string,
): boolean {
  const normalize = (value: string) =>
    stripTrailingPathSeparators(platform === "windows" ? value.toLowerCase() : value);
  const normalizedParent = normalize(parent);
  const normalizedChild = normalize(child);
  const separator = platform === "windows" ? "\\" : "/";
  return normalizedChild.startsWith(`${normalizedParent}${separator}`);
}

function stripTrailingPathSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return value.slice(0, end);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceHostError(`The ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new ServiceHostError(`The ${label} fields do not match the strict schema.`);
  }
}

function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
