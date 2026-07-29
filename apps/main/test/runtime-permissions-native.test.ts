import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createMainRuntime,
  initializeMainHome,
  MainRuntimeError,
  type MainRuntime,
} from "../src/index.ts";
import { createMainTestSecretContext } from "../test-fixtures/main-test-secrets.ts";

const execFileAsync = promisify(execFile);
const DEVELOPMENT_RELEASE_IDENTITY = {
  declaredReleaseChannel: "development",
  releaseChannel: "development",
  releaseVerification: { status: "not-applicable" },
} as const;

test(
  "production Main APIs enforce native runtime permissions before and after managed writes",
  { timeout: 240_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "opendelegate-runtime-permissions-native-"));
    const home = join(root, "home");
    const cleanup: { runtime?: MainRuntime } = {};
    t.after(async () => {
      await cleanup.runtime?.close();
      await rm(root, { force: true, recursive: true });
    });
    await mkdir(home, { mode: 0o777 });
    const adminRoot = await createAdminFixture(root);
    const mainSecrets = createMainTestSecretContext(root);

    await weakenRuntimePermissions(home);
    const initialized = await initializeMainHome({
      home,
      adminRoot,
      sourceCheckout: resolve("."),
      secretBackend: mainSecrets.configuration,
      managedSecretStore: mainSecrets.store,
    });

    await weakenRuntimePermissions(home, join(initialized.paths.configDirectory, "main.json"));
    cleanup.runtime = await createMainRuntime({
      configuration: initialized.configuration,
      home,
      build: { version: "0.1.0-test", buildId: "native-runtime-permissions" },
      releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
      sourceCheckout: resolve("."),
      managedSecretStore: mainSecrets.store,
    });

    if (process.platform === "win32") {
      const stateEntries = await readdir(initialized.paths.stateDirectory);
      assert.ok(stateEntries.includes("main.sqlite3-wal"));
      assert.ok(stateEntries.includes("main.sqlite3-shm"));
    }
    await assertNativeRuntimePermissions(home);
  },
);

test("production Main treats controlled provider contents as opaque behind a sealed root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-provider-home-native-"));
  const home = join(root, "home");
  const outside = join(root, "provider-executable");
  const cleanup: { runtime?: MainRuntime } = {};
  t.after(async () => {
    await cleanup.runtime?.close();
    await rm(root, { force: true, recursive: true });
  });
  const adminRoot = await createAdminFixture(root);
  const mainSecrets = createMainTestSecretContext(root);
  const initialized = await initializeMainHome({
    home,
    adminRoot,
    sourceCheckout: resolve("."),
    secretBackend: mainSecrets.configuration,
    managedSecretStore: mainSecrets.store,
  });
  const providerArgumentRoot = join(
    initialized.paths.stateDirectory,
    "providers",
    "codex",
    "tmp",
    "arg0",
    "codex-arg0-fixture",
  );
  await Promise.all([
    mkdir(providerArgumentRoot, { mode: 0o700, recursive: true }),
    mkdir(outside, { mode: 0o700 }),
  ]);
  await symlink(
    outside,
    join(providerArgumentRoot, "codex"),
    process.platform === "win32" ? "junction" : "dir",
  );

  cleanup.runtime = await createMainRuntime({
    configuration: initialized.configuration,
    home,
    build: { version: "0.1.0-test", buildId: "provider-home-native" },
    releaseIdentity: DEVELOPMENT_RELEASE_IDENTITY,
    sourceCheckout: resolve("."),
    managedSecretStore: mainSecrets.store,
  });

  const providerRoot = join(initialized.paths.stateDirectory, "providers", "codex");
  const providerMetadata = await lstat(providerRoot);
  assert.equal(providerMetadata.isDirectory(), true);
  assert.equal(providerMetadata.isSymbolicLink(), false);
  if (process.platform !== "win32") {
    assert.equal(providerMetadata.mode & 0o077, 0);
  }
});

test("production Main rejects a runtime junction without mutating its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opendelegate-runtime-junction-native-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const outside = join(root, "outside");
  await Promise.all([mkdir(home), mkdir(outside)]);
  await symlink(outside, join(home, "config"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    initializeMainHome({
      home,
      adminRoot: await createAdminFixture(root),
      sourceCheckout: resolve("."),
    }),
    (error: unknown) => error instanceof MainRuntimeError && error.code === "RUNTIME_PATH_UNSAFE",
  );
  assert.equal(await readFile(join(outside, "main.json"), "utf8").catch(() => null), null);
});

async function weakenRuntimePermissions(root: string, regularFile?: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("icacls.exe", [root, "/grant", "*S-1-5-11:(OI)(CI)RX", "/L", "/Q"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return;
  }
  await chmod(root, 0o777);
  if (regularFile !== undefined) {
    await chmod(regularFile, 0o666);
  }
}

async function assertNativeRuntimePermissions(root: string): Promise<void> {
  if (process.platform === "win32") {
    await assertWindowsRuntimePermissions(root);
    return;
  }
  await assertPosixRuntimePermissions(root);
}

async function assertPosixRuntimePermissions(root: string): Promise<void> {
  const currentUid = process.getuid?.();
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    assert.ok(path);
    const metadata = await lstat(path);
    assert.equal(metadata.mode & 0o077, 0, `${path} grants group or world access`);
    if (currentUid !== undefined) {
      assert.equal(metadata.uid, currentUid, `${path} is not owned by the current user`);
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        pending.push(join(path, entry.name));
      }
    }
  }
}

async function assertWindowsRuntimePermissions(root: string): Promise<void> {
  const verificationScript = String.raw`
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1")
$root = $env:OPENDELEGATE_TEST_ACL_ROOT
$currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$systemSid = "S-1-5-18"
$items = @((Get-Item -LiteralPath $root -Force)) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Runtime state contains a reparse point."
  }
  $acl = Get-Acl -LiteralPath $item.FullName
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne $currentSid -and $ownerSid -ne $systemSid) {
    throw "Unexpected owner '$ownerSid' on '$($item.FullName)'."
  }
  if ($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) {
    throw "Runtime root still inherits access rules."
  }
  $hasCurrent = $false
  $hasSystem = $false
  foreach ($rule in @($acl.Access)) {
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $isFullControl = (
      ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
      [System.Security.AccessControl.FileSystemRights]::FullControl
    )
    if (
      ($ruleSid -ne $currentSid -and $ruleSid -ne $systemSid) -or
      $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      -not $isFullControl
    ) {
      throw "Unexpected runtime access rule on '$($item.FullName)'."
    }
    if ($ruleSid -eq $currentSid -and $isFullControl) {
      $hasCurrent = $true
    }
    if ($ruleSid -eq $systemSid -and $isFullControl) {
      $hasSystem = $true
    }
  }
  if (-not $hasCurrent -or -not $hasSystem) {
    throw "Required runtime access rules are missing on '$($item.FullName)'."
  }
}
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verificationScript],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENDELEGATE_TEST_ACL_ROOT: root,
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
}

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
