import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

import {
  composeServiceConfiguration,
  type PlatformFamily,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

import {
  loadWorkerConfiguration,
  readStableWorkerFile,
  WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS,
  WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS,
  WorkerAppError,
  type WorkerPaths,
} from "./worker-app.ts";

const MAXIMUM_CHECKSUM_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RELEASE_METADATA_BYTES = 1024 * 1024;

export interface BuildWorkerServiceDocumentOptions {
  readonly paths: WorkerPaths;
  /** The release bundle the service will run, as built and signed for this host. */
  readonly bundleDirectory: string;
  readonly installRoot: string;
  readonly dataRoot: string;
  readonly instanceId: string;
  readonly healthPort: number;
  readonly sourceCheckoutRoot: string;
  readonly hostPlatform?: NodeJS.Platform;
  readonly ownerSession?: {
    readonly userName: string;
    readonly stableUserId: string;
    readonly uid?: number;
    readonly homeDirectory?: string;
  };
  readonly serviceIdentity?: {
    readonly userName: string;
    readonly groupName: string;
  };
}

/**
 * Builds this Device's native service document.
 *
 * Everything in it is read from the Device rather than transcribed: the Worker's
 * own identity, the two public signing pins captured before Windows staging moved
 * core Secrets, the retained owner-helper vault, and the bundle checksum manifest.
 * That matters most for the pins — after staging, service-account-sealed material
 * cannot be reopened by the owner merely to rediscover a public key.
 */
export async function buildWorkerServiceDocument(
  options: BuildWorkerServiceDocumentOptions,
): Promise<PlatformServiceConfiguration> {
  const hostPlatform = options.hostPlatform ?? platform();
  const family = platformFamily(hostPlatform);
  if (family === undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The current host platform has no native OpenDelegate service integration.",
    );
  }
  if (family === "macos") {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Persistent macOS Worker preparation still lacks the separate core-service and owner-session Keychain migration required by the two-plane runtime. No install document was written.",
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
  if (resolve(options.paths.home) !== resolve(options.dataRoot, "state")) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The enrolled Worker home must equal DATA_ROOT/state because the native core service opens that exact durable state root.",
    );
  }

  const configuration = await loadWorkerConfiguration(options.paths);
  const serviceBundleDirectory = platformPath(family, options.bundleDirectory);
  const [version, checksum] = await Promise.all([
    // Read through the path dialect of the process performing installation.
    // `hostPlatform` may intentionally target another service-document dialect
    // during validation, but must never rewrite the path used for local I/O.
    readBundleVersion(options.bundleDirectory),
    readBundleChecksum(options.bundleDirectory),
  ]);
  if (family === "linux") {
    if (configuration.secretBackend.backend !== "linux-systemd-credential-vault") {
      throw new WorkerAppError(
        "CONFIG_INVALID",
        "A persistent headless Linux Worker must join under its systemd credential vault before composing a service document.",
      );
    }
    const servicePreparation = configuration.secretBackend.servicePreparation;
    if (servicePreparation === undefined || servicePreparation.mode !== "headless") {
      throw new WorkerAppError(
        "CONFIG_INVALID",
        "This Linux Worker predates durable core service preparation. Re-enroll it under the eventual systemd service identity; OpenDelegate will not guess the lost public pin.",
      );
    }
    const ownerSession = requireUnixOwnerSession(options.ownerSession);
    const serviceIdentity = servicePreparation.serviceIdentity;
    if (
      options.serviceIdentity !== undefined &&
      (options.serviceIdentity.userName !== serviceIdentity.userName ||
        options.serviceIdentity.groupName !== serviceIdentity.groupName)
    ) {
      throw new WorkerAppError(
        "CONFIG_INVALID",
        "The requested Linux service identity does not match the identity bound during Worker enrollment.",
      );
    }
    return composeServiceConfiguration({
      platform: "linux",
      role: "worker",
      instanceId: options.instanceId,
      deviceId: configuration.deviceId,
      bundle: { version, sourceDirectory: serviceBundleDirectory, checksum },
      sourceCheckoutDirectory: platformPath(family, options.sourceCheckoutRoot),
      installRoot: platformPath(family, options.installRoot),
      dataRoot: platformPath(family, options.dataRoot),
      ownerSession: {
        ...ownerSession,
        adminAutoOpen: { enabled: false },
      },
      serviceIdentity: {
        userName: serviceIdentity.userName,
        groupName: serviceIdentity.groupName,
      },
      ipcTrust: {
        core: servicePreparation.ipcTrust.core,
      },
      secretReferences: {
        coreIpcSigningKey: `secret://worker/${WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS}`,
      },
      systemdCredential: {
        credentialName: configuration.secretBackend.credentialName,
        encryptedSourcePath: configuration.secretBackend.encryptedCredentialFile,
      },
      healthPort: options.healthPort,
    });
  }
  if (configuration.secretBackend.backend !== "windows-service-dpapi") {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Stage this enrolled Windows Worker with windows-service-secret-stage before composing its service document.",
    );
  }
  const servicePreparation = configuration.secretBackend.servicePreparation;
  if (servicePreparation === undefined) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "This Worker has no public service-preparation binding. If its handoff is owner-restorable, run windows-service-secret-restore and stage again; otherwise use a new owner-approved re-credentialing Grant before staging again.",
    );
  }

  const ownerSession = options.ownerSession ?? (await resolveWindowsOwnerSession());

  return composeServiceConfiguration({
    platform: family,
    role: "worker",
    instanceId: options.instanceId,
    deviceId: configuration.deviceId,
    bundle: { version, sourceDirectory: serviceBundleDirectory, checksum },
    sourceCheckoutDirectory: platformPath(family, options.sourceCheckoutRoot),
    installRoot: platformPath(family, options.installRoot),
    dataRoot: platformPath(family, options.dataRoot),
    ownerSession: {
      userName: ownerSession.userName,
      stableUserId: ownerSession.stableUserId,
      // A Worker never opens Admin: the configuration reader rejects it outright.
      adminAutoOpen: { enabled: false },
    },
    ipcTrust: {
      core: servicePreparation.ipcTrust.core,
      helper: servicePreparation.ipcTrust.helper,
    },
    secretReferences: {
      coreIpcSigningKey: `secret://worker/${WORKER_SESSION_HELPER_CORE_SIGNING_SECRET_ALIAS}`,
      helperIpcSigningKey: `secret://worker/${WORKER_SESSION_HELPER_OWNER_SIGNING_SECRET_ALIAS}`,
    },
    healthPort: options.healthPort,
    windowsOwnerHelperVaultRoot: platformPath(
      family,
      servicePreparation.ownerHelperSecretBinding.vaultRoot,
    ),
    windowsServiceSecretBinding: {
      backend: configuration.secretBackend.backend,
      handoffRoot: platformPath(family, configuration.secretBackend.handoffRoot),
      serviceName: configuration.secretBackend.serviceName,
      serviceSid: configuration.secretBackend.serviceSid,
      vaultRoot: platformPath(family, configuration.secretBackend.vaultRoot),
    },
  });
}

