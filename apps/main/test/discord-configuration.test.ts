import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import {
  MainDiscordConfigurationError,
  createMainDiscordComposition,
  loadMainDiscordConfigurationSource,
  provisionMainDiscordBotCredential,
  validateMainDiscordConfiguration,
  type MainDiscordComposition,
  type MainDiscordConfiguration,
  type MainDiscordSecretBackendConfiguration,
} from "../src/discord-configuration.ts";
import { initializeMainHome, loadMainConfiguration } from "../src/index.ts";

test("a stable owner-selected Discord file persists only IDs, backend metadata, and an alias", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-discord-config-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "discord.json");
  const source = configuration(root);
  await writeFile(path, `${JSON.stringify(source, null, 2)}\n`);

  const loaded = await loadMainDiscordConfigurationSource(path);
  assert.deepEqual(loaded, source);
  assert.doesNotMatch(JSON.stringify(loaded), /discord\.fixture\.credential/iu);

  const composition = createMainDiscordComposition({
    configuration: loaded,
    deviceId: "device_main",
    sourceCheckout: resolve("."),
    environment: process.env,
  });
  assert.equal(composition.botTokenAlias, "discord-bot");
  assert.equal(composition.secretStore.deviceId, "device_main");
  assert.equal(composition.config.forumBindings[0]?.channelId, "100000000000000003");
});

test("Discord configuration rejects unknown credential-bearing fields and malformed bindings", () => {
  const valid = configuration(resolve("."));
  assert.throws(
    () =>
      validateMainDiscordConfiguration({
        ...valid,
        botToken: "discord.fixture.credential",
      }),
    (error: unknown) =>
      error instanceof MainDiscordConfigurationError &&
      !error.message.includes("discord.fixture.credential"),
  );
  assert.throws(() =>
    validateMainDiscordConfiguration({
      ...valid,
      forum: {
        ...valid.forum,
        ownerUserIds: [],
      },
    }),
  );
});

test("bounded local provisioning stores or rotates bytes only through the managed store", async () => {
  const store = new TestManagedSecretStore();
  const composition: MainDiscordComposition = {
    config: configuration(resolve(".")).forum,
    botTokenAlias: "discord-bot",
    secretStore: store,
  };
  await provisionMainDiscordBotCredential({
    composition,
    secret: Buffer.from("discord.fixture.credential", "ascii"),
  });
  assert.equal(store.stores, 1);
  assert.equal(store.rotations, 0);
  assert.equal(store.lastValue, "discord.fixture.credential");

  await provisionMainDiscordBotCredential({
    composition,
    secret: Buffer.from("discord.fixture.credential", "ascii"),
  });
  assert.equal(store.stores, 1);
  assert.equal(store.rotations, 1);
  assert.equal(store.lastValue, "discord.fixture.credential");

  await assert.rejects(
    provisionMainDiscordBotCredential({
      composition,
      secret: Buffer.alloc(0),
    }),
    (error: unknown) =>
      error instanceof MainDiscordConfigurationError &&
      !error.message.includes("discord.fixture.credential"),
  );
});

test("Main initialization persists the validated binding while disabled remains the default", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opendelegate-discord-main-config-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const adminRoot = join(home, "admin");
  await mkdir(adminRoot);
  await writeFile(join(adminRoot, "index.html"), "<!doctype html><title>OpenDelegate</title>");
  const discord = configuration(home);

  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    discord,
  });
  assert.deepEqual(initialized.configuration.discord, discord);
  assert.deepEqual(
    (await loadMainConfiguration(initialized.paths.configurationFile)).discord,
    discord,
  );
  assert.doesNotMatch(
    await readFile(initialized.paths.configurationFile, "utf8"),
    /discord\.fixture\.credential/iu,
  );
});

function configuration(root: string): MainDiscordConfiguration {
  return {
    schemaVersion: 1,
    enabled: true,
    botTokenAlias: "discord-bot",
    forum: {
      applicationId: "100000000000000001",
      botUserId: "100000000000000002",
      guildId: "100000000000000003",
      forumBindings: [
        {
          channelId: "100000000000000003",
          workflowTagIds: {
            intake: "200000000000000001",
            running: "200000000000000002",
            waiting: "200000000000000003",
            review: "200000000000000004",
            done: "200000000000000005",
            failed: "200000000000000006",
          },
        },
      ],
      ownerUserIds: ["100000000000000004"],
      allowedRoleIds: [],
    },
    secretBackend: secretBackend(root),
  };
}

function secretBackend(root: string): MainDiscordSecretBackendConfiguration {
  switch (process.platform) {
    case "win32":
      return {
        backend: "windows-dpapi",
        vaultRoot: join(root, "secrets", "discord"),
      };
    case "darwin":
      return {
        backend: "macos-keychain",
        helperPath: join(root, "opendelegate-keychain-helper"),
        expectedHelperSha256: `sha256:${"0".repeat(64)}`,
      };
    default:
      return {
        backend: "linux-secret-service",
        secretToolPath: "/usr/bin/secret-tool",
      };
  }
}

class TestManagedSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi";
  public readonly deviceId = "device_main";
  public stores = 0;
  public rotations = 0;
  public lastValue: string | undefined;
  #ready = false;

  public async health(): Promise<ManagedSecretStoreHealth> {
    return {
      backend: this.backend,
      deviceId: this.deviceId,
      status: "ready",
    };
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    return { alias, ready: this.#ready };
  }

  public async store(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.stores += 1;
    this.#ready = true;
    this.lastValue = Buffer.from(value).toString("ascii");
    return { status: "stored" };
  }

  public async rotate(_alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    this.rotations += 1;
    this.lastValue = Buffer.from(value).toString("ascii");
    return { status: "rotated" };
  }

  public async delete(_alias: string): Promise<ManagedSecretDeletion> {
    this.#ready = false;
    return { status: "deleted" };
  }

  public async executeWithSecretBytes(
    _alias: string,
    _executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    throw new Error("not used");
  }
}
