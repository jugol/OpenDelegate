import { createHash } from "node:crypto";
import { win32 } from "node:path";

import type {
  ManagedSecretDeletion,
  ManagedSecretMutation,
  ManagedSecretStore,
  ManagedSecretStoreHealth,
  NativeSecretCommandRunner,
  SecretAvailability,
  WindowsServiceDpapiSecretHandoffConfig,
  WindowsServiceDpapiSecretStoreConfig,
  WindowsServiceSecretHandoffMutation,
  WindowsServiceSecretSealing,
} from "./contracts.ts";
import { NodeNativeSecretCommandRunner } from "./native-secret-command.ts";
import { SecureFileVault } from "./secure-file-vault.ts";
import { SecretError } from "./secret-error.ts";
import { assertSecretIdentifier } from "./secret-validation.ts";
import { WindowsDpapiSecretStore } from "./windows-dpapi-secret-store.ts";

const DEFAULT_MAXIMUM_SECRET_BYTES = 1_048_576;
const NATIVE_OVERHEAD_BYTES = 65_536;
const COMMAND_TIMEOUT_MS = 60_000;
const BINDING_BYTES = 32;
/** Sealed by a SID descriptor, readable only by the service account. */
const SEALING_MODE_SERVICE_ACCOUNT = 1;
/** Sealed by a machine descriptor because no domain KDS root key exists. */
const SEALING_MODE_MACHINE = 2;
const ALLOWED_WINDOWS_ENVIRONMENT = new Set(["COMSPEC", "SYSTEMROOT", "WINDIR"]);

export interface ResolveWindowsServiceSidOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly runner?: NativeSecretCommandRunner;
  readonly scPath?: string;
  readonly serviceName: string;
}

