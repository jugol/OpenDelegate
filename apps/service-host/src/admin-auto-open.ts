import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, win32 } from "node:path";

import type { ServiceHostConfiguration } from "./configuration.ts";

const DEFAULT_READINESS_ATTEMPTS = 120;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_READINESS_WINDOW_MS = 120_000;
const MAX_HEALTH_BODY_BYTES = 4_096;
const EXACT_LOGIN_SESSION_PATTERN =
  /^(?:windows:[0-9]+:logon:[0-9]+-[0-9]+|unix:[0-9]+:(?:audit:[0-9]+|xdg:[A-Za-z0-9._-]{1,128}))$/u;

export interface AdminAutoOpenInput {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly platform: ServiceHostConfiguration["platform"];
  readonly role: ServiceHostConfiguration["role"];
  readonly runtimeRoot: string;
  readonly ownerStableId: string;
  readonly sessionId: string;
  readonly adminAutoOpen: ServiceHostConfiguration["ownerSession"]["adminAutoOpen"];
  readonly health: ServiceHostConfiguration["health"];
  readonly signal: AbortSignal;
}

export interface AdminBrowserLaunchRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
}

export type AdminAutoOpenResult =
  | { readonly status: "disabled" }
  | { readonly status: "session-unavailable" }
  | { readonly status: "already-opened" }
  | { readonly status: "cancelled" }
  | { readonly status: "main-unavailable" }
  | { readonly status: "claim-unavailable" }
  | { readonly status: "launch-failed" }
  | { readonly status: "opened"; readonly url: string };

export interface AdminAutoOpenDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly launch?: (request: AdminBrowserLaunchRequest) => Promise<void>;
  readonly readinessAttempts?: number;
  readonly readinessWindowMs?: number;
  readonly retryIntervalMs?: number;
  readonly windowsDirectory?: string;
  readonly now?: () => number;
}

/**
 * Login-session convenience owned by the unprivileged helper plane. The durable
 * Main setting is copied into the signed service configuration, while this
 * function owns only the ephemeral once-per-session claim.
 */
export async function autoOpenAdminForOwnerSession(
  input: AdminAutoOpenInput,
  dependencies: AdminAutoOpenDependencies = {},
): Promise<AdminAutoOpenResult> {
  if (input.role !== "main" || !input.adminAutoOpen.enabled) {
    return { status: "disabled" };
  }
  if (!EXACT_LOGIN_SESSION_PATTERN.test(input.sessionId)) {
    return { status: "session-unavailable" };
  }
  if (input.signal.aborted) {
    return { status: "cancelled" };
  }

  const claim = new SessionOpenClaim(input);
  try {
    if (await claim.exists()) {
      return { status: "already-opened" };
    }
  } catch {
    return { status: "claim-unavailable" };
  }

  const attempts = boundedPositiveInteger(
    dependencies.readinessAttempts,
    DEFAULT_READINESS_ATTEMPTS,
    1,
    600,
  );
  const retryIntervalMs = boundedPositiveInteger(
    dependencies.retryIntervalMs,
    DEFAULT_RETRY_INTERVAL_MS,
    1,
    60_000,
  );
  const readinessWindowMs = boundedPositiveInteger(
    dependencies.readinessWindowMs,
    DEFAULT_READINESS_WINDOW_MS,
    1_000,
    10 * 60_000,
  );
  const now = dependencies.now ?? Date.now;
  const deadline = now() + readinessWindowMs;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const delayImplementation = dependencies.delay ?? abortableDelay;
  let ready = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.signal.aborted) {
      return { status: "cancelled" };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }
    ready = await probeMainReadiness(
      input,
      fetchImplementation,
      Math.min(input.health.timeoutMs, remaining),
    );
    if (ready) {
      break;
    }
    if (attempt + 1 < attempts) {
      const delayMs = Math.min(retryIntervalMs, Math.max(0, deadline - now()));
      if (delayMs <= 0) {
        break;
      }
      await delayImplementation(delayMs, input.signal);
    }
  }
  if (input.signal.aborted) {
    return { status: "cancelled" };
  }
  if (!ready) {
    return { status: "main-unavailable" };
  }

  try {
    if (!(await claim.acquire())) {
      return { status: "already-opened" };
    }
  } catch {
    return { status: "claim-unavailable" };
  }

  try {
    const request = createAdminBrowserLaunchRequest(input.platform, input.adminAutoOpen.url, {
      ...(dependencies.windowsDirectory === undefined
        ? {}
        : { windowsDirectory: dependencies.windowsDirectory }),
    });
    await (dependencies.launch ?? launchAdminBrowser)(request, input.platform);
    return { status: "opened", url: input.adminAutoOpen.url };
  } catch {
    // Retain the claim. A malformed browser association must not create a
    // supervisor restart/open loop in the same owner login session.
    return { status: "launch-failed" };
  }
}

