import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { arch, homedir, hostname, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  createMainControlPlaneApp,
  type MainControlPlaneAppOptions,
} from "@opendelegate/control-plane";
import {
  Argon2idPasswordHasher,
  NodeCryptoRandomSource,
  OwnerAuth,
  type OwnerAuthClock,
} from "@opendelegate/owner-auth";
import {
  SqlEventStore,
  SqlOwnerAuthRepository,
  type SqlMigrationMode,
} from "@opendelegate/storage-sql";
import { TaskService } from "@opendelegate/task-service";

import type { RuntimeReleaseChannel } from "./release-identity.ts";

import { closeAfterPrimaryFailure, closeMainResources } from "./shutdown.ts";
import { readStableRegularFile, StableFileError } from "./stable-file.ts";

const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_MAIN_PORT = 4380;
const MAX_ADMIN_FILES = 2_000;
const MAX_ADMIN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_TOTAL_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface MainListenerConfiguration {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly tls?: {
    readonly certificatePath: string;
    readonly privateKeyPath: string;
  };
}

export type MainDatabaseConfiguration =
  | {
      readonly adapter: "sqlite";
    }
  | {
      readonly adapter: "postgresql";
      readonly uriEnvironment: string;
      readonly schema?: string;
    };

export interface MainConfiguration {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly deviceId: string;
  readonly main: MainListenerConfiguration;
  readonly database: MainDatabaseConfiguration;
  readonly adminRoot: string;
}

export interface RuntimePaths {
  readonly home: string;
  readonly configDirectory: string;
  readonly configurationFile: string;
  readonly stateDirectory: string;
  readonly sqliteFile: string;
  readonly logsDirectory: string;
}

export type MainRuntimeErrorCode =
  | "ADMIN_ASSET_INVALID"
  | "CONFIG_EXISTS"
  | "CONFIG_INVALID"
  | "DATABASE_URI_MISSING"
  | "RUNTIME_PATH_UNSAFE";

export class MainRuntimeError extends Error {
  readonly code: MainRuntimeErrorCode;

  constructor(code: MainRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MainRuntimeError";
    this.code = code;
  }
}

