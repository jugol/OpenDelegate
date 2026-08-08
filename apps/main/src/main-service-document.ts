import { writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

import {
  parsePlatformServiceConfiguration,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

import type { MainConfiguration } from "./index.ts";
import { ServiceLifecycleCliError } from "./service-lifecycle.ts";

export interface ParsedMainServiceDocumentArguments {
  readonly workerConfigurationPath: string;
  readonly outputPath: string;
  readonly home: string;
}

export function parseMainServiceDocumentArguments(
  values: readonly string[],
): ParsedMainServiceDocumentArguments {
  let workerConfigurationPath: string | undefined;
  let outputPath: string | undefined;
  let home: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option !== "--worker-config" && option !== "--output" && option !== "--home") {
      throw argumentError(`Unknown service document option: ${String(option)}.`);
    }
    const target = values[index + 1];
    if (target === undefined || target.startsWith("--") || target.trim() === "") {
      throw argumentError(`${option} requires a value.`);
    }
    if (option === "--worker-config") {
      workerConfigurationPath = resolve(target);
    } else if (option === "--output") {
      outputPath = resolve(target);
    } else {
      home = resolve(target);
    }
    index += 1;
  }
  if (workerConfigurationPath === undefined || outputPath === undefined || home === undefined) {
    throw argumentError("service document requires --worker-config, --output, and --home.");
  }
  if (workerConfigurationPath === outputPath) {
    throw argumentError("The Worker input and Main output paths must be different.");
  }
  return Object.freeze({ workerConfigurationPath, outputPath, home });
}

export function composeHeadlessLinuxMainServiceDocument(input: {
  readonly main: MainConfiguration;
  readonly home: string;
  readonly workerConfiguration: PlatformServiceConfiguration;
}): PlatformServiceConfiguration {
  const worker = parsePlatformServiceConfiguration(structuredClone(input.workerConfiguration));
  if (
    worker.platform !== "linux" ||
    worker.role !== "worker" ||
    worker.helperSecretBinding !== null ||
    worker.systemdCredential === undefined ||
    worker.systemdCredential === null ||
    worker.ipcTrust.helper !== undefined ||
    Object.hasOwn(worker.secretReferences, "helperIpcSigningKey")
  ) {
    throw configurationError(
      "Main service composition requires an explicitly headless Linux Worker document.",
    );
  }
  if (worker.instanceId !== input.main.instanceId || worker.deviceId !== input.main.deviceId) {
    throw configurationError(
      "The co-located Worker service identity does not match the initialized Main.",
    );
  }
  if (posix.resolve(input.home) !== posix.resolve(worker.paths.stateRoot)) {
    throw configurationError(
      "The Main home must be the same state root prepared for its co-located Worker.",
    );
  }
  const backend = input.main.secretBackend;
  if (
    backend.backend !== "linux-systemd-credential-vault" ||
    backend.credentialName !== worker.systemdCredential.credentialName
  ) {
    throw configurationError(
      "Main and its co-located Worker must use the same named systemd credential.",
    );
  }
  if (
    backend.encryptedCredentialFile !== undefined &&
    posix.resolve(backend.encryptedCredentialFile) !==
      posix.resolve(worker.systemdCredential.encryptedSourcePath)
  ) {
    throw configurationError(
      "Main and its co-located Worker must use the same encrypted systemd credential source.",
    );
  }
  return parsePlatformServiceConfiguration({
    ...structuredClone(worker),
    role: "main",
    ownerSession: {
      ...structuredClone(worker.ownerSession),
      adminAutoOpen: { enabled: false },
    },
  });
}

export async function writeMainServiceDocument(input: {
  readonly outputPath: string;
  readonly configuration: PlatformServiceConfiguration;
}): Promise<void> {
  try {
    await writeFile(input.outputPath, `${JSON.stringify(input.configuration, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new ServiceLifecycleCliError(
      "SERVICE_CONFIGURATION_INVALID",
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "The Main service document output already exists; OpenDelegate will not overwrite reviewed install input."
        : "The Main service document could not be created safely.",
      { cause: error },
    );
  }
}

function argumentError(message: string): ServiceLifecycleCliError {
  return new ServiceLifecycleCliError("SERVICE_ARGUMENT_INVALID", message);
}

function configurationError(message: string): ServiceLifecycleCliError {
  return new ServiceLifecycleCliError("SERVICE_CONFIGURATION_INVALID", message);
}
