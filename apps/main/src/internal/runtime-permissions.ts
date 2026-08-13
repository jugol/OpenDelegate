import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { chmod, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { inspectExistingRuntimePath } from "./runtime-path-inspection.ts";

const execFileAsync = promisify(execFile);

export interface RuntimePermissionTargets {
  readonly root: string;
  /**
   * Provider-owned homes are sealed at their root, but their internal layout is
   * opaque to OpenDelegate. Codex and Claude may create private links and other
   * provider-specific entries that OpenDelegate never traverses.
   */
  readonly opaqueDirectories?: readonly string[];
}

export type HostRuntimePermissionEnforcer = (targets: RuntimePermissionTargets) => Promise<void>;

export class RuntimePermissionEnforcementError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimePermissionEnforcementError";
  }
}

const scopedTestEnforcer = new AsyncLocalStorage<HostRuntimePermissionEnforcer>();

export async function enforceHostRuntimePermissions(
  targets: RuntimePermissionTargets,
): Promise<void> {
  const override = scopedTestEnforcer.getStore();
  if (override !== undefined) {
    await override(targets);
    return;
  }
  if (process.platform === "win32") {
    await enforceWindowsRuntimeAcl(targets.root, targets.opaqueDirectories ?? []);
    return;
  }
  await enforcePosixRuntimePermissions(targets.root, targets.opaqueDirectories ?? []);
}

/**
 * Test-only capability for portable orchestration tests. This internal module is
 * absent from the package export map, and the release entrypoint tree-shakes this
 * setter. No runtime option, environment value, or CLI input can activate it.
 */
export function withHostRuntimePermissionEnforcerForTest<T>(
  enforcer: HostRuntimePermissionEnforcer,
  operation: () => T,
): T {
  return scopedTestEnforcer.run(enforcer, operation);
}

async function enforcePosixRuntimePermissions(
  root: string,
  opaqueDirectories: readonly string[],
): Promise<void> {
  const currentUid = process.getuid?.();
  const opaque = normalizeOpaqueDirectories(root, opaqueDirectories);
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) {
      continue;
    }
    const initialMetadata = await inspectExistingRuntimePath(path);
    if (initialMetadata === undefined) {
      assertTransientDescendant(path, root);
      continue;
    }
    if (initialMetadata.isSymbolicLink()) {
      throw new RuntimePermissionEnforcementError(
        "Runtime state cannot contain symlinks or reparse points.",
      );
    }
    const expectedDirectory = initialMetadata.isDirectory();
    const expectedMode = expectedDirectory ? 0o700 : initialMetadata.isFile() ? 0o600 : undefined;
    if (expectedMode === undefined) {
      throw new RuntimePermissionEnforcementError(
        "Runtime state may contain only regular files and directories.",
      );
    }
    try {
      await chmod(path, expectedMode);
    } catch (error) {
      if (isNotFound(error)) {
        assertTransientDescendant(path, root);
        continue;
      }
      throw error;
    }
    const sealedMetadata = await inspectExistingRuntimePath(path);
    if (sealedMetadata === undefined) {
      assertTransientDescendant(path, root);
      continue;
    }
    if (
      sealedMetadata.isSymbolicLink() ||
      (expectedDirectory ? !sealedMetadata.isDirectory() : !sealedMetadata.isFile()) ||
      (sealedMetadata.mode & 0o777) !== expectedMode ||
      (currentUid !== undefined && sealedMetadata.uid !== currentUid)
    ) {
      throw new RuntimePermissionEnforcementError(
        "Runtime state permissions must grant access only to the current operating-system owner.",
      );
    }
    if (sealedMetadata.isDirectory()) {
      if (opaque.has(normalizeFilesystemPath(path))) {
        continue;
      }
      let entries: string[];
      try {
        entries = await readdir(path);
      } catch (error) {
        if (isNotFound(error)) {
          assertTransientDescendant(path, root);
          continue;
        }
        throw error;
      }
      for (const entry of entries) {
        pending.push(join(path, entry));
      }
    }
  }
}

