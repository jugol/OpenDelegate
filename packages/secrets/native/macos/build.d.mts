export interface BuildMacOsKeychainHelperOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly hostPlatform?: NodeJS.Platform;
  readonly outputRoot?: string;
  readonly xcrunPath?: string;
}

export interface MacOsKeychainHelperBuild {
  readonly architecture: NodeJS.Architecture;
  readonly helperExecutable: string;
  readonly outputRoot: string;
}

export function buildMacOsKeychainHelper(
  options?: BuildMacOsKeychainHelperOptions,
): Promise<MacOsKeychainHelperBuild>;
