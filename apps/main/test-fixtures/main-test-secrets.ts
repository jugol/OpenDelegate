import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";
import { buildMacOsKeychainHelper } from "../../../packages/secrets/native/macos/build.mjs";

import type { MainSecretBackendConfiguration } from "../src/main-secret-backend.ts";

export interface MainTestSecretContext {
  readonly configuration: MainSecretBackendConfiguration;
  readonly store: MainTestManagedSecretStore;
}

export interface MainProcessTestSecretContext extends MainTestSecretContext {
  readonly environment: Readonly<Record<string, string>>;
}

export class MainTestManagedSecretStore implements ManagedSecretStore {
  public readonly backend: ManagedSecretStore["backend"];
  public readonly deviceId: string;
  readonly #values = new Map<string, Buffer>();

  public constructor(input: {
    readonly backend: ManagedSecretStore["backend"];
    readonly deviceId?: string;
  }) {
    this.backend = input.backend;
    this.deviceId = input.deviceId ?? "device_main_test";
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return {
      backend: this.backend,
      deviceId: this.deviceId,
      status: "ready",
    };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#values.has(alias) };
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (this.#values.has(alias)) {
      throw new Error("The test Secret alias already exists.");
    }
    this.#values.set(alias, Buffer.from(value));
    return { status: "stored" };
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    if (!this.#values.has(alias)) {
      throw new Error("The test Secret alias is unavailable.");
    }
    this.#values.get(alias)?.fill(0);
    this.#values.set(alias, Buffer.from(value));
    return { status: "rotated" };
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    const stored = this.#values.get(alias);
    stored?.fill(0);
    return { status: this.#values.delete(alias) ? "deleted" : "absent" };
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const stored = this.#values.get(alias);
    if (stored === undefined) {
      throw new Error("The test Secret alias is unavailable.");
    }
    const scoped = Buffer.from(stored);
    try {
      await executor(scoped);
    } finally {
      scoped.fill(0);
    }
  }
}

export function createMainTestSecretContext(
  root: string,
  options: { readonly deviceId?: string } = {},
): MainTestSecretContext {
  const configuration = mainTestSecretBackendConfiguration(root);
  return {
    configuration,
    store: new MainTestManagedSecretStore({
      backend: configuration.backend,
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    }),
  };
}

export async function createMainProcessTestSecretContext(
  root: string,
  options: { readonly deviceId?: string } = {},
): Promise<MainProcessTestSecretContext> {
  if (process.platform === "darwin") {
    const built = await buildMacOsKeychainHelper({ outputRoot: root });
    const helperBytes = await readFile(built.helperExecutable);
    try {
      const configuration: MainSecretBackendConfiguration = {
        backend: "macos-keychain",
        helperPath: built.helperExecutable,
        expectedHelperSha256: `sha256:${createHash("sha256").update(helperBytes).digest("hex")}`,
      };
      return {
        configuration,
        store: new MainTestManagedSecretStore({
          backend: configuration.backend,
          ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
        }),
        environment: {},
      };
    } finally {
      helperBytes.fill(0);
    }
  }

  if (process.platform !== "linux") {
    return {
      ...createMainTestSecretContext(root, options),
      environment: {},
    };
  }

  const secretToolPath = join(root, "fixture-secret-tool");
  await writeFile(
    secretToolPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  search) exit 0 ;;",
      "  lookup) exit 1 ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const configuration: MainSecretBackendConfiguration = {
    backend: "linux-secret-service",
    secretToolPath,
  };
  return {
    configuration,
    store: new MainTestManagedSecretStore({
      backend: configuration.backend,
      ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
    }),
    environment: {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "fixture-dbus")}`,
      XDG_RUNTIME_DIR: root,
    },
  };
}

export function mainTestSecretBackendConfiguration(root: string): MainSecretBackendConfiguration {
  switch (process.platform) {
    case "win32":
      return {
        backend: "windows-dpapi",
        vaultRoot: join(root, "secrets", "main"),
      };
    case "darwin":
      return {
        backend: "macos-keychain",
        helperPath: join(root, "opendelegate-keychain-helper"),
        expectedHelperSha256: `sha256:${"0".repeat(64)}`,
      };
    case "linux":
      return {
        backend: "linux-systemd-credential-vault",
        credentialName: "opendelegate-main-vault-key",
        vaultRoot: join(root, "secrets", "main"),
      };
    default:
      throw new Error(`Unsupported test platform: ${process.platform}`);
  }
}
