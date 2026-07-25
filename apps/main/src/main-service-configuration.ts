import type { ConfigurationService } from "@opendelegate/configuration";
import {
  parsePlatformServiceConfiguration,
  type AdminAutoOpenConfiguration,
  type PlatformServiceConfiguration,
} from "@opendelegate/platform-services";

export interface EffectiveMainServiceConfigurationInput {
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

/**
 * Resolves the owner preference at the deterministic Configuration boundary.
 * The supplied platform document is a topology template: its Admin preference
 * is never trusted as effective state.
 */
export async function resolveEffectiveMainServiceConfiguration(
  input: EffectiveMainServiceConfigurationInput,
): Promise<EffectiveMainServiceConfiguration> {
  const template = parsePlatformServiceConfiguration(structuredClone(input.template));
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
