import assert from "node:assert/strict";
import test from "node:test";

import {
  PlatformServiceError,
  createPlatformServiceDefinition,
  type WindowsServiceConfiguration,
} from "../src/index.ts";
import { linuxConfiguration, macOsConfiguration, windowsConfiguration } from "./fixtures.ts";

test("accepts absolute external Windows, macOS, and Linux runtime layouts", () => {
  for (const configuration of [
    windowsConfiguration(),
    macOsConfiguration(),
    linuxConfiguration(),
  ]) {
    const definition = createPlatformServiceDefinition(configuration);
    assert.equal(definition.configuration.platform, configuration.platform);
    assert.match(definition.releaseDirectory, /1\.2\.3$/);
    assert.ok(definition.runtimeConfigurationPath.includes("service.json"));
    assert.ok(definition.secretReferencesPath.includes("secret-references.json"));
  }
});

test("rejects relative or source-checkout runtime state paths", () => {
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          paths: {
            ...linuxConfiguration().paths,
            stateRoot: "relative/state",
          },
        }),
      ),
    (error: unknown) => error instanceof PlatformServiceError && error.code === "INVALID_PATH",
  );

  assert.throws(
    () =>
      createPlatformServiceDefinition(
        windowsConfiguration({
          paths: {
            ...windowsConfiguration().paths,
            stateRoot: "C:\\src\\OpenDelegate\\.runtime",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "PATH_INSIDE_CHECKOUT",
  );
});

test("accepts only opaque Secret references and never a raw Secret field", () => {
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          secretReferences: {
            helperIpc: "raw-super-secret",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_SECRET_REFERENCE",
  );

  const input = {
    ...windowsConfiguration(),
    password: "must-not-be-accepted",
  };
  assert.throws(
    () => createPlatformServiceDefinition(input as WindowsServiceConfiguration),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "UNKNOWN_CONFIGURATION_FIELD",
  );
});