export async function resolveWindowsServiceSid(
  options: ResolveWindowsServiceSidOptions,
): Promise<string> {
  assertWindowsHost(options.hostPlatform ?? process.platform);
  if (!/^OpenDelegate-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(options.serviceName)) {
    throw configurationInvalid();
  }
  const scPath = options.scPath ?? win32.join(requireWindowsSystemRoot(), "System32", "sc.exe");
  if (!win32.isAbsolute(scPath) || scPath.includes("\0")) {
    throw configurationInvalid();
  }
  const runner = options.runner ?? new NodeNativeSecretCommandRunner();
  let result;
  try {
    result = await runner.run({
      args: ["showsid", options.serviceName],
      environment: validateWindowsEnvironment(options.environment ?? defaultWindowsEnvironment()),
      executable: scPath,
      maximumStdoutBytes: 8_192,
      stdin: new Uint8Array(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  } catch {
    throw backendUnavailable();
  }
  try {
    if (result.exitCode !== 0) {
      throw backendUnavailable();
    }
    const matches = result.stdout
      .toString("utf8")
      .match(/S-1-5-80-(?:[0-9]{1,10}-){4}[0-9]{1,10}/gu);
    if (matches?.length !== 1) {
      throw backendUnavailable();
    }
    return validateWindowsServiceSid(matches[0]!);
  } finally {
    result.stdout.fill(0);
  }
}

export class WindowsServiceDpapiSecretHandoff {
  readonly #deviceId: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #maximumSecretBytes: number;
  readonly #expectedIdentitySid: string | undefined;
  readonly #helperExecutablePath: string;
  readonly #nativeHelper: boolean;
  readonly #runner: NativeSecretCommandRunner;
  readonly #serviceSid: string;
  readonly #vault: SecureFileVault;
  #initialization: Promise<void> | undefined;

  public constructor(config: WindowsServiceDpapiSecretHandoffConfig) {
    assertSecretIdentifier(config.deviceId, "Device ID");
    assertWindowsHost(config.hostPlatform ?? process.platform);
    this.#deviceId = config.deviceId;
    this.#serviceSid = validateWindowsServiceSid(config.serviceSid);
    this.#expectedIdentitySid =
      config.expectedIdentitySid === undefined
        ? undefined
        : validateWindowsServiceSid(config.expectedIdentitySid);
    this.#maximumSecretBytes = validateMaximumSecretBytes(
      config.maximumSecretBytes ?? DEFAULT_MAXIMUM_SECRET_BYTES,
    );
    const defaultNativeHelperPath = win32.join(
      config.sourceCheckoutRoot,
      "bin",
      "opendelegate-service-host.exe",
    );
    const nativeHelperPath =
      config.nativeHelperPath ??
      (config.runner === undefined && config.powershellPath === undefined
        ? defaultNativeHelperPath
        : undefined);
    if (
      nativeHelperPath !== undefined &&
      (!win32.isAbsolute(nativeHelperPath) ||
        nativeHelperPath.includes("\0") ||
        win32.normalize(nativeHelperPath).toLowerCase() !==
          win32.normalize(defaultNativeHelperPath).toLowerCase())
    ) {
      throw configurationInvalid();
    }
    this.#nativeHelper = nativeHelperPath !== undefined;
    this.#helperExecutablePath =
      nativeHelperPath ?? config.powershellPath ?? defaultWindowsPowerShellPath();
    if (
      !win32.isAbsolute(this.#helperExecutablePath) ||
      this.#helperExecutablePath.includes("\0")
    ) {
      throw configurationInvalid();
    }
    this.#environment = validateWindowsEnvironment(
      config.environment ?? defaultWindowsEnvironment(),
    );
    this.#runner = config.runner ?? new NodeNativeSecretCommandRunner();
    this.#vault = new SecureFileVault({
      maximumBlobBytes: this.#maximumSecretBytes + NATIVE_OVERHEAD_BYTES,
      namespace: handoffNamespace(this.#deviceId, this.#serviceSid),
      sourceCheckoutRoot: config.sourceCheckoutRoot,
      vaultRoot: config.handoffRoot,
    });
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    return Object.freeze({ alias, ready: await this.#vault.has(alias) });
  }

  public async stage(
    alias: string,
    value: Uint8Array,
  ): Promise<WindowsServiceSecretHandoffMutation> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const alreadyStaged = await this.#vault.has(alias);
    const material = copySecretMaterial(value, this.#maximumSecretBytes);
    try {
      const { sealed, sealing } = await this.#protect(alias, material);
      try {
        if (alreadyStaged) {
          await this.#vault.replace(alias, sealed);
        } else {
          await this.#vault.create(alias, sealed);
        }
      } finally {
        sealed.fill(0);
      }
      return Object.freeze({ status: alreadyStaged ? "restaged" : "staged", sealing });
    } finally {
      material.fill(0);
    }
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    return Object.freeze({ status: await this.#vault.delete(alias) });
  }

  public async consume(alias: string): Promise<Buffer> {
    assertSecretIdentifier(alias, "Secret alias");
    await this.#initialize();
    const protectedValue = await this.#vault.read(alias);
    try {
      return await this.#unprotect(alias, protectedValue);
    } finally {
      protectedValue.fill(0);
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
        const result = await this.#runHelper(
          "identity-probe",
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
    const handoffPath = this.#vault.rootPath();
    const input = encodeSidAndPath(this.#serviceSid, handoffPath);
    try {
      const result = await this.#runHelper("acl", WINDOWS_HANDOFF_ACL_SCRIPT, input, 0);
      result.stdout.fill(0);
      if (result.exitCode !== 0) {
        throw backendUnavailable(
          `The handoff directory ACL could not be applied at ${handoffPath} (exit ${String(result.exitCode)}). Staging rewrites that directory's access rules so only this account and the service account remain, which requires the staging account to be able to replace its DACL. A directory created directly under a drive root often refuses that even when this account owns it; a location under ProgramData or the user profile normally succeeds.`,
        );
      }
    } finally {
      input.fill(0);
    }
  }

  async #protect(
    alias: string,
    material: Uint8Array,
  ): Promise<{ readonly sealed: Buffer; readonly sealing: WindowsServiceSecretSealing }> {
    const serviceSid = Buffer.from(this.#serviceSid, "utf8");
    const binding = this.#binding(alias);
    const input = Buffer.allocUnsafe(
      2 + serviceSid.byteLength + binding.byteLength + material.length,
    );
    input.writeUInt16LE(serviceSid.byteLength, 0);
    serviceSid.copy(input, 2);
    binding.copy(input, 2 + serviceSid.byteLength);
    Buffer.from(material).copy(input, 2 + serviceSid.byteLength + binding.byteLength);
    serviceSid.fill(0);
    binding.fill(0);
    try {
      const result = await this.#runHelper(
        "protect",
        DPAPI_NG_PROTECT_SCRIPT,
        input,
        this.#maximumSecretBytes + NATIVE_OVERHEAD_BYTES,
      );
      // The first byte names the descriptor that actually sealed the blob.
      const mode = result.stdout[0];
      if (
        result.exitCode !== 0 ||
        result.stdout.byteLength <= 1 ||
        (mode !== SEALING_MODE_SERVICE_ACCOUNT && mode !== SEALING_MODE_MACHINE)
      ) {
        result.stdout.fill(0);
        throw storeAccessFailed(
          `Sealing the Secret failed (exit ${String(result.exitCode)}). Neither the service-account nor the machine protection descriptor produced a usable blob.`,
        );
      }
      const sealed = Buffer.from(result.stdout.subarray(1));
      result.stdout.fill(0);
      return {
        sealed,
        sealing: mode === SEALING_MODE_SERVICE_ACCOUNT ? "service-account" : "machine",
      };
    } finally {
      input.fill(0);
    }
  }

  async #unprotect(alias: string, protectedValue: Uint8Array): Promise<Buffer> {
    const binding = this.#binding(alias);
    const input = Buffer.concat([binding, protectedValue]);
    binding.fill(0);
    try {
      const result = await this.#runHelper(
        "unprotect",
        DPAPI_NG_UNPROTECT_SCRIPT,
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

  #binding(alias: string): Buffer {
    return createHash("sha256")
      .update("OpenDelegate Windows service Secret handoff v1")
      .update("\0")
      .update(this.#deviceId)
      .update("\0")
      .update(alias)
      .update("\0")
      .update(this.#serviceSid)
      .digest();
  }

  async #runHelper(
    operation: "acl" | "identity-probe" | "protect" | "unprotect",
    powershellScript: string,
    stdin: Uint8Array,
    maximumStdoutBytes: number,
  ) {
    try {
      return await this.#runner.run({
        args: this.#nativeHelper
          ? ["--secret-helper", operation]
          : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellScript],
        environment: this.#environment,
        executable: this.#helperExecutablePath,
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

export class WindowsServiceDpapiSecretStore implements ManagedSecretStore {
  public readonly backend = "windows-service-dpapi" as const;
  readonly #delegate: WindowsServiceDpapiSecretHandoff;
  readonly #deviceId: string;
  readonly #handoff: WindowsServiceDpapiSecretHandoff;
  readonly #legacyDelegate: WindowsDpapiSecretStore;
  readonly #migrations = new Map<string, Promise<boolean>>();

  public constructor(config: WindowsServiceDpapiSecretStoreConfig) {
    this.#deviceId = config.deviceId;
    this.#delegate = new WindowsServiceDpapiSecretHandoff({
      deviceId: config.deviceId,
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      expectedIdentitySid: config.serviceSid,
      handoffRoot: config.vaultRoot,
      serviceSid: config.serviceSid,
      sourceCheckoutRoot: config.sourceCheckoutRoot,
      ...(config.hostPlatform === undefined ? {} : { hostPlatform: config.hostPlatform }),
      ...(config.maximumSecretBytes === undefined
        ? {}
        : { maximumSecretBytes: config.maximumSecretBytes }),
      ...(config.nativeHelperPath === undefined
        ? {}
        : { nativeHelperPath: config.nativeHelperPath }),
      ...(config.powershellPath === undefined ? {} : { powershellPath: config.powershellPath }),
      ...(config.runner === undefined ? {} : { runner: config.runner }),
    });
    // Compatibility only: older releases moved service Secrets into
    // CurrentUser DPAPI. It is consulted only when the profile-independent
    // DPAPI-NG read fails, then the exact plaintext is immediately re-sealed
    // into the current service vault.
    this.#legacyDelegate = new WindowsDpapiSecretStore({
      deviceId: config.deviceId,
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      expectedIdentitySid: config.serviceSid,
      ...(config.hostPlatform === undefined ? {} : { hostPlatform: config.hostPlatform }),
      ...(config.maximumSecretBytes === undefined
        ? {}
        : { maximumSecretBytes: config.maximumSecretBytes }),
      ...(config.nativeHelperPath === undefined
        ? {}
        : { nativeHelperPath: config.nativeHelperPath }),
      ...(config.powershellPath === undefined ? {} : { powershellPath: config.powershellPath }),
      ...(config.runner === undefined ? {} : { runner: config.runner }),
      sourceCheckoutRoot: config.sourceCheckoutRoot,
      vaultRoot: config.vaultRoot,
    });
    this.#handoff = new WindowsServiceDpapiSecretHandoff({
      deviceId: config.deviceId,
      ...(config.environment === undefined ? {} : { environment: config.environment }),
      handoffRoot: config.handoffRoot,
      ...(config.hostPlatform === undefined ? {} : { hostPlatform: config.hostPlatform }),
      ...(config.maximumSecretBytes === undefined
        ? {}
        : { maximumSecretBytes: config.maximumSecretBytes }),
      ...(config.powershellPath === undefined ? {} : { powershellPath: config.powershellPath }),
      ...(config.runner === undefined ? {} : { runner: config.runner }),
      serviceSid: config.serviceSid,
      sourceCheckoutRoot: config.sourceCheckoutRoot,
    });
  }

  public get deviceId(): string {
    return this.#deviceId;
  }

  public async health(): Promise<ManagedSecretStoreHealth> {
    try {
      await this.#delegate.availability("opendelegate.service-vault-health");
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        status: "ready" as const,
      });
    } catch {
      return Object.freeze({
        backend: this.backend,
        deviceId: this.#deviceId,
        reasonCode: "service-identity-or-dpapi-unavailable",
        status: "unavailable" as const,
      });
    }
  }

  public async availability(alias: string): Promise<SecretAvailability> {
    assertSecretIdentifier(alias, "Secret alias");
    const health = await this.health();
    if (health.status !== "ready") {
      return Object.freeze({ alias, ready: false });
    }
    return Object.freeze({ alias, ready: await this.#ensureAvailable(alias) });
  }

  public async store(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    const result = await this.#delegate.stage(alias, value);
    return Object.freeze({ status: result.status === "staged" ? "stored" : "rotated" });
  }

  public async rotate(alias: string, value: Uint8Array): Promise<ManagedSecretMutation> {
    await this.#delegate.stage(alias, value);
    return Object.freeze({ status: "rotated" as const });
  }

  public async delete(alias: string): Promise<ManagedSecretDeletion> {
    const result = await this.#delegate.delete(alias);
    await this.#handoff.delete(alias);
    return result;
  }

  public async executeWithSecretBytes(
    alias: string,
    executor: (value: Uint8Array) => unknown | Promise<unknown>,
  ): Promise<void> {
    if (!(await this.#ensureAvailable(alias))) {
      throw aliasUnavailable();
    }
    const material = await this.#delegate.consume(alias);
    try {
      try {
        await executor(material);
      } catch {
        throw new SecretError("SECRET_EXECUTOR_FAILED", "The scoped Secret executor failed.");
      }
    } finally {
      material.fill(0);
    }
  }

  async #ensureAvailable(alias: string): Promise<boolean> {
    const existing = this.#migrations.get(alias);
    if (existing !== undefined) {
      return await existing;
    }
    const migration = this.#migrate(alias);
    this.#migrations.set(alias, migration);
    try {
      return await migration;
    } finally {
      this.#migrations.delete(alias);
    }
  }

  async #migrate(alias: string): Promise<boolean> {
    if ((await this.#delegate.availability(alias)).ready) {
      try {
        const material = await this.#delegate.consume(alias);
        material.fill(0);
      } catch (currentError) {
        let migrated = false;
        try {
          await this.#legacyDelegate.executeWithSecretBytes(alias, async (value) => {
            await this.#delegate.stage(alias, value);
            migrated = true;
          });
        } catch {
          throw currentError;
        }
        if (!migrated) {
          throw currentError;
        }
        const verified = await this.#delegate.consume(alias);
        verified.fill(0);
      }
      if ((await this.#handoff.availability(alias)).ready) {
        await this.#handoff.delete(alias);
      }
      return true;
    }
    if (!(await this.#handoff.availability(alias)).ready) {
      return false;
    }
    const material = await this.#handoff.consume(alias);
    try {
      await this.#delegate.stage(alias, material);
    } finally {
      material.fill(0);
    }
    await this.#handoff.delete(alias);
    return true;
  }
}

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

const DPAPI_NG_NATIVE_TYPE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class OpenDelegateDpapiNg {",
  '[DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] private static extern int NCryptCreateProtectionDescriptor(string value, uint flags, out IntPtr descriptor);',
  '[DllImport("ncrypt.dll")] private static extern int NCryptCloseProtectionDescriptor(IntPtr descriptor);',
  '[DllImport("ncrypt.dll")] private static extern int NCryptProtectSecret(IntPtr descriptor, uint flags, byte[] data, int dataLength, IntPtr memory, IntPtr window, out IntPtr output, out int outputLength);',
  '[DllImport("ncrypt.dll")] private static extern int NCryptUnprotectSecret(out IntPtr descriptor, uint flags, byte[] data, int dataLength, IntPtr memory, IntPtr window, out IntPtr output, out int outputLength);',
  '[DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);',
  "private static byte[] CopyAndFree(IntPtr value, int length) { if (value == IntPtr.Zero || length <= 0) throw new InvalidOperationException(); var output = new byte[length]; try { Marshal.Copy(value, output, 0, length); return output; } finally { LocalFree(value); } }",
  "public static byte[] Protect(string policy, byte[] value) { IntPtr descriptor; var status = NCryptCreateProtectionDescriptor(policy, 0, out descriptor); if (status != 0) throw new InvalidOperationException(); try { IntPtr output; int length; status = NCryptProtectSecret(descriptor, 0x40, value, value.Length, IntPtr.Zero, IntPtr.Zero, out output, out length); if (status != 0) throw new InvalidOperationException(); return CopyAndFree(output, length); } finally { NCryptCloseProtectionDescriptor(descriptor); } }",
  "public static byte[] Unprotect(byte[] value) { IntPtr descriptor; IntPtr output; int length; var status = NCryptUnprotectSecret(out descriptor, 0x40, value, value.Length, IntPtr.Zero, IntPtr.Zero, out output, out length); if (status != 0) throw new InvalidOperationException(); try { return CopyAndFree(output, length); } finally { if (descriptor != IntPtr.Zero) NCryptCloseProtectionDescriptor(descriptor); } }",
  "}",
].join("");

const DPAPI_NG_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$marker='OpenDelegate Windows service DPAPI-NG protect v1'",
  `$source='${DPAPI_NG_NATIVE_TYPE}'`,
  "Add-Type -TypeDefinition $source",
  "$inputStream=[Console]::OpenStandardInput()",
  "$memory=New-Object IO.MemoryStream",
  "$inputStream.CopyTo($memory)",
  "$all=$memory.ToArray()",
  "if($all.Length -le 34){exit 42}",
  "$sidLength=[BitConverter]::ToUInt16($all,0)",
  "if($sidLength -le 0 -or (2+$sidLength+32) -ge $all.Length){exit 42}",
  "$sid=[Text.Encoding]::UTF8.GetString($all,2,$sidLength)",
  "$payload=New-Object byte[] ($all.Length-2-$sidLength)",
  "[Array]::Copy($all,2+$sidLength,$payload,0,$payload.Length)",
  "$sealed=$null",
  "$mode=0",
  "try{",
  // A SID descriptor needs a domain KDS root key. A workgroup host has none and
  // fails closed with NTE_ENCRYPTION_FAILURE, so fall back to machine sealing
  // and report which one was used. The directory ACL, not the descriptor, is
  // what keeps other local accounts away from the staged blob.
  "try{",
  "$sealed=[OpenDelegateDpapiNg]::Protect(('SID='+$sid),$payload)",
  "$mode=1",
  "}catch{",
  "$sealed=[OpenDelegateDpapiNg]::Protect('LOCAL=machine',$payload)",
  "$mode=2",
  "}",
  "$output=[Console]::OpenStandardOutput()",
  "$output.Write([byte[]]@($mode),0,1)",
  "$output.Write($sealed,0,$sealed.Length)",
  "}finally{",
  "[Array]::Clear($all,0,$all.Length)",
  "[Array]::Clear($payload,0,$payload.Length)",
  "if($null -ne $sealed){[Array]::Clear($sealed,0,$sealed.Length)}",
  "}",
].join(";");

const DPAPI_NG_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$marker='OpenDelegate Windows service DPAPI-NG unprotect v1'",
  `$source='${DPAPI_NG_NATIVE_TYPE}'`,
  "Add-Type -TypeDefinition $source",
  "$inputStream=[Console]::OpenStandardInput()",
  "$memory=New-Object IO.MemoryStream",
  "$inputStream.CopyTo($memory)",
  "$all=$memory.ToArray()",
  `if($all.Length -le ${BINDING_BYTES}){exit 43}`,
  `$expected=New-Object byte[] ${BINDING_BYTES}`,
  `[Array]::Copy($all,0,$expected,0,${BINDING_BYTES})`,
  `$sealed=New-Object byte[] ($all.Length-${BINDING_BYTES})`,
  `[Array]::Copy($all,${BINDING_BYTES},$sealed,0,$sealed.Length)`,
  "$opened=$null",
  "$payload=$null",
  "try{",
  "$opened=[OpenDelegateDpapiNg]::Unprotect($sealed)",
  `if($opened.Length -le ${BINDING_BYTES}){exit 43}`,
  `for($index=0;$index -lt ${BINDING_BYTES};$index++){if($opened[$index] -ne $expected[$index]){exit 43}}`,
  `$payload=New-Object byte[] ($opened.Length-${BINDING_BYTES})`,
  `[Array]::Copy($opened,${BINDING_BYTES},$payload,0,$payload.Length)`,
  "$output=[Console]::OpenStandardOutput()",
  "$output.Write($payload,0,$payload.Length)",
  "}finally{",
  "[Array]::Clear($all,0,$all.Length)",
  "[Array]::Clear($expected,0,$expected.Length)",
  "[Array]::Clear($sealed,0,$sealed.Length)",
  "if($null -ne $opened){[Array]::Clear($opened,0,$opened.Length)}",
  "if($null -ne $payload){[Array]::Clear($payload,0,$payload.Length)}",
  "}",
].join(";");

const WINDOWS_HANDOFF_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$inputStream=[Console]::OpenStandardInput()",
  "$memory=New-Object IO.MemoryStream",
  "$inputStream.CopyTo($memory)",
  "$all=$memory.ToArray()",
  "if($all.Length -le 2){exit 44}",
  "$sidLength=[BitConverter]::ToUInt16($all,0)",
  "if($sidLength -le 0 -or (2+$sidLength) -ge $all.Length){exit 44}",
  "$serviceSidText=[Text.Encoding]::UTF8.GetString($all,2,$sidLength)",
  "$path=[Text.Encoding]::UTF8.GetString($all,2+$sidLength,$all.Length-2-$sidLength)",
  "$current=[Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$service=New-Object Security.Principal.SecurityIdentifier($serviceSidText)",
  "$acl=New-Object Security.AccessControl.DirectorySecurity",
  "$acl.SetOwner($current)",
  "$acl.SetAccessRuleProtection($true,$false)",
  "$inheritance='ContainerInherit,ObjectInherit'",
  "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($current,'FullControl',$inheritance,'None','Allow')))",
  "if($current.Value -cne $service.Value){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($service,'FullControl',$inheritance,'None','Allow')))}",
  "[IO.Directory]::SetAccessControl($path,$acl)",
  "$verified=[IO.Directory]::GetAccessControl($path)",
  "if(-not $verified.AreAccessRulesProtected){exit 44}",
  "$allowed=@($current.Value,$service.Value)",
  "foreach($entry in $verified.Access){$sid=$entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($entry.AccessControlType -eq 'Allow' -and $allowed -notcontains $sid){exit 44}}",
].join(";");

