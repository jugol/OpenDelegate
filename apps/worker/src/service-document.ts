import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  composeServiceConfiguration,
  type PlatformFamily,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

import {
  createWorkerManagedSecretStore,
  loadWorkerConfiguration,
  readWorkerComputerUseCoreKeyBinding,
  readWorkerSessionHelperOwnerKeyBinding,
  WorkerAppError,
  type WorkerPaths,
} from "./worker-app.ts";

export interface BuildWorkerServiceDocumentOptions {
  readonly paths: WorkerPaths;
  /** The release bundle the service will run, as built and signed for this host. */
  readonly bundleDirectory: string;
  readonly installRoot: string;
  readonly dataRoot: string;
  readonly instanceId: string;
  readonly healthPort: number;
  /** The staged Windows handoff emitted by `windows-service-secret-stage`. */
  readonly windowsServiceSecretBinding?: {
    readonly backend: "windows-service-dpapi";
    readonly handoffRoot: string;
    readonly serviceName: string;
    readonly serviceSid: string;
    readonly vaultRoot: string;
  };
  readonly sourceCheckoutRoot: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly ownerSession?: {
    readonly userName: string;
    readonly stableUserId: string;
  };
}

/**
 * Builds this Device's native service document.
 *
 * Everything in it is read from the Device rather than supplied: the Worker's own
 * identity, the two signing pins it already holds, and the bundle's checksum
 * manifest. That matters most for the pins — the session helper refuses to start
 * when a pin does not match the key it holds, and a document assembled from
 * anywhere else fails at helper start-up rather than here.
 */
export async function buildWorkerServiceDocument(
  options: BuildWorkerServiceDocumentOptions,
): Promise<PlatformServiceConfiguration> {
  const hostPlatform = options.hostPlatform ?? platform();
  const family = platformFamily(hostPlatform);
  if (family !== "windows") {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Worker service documents are composed only on the host they describe, and only Windows is wired.",
    );
  }
  for (const [label, value] of [
    ["bundle directory", options.bundleDirectory],
    ["install root", options.installRoot],
    ["data root", options.dataRoot],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new WorkerAppError("CONFIG_INVALID", `The ${label} must be an absolute path.`);
    }
  }

  const configuration = await loadWorkerConfiguration(options.paths);
  const store = createWorkerManagedSecretStore(
    configuration.secretBackend,
    configuration.deviceId,
    options.paths,
    options.environment ?? process.env,
  );
  if ((await store.health()).status !== "ready") {
    throw new WorkerAppError(
      "SECRET_BACKEND_UNAVAILABLE",
      "The Device-local Secret Store is unavailable, so its signing pins cannot be read.",
    );
  }
  const [core, helper] = await Promise.all([
    readWorkerComputerUseCoreKeyBinding(store),
    readWorkerSessionHelperOwnerKeyBinding(store),
  ]);

  const bundleDirectory = resolve(options.bundleDirectory);
  const [version, checksum] = await Promise.all([
    readBundleVersion(bundleDirectory),
    readBundleChecksum(bundleDirectory),
  ]);
  const ownerSession = options.ownerSession ?? (await resolveWindowsOwnerSession());

  return composeServiceConfiguration({
    platform: family,
    role: "worker",
    instanceId: options.instanceId,
    deviceId: configuration.deviceId,
    bundle: { version, sourceDirectory: bundleDirectory, checksum },
    sourceCheckoutDirectory: resolve(options.sourceCheckoutRoot),
    installRoot: resolve(options.installRoot),
    dataRoot: resolve(options.dataRoot),
    ownerSession: {
      userName: ownerSession.userName,
      stableUserId: ownerSession.stableUserId,
      // A Worker never opens Admin: the configuration reader rejects it outright.
      adminAutoOpen: { enabled: false },
    },
    ipcTrust: {
      core: { keyId: core.keyId, publicKeySpkiBase64Url: core.publicKeySpkiBase64Url },
      helper: { keyId: helper.keyId, publicKeySpkiBase64Url: helper.publicKeySpkiBase64Url },
    },
    secretReferences: {
      coreIpcSigningKey: `secret://worker/${core.alias}`,
      helperIpcSigningKey: `secret://worker/${helper.alias}`,
    },
    healthPort: options.healthPort,
    ...(options.windowsServiceSecretBinding === undefined
      ? {}
      : { windowsServiceSecretBinding: options.windowsServiceSecretBinding }),
  });
}

/**
 * The checksum the install preflight recomputes: the digest of the bundle's own
 * SHA256SUMS manifest, not of any one payload file.
 */
async function readBundleChecksum(bundleDirectory: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(bundleDirectory, "SHA256SUMS"));
  } catch {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The release bundle has no SHA256SUMS manifest, so its checksum cannot be stated.",
    );
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readBundleVersion(bundleDirectory: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bundleDirectory, "release-metadata.json"), "utf8"));
  } catch {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The release bundle has no readable release metadata.",
    );
  }
  const version =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["productVersion"]
      : undefined;
  if (
    typeof version !== "string" ||
    !/^[0-9]+(?:\.[0-9]+){2}(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The release bundle does not state a release-safe product version.",
    );
  }
  return version;
}

/**
 * The owner account the session helper will run as.
 *
 * The SID is the stable identity — a renamed account keeps it, and the IPC peer
 * list is checked against the SID rather than the display name — so it is read
 * from the OS rather than from an environment variable Windows does not set.
 */
async function resolveWindowsOwnerSession(): Promise<{
  readonly userName: string;
  readonly stableUserId: string;
}> {
  const output = await new Promise<string>((settle, fail) => {
    execFile(
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe"),
      ["/user", "/nh", "/fo", "csv"],
      { shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 },
      (error, stdout) => (error === null ? settle(stdout) : fail(error)),
    );
  }).catch(() => {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The owner account identity could not be read from this host.",
    );
  });
  const fields = [...output.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? "");
  const userName = fields[0];
  const sid = fields[1];
  if (
    userName === undefined ||
    userName.length === 0 ||
    sid === undefined ||
    !/^S-1-[0-9-]{1,120}$/u.test(sid)
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The owner account identity could not be read from this host.",
    );
  }
  return { userName, stableUserId: sid };
}

function platformFamily(value: NodeJS.Platform): PlatformFamily {
  return value === "win32" ? "windows" : value === "darwin" ? "macos" : "linux";
}