export function createAdminBrowserLaunchRequest(
  platform: ServiceHostConfiguration["platform"],
  url: string,
  options: { readonly windowsDirectory?: string } = {},
): AdminBrowserLaunchRequest {
  assertAdminUrl(url);
  if (platform === "macos") {
    return {
      executable: "/usr/bin/open",
      arguments: [url],
    };
  }
  if (platform === "linux") {
    return {
      executable: "/usr/bin/xdg-open",
      arguments: [url],
    };
  }
  const windowsDirectory = options.windowsDirectory ?? process.env["SystemRoot"];
  if (
    typeof windowsDirectory !== "string" ||
    !win32.isAbsolute(windowsDirectory) ||
    win32.normalize(windowsDirectory) !== windowsDirectory ||
    /[\0\r\n]/u.test(windowsDirectory)
  ) {
    throw new Error("The native Windows directory is unavailable.");
  }
  return {
    executable: win32.join(windowsDirectory, "explorer.exe"),
    arguments: [url],
  };
}

class SessionOpenClaim {
  readonly #directory: string;
  readonly #path: string;

  public constructor(input: AdminAutoOpenInput) {
    this.#directory = join(input.runtimeRoot, "admin-auto-open");
    const digest = createHash("sha256")
      .update(input.instanceId)
      .update("\0")
      .update(input.deviceId)
      .update("\0")
      .update(input.ownerStableId)
      .update("\0")
      .update(input.sessionId)
      .digest("hex");
    this.#path = join(this.#directory, `${digest}.claim`);
  }

  public async exists(): Promise<boolean> {
    try {
      const metadata = await lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("The Admin auto-open claim is unsafe.");
      }
      return true;
    } catch (error: unknown) {
      if (isFileSystemError(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  public async acquire(): Promise<boolean> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("The Admin auto-open claim directory is unsafe.");
    }
    try {
      const handle = await open(this.#path, "wx", 0o600);
      await handle.close();
      return true;
    } catch (error: unknown) {
      if (isFileSystemError(error, "EEXIST")) {
        await this.exists();
        return false;
      }
      throw error;
    }
  }
}

async function probeMainReadiness(
  input: AdminAutoOpenInput,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<boolean> {
  const timeout = new AbortController();
  const stop = () => timeout.abort();
  input.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(input.health.endpoint, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: timeout.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HEALTH_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_HEALTH_BODY_BYTES) {
      return false;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return false;
    }
    return isMatchingMainHealth(body, input);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
  }
}

function isMatchingMainHealth(body: unknown, input: AdminAutoOpenInput): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return (
    record["schemaVersion"] === 1 &&
    record["product"] === "OpenDelegate" &&
    record["plane"] === "core" &&
    record["instanceId"] === input.instanceId &&
    record["deviceId"] === input.deviceId &&
    record["role"] === "main" &&
    record["status"] === "running" &&
    record["headlessWorkAvailable"] === true
  );
}

async function launchAdminBrowser(
  request: AdminBrowserLaunchRequest,
  platform: ServiceHostConfiguration["platform"],
): Promise<void> {
  const child = spawn(request.executable, [...request.arguments], {
    detached: true,
    env: ownerBrowserEnvironment(platform),
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

function ownerBrowserEnvironment(
  platform: ServiceHostConfiguration["platform"],
): NodeJS.ProcessEnv {
  const allowed =
    platform === "windows"
      ? [
          "SystemRoot",
          "WINDIR",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "TEMP",
          "TMP",
          "SESSIONNAME",
        ]
      : platform === "macos"
        ? ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]
        : [
            "HOME",
            "USER",
            "LOGNAME",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_TYPE",
            "XDG_SESSION_ID",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
          ];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function assertAdminUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Admin auto-open URL is invalid.");
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
    throw new Error("The Admin auto-open URL is invalid.");
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("The Admin auto-open retry configuration is invalid.");
  }
  return value;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
