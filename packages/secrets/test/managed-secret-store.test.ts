import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  SecretError,
  MacOsKeychainSecretStore,
  LinuxSecretServiceSecretStore,
  ManagedDeviceIdentitySecretStore,
  NodeNativeSecretCommandRunner,
  resolveWindowsServiceSid,
  SystemdCredentialKeyProvider,
  SystemdCredentialVaultSecretStore,
  WindowsDpapiSecretStore,
  WindowsServiceDpapiSecretHandoff,
  WindowsServiceDpapiSecretStore,
  type NativeSecretCommandRequest,
  type NativeSecretCommandResult,
  type NativeSecretCommandRunner,
  type SecretKeyProvider,
} from "../src/index.ts";

const deviceId = "device-linux";
const secretAlias = "device-identity.ca-key";

class StaticKeyProvider implements SecretKeyProvider {
  readonly #key: Uint8Array;

  public constructor(key: Uint8Array) {
    this.#key = key;
  }

  public async executeWithKey(
    executor: (key: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    const scoped = new Uint8Array(this.#key);
    try {
      await executor(scoped);
    } finally {
      scoped.fill(0);
    }
  }
}

test("the headless Linux vault stores only ciphertext and scopes binary Secret access", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-test-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const vaultRoot = join(fixtureRoot, "runtime", "secrets");
  const first = Uint8Array.from([0, 1, 2, 3, 254, 255]);
  const second = Uint8Array.from([9, 8, 7, 6, 5, 4]);
  const store = new SystemdCredentialVaultSecretStore({
    deviceId,
    hostPlatform: "linux",
    keyProvider: new StaticKeyProvider(new Uint8Array(32).fill(42)),
    sourceCheckoutRoot,
    vaultRoot,
  });

  try {
    assert.deepEqual(await store.health(), {
      backend: "linux-systemd-credential-vault",
      deviceId,
      status: "ready",
    });
    assert.deepEqual(await store.availability(secretAlias), {
      alias: secretAlias,
      ready: false,
    });

    await store.store(secretAlias, first);
    assert.deepEqual(await store.availability(secretAlias), {
      alias: secretAlias,
      ready: true,
    });

    const observed: number[][] = [];
    await store.executeWithSecretBytes(secretAlias, (value) => {
      observed.push([...value]);
    });
    assert.deepEqual(observed, [[...first]]);

    await assert.rejects(store.store(secretAlias, second), (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_ALIAS_CONFLICT");
      assert.equal(error.message.includes(Buffer.from(first).toString("base64")), false);
      return true;
    });

    await store.rotate(secretAlias, second);
    await store.executeWithSecretBytes(secretAlias, (value) => {
      observed.push([...value]);
    });
    assert.deepEqual(observed, [[...first], [...second]]);

    const persistedFiles = (await readdir(vaultRoot)).filter((name) => name.endsWith(".secret"));
    assert.equal(persistedFiles.length, 1);
    const persistedName = persistedFiles[0];
    if (persistedName === undefined) {
      throw new Error("Expected one encrypted Secret record.");
    }
    const persisted = await readFile(join(vaultRoot, persistedName));
    assert.equal(persisted.includes(Buffer.from(first)), false);
    assert.equal(persisted.includes(Buffer.from(second)), false);

    assert.deepEqual(await store.delete(secretAlias), { status: "deleted" });
    assert.deepEqual(await store.delete(secretAlias), { status: "absent" });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("an immutable release-path change does not orphan Device-local Secret records", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-upgrade-");
  const vaultRoot = join(fixtureRoot, "runtime", "secrets");
  const keyProvider = new StaticKeyProvider(new Uint8Array(32).fill(64));
  const secret = Buffer.from("survives-release-upgrade", "utf8");
  const beforeUpgrade = new SystemdCredentialVaultSecretStore({
    deviceId,
    hostPlatform: "linux",
    keyProvider,
    sourceCheckoutRoot: join(fixtureRoot, "releases", "v1"),
    vaultRoot,
  });

  try {
    await beforeUpgrade.store(secretAlias, secret);
    const afterUpgrade = new SystemdCredentialVaultSecretStore({
      deviceId,
      hostPlatform: "linux",
      keyProvider,
      sourceCheckoutRoot: join(fixtureRoot, "releases", "v2"),
      vaultRoot,
    });
    assert.equal((await afterUpgrade.availability(secretAlias)).ready, true);
    await afterUpgrade.executeWithSecretBytes(secretAlias, (value) => {
      assert.deepEqual([...value], [...secret]);
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("authenticated local-vault corruption fails closed and scoped plaintext is zeroed", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-corrupt-");
  const vaultRoot = join(fixtureRoot, "runtime", "secrets");
  const secret = Buffer.from("zero-after-callback-secret", "utf8");
  const store = new SystemdCredentialVaultSecretStore({
    deviceId,
    hostPlatform: "linux",
    keyProvider: new StaticKeyProvider(new Uint8Array(32).fill(77)),
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
    vaultRoot,
  });
  let callbackView: Uint8Array | undefined;

  try {
    await store.store(secretAlias, secret);
    await store.executeWithSecretBytes(secretAlias, (value) => {
      callbackView = value;
      assert.deepEqual([...value], [...secret]);
    });
    assert.equal(
      callbackView?.every((value) => value === 0),
      true,
    );

    const names = (await readdir(vaultRoot)).filter((name) => name.endsWith(".secret"));
    const name = names[0];
    if (name === undefined) {
      throw new Error("Expected one encrypted Secret record.");
    }
    const path = join(vaultRoot, name);
    const ciphertext = await readFile(path);
    const lastIndex = ciphertext.byteLength - 1;
    ciphertext[lastIndex] = (ciphertext[lastIndex] ?? 0) ^ 0xff;
    await writeFile(path, ciphertext);

    await assert.rejects(
      store.executeWithSecretBytes(secretAlias, () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CORRUPTED");
        assert.equal(error.message.includes(secret.toString("utf8")), false);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("Secret vault paths fail closed inside the source checkout or through a link", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-path-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const keyProvider = new StaticKeyProvider(new Uint8Array(32).fill(33));

  try {
    assert.throws(
      () =>
        new SystemdCredentialVaultSecretStore({
          deviceId,
          hostPlatform: "linux",
          keyProvider,
          sourceCheckoutRoot,
          vaultRoot: join(sourceCheckoutRoot, ".opendelegate", "secrets"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CONFIGURATION_INVALID");
        return true;
      },
    );

    assert.throws(
      () =>
        new SystemdCredentialVaultSecretStore({
          deviceId,
          hostPlatform: "linux",
          keyProvider,
          sourceCheckoutRoot,
          vaultRoot: fixtureRoot,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CONFIGURATION_INVALID");
        return true;
      },
    );

    const unclaimedRoot = join(fixtureRoot, "pre-existing-data");
    const sentinelPath = join(unclaimedRoot, "owner-file.txt");
    await mkdir(unclaimedRoot, { mode: 0o700 });
    await writeFile(sentinelPath, "owner data", { mode: 0o600 });
    const unclaimedStore = new SystemdCredentialVaultSecretStore({
      deviceId,
      hostPlatform: "linux",
      keyProvider,
      sourceCheckoutRoot,
      vaultRoot: unclaimedRoot,
    });
    await assert.rejects(
      unclaimedStore.store(secretAlias, Buffer.from("must-not-be-written")),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
        return true;
      },
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "owner data");

    if (process.platform !== "win32") {
      const vaultRoot = join(fixtureRoot, "runtime", "secrets");
      const store = new SystemdCredentialVaultSecretStore({
        deviceId,
        hostPlatform: "linux",
        keyProvider,
        sourceCheckoutRoot,
        vaultRoot,
      });
      await store.store(secretAlias, Buffer.from("linked-secret-record"));
      const [recordName] = (await readdir(vaultRoot)).filter((name) => name.endsWith(".secret"));
      if (recordName === undefined) {
        throw new Error("Expected one encrypted Secret record.");
      }
      const recordPath = join(vaultRoot, recordName);
      const outsidePath = join(fixtureRoot, "outside-record");
      await rm(recordPath);
      await writeFile(outsidePath, Buffer.from("not-a-secret-record"), {
        mode: 0o600,
      });
      await symlink(outsidePath, recordPath);
      await assert.rejects(
        store.executeWithSecretBytes(secretAlias, () => undefined),
        (error: unknown) => {
          assert.ok(error instanceof SecretError);
          assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
          return true;
        },
      );
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

class DpapiFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  readonly #plaintext: Uint8Array;

  public constructor(plaintext: Uint8Array) {
    this.#plaintext = plaintext;
  }

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    const script = request.args.at(-1) ?? "";
    if (script.includes("DirectorySecurity")) {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (script.includes("OpenDelegate DPAPI probe")) {
      return { exitCode: 0, stdout: Buffer.from("ready", "utf8") };
    }
    if (script.includes("ProtectedData]::Protect")) {
      return { exitCode: 0, stdout: Buffer.from("sealed-dpapi-record", "utf8") };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return { exitCode: 0, stdout: Buffer.from(this.#plaintext) };
    }
    return { exitCode: 0, stdout: Buffer.from("ready", "utf8") };
  }
}

class HostileDpapiRunner implements NativeSecretCommandRunner {
  readonly #privateValue: string;

  public constructor(privateValue: string) {
    this.#privateValue = privateValue;
  }

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    const script = request.args.at(-1) ?? "";
    if (script.includes("DirectorySecurity")) {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (script.includes("OpenDelegate DPAPI probe")) {
      return { exitCode: 0, stdout: Buffer.from("ready", "utf8") };
    }
    if (script.includes("ProtectedData]::Protect")) {
      return {
        exitCode: 55,
        stdout: Buffer.from(this.#privateValue, "utf8"),
      };
    }
    return { exitCode: 0, stdout: Buffer.from("ready", "utf8") };
  }
}

class WindowsServiceDpapiFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  public currentUserDpapiAvailable = true;
  public serviceDpapiNgUnprotectAvailable = true;
  public serviceDpapiUnprotectAvailable = true;
  public serviceIdentityAvailable = true;
  /** 1 seals to the service SID, 2 is the workgroup machine fallback. */
  public sealingMode = 1;
  public handoffAclAvailable = true;
  readonly #plaintext: Uint8Array;

  public constructor(plaintext: Uint8Array) {
    this.#plaintext = plaintext;
  }

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    const script = request.args.at(-1) ?? "";
    if (script.includes("OpenDelegate Windows service identity probe v1")) {
      return {
        exitCode: this.serviceIdentityAvailable ? 0 : 41,
        stdout: this.serviceIdentityAvailable ? Buffer.from("ready") : Buffer.alloc(0),
      };
    }
    if (script.includes("OpenDelegate Windows service DPAPI-NG protect v1")) {
      return {
        exitCode: 0,
        stdout: Buffer.concat([
          Buffer.from([this.sealingMode]),
          Buffer.from("sealed-service-handoff"),
        ]),
      };
    }
    if (script.includes("OpenDelegate Windows service DPAPI-NG unprotect v1")) {
      return this.serviceDpapiNgUnprotectAvailable
        ? { exitCode: 0, stdout: Buffer.from(this.#plaintext) }
        : { exitCode: 52, stdout: Buffer.alloc(0) };
    }
    if (script.includes("DirectorySecurity")) {
      return {
        exitCode: this.handoffAclAvailable ? 0 : 44,
        stdout: Buffer.alloc(0),
      };
    }
    if (script.includes("OpenDelegate DPAPI probe")) {
      return this.currentUserDpapiAvailable
        ? { exitCode: 0, stdout: Buffer.from("ready") }
        : { exitCode: 52, stdout: Buffer.alloc(0) };
    }
    if (script.includes("ProtectedData]::Protect")) {
      return this.currentUserDpapiAvailable
        ? { exitCode: 0, stdout: Buffer.from("sealed-service-dpapi-record") }
        : { exitCode: 52, stdout: Buffer.alloc(0) };
    }
    if (script.includes("ProtectedData]::Unprotect")) {
      return this.serviceDpapiUnprotectAvailable
        ? { exitCode: 0, stdout: Buffer.from(this.#plaintext) }
        : { exitCode: 52, stdout: Buffer.alloc(0) };
    }
    return { exitCode: 50, stdout: Buffer.alloc(0) };
  }
}

class KeychainFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  readonly #values = new Map<string, Buffer>();

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    if (request.executable.endsWith("codesign")) {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    const operationIndex = request.args[0] === "--" ? 2 : 0;
    const operation = request.args[operationIndex];
    const accountIndex = request.args.indexOf("--account");
    const alias = accountIndex < 0 ? "" : (request.args[accountIndex + 1] ?? "");
    if (operation === "status") {
      return { exitCode: 0, stdout: Buffer.from("ready") };
    }
    if (operation === "create") {
      if (this.#values.has(alias)) {
        return { exitCode: 10, stdout: Buffer.alloc(0) };
      }
      this.#values.set(alias, Buffer.from(request.stdin));
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (operation === "rotate") {
      if (!this.#values.has(alias)) {
        return { exitCode: 11, stdout: Buffer.alloc(0) };
      }
      this.#values.set(alias, Buffer.from(request.stdin));
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (operation === "read") {
      const value = this.#values.get(alias);
      return value === undefined
        ? { exitCode: 11, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.from(value) };
    }
    if (operation === "has") {
      return this.#values.has(alias)
        ? { exitCode: 0, stdout: Buffer.from("ready") }
        : { exitCode: 11, stdout: Buffer.alloc(0) };
    }
    if (operation === "delete") {
      return {
        exitCode: this.#values.delete(alias) ? 0 : 11,
        stdout: Buffer.alloc(0),
      };
    }
    return { exitCode: 12, stdout: Buffer.alloc(0) };
  }
}

class SecretToolFixtureRunner implements NativeSecretCommandRunner {
  public readonly requests: NativeSecretCommandRequest[] = [];
  #value: Buffer | undefined;

  public async run(request: NativeSecretCommandRequest): Promise<NativeSecretCommandResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      environment: { ...request.environment },
      stdin: Buffer.from(request.stdin),
    });
    const operation = request.args[0];
    if (operation === "search") {
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (operation === "lookup") {
      return this.#value === undefined
        ? { exitCode: 1, stdout: Buffer.alloc(0) }
        : { exitCode: 0, stdout: Buffer.concat([this.#value, Buffer.from("\n")]) };
    }
    if (operation === "store") {
      this.#value = Buffer.from(request.stdin);
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    if (operation === "clear") {
      this.#value = undefined;
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    }
    return { exitCode: 2, stdout: Buffer.alloc(0) };
  }
}

test("the graphical Linux Secret Service adapter uses secret-tool stdin without inherited environment", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-tool-shape-");
  const secretToolPath = join(fixtureRoot, "secret-tool");
  await writeFile(secretToolPath, "fixture", { mode: 0o700 });
  const secret = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);
  const runner = new SecretToolFixtureRunner();
  const store = new LinuxSecretServiceSecretStore({
    deviceId: "device-linux-desktop",
    environment: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    hostPlatform: "linux",
    runner,
    secretToolPath,
  });

  try {
    assert.equal((await store.health()).status, "ready");
    await store.store("agent-token", secret);
    await store.executeWithSecretBytes("agent-token", (value) => {
      assert.deepEqual([...value], [...secret]);
    });
    const metadata = JSON.stringify(
      runner.requests.map(({ args, environment, executable }) => ({
        args,
        environment,
        executable,
      })),
    );
    assert.equal(metadata.includes(Buffer.from(secret).toString("base64")), false);
    assert.equal(
      Object.keys(runner.requests.at(-1)?.environment ?? {}).some((name) =>
        /token|secret|password/iu.test(name),
      ),
      false,
    );
    const storeRequest = runner.requests.find(({ args }) => args[0] === "store");
    assert.equal(
      Buffer.from(storeRequest?.stdin ?? []).toString("utf8"),
      `ODSS1:${Buffer.from(secret).toString("base64")}`,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("platform adapters reject caller-defined credential-shaped child environments", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-secret-env-");
  const helperPath = join(fixtureRoot, "helper");
  await writeFile(helperPath, "fixture", { mode: 0o700 });
  const expectedHelperSha256 = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
  const forbidden = "environment-secret-value";

  try {
    assert.throws(
      () =>
        new WindowsDpapiSecretStore({
          deviceId: "device-windows",
          environment: { OPENDELEGATE_TOKEN: forbidden },
          hostPlatform: "win32",
          powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          runner: new DpapiFixtureRunner(Buffer.from(forbidden)),
          sourceCheckoutRoot: join(fixtureRoot, "checkout"),
          vaultRoot: join(fixtureRoot, "runtime", "windows-secrets"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CONFIGURATION_INVALID");
        assert.equal(error.message.includes(forbidden), false);
        return true;
      },
    );
    assert.throws(
      () =>
        new MacOsKeychainSecretStore({
          deviceId: "device-macos",
          environment: { API_KEY: forbidden },
          expectedHelperSha256,
          helperPath,
          hostPlatform: "darwin",
          runner: new KeychainFixtureRunner(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CONFIGURATION_INVALID");
        assert.equal(error.message.includes(forbidden), false);
        return true;
      },
    );
    assert.throws(
      () =>
        new LinuxSecretServiceSecretStore({
          deviceId: "device-linux",
          environment: { PASSWORD: forbidden },
          hostPlatform: "linux",
          runner: new SecretToolFixtureRunner(),
          secretToolPath: helperPath,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_CONFIGURATION_INVALID");
        assert.equal(error.message.includes(forbidden), false);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the signed macOS Keychain helper receives Secret bytes only through stdin", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-keychain-shape-");
  const helperPath = join(fixtureRoot, "opendelegate-keychain-helper");
  await writeFile(helperPath, "fixture", { mode: 0o700 });
  const expectedHelperSha256 = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
  const secret = Buffer.from("keychain-helper-secret", "utf8");
  const rotated = Buffer.from("keychain-helper-rotated", "utf8");
  const runner = new KeychainFixtureRunner();
  const store = new MacOsKeychainSecretStore({
    codesignPath: join(fixtureRoot, "codesign"),
    deviceId: "device-macos",
    expectedHelperSha256,
    helperPath,
    hostPlatform: "darwin",
    runner,
  });

  try {
    assert.equal((await store.health()).status, "ready");
    await store.store("agent-token", secret);
    await store.rotate("agent-token", rotated);
    await store.executeWithSecretBytes("agent-token", (value) => {
      assert.deepEqual([...value], [...rotated]);
    });
    assert.deepEqual(await store.delete("agent-token"), { status: "deleted" });

    const commandMetadata = JSON.stringify(
      runner.requests.map(({ args, environment, executable }) => ({
        args,
        environment,
        executable,
      })),
    );
    assert.equal(commandMetadata.includes(secret.toString("utf8")), false);
    assert.equal(commandMetadata.includes(rotated.toString("utf8")), false);
    const createRequest = runner.requests.find(({ args }) => args[0] === "create");
    assert.deepEqual(createRequest?.stdin, secret);
    const rotateRequest = runner.requests.find(({ args }) => args[0] === "rotate");
    assert.deepEqual(rotateRequest?.stdin, rotated);

    const requestCountBeforeTamper = runner.requests.length;
    await writeFile(helperPath, "tampered-helper", { mode: 0o700 });
    assert.equal((await store.health()).status, "unavailable");
    assert.equal(runner.requests.length, requestCountBeforeTamper);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the macOS System Keychain backend binds every operation and can stage through sudo", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-system-keychain-shape-");
  const helperPath = join(fixtureRoot, "opendelegate-keychain-helper");
  const bindingPath = join(fixtureRoot, "system-keychain-binding.json");
  await writeFile(helperPath, "fixture", { mode: 0o700 });
  const expectedHelperSha256 = `sha256:${createHash("sha256").update("fixture").digest("hex")}`;
  const runner = new KeychainFixtureRunner();
  const store = new MacOsKeychainSecretStore({
    bindingPath,
    codesignPath: join(fixtureRoot, "codesign"),
    deviceId: "device-macos-system",
    expectedHelperSha256,
    helperPath,
    hostPlatform: "darwin",
    runner,
    sudoPath: "/usr/bin/sudo",
  });
  const secret = Buffer.from("system-keychain-secret", "utf8");

  try {
    assert.equal(store.backend, "macos-system-keychain");
    assert.equal((await store.health()).status, "ready");
    await store.store("device-key", secret);
    await store.executeWithSecretBytes("device-key", (value) => {
      assert.deepEqual(value, secret);
    });
    const helperRequests = runner.requests.filter(({ args }) => args[0] === "--");
    assert.equal(helperRequests.length, 3);
    assert.equal(
      helperRequests.every(({ executable }) => executable === resolve("/usr/bin/sudo")),
      true,
    );
    assert.equal(
      helperRequests.every(({ args }) => {
        const bindingIndex = args.indexOf("--system-binding");
        return (
          args[0] === "--" &&
          args[1] === helperPath &&
          bindingIndex >= 0 &&
          args[bindingIndex + 1] === bindingPath
        );
      }),
      true,
    );
    assert.equal(
      JSON.stringify(helperRequests.map(({ args }) => args)).includes(secret.toString()),
      false,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Windows DPAPI adapter never places Secret material in argv or environment", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-dpapi-shape-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const vaultRoot = join(fixtureRoot, "runtime", "secrets");
  const secret = Buffer.from("dpapi-command-shape-secret", "utf8");
  const runner = new DpapiFixtureRunner(secret);
  const store = new WindowsDpapiSecretStore({
    deviceId: "device-windows",
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    sourceCheckoutRoot,
    vaultRoot,
  });

  try {
    assert.equal((await store.health()).status, "ready");
    await store.store("agent-token", secret);
    await store.executeWithSecretBytes("agent-token", (value) => {
      assert.deepEqual(value, secret);
    });

    const serializedArguments = JSON.stringify(
      runner.requests.map(({ args, environment, executable }) => ({
        args,
        environment,
        executable,
      })),
    );
    assert.equal(serializedArguments.includes(secret.toString("utf8")), false);
    const protectRequest = runner.requests.find((request) =>
      request.args.at(-1)?.includes("ProtectedData]::Protect($payload,$entropy"),
    );
    assert.notEqual(protectRequest, undefined);
    assert.deepEqual(
      protectRequest?.stdin.subarray(protectRequest.stdin.byteLength - secret.byteLength),
      secret,
    );
    assert.equal(
      runner.requests.every((request) => request.timeoutMs === 60_000),
      true,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a refused handoff ACL names the directory and what would satisfy it", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-acl-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const handoffRoot = join(fixtureRoot, "service-handoff");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const runner = new WindowsServiceDpapiFixtureRunner(Buffer.from("unused", "utf8"));
  // The host refuses to rewrite the directory's DACL, which is what a path
  // directly under a drive root does even when this account owns it.
  runner.handoffAclAvailable = false;
  const handoff = new WindowsServiceDpapiSecretHandoff({
    deviceId: "device-windows-acl",
    handoffRoot,
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot,
  });

  try {
    await assert.rejects(
      handoff.stage("identity-p256.device-key_0123456789012345678901", Buffer.from("x", "utf8")),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_BACKEND_UNAVAILABLE");
        // The operator needs the path and a next step, not just a code.
        assert.match(error.detail ?? "", /handoff directory ACL could not be applied/u);
        assert.match(error.detail ?? "", /ProgramData/u);
        assert.ok((error.detail ?? "").includes(handoffRoot));
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a workgroup host seals to the machine and says so, and the blob still opens", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-workgroup-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const handoffRoot = join(fixtureRoot, "service-handoff");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const alias = "identity-p256.device-key_0123456789012345678901";
  const secret = Buffer.from("workgroup-sealed-device-private-key", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  // No domain KDS root key, so the SID descriptor fails and the script falls
  // back to the machine descriptor.
  runner.sealingMode = 2;
  const handoff = new WindowsServiceDpapiSecretHandoff({
    deviceId: "device-windows-workgroup",
    handoffRoot,
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot,
  });

  try {
    assert.deepEqual(await handoff.stage(alias, secret), {
      status: "staged",
      sealing: "machine",
    });

    // The directory ACL is still applied; the descriptor is not the only boundary.
    assert.equal(
      runner.requests.some((request) => request.args.at(-1)?.includes("DirectorySecurity")),
      true,
    );

    // Unsealing is descriptor-agnostic, so the entry opens without migration.
    const opened = await handoff.consume(alias);
    try {
      assert.deepEqual(Buffer.from(opened), secret);
    } finally {
      opened.fill(0);
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Windows service vault survives restart without a loaded CurrentUser profile", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-profileless-");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const alias = "identity-p256.profileless-service-key";
  const secret = Buffer.from("profile-independent-service-secret", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  const configuration = {
    deviceId: "device-windows-profileless-service",
    handoffRoot: join(fixtureRoot, "handoff"),
    hostPlatform: "win32" as const,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
    vaultRoot: join(fixtureRoot, "service"),
  };
  const handoff = new WindowsServiceDpapiSecretHandoff(configuration);

  try {
    await handoff.stage(alias, secret);
    runner.currentUserDpapiAvailable = false;
    const first = new WindowsServiceDpapiSecretStore(configuration);
    assert.deepEqual(await first.availability(alias), { alias, ready: true });
    await first.executeWithSecretBytes(alias, (value) => assert.deepEqual(value, secret));

    const restarted = new WindowsServiceDpapiSecretStore(configuration);
    assert.deepEqual(await restarted.availability(alias), { alias, ready: true });
    await restarted.executeWithSecretBytes(alias, (value) => assert.deepEqual(value, secret));
    assert.equal(
      runner.requests.some((request) => request.args.at(-1)?.includes("OpenDelegate DPAPI probe")),
      false,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a Windows service handoff moves a Secret into its profile-independent DPAPI-NG vault", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-dpapi-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const ownerVaultRoot = join(fixtureRoot, "owner-secrets");
  const handoffRoot = join(fixtureRoot, "service-handoff");
  const serviceVaultRoot = join(fixtureRoot, "service-secrets");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const alias = "identity-p256.device-key_0123456789012345678901";
  const secret = Buffer.from("service-bound-device-private-key", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  const ownerStore = new WindowsDpapiSecretStore({
    deviceId: "device-windows-service",
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    sourceCheckoutRoot,
    vaultRoot: ownerVaultRoot,
  });
  const handoff = new WindowsServiceDpapiSecretHandoff({
    deviceId: "device-windows-service",
    handoffRoot,
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot,
  });

  try {
    await ownerStore.store(alias, secret);
    await ownerStore.executeWithSecretBytes(alias, async (value) => {
      assert.deepEqual(await handoff.stage(alias, value), {
        status: "staged",
        sealing: "service-account",
      });
      assert.deepEqual(await handoff.stage(alias, value), {
        status: "restaged",
        sealing: "service-account",
      });
    });
    assert.equal(
      runner.requests.filter((request) =>
        request.args.at(-1)?.includes("OpenDelegate Windows service DPAPI-NG protect v1"),
      ).length,
      2,
    );
    assert.deepEqual(await ownerStore.delete(alias), { status: "deleted" });

    const serviceStore = new WindowsServiceDpapiSecretStore({
      deviceId: "device-windows-service",
      handoffRoot,
      hostPlatform: "win32",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      runner,
      serviceSid,
      sourceCheckoutRoot,
      vaultRoot: serviceVaultRoot,
    });
    assert.deepEqual(await serviceStore.availability(alias), { alias, ready: true });
    await serviceStore.executeWithSecretBytes(alias, (value) => {
      assert.deepEqual(value, secret);
    });
    assert.deepEqual(await handoff.availability(alias), { alias, ready: false });

    const persisted: Buffer[] = [];
    for (const root of [handoffRoot, serviceVaultRoot]) {
      for (const name of (await readdir(root)).filter((entry) => entry.endsWith(".secret"))) {
        persisted.push(await readFile(join(root, name)));
      }
    }
    assert.equal(Buffer.concat(persisted).includes(secret), false);
    const metadata = JSON.stringify(
      runner.requests.map(({ args, environment, executable }) => ({
        args,
        environment,
        executable,
      })),
    );
    assert.equal(metadata.includes(secret.toString("utf8")), false);
    assert.equal(
      runner.requests
        .filter(({ executable }) => executable.endsWith("powershell.exe"))
        .every((request) => request.timeoutMs === 60_000),
      true,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a restarted Windows service keeps its DPAPI-NG vault record over a stale handoff", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-dpapi-restart-");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const alias = "identity-p256.service-restart-key";
  const secret = Buffer.from("service-restart-private-key", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  const configuration = {
    deviceId: "device-windows-service-restart",
    handoffRoot: join(fixtureRoot, "handoff"),
    hostPlatform: "win32" as const,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
    vaultRoot: join(fixtureRoot, "service"),
  };
  const handoff = new WindowsServiceDpapiSecretHandoff(configuration);

  try {
    await handoff.stage(alias, secret);
    await new WindowsServiceDpapiSecretStore(configuration).store(alias, secret);
    const restarted = new WindowsServiceDpapiSecretStore(configuration);

    assert.deepEqual(await restarted.availability(alias), { alias, ready: true });
    assert.deepEqual(await handoff.availability(alias), { alias, ready: false });
    assert.equal(
      runner.requests.some((request) =>
        request.args.at(-1)?.includes("OpenDelegate Windows service DPAPI-NG unprotect v1"),
      ),
      true,
    );
    assert.equal(
      runner.requests.some((request) => request.args.at(-1)?.includes("OpenDelegate DPAPI probe")),
      false,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a corrupt service DPAPI destination fails closed without deleting its recoverable handoff", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-dpapi-corrupt-");
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const alias = "identity-p256.service-corrupt-key";
  const secret = Buffer.from("service-corrupt-private-key", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  const configuration = {
    deviceId: "device-windows-service-corrupt",
    handoffRoot: join(fixtureRoot, "handoff"),
    hostPlatform: "win32" as const,
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
    vaultRoot: join(fixtureRoot, "service"),
  };
  const handoff = new WindowsServiceDpapiSecretHandoff(configuration);

  try {
    await handoff.stage(alias, secret);
    await new WindowsServiceDpapiSecretStore(configuration).store(alias, secret);
    runner.serviceDpapiNgUnprotectAvailable = false;
    runner.currentUserDpapiAvailable = false;
    runner.serviceDpapiUnprotectAvailable = false;
    const restarted = new WindowsServiceDpapiSecretStore(configuration);

    await assert.rejects(restarted.availability(alias), (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
      return true;
    });
    assert.deepEqual(await handoff.availability(alias), { alias, ready: true });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Windows service DPAPI backend fails closed outside its configured service SID", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-service-dpapi-identity-");
  const secret = Buffer.from("must-remain-in-handoff", "utf8");
  const runner = new WindowsServiceDpapiFixtureRunner(secret);
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const handoff = new WindowsServiceDpapiSecretHandoff({
    deviceId: "device-windows-service",
    handoffRoot: join(fixtureRoot, "handoff"),
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
    serviceSid,
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
  });

  try {
    await handoff.stage("identity-p256.service-key", secret);
    runner.serviceIdentityAvailable = false;
    const serviceStore = new WindowsServiceDpapiSecretStore({
      deviceId: "device-windows-service",
      handoffRoot: join(fixtureRoot, "handoff"),
      hostPlatform: "win32",
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      runner,
      serviceSid,
      sourceCheckoutRoot: join(fixtureRoot, "checkout"),
      vaultRoot: join(fixtureRoot, "service"),
    });

    assert.deepEqual(await serviceStore.health(), {
      backend: "windows-service-dpapi",
      deviceId: "device-windows-service",
      reasonCode: "service-identity-or-dpapi-unavailable",
      status: "unavailable",
    });
    assert.deepEqual(await serviceStore.availability("identity-p256.service-key"), {
      alias: "identity-p256.service-key",
      ready: false,
    });
    assert.deepEqual(await handoff.availability("identity-p256.service-key"), {
      alias: "identity-p256.service-key",
      ready: true,
    });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("Windows service SID resolution uses fixed sc.exe argv and parses only the SID value", async () => {
  const requests: NativeSecretCommandRequest[] = [];
  const serviceSid = "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702";
  const resolved = await resolveWindowsServiceSid({
    environment: { SystemRoot: "C:\\Windows" },
    hostPlatform: "win32",
    runner: {
      async run(request) {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: Buffer.from(`localized heading\r\n${serviceSid}\r\n`, "utf8"),
        };
      },
    },
    scPath: "C:\\Windows\\System32\\sc.exe",
    serviceName: "OpenDelegate-personal",
  });

  assert.equal(resolved, serviceSid);
  assert.deepEqual(
    requests.map(({ args, executable, environment, stdin }) => ({
      args,
      executable,
      environment,
      stdin: [...stdin],
    })),
    [
      {
        args: ["showsid", "OpenDelegate-personal"],
        environment: { SystemRoot: "C:\\Windows" },
        executable: "C:\\Windows\\System32\\sc.exe",
        stdin: [],
      },
    ],
  );
});

test("native backend output and failures cannot echo a Secret into diagnostics", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-native-redaction-");
  const secret = "hostile-native-output-secret";
  const store = new WindowsDpapiSecretStore({
    deviceId: "device-windows",
    hostPlatform: "win32",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner: new HostileDpapiRunner(secret),
    sourceCheckoutRoot: join(fixtureRoot, "checkout"),
    vaultRoot: join(fixtureRoot, "runtime", "secrets"),
  });

  try {
    await assert.rejects(
      store.store("agent-token", Buffer.from(secret, "utf8")),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_STORE_ACCESS_FAILED");
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test(
  "Windows DPAPI protects and restores a Device-local binary Secret",
  {
    skip: process.platform !== "win32" || process.env["OPENDELEGATE_TEST_SKIP_LIVE_DPAPI"] === "1",
  },
  async () => {
    const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-dpapi-live-");
    const sourceCheckoutRoot = join(fixtureRoot, "checkout");
    const vaultRoot = join(fixtureRoot, "runtime", "secrets");
    const first = Uint8Array.from([0, 17, 34, 51, 68, 85, 102, 255]);
    const second = Uint8Array.from([255, 238, 221, 204, 187, 170, 153, 0]);
    const nativeRunner = new NodeNativeSecretCommandRunner();
    const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
    assert.ok(systemRoot);
    const powershellPath = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const nativeEnvironment = Object.fromEntries(
      ["SystemRoot", "WINDIR", "ComSpec"].flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const store = new WindowsDpapiSecretStore({
      deviceId: "device-windows-live",
      environment: nativeEnvironment,
      powershellPath,
      runner: nativeRunner,
      sourceCheckoutRoot,
      vaultRoot,
    });

    try {
      assert.deepEqual(await store.health(), {
        backend: "windows-dpapi",
        deviceId: "device-windows-live",
        status: "ready",
      });
      await store.store("device-identity.private-key", first);
      await store.executeWithSecretBytes("device-identity.private-key", (value) => {
        assert.deepEqual([...value], [...first]);
      });
      await store.rotate("device-identity.private-key", second);
      await store.executeWithSecretBytes("device-identity.private-key", (value) => {
        assert.deepEqual([...value], [...second]);
      });

      const persistedNames = (await readdir(vaultRoot)).filter((name) => name.endsWith(".secret"));
      assert.equal(persistedNames.length, 1);
      const persistedName = persistedNames[0];
      if (persistedName === undefined) {
        throw new Error("Expected one DPAPI record.");
      }
      const persisted = await readFile(join(vaultRoot, persistedName));
      assert.equal(persisted.includes(Buffer.from(first)), false);
      assert.equal(persisted.includes(Buffer.from(second)), false);
      assert.deepEqual(await store.delete("device-identity.private-key"), {
        status: "deleted",
      });
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  },
);

test("the systemd key provider accepts only a scoped 256-bit runtime credential", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-credential-test-");
  const credentialRoot = join(fixtureRoot, "run", "credentials");
  const credentialDirectory = join(credentialRoot, "opendelegate.service");
  const credentialPath = join(credentialDirectory, "opendelegate-vault-key");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  await mkdir(credentialDirectory, { mode: 0o700, recursive: true });
  await writeFile(credentialPath, new Uint8Array(32).fill(91), { mode: 0o400 });
  const provider = new SystemdCredentialKeyProvider({
    allowedCredentialRoot: credentialRoot,
    credentialDirectory,
    credentialName: "opendelegate-vault-key",
    hostPlatform: "linux",
    sourceCheckoutRoot,
  });
  let callbackView: Uint8Array | undefined;

  try {
    await provider.executeWithKey((value) => {
      callbackView = value;
      assert.deepEqual([...value], [...new Uint8Array(32).fill(91)]);
    });
    assert.notEqual(callbackView, undefined);
    assert.equal(
      callbackView?.every((value) => value === 0),
      true,
    );

    await chmod(credentialPath, 0o600);
    await writeFile(credentialPath, new Uint8Array(31).fill(91));
    await assert.rejects(
      provider.executeWithKey(() => undefined),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.code, "SECRET_BACKEND_UNAVAILABLE");
        assert.equal(error.message.includes("91"), false);
        return true;
      },
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("Device identity P-256 keys survive restart as encrypted bytes and re-enter WebCrypto non-extractable", async () => {
  const fixtureRoot = await canonicalTemporaryDirectory("opendelegate-identity-secret-");
  const sourceCheckoutRoot = join(fixtureRoot, "checkout");
  const vaultRoot = join(fixtureRoot, "runtime", "secrets");
  const managed = new SystemdCredentialVaultSecretStore({
    deviceId,
    hostPlatform: "linux",
    keyProvider: new StaticKeyProvider(new Uint8Array(32).fill(23)),
    sourceCheckoutRoot,
    vaultRoot,
  });
  const firstProcess = new ManagedDeviceIdentitySecretStore(managed);
  const payload = new TextEncoder().encode("OpenDelegate identity proof");

  try {
    const created = await firstProcess.createP256KeyPair("ca_key-generation-1");
    assert.equal(created.privateKey.extractable, false);
    assert.equal(created.publicKey.type, "public");
    assert.equal(await firstProcess.has("ca_key-generation-1"), true);
    const firstSignature = await firstProcess.signP256("ca_key-generation-1", payload);
    assert.equal(
      await globalThis.crypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        created.publicKey,
        firstSignature,
        payload,
      ),
      true,
    );

    const restarted = new ManagedDeviceIdentitySecretStore(managed);
    const restoredPrivateKey = await restarted.getPrivateKey("ca_key-generation-1");
    assert.notEqual(restoredPrivateKey, null);
    assert.equal(restoredPrivateKey?.extractable, false);
    const restartedSignature = await restarted.signP256("ca_key-generation-1", payload);
    assert.equal(
      await globalThis.crypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        created.publicKey,
        restartedSignature,
        payload,
      ),
      true,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

async function canonicalTemporaryDirectory(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}
