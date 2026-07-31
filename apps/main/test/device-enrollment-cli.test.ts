import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  SecretAvailability,
} from "@opendelegate/secrets";

import { parseArguments } from "../src/cli.ts";
import { executeWithMainDeviceChannelDatabase } from "../src/device-enrollment-cli.ts";

test("CLI accepts secret-free Main Device channel setup and a bounded owner grant command", () => {
  const configuration = resolve("device-channel.json");
  const home = resolve("runtime-home");
  const output = join(tmpdir(), "worker.enrollment.json");
  const initialized = parseArguments(["init", "--device-channel-config", configuration]);
  assert.equal(initialized.deviceEnrollmentConfigurationFile, configuration);

  const parsed = parseArguments([
    "device",
    "grant",
    "--home",
    home,
    "--device-id",
    "device-worker-nas",
    "--output",
    output,
    "--expires-seconds",
    "45",
    "--role",
    "worker",
    "--role",
    "storage",
  ]);
  assert.deepEqual(parsed.device, {
    command: "grant",
    home,
    deviceId: "device-worker-nas",
    outputPath: output,
    expiresInMs: 45_000,
    intent: "enroll",
    allowedBootstrapRoles: ["worker", "storage"],
  });
});

test("a grant re-credentials an existing Device only when the owner asks outright", () => {
  const output = join(tmpdir(), "worker.enrollment.json");
  const base = ["device", "grant", "--device-id", "Windows_5090", "--output", output];

  const parsed = parseArguments([...base, "--recredential"]);
  assert.deepEqual(parsed.device, {
    command: "grant",
    deviceId: "Windows_5090",
    outputPath: output,
    expiresInMs: 300_000,
    intent: "recredential",
    allowedBootstrapRoles: ["worker"],
  });

  // Omission cannot reach re-credentialing, and the flag takes no value that a
  // stray argument could be swallowed into.
  assert.equal((parseArguments(base).device as { readonly intent: string }).intent, "enroll");
  assert.throws(() => parseArguments([...base, "--recredential", "--recredential"]), /only once/u);
  assert.deepEqual(
    (
      parseArguments([...base, "--recredential", "--role", "storage"]).device as {
        readonly allowedBootstrapRoles: readonly string[];
      }
    ).allowedBootstrapRoles,
    ["storage"],
  );
});

test("CLI rejects grant secrets, unsafe lifetimes, relative output, and serve-time source replacement", () => {
  const output = join(tmpdir(), "worker.enrollment.json");
  assert.throws(
    () =>
      parseArguments([
        "device",
        "grant",
        "--device-id",
        "device-worker",
        "--output",
        output,
        "--token",
        "must-never-enter-argv",
      ]),
    /Unknown Device option/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "device",
        "grant",
        "--device-id",
        "device-worker",
        "--output",
        output,
        "--expires-seconds",
        "29",
      ]),
    /30 through 1800/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "device",
        "grant",
        "--device-id",
        "device-worker",
        "--output",
        "relative-grant.json",
      ]),
    /absolute/u,
  );
  assert.throws(
    () => parseArguments(["serve", "--device-channel-config", "device-channel.json"]),
    /available only with init/u,
  );
});

test("Device enrollment resolves SQLite and PostgreSQL inside a managed callback", async () => {
  let observed: unknown;
  await executeWithMainDeviceChannelDatabase(
    { adapter: "sqlite" },
    resolve("state/main.sqlite3"),
    new DatabaseSecretStore("postgresql://database.example.test/opendelegate"),
    (database) => {
      observed = database;
    },
  );
  assert.deepEqual(observed, {
    adapter: "sqlite",
    filename: resolve("state/main.sqlite3"),
  });
  await executeWithMainDeviceChannelDatabase(
    {
      adapter: "postgresql",
      uriRef: "secret://main/database-primary",
      schema: "opendelegate",
    },
    resolve("unused.sqlite3"),
    new DatabaseSecretStore("postgresql://database.example.test/opendelegate"),
    (database) => {
      observed = database;
    },
  );
  assert.deepEqual(observed, {
    adapter: "postgresql",
    connectionString: "postgresql://database.example.test/opendelegate",
    schema: "opendelegate",
  });
  await assert.rejects(
    executeWithMainDeviceChannelDatabase(
      {
        adapter: "postgresql",
        uriRef: "secret://main/database-primary",
      },
      resolve("unused.sqlite3"),
      new DatabaseSecretStore(undefined),
      () => undefined,
    ),
    /Secret reference/u,
  );
});

class DatabaseSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi";
  public readonly deviceId = "device_main";
  readonly #value: string | undefined;

  public constructor(value: string | undefined) {
    this.#value = value;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    return { backend: this.backend, deviceId: this.deviceId, status: "ready" };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#value !== undefined };
  }

  public async store(): Promise<ManagedSecretMutation> {
    return { status: "stored" };
  }

  public async rotate(): Promise<ManagedSecretMutation> {
    return { status: "rotated" };
  }

  public async delete(): Promise<ManagedSecretDeletion> {
    return { status: "absent" };
  }

  public async executeWithSecretBytes(
    _alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    if (this.#value === undefined) {
      throw new Error("unavailable");
    }
    const value = Buffer.from(this.#value, "utf8");
    try {
      await executor(value);
    } finally {
      value.fill(0);
    }
  }
}
