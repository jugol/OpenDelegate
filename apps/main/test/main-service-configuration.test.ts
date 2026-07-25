import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationService,
  InMemoryConfigurationRepository,
  STANDARD_CONFIGURATION_DEFINITIONS,
} from "@opendelegate/configuration";
import type { PlatformServiceConfiguration } from "@opendelegate/platform-services";

import type { MainConfiguration } from "../src/index.ts";
import { resolveEffectiveMainServiceConfiguration } from "../src/main-service-configuration.ts";

const NOW = "2026-07-26T00:00:00.000Z";

test("Main service rendering replaces template state with the effective owner preference and canonical Admin origin", async () => {
  const configuration = configurationService();
  const template = serviceConfiguration({
    enabled: true,
    url: "https://stale.example.test/",
  });
  const disabled = await resolveEffectiveMainServiceConfiguration({
    service: configuration,
    main: mainConfiguration(),
    template,
  });

  assert.deepEqual(disabled.configuration.ownerSession.adminAutoOpen, {
    enabled: false,
  });
  assert.deepEqual(disabled.alternateConfiguration.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://admin.example.test/",
  });
  assert.deepEqual(template.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://stale.example.test/",
  });

  const proposal = await configuration.propose({
    actor: "owner_personal",
    reason: "Open Admin after owner login.",
    changes: [
      {
        operation: "set",
        key: "admin.open-on-login",
        scope: { kind: "main", id: "device_main" },
        value: true,
      },
    ],
  });
  await configuration.apply({
    proposalId: proposal.id,
    expectedRevision: 0,
    actor: "owner_personal",
  });

  const enabled = await resolveEffectiveMainServiceConfiguration({
    service: configuration,
    main: mainConfiguration(),
    template,
  });
  assert.deepEqual(enabled.configuration.ownerSession.adminAutoOpen, {
    enabled: true,
    url: "https://admin.example.test/",
  });
  assert.deepEqual(enabled.alternateConfiguration.ownerSession.adminAutoOpen, {
    enabled: false,
  });
});

test("Main service rendering rejects a Worker or a template for another Instance", async () => {
  const configuration = configurationService();
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      service: configuration,
      main: mainConfiguration(),
      template: {
        ...serviceConfiguration({ enabled: false }),
        role: "worker",
      },
    }),
    /fixed Main/i,
  );
  await assert.rejects(
    resolveEffectiveMainServiceConfiguration({
      service: configuration,
      main: mainConfiguration(),
      template: {
        ...serviceConfiguration({ enabled: false }),
        instanceId: "instance_other",
      },
    }),
    /identity/i,
  );
});

function configurationService(): ConfigurationService {
  let sequence = 0;
  return new ConfigurationService({
    definitions: STANDARD_CONFIGURATION_DEFINITIONS,
    repository: new InMemoryConfigurationRepository(),
    idSource: () => `configuration_${++sequence}`,
    clock: () => NOW,
  });
}

function mainConfiguration(): MainConfiguration {
  return {
    schemaVersion: 1,
    instanceId: "instance_personal",
    deviceId: "device_main",
    main: {
      host: "0.0.0.0",
      port: 443,
      origin: "https://admin.example.test",
      tls: {
        certificatePath: "/etc/opendelegate/tls/admin.pem",
        privateKeyPath: "/etc/opendelegate/tls/admin-key.pem",
      },
    },
    database: { adapter: "sqlite" },
    secretBackend: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    adminRoot: "/opt/opendelegate/admin",
  };
}

function serviceConfiguration(
  adminAutoOpen: PlatformServiceConfiguration["ownerSession"]["adminAutoOpen"],
): PlatformServiceConfiguration {
  return {
    platform: "linux",
    instanceId: "instance_personal",
    deviceId: "device_main",
    role: "main",
    bundle: {
      version: "1.2.3",
      sourceDirectory: "/mnt/release-input/opendelegate-1.2.3",
      checksum: `sha256:${"a".repeat(64)}`,
    },
    paths: {
      sourceCheckoutDirectory: "/home/owner/src/OpenDelegate",
      installRoot: "/opt/opendelegate",
      stateRoot: "/var/lib/opendelegate",
      authorityRoot: "/var/lib/opendelegate-authority",
      runtimeRoot: "/run/opendelegate",
      logRoot: "/var/log/opendelegate",
    },
    ownerSession: {
      userName: "owner",
      stableUserId: "1000",
      uid: 1000,
      homeDirectory: "/home/owner",
      adminAutoOpen,
    },
    serviceIdentity: {
      userName: "opendelegate",
      groupName: "opendelegate",
    },
    helperSecretBinding: {
      backend: "linux-secret-service",
      secretToolPath: "/usr/bin/secret-tool",
    },
    systemdCredential: null,
    ipcTrust: {
      protocolVersion: 2,
      core: {
        keyId: "sha256:f9acccda515ce25409e456e45f25417bcda0c1cc0255490965f6ab59d5a81b48",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAjBmMzBDNPDdi86mu7kAWdhSpEsUBySgfGN0q2ganv5I",
      },
      helper: {
        keyId: "sha256:b0308f5b2e753b15572359e7e9cd8da8400839df95052ddc21d9711554750c2f",
        publicKeySpkiBase64Url: "MCowBQYDK2VwAyEAli20Wxft7Lox4PLDh_IcMGjN265l-fNMneRfYNWYnko",
      },
    },
    secretReferences: {
      deviceIdentity: "secret://linux/device-identity",
      coreIpcSigningKey: "secret://linux/core-ipc-signing-v2",
      helperIpcSigningKey: "secret://linux/helper-ipc-signing-v2",
    },
    health: {
      endpoint: "http://127.0.0.1:4380/health/live",
      timeoutMs: 30_000,
    },
    retainPreviousVersions: 2,
  };
}
