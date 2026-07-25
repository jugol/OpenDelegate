import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MainSecretBackendConfigurationError,
  createMainManagedSecretStore,
  defaultMainSecretBackendConfiguration,
  loadMainSecretBackendConfigurationSource,
  validateMainSecretBackendConfiguration,
} from "../src/main-secret-backend.ts";

test("headless Linux has no implicit Secret Service fallback", async () => {
  await assert.rejects(
    defaultMainSecretBackendConfiguration({
      home: resolve("runtime"),
      sourceCheckout: resolve("."),
      hostPlatform: "linux",
      environment: {},
    }),
    (error: unknown) =>
      error instanceof MainSecretBackendConfigurationError &&
      /linux-systemd-credential-vault/u.test(error.message),
  );
});

test("an explicit systemd credential vault is persisted as non-secret metadata", () => {
  const configuration = validateMainSecretBackendConfiguration({
    backend: "linux-systemd-credential-vault",
    credentialName: "opendelegate-main-vault-key",
    vaultRoot: resolve("runtime/secrets/main"),
  });

  assert.equal(configuration.backend, "linux-systemd-credential-vault");
  assert.equal(configuration.credentialName, "opendelegate-main-vault-key");
  assert.doesNotMatch(JSON.stringify(configuration), /credential-value|password|token/u);
});

test("Linux Secret Service composition drops unrelated process environment", () => {
  const store = createMainManagedSecretStore({
    configuration: {
      backend: "linux-secret-service",
      secretToolPath: resolve("runtime/fixture-secret-tool"),
    },
    deviceId: "device_main_linux_secret_service",
    sourceCheckout: resolve("."),
    hostPlatform: "linux",
    environment: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: resolve("runtime/xdg"),
      PATH: "must-not-reach-the-secret-store",
      OPENDELEGATE_UNRELATED: "must-not-reach-the-secret-store",
    },
  });

  assert.equal(store.backend, "linux-secret-service");
  assert.equal(store.deviceId, "device_main_linux_secret_service");
});

test("the owner-selected backend document is stable, bounded, and exact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-secret-backend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "secret-backend.json");
  const configuration = {
    backend: "windows-dpapi" as const,
    vaultRoot: join(root, "vault"),
  };
  await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`);

  assert.deepEqual(await loadMainSecretBackendConfigurationSource(path), configuration);
  assert.throws(() =>
    validateMainSecretBackendConfiguration({
      ...configuration,
      rawSecret: "must-not-be-accepted",
    }),
  );
});