export interface InitializeMainHomeOptions {
  readonly home?: string;
  readonly adminRoot: string;
  readonly expectedAdminRoot?: string;
  readonly sourceCheckout: string;
  readonly database?: MainDatabaseConfiguration;
  readonly listener?: MainListenerConfiguration;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface InitializedMainHome {
  readonly created: boolean;
  readonly configuration: MainConfiguration;
  readonly paths: RuntimePaths;
}

export interface CreateMainRuntimeOptions {
  readonly home?: string;
  readonly configuration: MainConfiguration;
  readonly build: MainControlPlaneAppOptions["build"];
  readonly releaseChannel: RuntimeReleaseChannel;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface MainRuntime {
  readonly app: Awaited<ReturnType<typeof createMainControlPlaneApp>>;
  readonly configuration: MainConfiguration;
  readonly ownerAuth: OwnerAuth;
  readonly paths: RuntimePaths;
  readonly tasks: TaskService;
  close(): Promise<void>;
}

export interface ListeningMainRuntime extends MainRuntime {
  readonly address: string;
}

export function resolveRuntimePaths(input: {
  readonly home?: string;
  readonly sourceCheckout: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): RuntimePaths {
  const sourceCheckout = resolve(input.sourceCheckout);
  const home = resolve(input.home ?? defaultRuntimeHome(input.environment ?? process.env));
  if (isWithin(sourceCheckout, home)) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "Runtime state must live outside the OpenDelegate source checkout.",
    );
  }
  const configDirectory = join(home, "config");
  const stateDirectory = join(home, "state");
  return Object.freeze({
    home,
    configDirectory,
    configurationFile: join(configDirectory, "main.json"),
    stateDirectory,
    sqliteFile: join(stateDirectory, "main.sqlite3"),
    logsDirectory: join(home, "logs"),
  });
}

export async function initializeMainHome(
  options: InitializeMainHomeOptions,
): Promise<InitializedMainHome> {
  const paths = resolveRuntimePaths(options);
  await ensureRuntimeDirectories(paths, options.sourceCheckout);

  if (await exists(paths.configurationFile)) {
    const configuration = await loadMainConfiguration(paths.configurationFile);
    assertExistingConfigurationMatches(configuration, options);
    await validateAdminRoot(configuration.adminRoot);
    await applyInitialMigrations({
      configuration,
      paths,
      environment: options.environment ?? process.env,
    });
    await sealRuntimeState(paths);
    return {
      created: false,
      configuration,
      paths,
    };
  }

  const configuration = validateMainConfiguration({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    instanceId: `instance_${randomUUID()}`,
    deviceId: `device_${randomUUID()}`,
    main:
      options.listener ??
      ({
        host: "127.0.0.1",
        port: DEFAULT_MAIN_PORT,
        origin: `http://127.0.0.1:${DEFAULT_MAIN_PORT}`,
      } satisfies MainListenerConfiguration),
    database: options.database ?? { adapter: "sqlite" },
    adminRoot: resolve(options.adminRoot),
  });
  await validateAdminRoot(configuration.adminRoot);

  await writeFile(paths.configurationFile, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await applyInitialMigrations({
    configuration,
    paths,
    environment: options.environment ?? process.env,
  });
  await sealRuntimeState(paths);

  return {
    created: true,
    configuration,
    paths,
  };
}

function assertExistingConfigurationMatches(
  configuration: MainConfiguration,
  options: InitializeMainHomeOptions,
): void {
  const requested = validateMainConfiguration({
    ...configuration,
    ...(options.listener === undefined ? {} : { main: options.listener }),
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.expectedAdminRoot === undefined
      ? {}
      : { adminRoot: resolve(options.expectedAdminRoot) }),
  });
  const conflicts =
    (options.listener !== undefined &&
      JSON.stringify(requested.main) !== JSON.stringify(configuration.main)) ||
    (options.database !== undefined &&
      JSON.stringify(requested.database) !== JSON.stringify(configuration.database)) ||
    (options.expectedAdminRoot !== undefined && requested.adminRoot !== configuration.adminRoot);
  if (conflicts) {
    throw new MainRuntimeError(
      "CONFIG_EXISTS",
      "Main is already initialized with different requested settings. Existing configuration was not changed.",
    );
  }
}

export async function loadMainConfiguration(path: string): Promise<MainConfiguration> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new MainRuntimeError("CONFIG_INVALID", "Main configuration is not valid JSON.");
  }
  return validateMainConfiguration(parsed);
}

export async function createMainRuntime(options: CreateMainRuntimeOptions): Promise<MainRuntime> {
  const configuration = validateMainConfiguration(options.configuration);
  const paths = resolveRuntimePaths(options);
  await ensureRuntimeDirectories(paths, options.sourceCheckout);
  await validateAdminRoot(configuration.adminRoot);

  const environment = options.environment ?? process.env;
  const clock = new SystemClock();
  const eventStore = await openEventStore(
    configuration.database,
    paths,
    clock,
    "verify",
    environment,
  );
  let ownerRepository: SqlOwnerAuthRepository | undefined;
  let app: Awaited<ReturnType<typeof createMainControlPlaneApp>> | undefined;
  try {
    ownerRepository = await openOwnerRepository(
      configuration.database,
      paths,
      "verify",
      environment,
    );
    const ownerAuth = new OwnerAuth({
      allowedOrigins: [configuration.main.origin],
      clock,
      passwordHasher: new Argon2idPasswordHasher(),
      random: new NodeCryptoRandomSource(),
      repository: ownerRepository,
    });
    const tasks = new TaskService({ clock: clock.asEventClock(), eventStore });
    const tls =
      configuration.main.tls === undefined
        ? undefined
        : {
            certificate: await readFile(configuration.main.tls.certificatePath),
            privateKey: await readFile(configuration.main.tls.privateKeyPath),
          };
    app = await createMainControlPlaneApp({
      ownerAuth,
      allowedOrigins: [configuration.main.origin],
      build: options.build,
      runtimeFeatures: {
        releaseChannel: options.releaseChannel,
        taskExecution: {
          status: "unavailable",
          code: "ORCHESTRATION_NOT_CONNECTED",
        },
        configurationAgent: {
          status: "unavailable",
          code: "CONFIGURATION_AGENT_NOT_CONNECTED",
        },
        discord: {
          status: "unavailable",
          code: "DISCORD_NOT_CONFIGURED",
        },
      },
      devices: [
        {
          deviceId: configuration.deviceId,
          name: hostname(),
          osFamily: currentOsFamily(),
          platformRelease: release(),
          architecture: arch(),
          role: "main",
          connection: "online",
          runtime: "healthy",
          serviceMode: "foreground",
        },
      ],
      tasks,
      ...(tls === undefined ? {} : { tls }),
      readiness: async () => {
        await eventStore.streamVersion("opendelegate:readiness");
        return {
          status: "ready",
          checks: [
            { status: "ready", code: "DATABASE_READY" },
            { status: "ready", code: "CONTROL_PLANE_READY" },
          ],
        };
      },
    });
    await registerAdminAssets(app, configuration.adminRoot);
    await app.ready();
    await sealRuntimeState(paths);

    let closePromise: Promise<void> | undefined;
    return {
      app,
      configuration,
      ownerAuth,
      paths,
      tasks,
      close: () => {
        if (closePromise === undefined) {
          closePromise = closeMainResources([
            { operation: "control-plane", close: () => app?.close() },
            { operation: "event-store", close: () => eventStore.close() },
            { operation: "owner-auth-repository", close: () => ownerRepository?.close() },
          ]);
        }
        return closePromise;
      },
    };
  } catch (error) {
    return closeAfterPrimaryFailure(error, [
      { operation: "control-plane", close: () => app?.close() },
      { operation: "event-store", close: () => eventStore.close() },
      { operation: "owner-auth-repository", close: () => ownerRepository?.close() },
    ]);
  }
}

