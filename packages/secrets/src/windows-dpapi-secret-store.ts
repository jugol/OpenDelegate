import { createHash } from "node:crypto";
import { win32 } from "node:path";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  NativeSecretCommandRunner,
  SecretAvailability,
  WindowsDpapiSecretStoreConfig,
} from "./contracts.ts";
import { NodeNativeSecretCommandRunner } from "./native-secret-command.ts";
import { SecureFileVault } from "./secure-file-vault.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";

const DEFAULT_MAXIMUM_SECRET_BYTES = 1_048_576;
const ENTROPY_BYTES = 32;
const NATIVE_OVERHEAD_BYTES = 8_192;
const COMMAND_TIMEOUT_MS = 30_000;
const ALLOWED_WINDOWS_ENVIRONMENT = new Set(["COMSPEC", "SYSTEMROOT", "WINDIR"]);

export class WindowsDpapiSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-dpapi" as const;
  readonly #deviceId: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #expectedIdentitySid: string | undefined;
  readonly #maximumSecretBytes: number;
  readonly #powershellPath: string;
  readonly #runner: NativeSecretCommandRunner;
  readonly #vault: SecureFileVault;
  #initialization: Promise<void> | undefined;

  public constructor(config: WindowsDpapiSecretStoreConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    if ((config.hostPlatform ?? process.platform) !== "win32") {
      throw configurationInvalid();
    }
    this.#deviceId = config.deviceId;
    this.#expectedIdentitySid =
      config.expectedIdentitySid === undefined
        ? undefined
        : validateWindowsIdentitySid(config.expectedIdentitySid);
    this.#maximumSecretBytes = validateMaximumSecretBytes(
      config.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES,
    );
    this.#powershellPath = config.powershellPath ?? defaultWindowsPowerShellPath();
    if (!win32.isAbsolute(this.#powershellPath) || this.#powershellPath.includes("\0")) {
      throw configurationInvalid();
    }
    this.#environment = validateWindowsEnvironment(
      config.environment ?? defaultWindowsEnvironment(),
    );
    this.#runner = config.runner ?? new NodeNativeSecretCommandRunner();
    this.#vault = new SecureFileVault({
      maximumBlobBytes: this.#maximumSecretBytes + NATIVE_OVERHEAD_BYTES,
      namespace: config.deviceId,
      sourceCheckoutRoot: config.sourceCheckoutRoot,
      vaultRoot: config.vaultRoot,
    });
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    try {
      await this.#initialize();
      const result = await this.#runPowerShell(DPAPI_PROBE_SCRIPT, new Uint8Array(), 16);
      const ready = result.exitCode === 0 && result.stdout.equals(Buffer.from("ready"));
      result.stdout.fill(0);
      if (!ready) {
        throw backendUnavailable();
      }
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        status: "ready" as const,
      });
    } catch {
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        reasonCode: "dpapi-or-vault-unavailable",
        status: "unavailable" as const,
      });
    }
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    const health = await this.health();
    return Object.freeze({
      alias,
      ready: health.status === "ready" && (await this.#vault.has(alias)),
    });
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const protectedValue = await this.#protect(alias, material);
      try {
        await this.#vault.create(alias, protectedValue);
      } finally {
        protectedValue.fill(0);
      }
      return Object.freeze({ status: "stored" as const });
    } finally {
      material.fill(0);
    }
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const protectedValue = await this.#protect(alias, material);
      try {
        await this.#vault.replace(alias, protectedValue);
      } finally {
        protectedValue.fill(0);
      }
      return Object.freeze({ status: "rotated" as const });
    } finally {
      material.fill(0);
    }
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const status = await this.#vault.delete(alias);
    return Object.freeze({ status });
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const protectedValue = await this.#vault.read(alias);
    let material: Buffer | undefined;
    try {
      material = await this.#unprotect(alias, protectedValue);
      try {
        await executor(material);
      } catch {
        throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
      }
    } finally {
      protectedValue.fill(0);
      material?.fill(0);
    }
  }

  async #initialize(): Promise<void> {
    this.#initialization ??= this.#initializeOnce();
    try {
      await this.#initialization;
    } catch (error) {
      this.#initialization = undefined;
      throw error;
    }
  }

  async #initializeOnce(): Promise<void> {
    if (this.#expectedIdentitySid !== undefined) {
      const identityInput = Buffer.from(this.#expectedIdentitySid, "utf8");
      try {
        const result = await this.#runPowerShell(
          WINDOWS_SERVICE_IDENTITY_PROBE_SCRIPT,
          identityInput,
          16,
        );
        const ready = result.exitCode === 0 && result.stdout.equals(Buffer.from("ready"));
        result.stdout.fill(0);
        if (!ready) {
          throw backendUnavailable();
        }
      } finally {
        identityInput.fill(0);
      }
    }
    await this.#vault.initialize();
    const vaultRoot = await this.#vaultRootInput();
    try {
      const result = await this.#runPowerShell(WINDOWS_ACL_SCRIPT, vaultRoot, 0);
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
        throw backendUnavailable();
      }
    } finally {
      vaultRoot.fill(0);
    }
  }

  async #vaultRootInput(): Promise<Buffer> {
    // SecureFileVault has already canonicalized and validated this configured path.
    // PowerShell receives it through stdin so command metadata stays stable.
    return Buffer.from(this.#vault.rootPath(), "utf8");
  }

  async #protect(alias: string, material: Uint8Array): Promise<Buffer> {
    const input = Buffer.concat([this.#entropy(alias), material]);
    try {
      const result = await this.#runPowerShell(
        DPAPI_PROTECT_SCRIPT,
        input,
        this.#maximumSecretBytes + NATIVE_OVERHEAD_BYTES,
      );
      if (result.exitCode !== 0 || result.stdout.byteLength === 0) {
        result.stdout.fill(0);
        throw storeAccessFailed();
      }
      return result.stdout;
    } finally {
      input.fill(0);
    }
  }

  async #unprotect(alias: string, protectedValue: Uint8Array): Promise<Buffer> {
    const input = Buffer.concat([this.#entropy(alias), protectedValue]);
    try {
      const result = await this.#runPowerShell(
        DPAPI_UNPROTECT_SCRIPT,
        input,
        this.#maximumSecretBytes,
      );
      if (
        result.exitCode !== 0 ||
        result.stdout.byteLength === 0 ||
        result.stdout.byteLength > this.#maximumSecretBytes
      ) {
        result.stdout.fill(0);
        throw storeAccessFailed();
      }
      return result.stdout;
    } finally {
      input.fill(0);
    }
  }

  #entropy(alias: string): Buffer {
    return createHash("sha256")
      .update("OpenDelegate Windows DPAPI v1")
      .update("\0")
      .update(this.#deviceId)
      .update("\0")
      .update(alias)
      .digest();
  }

  async #runPowerShell(script: string, stdin: Uint8Array, maximumStdoutBytes: number) {
    try {
      return await this.#runner.run({
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        environment: this.#environment,
        executable: this.#powershellPath,
        maximumStdoutBytes,
        stdin,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      throw storeAccessFailed();
    }
  }
}

