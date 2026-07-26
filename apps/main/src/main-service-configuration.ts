import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type { ConfigurationService } from "@opendelegate/configuration";
import {
  parsePlatformServiceConfiguration,
  type AdminAutoOpenConfiguration,
  type PlatformFamily,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

import type { ServiceLifecycleCommand } from "./service-lifecycle.ts";

export interface EffectiveMainServiceConfigurationInput {
  readonly command: ServiceLifecycleCommand;
  readonly home: string;
  readonly hostPlatform: PlatformFamily | undefined;
  readonly homeBindingBoundary?: MainServiceHomeBindingBoundary;
  readonly service: Pick<ConfigurationService, "inspect">;
  readonly main: {
    readonly instanceId: string;
    readonly deviceId: string;
    readonly main: {
      readonly origin: string;
    };
  };
  readonly template: PlatformServiceConfiguration;
}

export interface EffectiveMainServiceConfiguration {
  readonly configuration: PlatformServiceConfiguration;
  /**
   * The only other permitted installed state. Native reconfiguration uses this
   * exact configuration as the rollback candidate and rejects every unrelated
   * difference.
   */
  readonly alternateConfiguration: PlatformServiceConfiguration;
}

export interface MainServiceHomeBindingInput {
  readonly command: ServiceLifecycleCommand;
  readonly home: string;
  readonly hostPlatform: PlatformFamily | undefined;
  readonly template: {
    readonly paths: {
      readonly stateRoot: string;
    };
    readonly platform: PlatformFamily;
    readonly role: PlatformServiceConfiguration["role"];
  };
}

export interface MainServiceHomeBindingBoundary {
  readonly realPath: (path: string) => Promise<string>;
}

const DEFAULT_MAIN_SERVICE_HOME_BINDING_BOUNDARY: MainServiceHomeBindingBoundary = {
  realPath: realpath,
};

export function assertMainServiceHomeBinding(input: MainServiceHomeBindingInput): void {
  if (!requiresMainServiceHomeBinding(input)) {
    return;
  }
  if (
    comparablePath(input.home, input.template.platform) !==
    comparablePath(input.template.paths.stateRoot, input.template.platform)
  ) {
    throw new TypeError("Main service --home must match the template state root.");
  }
}

/**
 * Binds current-host Main operations to one filesystem authority. Real paths
 * accept harmless directory aliases, while returning the template state root
 * makes all later durable reads use the same path as the native service host.
 */
export async function resolveMainServiceHomeBinding(
  input: MainServiceHomeBindingInput,
  boundary: MainServiceHomeBindingBoundary = DEFAULT_MAIN_SERVICE_HOME_BINDING_BOUNDARY,
): Promise<string> {
  if (!requiresMainServiceHomeBinding(input)) {
    return input.home;
  }

  let canonicalHome: string;
  let canonicalStateRoot: string;
  try {
    [canonicalHome, canonicalStateRoot] = await Promise.all([
      boundary.realPath(input.home),
      boundary.realPath(input.template.paths.stateRoot),
    ]);
  } catch {
    throw new TypeError(
      "Main service --home and the template state root must resolve to readable directories.",
    );
  }

  assertMainServiceHomeBinding({
    ...input,
    home: canonicalHome,
    template: {
      ...input.template,
      paths: {
        stateRoot: canonicalStateRoot,
      },
    },
  });
  return canonicalStateRoot;
}

/**
 * Resolves the owner preference at the deterministic Configuration boundary.
 * The supplied platform document is a topology template: its Admin preference
 * is never trusted as effective state.
 */
export async function resolveEffectiveMainServiceConfiguration(
  input: EffectiveMainServiceConfigurationInput,
): Promise<EffectiveMainServiceConfiguration> {
  const template = parsePlatformServiceConfiguration(structuredClone(input.template));
  await resolveMainServiceHomeBinding(
    {
      command: input.command,
      home: input.home,
      hostPlatform: input.hostPlatform,
      template,
    },
    input.homeBindingBoundary,
  );
  if (template.role !== "main") {
    throw new TypeError("Admin auto-open service rendering is available only to the fixed Main.");
  }
  if (template.instanceId !== input.main.instanceId || template.deviceId !== input.main.deviceId) {
    throw new TypeError("The Main service template identity does not match Main configuration.");
  }

  const origin = canonicalAdminOrigin(input.main.main.origin);
  const effective = await input.service.inspect({
    instanceId: input.main.instanceId,
    mainId: input.main.deviceId,
    deviceId: input.main.deviceId,
  });
  const enabled = effective["admin.open-on-login"]?.value;
  if (typeof enabled !== "boolean") {
    throw new TypeError("The effective Admin auto-open setting is unavailable.");
  }

  const selected: AdminAutoOpenConfiguration = enabled
    ? { enabled: true, url: origin }
    : { enabled: false };
  const alternate: AdminAutoOpenConfiguration = enabled
    ? { enabled: false }
    : { enabled: true, url: origin };
  return Object.freeze({
    configuration: withAdminAutoOpen(template, selected),
    alternateConfiguration: withAdminAutoOpen(template, alternate),
  });
}

function requiresMainServiceHomeBinding(input: MainServiceHomeBindingInput): boolean {
  return (
    input.command !== "help" &&
    input.command !== "render" &&
    input.command !== "plan" &&
    input.template.role === "main" &&
    input.template.platform === input.hostPlatform
  );
}

function comparablePath(value: string, platform: PlatformFamily): string {
  const path = platform === "windows" ? win32 : posix;
  const resolved = path.resolve(value);
  return platform === "windows" ? resolved.toLowerCase() : resolved;
}

function withAdminAutoOpen(
  configuration: PlatformServiceConfiguration,
  adminAutoOpen: AdminAutoOpenConfiguration,
): PlatformServiceConfiguration {
  return parsePlatformServiceConfiguration({
    ...structuredClone(configuration),
    ownerSession: {
      ...structuredClone(configuration.ownerSession),
      adminAutoOpen,
    },
  });
}

function canonicalAdminOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new TypeError("The canonical Main Admin origin is invalid.");
  }
  if (
    origin.origin !== value ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new TypeError("The canonical Main Admin origin is invalid.");
  }
  return new URL("/", origin).href;
}
