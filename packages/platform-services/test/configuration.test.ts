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
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          systemdCredential: {
            credentialName: "opendelegate-vault-key",
            encryptedSourcePath: "/var/lib/opendelegate/credentials/opendelegate-vault-key.cred",
          },
        }),
      ),
    (error: unknown) => error instanceof PlatformServiceError && error.code === "INVALID_PATH",
  );
});

test("accepts only the exact external Windows Codex sandbox helper directory", () => {
  const accepted = createPlatformServiceDefinition(
    windowsConfiguration({
      agentSandbox: {
        codexSandboxBinDirectory: "C:\\Users\\owner\\.codex\\.sandbox-bin",
      },
    }),
  ).configuration;
  assert.equal(
    accepted.platform === "windows" ? accepted.agentSandbox?.codexSandboxBinDirectory : undefined,
    "C:\\Users\\owner\\.codex\\.sandbox-bin",
  );

  for (const codexSandboxBinDirectory of [
    "C:\\Users\\owner\\.codex",
    "C:\\src\\OpenDelegate\\.sandbox-bin",
  ]) {
    assert.throws(
      () =>
        createPlatformServiceDefinition(
          windowsConfiguration({ agentSandbox: { codexSandboxBinDirectory } }),
        ),
      (error: unknown) =>
        error instanceof PlatformServiceError &&
        (error.code === "INVALID_PATH" || error.code === "PATH_INSIDE_CHECKOUT"),
    );
  }
});

test("rejects overlapping mutable roots and bundle sources", () => {
  const linux = linuxConfiguration();
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          paths: {
            ...linux.paths,
            stateRoot: `${linux.paths.installRoot}/state`,
          },
        }),
      ),
    (error: unknown) => error instanceof PlatformServiceError && error.code === "INVALID_PATH",
  );
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          bundle: {
            ...linux.bundle,
            sourceDirectory: `${linux.paths.stateRoot}/incoming`,
          },
        }),
      ),
    (error: unknown) => error instanceof PlatformServiceError && error.code === "INVALID_PATH",
  );
});

test("accepts only opaque Secret references and never a raw Secret field", () => {
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          secretReferences: {
            coreIpcSigningKey: "raw-super-secret",
            helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_SECRET_REFERENCE",
  );

  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          secretReferences: {
            coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
            helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
            helperIpc: "secret://linux/legacy-shared-key",
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

test("accepts only a non-secret external systemd encrypted credential mapping", () => {
  const configuration = linuxConfiguration({
    systemdCredential: {
      credentialName: "opendelegate-vault-key",
      encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
    },
  });
  const accepted = createPlatformServiceDefinition(configuration).configuration;
  assert.equal(accepted.platform, "linux");
  assert.deepEqual(
    accepted.platform === "linux" ? accepted.systemdCredential : undefined,
    configuration.systemdCredential,
  );
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          systemdCredential: {
            credentialName: "bad credential",
            encryptedSourcePath: "/etc/credstore.encrypted/opendelegate-vault-key.cred",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "INVALID_SECRET_REFERENCE",
  );
  assert.throws(
    () =>
      createPlatformServiceDefinition(
        linuxConfiguration({
          systemdCredential: {
            credentialName: "opendelegate-vault-key",
            encryptedSourcePath: "/home/owner/src/OpenDelegate/runtime/vault-key.cred",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof PlatformServiceError && error.code === "PATH_INSIDE_CHECKOUT",
  );
});

test("a Windows Main may stage the SCM Secret binding needed by its co-located Worker", () => {
  const configuration = windowsConfiguration({
    role: "main",
    serviceSecretBinding: {
      backend: "windows-service-dpapi",
      handoffRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\handoff",
      serviceName: "OpenDelegate-personal",
      serviceSid: "S-1-5-80-611375048-4065716985-2142524325-1255325421-3479547702",
      vaultRoot: "C:\\ProgramData\\OpenDelegate\\state\\secrets\\service",
    },
  });

  const accepted = createPlatformServiceDefinition(configuration).configuration;
  assert.equal(accepted.role, "main");
  assert.deepEqual(
    accepted.platform === "windows" ? accepted.serviceSecretBinding : undefined,
    configuration.serviceSecretBinding,
  );
});

test("Admin auto-open is an explicit Main-only safe-origin preference", () => {
  const main = windowsConfiguration({
    ownerSession: {
      ...windowsConfiguration().ownerSession,
      adminAutoOpen: {
        enabled: true,
        url: "https://admin.example.test/",
      },
    },
  });
  assert.deepEqual(createPlatformServiceDefinition(main).configuration.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://admin.example.test/",
  });

  for (const configuration of [
    {
      ...main,
      role: "worker" as const,
    },
    {
      ...main,
      ownerSession: {
        ...main.ownerSession,
        adminAutoOpen: {
          enabled: true as const,
          url: "http://admin.example.test/",
        },
      },
    },
    {
      ...main,
      ownerSession: {
        ...main.ownerSession,
        adminAutoOpen: {
          enabled: true as const,
          url: "file:///C:/Windows/System32/calc.exe",
        },
      },
    },
    {
      ...main,
      ownerSession: {
        ...main.ownerSession,
        adminAutoOpen: {
          enabled: true as const,
          url: "https://admin.example.test/path",
        },
      },
    },
  ]) {
    assert.throws(
      () => createPlatformServiceDefinition(configuration),
      (error: unknown) =>
        error instanceof PlatformServiceError && error.code === "INVALID_CONFIGURATION",
    );
  }
});