function currentOsFamily(): "macos" | "windows" | "linux" {
  switch (platform()) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "This OpenDelegate release supports macOS, Windows, and Linux.",
      );
  }
}

export async function listenMainRuntime(runtime: MainRuntime): Promise<ListeningMainRuntime> {
  const address = await runtime.app.listen({
    host: runtime.configuration.main.host,
    port: runtime.configuration.main.port,
    listenTextResolver: (value) => value,
  });
  return Object.assign(runtime, { address });
}

async function applyInitialMigrations(input: {
  readonly configuration: MainConfiguration;
  readonly paths: RuntimePaths;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const clock = new SystemClock();
  const store = await openEventStore(
    input.configuration.database,
    input.paths,
    clock,
    "apply",
    input.environment,
  );
  await store.close();
}

async function openEventStore(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  clock: SystemClock,
  migrationMode: SqlMigrationMode,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SqlEventStore> {
  if (configuration.adapter === "sqlite") {
    return SqlEventStore.openSqlite({
      clock: clock.asEventClock(),
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  return SqlEventStore.openPostgres({
    clock: clock.asEventClock(),
    connectionString: requireDatabaseUri(configuration, environment),
    migrationMode,
    ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
  });
}

async function openOwnerRepository(
  configuration: MainDatabaseConfiguration,
  paths: RuntimePaths,
  migrationMode: SqlMigrationMode,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SqlOwnerAuthRepository> {
  if (configuration.adapter === "sqlite") {
    return SqlOwnerAuthRepository.openSqlite({
      filename: paths.sqliteFile,
      migrationMode,
    });
  }
  return SqlOwnerAuthRepository.openPostgres({
    connectionString: requireDatabaseUri(configuration, environment),
    migrationMode,
    ...(configuration.schema === undefined ? {} : { schema: configuration.schema }),
  });
}

function requireDatabaseUri(
  configuration: Extract<MainDatabaseConfiguration, { adapter: "postgresql" }>,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[configuration.uriEnvironment];
  if (value === undefined || value.trim().length === 0) {
    throw new MainRuntimeError(
      "DATABASE_URI_MISSING",
      `PostgreSQL requires the ${configuration.uriEnvironment} environment variable.`,
    );
  }
  return value;
}

async function registerAdminAssets(
  app: Awaited<ReturnType<typeof createMainControlPlaneApp>>,
  adminRoot: string,
): Promise<void> {
  const assets = await loadAdminAssets(adminRoot);
  const index = assets.get("index.html");
  if (index === undefined) {
    throw new MainRuntimeError("ADMIN_ASSET_INVALID", "The Admin Web bundle has no index.html.");
  }

  app.get("/", async (_request, reply) => {
    setAdminHeaders(reply, "index.html");
    return reply.send(index);
  });
  app.get("/*", async (request, reply) => {
    const wildcard = (request.params as { "*": string })["*"];
    const path = normalizeAssetRequestPath(wildcard);
    if (isControlPlaneNamespace(path)) {
      return reply.callNotFound();
    }
    const asset = assets.get(path);
    if (asset !== undefined) {
      setAdminHeaders(reply, path);
      return reply.send(asset);
    }
    if (path.includes(".")) {
      return reply.callNotFound();
    }
    setAdminHeaders(reply, "index.html");
    return reply.send(index);
  });
}

function isControlPlaneNamespace(path: string): boolean {
  return (
    path === "api" || path.startsWith("api/") || path === "health" || path.startsWith("health/")
  );
}

async function loadAdminAssets(root: string): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "Admin Web assets cannot contain symbolic links.",
        );
      }
      const absolute = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(absolute, relativePath);
        continue;
      }
      if (!entry.isFile() || files.size >= MAX_ADMIN_FILES) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "The Admin Web bundle contains unsupported or too many entries.",
        );
      }
      let bytes: Buffer;
      try {
        bytes = await readStableRegularFile(absolute, MAX_ADMIN_FILE_BYTES);
      } catch (error) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          error instanceof StableFileError && error.code === "TOO_LARGE"
            ? "An Admin Web asset exceeds the size limit."
            : "An Admin Web asset is not a stable regular file.",
          { cause: error },
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_ADMIN_TOTAL_BYTES) {
        throw new MainRuntimeError(
          "ADMIN_ASSET_INVALID",
          "The Admin Web bundle exceeds the total size limit.",
        );
      }
      files.set(relativePath.replaceAll("\\", "/"), bytes);
    }
  };

  await visit(root, "");
  return files;
}