function platformPath(family: PlatformFamily, value: string): string {
  return family === "windows" ? win32.resolve(value) : posix.normalize(value);
}

function requireUnixOwnerSession(value: BuildWorkerServiceDocumentOptions["ownerSession"]): {
  readonly userName: string;
  readonly stableUserId: string;
  readonly uid: number;
  readonly homeDirectory: string;
} {
  if (
    value === undefined ||
    !Number.isSafeInteger(value.uid) ||
    (value.uid ?? -1) < 0 ||
    value.stableUserId !== String(value.uid) ||
    value.homeDirectory === undefined
  ) {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "Linux service-document requires the installation owner's user name, numeric UID, and home directory.",
    );
  }
  return {
    userName: value.userName,
    stableUserId: value.stableUserId,
    uid: value.uid!,
    homeDirectory: value.homeDirectory,
  };
}

/**
 * The checksum the install preflight recomputes: the digest of the bundle's own
 * SHA256SUMS manifest, not of any one payload file.
 */
async function readBundleChecksum(bundleDirectory: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readStableWorkerFile(
      join(bundleDirectory, "SHA256SUMS"),
      MAXIMUM_CHECKSUM_MANIFEST_BYTES,
    );
  } catch {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The release bundle has no stable, bounded SHA256SUMS manifest, so its checksum cannot be stated.",
    );
  }
  try {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    bytes.fill(0);
  }
}

async function readBundleVersion(bundleDirectory: string): Promise<string> {
  let parsed: unknown;
  let bytes: Buffer | undefined;
  try {
    bytes = await readStableWorkerFile(
      join(bundleDirectory, "release-metadata.json"),
      MAXIMUM_RELEASE_METADATA_BYTES,
    );
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new WorkerAppError(
      "CONFIG_INVALID",
      "The release bundle has no stable, bounded, readable release metadata.",
    );
  } finally {
    bytes?.fill(0);
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

function platformFamily(value: NodeJS.Platform): PlatformFamily | undefined {
  return value === "win32"
    ? "windows"
    : value === "darwin"
      ? "macos"
      : value === "linux"
        ? "linux"
        : undefined;
}
