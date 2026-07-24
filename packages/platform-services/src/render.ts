import { validateSupervisorCommands } from "./command-validation.ts";
import { createPlatformServiceDefinition } from "./configuration.ts";
import { renderLinuxServiceArtifacts } from "./render-linux.ts";
import { renderMacOsServiceArtifacts } from "./render-macos.ts";
import { renderWindowsServiceArtifacts } from "./render-windows.ts";
import type {
  PlatformServiceArtifacts,
  PlatformServiceConfiguration,
  PlatformServiceDefinition,
} from "./types.ts";

export function renderPlatformServiceArtifacts(
  configuration: PlatformServiceConfiguration,
): PlatformServiceArtifacts {
  const definition = createPlatformServiceDefinition(configuration);
  const artifacts = renderByPlatform(definition);
  validateSupervisorCommands([
    ...artifacts.installCommands,
    ...artifacts.startCommands,
    ...artifacts.stopCommands,
    ...artifacts.removeCommands,
  ]);
  return artifacts;
}

function renderByPlatform(definition: PlatformServiceDefinition): PlatformServiceArtifacts {
  if (definition.configuration.platform === "windows") {
    return renderWindowsServiceArtifacts(
      definition as PlatformServiceDefinition & {
        readonly configuration: Extract<
          PlatformServiceConfiguration,
          { readonly platform: "windows" }
        >;
      },
    );
  }
  if (definition.configuration.platform === "macos") {
    return renderMacOsServiceArtifacts(
      definition as PlatformServiceDefinition & {
        readonly configuration: Extract<
          PlatformServiceConfiguration,
          { readonly platform: "macos" }
        >;
      },
    );
  }
  return renderLinuxServiceArtifacts(
    definition as PlatformServiceDefinition & {
      readonly configuration: Extract<PlatformServiceConfiguration, { readonly platform: "linux" }>;
    },
  );
}