function assertTransientDescendant(path: string, root: string): void {
  if (normalizeFilesystemPath(path) === normalizeFilesystemPath(root)) {
    throw new RuntimePermissionEnforcementError(
      "Runtime state disappeared during permission enforcement.",
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function enforceWindowsRuntimeAcl(
  root: string,
  opaqueDirectories: readonly string[],
): Promise<void> {
  const opaque = [...normalizeOpaqueDirectories(root, opaqueDirectories)];
  let identityOutput: string;
  try {
    const result = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      env: runtimeNativeToolEnvironment(),
      windowsHide: true,
    });
    identityOutput = result.stdout;
  } catch (error) {
    throw new RuntimePermissionEnforcementError(
      "OpenDelegate could not resolve the current Windows security identity.",
      { cause: error },
    );
  }
  const userSid = identityOutput.match(/S-\d(?:-\d+)+/u)?.[0];
  if (userSid === undefined) {
    throw new RuntimePermissionEnforcementError(
      "OpenDelegate could not parse the current Windows security identity.",
    );
  }
  const verificationScript = String.raw`
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1")
$root = $env:OPENDELEGATE_ACL_ROOT
$userSidText = $env:OPENDELEGATE_ACL_USER_SID
$systemSidText = "S-1-5-18"
$opaqueRoots = @(
  ConvertFrom-Json -InputObject $env:OPENDELEGATE_ACL_OPAQUE_ROOTS
)
$pending = [System.Collections.Generic.Stack[string]]::new()
$pending.Push($root)
$items = [System.Collections.Generic.List[object]]::new()
while ($pending.Count -gt 0) {
  $item = Get-Item -LiteralPath $pending.Pop() -Force
  $items.Add($item)
  $isOpaque = $false
  foreach ($opaqueRoot in $opaqueRoots) {
    if ([string]::Equals(
      $item.FullName,
      $opaqueRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      $isOpaque = $true
      break
    }
  }
  if ($item.PSIsContainer -and -not $isOpaque) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
      $pending.Push($child.FullName)
    }
  }
}
foreach ($item in $items) {
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Runtime state contains a reparse point."
  }
  $acl = Get-Acl -LiteralPath $item.FullName
  $ownerSidText = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSidText -ne $userSidText -and $ownerSidText -ne $systemSidText) {
    throw "Runtime state item '$($item.FullName)' is owned by '$ownerSidText', not the current user or LocalSystem."
  }
  if ($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) {
    throw "Runtime state still inherits access rules."
  }
  $hasUserFullControl = $false
  $hasSystemFullControl = $false
  foreach ($existingRule in @($acl.Access)) {
    $ruleSidText = $existingRule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    $isFullControl = (
      ($existingRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
      [System.Security.AccessControl.FileSystemRights]::FullControl
    )
    if (
      ($ruleSidText -ne $userSidText -and $ruleSidText -ne $systemSidText) -or
      $existingRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      -not $isFullControl
    ) {
      throw "Runtime state grants access outside the current user and LocalSystem."
    }
    if ($ruleSidText -eq $userSidText -and $isFullControl) {
      $hasUserFullControl = $true
    }
    if ($ruleSidText -eq $systemSidText -and $isFullControl) {
      $hasSystemFullControl = $true
    }
  }
  if (-not $hasUserFullControl -or -not $hasSystemFullControl) {
    throw "Runtime state does not grant required owner and LocalSystem access."
  }
}
`;
  try {
    for (const arguments_ of [
      [root, "/reset", "/L", "/Q"],
      [root, "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L", "/Q"],
      [root, "/inheritance:r", "/L", "/Q"],
      [join(root, "*"), "/reset", "/T", "/L", "/Q"],
      [root, "/setowner", `*${userSid}`, "/T", "/L", "/Q"],
    ]) {
      await execFileAsync("icacls.exe", arguments_, {
        encoding: "utf8",
        env: runtimeNativeToolEnvironment(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
    }
    await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verificationScript],
      {
        encoding: "utf8",
        env: {
          ...runtimeNativeToolEnvironment(),
          OPENDELEGATE_ACL_ROOT: root,
          OPENDELEGATE_ACL_OPAQUE_ROOTS: JSON.stringify(opaque),
          OPENDELEGATE_ACL_USER_SID: userSid,
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new RuntimePermissionEnforcementError(
      "OpenDelegate could not enforce a private Windows ACL on runtime state.",
      { cause: error },
    );
  }
}

function normalizeOpaqueDirectories(root: string, paths: readonly string[]): ReadonlySet<string> {
  const canonicalRoot = resolve(root);
  const normalized = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new RuntimePermissionEnforcementError(
        "Opaque runtime directories must be absolute descendants of the runtime root.",
      );
    }
    const canonicalPath = resolve(path);
    const relationship = relative(canonicalRoot, canonicalPath);
    if (
      relationship === "" ||
      relationship === ".." ||
      relationship.startsWith(`..${sep}`) ||
      isAbsolute(relationship)
    ) {
      throw new RuntimePermissionEnforcementError(
        "Opaque runtime directories must be absolute descendants of the runtime root.",
      );
    }
    normalized.add(normalizeFilesystemPath(canonicalPath));
  }
  return normalized;
}

function normalizeFilesystemPath(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

function runtimeNativeToolEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}
