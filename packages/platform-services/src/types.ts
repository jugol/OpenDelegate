export type PlatformFamily = "linux" | "macos" | "windows";
export type DeviceRuntimeRole = "main" | "worker";
export type RuntimePlane = "core" | "session-helper";
export type ServiceOperation =
  "install" | "reconfigure" | "restart" | "start" | "stop" | "uninstall" | "upgrade";

export interface ReleaseBundle {
  readonly version: string;
  readonly sourceDirectory: string;
  readonly checksum: string;
}

export interface RuntimePaths {
  readonly sourceCheckoutDirectory: string;
  readonly installRoot: string;
  readonly stateRoot: string;
  /**
   * Monotonic desktop authority is deliberately outside restorable Device state.
   */
  readonly authorityRoot: string;
  readonly runtimeRoot: string;
  readonly logRoot: string;
}

export interface OwnerSessionIdentity {
  readonly userName: string;
  readonly stableUserId: string;
  readonly uid?: number;
  readonly homeDirectory?: string;
  /**
   * Owner opt-in copied from the durable Main setting when service artifacts are
   * rendered.
   */
  readonly adminAutoOpen: AdminAutoOpenConfiguration;
}

export type AdminAutoOpenConfiguration =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly url: string;
    };

export interface ServiceIdentity {
  readonly userName: string;
  readonly groupName: string;
}

export interface SystemdEncryptedCredential {
  readonly credentialName: string;
  readonly encryptedSourcePath: string;
}

export interface LocalHealthConfiguration {
  readonly endpoint: string;
  readonly timeoutMs: number;
}

export interface LocalIpcPublicKeyPin {
  readonly keyId: `sha256:${string}`;
  readonly publicKeySpkiBase64Url: string;
}

export interface LocalIpcTrustConfiguration {
  readonly protocolVersion: 2;
  readonly core: LocalIpcPublicKeyPin;
  readonly helper: LocalIpcPublicKeyPin;
}

interface BaseServiceConfiguration {
  readonly instanceId: string;
  readonly deviceId: string;
  readonly role: DeviceRuntimeRole;
  readonly bundle: ReleaseBundle;
  readonly paths: RuntimePaths;
  readonly ownerSession: OwnerSessionIdentity;
  readonly ipcTrust: LocalIpcTrustConfiguration;
  readonly secretReferences: Readonly<Record<string, string>>;
  readonly health: LocalHealthConfiguration;
  readonly retainPreviousVersions: number;
}

export interface WindowsServiceConfiguration extends BaseServiceConfiguration {
  readonly platform: "windows";
  readonly helperSecretBinding: WindowsOwnerHelperSecretBinding;
  readonly serviceSecretBinding?: WindowsServiceSecretBinding;
}

export interface WindowsOwnerHelperSecretBinding {
  readonly backend: "windows-dpapi";
  readonly vaultRoot: string;
}

export interface WindowsServiceSecretBinding {
  readonly backend: "windows-service-dpapi";
  readonly handoffRoot: string;
  readonly serviceName: string;
  readonly serviceSid: string;
  readonly vaultRoot: string;
}

export interface MacOsServiceConfiguration extends BaseServiceConfiguration {
  readonly platform: "macos";
  readonly serviceIdentity: ServiceIdentity;
  readonly helperSecretBinding: MacOsOwnerHelperSecretBinding;
}

export interface MacOsOwnerHelperSecretBinding {
  readonly backend: "macos-keychain";
  readonly helperPath: string;
  readonly expectedHelperSha256: `sha256:${string}`;
}

export interface LinuxServiceConfiguration extends BaseServiceConfiguration {
  readonly platform: "linux";
  readonly serviceIdentity: ServiceIdentity;
  readonly helperSecretBinding: LinuxOwnerHelperSecretBinding;
  readonly systemdCredential?: SystemdEncryptedCredential | null;
}

export interface LinuxOwnerHelperSecretBinding {
  readonly backend: "linux-secret-service";
  readonly secretToolPath: string;
}

export type PlatformServiceConfiguration =
  LinuxServiceConfiguration | MacOsServiceConfiguration | WindowsServiceConfiguration;

export interface PlatformServiceDefinition {
  readonly configuration: PlatformServiceConfiguration;
  readonly activeDirectory: string;
  readonly releaseDirectory: string;
  readonly stagingDirectory: string;
  readonly runtimeConfigurationPath: string;
  readonly secretReferencesPath: string;
  readonly coreExecutablePath: string;
  readonly helperExecutablePath: string;
  readonly coreStdoutLogPath: string;
  readonly coreStderrLogPath: string;
  readonly helperStdoutLogPath: string;
  readonly helperStderrLogPath: string;
}

export type PlatformServiceErrorCode =
  | "INVALID_BUNDLE"
  | "INVALID_CONFIGURATION"
  | "INVALID_HEALTH_ENDPOINT"
  | "INVALID_IDENTITY"
  | "INVALID_PATH"
  | "INVALID_SECRET_REFERENCE"
  | "PATH_INSIDE_CHECKOUT"
  | "UNKNOWN_CONFIGURATION_FIELD";

export class PlatformServiceError extends Error {
  public readonly code: PlatformServiceErrorCode;

  public constructor(code: PlatformServiceErrorCode, message: string) {
    super(message);
    this.name = "PlatformServiceError";
    this.code = code;
  }
}

export interface RenderedFile {
  readonly purpose:
    "core-manifest" | "helper-manifest" | "runtime-configuration" | "secret-references";
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf8" | "utf16le-bom";
  readonly mode: "0600" | "0640" | "0644";
}

export interface CommandInvocation {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly plane: RuntimePlane;
  readonly verb: "disable" | "enable" | "install" | "reload" | "remove" | "start" | "stop";
  readonly privilege: "elevated" | "owner-session";
  readonly availabilityPolicy: "required" | "defer-if-logged-out";
  readonly timeoutMs: number;
  readonly expectedExitCodes: readonly number[];
}

export interface LocalIpcDefinition {
  readonly kind: "named-pipe" | "unix-domain-socket";
  readonly endpoint: string;
  readonly authentication: "ed25519-mutual-signature-v2";
  readonly corePrivateKeyReference: string;
  readonly helperPrivateKeyReference: string;
  readonly corePublicKey: LocalIpcPublicKeyPin;
  readonly helperPublicKey: LocalIpcPublicKeyPin;
  readonly allowedPeers: readonly string[];
  readonly socketMode?: "0660";
}

export interface ServicePlaneArtifact {
  readonly plane: RuntimePlane;
  readonly bootSemantics: "boot" | "login";
  readonly identity: string;
  readonly manifest: RenderedFile;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
}

export interface ForegroundFallback {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly requiresExternalSupervisor: true;
  readonly restartPolicy: "on-failure";
  readonly limitation: string;
}

export interface PlatformServiceArtifacts {
  readonly platform: PlatformFamily;
  readonly definition: PlatformServiceDefinition;
  readonly core: ServicePlaneArtifact;
  readonly helper: ServicePlaneArtifact;
  readonly ipc: LocalIpcDefinition;
  readonly files: readonly RenderedFile[];
  readonly installCommands: readonly CommandInvocation[];
  readonly startCommands: readonly CommandInvocation[];
  readonly stopCommands: readonly CommandInvocation[];
  readonly removeCommands: readonly CommandInvocation[];
  readonly foregroundFallback: ForegroundFallback;
}
