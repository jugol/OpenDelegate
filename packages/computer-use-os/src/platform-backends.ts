import { ComputerUseOsBackend, type ComputerUseOsBackendOptions } from "./backend.ts";

type PlatformBackendOptions = Omit<ComputerUseOsBackendOptions, "osFamily">;

export function createWindowsComputerUseBackend(
  options: PlatformBackendOptions,
): ComputerUseOsBackend {
  return new ComputerUseOsBackend({ ...options, osFamily: "windows" });
}

export function createMacOsComputerUseBackend(
  options: PlatformBackendOptions,
): ComputerUseOsBackend {
  return new ComputerUseOsBackend({ ...options, osFamily: "macos" });
}

export function createLinuxComputerUseBackend(
  options: PlatformBackendOptions,
): ComputerUseOsBackend {
  return new ComputerUseOsBackend({ ...options, osFamily: "linux" });
}