function setAdminHeaders(
  reply: {
    header(name: string, value: string): unknown;
    type(contentType: string): unknown;
  },
  path: string,
): void {
  void reply.type(contentType(path));
  void reply.header(
    "cache-control",
    path === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
  );
  void reply.header("x-content-type-options", "nosniff");
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };
  return types[extension] ?? "application/octet-stream";
}

function normalizeAssetRequestPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return "__invalid__";
  }
  return value;
}

async function validateAdminRoot(root: string): Promise<void> {
  if (!isAbsolute(root)) {
    throw new MainRuntimeError("CONFIG_INVALID", "The Admin Web bundle path must be absolute.");
  }
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a directory");
    }
    await access(join(root, "index.html"));
  } catch {
    throw new MainRuntimeError(
      "ADMIN_ASSET_INVALID",
      "The Admin Web bundle path is not a readable directory with index.html.",
    );
  }
}

async function ensureRuntimeDirectories(
  paths: RuntimePaths,
  sourceCheckout: string,
): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(paths.home, "runtime home");
  for (const [path, label] of [
    [paths.configDirectory, "runtime config directory"],
    [paths.stateDirectory, "runtime state directory"],
    [paths.logsDirectory, "runtime logs directory"],
  ] as const) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    await assertPrivateDirectory(path, label);
  }

  const [actualHome, actualCheckout] = await Promise.all([
    realpath(paths.home),
    realpath(sourceCheckout),
  ]);
  if (isWithin(actualCheckout, actualHome)) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "Resolved runtime state must live outside the OpenDelegate source checkout.",
    );
  }
  await sealRuntimeState(paths, actualHome);
}

async function sealRuntimeState(paths: RuntimePaths, resolvedHome?: string): Promise<void> {
  const actualHome = resolvedHome ?? (await realpath(paths.home));
  await assertManagedTreeHasNoLinks(actualHome);
  if (process.platform === "win32") {
    await enforceWindowsRuntimeAcl(actualHome);
  } else {
    await enforcePosixRuntimePermissions([
      actualHome,
      paths.configDirectory,
      paths.stateDirectory,
      paths.logsDirectory,
    ]);
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a private directory");
    }
  } catch {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      `The ${label} must be a real directory, not a symlink or reparse point.`,
    );
  }
}

async function assertManagedTreeHasNoLinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new MainRuntimeError(
        "RUNTIME_PATH_UNSAFE",
        "Runtime state cannot contain symlinks or reparse points.",
      );
    }
    if (metadata.isDirectory()) {
      await assertManagedTreeHasNoLinks(path);
    }
  }
}

async function enforcePosixRuntimePermissions(paths: readonly string[]): Promise<void> {
  const currentUid = process.getuid?.();
  for (const path of paths) {
    await chmod(path, 0o700);
    const metadata = await lstat(path);
    if (
      (metadata.mode & 0o077) !== 0 ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new MainRuntimeError(
        "RUNTIME_PATH_UNSAFE",
        "Runtime state permissions must grant access only to the current operating-system owner.",
      );
    }
  }
}

async function enforceWindowsRuntimeAcl(root: string): Promise<void> {
  let identityOutput: string;
  try {
    const result = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    identityOutput = result.stdout;
  } catch {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "OpenDelegate could not resolve the current Windows security identity.",
    );
  }
  const userSid = identityOutput.match(/S-\d(?:-\d+)+/u)?.[0];
  if (userSid === undefined) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "OpenDelegate could not parse the current Windows security identity.",
    );
  }
  const verificationScript = String.raw`
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1")
$root = $env:OPENDELEGATE_ACL_ROOT
$userSidText = $env:OPENDELEGATE_ACL_USER_SID
$systemSidText = "S-1-5-18"
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Runtime state contains a reparse point."
  }
  $acl = Get-Acl -LiteralPath $item.FullName
  $ownerSidText = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSidText -ne $userSidText -and $ownerSidText -ne $systemSidText) {
    throw "Runtime state item '$($item.FullName)' is owned by '$ownerSidText', not the current user or LocalSystem."
  }
  if ($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) {
    throw "Runtime state still inherits access rules."
  }
  foreach ($existingRule in @($acl.Access)) {
    $ruleSidText = $existingRule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if (
      ($ruleSidText -ne $userSidText -and $ruleSidText -ne $systemSidText) -or
      $existingRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      (($existingRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
        [System.Security.AccessControl.FileSystemRights]::FullControl)
    ) {
      throw "Runtime state grants access outside the current user and LocalSystem."
    }
  }
}
`;
  try {
    for (const arguments_ of [
      [root, "/reset", "/L", "/Q"],
      [root, "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L", "/Q"],
      [root, "/inheritance:r", "/L", "/Q"],
      [join(root, "*"), "/reset", "/T", "/L", "/Q"],
      [root, "/setowner", `*${userSid}`, "/T", "/L", "/Q"],
    ]) {
      await execFileAsync("icacls.exe", arguments_, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    }
    await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verificationScript],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENDELEGATE_ACL_ROOT: root,
          OPENDELEGATE_ACL_USER_SID: userSid,
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new MainRuntimeError(
      "RUNTIME_PATH_UNSAFE",
      "OpenDelegate could not enforce a private Windows ACL on runtime state.",
      { cause: error },
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function validateMainConfiguration(input: unknown): MainConfiguration {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "schemaVersion",
      "instanceId",
      "deviceId",
      "main",
      "database",
      "adminRoot",
    ]) ||
    input["schemaVersion"] !== CONFIG_SCHEMA_VERSION ||
    typeof input["instanceId"] !== "string" ||
    typeof input["deviceId"] !== "string" ||
    input["instanceId"] === input["deviceId"] ||
    !isOpaqueId(input["instanceId"]) ||
    !isOpaqueId(input["deviceId"]) ||
    typeof input["adminRoot"] !== "string" ||
    !isAbsolute(input["adminRoot"])
  ) {
    throw configInvalid();
  }

  const main = validateListener(input["main"]);
  const database = validateDatabase(input["database"]);
  return Object.freeze({
    schemaVersion: 1,
    instanceId: input["instanceId"],
    deviceId: input["deviceId"],
    main,
    database,
    adminRoot: resolve(input["adminRoot"]),
  });
}