function encodeSidAndPath(serviceSid: string, path: string): Buffer {
  const sid = Buffer.from(serviceSid, "utf8");
  const pathBytes = Buffer.from(path, "utf8");
  if (sid.byteLength > 65_535 || pathBytes.byteLength === 0) {
    sid.fill(0);
    pathBytes.fill(0);
    throw configurationInvalid();
  }
  const input = Buffer.allocUnsafe(2 + sid.byteLength + pathBytes.byteLength);
  input.writeUInt16LE(sid.byteLength, 0);
  sid.copy(input, 2);
  pathBytes.copy(input, 2 + sid.byteLength);
  sid.fill(0);
  pathBytes.fill(0);
  return input;
}

function handoffNamespace(deviceId: string, serviceSid: string): string {
  return `windows-service-handoff-${createHash("sha256")
    .update(deviceId)
    .update("\0")
    .update(serviceSid)
    .digest("hex")}`;
}

function validateWindowsServiceSid(value: string): string {
  if (typeof value !== "string" || !/^S-1-5-80-(?:[0-9]{1,10}-){4}[0-9]{1,10}$/u.test(value)) {
    throw configurationInvalid();
  }
  return value;
}

function validateMaximumSecretBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAXIMUM_SECRET_BYTES) {
    throw configurationInvalid();
  }
  return value;
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

function defaultWindowsPowerShellPath(): string {
  return win32.join(
    requireWindowsSystemRoot(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function requireWindowsSystemRoot(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw configurationInvalid();
  }
  return systemRoot;
}

function assertWindowsHost(platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    throw configurationInvalid();
  }
}

function configurationInvalid(): SecretError {
  return new SecretError(
    "SECRET_CONFIGURATION_INVALID",
    "The Windows service DPAPI Secret configuration is invalid.",
  );
}

function backendUnavailable(detail?: string): SecretError {
  return new SecretError(
    "SECRET_BACKEND_UNAVAILABLE",
    "The Windows service identity or its DPAPI Secret lifecycle is unavailable.",
    detail,
  );
}

function storeAccessFailed(detail?: string): SecretError {
  return new SecretError(
    "SECRET_STORE_ACCESS_FAILED",
    "The Windows service Secret handoff could not complete its Device-local operation.",
    detail,
  );
}

function aliasUnavailable(): SecretError {
  return new SecretError(
    "SECRET_ALIAS_UNAVAILABLE",
    "The Secret alias is unavailable on this Device.",
  );
}
