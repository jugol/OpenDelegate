import {
  createMainRuntime as createProductionMainRuntime,
  initializeMainHome as initializeProductionMainHome,
  type CreateMainRuntimeOptions,
  type InitializedMainHome,
  type InitializeMainHomeOptions,
  type MainRuntime,
} from "../src/index.ts";
import { withHostRuntimePermissionEnforcerForTest } from "../src/internal/runtime-permissions.ts";

export function runWithPortableWindowsRuntimePermissionsForTest<T>(operation: () => T): T {
  if (process.platform !== "win32") {
    return operation();
  }
  return withHostRuntimePermissionEnforcerForTest(async () => undefined, operation);
}

export function initializeMainHome(
  options: InitializeMainHomeOptions,
): Promise<InitializedMainHome> {
  return runWithPortableWindowsRuntimePermissionsForTest(() =>
    initializeProductionMainHome(options),
  );
}

export function createMainRuntime(options: CreateMainRuntimeOptions): Promise<MainRuntime> {
  return runWithPortableWindowsRuntimePermissionsForTest(() =>
    createProductionMainRuntime(options),
  );
}