function validateListener(input: unknown): MainListenerConfiguration {
  if (
    !isRecord(input) ||
    !hasAllowedKeys(input, ["host", "port", "origin", "tls"]) ||
    !hasRequiredKeys(input, ["host", "port", "origin"]) ||
    typeof input["host"] !== "string" ||
    typeof input["port"] !== "number" ||
    !Number.isSafeInteger(input["port"]) ||
    input["port"] < 1 ||
    input["port"] > 65_535 ||
    typeof input["origin"] !== "string"
  ) {
    throw configInvalid();
  }

  let origin: URL;
  try {
    origin = new URL(input["origin"]);
  } catch {
    throw configInvalid();
  }
  if (
    origin.origin !== input["origin"] ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    Number(origin.port || defaultPort(origin.protocol)) !== input["port"]
  ) {
    throw configInvalid();
  }

  const tls = validateTls(input["tls"]);
  if (tls === undefined) {
    if (
      origin.protocol !== "http:" ||
      !isLoopbackHost(input["host"]) ||
      !isLoopbackHost(origin.hostname)
    ) {
      throw new MainRuntimeError(
        "CONFIG_INVALID",
        "Cleartext Main listeners are allowed only on loopback.",
      );
    }
  } else if (origin.protocol !== "https:") {
    throw configInvalid();
  }

  return Object.freeze({
    host: input["host"],
    port: input["port"],
    origin: origin.origin,
    ...(tls === undefined ? {} : { tls }),
  });
}

function validateTls(input: unknown): MainListenerConfiguration["tls"] {
  if (input === undefined) {
    return undefined;
  }
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["certificatePath", "privateKeyPath"]) ||
    typeof input["certificatePath"] !== "string" ||
    typeof input["privateKeyPath"] !== "string" ||
    !isAbsolute(input["certificatePath"]) ||
    !isAbsolute(input["privateKeyPath"])
  ) {
    throw configInvalid();
  }
  return Object.freeze({
    certificatePath: resolve(input["certificatePath"]),
    privateKeyPath: resolve(input["privateKeyPath"]),
  });
}

function validateDatabase(input: unknown): MainDatabaseConfiguration {
  if (!isRecord(input) || typeof input["adapter"] !== "string") {
    throw configInvalid();
  }
  if (input["adapter"] === "sqlite" && hasExactKeys(input, ["adapter"])) {
    return Object.freeze({ adapter: "sqlite" });
  }
  if (
    input["adapter"] === "postgresql" &&
    hasAllowedKeys(input, ["adapter", "uriEnvironment", "schema"]) &&
    hasRequiredKeys(input, ["adapter", "uriEnvironment"]) &&
    typeof input["uriEnvironment"] === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(input["uriEnvironment"]) &&
    (input["schema"] === undefined ||
      (typeof input["schema"] === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input["schema"])))
  ) {
    return Object.freeze({
      adapter: "postgresql",
      uriEnvironment: input["uriEnvironment"],
      ...(input["schema"] === undefined ? {} : { schema: input["schema"] }),
    });
  }
  throw configInvalid();
}

function defaultRuntimeHome(environment: Readonly<Record<string, string | undefined>>): string {
  const explicit = environment["OPENDELEGATE_HOME"];
  if (explicit !== undefined && explicit.trim().length > 0) {
    if (!isAbsolute(explicit)) {
      throw new MainRuntimeError(
        "RUNTIME_PATH_UNSAFE",
        "OPENDELEGATE_HOME must be an absolute path.",
      );
    }
    return explicit;
  }
  switch (platform()) {
    case "win32":
      return join(
        environment["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
        "OpenDelegate",
      );
    case "darwin":
      return join(homedir(), "Library", "Application Support", "OpenDelegate");
    default:
      return join(
        environment["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
        "opendelegate",
      );
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

function isOpaqueId(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function configInvalid(): MainRuntimeError {
  return new MainRuntimeError(
    "CONFIG_INVALID",
    "Main configuration does not match schema version 1.",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class SystemClock implements OwnerAuthClock {
  now(): number {
    return Date.now();
  }

  asEventClock(): { readonly now: () => string } {
    return {
      now: () => new Date(this.now()).toISOString(),
    };
  }
}

export function mainConfigurationDirectory(configurationFile: string): string {
  return dirname(configurationFile);
}
