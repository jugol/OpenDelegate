import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { withHostRuntimePermissionEnforcerForTest } from "../src/internal/runtime-permissions.ts";
import {
  createMainRuntime,
  initializeMainHome,
  MainRuntimeError,
  type MainRuntime,
} from "../src/index.ts";
import { createMainTestSecretContext } from "../test-fixtures/main-test-secrets.ts";

const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;

test("public Main APIs cross the host permission boundary before and after managed writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-runtime-permission-port-"));
  const home = join(root, "home");
  let runtime: MainRuntime | undefined;
  t.after(async () => {
    await runtime?.close();
    await rm(root, { force: true, recursive: true });
  });
  const mainSecrets = createMainTestSecretContext(root);
  const adminRoot = await createAdminFixture(root);
  const observations: string[][] = [];

  await withHostRuntimePermissionEnforcerForTest(
    async ({ root: permissionRoot }) => {
      assert.equal(permissionRoot, await realpath(home));
      observations.push([
        await readFile(join(permissionRoot, "config", "main.json"), "utf8")
          .then(() => "configuration-present")
          .catch(() => "configuration-absent"),
      ]);
    },
    async () => {
      const initialized = await initializeMainHome({
        home,
        adminRoot,
        sourceCheckout: resolve("."),
        secretBackend: mainSecrets.configuration,
        managedSecretStore: mainSecrets.store,
      });
      runtime = await createMainRuntime({
        configuration: initialized.configuration,
        home,
        build: { version: "0.1.0-test", buildId: "runtime-permission-port" },
        releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
        sourceCheckout: resolve("."),
        managedSecretStore: mainSecrets.store,
      });
    },
  );

  assert.equal(observations.length, 4);
  assert.equal(observations[0]?.[0], "configuration-absent");
  assert.equal(observations[1]?.[0], "configuration-present");
  assert.equal(observations[2]?.[0], "configuration-present");
  assert.equal(observations[3]?.[0], "configuration-present");
});

test("managed link validation rejects before a test host permission enforcer can run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-runtime-permission-links-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const outside = join(root, "outside");
  await Promise.all([mkdir(home), mkdir(outside)]);
  await symlink(outside, join(home, "config"), process.platform === "win32" ? "junction" : "dir");
  const adminRoot = await createAdminFixture(root);
  let enforcementCalls = 0;

  await assert.rejects(
    withHostRuntimePermissionEnforcerForTest(
      async () => {
        enforcementCalls += 1;
      },
      () =>
        initializeMainHome({
          home,
          adminRoot,
          sourceCheckout: resolve("."),
        }),
    ),
    (error: unknown) => error instanceof MainRuntimeError && error.code === "RUNTIME_PATH_UNSAFE",
  );
  assert.equal(enforcementCalls, 0);
  assert.equal(await readFile(join(outside, "main.json"), "utf8").catch(() => null), null);
});

async function createAdminFixture(parent: string): Promise<string> {
  const root = join(parent, "admin-dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    '<!doctype html><title>OpenDelegate test shell</title><div id="root"></div>',
  );
  await writeFile(join(root, "assets", "app.js"), "console.log('test');");
  return root;
}