const DPAPI_PROBE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$payload=[Text.Encoding]::ASCII.GetBytes('OpenDelegate DPAPI probe')",
  "$sealed=$null",
  "$opened=$null",
  "try{",
  "$sealed=[Security.Cryptography.ProtectedData]::Protect($payload,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "$opened=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "if($payload.Length -ne $opened.Length){exit 33}",
  "for($index=0;$index -lt $payload.Length;$index++){if($payload[$index] -ne $opened[$index]){exit 33}}",
  "[Console]::OpenStandardOutput().Write([Text.Encoding]::ASCII.GetBytes('ready'),0,5)",
  "}finally{",
  "[Array]::Clear($payload,0,$payload.Length)",
  "if($null -ne $sealed){[Array]::Clear($sealed,0,$sealed.Length)}",
  "if($null -ne $opened){[Array]::Clear($opened,0,$opened.Length)}",
  "}",
].join(";");

const WINDOWS_SERVICE_IDENTITY_PROBE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$marker='OpenDelegate Windows service identity probe v1'",
  "$inputStream=[Console]::OpenStandardInput()",
  "$memory=New-Object IO.MemoryStream",
  "$inputStream.CopyTo($memory)",
  "$expected=[Text.Encoding]::UTF8.GetString($memory.ToArray())",
  "$actual=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "if($actual -cne $expected){exit 41}",
  "[Console]::OpenStandardOutput().Write([Text.Encoding]::ASCII.GetBytes('ready'),0,5)",
].join(";");

const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$inputStream=[Console]::OpenStandardInput()",
  "$memory=New-Object IO.MemoryStream",
  "$inputStream.CopyTo($memory)",
  "$path=[Text.Encoding]::UTF8.GetString($memory.ToArray())",
  "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl=New-Object Security.AccessControl.DirectorySecurity",
  "$acl.SetOwner($identity)",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $path -AclObject $acl",
  "$verified=Get-Acl -LiteralPath $path",
  "if(-not $verified.AreAccessRulesProtected){exit 31}",
  "foreach($entry in $verified.Access){if($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value){exit 31}}",
].join(";");

const DPAPI_PROTECT_SCRIPT = dpapiTransformScript("Protect");
const DPAPI_UNPROTECT_SCRIPT = dpapiTransformScript("Unprotect");

function dpapiTransformScript(operation: "Protect" | "Unprotect"): string {
  return [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$inputStream=[Console]::OpenStandardInput()",
    "$memory=New-Object IO.MemoryStream",
    "$inputStream.CopyTo($memory)",
    "$all=$memory.ToArray()",
    `if($all.Length -le ${ENTROPY_BYTES}){exit 32}`,
    `$entropy=New-Object byte[] ${ENTROPY_BYTES}`,
    `[Array]::Copy($all,0,$entropy,0,${ENTROPY_BYTES})`,
    `$payload=New-Object byte[] ($all.Length-${ENTROPY_BYTES})`,
    `[Array]::Copy($all,${ENTROPY_BYTES},$payload,0,$payload.Length)`,
    "try{",
    `$result=[Security.Cryptography.ProtectedData]::${operation}($payload,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "$output=[Console]::OpenStandardOutput()",
    "$output.Write($result,0,$result.Length)",
    "}finally{",
    "[Array]::Clear($all,0,$all.Length)",
    "[Array]::Clear($entropy,0,$entropy.Length)",
    "[Array]::Clear($payload,0,$payload.Length)",
    "if($null -ne $result){[Array]::Clear($result,0,$result.Length)}",
    "}",
  ].join(";");
}

function defaultWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw configurationInvalid();
  }
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function defaultWindowsEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function validateWindowsEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ALLOWED_WINDOWS_ENVIRONMENT.has(name.toLocaleUpperCase("en-US"))) {
      throw configurationInvalid();
    }
    environment[name] = entry;
  }
  return Object.freeze(environment);
}

function copySecretMaterial(value: Uint8Array, maximumSecretBytes: number): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > maximumSecretBytes
  ) {
    throw new SecretError(
      "SECRET_MATERIAL_INVALID",
      "Secret material must be non-empty and within the configured size limit.",
    );
  }
  return Buffer.from(value);
}

function validateMaximumSecretBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_SECRET_BYTES) {
    throw configurationInvalid();
  }
  return value;
}

function validateWindowsIdentitySid(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 184 ||
    !/^S-[0-9]{1,2}(?:-[0-9]{1,20})+$/u.test(value)
  ) {
    throw configurationInvalid();
  }
  return value;
}

function configurationInvalid(): SecretError {
  return new SecretError(
    "SECRET_CONFIGURATION_INVALID",
    "The Windows DPAPI Secret Store configuration is invalid.",
  );
}

function backendUnavailable(): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "Windows DPAPI or its restrictive local vault is unavailable.",
  );
}

function storeAccessFailed(): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "Windows DPAPI could not complete the Device-local Secret operation.",
  );
}
